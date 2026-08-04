/**
 * Simple OpenTelemetry-compatible tracing.
 *
 * No-op by default (zero overhead when disabled).
 * When an OTLP HTTP endpoint is configured, exports spans via OTLP HTTP JSON.
 */

import { getTracer as getOtelBridgeTracer } from "./otel-tracer.js";

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

interface SpanEvent {
  name: string;
  time: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface TracingConfig {
  enabled?: boolean;
  otlpEndpoint?: string;
  serviceName?: string;
}

/** Generate a random hex string of the given byte length. */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class Tracer {
  private readonly enabled: boolean;
  private readonly otlpEndpoint: string | undefined;
  private readonly serviceName: string;
  private readonly spans: Span[] = [];

  constructor(config?: TracingConfig) {
    this.enabled = config?.enabled ?? false;
    this.otlpEndpoint = config?.otlpEndpoint;
    this.serviceName = config?.serviceName ?? "ai-gateway";
  }

  /** Start a new span. */
  startSpan(name: string, attrs?: Record<string, string | number | boolean>): Span {
    const span: Span = {
      traceId: randomHex(16),
      spanId: randomHex(8),
      name,
      startTime: Date.now(),
      attributes: { "service.name": this.serviceName, ...attrs },
      status: "unset",
      events: [],
    };

    if (this.enabled) {
      this.spans.push(span);
    }

    return span;
  }

  /** End a span and record its duration. */
  endSpan(span: Span): void {
    span.endTime = Date.now();
    // Export if endpoint is configured
    if (this.enabled && this.otlpEndpoint) {
      this.exportSpan(span).catch(() => {
        // Silently swallow export errors — tracing must not break the gateway
      });
    }
  }

  /** Record an error on a span. */
  recordError(span: Span, error: Error): void {
    span.status = "error";
    span.events.push({
      name: "exception",
      time: Date.now(),
      attributes: {
        "exception.type": error.name,
        "exception.message": error.message,
        "exception.stacktrace": error.stack ?? "",
      },
    });
  }

  /** Get all collected spans (for testing). */
  getSpans(): readonly Span[] {
    return this.spans;
  }

  /** Clear all collected spans (for testing). */
  clear(): void {
    this.spans.length = 0;
  }

  /** Export a single span via OTLP HTTP JSON. */
  private async exportSpan(span: Span): Promise<void> {
    if (!this.otlpEndpoint) return;

    const otlpSpan = {
      traceId: span.traceId,
      spanId: span.spanId,
      name: span.name,
      kind: 1, // INTERNAL
      startTimeUnixNano: String(span.startTime * 1_000_000),
      endTimeUnixNano: span.endTime ? String(span.endTime * 1_000_000) : "0",
      attributes: Object.entries(span.attributes).map(([key, value]) => ({
        key,
        value: {
          stringValue: typeof value === "string" ? value : undefined,
          intValue: typeof value === "number" ? value : undefined,
          boolValue: typeof value === "boolean" ? value : undefined,
        },
      })),
      status: {
        code: span.status === "error" ? 2 : span.status === "ok" ? 1 : 0,
      },
      events: span.events.map((event) => ({
        timeUnixNano: String(event.time * 1_000_000),
        name: event.name,
        attributes: event.attributes
          ? Object.entries(event.attributes).map(([key, value]) => ({
              key,
              value: {
                stringValue: typeof value === "string" ? value : undefined,
                intValue: typeof value === "number" ? value : undefined,
                boolValue: typeof value === "boolean" ? value : undefined,
              },
            }))
          : [],
      })),
    };

    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: this.serviceName } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "ai-gateway" },
              spans: [otlpSpan],
            },
          ],
        },
      ],
    };

    await fetch(this.otlpEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
}

/** Global no-op tracer (zero overhead). */
const noopTracer = new Tracer({ enabled: false });

let globalTracer: Tracer = noopTracer;

/**
 * Configure the global tracer. When OpenTelemetry is active the bridge tracer
 * (otel-tracer.ts) is used instead, so spans flow into the SDK.
 */
export function initTracing(config: TracingConfig): Tracer {
  globalTracer = new Tracer(config);
  return globalTracer;
}

/** Get the global tracer instance (OTel bridge when tracing is enabled). */
export function getTracer(): Tracer {
  return getOtelBridgeTracer() as unknown as Tracer;
}
