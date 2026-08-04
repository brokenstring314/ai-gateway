import { afterEach, describe, expect, it } from "vitest";
import {
  ProductionSafetyError,
  isProductionMode,
  parseAllowUnauthenticatedProxy,
  validateProductionSafety,
} from "../../../src/config/production-safety.js";

const ENV_KEYS = ["GATEWAY_ENV", "ALLOW_UNAUTHENTICATED_PROXY"] as const;

const savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = {
  GATEWAY_ENV: process.env.GATEWAY_ENV,
  ALLOW_UNAUTHENTICATED_PROXY: process.env.ALLOW_UNAUTHENTICATED_PROXY,
};

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = savedEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

describe("validateProductionSafety", () => {
  it("does not validate when gatewayEnv is not production", () => {
    expect(() =>
      validateProductionSafety({
        gatewayEnv: "development",
        allowUnauthenticatedProxy: true,
        adminSecret: "short",
        authEnabled: false,
        hasAuthKeys: false,
        keyStoreEmpty: true,
      }),
    ).not.toThrow();
  });

  it("does not validate when gatewayEnv is unset", () => {
    expect(() =>
      validateProductionSafety({
        allowUnauthenticatedProxy: true,
        authEnabled: false,
      }),
    ).not.toThrow();
  });

  it("throws when allowUnauthenticatedProxy is true in production", () => {
    expect(() =>
      validateProductionSafety({
        gatewayEnv: "production",
        allowUnauthenticatedProxy: true,
      }),
    ).toThrow(ProductionSafetyError);
  });

  it("throws when adminSecret is shorter than 16 characters", () => {
    expect(() =>
      validateProductionSafety({
        gatewayEnv: "production",
        adminSecret: "short-secret",
      }),
    ).toThrow(ProductionSafetyError);
  });

  it("throws when adminSecret is an empty string", () => {
    expect(() =>
      validateProductionSafety({
        gatewayEnv: "production",
        adminSecret: "",
      }),
    ).toThrow(ProductionSafetyError);
  });

  it("passes when adminSecret is at least 16 characters", () => {
    expect(() =>
      validateProductionSafety({
        gatewayEnv: "production",
        adminSecret: "a-very-long-admin-secret",
        hasAuthKeys: true,
      }),
    ).not.toThrow();
  });

  it("throws when authEnabled is false in production", () => {
    expect(() =>
      validateProductionSafety({
        gatewayEnv: "production",
        authEnabled: false,
        hasAuthKeys: true,
      }),
    ).toThrow(ProductionSafetyError);
  });

  it("throws when no auth keys exist and the key store is empty", () => {
    expect(() =>
      validateProductionSafety({
        gatewayEnv: "production",
        hasAuthKeys: false,
        keyStoreEmpty: true,
      }),
    ).toThrow(ProductionSafetyError);
  });

  it("throws when no auth keys exist and key store emptiness is unknown", () => {
    expect(() =>
      validateProductionSafety({
        gatewayEnv: "production",
        hasAuthKeys: false,
      }),
    ).toThrow(ProductionSafetyError);
  });

  it("passes when auth keys exist", () => {
    expect(() =>
      validateProductionSafety({
        gatewayEnv: "production",
        hasAuthKeys: true,
        keyStoreEmpty: true,
      }),
    ).not.toThrow();
  });

  it("passes when no auth keys but the key store is confirmed non-empty", () => {
    expect(() =>
      validateProductionSafety({
        gatewayEnv: "production",
        hasAuthKeys: false,
        keyStoreEmpty: false,
      }),
    ).not.toThrow();
  });

  it("passes when every production requirement is satisfied", () => {
    expect(() =>
      validateProductionSafety({
        gatewayEnv: "production",
        allowUnauthenticatedProxy: false,
        adminSecret: "a-very-long-admin-secret",
        authEnabled: true,
        hasAuthKeys: true,
        keyStoreEmpty: false,
      }),
    ).not.toThrow();
  });
});

describe("isProductionMode", () => {
  it("returns true when GATEWAY_ENV is production", () => {
    process.env.GATEWAY_ENV = "production";
    expect(isProductionMode()).toBe(true);
  });

  it("returns false when GATEWAY_ENV is unset", () => {
    delete process.env.GATEWAY_ENV;
    expect(isProductionMode()).toBe(false);
  });
});

describe("parseAllowUnauthenticatedProxy", () => {
  it("returns true when ALLOW_UNAUTHENTICATED_PROXY is true", () => {
    process.env.ALLOW_UNAUTHENTICATED_PROXY = "true";
    expect(parseAllowUnauthenticatedProxy()).toBe(true);
  });

  it("returns false for any other value", () => {
    process.env.ALLOW_UNAUTHENTICATED_PROXY = "false";
    expect(parseAllowUnauthenticatedProxy()).toBe(false);
  });

  it("returns false when ALLOW_UNAUTHENTICATED_PROXY is unset", () => {
    delete process.env.ALLOW_UNAUTHENTICATED_PROXY;
    expect(parseAllowUnauthenticatedProxy()).toBe(false);
  });
});

describe("ProductionSafetyError", () => {
  it("is an instance of Error with a stable name and message", () => {
    const err = new ProductionSafetyError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProductionSafetyError);
    expect(err.name).toBe("ProductionSafetyError");
    expect(err.message).toBe("boom");
  });
});
