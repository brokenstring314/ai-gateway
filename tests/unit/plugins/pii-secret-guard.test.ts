// pii-secret-guard: detectors (true positives + false-positive guards),
// validators, actions, roles / surfaces / direction, config validation and
// no value leakage. Credential-shaped fixtures are assembled at runtime
// (prefix + body) so the repository holds no literal token strings.
import { describe, expect, it } from "bun:test";
import { configReferenceIssues } from "@/config/validate";
import { getMetrics } from "@/metrics/metrics";
import { buildPluginsFromConfig } from "@/plugins/builtins/from-config";
import {
  canonicalize,
  detect,
  PiiSecretGuardPlugin,
  piiSecretGuardConfigIssues,
  resolveGuardConfig,
  type PiiSecretGuardInput,
} from "@/plugins/builtins/pii-secret-guard/index";
import {
  cnIdValid,
  creditCardValid,
  ibanValid,
  luhnValid,
  shannonEntropy,
} from "@/plugins/builtins/pii-secret-guard/validators";
import { createPluginContext } from "@/plugins/context";
import { PluginRejectionError } from "@/plugins/error";
import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage } from "@/providers/types";

// ── fixtures (built at runtime) ──
const cat = (...p: string[]) => p.join("");
const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FX = {
  openai: cat("sk-", "proj-", "abc123DEF456ghi789JKL012"),
  deepseek: cat("sk-", "0123456789abcdef0123456789abcdef"),
  anthropic: cat("sk-", "ant-", "api03-", "abcdefghijklmnopqrstuvwxyz0123"),
  awsAccess: cat("AK", "IA", "IOSFODNN7EXAMPLE"),
  awsAccessTemp: cat("AS", "IA", "IOSFODNN7EXAMPLE"),
  awsSecret: cat("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"),
  ghp: cat("gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
  gho: cat("gh", "o_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
  ghPat: cat("github", "_pat_", "11ABCDEFG0123456789_abcdefghijklmnop"),
  slack: cat("xo", "xb-", "1234567890-abcdefghij"),
  google: cat("AI", "za", "SyA1234567890abcdefghijklmnopqrstuv"),
  stripeLive: cat("sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc"),
  stripeRestricted: cat("rk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc"),
  jwt: cat(
    b64u({ alg: "HS256", typ: "JWT" }),
    ".",
    b64u({ sub: "1234567890", name: "x" }),
    ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ),
  pem: cat(
    "-----BEGIN RSA ",
    "PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890abcdef\nabcdefABCDEF0123456789+/==\n-----END RSA ",
    "PRIVATE KEY-----",
  ),
  genericValue: "Zx9Qw3Er7Ty1Ui5Op2As",
  email: "john.doe+x@example.co.uk",
  cnMobile: "13812345678",
  cnId: "11010519491231002X",
  visa: "4111 1111 1111 1111",
  amex: "378282246310005",
  iban: "DE89 3704 0044 0532 0130 00",
  ssn: "123-45-6789",
};

const ALL_ON: PiiSecretGuardInput = { entityActions: { ipv4: "block" } };
function entities(text: string, raw: PiiSecretGuardInput = ALL_ON): string[] {
  const cfg = resolveGuardConfig(raw);
  const t = canonicalize(text);
  return detect(t, cfg.detectors, { entropyThreshold: cfg.entropyThreshold }, cfg.allowlist).map((f) => f.entity);
}
function values(text: string, raw: PiiSecretGuardInput = ALL_ON): string[] {
  const cfg = resolveGuardConfig(raw);
  const t = canonicalize(text);
  return detect(t, cfg.detectors, { entropyThreshold: cfg.entropyThreshold }, cfg.allowlist).map((f) =>
    t.slice(f.start, f.end),
  );
}

// ── validators ──
describe("validators", () => {
  it("luhn", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("")).toBe(false);
  });
  it("credit card: issuer prefix, length, grouping, repeated digits", () => {
    expect(creditCardValid("4111 1111 1111 1111")).toBe(true);
    expect(creditCardValid("4111-1111-1111-1111")).toBe(true);
    expect(creditCardValid("3782 822463 10005")).toBe(true);
    expect(creditCardValid("0000000000000000")).toBe(false); // Luhn-valid, no issuer
    expect(creditCardValid("41 11111 1111 11111")).toBe(false); // odd grouping
    expect(creditCardValid("4111 1111-1111 1111")).toBe(false); // mixed separators
  });
  it("CN ID: check digit and calendar date", () => {
    expect(cnIdValid("11010519491231002X")).toBe(true);
    expect(cnIdValid("11010519491231002x")).toBe(true);
    expect(cnIdValid("110105194912310021")).toBe(false); // wrong check digit
    expect(cnIdValid("110105194902300026")).toBe(false); // 30 Feb
  });
  it("IBAN mod-97", () => {
    expect(ibanValid("DE89370400440532013000")).toBe(true);
    expect(ibanValid("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(ibanValid("DE89370400440532013001")).toBe(false);
  });
  it("entropy", () => {
    expect(shannonEntropy("aaaaaaaa")).toBe(0);
    expect(shannonEntropy("Zx9Qw3Er7Ty1Ui5Op2As")).toBeGreaterThan(4);
  });
});

// ── secret detectors ──
describe("secret detectors: true positives", () => {
  const cases: [string, string, string][] = [
    ["openai_key", `key ${FX.openai} here`, FX.openai],
    ["openai_key", `deepseek ${FX.deepseek}`, FX.deepseek],
    ["anthropic_key", `x ${FX.anthropic}`, FX.anthropic],
    ["aws_access_key", `id ${FX.awsAccess}`, FX.awsAccess],
    ["aws_access_key", `sts ${FX.awsAccessTemp}`, FX.awsAccessTemp],
    ["aws_secret_key", `aws_secret_access_key = ${FX.awsSecret}`, FX.awsSecret],
    ["aws_secret_key", `AWS_SECRET_KEY: "${FX.awsSecret}"`, FX.awsSecret],
    ["github_token", `t ${FX.ghp}`, FX.ghp],
    ["github_token", `t ${FX.gho}`, FX.gho],
    ["github_token", `t ${FX.ghPat}`, FX.ghPat],
    ["slack_token", `t ${FX.slack}`, FX.slack],
    ["google_api_key", `t ${FX.google}`, FX.google],
    ["stripe_key", `t ${FX.stripeLive}`, FX.stripeLive],
    ["stripe_key", `t ${FX.stripeRestricted}`, FX.stripeRestricted],
    ["jwt", `Bearer ${FX.jwt}`, FX.jwt],
    ["private_key", `${FX.pem}\nthanks`, FX.pem],
    ["generic_secret", `api_key=${FX.genericValue}`, FX.genericValue],
    ["generic_secret", `"client_secret": "${FX.genericValue}"`, FX.genericValue],
    ["generic_secret", `PASSWORD: ${FX.genericValue}`, FX.genericValue],
  ];
  for (const [entity, text, value] of cases) {
    it(`${entity}: ${text.slice(0, 24)}…`, () => {
      expect(entities(text)).toEqual([entity]);
      expect(values(text)).toEqual([value]);
    });
  }

  it("truncated PEM (no END line) still detected, prose after it is kept", () => {
    const text = cat("-----BEGIN OPENSSH ", "PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n\nPlease explain this");
    expect(entities(text)).toEqual(["private_key"]);
    expect(values(text)[0]).not.toContain("Please");
  });

  it("specific type wins over generic_secret for `api_key=sk-…`", () => {
    expect(entities(`api_key=${FX.openai}`)).toEqual(["openai_key"]);
  });
});

describe("secret detectors: false-positive guards", () => {
  const negatives = [
    "sk-learn-tutorial-for-beginners-guide is a slug",
    "risk-assessment-framework-document-12",
    "password=changeme",
    "password: hunter2",
    "max_tokens=4096 and total_tokens: 12345678",
    "token=${GITHUB_TOKEN} api_key=process.env.OPENAI_KEY",
    "secret = understanding the problem",
    "AKIA lowercase akiaiosfodnn7example",
    cat("gh", "p_", "short"),
    cat("eyJ", "notreallyajwt.", "eyJ", "alsonotone.", "abcdefghij"), // header not JSON
    "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----",
    cat("sk", "_live_", "short"),
  ];
  for (const text of negatives) {
    it(`no hit: ${text.slice(0, 40)}`, () => {
      expect(entities(text)).toEqual([]);
    });
  }
});

// ── PII detectors ──
describe("PII detectors: true positives", () => {
  const cases: [string, string, string][] = [
    ["email", `mail ${FX.email} now`, FX.email],
    ["phone", `call ${FX.cnMobile}`, FX.cnMobile],
    ["phone", "call 138-1234-5678", "138-1234-5678"],
    ["phone", "call +86 138 1234 5678", "+86 138 1234 5678"],
    ["phone", "call +8613812345678", "+8613812345678"],
    ["phone", "call +14155550100", "+14155550100"],
    ["phone", "call +44 20 7946 0958", "+44 20 7946 0958"],
    ["phone", "call (415) 555-0100", "(415) 555-0100"],
    ["phone", "call 415-555-0100", "415-555-0100"],
    ["cn_id", `身份证 ${FX.cnId}`, FX.cnId],
    ["cn_id", "身份证11010519491231002x号", "11010519491231002x"],
    ["credit_card", `card ${FX.visa}`, FX.visa],
    ["credit_card", "card 4111-1111-1111-1111", "4111-1111-1111-1111"],
    ["credit_card", `amex ${FX.amex}`, FX.amex],
    ["iban", `iban ${FX.iban}`, FX.iban],
    ["iban", "GB82WEST12345698765432", "GB82WEST12345698765432"],
    ["ssn", `ssn ${FX.ssn}`, FX.ssn],
    ["ipv4", "host 192.168.1.10.", "192.168.1.10"],
  ];
  for (const [entity, text, value] of cases) {
    it(`${entity}: ${text}`, () => {
      expect(entities(text)).toEqual([entity]);
      expect(values(text)).toEqual([value]);
    });
  }
});

describe("PII detectors: false-positive guards", () => {
  const negatives = [
    "order 1234567812345678 shipped", // fails Luhn
    "tracking 0000 0000 0000 0000",
    "id 110105194912310021", // CN ID with a wrong check digit
    "date 2026-10-18, time 12:30:45",
    "ssn-like 000-12-3456 and 666-12-3456 and 123-00-4567",
    "version 1.2.3.4.5 and 10.0.0",
    "number 12812345678", // 12x is not a CN mobile prefix
    "DE89370400440532013001", // IBAN check fails
    "user@localhost",
    "price 415.55 or 3.14159",
  ];
  for (const text of negatives) {
    it(`no hit: ${text}`, () => {
      expect(entities(text)).toEqual([]);
    });
  }
  it("ipv4 is opt-in", () => {
    expect(entities("host 192.168.1.10", {})).toEqual([]);
  });
  it("CN mobile inside an 18-digit ID is not a phone", () => {
    expect(entities(`x ${FX.cnId} y`)).toEqual(["cn_id"]);
  });
});

describe("canonicalization (NFKC like word-filter, zero-width removed)", () => {
  it("fullwidth digits and letters", () => {
    expect(entities("电话１３８１２３４５６７８")).toEqual(["phone"]);
    expect(entities(`ｓｋ-${FX.openai.slice(3)}`)).toEqual(["openai_key"]);
  });
  it("zero-width joiners inside a key", () => {
    expect(entities(`s\u200Bk-${FX.openai.slice(3)}`)).toEqual(["openai_key"]);
    expect(entities(`${FX.ghp.slice(0, 6)}\u2060${FX.ghp.slice(6)}`)).toEqual(["github_token"]);
  });
});

// ── plugin behaviour ──
type Ctx = ReturnType<typeof createPluginContext>;
function ctxFor(
  messages: ChatMessage[],
  meta: Record<string, unknown> = {},
  extra: Partial<ChatCompletionRequest> = {},
) {
  const ctx = createPluginContext({ model: "gpt-4o", messages, ...extra });
  Object.assign(ctx.metadata, meta);
  return ctx;
}
const plugin = (raw: PiiSecretGuardInput, stage: "before_request" | "after_request" = "before_request") =>
  new PiiSecretGuardPlugin(resolveGuardConfig(raw), stage);
const user = (content: ChatMessage["content"]): ChatMessage => ({ role: "user", content });

function guardrail(ctx: Ctx) {
  return ctx.metadata["_guardrail"] as { direction: string; action: string; entities: string[] }[] | undefined;
}

describe("actions", () => {
  it("block: 400, code secret_detected, entity type in reason, value never echoed", async () => {
    const ctx = ctxFor([user(`deploy with ${FX.ghp} please`)]);
    const r = await plugin({}).execute(ctx);
    expect(r.action).toBe("reject");
    if (r.action !== "reject") return;
    expect(r.status).toBe(400);
    expect(r.code).toBe("secret_detected");
    expect(r.type).toBe("invalid_request_error");
    expect(r.reason).toContain("github_token");
    expect(r.reason).not.toContain(FX.ghp);
    expect(guardrail(ctx)).toEqual([
      { plugin: "pii-secret-guard", direction: "request", action: "blocked", entities: ["github_token"] },
    ] as never);
  });

  it("block: PII only → pii_detected", async () => {
    const r = await plugin({}).execute(ctxFor([user(`mail ${FX.email}`)]));
    expect(r.action === "reject" && r.code).toBe("pii_detected");
    expect(r.action === "reject" && r.reason).not.toContain(FX.email);
  });

  it("block wins over redact; secret code wins over PII", async () => {
    const r = await plugin({ categories: { pii: "redact", secret: "block" } }).execute(
      ctxFor([user(`${FX.email} ${FX.stripeLive}`)]),
    );
    expect(r.action === "reject" && r.code).toBe("secret_detected");
  });

  it("redact: typed placeholders, other text untouched", async () => {
    const ctx = ctxFor([user(`mail ${FX.email}, call ${FX.cnMobile}, key ${FX.ghp}, id ${FX.cnId}`)]);
    const r = await plugin({ action: "redact" }).execute(ctx);
    expect(r.action).toBe("modify");
    if (r.action !== "modify") return;
    expect(r.request?.messages[0]!.content).toBe("mail [EMAIL], call [PHONE], key [SECRET:github_token], id [CN_ID]");
    expect(guardrail(ctx)?.[0]?.action).toBe("redacted");
    expect(guardrail(ctx)?.[0]?.entities).toEqual(["cn_id", "email", "github_token", "phone"]);
  });

  it("redact: only the value of a generic assignment", async () => {
    const r = await plugin({ action: "redact" }).execute(ctxFor([user(`api_key=${FX.genericValue}`)]));
    expect(r.action === "modify" && r.request?.messages[0]!.content).toBe("api_key=[SECRET:generic_secret]");
  });

  it("log: request forwarded unchanged, detection recorded", async () => {
    const msgs = [user(`mail ${FX.email}`)];
    const ctx = ctxFor(msgs);
    const r = await plugin({ action: "log" }).execute(ctx);
    expect(r.action).toBe("continue");
    expect(ctx.request.messages).toBe(msgs);
    expect(guardrail(ctx)).toEqual([
      { plugin: "pii-secret-guard", direction: "request", action: "logged", entities: ["email"] },
    ] as never);
  });

  it("per-entity action beats category, category beats default", async () => {
    const ctx = ctxFor([user(`${FX.email} ${FX.cnMobile}`)]);
    const r = await plugin({ action: "block", categories: { pii: "redact" }, entityActions: { phone: "log" } }).execute(
      ctx,
    );
    expect(r.action === "modify" && r.request?.messages[0]!.content).toBe(`[EMAIL] ${FX.cnMobile}`);
  });

  it("clean request: continue, nothing recorded", async () => {
    const ctx = ctxFor([user("hello, what is 2+2?")]);
    expect((await plugin({}).execute(ctx)).action).toBe("continue");
    expect(guardrail(ctx)).toBeUndefined();
  });

  it("allowlist: a matching value is ignored", async () => {
    const r = await plugin({ allowlist: ["@example\\.co\\.uk$"] }).execute(ctxFor([user(`mail ${FX.email}`)]));
    expect(r.action).toBe("continue");
  });

  it("entities selection: unselected built-ins are not scanned", async () => {
    const r = await plugin({ entities: ["email"] }).execute(ctxFor([user(`call ${FX.cnMobile}`)]));
    expect(r.action).toBe("continue");
  });

  it("custom patterns: [CUSTOM:name] placeholder, own action", async () => {
    const r = await plugin({
      action: "block",
      entities: [],
      patterns: [{ name: "employee_id", pattern: "EMP-\\d{6}", action: "redact" }],
    }).execute(ctxFor([user("ticket for EMP-123456")]));
    expect(r.action === "modify" && r.request?.messages[0]!.content).toBe("ticket for [CUSTOM:employee_id]");
  });

  it("redacted text is the NFKC form", async () => {
    const r = await plugin({ action: "redact" }).execute(ctxFor([user("ｆｕｌｌ 电话１３８１２３４５６７８")]));
    expect(r.action === "modify" && r.request?.messages[0]!.content).toBe("full 电话[PHONE]");
  });
});

describe("what is scanned", () => {
  it("content-part arrays (text parts only; image parts untouched)", async () => {
    const image = { type: "image_url" as const, imageUrl: { url: "https://x/a.png" } };
    const ctx = ctxFor([user([{ type: "text", text: `mail ${FX.email}` }, image])]);
    const r = await plugin({ action: "redact" }).execute(ctx);
    expect(r.action).toBe("modify");
    if (r.action !== "modify") return;
    const parts = r.request?.messages[0]!.content as readonly { text?: string }[];
    expect(parts[0]!.text).toBe("mail [EMAIL]");
    expect(parts[1] as unknown).toBe(image);
  });

  it("tool call arguments: redacted and still valid JSON", async () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: null as never,
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: { name: "send", arguments: JSON.stringify({ to: FX.email, token: FX.ghp, n: 1 }) },
        },
      ],
    };
    const r = await plugin({ action: "redact" }).execute(ctxFor([msg]));
    expect(r.action).toBe("modify");
    if (r.action !== "modify") return;
    const args = JSON.parse(r.request!.messages[0]!.toolCalls![0]!.function.arguments);
    expect(args).toEqual({ to: "[EMAIL]", token: "[SECRET:github_token]", n: 1 });
  });

  it("tool call arguments: block mode rejects", async () => {
    const msg: ChatMessage = {
      role: "assistant",
      toolCalls: [{ id: "c1", type: "function", function: { name: "f", arguments: `{"k":"${FX.awsAccess}"}` } }],
    };
    expect((await plugin({}).execute(ctxFor([msg]))).action).toBe("reject");
  });

  it("scanToolArguments: false skips tool arguments", async () => {
    const msg: ChatMessage = {
      role: "assistant",
      toolCalls: [{ id: "c1", type: "function", function: { name: "f", arguments: `{"k":"${FX.awsAccess}"}` } }],
    };
    expect((await plugin({ scanToolArguments: false }).execute(ctxFor([msg]))).action).toBe("continue");
  });

  it("redaction that would break a tool call's JSON falls back to block", async () => {
    // A PEM with literal quotes after the BEGIN line would be cut mid-string.
    const args = JSON.stringify({ k: `${FX.pem}` });
    const msg: ChatMessage = {
      role: "assistant",
      toolCalls: [{ id: "c", type: "function", function: { name: "f", arguments: args } }],
    };
    const r = await plugin({ action: "redact" }).execute(ctxFor([msg]));
    // Either a clean redaction (still JSON) or a block: never forwarded with the key.
    if (r.action === "modify") {
      const out = r.request!.messages[0]!.toolCalls![0]!.function.arguments;
      expect(() => JSON.parse(out)).not.toThrow();
      expect(out).not.toContain("MIIEpAIBAAKCAQEA");
    } else {
      expect(r.action).toBe("reject");
    }
  });
});

