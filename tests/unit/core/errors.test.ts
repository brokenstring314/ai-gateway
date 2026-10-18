import { describe, expect, it } from "bun:test";
import { GatewayError, errorBody, errorHeaders, mostMeaningful, toGatewayError, unwrapExhausted } from "@/core/errors";
import { ProviderError } from "@/providers/openai-compat";
import { PluginRejectionError } from "@/plugins/error";
import { CircuitOpenError } from "@/routing/circuit-breaker";
import { ConcurrencyLimitError } from "@/routing/concurrency-limiter";
import { FallbackExhaustedError } from "@/routing/fallback";
import { RetryExhaustedError } from "@/routing/retry";
import { createTimeoutReason } from "@/core/outcome";

const upstream = (status: number, body?: Record<string, unknown>, retryAfter?: string) => {
  const e = new ProviderError("secret-t", status, String(body?.["message"] ?? `HTTP ${status}`), { origin: "upstream", upstream: body });
  if (retryAfter) e.retryAfter = retryAfter;
  return e;
};

describe("toGatewayError (plan §1.3)", () => {
  it("upstream 4xx keeps status and OpenAI code/type/param/message; target only in header", () => {
    const e = toGatewayError(upstream(400, { message: "too long", type: "invalid_request_error", code: "context_length_exceeded", param: "messages" }));
    expect(e.kind).toBe("upstream_client");
    expect(e.status).toBe(400);
    expect(errorBody(e)).toEqual({ error: { message: "too long", type: "invalid_request_error", code: "context_length_exceeded", param: "messages" } });
    expect(JSON.stringify(errorBody(e))).not.toContain("secret-t");
    expect(errorHeaders(e)["X-Gateway-Target"]).toBe("secret-t");
  });

  it("upstream 429 -> 429 with Retry-After", () => {
    const e = toGatewayError(upstream(429, { message: "slow down" }, "7"));
    expect([e.status, e.kind, errorHeaders(e)["Retry-After"]]).toEqual([429, "upstream_rate", "7"]);
  });

  it("upstream 5xx -> 502 keeping upstream code/type", () => {
    const e = toGatewayError(upstream(503, { message: "overloaded", type: "server_error", code: "overloaded" }));
    expect([e.status, e.kind, e.code]).toEqual([502, "upstream_server", "overloaded"]);
  });

  it("upstream 401/403 -> 502 upstream_auth_failed with a generic message", () => {
    const e = toGatewayError(upstream(401, { message: "Incorrect API key provided: sk-abc" }));
    expect([e.status, e.code]).toEqual([502, "upstream_auth_failed"]);
    expect(e.message).not.toContain("sk-abc");
  });

  it("network error and invalid body -> 502 with fixed messages (no URL)", () => {
    const net = toGatewayError(new ProviderError("t", 0, "fetch failed: ECONNRESET http://10.0.0.1:8080/v1"));
    expect([net.status, net.code, net.message]).toEqual([502, "upstream_unavailable", "Upstream service unavailable"]);
    const bad = toGatewayError(new ProviderError("t", 502, "invalid JSON in upstream response", { origin: "invalid_body" }));
    expect([bad.status, bad.code]).toEqual([502, "upstream_invalid_response"]);
  });

  it("FallbackExhausted / RetryExhausted are unwrapped", () => {
    const inner = upstream(429, { message: "x" });
    const wrapped = new FallbackExhaustedError("all failed", new RetryExhaustedError("retries", inner));
    expect(unwrapExhausted(wrapped)).toBe(inner);
    expect(toGatewayError(wrapped).status).toBe(429);
  });

  it("plugin rejection: 403 by default, the plugin's status (429) and Retry-After when set", () => {
    expect(toGatewayError(new PluginRejectionError("before_request", "no", "word-filter")).status).toBe(403);
    const rl = toGatewayError(new PluginRejectionError("before_request", "limit", "rate-limit", 429, 12));
    expect([rl.status, rl.type, rl.retryAfter]).toEqual([429, "plugin_rejection", "12"]);
  });

  it("breaker open -> 503 with Retry-After; local overload -> 429 gateway_overloaded", () => {
    const open = toGatewayError(new CircuitOpenError("t", 9));
    expect([open.status, open.kind, open.retryAfter]).toEqual([503, "breaker_open", "9"]);
    const busy = toGatewayError(new ConcurrencyLimitError("t"));
    expect([busy.status, busy.code]).toEqual([429, "gateway_overloaded"]);
  });

  it("gateway deadline -> 504 whatever the attempt error was", () => {
    const ac = new AbortController();
    ac.abort(createTimeoutReason(10));
    expect(toGatewayError(upstream(500), { signal: ac.signal }).status).toBe(504);
    expect(toGatewayError(new Error("boom"), { signal: ac.signal }).status).toBe(504);
  });

  it("anything else -> 500 with a fixed message", () => {
    const e = toGatewayError(new Error("db password is hunter2"));
    expect([e.status, e.message]).toEqual([500, "Internal server error"]);
  });

  it("GatewayError exposes statusCode for embedded callers", () => {
    expect(new GatewayError("timeout", { status: 504, message: "m", type: "t" }).statusCode).toBe(504);
  });
});

describe("mostMeaningful", () => {
  it("prefers upstream_client > upstream_rate > upstream_auth > timeout > upstream_server > breaker_open", () => {
    const client = upstream(400, { message: "bad" });
    const rate = upstream(429);
    const auth = upstream(401);
    const server = upstream(500);
    const open = new CircuitOpenError("t");
    expect(mostMeaningful([open, server, auth, rate, client])).toBe(client);
    expect(mostMeaningful([client, rate, open])).toBe(client);
    expect(mostMeaningful([open, server, auth])).toBe(auth);
    expect(mostMeaningful([server, open])).toBe(server);
  });
});
