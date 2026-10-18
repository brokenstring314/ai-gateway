import { describe, it, expect } from "bun:test";
import { redactMessage, redactObject } from "@/observability/redact";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

// ---------------------------------------------------------------------------
// redactMessage
// ---------------------------------------------------------------------------

describe("redactMessage", () => {
  it("redacts email addresses, including multiple occurrences", () => {
    const input = "Contact alice@example.com or bob.smith@test.co.uk for access.";
    expect(redactMessage(input)).toBe("Contact [REDACTED_EMAIL] or [REDACTED_EMAIL] for access.");
  });

  it("redacts three-part eyJ... JWTs, including multiple tokens", () => {
    const input = `token1=${JWT} token2=${JWT}`;
    const result = redactMessage(input);
    expect(result).toBe("token1=[REDACTED_JWT] token2=[REDACTED_JWT]");
    expect(result).not.toContain("eyJ");
  });

  it("redacts sk- prefixed API keys, including multiple keys", () => {
    const input = "key=sk-proj-abcdef1234567890abcdef1234567890 and sk-0987654321fedcba0987654321fedcba";
    expect(redactMessage(input)).toBe("key=[REDACTED_KEY] and [REDACTED_KEY]");
  });

  it("redacts fgw_ prefixed keys", () => {
    const input = "gateway key fgw_live_9f2a1b3c4d5e6f7a8b9c0d1e, keep going";
    expect(redactMessage(input)).toBe("gateway key [REDACTED_KEY], keep going");
  });

  it("redacts Bearer tokens, including JWTs carried inside them", () => {
    const input = `Authorization: Bearer ${JWT}`;
    expect(redactMessage(input)).toBe("Authorization: [REDACTED_BEARER]");
  });

  it("redacts AWS AKIA access key ids, including multiple keys", () => {
    const input = "access key AKIAIOSFODNN7EXAMPLE and backup AKIA1234567890ABCDEF";
    expect(redactMessage(input)).toBe("access key [REDACTED_AWS_KEY] and backup [REDACTED_AWS_KEY]");
  });

  it("redacts all patterns within a single mixed message", () => {
    const input = [
      "user=alice@example.com",
      `jwt=${JWT}`,
      "sk=sk-proj-abcdef1234567890abcdef1234567890",
      "fgw=fgw_live_9f2a1b3c4d5e6f7a8b9c0d1e",
      `bearer=Bearer ${JWT}`,
      "aws=AKIAIOSFODNN7EXAMPLE",
    ].join(" ");
    const result = redactMessage(input);
    expect(result).toContain("[REDACTED_EMAIL]");
    expect(result).toContain("[REDACTED_JWT]");
    expect(result).toContain("[REDACTED_KEY]");
    expect(result).toContain("[REDACTED_BEARER]");
    expect(result).toContain("[REDACTED_AWS_KEY]");
    expect(result).not.toContain("alice@example.com");
    expect(result).not.toContain("eyJ");
    expect(result).not.toContain("sk-proj");
    expect(result).not.toContain("fgw_live");
    expect(result).not.toContain("AKIA");
  });

  it('returns the message unchanged for level "none"', () => {
    const input = "alice@example.com Bearer eyJabc.def.ghi";
    expect(redactMessage(input, "none")).toBe(input);
  });

  it('returns the message unchanged for level "full"', () => {
    const input = "alice@example.com Bearer eyJabc.def.ghi";
    expect(redactMessage(input, "full")).toBe(input);
  });

  it("defaults to the metadata level", () => {
    expect(redactMessage("a@b.co")).toBe("[REDACTED_EMAIL]");
  });

  it("leaves plain text without secrets untouched", () => {
    const input = "Request failed with status 429: rate limit exceeded";
    expect(redactMessage(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// redactObject
// ---------------------------------------------------------------------------

describe("redactObject", () => {
  it("replaces the whole value of sensitive property names with [REDACTED]", () => {
    const input = {
      apiKey: "sk-proj-abcdef1234567890abcdef1234567890",
      api_key: "fgw_live_9f2a1b3c4d5e6f7a8b9c0d1e",
      apikey: "secret-apikey",
      Authorization: `Bearer ${JWT}`,
      password: "hunter2",
      secret: "s3cr3t",
      token: JWT,
      accessToken: "abc123",
      webhookSecret: "whsec_xyz",
    };
    expect(redactObject(input, "metadata")).toEqual({
      apiKey: "[REDACTED]",
      api_key: "[REDACTED]",
      apikey: "[REDACTED]",
      Authorization: "[REDACTED]",
      password: "[REDACTED]",
      secret: "[REDACTED]",
      token: "[REDACTED]",
      accessToken: "[REDACTED]",
      webhookSecret: "[REDACTED]",
    });
  });

  it("recursively redacts nested objects and arrays while preserving structure", () => {
    const input = {
      user: {
        name: "Alice",
        email: "alice@example.com",
        roles: ["admin", "operator"],
        sessions: [
          { token: JWT, id: "s1" },
          { token: "fgw_live_9f2a1b3c4d5e6f7a8b9c0d1e", id: "s2" },
        ],
      },
      config: { timeoutMs: 3000, retries: 3 },
    };
    expect(redactObject(input, "metadata")).toEqual({
      user: {
        name: "Alice",
        email: "[REDACTED_EMAIL]",
        roles: ["admin", "operator"],
        sessions: [
          { token: "[REDACTED]", id: "s1" },
          { token: "[REDACTED]", id: "s2" },
        ],
      },
      config: { timeoutMs: 3000, retries: 3 },
    });
  });

  it("handles arrays of objects and scalars at the top level", () => {
    const input = [
      { apiKey: "sk-proj-abcdef1234567890abcdef1234567890", label: "prod" },
      "plain string",
      42,
      null,
      { note: "reach alice@example.com" },
    ];
    expect(redactObject(input, "metadata")).toEqual([
      { apiKey: "[REDACTED]", label: "prod" },
      "plain string",
      42,
      null,
      { note: "reach [REDACTED_EMAIL]" },
    ]);
  });

  it("redacts secret patterns inside non-sensitive string values", () => {
    const input = {
      message: "contact alice@example.com with key sk-proj-abcdef1234567890abcdef1234567890",
      metadata: { trace: `jwt=${JWT}` },
    };
    expect(redactObject(input, "metadata")).toEqual({
      message: "contact [REDACTED_EMAIL] with key [REDACTED_KEY]",
      metadata: { trace: "jwt=[REDACTED_JWT]" },
    });
  });

  it("keeps non-sensitive fields and scalar values unchanged", () => {
    const input = {
      name: "Alice",
      count: 7,
      active: true,
      tags: ["a", "b"],
      nested: { depth: 2 },
    };
    expect(redactObject(input, "metadata")).toEqual(input);
  });

  it("does not mutate the original input", () => {
    const input = {
      user: { name: "Alice", email: "alice@example.com" },
      apiKey: "sk-proj-abcdef1234567890abcdef1234567890",
    };
    const snapshot = structuredClone(input);
    redactObject(input, "metadata");
    expect(input).toEqual(snapshot);
  });

  it('returns the input unchanged (same reference) for "none" and "full"', () => {
    const input = { apiKey: "sk-proj-abcdef1234567890abcdef1234567890" };
    expect(redactObject(input, "none")).toBe(input);
    expect(redactObject(input, "full")).toBe(input);
  });

  it("preserves non-plain objects such as Date instances", () => {
    const when = new Date("2026-08-03T00:00:00.000Z");
    const input = { createdAt: when, apiKey: "sk-proj-abcdef1234567890abcdef1234567890" };
    const result = redactObject(input, "metadata") as { createdAt: Date; apiKey: string };
    expect(result.createdAt).toBe(when);
    expect(result.apiKey).toBe("[REDACTED]");
  });
});