describe("roles and surfaces", () => {
  it("roles: system prompt excluded when roles=[user]", async () => {
    const ctx = ctxFor([{ role: "system", content: `use ${FX.ghp}` }, user("hi")]);
    expect((await plugin({ roles: ["user"] }).execute(ctx)).action).toBe("continue");
  });

  it("roles: redaction leaves excluded roles untouched", async () => {
    const sys: ChatMessage = { role: "system", content: `admin ${FX.email}` };
    const ctx = ctxFor([sys, user(`me ${FX.email}`)]);
    const r = await plugin({ action: "redact", roles: ["user"] }).execute(ctx);
    expect(r.action === "modify" && r.request?.messages[0]).toBe(sys);
    expect(r.action === "modify" && r.request?.messages[1]!.content).toBe("me [EMAIL]");
  });

  it("surfaces: embeddings skipped when not listed", async () => {
    const ctx = ctxFor([user(FX.email)], { _surfaceName: "embeddings" });
    expect((await plugin({ surfaces: ["chat"] }).execute(ctx)).action).toBe("continue");
    const ctx2 = ctxFor([user(FX.email)], { _surfaceName: "embeddings" });
    expect((await plugin({}).execute(ctx2)).action).toBe("reject");
  });

  it("surfaces: images are never scanned", async () => {
    const ctx = ctxFor([user(FX.email)], { _surfaceName: "images" });
    expect((await plugin({}).execute(ctx)).action).toBe("continue");
  });

  it("passthrough + redact → blocked (a proxied body cannot be rewritten)", async () => {
    const ctx = ctxFor([user(`mail ${FX.email}`)], { _surfaceName: "passthrough" });
    const r = await plugin({ action: "redact" }).execute(ctx);
    expect(r.action).toBe("reject");
    expect(r.action === "reject" && r.reason).toContain("pass-through");
    expect(r.action === "reject" && r.code).toBe("pii_detected");
  });

  it("passthrough + log → forwarded", async () => {
    const ctx = ctxFor([user(`mail ${FX.email}`)], { _surfaceName: "passthrough" });
    expect((await plugin({ action: "log" }).execute(ctx)).action).toBe("continue");
  });
});

