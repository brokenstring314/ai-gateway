/**
 * OpenTelemetry SDK integration for the AI Gateway.
 *
 * Wraps the OpenTelemetry Node SDK with a small, gateway-friendly surface:
 *  - OTLP HTTP trace export (endpoint from config or OTEL_EXPORTER_OTLP_ENDPOINT)
 *  - W3C tracecontext + baggage propagation
 *  - `service.name` resource attribute
 *  - Parent-based sampling with a configurable sample ratio
 *  - Graceful shutdown guarded by a configurable timeout
 *  - Request-id correlation via {@link RequestIdIdGenerator}
 *
 * When tracing is not enabled (or no endpoint is available) `initOtel` returns
 * a no-op handle and never allocates a tracer provider, keeping the runtime
 * cost at zero when observability is switched off.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { TextMapPropagator } from "@opentelemetry/api";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { NodeSDK, type NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type IdGenerator,
  type Sampler,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export interface OtelConfig {
  /** Master switch. Defaults to `true`; when `false` a no-op handle is returned. */
  enabled?: boolean;
  /**
   * OTLP HTTP endpoint (e.g. `http://collector:4318/v1/traces`).
   * Falls back to the `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable.
   */
  otlpEndpoint?: string;
  /** `service.name` resource attribute. Defaults to `"ai-gateway"`. */
  serviceName?: string;
  /** Fraction of root traces to sample, in `[0, 1]`. Defaults to `1`. */
  sampleRatio?: number;
  /**
   * Privacy level for span attribute handling, consumed by the tracing bridge:
   * - `"none"`     – no redaction
   * - `"metadata"` – drop sensitive attribute keys (tokens, keys, secrets)
   * - `"full"`     – additionally drop payload-like attribute keys
   */
  privacyLevel?: "none" | "metadata" | "full";
  /** Maximum time (ms) to wait for a graceful SDK shutdown. Defaults to `5000`. */
  shutdownGraceMs?: number;
  /** Extra HTTP headers forwarded to the OTLP exporter. */
  headers?: Record<string, string>;
  /** Test seam: override the trace exporter (avoids real network in tests). */
  traceExporter?: SpanExporter;
  /** Test seam: override the span processor used by the SDK. */
  spanProcessor?: SpanProcessor;
}

export interface OtelHandle {
  /** Flush and shut down the SDK. Resolves even when the SDK exceeds the grace period. */
  shutdown(): Promise<void>;
  /** Whether this handle is backed by a live OpenTelemetry SDK. */
  isEnabled(): boolean;
}

const DEFAULT_SERVICE_NAME = "ai-gateway";
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

const TRACE_ID_HEX_PATTERN = /^[0-9a-f]{32}$/i;

/** Async-local slot used to correlate trace IDs with the request's X-Request-Id. */
const requestIdStorage = new AsyncLocalStorage<string>();

/** Generate a random hex string of the given byte length. */
export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive a 32-char lowercase hex trace ID from a request id.
 *
 * Well-formed 32-hex ids pass through unchanged. Anything else is hashed
 * (SHA-256) so an arbitrary `X-Request-Id` still yields a valid W3C trace id
 * that is stable for the same request id.
 */
