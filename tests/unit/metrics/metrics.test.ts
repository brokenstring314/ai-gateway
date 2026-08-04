import { describe, expect, it } from "vitest";
import { Counter, Gauge, Histogram } from "prom-client";
import {
  Metrics,
  getMetrics,
  resetMetrics,
} from "../../../src/metrics/metrics.js";
import type {
  CircuitBreakerState,
  RequestLabels,
} from "../../../src/metrics/metrics.js";

const PREFIX = "ai_gateway";

interface Sample {
  labels: Record<string, string>;
  value: number;
}

const METRIC_NAME_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)/;
const SAMPLE_VALUE_RE = /^\s+([0-9.+-eE]+)$/;

/** Index of the `}` that closes the label block (respecting quoted values). */
function findClosingBrace(text: string): number {
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\" && inQuotes) {
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "}" && !inQuotes) return i;
  }
  return -1;
}

/** Parse a `key="value",key2="value2"` label block (quote-aware). */
function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    const eq = text.indexOf("=", i);
    if (eq === -1) break;
    const key = text.slice(i, eq).trim();
    i = eq + 1;
    if (text[i] !== '"') break;
    let value = "";
    i++;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\\" && i + 1 < text.length) {
        value += text[i + 1];
        i += 2;
      } else if (ch === '"') {
        i++;
        break;
      } else {
        value += ch;
        i++;
      }
    }
    labels[key] = value;
    if (text[i] === ",") i++;
  }
  return labels;
}

/**
 * Parse the Prometheus text exposition format into metric name -> samples.
 * Throws if any non-comment line is not parseable.
 */
function parseMetrics(text: string): Map<string, Sample[]> {
  const samples = new Map<string, Sample[]>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const nameMatch = METRIC_NAME_RE.exec(line);
    if (nameMatch === null) {
      throw new Error(`Unparseable metric line: ${line}`);
    }
    const name = nameMatch[1] ?? "";
    let rest = line.slice(name.length);
    const labels: Record<string, string> = {};
    if (rest.startsWith("{")) {
      const end = findClosingBrace(rest);
      if (end === -1) {
        throw new Error(`Unclosed label block in metric line: ${line}`);
      }
      Object.assign(labels, parseLabels(rest.slice(1, end)));
      rest = rest.slice(end + 1);
    }
    const valueMatch = SAMPLE_VALUE_RE.exec(rest);
    if (valueMatch === null) {
      throw new Error(`Unparseable metric line: ${line}`);
    }
    const sample: Sample = { labels, value: Number(valueMatch[1]) };
    const list = samples.get(name);
    if (list === undefined) {
      samples.set(name, [sample]);
    } else {
      list.push(sample);
    }
  }
  return samples;
}

function findSample(
  samples: Map<string, Sample[]>,
  name: string,
  labels: Record<string, string>,
): Sample | undefined {
  return samples
    .get(name)
    ?.find((s) =>
      Object.entries(labels).every(([key, value]) => s.labels[key] === value),
    );
}

const reqLabels: RequestLabels = {
  method: "POST",
  status: 200,
  provider: "openai",
};

