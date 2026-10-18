/**
 * Detectors for the pii-secret-guard plugin.
 *
 * Every detector matches a written STRUCTURE (a vendor prefix and length, a
 * checksum-bearing number, a `key = value` assignment) rather than guessing
 * from context, and the ones whose structure alone is ambiguous carry a
 * validator (Luhn, GB 11643 check digit, IBAN mod-97, JWT header, Shannon
 * entropy). A false positive costs a caller their request, so the patterns
 * stay literal.
 *
 * Detection runs on canonical text (see `canonicalize`), the same NFKC fold
 * word-filter uses, plus removal of zero-width / format characters, so
 * fullwidth digits (１３８…) and "s\u200Bk-…" do not slip through.
 *
 * Shape and priority were modelled on ferro-labs/ai-gateway's `pii-redact`
 * and `secret-scan` plugins (Apache-2.0); the TypeScript here is our own.
 */

import {
  cnIdValid,
  creditCardValid,
  ibanValid,
  jwtValid,
  mixedAlnum,
  phoneDigitsValid,
  shannonEntropy,
} from "./validators.js";

export type Category = "pii" | "secret";

export interface DetectorOptions {
  /** Minimum Shannon entropy (bits/char) for generic `key = value` secrets. */
  readonly entropyThreshold: number;
}

export interface Detector {
  readonly entity: string;
  readonly category: Category;
  /** Global regex (flags must include `g` and `d`). */
  readonly pattern: RegExp;
  /** Capture group holding the sensitive value (redacted span); 0 = whole match. */
  readonly group?: number;
  /** Decides whether a hit's value is a real instance; absent = every hit counts. */
  readonly verify?: (value: string, opts: DetectorOptions) => boolean;
  /** Off unless named in `entities` / `entityActions` (noisy entities such as ipv4). */
  readonly optIn?: boolean;
}

export interface Finding {
  readonly entity: string;
  readonly category: Category;
  /** Span of the sensitive value in the canonical text. */
  readonly start: number;
  readonly end: number;
}