export function traceIdFromRequestId(requestId: string): string {
  const trimmed = requestId.trim();
  if (TRACE_ID_HEX_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return Bun.CryptoHasher.hash("sha256", trimmed, "hex").substring(0, 32);
}

/**
 * Run `fn` with a request id attached to the current async context.
 * {@link RequestIdIdGenerator} reads this value when the SDK creates a root
 * span, so the resulting trace id stays aligned with the request id. Unlike
 * the OpenTelemetry `context` API this works without a registered context
 * manager, which keeps it usable even before the SDK is initialized.
 */
export function withRequestId<T>(requestId: string | undefined, fn: () => T): T {
  if (requestId === undefined || requestId === "") {
    return fn();
  }
  return requestIdStorage.run(requestId, fn);
}

/** Read the request id attached via {@link withRequestId}, if any. */
export function getCurrentRequestId(): string | undefined {
  return requestIdStorage.getStore();
}

/**
 * Custom ID generator that derives trace IDs from the current request id.
 * When no request id is in scope it falls back to random trace/span ids, so
 * the generator is always safe to use.
 */
export class RequestIdIdGenerator implements IdGenerator {
  generateTraceId(): string {
    const requestId = getCurrentRequestId();
    if (requestId !== undefined) {
      return traceIdFromRequestId(requestId);
    }
    return randomHex(16);
  }

  generateSpanId(): string {
    return randomHex(8);
  }
}

/** Resolve the OTLP endpoint: explicit config wins, then env fallback. */
function resolveEndpoint(config: Pick<OtelConfig, "otlpEndpoint">): string | undefined {
  return config.otlpEndpoint ?? process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
}

function normalizeRatio(ratio: number | undefined): number {
  if (ratio === undefined || Number.isNaN(ratio)) {
    return 1;
  }
  return Math.min(1, Math.max(0, ratio));
}

/**
 * Build the trace sampler.
 *
 * `OTEL_TRACES_SAMPLER` takes precedence when it holds a standard value
 * (`always_on` / `always_off` / `traceidratio`). Otherwise the sampler is
 * derived from `sampleRatio`:
 *   - `<= 0`   → ParentBased(AlwaysOff)
 *   - `>= 1`   → ParentBased(AlwaysOn)
 *   - `(0, 1)` → ParentBased(TraceIdRatioBased(ratio))
 */
function resolveSampler(config: Pick<OtelConfig, "sampleRatio">): Sampler {
  const ratio = normalizeRatio(config.sampleRatio);
  const envSampler = process.env["OTEL_TRACES_SAMPLER"];
  if (envSampler !== undefined && envSampler !== "") {
    switch (envSampler) {
      case "always_on":
        return new AlwaysOnSampler();
      case "always_off":
        return new AlwaysOffSampler();
      case "traceidratio":
        return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
      default:
        // Unknown value — ignore and fall through to config-driven sampling.
        break;
    }
  }
  if (ratio <= 0) {
    return new ParentBasedSampler({ root: new AlwaysOffSampler() });
  }
  if (ratio >= 1) {
    return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
  return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
}

function buildResource(serviceName: string): Resource {
  return resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });
}

function buildPropagator(): TextMapPropagator {
  return new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  });
}

function resolveTraceExporter(config: OtelConfig, endpoint: string): SpanExporter {
  if (config.traceExporter !== undefined) {
    return config.traceExporter;
  }
  return new OTLPTraceExporter({
    url: endpoint,
    headers: config.headers,
  });
}

/** Await a promise but give up after `timeoutMs`; never rejects. */
async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

class EnabledOtelHandle implements OtelHandle {
  private readonly sdk: NodeSDK;
  private readonly graceMs: number;
  private shuttingDown = false;

  constructor(sdk: NodeSDK, graceMs: number) {
    this.sdk = sdk;
    this.graceMs = graceMs;
  }

  isEnabled(): boolean {
    return true;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    await withTimeout(this.sdk.shutdown(), this.graceMs);
  }
}

class NoOpOtelHandle implements OtelHandle {
  isEnabled(): boolean {
    return false;
  }

  async shutdown(): Promise<void> {
    // Nothing to shut down — no SDK, no exporter, no provider was allocated.
  }
}

const noOpHandle: OtelHandle = new NoOpOtelHandle();

let activeHandle: OtelHandle | undefined;

/** Whether a live OpenTelemetry SDK is currently active. */
export function isOtelEnabled(): boolean {
  return activeHandle !== undefined && activeHandle.isEnabled();
}

/**
 * Initialize the OpenTelemetry SDK.
 *
 * Returns a no-op handle (and allocates nothing) when tracing is disabled or
 * no OTLP endpoint can be resolved. Repeated calls are safe: a previously
 * initialized enabled SDK is returned as-is, so a second tracer provider is
 * never allocated.
 */
export async function initOtel(config: OtelConfig = {}): Promise<OtelHandle> {
  const enabled = config.enabled !== false;
  const endpoint = resolveEndpoint(config);
  if (!enabled || endpoint === undefined) {
    return noOpHandle;
  }

  if (activeHandle !== undefined) {
    return activeHandle;
  }

  const serviceName = config.serviceName ?? DEFAULT_SERVICE_NAME;
  const sdkConfig: Partial<NodeSDKConfiguration> = {
    resource: buildResource(serviceName),
    sampler: resolveSampler(config),
    textMapPropagator: buildPropagator(),
    idGenerator: new RequestIdIdGenerator(),
  };
  if (config.spanProcessor !== undefined) {
    sdkConfig.spanProcessors = [config.spanProcessor];
  } else {
    sdkConfig.traceExporter = resolveTraceExporter(config, endpoint);
  }

  const sdk = new NodeSDK(sdkConfig);
  sdk.start();

  activeHandle = new EnabledOtelHandle(sdk, config.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
  return activeHandle;
}

/**
 * Reset the module singleton. Test-only: lets tests start from a clean state
 * (no active SDK) without reloading the whole module graph.
 */
export function resetOtelForTesting(): void {
  activeHandle = undefined;
}