// ── response direction ──
function response(content: string): ChatCompletionResponse {
  return {
    id: "r",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o",
    provider: "mock",
    choices: [{ index: 0, message: { role: "assistant", content }, finishReason: "stop" }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

describe("response scanning (non-streaming)", () => {
  it("direction=request (default) never scans responses", () => {
    const regs = buildPluginsFromConfig([{ name: "pii-secret-guard", stage: "before_request", config: {} }]);
    expect(regs.map((r) => r.stage)).toEqual(["before_request"]);
  });

  it("direction=both registers both stages; response only registers after_request", () => {
    const both = buildPluginsFromConfig([
      { name: "pii_secret_guard", stage: "before_request", config: { direction: "both" } },
    ]);
    expect(both.map((r) => r.stage)).toEqual(["before_request", "after_request"]);
    const resp = buildPluginsFromConfig([
      { name: "pii-secret-guard", stage: "before_request", config: { direction: "response" } },
    ]);
    expect(resp.map((r) => r.stage)).toEqual(["after_request"]);
  });

  it("block: throws a 422 rejection without the value", async () => {
    const ctx = ctxFor([user("show config")]);
    ctx.response = response(`here: ${FX.stripeLive}`);
    let err: unknown;
    try {
      await plugin({ direction: "response" }, "after_request").execute(ctx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PluginRejectionError);
    const e = err as PluginRejectionError;
    expect(e.status).toBe(422);
    expect(e.details.code).toBe("secret_detected");
    expect(e.message).not.toContain(FX.stripeLive);
    expect(guardrail(ctx)?.[0]).toMatchObject({ direction: "response", action: "blocked" });
  });

  it("redact: rewrites ctx.response, never mutates the upstream object", async () => {
    const ctx = ctxFor([user("q")]);
    const original = response(`contact ${FX.email}`);
    ctx.response = original;
    await plugin({ direction: "response", action: "redact" }, "after_request").execute(ctx);
    expect(ctx.response?.choices[0]!.message!.content).toBe("contact [EMAIL]");
    expect(original.choices[0]!.message!.content).toBe(`contact ${FX.email}`);
  });

  it("streaming responses are not scanned (documented)", async () => {
    const ctx = ctxFor([user("q")], { _streaming: true }, { stream: true });
    ctx.response = response(`k ${FX.stripeLive}`);
    await plugin({ direction: "response" }, "after_request").execute(ctx);
    expect(ctx.response?.choices[0]!.message!.content).toContain("sk_live_");
  });

  it("embeddings responses are not scanned", async () => {
    const ctx = ctxFor([user("q")], { _surfaceName: "embeddings" });
    ctx.response = response(FX.email);
    expect((await plugin({ direction: "response" }, "after_request").execute(ctx)).action).toBe("continue");
  });
});

// ── metrics ──
describe("metrics", () => {
  it("detections counter by entity type; no values", async () => {
    getMetrics().reset();
    await plugin({ action: "log" }).execute(ctxFor([user(`${FX.email} ${FX.email} ${FX.ghp}`)]));
    const text = await getMetrics().format();
    expect(text).toContain(
      'ai_gateway_guardrail_detections_total{entity="email",category="pii",action="log",direction="request"} 2',
    );
    expect(text).toContain(
      'ai_gateway_guardrail_detections_total{entity="github_token",category="secret",action="log",direction="request"} 1',
    );
    expect(text).not.toContain(FX.email);
    expect(text).not.toContain(FX.ghp);
  });
});

// ── config validation ──
describe("config validation", () => {
  it("defaults are valid", () => {
    expect(piiSecretGuardConfigIssues({})).toEqual([]);
    expect(piiSecretGuardConfigIssues(undefined)).toEqual([]);
  });
  const bad: [string, unknown][] = [
    ["unknown key", { actions: "block" }],
    ["bad action", { action: "drop" }],
    ["unknown entity", { entities: ["passport"] }],
    ["unknown entityActions key", { entityActions: { passport: "log" } }],
    ["bad surface", { surfaces: ["images"] }],
    ["bad role", { roles: ["bot"] }],
    ["bad direction", { direction: "out" }],
    ["invalid allowlist regex", { allowlist: ["("] }],
    ["empty pattern", { patterns: [{ name: "x", pattern: " " }] }],
    ["pattern name collides with built-in", { patterns: [{ name: "email", pattern: "x" }] }],
    [
      "duplicate pattern names",
      {
        patterns: [
          { name: "a_b", pattern: "x" },
          { name: "a_b", pattern: "y" },
        ],
      },
    ],
    ["nothing to detect", { entities: [] }],
    ["entropy out of range", { entropyThreshold: 9 }],
  ];
  for (const [name, raw] of bad) {
    it(`rejects: ${name}`, () => {
      expect(piiSecretGuardConfigIssues(raw).length).toBeGreaterThan(0);
      expect(() => resolveGuardConfig(raw)).toThrow(/pii-secret-guard/);
    });
  }

  it("config/validate reports plugin issues with their path", () => {
    const issues = configReferenceIssues({
      targets: [],
      strategy: undefined as never,
      plugins: [{ name: "pii-secret-guard", stage: "before_request", config: { action: "drop" } }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(["plugins", 0, "config", "action"]);
    expect(issues[0]!.message).toContain("pii-secret-guard");
  });

  it("disabled plugin entries are not validated", () => {
    const issues = configReferenceIssues({
      targets: [],
      strategy: undefined as never,
      plugins: [{ name: "pii-secret-guard", stage: "before_request", enabled: false, config: { action: "drop" } }],
    });
    expect(issues).toEqual([]);
  });
});
