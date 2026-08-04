import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROOT_CONTEXT,
  SpanKind,
  isValidTraceId,
  trace,
  type TextMapPropagator,
} from "@opentelemetry/api";
import { CompositePropagator } from "@opentelemetry/core";
import type { Resource } from "@opentelemetry/resources";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  SamplingDecision,
  type Sampler,
} from "@opentelemetry/sdk-trace-base";

// ---------------------------------------------------------------------------
// Test doubles
//
// The OpenTelemetry SDK and the OTLP HTTP exporter are mocked so tests never
// touch the network and never allocate a real tracer provider. The mocks
// record constructor arguments so the tests can assert on the resolved config.
// The factories are plain closures over module-level state; because the mocked
// modules are only imported when the product module is loaded (inside the
// tests, via dynamic import), the state is always initialized by then.
// ---------------------------------------------------------------------------

interface CapturedSdkConfig {
  sampler?: Sampler;
  textMapPropagator?: TextMapPropagator;
  resource?: Resource;
  traceExporter?: unknown;
  idGenerator?: unknown;
  spanProcessors?: unknown[];
}

interface CapturedExporterConfig {
  url?: string;
  headers?: Record<string, string>;
}

const sdkInstances: CapturedSdkConfig[] = [];
const sdkMockState = { hangShutdown: false };
const otlpInstances: CapturedExporterConfig[] = [];

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class MockNodeSDK {
    constructor(config: CapturedSdkConfig) {
      sdkInstances.push(config);
    }

    start(): void {
      // No-op: never registers a real tracer provider.
    }

    shutdown(): Promise<void> {
      if (sdkMockState.hangShutdown) {
        return new Promise<void>(() => {
          // Never resolves — used to exercise the shutdown grace timeout.
        });
      }
      return Promise.resolve();
    }
  },
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class MockOTLPExporter {
    constructor(config: CapturedExporterConfig) {
      otlpInstances.push(config);
    }
  },
}));

const ENDPOINT = "http://localhost:4318/v1/traces";

function randomTraceId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type OtelModule = typeof import("@/observability/otel");
type OtelTracerModule = typeof import("@/observability/otel-tracer");

let otel: OtelModule;
let otelTracer: OtelTracerModule;

beforeEach(async () => {
  otel = await import("@/observability/otel");
  otelTracer = await import("@/observability/otel-tracer");
  otel.resetOtelForTesting();
  sdkInstances.length = 0;
  sdkMockState.hangShutdown = false;
  otlpInstances.length = 0;
});

afterEach(() => {
  delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  delete process.env["OTEL_TRACES_SAMPLER"];
});

// ---------------------------------------------------------------------------
// No-op behavior
// ---------------------------------------------------------------------------

