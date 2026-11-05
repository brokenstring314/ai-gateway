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
  /**
   * Global regex (flags must include `g` and `d`). Built-in patterns must run
   * in linear time on any input (red team 2026-11-05 D2); a pattern that
   * cannot (an unbounded run that must be followed by something specific)
   * is replaced by `scan`.
   */
  readonly pattern?: RegExp;
  /** Linear-time scanner used instead of `pattern`: the same hits, in text order, non-overlapping. */
  readonly scan?: (text: string) => Iterable<Hit>;
  /** Capture group holding the sensitive value (redacted span); 0 = whole match. */
  readonly group?: number;
  /** Decides whether a hit's value is a real instance; absent = every hit counts. */
  readonly verify?: (value: string, opts: DetectorOptions) => boolean;
  /** Off unless named in `entities` / `entityActions` (noisy entities such as ipv4). */
  readonly optIn?: boolean;
}

/** One match of a detector: span of the reported value and the value itself. */
export interface Hit {
  readonly start: number;
  readonly end: number;
  readonly value: string;
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
    // Same hits as `-----BEGIN L-----(?:[\s\S]*?-----END L-----|LINES)`, whose
    // lazy END search re-scanned the rest of the text for every BEGIN line.
    scan: scanPrivateKeys,
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
    // `\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`, scanned
    // linearly ("eyJ-eyJ-eyJ-…" made the regex rescan the run for every eyJ).
    scan: scanJwts,
    verify: jwtValid,
  },
  {
    // `api_key = …`, `password: "…"`, `client_secret=…`: the value is reported
    // only above the entropy threshold, so `password=changeme` and
    // `max_tokens=4096` pass.
    entity: "generic_secret",
    category: "secret",
    // Same hits as `\b[A-Za-z0-9_.-]*(?:api[_.-]?key|…|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?([^\s"'`,;<>{}()[\]\\]{8,})`
    // (case-insensitive), scanned from each ":" / "=" so it stays linear: the
    // regex re-scanned a long `a.a.a.…` run for every word boundary (D2).
    scan: scanGenericSecrets,
    verify: genericSecretValid,
  },
  // ── PII ──
  {
    entity: "email",
    category: "pii",
    // `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b`, anchored on "@" (linear, D2).
    scan: scanEmails,
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

/** The hits of one detector, in text order (regex detectors: every match of the global pattern). */
function* hitsOf(det: Detector, text: string): Iterable<Hit> {
  if (det.scan) {
    yield* det.scan(text);
    return;
  }
  const pattern = det.pattern;
  if (!pattern) return;
  pattern.lastIndex = 0;
  const g = det.group ?? 0;
  for (const m of text.matchAll(pattern)) {
    const span = m.indices?.[g];
    const value = m[g];
    if (!span || value === undefined || value === "") continue;
    yield { start: span[0], end: span[1], value };
  }
}

/**
 * Every non-overlapping verified finding in `text` (already canonical), in
 * text order. Overlaps go to the higher-priority detector (earlier in the
 * list). Allowlisted values are dropped before they can claim a span.
 * Linear in the text plus the findings: each detector's hits arrive in text
 * order and are merged against the (sorted) accepted spans with one cursor.
 */
export function detect(
  text: string,
  detectors: readonly Detector[],
  opts: DetectorOptions,
  allowlist: readonly RegExp[] = [],
): Finding[] {
  let accepted: Finding[] = [];
  for (const det of detectors) {
    const added: Finding[] = [];
    let cursor = 0;
    let lastEnd = -1;
    for (const hit of hitsOf(det, text)) {
      const { start, end, value } = hit;
      if (value === "" || end <= start) continue;
      if (det.verify && !det.verify(value, opts)) continue;
      if (allowlist.some((re) => re.test(value))) continue;
      if (start < lastEnd) continue; // a custom pattern's hits never overlap; be safe anyway
      while (cursor < accepted.length && accepted[cursor]!.end <= start) cursor++;
      if (cursor < accepted.length && accepted[cursor]!.start < end) continue;
      added.push({ entity: det.entity, category: det.category, start, end });
      lastEnd = end;
    }
    if (added.length > 0) accepted = mergeByStart(accepted, added);
  }
  return accepted;
}

function mergeByStart(a: readonly Finding[], b: readonly Finding[]): Finding[] {
  const out: Finding[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(a[i]!.start <= b[j]!.start ? a[i++]! : b[j++]!);
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

/** `text` with each selected finding's span replaced by its placeholder (findings from detect() on the same text). */
export function redact(
  text: string,
  findings: readonly Finding[],
  shouldRedact: (f: Finding) => boolean,
  placeholder: (f: Finding) => string,
): string {
  const parts: string[] = [];
  let last = 0;
  for (const f of [...findings].sort((a, b) => a.start - b.start)) {
    if (!shouldRedact(f) || f.start < last) continue;
    parts.push(text.slice(last, f.start), placeholder(f));
    last = f.end;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(last));
  return parts.join("");
}

// ── Linear scanners (D2) ──
// Each returns exactly the matches its documented regex would (verified by a
// differential test against the regex on random inputs), without the
// regex's per-start-position rescans.

function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}
function isWord(c: number): boolean {
  return isLetter(c) || isDigit(c) || c === 95;
}
/** [A-Za-z0-9_-] */
function isB64Url(c: number): boolean {
  return isWord(c) || c === 45;
}
/** [A-Za-z0-9._%+-] */
function isEmailLocal(c: number): boolean {
  return isLetter(c) || isDigit(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45;
}
/** [A-Za-z0-9-] */
function isLabel(c: number): boolean {
  return isLetter(c) || isDigit(c) || c === 45;
}
/** [A-Za-z0-9_.-] */
function isKeyName(c: number): boolean {
  return isWord(c) || c === 46 || c === 45;
}
/** JS `\s` for the characters that matter here (ASCII whitespace, NBSP, Unicode spaces, line separators, BOM). */
function isSpace(c: number): boolean {
  return (
    (c >= 9 && c <= 13) ||
    c === 32 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}
/** Generic secret value: [^\s"'`,;<>{}()[\]\\] */
function isSecretValue(c: number): boolean {
  if (isSpace(c)) return false;
  switch (c) {
    case 34: // "
    case 39: // '
    case 96: // `
    case 44: // ,
    case 59: // ;
    case 60: // <
    case 62: // >
    case 123: // {
    case 125: // }
    case 40: // (
    case 41: // )
    case 91: // [
    case 93: // ]
    case 92: // \
      return false;
    default:
      return true;
  }
}
/** Word boundary before index i (`\b`). */
function boundaryAt(s: string, i: number): boolean {
  const before = i > 0 && isWord(s.charCodeAt(i - 1));
  const after = i < s.length && isWord(s.charCodeAt(i));
  return before !== after;
}
function runEnd(s: string, i: number, pred: (c: number) => boolean): number {
  let j = i;
  while (j < s.length && pred(s.charCodeAt(j))) j++;
  return j;
}

/** `\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}` */
export function* scanJwts(s: string): Iterable<Hit> {
  let i = s.indexOf("eyJ");
  while (i !== -1) {
    if (i > 0 && isWord(s.charCodeAt(i - 1))) {
      i = s.indexOf("eyJ", i + 1);
      continue;
    }
    const e1 = runEnd(s, i + 3, isB64Url);
    let end = -1;
    if (e1 - (i + 3) >= 8 && s.charCodeAt(e1) === 46 && s.startsWith("eyJ", e1 + 1)) {
      const e2 = runEnd(s, e1 + 4, isB64Url);
      if (e2 - (e1 + 4) >= 8 && s.charCodeAt(e2) === 46) {
        const e3 = runEnd(s, e2 + 1, isB64Url);
        if (e3 - (e2 + 1) >= 8) end = e3;
      }
    }
    if (end !== -1) {
      yield { start: i, end, value: s.slice(i, end) };
      i = s.indexOf("eyJ", end);
    } else {
      // Every later candidate inside the first segment's run fails the same way.
      i = s.indexOf("eyJ", Math.max(e1, i + 1));
    }
  }
}

/** `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b` */
export function* scanEmails(s: string): Iterable<Hit> {
  let last = 0;
  let at = s.indexOf("@");
  while (at !== -1) {
    let runStart = at;
    while (runStart > last && isEmailLocal(s.charCodeAt(runStart - 1))) runStart--;
    // The left-most start in the run that sits on a word boundary.
    let start = -1;
    for (let i = runStart; i < at; i++) {
      if (boundaryAt(s, i)) {
        start = i;
        break;
      }
    }
    let end = -1;
    if (start !== -1) {
      // Labels [A-Za-z0-9-]+ joined by single dots; the TLD is the letters
      // after the right-most usable dot, ≥ 2 of them, followed by a boundary.
      let i = at + 1;
      let labelEnd = runEnd(s, i, isLabel);
      while (labelEnd > i && s.charCodeAt(labelEnd) === 46) {
        const dot = labelEnd;
        const k = runEnd(s, dot + 1, isLetter);
        if (k - (dot + 1) >= 2 && boundaryAt(s, k)) end = k;
        i = dot + 1;
        labelEnd = runEnd(s, i, isLabel);
      }
    }
    if (end !== -1) {
      yield { start, end, value: s.slice(start, end) };
      last = end;
      at = s.indexOf("@", end);
    } else {
      at = s.indexOf("@", at + 1);
    }
  }
}

const SECRET_KEYWORD =
  /api[_.-]?key|apikey|secret|token|passwd|password|pwd|access[_.-]?key|private[_.-]?key|credential/i;

/**
 * `\b[A-Za-z0-9_.-]*(?:KEYWORD)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?([^\s"'`,;<>{}()[\]\\]{8,})` (i),
 * group 1. The leading `\b[…]*` always finds a boundary in front of a keyword
 * (keywords start with a letter), so a hit is: a ":" or "=" whose name — the
 * run of name characters before it (optionally closed by a quote and
 * whitespace) — contains a keyword, followed by a value of ≥ 8 characters.
 */
export function* scanGenericSecrets(s: string): Iterable<Hit> {
  const n = s.length;
  let from = 0;
  for (let p = 0; p < n; p++) {
    const c = s.charCodeAt(p);
    if (c !== 58 && c !== 61) continue; // ":" "="
    if (p < from) continue;
    // Backwards: \s*, optional quote, the name run.
    let q = p;
    while (q > from && isSpace(s.charCodeAt(q - 1))) q--;
    if (q > from && (s.charCodeAt(q - 1) === 34 || s.charCodeAt(q - 1) === 39)) q--;
    let r = q;
    while (r > from && isKeyName(s.charCodeAt(r - 1))) r--;
    if (r === q || !SECRET_KEYWORD.test(s.slice(r, q))) continue;
    // Forwards: \s*, optional quote, the value.
    let v = p + 1;
    while (v < n && isSpace(s.charCodeAt(v))) v++;
    if (v < n && (s.charCodeAt(v) === 34 || s.charCodeAt(v) === 39)) v++;
    const e = runEnd(s, v, isSecretValue);
    if (e - v < 8) continue;
    yield { start: v, end: e, value: s.slice(v, e) };
    from = e;
    p = e - 1;
  }
}

const PEM_LABEL_SRC = "(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?";
const PEM_BEGIN = new RegExp(`-----BEGIN ${PEM_LABEL_SRC}-----`, "g");
const PEM_END = new RegExp(`-----END ${PEM_LABEL_SRC}-----`, "g");
const PEM_LINES = new RegExp(PEM_BASE64_LINES, "y");

/** `-----BEGIN L-----(?:[\s\S]*?-----END L-----|LINES)` with L = PEM_LABEL. */
export function* scanPrivateKeys(s: string): Iterable<Hit> {
  const begin = new RegExp(PEM_BEGIN.source, "g");
  const endRe = new RegExp(PEM_END.source, "g");
  const lines = new RegExp(PEM_LINES.source, "y");
  // First END at or after a position; queries only move forward, so one cached answer keeps this linear.
  let cachedFrom = -1;
  let cached: RegExpExecArray | null = null;
  let noneAfter = Number.POSITIVE_INFINITY;
  const firstEnd = (from: number): RegExpExecArray | null => {
    if (from >= noneAfter) return null;
    if (cached && cachedFrom <= from && cached.index >= from) return cached;
    endRe.lastIndex = from;
    cached = endRe.exec(s);
    cachedFrom = from;
    if (!cached) noneAfter = from;
    return cached;
  };
  let m: RegExpExecArray | null;
  begin.lastIndex = 0;
  while ((m = begin.exec(s)) !== null) {
    const start = m.index;
    const afterBegin = start + m[0].length;
    const end = firstEnd(afterBegin);
    let stop: number;
    if (end) {
      stop = end.index + end[0].length;
    } else {
      lines.lastIndex = afterBegin;
      const l = lines.exec(s);
      stop = afterBegin + (l ? l[0].length : 0);
    }
    yield { start, end: stop, value: s.slice(start, stop) };
    begin.lastIndex = stop > start ? stop : start + 1;
  }
}
