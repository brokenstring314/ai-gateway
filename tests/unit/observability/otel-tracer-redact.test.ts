import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OtelTracer } from "@/observability/otel-tracer";
import { initOtel, resetOtelForTesting } from "@/observability/otel";

const SECRET = "sk-abcdefghijklmnop";

// The OTel SDK registers a global provider once per process, so initialize a
// single time; privacy is applied per OtelTracer instance.
const exporter = new InMemorySpanExporter();
beforeAll(async () => {
  resetOtelForTesting();
  await initOtel({ otlpEndpoint: "http://127.0.0.1:1", spanProcessor: new SimpleSpanProcessor(exporter), privacyLevel: "metadata" });
});
afterAll(() => {
  resetOtelForTesting();
});

async function exportedErrorSpan(privacyLevel: "none" | "metadata" | "full" | undefined) {
  exporter.reset();
  const tracer = new OtelTracer({ privacyLevel });
  const span = tracer.startSpan("x");
  tracer.recordError(span, new Error(`Incorrect API key provided: ${SECRET} (Bearer tok.en-123)`));
  tracer.endSpan(span);
  for (let i = 0; i < 50 && exporter.getFinishedSpans().length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return { otel: exporter.getFinishedSpans()[0], local: span };
}

describe("OtelTracer.recordError redaction", () => {
  for (const level of ["metadata", "full", undefined] as const) {
    it(`redacts secrets from exception message/stack/status (privacyLevel=${String(level)})`, async () => {
      const { otel, local } = await exportedErrorSpan(level);
      expect(otel).toBeDefined();
      const blob = JSON.stringify({ status: otel!.status, events: otel!.events, local: local.events });
      expect(blob).not.toContain(SECRET);
      expect(blob).not.toContain("tok.en-123");
      expect(blob).toContain("[REDACTED_KEY]");
      expect(otel!.status.code).toBe(2); // ERROR
    });
  }

  it("keeps the raw message when privacyLevel is none", async () => {
    const { otel } = await exportedErrorSpan("none");
    expect(otel!.status.message).toContain(SECRET);
  });
});
