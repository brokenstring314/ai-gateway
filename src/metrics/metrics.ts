/**
 * Prometheus metrics for the AI gateway, built on prom-client.
 *
 * All metrics are registered on a dedicated `Registry` (one per `Metrics`
 * instance) so the module is fully self-contained and never touches
 * prom-client's global `register`.
 *
 * Metric names (default prefix `ai_gateway`):
 *   - ai_gateway_requests_total                 counter   {method, status, provider}
 *   - ai_gateway_request_duration_seconds       histogram {method, status, provider}
 *   - ai_gateway_tokens_input_total             counter   {provider, model}
 *   - ai_gateway_tokens_output_total            counter   {provider, model}
 *   - ai_gateway_provider_errors_total          counter   {provider, error_type}
 *   - ai_gateway_circuit_breaker_state          gauge     {provider, state}
 *   - ai_gateway_mcp_server_up                  gauge     {server}
 *   - ai_gateway_rate_limit_rejections_total    counter   {provider}
 *   - ai_gateway_request_cost_usd               counter   {provider, model}
 *
 * Label values are sanitized before recording (control characters, quotes
 * and backslashes replaced, values trimmed and length-bounded) and the
 * circuit-breaker state gauge only accepts a fixed set of values, so
 * caller-controlled input cannot inject extra label series (cardinality
 * injection) or break the Prometheus text format.
 */

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

/** Configuration for constructing a `Metrics` instance. */
export interface MetricsOptions {
  /** Prefix for every metric name. Defaults to `"ai_gateway"`. */
  prefix?: string;
  /**
   * Also collect prom-client's default Node.js process metrics onto the
   * same registry. Defaults to `false` to keep output predictable.
   */
  enableDefaultMetrics?: boolean;
}

/** Labels recorded for request counters and duration histograms. */
export interface RequestLabels {
  method: string;
  status: number | string;
  provider: string;
}

/** See `Metrics.requestSummary`. Latencies are null when there is no sample (or p95 is above the last bucket). */
export interface RequestSummary {
  total: number;
  clientErrors: number;
  serverErrors: number;
  /** 5xx / total. */
  errorRate: number;
  latencyMs: { mean: number | null; p50: number | null; p95: number | null };
}

/** Circuit breaker states as reported by the routing layer. */
export type CircuitBreakerState = "CLOSED" | "HALF_OPEN" | "OPEN";

const DEFAULT_PREFIX = "ai_gateway";

/** Fixed set of circuit breaker state label values (lowercased). */
const CIRCUIT_BREAKER_STATE_LABELS = new Set(["closed", "half_open", "open"]);

/** Upper bound for any label value; bounds series cardinality. */
const MAX_LABEL_LENGTH = 64;

/** Default value used when a label value sanitizes to an empty string. */
const UNKNOWN = "unknown";

/**
 * Sanitize a label value so it is safe in the Prometheus text format and
 * cannot grow series cardinality without bound. Values are coerced to a
 * string, control characters / quotes / backslashes are replaced, and the
 * result is trimmed and truncated to `MAX_LABEL_LENGTH`.
 */
