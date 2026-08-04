import { describe, expect, it } from "vitest";
import type { TracingPolicy } from "@/observability/otel-policy";
import {
  applyPrivacy,
  parseShutdownGrace,
  policyHeaders,
  shouldSample,
} from "@/observability/otel-policy";

describe("shouldSample", () => {
  it("never samples at ratio 0", () => {
    expect(shouldSample(0)).toBe(false);
    expect(shouldSample(0, "trace-0")).toBe(false);
  });

  it("always samples at ratio 1", () => {
    expect(shouldSample(1)).toBe(true);
    expect(shouldSample(1, "trace-0")).toBe(true);
  });

  it("samples roughly half of random calls at ratio 0.5", () => {
    const iterations = 2000;
    let sampled = 0;
    for (let i = 0; i < iterations; i++) {
      if (shouldSample(0.5)) sampled++;
    }
    expect(sampled).toBeGreaterThan(iterations * 0.4);
    expect(sampled).toBeLessThan(iterations * 0.6);
  });

  it("samples roughly half of deterministic trace ids at ratio 0.5", () => {
    let sampled = 0;
    for (let i = 0; i < 500; i++) {
      if (shouldSample(0.5, `trace-${i}`)) sampled++;
    }
    expect(sampled).toBeGreaterThan(150);
    expect(sampled).toBeLessThan(350);
  });

  it("is stable for the same trace id", () => {
    const traceId = "abcdef0123456789abcdef0123456789";
    const first = shouldSample(0.5, traceId);
    for (let i = 0; i < 50; i++) {
      expect(shouldSample(0.5, traceId)).toBe(first);
    }
  });

  it("produces both outcomes across many trace ids", () => {
    const outcomes = new Set<boolean>();
    for (let i = 0; i < 500; i++) {
      outcomes.add(shouldSample(0.5, `trace-${i}`));
    }
    expect(outcomes.has(true)).toBe(true);
    expect(outcomes.has(false)).toBe(true);
  });
});

describe("applyPrivacy", () => {
  it("redacts secrets at the metadata level", () => {
    expect(
      applyPrivacy("contact alice@example.com with sk-proj-abcdef1234567890", "metadata"),
    ).toBe("contact [REDACTED_EMAIL] with [REDACTED_KEY]");
  });

  it("leaves the message unchanged at the full level", () => {
    const message = "contact alice@example.com";
    expect(applyPrivacy(message, "full")).toBe(message);
  });

  it("leaves the message unchanged at the none level", () => {
    const message = "contact alice@example.com";
    expect(applyPrivacy(message, "none")).toBe(message);
  });
});

describe("parseShutdownGrace", () => {
  it("parses seconds", () => {
    expect(parseShutdownGrace("10s")).toBe(10_000);
  });

  it("parses milliseconds", () => {
    expect(parseShutdownGrace("500ms")).toBe(500);
  });

  it("parses minutes", () => {
    expect(parseShutdownGrace("2m")).toBe(120_000);
  });

  it("falls back to the default for invalid values", () => {
    expect(parseShutdownGrace("soon")).toBe(10_000);
    expect(parseShutdownGrace("10")).toBe(10_000);
    expect(parseShutdownGrace("-5s")).toBe(10_000);
  });

  it("falls back to the default when the value is undefined", () => {
    expect(parseShutdownGrace(undefined)).toBe(10_000);
    expect(parseShutdownGrace(undefined, 2_500)).toBe(2_500);
  });
});

describe("policyHeaders", () => {
  it("passes through the configured headers", () => {
    const policy: TracingPolicy = {
      sampleRatio: 1,
      privacyLevel: "metadata",
      shutdownGraceMs: 10_000,
      headers: { Authorization: "Bearer xyz", "X-Tenant": "acme" },
    };
    expect(policyHeaders(policy)).toEqual({
      Authorization: "Bearer xyz",
      "X-Tenant": "acme",
    });
  });

  it("returns an empty object when no headers are configured", () => {
    const policy: TracingPolicy = {
      sampleRatio: 1,
      privacyLevel: "none",
      shutdownGraceMs: 10_000,
    };
    expect(policyHeaders(policy)).toEqual({});
  });
});