describe("Metrics", () => {
  it("registers all expected metrics with HELP/TYPE lines", async () => {
    const metrics = new Metrics();
    const text = await metrics.format();
    const expected: Array<[string, string]> = [
      [`${PREFIX}_requests_total`, "counter"],
      [`${PREFIX}_request_duration_seconds`, "histogram"],
      [`${PREFIX}_tokens_input_total`, "counter"],
      [`${PREFIX}_tokens_output_total`, "counter"],
      [`${PREFIX}_provider_errors_total`, "counter"],
      [`${PREFIX}_circuit_breaker_state`, "gauge"],
      [`${PREFIX}_mcp_server_up`, "gauge"],
      [`${PREFIX}_rate_limit_rejections_total`, "counter"],
      [`${PREFIX}_request_cost_usd`, "counter"],
    ];
    for (const [name, type] of expected) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} ${type}`);
    }
  });

  it("exposes the underlying registry with correctly typed metrics", () => {
    const metrics = new Metrics();
    expect(
      metrics.registry.getSingleMetric(`${PREFIX}_requests_total`),
    ).toBeInstanceOf(Counter);
    expect(
      metrics.registry.getSingleMetric(
        `${PREFIX}_request_duration_seconds`,
      ),
    ).toBeInstanceOf(Histogram);
    expect(
      metrics.registry.getSingleMetric(`${PREFIX}_mcp_server_up`),
    ).toBeInstanceOf(Gauge);
  });

  it("recordRequest increments requests_total with method/status/provider labels", async () => {
    const metrics = new Metrics();
    metrics.recordRequest(reqLabels);
    metrics.recordRequest(reqLabels);
    metrics.recordRequest({
      method: "GET",
      status: 429,
      provider: "anthropic",
    });

    const samples = parseMetrics(await metrics.format());
    expect(
      findSample(samples, `${PREFIX}_requests_total`, {
        method: "POST",
        status: "200",
        provider: "openai",
      })?.value,
    ).toBe(2);
    expect(
      findSample(samples, `${PREFIX}_requests_total`, {
        method: "GET",
        status: "429",
        provider: "anthropic",
      })?.value,
    ).toBe(1);
  });

  it("observeDuration records request_duration_seconds histogram with labels", async () => {
    const metrics = new Metrics();
    metrics.observeDuration(0.1, reqLabels);
    metrics.observeDuration(0.3, reqLabels);

    const samples = parseMetrics(await metrics.format());
    const name = `${PREFIX}_request_duration_seconds`;
    const labels = { method: "POST", status: "200", provider: "openai" };

    const count = findSample(samples, `${name}_count`, labels);
    const sum = findSample(samples, `${name}_sum`, labels);
    expect(count?.value).toBe(2);
    expect(sum?.value).toBeCloseTo(0.4, 10);

    // Bucket le="0.25" contains only the 0.1 observation.
    const bucketQuarter = findSample(samples, `${name}_bucket`, {
      ...labels,
      le: "0.25",
    });
    expect(bucketQuarter?.value).toBe(1);
    // The +Inf bucket contains all observations.
    const bucketInf = findSample(samples, `${name}_bucket`, {
      ...labels,
      le: "+Inf",
    });
    expect(bucketInf?.value).toBe(2);
  });

  it("recordTokens increments token counters with provider/model labels", async () => {
    const metrics = new Metrics();
    metrics.recordTokens("openai", "gpt-4o", 10, 20);
    metrics.recordTokens("openai", "gpt-4o", 5, 7);
    metrics.recordTokens("anthropic", "claude-3", 3, 4);

    const samples = parseMetrics(await metrics.format());
    expect(
      findSample(samples, `${PREFIX}_tokens_input_total`, {
        provider: "openai",
        model: "gpt-4o",
      })?.value,
    ).toBe(15);
    expect(
      findSample(samples, `${PREFIX}_tokens_output_total`, {
        provider: "openai",
        model: "gpt-4o",
      })?.value,
    ).toBe(27);
    expect(
      findSample(samples, `${PREFIX}_tokens_input_total`, {
        provider: "anthropic",
        model: "claude-3",
      })?.value,
    ).toBe(3);
  });

  it("recordProviderError increments provider_errors_total with labels", async () => {
    const metrics = new Metrics();
    metrics.recordProviderError("openai", "timeout");
    metrics.recordProviderError("openai", "timeout");
    metrics.recordProviderError("openai");

    const samples = parseMetrics(await metrics.format());
    expect(
      findSample(samples, `${PREFIX}_provider_errors_total`, {
        provider: "openai",
        error_type: "timeout",
      })?.value,
    ).toBe(2);
    expect(
      findSample(samples, `${PREFIX}_provider_errors_total`, {
        provider: "openai",
        error_type: "unknown",
      })?.value,
    ).toBe(1);
  });

  it("setCircuitBreakerState marks the active state 1 and stale states 0", async () => {
    const metrics = new Metrics();
    metrics.setCircuitBreakerState("openai", "OPEN");
    metrics.setCircuitBreakerState("openai", "HALF_OPEN");

    const samples = parseMetrics(await metrics.format());
    const name = `${PREFIX}_circuit_breaker_state`;
    expect(
      findSample(samples, name, { provider: "openai", state: "open" })?.value,
    ).toBe(0);
    expect(
      findSample(samples, name, {
        provider: "openai",
        state: "half_open",
      })?.value,
    ).toBe(1);
    // A state that was never active does not appear at all.
    expect(
      findSample(samples, name, { provider: "openai", state: "closed" }),
    ).toBeUndefined();
  });

  it("setCircuitBreakerState rejects unknown states", () => {
    const metrics = new Metrics();
    expect(() =>
      metrics.setCircuitBreakerState(
        "openai",
        "DEGRADED" as CircuitBreakerState,
      ),
    ).toThrow(RangeError);
  });

  it("setMcpServerUp tracks mcp_server_up gauge per server", async () => {
    const metrics = new Metrics();
    metrics.setMcpServerUp("filesystem", true);
    metrics.setMcpServerUp("github", false);

    const samples = parseMetrics(await metrics.format());
    expect(
      findSample(samples, `${PREFIX}_mcp_server_up`, {
        server: "filesystem",
      })?.value,
    ).toBe(1);
    expect(
      findSample(samples, `${PREFIX}_mcp_server_up`, { server: "github" })
        ?.value,
    ).toBe(0);
  });

  it("recordRateLimitRejection increments the rate limit counter", async () => {
    const metrics = new Metrics();
    metrics.recordRateLimitRejection("openai");
    metrics.recordRateLimitRejection("openai");
    metrics.recordRateLimitRejection();

    const samples = parseMetrics(await metrics.format());
    expect(
      findSample(samples, `${PREFIX}_rate_limit_rejections_total`, {
        provider: "openai",
      })?.value,
    ).toBe(2);
    expect(
      findSample(samples, `${PREFIX}_rate_limit_rejections_total`, {
        provider: "unknown",
      })?.value,
    ).toBe(1);
  });

  it("recordCost accumulates request_cost_usd per provider/model", async () => {
    const metrics = new Metrics();
    metrics.recordCost("openai", "gpt-4o", 0.0015);
    metrics.recordCost("openai", "gpt-4o", 0.0005);
    metrics.recordCost("anthropic", "claude-3", 0.002);

    const samples = parseMetrics(await metrics.format());
    expect(
      findSample(samples, `${PREFIX}_request_cost_usd`, {
        provider: "openai",
        model: "gpt-4o",
      })?.value,
    ).toBeCloseTo(0.002, 10);
    expect(
      findSample(samples, `${PREFIX}_request_cost_usd`, {
        provider: "anthropic",
        model: "claude-3",
      })?.value,
    ).toBe(0.002);
  });

  it("reset clears recorded values but keeps metric definitions", async () => {
    const metrics = new Metrics();
    metrics.recordRequest(reqLabels);
    metrics.observeDuration(0.5, reqLabels);
    metrics.setMcpServerUp("filesystem", true);
    metrics.setCircuitBreakerState("openai", "OPEN");
    metrics.recordTokens("openai", "gpt-4o", 5, 5);
    metrics.recordProviderError("openai", "timeout");
    metrics.recordRateLimitRejection("openai");
    metrics.recordCost("openai", "gpt-4o", 0.01);
    metrics.reset();

    const text = await metrics.format();
    // Definitions remain registered.
    expect(text).toContain("# TYPE ai_gateway_requests_total counter");
    // No sample lines with any recorded label values remain.
    expect(text).not.toContain('provider="openai"');
    expect(text).not.toContain('server="filesystem"');
    expect(text).not.toContain('model="gpt-4o"');

    const samples = parseMetrics(text);
    expect(
      findSample(samples, `${PREFIX}_requests_total`, {
        method: "POST",
        status: "200",
        provider: "openai",
      }),
    ).toBeUndefined();
    expect(
      findSample(samples, `${PREFIX}_mcp_server_up`, {
        server: "filesystem",
      }),
    ).toBeUndefined();
  });

  it("format returns valid Prometheus text exposition format", async () => {
    const metrics = new Metrics();
    metrics.recordRequest({ method: "POST", status: 500, provider: "openai" });
    metrics.observeDuration(0.05, {
      method: "POST",
      status: 500,
      provider: "openai",
    });
    metrics.setMcpServerUp("filesystem", true);
    metrics.recordCost("openai", "gpt-4o", 0.01);
    metrics.recordProviderError("openai", "timeout");
    metrics.setCircuitBreakerState("openai", "OPEN");

    const text = await metrics.format();
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toMatch(/^# HELP /m);
    expect(text).toMatch(/^# TYPE /m);

    // Every non-comment line must parse as `name[{labels}] value`.
    const samples = parseMetrics(text);
    expect(samples.size).toBeGreaterThan(0);
    for (const name of samples.keys()) {
      expect(name).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/);
    }
  });

  it("sanitizes label values to prevent format and cardinality injection", async () => {
    const metrics = new Metrics();
    metrics.recordRequest({
      method: "POST",
      status: 200,
      provider: 'openai"}\n# TYPE evil counter\n  }',
    });
    metrics.recordRequest({
      method: "GET",
      status: 418,
      provider: `openai with a very long name ${"x".repeat(200)}`,
    });

    const text = await metrics.format();
    // The injected pseudo-lines must not appear as real output lines; the
    // sanitizer keeps them embedded inside a single escaped label value.
    expect(text).not.toContain("\n# TYPE evil");
    expect(text).not.toContain("\n# HELP evil");
    const samples = parseMetrics(text);

    const reqs = samples.get(`${PREFIX}_requests_total`) ?? [];
    const injected = reqs.find(
      (s) => s.labels.method === "POST" && s.labels.status === "200",
    );
    expect(injected).toBeDefined();
    expect(injected?.labels.provider).toBe(
      "openai_}_# TYPE evil counter_  }",
    );

    const longOne = reqs.find((s) => s.labels.method === "GET");
    expect(longOne?.labels.provider?.startsWith("openai with a very long name")).toBe(
      true,
    );
    expect(longOne?.labels.provider?.length).toBe(64);
  });

  it("clamps invalid numeric inputs to zero", async () => {
    const metrics = new Metrics();
    metrics.observeDuration(-1, reqLabels);
    metrics.recordTokens("openai", "gpt-4o", -5, Number.NaN);
    metrics.recordCost("openai", "gpt-4o", -1);

    const samples = parseMetrics(await metrics.format());
    const name = `${PREFIX}_request_duration_seconds`;
    expect(
      findSample(samples, `${name}_count`, {
        method: "POST",
        status: "200",
        provider: "openai",
      })?.value,
    ).toBe(1);
    expect(
      findSample(samples, `${name}_sum`, {
        method: "POST",
        status: "200",
        provider: "openai",
      })?.value,
    ).toBe(0);
    expect(
      findSample(samples, `${PREFIX}_tokens_input_total`, {
        provider: "openai",
        model: "gpt-4o",
      })?.value,
    ).toBe(0);
    expect(
      findSample(samples, `${PREFIX}_request_cost_usd`, {
        provider: "openai",
        model: "gpt-4o",
      })?.value,
    ).toBe(0);
  });

  it("instances are isolated from each other", async () => {
    const a = new Metrics();
    const b = new Metrics();
    a.recordRequest(reqLabels);
    expect(await b.format()).not.toContain("openai");
  });

  it("supports a custom metric name prefix", async () => {
    const metrics = new Metrics({ prefix: "gw" });
    metrics.recordRequest(reqLabels);
    const text = await metrics.format();
    expect(text).toContain("# TYPE gw_requests_total counter");
    expect(text).not.toContain("ai_gateway_requests_total");
  });

  it("getMetrics returns a shared singleton and resetMetrics resets it", async () => {
    resetMetrics();
    const first = getMetrics();
    const second = getMetrics();
    expect(first).toBe(second);

    first.recordRequest(reqLabels);
    expect(await first.format()).toContain('provider="openai"');

    resetMetrics();
    expect(await first.format()).not.toContain('provider="openai"');
  });
});