const PLACEHOLDER_VALUE =
  /^(?:\$|%|\{\{|process\.env|os\.environ|env\.)|^(?:x+|\*+|\.+|-+)$|^(?:changeme|placeholder|redacted|example|your[_-]?\w*)$/i;

/** Generic assignment value: high entropy and not an obvious placeholder / env reference. */
function genericSecretValid(value: string, opts: DetectorOptions): boolean {
  if (value.length < 8) return false;
  if (PLACEHOLDER_VALUE.test(value)) return false;
  return shannonEntropy(value) >= opts.entropyThreshold;
}

const PEM_BASE64_LINES = String.raw`(?:(?:\s|\\n|\\r)*(?:[A-Za-z0-9+/=]{16,}|[A-Za-z-]+: [^\n\\]*))*`;
const PEM_LABEL = "(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?";

/**
 * Built-in detectors in PRIORITY order: when two findings overlap, the one
 * from the earlier detector wins (so `api_key=sk-…` is reported as
 * openai_key, not generic_secret, and an 18-digit ID that happens to pass
 * Luhn stays a cn_id).
 */
export const BUILTIN_DETECTORS: readonly Detector[] = [
  // ── secrets ──
  {
    entity: "private_key",
    category: "secret",
    // The whole block when the END line is there; otherwise the BEGIN line and
    // the base64 / header lines after it (a truncated paste is still a key).
    pattern: new RegExp(
      String.raw`-----BEGIN ${PEM_LABEL}-----(?:[\s\S]*?-----END ${PEM_LABEL}-----|${PEM_BASE64_LINES})`,
      "dg",
    ),
  },
  { entity: "anthropic_key", category: "secret", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/dg },
  {
    // sk- keys: OpenAI (sk-…, sk-proj-…, sk-svcacct-…), DeepSeek, Moonshot and
    // other OpenAI-compatible vendors. Anthropic's sk-ant- is its own entity.
    entity: "openai_key",
    category: "secret",
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/dg,
    verify: (v) => mixedAlnum(v.slice(3)),
  },
  { entity: "aws_access_key", category: "secret", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/dg },
  {
    entity: "aws_secret_key",
    category: "secret",
    pattern:
      /\baws[A-Za-z0-9_.-]{0,20}?secret[A-Za-z0-9_.-]{0,20}["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/dgi,
    group: 1,
    verify: (v) => mixedAlnum(v),
  },
  {
    entity: "github_token",
    category: "secret",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/dg,
  },
  { entity: "slack_token", category: "secret", pattern: /\b(?:xox[abeprs]|xapp)-[0-9A-Za-z-]{10,}/dg },
  { entity: "google_api_key", category: "secret", pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/dg },
  { entity: "stripe_key", category: "secret", pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{24,}\b/dg },
  {
    entity: "jwt",
    category: "secret",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/dg,
    verify: jwtValid,
  },
  {
    // `api_key = …`, `password: "…"`, `client_secret=…`: the value is reported
    // only above the entropy threshold, so `password=changeme` and
    // `max_tokens=4096` pass.
    entity: "generic_secret",
    category: "secret",
    pattern:
      /\b[A-Za-z0-9_.-]*(?:api[_.-]?key|apikey|secret|token|passwd|password|pwd|access[_.-]?key|private[_.-]?key|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?([^\s"'`,;<>{}()[\]\\]{8,})/dgi,
    group: 1,
    verify: genericSecretValid,
  },
  // ── PII ──
  {
    entity: "email",
    category: "pii",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/dg,
  },
  {
    entity: "cn_id",
    category: "pii",
    pattern:
      /(?<![0-9A-Za-z])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9A-Za-z])/dg,
    verify: cnIdValid,
  },
  {
    entity: "credit_card",
    category: "pii",
    pattern: /(?<![\d-])(?:\d[ -]?){12,18}\d(?!\d)/dg,
    verify: creditCardValid,
  },
  {
    entity: "iban",
    category: "pii",
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/dg,
    verify: ibanValid,
  },
  {
    // CN mobile (1[3-9]x, optional +86 / 0086), E.164 (+ and 8–15 digits),
    // formatted international (+44 20 7946 0958), NANP ((415) 555-0100, 415-555-0100).
    entity: "phone",
    category: "pii",
    pattern: new RegExp(
      [
        String.raw`(?<![\w+])(?:(?:\+|00)86[ -]?)?1[3-9]\d(?:[ -]?\d{4}){2}(?!\w)`,
        String.raw`(?<![\w+])\+[1-9]\d{7,14}(?!\w)`,
        String.raw`(?<![\w+])\+[1-9]\d{0,3}[ -]\(?\d{1,4}\)?(?:[ -]\d{2,4}){1,4}(?!\w)`,
        String.raw`(?<![\w(])\(\d{3}\) ?\d{3}-\d{4}(?!\w)`,
        String.raw`(?<![\w.-])\d{3}[-.]\d{3}[-.]\d{4}(?!\w|[.-]\d)`,
      ].join("|"),
      "dg",
    ),
    verify: phoneDigitsValid,
  },
  {
    entity: "ssn",
    category: "pii",
    pattern: /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/dg,
  },
  {
    entity: "ipv4",
    category: "pii",
    pattern: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d|\.\d)/dg,
    optIn: true,
  },
];

export const BUILTIN_ENTITIES: readonly string[] = BUILTIN_DETECTORS.map((d) => d.entity);
export const SECRET_ENTITIES: readonly string[] = BUILTIN_DETECTORS.filter((d) => d.category === "secret").map(
  (d) => d.entity,
);
export const PII_ENTITIES: readonly string[] = BUILTIN_DETECTORS.filter((d) => d.category === "pii").map(
  (d) => d.entity,
);

const ZERO_WIDTH = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** NFKC (as word-filter) and zero-width / bidi-control removal. */
export function canonicalize(text: string): string {
  return text.normalize("NFKC").replace(ZERO_WIDTH, "");
}

/**
 * Every non-overlapping verified finding in `text` (already canonical), in
 * text order. Overlaps go to the higher-priority detector (earlier in the
 * list). Allowlisted values are dropped before they can claim a span.
 */
export function detect(
  text: string,
  detectors: readonly Detector[],
  opts: DetectorOptions,
  allowlist: readonly RegExp[] = [],
): Finding[] {
  const accepted: Finding[] = [];
  for (const det of detectors) {
    det.pattern.lastIndex = 0;
    for (const m of text.matchAll(det.pattern)) {
      const g = det.group ?? 0;
      const span = m.indices?.[g];
      const value = m[g];
      if (!span || value === undefined || value === "") continue;
      if (det.verify && !det.verify(value, opts)) continue;
      if (allowlist.some((re) => re.test(value))) continue;
      const [start, end] = span;
      if (accepted.some((f) => start < f.end && f.start < end)) continue;
      accepted.push({ entity: det.entity, category: det.category, start, end });
    }
  }
  return accepted.sort((a, b) => a.start - b.start);
}

/** `text` with each selected finding's span replaced by its placeholder (findings from detect() on the same text). */
export function redact(
  text: string,
  findings: readonly Finding[],
  shouldRedact: (f: Finding) => boolean,
  placeholder: (f: Finding) => string,
): string {
  let out = text;
  for (const f of [...findings].sort((a, b) => b.start - a.start)) {
    if (!shouldRedact(f)) continue;
    out = out.slice(0, f.start) + placeholder(f) + out.slice(f.end);
  }
  return out;
}
