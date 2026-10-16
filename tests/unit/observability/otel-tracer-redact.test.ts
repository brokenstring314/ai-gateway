import { describe, expect, it } from "bun:test";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OtelTracer } from "@/observability/otel-tracer";

const SECRET = "sk-abcdefghijklmnop";

// Deterministic & isolated: use a private BasicTracerProvider with a synchronous
// SimpleSpanProcessor -> InMemorySpanExporter and inject its tracer into
// OtelTracer. No initOtel()/NodeSDK, no global tracer provider (set-once per
// process, and otel.test.ts replaces @opentelemetry/sdk-node with a
// process-wide vi.mock whose start() registers nothing), no network exporter,
// no polling with real timers.
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const apiTracer = provider.getTracer("otel-tracer-redact-test");

function exportedErrorSpan(privacyLevel: "none" | "metadata" | "full" | undefined) {
  exporter.reset();
  const tracer = new OtelTracer({ privacyLevel, tracer: apiTracer });
  const span = tracer.startSpan("x");
  tracer.recordError(span, new Error(`Incorrect API key provided: ${SECRET} (Bearer tok.en-123)`));
  tracer.endSpan(span);
  const finished = exporter.getFinishedSpans();
  expect(finished.length).toBe(1);
  return { otel: finished[0]!, local: span };
}

describe("OtelTracer.recordError redaction", () => {
  for (const level of ["metadata", "full", undefined] as const) {
    it(`redacts secrets from exception message/stack/status (privacyLevel=${String(level)})`, () => {
      const { otel, local } = exportedErrorSpan(level);
      const blob = JSON.stringify({ status: otel.status, events: otel.events, local: local.events });
      expect(blob).not.toContain(SECRET);
      expect(blob).not.toContain("tok.en-123");
      expect(blob).toContain("[REDACTED_KEY]");
      expect(otel.status.code).toBe(2); // ERROR
    });
  }

  it("keeps the raw message when privacyLevel is none", () => {
    const { otel } = exportedErrorSpan("none");
    expect(otel.status.message).toContain(SECRET);
  });
});
