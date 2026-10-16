/**
 * OpenTelemetry-backed bridge for the gateway's tracing abstraction.
 *
 * Implements the same public API as `./tracing.ts` (`getTracer()`,
 * `startSpan`, `endSpan`, `recordError`, ...) on top of the OpenTelemetry
 * SDK. Call sites that already use `getTracer()`/`startSpan` can switch to
 * this module without changing their code.
 *
 * When OpenTelemetry is not initialized (or no endpoint is configured) spans
 * degrade to lightweight local records — no SDK is allocated, matching the
 * zero-overhead behavior of `tracing.ts`.
 */

import { SpanStatusCode, trace, type Span as OtelSpan, type Tracer as OtelApiTracer } from "@opentelemetry/api";
import type { Span } from "./tracing.js";
import {
  getCurrentRequestId,
  initOtel,
  isOtelEnabled,
  randomHex,
  traceIdFromRequestId,
  withRequestId,
} from "./otel.js";
import type { OtelConfig } from "./otel.js";
import { applyPrivacy } from "./otel-policy.js";

export interface StartSpanOptions {
  /** Correlate the span's trace id with the request's X-Request-Id. */
  requestId?: string;
}

export interface OtelTracerOptions {
  /** `service.name` attribute used by local (fallback) spans. */
  serviceName?: string;
  /** Privacy level applied to span attributes sent to OpenTelemetry. */
  privacyLevel?: OtelConfig["privacyLevel"];
}

const SENSITIVE_KEY_PATTERN =
  /^(authorization|apikey|api[_-]?key|token|secret|password|access[_-]?token|webhook[_-]?secret)$/i;
const PAYLOAD_KEY_PATTERN = /(prompt|content|message|body|text|input)$/i;

/**
 * Apply privacy-level filtering to span attributes.
 * - `"none"`     – return the attributes unchanged
 * - `"metadata"` – drop sensitive attribute keys
 * - `"full"`     – also drop payload-like attribute keys
 */
export function filterSpanAttributes(
  attrs: Record<string, string | number | boolean> | undefined,
  privacyLevel: OtelConfig["privacyLevel"] | undefined,
): Record<string, string | number | boolean> | undefined {
  if (attrs === undefined || privacyLevel === undefined || privacyLevel === "none") {
    return attrs;
  }
  const filtered: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      continue;
    }
    if (privacyLevel === "full" && PAYLOAD_KEY_PATTERN.test(key)) {
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
}

const otelSpanByWrapper = new WeakMap<Span, OtelSpan>();

/** Upper bound on locally buffered spans to keep long-running memory bounded. */
const MAX_BUFFERED_SPANS = 10_000;

export class OtelTracer {
  private readonly apiTracer: OtelApiTracer;
  private readonly serviceName: string;
  private readonly privacyLevel: OtelConfig["privacyLevel"];
  private readonly spans: Span[] = [];

  constructor(options: OtelTracerOptions = {}) {
    this.apiTracer = trace.getTracer("ai-gateway");
    this.serviceName = options.serviceName ?? "ai-gateway";
    this.privacyLevel = options.privacyLevel;
  }

  /**
   * Start a new span. When OpenTelemetry is active the span is created on the
   * registered SDK; otherwise a lightweight local span is produced.
   */
  startSpan(
    name: string,
    attrs?: Record<string, string | number | boolean>,
    options?: StartSpanOptions,
  ): Span {
    const requestId = options?.requestId ?? getCurrentRequestId();
    if (isOtelEnabled()) {
      return this.startOtelSpan(name, attrs, requestId);
    }
    return this.startLocalSpan(name, attrs, requestId);
  }

  /** End a span and record its duration. */
  endSpan(span: Span): void {
    span.endTime = Date.now();
    const otelSpan = otelSpanByWrapper.get(span);
    if (otelSpan !== undefined) {
      otelSpan.end();
    }
  }

  /**
   * Record an error on a span. Error messages and stacks routinely carry
   * secrets (upstream "Incorrect API key provided: sk-..." etc.), so they are
   * passed through redactMessage unless privacyLevel is explicitly "none".
   */
  recordError(span: Span, error: Error): void {
    const message = this.redactErrorText(error.message ?? "");
    const stack = this.redactErrorText(error.stack ?? "");
    span.status = "error";
    span.events.push({
      name: "exception",
      time: Date.now(),
      attributes: {
        "exception.type": error.name,
        "exception.message": message,
        "exception.stacktrace": stack,
      },
    });
    const otelSpan = otelSpanByWrapper.get(span);
    if (otelSpan !== undefined) {
      otelSpan.recordException({ name: error.name, message, stack });
      otelSpan.setStatus({ code: SpanStatusCode.ERROR, message });
    }
  }

  private redactErrorText(text: string): string {
    if (this.privacyLevel === "none") return text;
    // "metadata" and "full" (and unset) both strip known secret patterns.
    return applyPrivacy(text, "metadata");
  }

  /** Get all spans tracked by this tracer (including fallback spans). */
  getSpans(): readonly Span[] {
    return this.spans;
  }

  /** Clear the tracked-span buffer (does not affect the SDK). */
  clear(): void {
    this.spans.length = 0;
  }

  private startOtelSpan(
    name: string,
    attrs: Record<string, string | number | boolean> | undefined,
    requestId: string | undefined,
  ): Span {
    const otelSpan = withRequestId(requestId, () =>
      this.apiTracer.startSpan(name, {
        attributes: filterSpanAttributes(attrs, this.privacyLevel),
      }),
    );
    const spanContext = otelSpan.spanContext();
    const wrapper: Span = {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      name,
      startTime: Date.now(),
      attributes: { ...(attrs ?? {}) },
      status: "unset",
      events: [],
    };
    otelSpanByWrapper.set(wrapper, otelSpan);
    this.spans.push(wrapper);
    if (this.spans.length > MAX_BUFFERED_SPANS) {
      this.spans.shift();
    }
    return wrapper;
  }

  private startLocalSpan(
    name: string,
    attrs: Record<string, string | number | boolean> | undefined,
    requestId: string | undefined,
  ): Span {
    const traceId = requestId !== undefined ? traceIdFromRequestId(requestId) : randomHex(16);
    const span: Span = {
      traceId,
      spanId: randomHex(8),
      name,
      startTime: Date.now(),
      attributes: { "service.name": this.serviceName, ...(attrs ?? {}) },
      status: "unset",
      events: [],
    };
    this.spans.push(span);
    if (this.spans.length > MAX_BUFFERED_SPANS) {
      this.spans.shift();
    }
    return span;
  }
}

let globalOtelTracer: OtelTracer | undefined;

/** Get the global bridge tracer instance. */
export function getTracer(): OtelTracer {
  if (globalOtelTracer === undefined) {
    globalOtelTracer = new OtelTracer();
  }
  return globalOtelTracer;
}

/**
 * Initialize OpenTelemetry and return a bridge tracer that shares its config.
 * Safe to call repeatedly — `initOtel` is idempotent.
 */
export async function initOtelTracer(config: OtelConfig = {}): Promise<OtelTracer> {
  await initOtel(config);
  globalOtelTracer = new OtelTracer({
    serviceName: config.serviceName,
    privacyLevel: config.privacyLevel,
  });
  return globalOtelTracer;
}
