/**
 * Red team 2026-11-05 D1 / D2: regexes run on attacker-shaped text must stay
 * linear. D1: the email redaction regex (called through otel-tracer on every
 * failed request, OTel on or off) froze the gateway for 52 s on a 300 KB
 * model name. D2: pii-secret-guard's generic_secret / email detectors froze
 * it for 19 s on a 100 KB `a.a.a.…` prompt.
 *
 * 1. Differential: each linear scanner returns exactly what the regex it
 *    replaced returns, on many random short strings built from the
 *    characters that matter.
 * 2. Adversarial: 1 MB and 9 MB inputs shaped to trigger backtracking go
 *    through every text function that sees user-controlled input and each
 *    must finish well inside the budget (the old code needed minutes to hours).
 */
import { describe, expect, it } from "bun:test";
import { scrubUrl } from "@/admin/config-scrub";
import { estimatePromptTokens } from "@/core/usage";
import { OtelTracer } from "@/observability/otel-tracer";
import { clampText, redactEmails, redactJwts, redactMessage } from "@/observability/redact";
import {
  BUILTIN_DETECTORS,
  canonicalize,
  type Detector,
  detect,
  redact,
  scanEmails,
  scanGenericSecrets,
  scanJwts,
  scanPrivateKeys,
} from "@/plugins/builtins/pii-secret-guard/detectors";
import { keyErrorText } from "@/routing/key-pool";
import { scrubSecrets } from "@/security/secret-scrub";

// ── 1. differential ──

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomStrings(alphabet: string[], count: number, maxLen: number, seed = 7): string[] {
  const r = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = Math.floor(r() * maxLen);
    let s = "";
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(r() * alphabet.length)];
    out.push(s);
  }
  return out;
}

const hits = (it: Iterable<{ start: number; end: number; value: string }>) =>
  [...it].map((h) => `${h.start}-${h.end}:${h.value}`);
const regexHits = (re: RegExp, s: string, group = 0) =>
  [...s.matchAll(re)]
    .filter((m) => m[group] !== undefined && m[group] !== "")
    .map((m) => `${m.indices![group]![0]}-${m.indices![group]![1]}:${m[group]}`);

