import { describe, it, expect } from "vitest";
import {
  hashKey,
  displayKey,
  generateAPIKey,
  generateID,
  timingSafeEqual,
} from "@/auth/key-hash";

describe("hashKey", () => {
  it("produces deterministic output for same input", () => {
    const key = "fgw_abcdef1234567890";
    expect(hashKey(key)).toBe(hashKey(key));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashKey("key-one")).not.toBe(hashKey("key-two"));
  });

  it("produces 64 hex chars (SHA-256 format)", () => {
    const hash = hashKey("test-key");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes empty string to valid SHA-256", () => {
    const hash = hashKey("");
    expect(hash).toHaveLength(64);
    // Known SHA-256 of empty string
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("displayKey", () => {
  it("returns short key (<=12 chars) as-is", () => {
    expect(displayKey("short-key")).toBe("short-key");
    expect(displayKey("123456789012")).toBe("123456789012");
  });

  it('formats long key as "first8...last4"', () => {
    expect(displayKey("1234567890123")).toBe("12345678...0123");
  });

  it('formats fgw_ key as "fgw_abcd...abcd"', () => {
    const key = "fgw_abcdef1234567890abcdef1234567890abcd";
    expect(displayKey(key)).toBe("fgw_abcd...abcd");
  });
});

describe("generateAPIKey", () => {
  it('has "fgw_" prefix', () => {
    const key = generateAPIKey();
    expect(key.startsWith("fgw_")).toBe(true);
  });

  it("is 68 chars total (4 prefix + 64 hex)", () => {
    const key = generateAPIKey();
    expect(key).toHaveLength(68);
    expect(key.slice(4)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique keys", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      keys.add(generateAPIKey());
    }
    expect(keys.size).toBe(100);
  });
});

describe("generateID", () => {
  it("produces UUID v4 format (8-4-4-4-12 hex chars)", () => {
    const id = generateID();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateID());
    }
    expect(ids.size).toBe(100);
  });
});

describe("timingSafeEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqual("hello", "hello")).toBe(true);
  });

  it("returns false for unequal strings", () => {
    expect(timingSafeEqual("hello", "world")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(timingSafeEqual("short", "a-longer-string")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("returns true for single equal char", () => {
    expect(timingSafeEqual("a", "a")).toBe(true);
  });

  it("returns false for single unequal char", () => {
    expect(timingSafeEqual("a", "b")).toBe(false);
  });
});
