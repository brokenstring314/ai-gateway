/**
 * Unit tests for proxy-route auth: isProxyAuthAllowed, proxyAuthMiddleware,
 * the standalone handler auth gate, and the timing-safe key validator.
 */

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  createProxyHandler,
  createProxyKeyValidator,
  isProxyAuthAllowed,
  proxyAuthMiddleware,
  type ProxyTarget,
} from "@/proxy/proxy";
import type { KeyStore } from "@/persistence/key-store";

function makeTarget(overrides?: Partial<ProxyTarget>): ProxyTarget {
  return {
    name: "openai-main",
    provider: "openai",
    baseURL: "https://api.openai.com",
    apiKey: "sk-target-key",
    authHeaders: { Authorization: "Bearer sk-target-key" },
    ...overrides,
  };
}

function fakeKeyStore(validKeys: string[]): KeyStore {
  return {
    validateKey: (token: string) => (validKeys.includes(token) ? { id: "k1" } : null),
  } as unknown as KeyStore;
}

describe("isProxyAuthAllowed", () => {
  it("production never allows unauthenticated proxy access, even when explicitly enabled", () => {
    expect(isProxyAuthAllowed({ environment: "production", allowUnauthenticatedProxy: true })).toBe(false);
    expect(isProxyAuthAllowed({ environment: "production", allowUnauthenticatedProxy: false })).toBe(false);
    expect(isProxyAuthAllowed({ environment: "production" })).toBe(false);
  });

  it("non-production allows only when explicitly enabled", () => {
    expect(isProxyAuthAllowed({ allowUnauthenticatedProxy: true })).toBe(true);
    expect(isProxyAuthAllowed({ environment: "development", allowUnauthenticatedProxy: true })).toBe(true);
    expect(isProxyAuthAllowed({ allowUnauthenticatedProxy: false })).toBe(false);
    expect(isProxyAuthAllowed({ environment: "development" })).toBe(false);
    expect(isProxyAuthAllowed({})).toBe(false);
  });
});

describe("createProxyKeyValidator", () => {
  it("accepts only known keys using timing-safe comparison", () => {
    const validate = createProxyKeyValidator(["sk-a", "sk-b"]);
    expect(validate("sk-a")).toBe(true);
    expect(validate("sk-b")).toBe(true);
    expect(validate("sk-c")).toBe(false);
    expect(validate("")).toBe(false);
  });
});

describe("proxyAuthMiddleware", () => {
  function mount(opts: Parameters<typeof proxyAuthMiddleware>[0]): Hono {
    const app = new Hono();
    app.use("/v1/*", proxyAuthMiddleware(opts));
    app.all("/v1/*", (c) => c.json({ ok: true }));
    return app;
  }

  it("passes through when auth is disabled in development", async () => {
    const app = mount({ environment: "development", allowUnauthenticatedProxy: true });
    const res = await app.request("/v1/files", { method: "GET" });
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated requests in production even with the allow flag set", async () => {
    const app = mount({
      environment: "production",
      allowUnauthenticatedProxy: true,
      keyStore: fakeKeyStore(["sk-valid"]),
    });
    const res = await app.request("/v1/files", { method: "GET" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.code).toBe("missing_authorization");
  });

  it("requires a valid Bearer API key when auth is enabled", async () => {
    const app = mount({ keyStore: fakeKeyStore(["sk-valid"]) });

    const ok = await app.request("/v1/files", {
      method: "GET",
      headers: { Authorization: "Bearer sk-valid" },
    });
    expect(ok.status).toBe(200);

    const missing = await app.request("/v1/files", { method: "GET" });
    expect(missing.status).toBe(401);
    const missingBody = (await missing.json()) as { error: { code: string } };
    expect(missingBody.error.code).toBe("missing_authorization");

    const invalid = await app.request("/v1/files", {
      method: "GET",
      headers: { Authorization: "Bearer sk-wrong" },
    });
    expect(invalid.status).toBe(401);
    const invalidBody = (await invalid.json()) as { error: { code: string } };
    expect(invalidBody.error.code).toBe("invalid_api_key");

    const malformed = await app.request("/v1/files", {
      method: "GET",
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(malformed.status).toBe(401);
    const malformedBody = (await malformed.json()) as { error: { code: string } };
    expect(malformedBody.error.code).toBe("invalid_authorization");
  });

  it("uses the keyStore when both keyStore and validateKey are provided", async () => {
    const store = fakeKeyStore(["sk-store"]);
    const app = mount({
      keyStore: store,
      validateKey: () => true,
    });

    const res = await app.request("/v1/files", {
      method: "GET",
      headers: { Authorization: "Bearer sk-wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a custom validateKey validator", async () => {
    const validateKey = vi.fn((token: string) => token === "custom-key");
    const app = mount({ validateKey });

    const ok = await app.request("/v1/files", {
      method: "GET",
      headers: { Authorization: "Bearer custom-key" },
    });
    expect(ok.status).toBe(200);
    expect(validateKey).toHaveBeenCalledWith("custom-key");

    const bad = await app.request("/v1/files", {
      method: "GET",
      headers: { Authorization: "Bearer nope" },
    });
    expect(bad.status).toBe(401);
  });

  it("fails closed when auth is required but no validator is configured", async () => {
    const app = mount({});
    const res = await app.request("/v1/files", {
      method: "GET",
      headers: { Authorization: "Bearer anything" },
    });
    expect(res.status).toBe(401);
  });
});

describe("createProxyHandler auth gate", () => {
  it("enforces auth when the handler is used standalone", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const app = new Hono();
    app.all("/v1/*", createProxyHandler({
      resolveTarget: () => makeTarget(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      keyStore: fakeKeyStore(["sk-valid"]),
    }));

    const denied = await app.request("/v1/files", {
      method: "GET",
      headers: { "X-Provider": "openai" },
    });
    expect(denied.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();

    const allowed = await app.request("/v1/files", {
      method: "GET",
      headers: { "X-Provider": "openai", Authorization: "Bearer sk-valid" },
    });
    expect(allowed.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("production blocks unauthenticated proxying even with the allow flag", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const app = new Hono();
    app.all("/v1/*", createProxyHandler({
      resolveTarget: () => makeTarget(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      environment: "production",
      allowUnauthenticatedProxy: true,
      keyStore: fakeKeyStore(["sk-valid"]),
    }));

    const denied = await app.request("/v1/files", {
      method: "GET",
      headers: { "X-Provider": "openai" },
    });
    expect(denied.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();

    const allowed = await app.request("/v1/files", {
      method: "GET",
      headers: { "X-Provider": "openai", Authorization: "Bearer sk-valid" },
    });
    expect(allowed.status).toBe(200);
  });

  it("allows unauthenticated proxying in development when explicitly enabled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const app = new Hono();
    app.all("/v1/*", createProxyHandler({
      resolveTarget: () => makeTarget(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      environment: "development",
      allowUnauthenticatedProxy: true,
      keyStore: fakeKeyStore(["sk-valid"]),
    }));

    const res = await app.request("/v1/files", {
      method: "GET",
      headers: { "X-Provider": "openai" },
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
