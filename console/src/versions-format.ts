/**
 * Human-readable config versions and audit entries (UI test 2026-11-05 U2 / U9):
 *  - version summaries (English text written by the server) parsed back into labelled zh / en text;
 *  - snapshots turned into "channel alpha › Base URL" style rows: ids, revisions, timestamps and
 *    other internal columns hidden, *_json columns parsed, secrets masked;
 *  - audit details as labelled key: value pairs.
 */
import { DICTIONARY, fieldLabel, type MsgKey, t } from "./i18n";

// ── Summaries ──

const RESOURCE: Record<string, MsgKey> = { channel: "rt.channel", model: "rt.model" };

function fieldsText(list: string): string {
  if (list.trim() === "no fields") return t("vs.noFields");
  return list
    .split(/,\s*/)
    .map((f) => fieldLabel(f.trim()))
    .join(t("listSep"));
}

/** A version summary as the server wrote it → the console's language. Unknown shapes are shown as written. */
export function summaryText(summary: string): string {
  let m = summary.match(/^(Create|Delete) (channel|model) "(.*)"$/);
  if (m) {
    return t(m[1] === "Create" ? "vs.create" : "vs.delete", { type: t(RESOURCE[m[2]!]!), name: m[3]! });
  }
  m = summary.match(/^Update (channel|model) "(.*)" \((.*)\)$/);
  if (m) return t("vs.update", { type: t(RESOURCE[m[1]!]!), name: m[2]!, fields: fieldsText(m[3]!) });
  m = summary.match(/^Add (\d+) key\(s\) to channel "(.*)"$/);
  if (m) return t("vs.addKeys", { n: m[1]!, name: m[2]! });
  m = summary.match(/^(update|enable|disable|delete) key (.+) on channel "(.*)"$/);
  if (m) return t("vs.keyOp", { op: t(`vs.op.${m[1]}_key` as MsgKey), hint: m[2]!, name: m[3]! });
  m = summary.match(/^Set (\d+) binding\(s\) of model "(.*)"$/);
  if (m) return t("vs.bindings", { n: m[1]!, name: m[2]! });
  m = summary.match(/^Update settings \((.*)\)$/);
  if (m) return t("vs.settings", { fields: fieldsText(m[1]!) });
  m = summary.match(/^Roll back to config version (\d+)$/);
  if (m) return t("vs.rollback", { v: m[1]! });
  m = summary.match(/^Imported (\d+) target\(s\)/);
  if (m) return t("vs.import", { n: m[1]! });
  return summary;
}

// ── Secrets ──

const SECRET_NAME = /(^|_)(api_?key|secret|token|password|passwd|credential)s?$|^(key|apiKey|authorization)$/i;
const SECRET_VALUE = /^(sk|fgw|rk|pk|xai|gsk)[-_][A-Za-z0-9_\-.]{8,}$/;

/** "sk-abcdef…wxyz" style mask for anything that looks like a secret. */
export function maskSecret(v: string): string {
  if (v.length <= 8) return "••••";
  return `${v.slice(0, 3)}…${v.slice(-4)}`;
}

function maskValue(name: string, v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (SECRET_NAME.test(name) || SECRET_VALUE.test(v)) return maskSecret(v);
  return v;
}

// ── Snapshots ──

const HIDDEN =
  /^(id|.*_id|revision|position|created_at|updated_at|createdAt|updatedAt|format|key_hash|ciphertext|iv|nonce|encrypted.*)$/;
const BOOL_COLS = new Set(["enabled"]);

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

/** Row columns → readable fields: *_json parsed, ids / revisions / timestamps dropped, 0/1 booleans, secrets masked. */
function cleanRow(row: Record<string, unknown>, drop: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(row)) {
    if (HIDDEN.test(k) || drop.includes(k)) continue;
    if (k.endsWith("_json")) {
      const base = k.slice(0, -5);
      const v = parseJson(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if (base === "settings" || base === "routing" || base === "metadata") {
          // Flatten one level: settings.keyStrategy reads better as "多 key 策略".
          for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) out[sk] = maskValue(sk, sv);
          continue;
        }
        if (Object.keys(v as object).length === 0) continue;
      }
      out[base] = v;
      continue;
    }
    out[k] = BOOL_COLS.has(k) && (raw === 0 || raw === 1) ? raw === 1 : maskValue(k, raw);
  }
  return out;
}

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Row[]) : []);

/**
 * A stored config snapshot (DB rows) → a readable tree:
 * { channels: { alpha: { …, keys: { "sk-…aaaa": {…} } } }, models: { m: { …, bindings: { "alpha → up": {…} } } }, settings, modelSource }.
 */
