/**
 * Prometheus-compatible metrics — simple in-memory implementation.
 *
 * Counters and histograms for request counts, durations, and token usage.
 * Exposes `format()` for the Prometheus text exposition format.
 */

export interface TokenCounts {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export class MetricsRegistry {
  // Counters
  private readonly requestsTotal = new Map<string, number>();
  private readonly tokensInputTotal = new Map<string, number>();
  private readonly tokensOutputTotal = new Map<string, number>();

  // Histograms (stored as individual observations for quantile estimation)
  private readonly requestDurationMs = new Map<string, number[]>();
  private readonly providerDurationMs = new Map<string, number[]>();

  /** Record a completed request. */
  recordRequest(
    provider: string,
    model: string,
    durationMs: number,
    tokens?: TokenCounts,
  ): void {
    const reqKey = `${provider}:${model}`;
    this.requestsTotal.set(reqKey, (this.requestsTotal.get(reqKey) ?? 0) + 1);

    this.pushObservation(this.requestDurationMs, reqKey, durationMs);
    this.pushObservation(this.providerDurationMs, provider, durationMs);

    if (tokens) {
      this.tokensInputTotal.set(reqKey, (this.tokensInputTotal.get(reqKey) ?? 0) + tokens.promptTokens);
      this.tokensOutputTotal.set(reqKey, (this.tokensOutputTotal.get(reqKey) ?? 0) + tokens.completionTokens);
    }
  }

  /** Format all metrics in Prometheus text exposition format. */
  format(): string {
    const lines: string[] = [];

    // --- Counters ---

    lines.push("# HELP ai_gateway_requests_total Total number of requests");
    lines.push("# TYPE ai_gateway_requests_total counter");
    for (const [key, value] of this.requestsTotal) {
      const [provider, model] = this.splitKey(key);
      lines.push(`ai_gateway_requests_total{provider="${provider}",model="${model}"} ${value}`);
    }

    lines.push("# HELP ai_gateway_tokens_input_total Total input tokens consumed");
    lines.push("# TYPE ai_gateway_tokens_input_total counter");
    for (const [key, value] of this.tokensInputTotal) {
      const [provider, model] = this.splitKey(key);
      lines.push(`ai_gateway_tokens_input_total{provider="${provider}",model="${model}"} ${value}`);
    }

    lines.push("# HELP ai_gateway_tokens_output_total Total output tokens generated");
    lines.push("# TYPE ai_gateway_tokens_output_total counter");
    for (const [key, value] of this.tokensOutputTotal) {
      const [provider, model] = this.splitKey(key);
      lines.push(`ai_gateway_tokens_output_total{provider="${provider}",model="${model}"} ${value}`);
    }

    // --- Histograms ---

    lines.push("# HELP ai_gateway_request_duration_ms Request duration in milliseconds");
    lines.push("# TYPE ai_gateway_request_duration_ms histogram");
    for (const [key, observations] of this.requestDurationMs) {
      const [provider, model] = this.splitKey(key);
      this.formatHistogram(lines, "ai_gateway_request_duration_ms", { provider, model }, observations);
    }

    lines.push("# HELP ai_gateway_provider_duration_ms Provider-specific request duration in milliseconds");
    lines.push("# TYPE ai_gateway_provider_duration_ms histogram");
    for (const [provider, observations] of this.providerDurationMs) {
      this.formatHistogram(lines, "ai_gateway_provider_duration_ms", { provider }, observations);
    }

    return lines.join("\n") + "\n";
  }

  /** Reset all metrics (for testing). */
  reset(): void {
    this.requestsTotal.clear();
    this.tokensInputTotal.clear();
    this.tokensOutputTotal.clear();
    this.requestDurationMs.clear();
    this.providerDurationMs.clear();
  }

  // --- Private helpers ---

  private pushObservation(map: Map<string, number[]>, key: string, value: number): void {
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(value);
    } else {
      map.set(key, [value]);
    }
  }

  private splitKey(key: string): [string, string] {
    const idx = key.indexOf(":");
    if (idx === -1) return [key, ""];
    return [key.slice(0, idx), key.slice(idx + 1)];
  }

  private formatHistogram(
    lines: string[],
    name: string,
    labels: Record<string, string>,
    observations: number[],
  ): void {
    // Prometheus histogram buckets (ms)
    const bucketBounds = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");

    const sorted = [...observations].sort((a, b) => a - b);
    let sum = 0;
    for (const obs of sorted) sum += obs;

    // Bucket counts
    let bucketIdx = 0;
    let count = 0;
    for (const obs of sorted) {
      while (bucketIdx < bucketBounds.length && obs > bucketBounds[bucketIdx]!) {
        lines.push(`${name}_bucket{${labelStr},le="${bucketBounds[bucketIdx]!}"} ${count}`);
        bucketIdx++;
      }
      count++;
    }
    // Fill remaining buckets
    while (bucketIdx < bucketBounds.length) {
      lines.push(`${name}_bucket{${labelStr},le="${bucketBounds[bucketIdx]!}"} ${count}`);
      bucketIdx++;
    }
    // +Inf bucket
    lines.push(`${name}_bucket{${labelStr},le="+Inf"} ${count}`);

    // Sum and count
    lines.push(`${name}_sum{${labelStr}} ${sum}`);
    lines.push(`${name}_count{${labelStr}} ${count}`);
  }
}

/** Global metrics registry. */
let globalMetrics: MetricsRegistry = new MetricsRegistry();

/** Get the global metrics registry. */
export function getMetrics(): MetricsRegistry {
  return globalMetrics;
}

/** Replace the global metrics registry (for testing). */
export function setMetrics(registry: MetricsRegistry): void {
  globalMetrics = registry;
}
