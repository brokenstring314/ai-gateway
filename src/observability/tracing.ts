/**
 * Tracing facade. Spans go to the OpenTelemetry SDK through the bridge in
 * otel-tracer.ts (no-op unless observability.tracing.enabled). The old
 * built-in Tracer / OTLP-JSON exporter was removed in 0.2.0.
 */

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, string | number | boolean>;
  status: "ok" | "error" | "unset";
  events: SpanEvent[];
}

export interface SpanEvent {
  name: string;
  time: number;
  attributes?: Record<string, string | number | boolean>;
}

export { getTracer } from "./otel-tracer.js";