describe("D1/D2 linear scanners match the regexes they replace", () => {
  it("redactEmails ≡ /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g", () => {
    const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    for (const s of randomStrings(["a", "b", "1", ".", "@", "-", "+", " ", "%", "_", "Z", ":"], 6000, 24)) {
      expect(redactEmails(s)).toBe(s.replace(re, "[REDACTED_EMAIL]"));
    }
    expect(redactEmails("mail bob.smith+x@mail.example.com now")).toBe("mail [REDACTED_EMAIL] now");
  });

  it("redactJwts ≡ /\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/g", () => {
    const re = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
    for (const s of randomStrings(["eyJ", "a", "-", ".", "_", " ", "x", "eyJ."], 6000, 14)) {
      expect(redactJwts(s)).toBe(s.replace(re, "[REDACTED_JWT]"));
    }
  });

  it("scanEmails ≡ pii email regex", () => {
    const re = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/dg;
    for (const s of randomStrings(["a", "b", "1", ".", "@", "-", "+", " ", "%", "_", "Z", "é"], 8000, 24, 11)) {
      expect(hits(scanEmails(s))).toEqual(regexHits(re, s));
    }
  });

  it("scanJwts ≡ pii jwt regex", () => {
    const re = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/dg;
    for (const s of randomStrings(["eyJ", "abc", "a", "-", ".", "_", " ", "x"], 8000, 20, 13)) {
      expect(hits(scanJwts(s))).toEqual(regexHits(re, s));
    }
  });

  it("scanGenericSecrets ≡ pii generic_secret regex (group 1)", () => {
    const re =
      /\b[A-Za-z0-9_.-]*(?:api[_.-]?key|apikey|secret|token|passwd|password|pwd|access[_.-]?key|private[_.-]?key|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?([^\s"'`,;<>{}()[\]\\]{8,})/dgi;
    const alphabet = ["token", "API_KEY", "Pwd", "a", "x9", ".", "-", "=", ":", " ", '"', "'", "{", ",", "Q", "\t"];
    for (const s of randomStrings(alphabet, 8000, 16, 17)) {
      expect(hits(scanGenericSecrets(s))).toEqual(regexHits(re, s, 1));
    }
  });

  it("scanPrivateKeys ≡ pii private_key regex", () => {
    const B64 = String.raw`(?:(?:\s|\\n|\\r)*(?:[A-Za-z0-9+/=]{16,}|[A-Za-z-]+: [^\n\\]*))*`;
    const L = "(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?";
    const re = new RegExp(String.raw`-----BEGIN ${L}-----(?:[\s\S]*?-----END ${L}-----|${B64})`, "dg");
    const alphabet = [
      "-----BEGIN PRIVATE KEY-----",
      "-----BEGIN RSA PRIVATE KEY-----",
      "-----END PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
      "\n",
      "Proc-Type: 4,ENCRYPTED",
      "abc",
      " ",
      "\\n",
    ];
    for (const s of randomStrings(alphabet, 4000, 8, 19)) {
      expect(hits(scanPrivateKeys(s))).toEqual(regexHits(re, s));
    }
  });
});

// ── 2. adversarial inputs ──

const MB = 1024 * 1024;
const rep = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

/** Inputs that made one of the old patterns backtrack over the whole run for every start position. */
function adversarial(bytes: number): Record<string, string> {
  return {
    letters: rep("A", bytes), // D1 repro: 300 K "A" as the model name
    dotted: rep("a.", bytes), // D2 repro: generic_secret / email
    dashed: rep("a-", bytes),
    atNoTld: rep("a@a", bytes),
    atDots: rep("a@a.", bytes),
    eyJ: rep("eyJ-", bytes),
    eyJDots: rep("eyJaaaaaaaaa.", bytes),
    keyword: rep("token", bytes),
    keywordDots: rep("secret.", bytes),
    assign: rep("x=", bytes),
    pemBegin: rep("-----BEGIN PRIVATE KEY-----", bytes),
    spaces: `Bearer${rep(" ", bytes)}`,
    sk: rep("sk-", bytes),
    query: rep("?", bytes),
    emails: rep("a@b.co ", bytes), // many findings: the merge / redact must stay linear too
  };
}

const detectorOpts = { entropyThreshold: 3.5 };

/** Text functions that see request / upstream text, with the input each gets. */
const functions: Record<string, (s: string) => unknown> = {
  redactMessage: (s) => redactMessage(s),
  "otel recordError (local span)": (s) => {
    const t = new OtelTracer();
    t.recordError(t.startSpan("x"), new Error(`The model "${s}" does not exist`));
  },
  "pii detect (all built-ins)": (s) => {
    const text = canonicalize(s);
    const findings = detect(
      text,
      BUILTIN_DETECTORS.map((d) => ({ ...d, optIn: false }) as Detector),
      detectorOpts,
    );
    redact(
      text,
      findings,
      () => true,
      (f) => `[${f.entity}]`,
    );
  },
  keyErrorText: (s) => keyErrorText(400, s, "sk-upstream-key-0123456789"),
  scrubSecrets: (s) => scrubSecrets(s, ["sk-upstream-key-0123456789", "other-key-abcdef"]),
  scrubUrl: (s) => scrubUrl(`https://h.example/v1${s}`),
  estimatePromptTokens: (s) => estimatePromptTokens({ messages: [{ role: "user", content: s }] }),
  clampText: (s) => clampText(s, 4096),
};

function time(fn: () => unknown): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe("D1/D2 every user-facing text function is fast on adversarial input", () => {
  // Budgets are generous for slow / loaded CI runners (pii detect on 1 MB took
  // ~240 ms on a busy 2-core box); the quadratic versions took ~10 minutes for
  // 1 MB (D1) and ~30 minutes for 1 MB (D2), so these still catch any regression
  // by orders of magnitude.
  for (const [size, budgetMs] of [
    [1 * MB, 1000],
    [9 * MB, 8000],
  ] as const) {
    for (const [fname, fn] of Object.entries(functions)) {
      it(`${fname}: ${size / MB} MB inputs`, () => {
        // Built per test and dropped after it: 9 MB inputs kept alive for the
        // whole run made later timing-sensitive tests flaky (GC pauses).
        const inputs = adversarial(size);
        const slow: string[] = [];
        for (const [iname, input] of Object.entries(inputs)) {
          const ms = time(() => fn(input));
          if (ms > budgetMs) slow.push(`${iname}=${Math.round(ms)}ms`);
        }
        expect(slow).toEqual([]);
        Bun.gc(true);
      }, 60_000);
    }
  }

  it("D1 end to end: a 1 MB unknown model name answers fast (no event-loop freeze)", async () => {
    // The repro, without a server: recordError on the model_not_found message.
    const name = "A".repeat(MB);
    const ms = time(() => {
      const t = new OtelTracer();
      const span = t.startSpan("gateway.chat");
      t.recordError(span, new Error(`The model "${name}" does not exist on this gateway`));
      expect(String(span.events[0]!.attributes!["exception.message"]).length).toBeLessThan(5000);
    });
    expect(ms).toBeLessThan(200);
  });
});
