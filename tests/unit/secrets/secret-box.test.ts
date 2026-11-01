import { describe, expect, it } from "bun:test";
import {
  decodeMasterKey,
  maskSecret,
  SecretBox,
  SecretDecryptError,
  SecretKeyError,
} from "../../../src/secrets/secret-box.js";

const K1 = new Uint8Array(32).fill(1);
const K2 = new Uint8Array(32).fill(2);

describe("SecretBox", () => {
  it("round-trips and never repeats a ciphertext", async () => {
    const box = await SecretBox.create(K1);
    const a = await box.encrypt("sk-secret-value", "ctx");
    const b = await box.encrypt("sk-secret-value", "ctx");
    expect(a).not.toBe(b);
    expect(a).not.toContain("sk-secret-value");
    expect(a.startsWith(`v1.${box.kid}.`)).toBe(true);
    expect(await box.decrypt(a, "ctx")).toBe("sk-secret-value");
  });

  it("rejects tampered ciphertext", async () => {
    const box = await SecretBox.create(K1);
    const env = await box.encrypt("sk-secret-value", "ctx");
    const parts = env.split(".");
    const ct = parts[3]!;
    parts[3] = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    await expect(box.decrypt(parts.join("."), "ctx")).rejects.toBeInstanceOf(SecretDecryptError);
  });

  it("binds the context: a ciphertext moved to another record fails", async () => {
    const box = await SecretBox.create(K1);
    const env = await box.encrypt("sk-secret-value", "channel_key:a");
    await expect(box.decrypt(env, "channel_key:b")).rejects.toBeInstanceOf(SecretDecryptError);
  });

  it("refuses a ciphertext from an unknown master key, accepts a previous one", async () => {
    const old = await SecretBox.create(K1);
    const env = await old.encrypt("sk-x-123456789", "c");
    const other = await SecretBox.create(K2);
    await expect(other.decrypt(env, "c")).rejects.toThrow(/not GATEWAY_SECRET_KEY/);
    const rotated = await SecretBox.create(K2, [K1]);
    expect(await rotated.decrypt(env, "c")).toBe("sk-x-123456789");
    expect(rotated.isStale(env)).toBe(true);
    expect(rotated.isStale(await rotated.encrypt("y", "c"))).toBe(false);
  });

  it("rejects malformed envelopes", async () => {
    const box = await SecretBox.create(K1);
    await expect(box.decrypt("plaintext", "c")).rejects.toBeInstanceOf(SecretDecryptError);
    await expect(box.decrypt("v2.a.b.c", "c")).rejects.toBeInstanceOf(SecretDecryptError);
  });

  it("fromEnv: unset → undefined; set → usable; previous keys parsed", async () => {
    expect(await SecretBox.fromEnv({})).toBeUndefined();
    expect(await SecretBox.fromEnv({ GATEWAY_SECRET_KEY: "  " })).toBeUndefined();
    const hex = "ab".repeat(32);
    const box = await SecretBox.fromEnv({ GATEWAY_SECRET_KEY: hex, GATEWAY_SECRET_KEY_PREVIOUS: "cd".repeat(32) });
    expect(box).toBeDefined();
    await expect(SecretBox.fromEnv({ GATEWAY_SECRET_KEY: "short" })).rejects.toBeInstanceOf(SecretKeyError);
  });
});

describe("decodeMasterKey", () => {
  it("accepts hex, base64 and base64url of >= 32 bytes", () => {
    expect(decodeMasterKey("00".repeat(32)).length).toBe(32);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(250)));
    expect(decodeMasterKey(b64).length).toBe(32);
    expect(decodeMasterKey(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")).length).toBe(32);
  });

  it("rejects short or malformed keys with a hint", () => {
    expect(() => decodeMasterKey("00".repeat(16))).toThrow(/at least 32 bytes/);
    expect(() => decodeMasterKey("not a key!")).toThrow(/openssl rand/);
  });
});

describe("maskSecret", () => {
  it("shows a prefix and the last 4 characters only", () => {
    expect(maskSecret("sk-abcdefghijklmnop1234")).toBe("sk-…1234");
    expect(maskSecret("abcdefghijkl9876")).toBe("…9876");
    expect(maskSecret("short")).toBe("****");
  });
});
