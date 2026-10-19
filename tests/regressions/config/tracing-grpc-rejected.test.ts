// Backlog #2: `observability.tracing.otlpProtocol: grpc` was accepted but had
// no effect (only the OTLP/HTTP exporter exists). It is now a validation error.
import { describe, expect, it } from "bun:test";
import { base, errors, ok } from "./_h";

describe("otlpProtocol: grpc (backlog #2)", () => {
  it("is rejected with a migration hint", () => {
    const msg = errors(base({ observability: { tracing: { enabled: true, otlpProtocol: "grpc" } } }));
    expect(msg).toMatch(/^observability\.tracing\.otlpProtocol: .*grpc.*not supported.*OTLP\/HTTP/m);
    expect(msg).toMatch(/4318/);
  });

  it("http (and omitting the key) still validate", () => {
    ok(base({ observability: { tracing: { enabled: true, otlpProtocol: "http" } } }));
    ok(base({ observability: { tracing: { enabled: true } } }));
  });
});