export function readableSnapshot(snap: unknown): Record<string, unknown> {
  const s = (snap && typeof snap === "object" ? snap : {}) as Record<string, unknown>;
  const channelName = new Map<string, string>();
  for (const ch of rows(s["channels"])) channelName.set(String(ch["id"]), String(ch["name"] ?? ch["id"]));
  const modelName = new Map<string, string>();
  for (const m of rows(s["models"])) modelName.set(String(m["id"]), String(m["name"] ?? m["id"]));

  const out: Record<string, unknown> = {};
  const known = new Set(["channels", "keys", "models", "bindings", "settings", "meta", "format"]);

  const channels: Record<string, Row> = {};
  for (const ch of rows(s["channels"])) channels[String(ch["name"] ?? ch["id"])] = cleanRow(ch, ["name"]);
  // Keys under their channel, by hint; two keys with the same hint get "#2".
  const seen = new Map<string, number>();
  for (const k of rows(s["keys"])) {
    const ch = channelName.get(String(k["channel_id"])) ?? String(k["channel_id"]);
    const target = (channels[ch] ??= {});
    const keys = (target["keys"] ??= {}) as Record<string, unknown>;
    const hint = String(k["hint"] ?? "key");
    const n = (seen.get(`${ch}\u0000${hint}`) ?? 0) + 1;
    seen.set(`${ch}\u0000${hint}`, n);
    const row = cleanRow(k, ["hint", "kind", "last_error_at"]);
    // Key health in the console's language (正常 / 失效（401）…).
    if (typeof row["status"] === "string" && DICTIONARY[`ch.keyStatus.${row["status"]}`]) {
      row["status"] = t(`ch.keyStatus.${row["status"]}` as MsgKey);
    }
    keys[n > 1 ? `${hint} #${n}` : hint] = row;
  }
  if (Object.keys(channels).length > 0 || s["channels"] !== undefined) out["channels"] = channels;

  const models: Record<string, Row> = {};
  for (const m of rows(s["models"])) models[String(m["name"] ?? m["id"])] = cleanRow(m, ["name"]);
  for (const b of rows(s["bindings"])) {
    const m = modelName.get(String(b["model_id"])) ?? String(b["model_id"]);
    const target = (models[m] ??= {});
    const bindings = (target["bindings"] ??= {}) as Record<string, unknown>;
    const ch = channelName.get(String(b["channel_id"])) ?? String(b["channel_id"]);
    const up = b["upstream_model"] ?? b["upstreamModel"];
    bindings[up ? `${ch} → ${String(up)}` : ch] = cleanRow(b, ["upstream_model", "upstreamModel"]);
  }
  if (Object.keys(models).length > 0 || s["models"] !== undefined) out["models"] = models;

  if (Array.isArray(s["settings"])) {
    const settings: Row = {};
    for (const r of rows(s["settings"])) settings[String(r["key"])] = parseJson(r["value_json"] ?? r["value"]);
    out["settings"] = settings;
  } else if (s["settings"] && typeof s["settings"] === "object") {
    out["settings"] = s["settings"];
  }
  const meta = s["meta"] as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    for (const [k, v] of Object.entries(meta)) {
      if (k === "models_explicit") out["modelSource"] = v === "1" || v === 1 || v === true ? "explicit" : "derived";
      else out[k] = v;
    }
  }
  // Anything newer the console does not know yet: shown generically, still cleaned.
  for (const [k, v] of Object.entries(s)) {
    if (known.has(k)) continue;
    if (Array.isArray(v)) {
      const t2: Record<string, Row> = {};
      rows(v).forEach((r, i) => {
        t2[String(r["name"] ?? r["key"] ?? r["id"] ?? i)] = cleanRow(r, ["name"]);
      });
      out[k] = t2;
    } else out[k] = v;
  }
  return out;
}

/** Marker value: the whole channel / model was added or removed. */
export const WHOLE = Symbol("whole");

export interface ReadableDiff {
  /** Path segments: section, item, field… */
  segs: string[];
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

function leaves(v: unknown, segs: string[], out: Map<string, { segs: string[]; value: unknown }>): void {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0 && segs.length > 0) out.set(JSON.stringify(segs), { segs, value: {} });
    for (const [k, x] of entries) leaves(x, [...segs, k], out);
    return;
  }
  // Arrays (model lists, efforts…) are compared as one value.
  out.set(JSON.stringify(segs), { segs, value: v });
}