function sanitizeLabel(value: unknown): string {
  let str: string;
  if (typeof value === "string") {
    str = value;
  } else if (typeof value === "number") {
    str = Number.isFinite(value) ? String(value) : "";
  } else if (typeof value === "boolean") {
    str = String(value);
  } else {
    str = "";
  }
  const cleaned = str
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips control chars from label values
    .replace(/[\u0000-\u001f\u007f\\"]/g, "_")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
  return cleaned.length > 0 ? cleaned : UNKNOWN;
}

/** Clamp a numeric observation to a finite, non-negative value. */
function nonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Prometheus metrics registry for the gateway.
 *
 * Create instances directly (`new Metrics()`) for isolation in tests, or use
 * the process-wide singleton via `getMetrics()` / `resetMetrics()`.
 */
export class Metrics {
  /** The underlying prom-client registry (exposed for `/metrics` endpoints). */
  readonly registry: Registry;

  private readonly requestsTotal: Counter<string>;
  private readonly requestDurationSeconds: Histogram<string>;
  private readonly tokensInputTotal: Counter<string>;
  private readonly tokensOutputTotal: Counter<string>;
  private readonly providerErrors: Counter<string>;
  private readonly circuitBreakerState: Gauge<string>;
  private readonly mcpServerUp: Gauge<string>;
  private readonly rateLimitRejections: Counter<string>;
  private readonly requestCostUsd: Counter<string>;
  private readonly pluginBlocked: Counter<string>;
  private readonly guardrailDetections: Counter<string>;

  /** Active circuit breaker state per provider, used to zero stale states. */
  private readonly breakerStates = new Map<string, string>();

  constructor(options: MetricsOptions = {}) {
    const prefix = options.prefix ?? DEFAULT_PREFIX;
    this.registry = new Registry();

    this.requestsTotal = new Counter({
      name: `${prefix}_requests_total`,
      help: "Total number of HTTP requests handled by the gateway",
      labelNames: ["method", "status", "provider"],
      registers: [this.registry],
    });

    this.requestDurationSeconds = new Histogram({
      name: `${prefix}_request_duration_seconds`,
      help: "Request duration in seconds",
      labelNames: ["method", "status", "provider"],
      registers: [this.registry],
    });

    this.tokensInputTotal = new Counter({
      name: `${prefix}_tokens_input_total`,
      help: "Total number of input (prompt) tokens consumed",
      labelNames: ["provider", "model"],
      registers: [this.registry],
    });

    this.tokensOutputTotal = new Counter({
      name: `${prefix}_tokens_output_total`,
      help: "Total number of output (completion) tokens generated",
      labelNames: ["provider", "model"],
      registers: [this.registry],
    });

    this.providerErrors = new Counter({
      name: `${prefix}_provider_errors_total`,
      help: "Total number of upstream provider errors",
      labelNames: ["provider", "error_type"],
      registers: [this.registry],
    });

    this.circuitBreakerState = new Gauge({
      name: `${prefix}_circuit_breaker_state`,
      help: "Current circuit breaker state per provider (1 for the active state, 0 otherwise)",
      labelNames: ["provider", "state"],
      registers: [this.registry],
    });

    this.mcpServerUp = new Gauge({
      name: `${prefix}_mcp_server_up`,
      help: "Whether an MCP server is reachable (1) or not (0)",
      labelNames: ["server"],
      registers: [this.registry],
    });

    this.rateLimitRejections = new Counter({
      name: `${prefix}_rate_limit_rejections_total`,
      help: "Total number of requests rejected by the rate limiter",
      labelNames: ["provider"],
      registers: [this.registry],
    });

    this.requestCostUsd = new Counter({
      name: `${prefix}_request_cost_usd`,
      help: "Cumulative cost of requests in US dollars",
      labelNames: ["provider", "model"],
      registers: [this.registry],
    });

    this.pluginBlocked = new Counter({
      name: `${prefix}_plugin_blocked_total`,
      help: "Requests ended by a before-request plugin (rejected or short-circuited)",
      labelNames: ["plugin", "outcome", "surface"],
      registers: [this.registry],
    });

    this.guardrailDetections = new Counter({
      name: `${prefix}_guardrail_detections_total`,
      help: "PII / secret detections by guardrail plugins, by entity type (values are never recorded)",
      labelNames: ["entity", "category", "action", "direction"],
      registers: [this.registry],
    });

    if (options.enableDefaultMetrics) {
      collectDefaultMetrics({ register: this.registry, prefix });
    }
  }

  /** Record a completed request (counter only; see also `observeDuration`). */
  recordRequest(labels: RequestLabels): void {
    this.requestsTotal.inc(this.requestLabelValues(labels));
  }

  /** Observe a request duration in seconds. */
  observeDuration(seconds: number, labels: RequestLabels): void {
    this.requestDurationSeconds.observe(this.requestLabelValues(labels), nonNegative(seconds));
  }

  /** Record input/output token usage for a provider and model. */
  recordTokens(provider: string, model: string, inputTokens: number, outputTokens: number): void {
    const labels = {
      provider: sanitizeLabel(provider),
      model: sanitizeLabel(model),
    };
    this.tokensInputTotal.inc(labels, nonNegative(inputTokens));
    this.tokensOutputTotal.inc(labels, nonNegative(outputTokens));
  }

  /** Record an upstream provider error. */
  recordProviderError(provider: string, errorType = UNKNOWN): void {
    this.providerErrors.inc({
      provider: sanitizeLabel(provider),
      error_type: sanitizeLabel(errorType),
    });
  }

  /**
   * Set the current circuit breaker state for a provider.
   * The active state is set to 1 and all other (previously seen) states for
   * the same provider are set to 0. Only the fixed states CLOSED, HALF_OPEN
   * and OPEN are accepted.
   */
  setCircuitBreakerState(provider: string, state: CircuitBreakerState): void {
    const normalized = state.toLowerCase();
    if (!CIRCUIT_BREAKER_STATE_LABELS.has(normalized)) {
      throw new RangeError(`Invalid circuit breaker state: ${state}`);
    }
    const providerLabel = sanitizeLabel(provider);
    const previous = this.breakerStates.get(providerLabel);
    if (previous !== undefined && previous !== normalized) {
      this.circuitBreakerState.set({ provider: providerLabel, state: previous }, 0);
    }
    this.circuitBreakerState.set({ provider: providerLabel, state: normalized }, 1);
    this.breakerStates.set(providerLabel, normalized);
  }

  /** Set whether an MCP server is currently up. */
  setMcpServerUp(server: string, up: boolean): void {
    this.mcpServerUp.set({ server: sanitizeLabel(server) }, up ? 1 : 0);
  }

  /** Record a rate-limit rejection for a provider. */
  recordRateLimitRejection(provider = UNKNOWN): void {
    this.rateLimitRejections.inc({ provider: sanitizeLabel(provider) });
  }

  /** Record a request ended by a before-request plugin. */
  recordPluginBlocked(plugin: string, outcome: string, surface: string): void {
    this.pluginBlocked.inc({
      plugin: sanitizeLabel(plugin),
      outcome: sanitizeLabel(outcome),
      surface: sanitizeLabel(surface),
    });
  }

  /** Record one guardrail detection (entity type only; never the matched value). */
  recordGuardrailDetection(entity: string, category: string, action: string, direction: string): void {
    this.guardrailDetections.inc({
      entity: sanitizeLabel(entity),
      category: sanitizeLabel(category),
      action: sanitizeLabel(action),
      direction: sanitizeLabel(direction),
    });
  }

  /** Record the cost (in US dollars) of a completed request. */
  recordCost(provider: string, model: string, costUsd: number): void {
    this.requestCostUsd.inc({ provider: sanitizeLabel(provider), model: sanitizeLabel(model) }, nonNegative(costUsd));
  }

  /**
   * Render all metrics in the Prometheus text exposition format
   * (version 0.0.4), ready to serve from a `/metrics` endpoint.
   */
  async format(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * In-process summary of requests an upstream target answered (provider
   * label set), since this process started or the last reset: counts by
   * status class, error rate and latency (mean and histogram-bucket p50/p95,
   * i.e. the upper bound of the bucket holding that rank). Used by the admin
   * console; Prometheus remains the source of truth for history.
   */
  async requestSummary(): Promise<RequestSummary> {
    const counts = await this.requestsTotal.get();
    let total = 0;
    let clientErrors = 0;
    let serverErrors = 0;
    for (const v of counts.values) {
      if (v.labels["provider"] === UNKNOWN || v.labels["provider"] === undefined) continue;
      const status = Number(v.labels["status"]);
      total += v.value;
      if (status >= 500) serverErrors += v.value;
      else if (status >= 400) clientErrors += v.value;
    }
    const hist = await this.requestDurationSeconds.get();
    let sum = 0;
    let count = 0;
    const buckets = new Map<number, number>();
    for (const v of hist.values) {
      if (v.labels["provider"] === UNKNOWN || v.labels["provider"] === undefined) continue;
      const name = (v as { metricName?: string }).metricName ?? "";
      if (name.endsWith("_sum")) sum += v.value;
      else if (name.endsWith("_count")) count += v.value;
      else if (name.endsWith("_bucket")) {
        const le = v.labels["le"];
        const bound = le === "+Inf" ? Number.POSITIVE_INFINITY : Number(le);
        buckets.set(bound, (buckets.get(bound) ?? 0) + v.value);
      }
    }
    const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
    const quantile = (q: number): number | null => {
      if (count === 0) return null;
      const rank = q * count;
      for (const [bound, cumulative] of sorted) {
        if (cumulative >= rank) return Number.isFinite(bound) ? Math.round(bound * 1000) : null;
      }
      return null;
    };
    return {
      total,
      clientErrors,
      serverErrors,
      errorRate: total > 0 ? serverErrors / total : 0,
      latencyMs: {
        mean: count > 0 ? Math.round((sum / count) * 1000) : null,
        p50: quantile(0.5),
        p95: quantile(0.95),
      },
    };
  }

  /** Reset every metric value back to its initial (empty) state. */
  reset(): void {
    this.registry.resetMetrics();
    this.breakerStates.clear();
  }

  private requestLabelValues(labels: RequestLabels): Record<"method" | "status" | "provider", string> {
    return {
      method: sanitizeLabel(labels.method),
      status: sanitizeLabel(labels.status),
      provider: sanitizeLabel(labels.provider),
    };
  }
}

/** Process-wide metrics instance. */
let defaultMetrics: Metrics | undefined;

/** Get the process-wide `Metrics` singleton (created lazily). */
export function getMetrics(): Metrics {
  defaultMetrics ??= new Metrics();
  return defaultMetrics;
}

/** Reset the process-wide `Metrics` singleton, if it has been created. */
export function resetMetrics(): void {
  defaultMetrics?.reset();
}