describe("initOtel — no-op behavior", () => {
  it("returns a no-op handle when tracing is disabled", async () => {
    const handle = await otel.initOtel({ enabled: false });

    expect(handle.isEnabled()).toBe(false);
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("returns a no-op handle when enabled but no endpoint is available", async () => {
    const handle = await otel.initOtel({ enabled: true });

    expect(handle.isEnabled()).toBe(false);
  });

  it("no-op shutdown resolves without throwing", async () => {
    const handle = await otel.initOtel({});
    await expect(handle.shutdown()).resolves.toBeUndefined();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("does not allocate a tracer provider when disabled", async () => {
    const providerBefore = trace.getTracerProvider();

    const handle = await otel.initOtel({ enabled: false, otlpEndpoint: ENDPOINT });

    expect(handle.isEnabled()).toBe(false);
    expect(sdkInstances).toHaveLength(0);
    expect(otlpInstances).toHaveLength(0);
    expect(trace.getTracerProvider()).toBe(providerBefore);
    expect(otel.isOtelEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enabled behavior
// ---------------------------------------------------------------------------

describe("initOtel — enabled behavior", () => {
  it("returns an enabled handle when an endpoint is configured", async () => {
    const handle = await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT });

    expect(handle.isEnabled()).toBe(true);
    expect(otel.isOtelEnabled()).toBe(true);
    expect(sdkInstances).toHaveLength(1);
    expect(otlpInstances).toHaveLength(1);
    expect(otlpInstances[0]?.url).toBe(ENDPOINT);
  });

  it("falls back to OTEL_EXPORTER_OTLP_ENDPOINT when no endpoint is configured", async () => {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = ENDPOINT;

    const handle = await otel.initOtel({ enabled: true });

    expect(handle.isEnabled()).toBe(true);
    expect(otlpInstances[0]?.url).toBe(ENDPOINT);
  });

  it("forwards custom headers to the OTLP exporter", async () => {
    const headers = { Authorization: "Bearer collector-token" };

    await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT, headers });

    expect(otlpInstances[0]?.headers).toEqual(headers);
  });

  it("wires W3C tracecontext + baggage propagation", async () => {
    await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT });

    expect(sdkInstances[0]?.textMapPropagator).toBeInstanceOf(CompositePropagator);
  });

  it("sets the service.name resource attribute from config", async () => {
    await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT, serviceName: "my-gateway" });

    expect(sdkInstances[0]?.resource?.attributes["service.name"]).toBe("my-gateway");
  });

  it("defaults the service.name resource attribute to ai-gateway", async () => {
    await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT });

    expect(sdkInstances[0]?.resource?.attributes["service.name"]).toBe("ai-gateway");
  });

  it("prefers an injected span processor over the OTLP exporter", async () => {
    const spanProcessor = {
      forceFlush: () => Promise.resolve(),
      onEnd: () => {},
      onStart: () => {},
      shutdown: () => Promise.resolve(),
    };

    await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT, spanProcessor });

    expect(sdkInstances[0]?.spanProcessors?.[0]).toBe(spanProcessor);
    expect(sdkInstances[0]?.traceExporter).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

describe("initOtel — sampling", () => {
  it("maps sampleRatio 0 to a ParentBased AlwaysOff root", async () => {
    await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT, sampleRatio: 0 });

    const sampler = sdkInstances[0]?.sampler;
    expect(sampler).toBeInstanceOf(ParentBasedSampler);
    expect(sampler?.toString()).toMatch(/^ParentBased\{root=AlwaysOffSampler/);
  });

  it("maps sampleRatio 1 to a ParentBased AlwaysOn root", async () => {
    await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT, sampleRatio: 1 });

    const sampler = sdkInstances[0]?.sampler;
    expect(sampler).toBeInstanceOf(ParentBasedSampler);
    expect(sampler?.toString()).toMatch(/^ParentBased\{root=AlwaysOnSampler/);
  });

  it("maps sampleRatio 0.5 to a ParentBased TraceIdRatioBased root", async () => {
    await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT, sampleRatio: 0.5 });

    const sampler = sdkInstances[0]?.sampler;
    expect(sampler).toBeInstanceOf(ParentBasedSampler);
    expect(sampler?.toString()).toContain("TraceIdRatioBased{0.5}");
  });

  it("samples approximately half of root traces at ratio 0.5", async () => {
    await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT, sampleRatio: 0.5 });

    const sampler = sdkInstances[0]?.sampler;
    expect(sampler).toBeDefined();

    const N = 2000;
    let sampled = 0;
    for (let i = 0; i < N; i++) {
      const result = sampler!.shouldSample(
        ROOT_CONTEXT,
        randomTraceId(),
        "root-span",
        SpanKind.INTERNAL,
        {},
        [],
      );
      if (result.decision === SamplingDecision.RECORD_AND_SAMPLED) {
        sampled++;
      }
    }

    expect(sampled).toBeGreaterThan(N * 0.4);
    expect(sampled).toBeLessThan(N * 0.6);
  });

  it("lets OTEL_TRACES_SAMPLER=always_on override the sample ratio", async () => {
    process.env["OTEL_TRACES_SAMPLER"] = "always_on";

    await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT, sampleRatio: 0 });

    expect(sdkInstances[0]?.sampler).toBeInstanceOf(AlwaysOnSampler);
  });

  it("lets OTEL_TRACES_SAMPLER=always_off override the sample ratio", async () => {
    process.env["OTEL_TRACES_SAMPLER"] = "always_off";

    await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT, sampleRatio: 1 });

    expect(sdkInstances[0]?.sampler).toBeInstanceOf(AlwaysOffSampler);
  });

  it("lets OTEL_TRACES_SAMPLER=traceidratio use the configured ratio", async () => {
    process.env["OTEL_TRACES_SAMPLER"] = "traceidratio";

    await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT, sampleRatio: 0.5 });

    const sampler = sdkInstances[0]?.sampler;
    expect(sampler).toBeInstanceOf(ParentBasedSampler);
    expect(sampler?.toString()).toContain("TraceIdRatioBased{0.5}");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("initOtel — lifecycle", () => {
  it("is idempotent: repeated calls return the same handle and allocate one SDK", async () => {
    const first = await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT });
    const second = await otel.initOtel({
      enabled: true,
      otlpEndpoint: "http://other:4318/v1/traces",
    });

    expect(second).toBe(first);
    expect(sdkInstances).toHaveLength(1);
    expect(otlpInstances).toHaveLength(1);
  });

  it("shutdown resolves within shutdownGraceMs when the SDK shutdown hangs", async () => {
    sdkMockState.hangShutdown = true;

    const handle = await otel.initOtel({
      enabled: true,
      otlpEndpoint: ENDPOINT,
      shutdownGraceMs: 50,
    });

    const started = performance.now();
    await handle.shutdown();
    const elapsed = performance.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2000);
  });

  it("shutdown resolves quickly when the SDK shuts down cleanly", async () => {
    const handle = await otel.initOtel({ enabled: true, otlpEndpoint: ENDPOINT });

    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Request-id correlation
// ---------------------------------------------------------------------------

describe("request-id correlation", () => {
  it("maps a well-formed 32-hex request id directly to the trace id", () => {
    const generator = new otel.RequestIdIdGenerator();
    const requestId = "0123456789abcdef0123456789abcdef";

    const traceId = otel.withRequestId(requestId, () => generator.generateTraceId());

    expect(traceId).toBe(requestId);
    expect(isValidTraceId(traceId)).toBe(true);
  });

  it("hashes arbitrary request ids into a stable, valid trace id", () => {
    const generator = new otel.RequestIdIdGenerator();
    const requestId = "req-abc-123";

    const first = otel.withRequestId(requestId, () => generator.generateTraceId());
    const second = otel.withRequestId(requestId, () => generator.generateTraceId());

    expect(first).toBe(second);
    expect(first).not.toBe(requestId);
    expect(isValidTraceId(first)).toBe(true);
  });

  it("normalizes uppercase 32-hex request ids to lowercase trace ids", () => {
    expect(otel.traceIdFromRequestId("0123456789ABCDEF0123456789ABCDEF")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
  });

  it("exposes the request id set via withRequestId to getCurrentRequestId", () => {
    const requestId = "req-xyz";

    const observed = otel.withRequestId(requestId, () => otel.getCurrentRequestId());

    expect(observed).toBe(requestId);
    expect(otel.getCurrentRequestId()).toBeUndefined();
  });

  it("generates valid random ids when no request id is in scope", () => {
    const generator = new otel.RequestIdIdGenerator();

    expect(isValidTraceId(generator.generateTraceId())).toBe(true);
    expect(generator.generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// Tracing bridge
// ---------------------------------------------------------------------------

describe("tracing bridge (otel-tracer)", () => {
  it("produces a compatible Span lifecycle in fallback mode", () => {
    const tracer = new otelTracer.OtelTracer({ serviceName: "test-gateway" });
    const span = tracer.startSpan("gateway.route", { "request.model": "gpt-4o" });

    expect(span.name).toBe("gateway.route");
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.attributes["service.name"]).toBe("test-gateway");
    expect(span.attributes["request.model"]).toBe("gpt-4o");
    expect(span.endTime).toBeUndefined();
    expect(span.status).toBe("unset");

    tracer.endSpan(span);

    expect(span.endTime).toBeTypeOf("number");
  });

  it("recordError records an exception event and sets error status", () => {
    const tracer = new otelTracer.OtelTracer();
    const span = tracer.startSpan("gateway.route");

    tracer.recordError(span, new Error("upstream boom"));

    expect(span.status).toBe("error");
    expect(span.events).toHaveLength(1);
    expect(span.events[0]?.name).toBe("exception");
    expect(span.events[0]?.attributes?.["exception.message"]).toBe("upstream boom");
  });

  it("tracks spans via getSpans and clears via clear", () => {
    const tracer = new otelTracer.OtelTracer();
    tracer.startSpan("a");
    tracer.startSpan("b");

    expect(tracer.getSpans()).toHaveLength(2);

    tracer.clear();
    expect(tracer.getSpans()).toHaveLength(0);
  });

  it("correlates the fallback trace id with a provided request id", () => {
    const tracer = new otelTracer.OtelTracer();
    const hex = "0123456789abcdef0123456789abcdef";

    const hexSpan = tracer.startSpan("req", undefined, { requestId: hex });
    expect(hexSpan.traceId).toBe(hex);

    const arbitrarySpan = tracer.startSpan("req2", undefined, { requestId: "req-xyz" });
    expect(arbitrarySpan.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(arbitrarySpan.traceId).not.toBe("req-xyz");
  });

  it("keeps the global bridge tracer stable across getTracer calls", () => {
    expect(otelTracer.getTracer()).toBe(otelTracer.getTracer());
  });

  it("privacyLevel metadata drops sensitive attribute keys", () => {
    const filtered = otelTracer.filterSpanAttributes(
      { apiKey: "sk-123", token: "abc", model: "gpt-4o" },
      "metadata",
    );

    expect(filtered).toEqual({ model: "gpt-4o" });
  });

  it("privacyLevel full additionally drops payload-like keys", () => {
    const filtered = otelTracer.filterSpanAttributes(
      { apiKey: "sk-123", prompt: "hello", model: "gpt-4o" },
      "full",
    );

    expect(filtered).toEqual({ model: "gpt-4o" });
  });

  it("privacyLevel none leaves the attribute object untouched", () => {
    const attrs = { apiKey: "sk-123" };

    expect(otelTracer.filterSpanAttributes(attrs, "none")).toBe(attrs);
  });
});