/** Readable diff of two snapshots, sorted by path. A channel / model added or removed as a whole is one line. */
export function readableDiff(a: unknown, b: unknown): ReadableDiff[] {
  const ra = readableSnapshot(a);
  const rb = readableSnapshot(b);
  const fa = new Map<string, { segs: string[]; value: unknown }>();
  const fb = new Map<string, { segs: string[]; value: unknown }>();
  const out: ReadableDiff[] = [];
  for (const section of ["channels", "models"]) {
    const sa = (ra[section] ?? {}) as Record<string, unknown>;
    const sb = (rb[section] ?? {}) as Record<string, unknown>;
    for (const item of Object.keys(sa)) {
      if (!(item in sb)) {
        out.push({ segs: [section, item], kind: "removed", before: WHOLE });
        delete sa[item];
      }
    }
    for (const item of Object.keys(sb)) {
      if (!(item in sa)) {
        out.push({ segs: [section, item], kind: "added", after: WHOLE });
        delete sb[item];
      }
    }
  }
  leaves(ra, [], fa);
  leaves(rb, [], fb);
  for (const [k, x] of fa) {
    const y = fb.get(k);
    if (!y) out.push({ segs: x.segs, kind: "removed", before: x.value });
    else if (JSON.stringify(x.value) !== JSON.stringify(y.value))
      out.push({ segs: x.segs, kind: "changed", before: x.value, after: y.value });
  }
  for (const [k, y] of fb) if (!fa.has(k)) out.push({ segs: y.segs, kind: "added", after: y.value });
  return out.sort((x, y) => x.segs.join("\u0000").localeCompare(y.segs.join("\u0000")));
}

const SECTION: Record<string, MsgKey> = {
  channels: "nav.channels",
  models: "nav.models",
  settings: "nav.settings",
};
/** Levels whose segment is a user-chosen name (channel / key hint / model / binding), not a field. */
const NAMED_LEVELS: Record<string, readonly number[]> = { channels: [1, 3], models: [1, 3], settings: [1] };

/** Path segments → "渠道 › alpha › 上游 key › sk-…aaaa › 权重". */
export function pathText(segs: readonly string[]): string {
  const section = segs[0] ?? "";
  const named = NAMED_LEVELS[section] ?? [];
  return segs
    .map((s, i) => {
      if (i === 0) return SECTION[section] ? t(SECTION[section]!) : fieldLabel(s);
      return named.includes(i) ? s : fieldLabel(s);
    })
    .join(" › ");
}

/** A diff / detail value for display: strings bare, booleans 是/否, lists joined, objects as compact JSON. */
export function valueText(v: unknown): string {
  if (v === WHOLE) return t("v.wholeItem");
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? t("yes") : t("no");
  if (typeof v === "string") return v === "" ? '""' : v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.every((x) => typeof x !== "object" || x === null)) return v.map((x) => String(x)).join(", ");
  }
  return JSON.stringify(v);
}

// ── Audit details ──

function maskDeep(v: unknown, name = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, name));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, maskDeep(x, k)]));
  }
  return maskValue(name, v);
}

/** Audit detail → labelled pairs (field names translated, ids → names when known, secrets masked). */
export function auditPairs(
  detail: unknown,
  names: ReadonlyMap<string, string> = new Map(),
): Array<{ label: string; value: string }> {
  if (detail === null || detail === undefined) return [];
  if (typeof detail !== "object" || Array.isArray(detail)) return [{ label: t("v.detail"), value: valueText(detail) }];
  const out: Array<{ label: string; value: string }> = [];
  for (const [k, raw] of Object.entries(detail as Record<string, unknown>)) {
    let v: unknown = maskValue(k, raw);
    if ((k === "changed" || k === "fields") && Array.isArray(raw)) v = raw.map((f) => fieldLabel(String(f)));
    else if (Array.isArray(raw) && raw.some((x) => x && typeof x === "object")) {
      // keys → hints; bindings → "channel:upstream"; anything else as JSON.
      v = raw.map((x) => {
        if (!x || typeof x !== "object") return x;
        const r = x as Row;
        if (typeof r["hint"] === "string") return r["hint"];
        const ch = r["channelId"] ?? r["channel"];
        if (typeof ch === "string") {
          const up = typeof r["upstreamModel"] === "string" ? `:${r["upstreamModel"]}` : "";
          return `${names.get(ch) ?? shortId(ch)}${up}`;
        }
        return JSON.stringify(maskDeep(r));
      });
    } else if (typeof raw === "string" && names.has(raw)) v = names.get(raw);
    else if (typeof raw === "number" && k === "bindings") v = String(raw);
    else if (k === "status" && typeof raw === "string" && DICTIONARY[`ch.keyStatus.${raw}`]) {
      v = t(`ch.keyStatus.${raw}` as MsgKey);
    }
    out.push({ label: fieldLabel(k), value: valueText(v) });
  }
  return out;
}

/** "644fb848-0555-…" → "644fb848"; other ids unchanged. */
export function shortId(id: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) return id.slice(0, 8);
  // ch_ / chk_ / mdl_ / bnd_ + 24 hex: prefix and the first 6.
  const m = id.match(/^([a-z]{2,4}_)([0-9a-f]{6})[0-9a-f]{10,}$/);
  return m ? `${m[1]}${m[2]}…` : id;
}
