/**
 * GET /admin/usage (0.3.0 P5): token and request statistics for the owner,
 * grouped by key, model or channel over a range of calendar days.
 *
 *   ?groupBy=key|model|channel   (default key)
 *   &from=YYYY-MM-DD&to=YYYY-MM-DD  inclusive; default: the last 7 days up to today
 *   &tz=<IANA zone>              days are calendar days in this zone (default UTC)
 *   &daily=true                  also split every group by day
 *
 * Read from the hourly rollups (usage/usage-store.ts), never from the
 * request log; pending rollups are flushed first, so finished requests are
 * always included. Any admin or read_only credential may read it. There are
 * no prices or costs anywhere: only tokens, requests, errors and latency.
 */

import type { Context } from "hono";
import type { KeyStore } from "../persistence/key-store.js";
import type { UsageRecorder } from "../usage/recorder.js";
import { addCounts, emptyCounts, HOUR_MS, type UsageCounts, type UsageStore } from "../usage/usage-store.js";
import { adminError } from "./guards.js";

export interface UsageHandlerState {
  readonly store?: UsageStore;
  readonly recorder?: UsageRecorder;
  readonly keyStore?: KeyStore;
}

const GROUP_BY = ["key", "model", "channel"] as const;
type GroupBy = (typeof GROUP_BY)[number];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
/** Longest range one query may cover. */
export const MAX_USAGE_DAYS = 366;
const DEFAULT_DAYS = 7;

/** "YYYY-MM-DD" → UTC midnight ms of that calendar date, or undefined when not a real date. */
function parseDate(v: string): number | undefined {
  const m = DATE_RE.exec(v);
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === v ? ms : undefined;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Calendar date ("YYYY-MM-DD") of an instant in a time zone. */
function dateFormatter(tz: string): (ms: number) => string {
  if (tz === "UTC") return isoDate;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return (ms) => {
    const parts = fmt.formatToParts(ms);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
}

/** A valid IANA zone name (or UTC), else undefined. */
function validZone(tz: string): string | undefined {
  if (tz === "" || tz.length > 64) return undefined;
  if (tz.toUpperCase() === "UTC" || tz === "Etc/UTC") return "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

interface Group extends UsageCounts {
  daily?: Map<string, UsageCounts>;
}

function view(c: UsageCounts) {
  return {
    requests: c.requests,
    errors: c.errors,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    totalTokens: c.inputTokens + c.outputTokens,
    cacheHitTokens: c.cacheHitTokens,
    reasoningTokens: c.reasoningTokens,
    estimatedRequests: c.estimatedRequests,
    avgLatencyMs: c.requests > 0 ? Math.round(c.latencyMsSum / c.requests) : 0,
    maxLatencyMs: c.latencyMsMax,
  };
}

/** GET /admin/usage */
export function usageHandler(state: UsageHandlerState) {
  return (c: Context) => {
    const q = (k: string) => c.req.query(k);
    const groupBy = (q("groupBy") ?? "key") as GroupBy;
    if (!GROUP_BY.includes(groupBy)) {
      return adminError(c, 400, "invalid_request", `groupBy must be one of: ${GROUP_BY.join(", ")}`);
    }
    const tz = validZone(q("tz") ?? "UTC");
    if (tz === undefined) {
      return adminError(c, 400, "invalid_request", 'tz must be an IANA time zone such as "UTC" or "Asia/Shanghai"');
    }
    const dateOf = dateFormatter(tz);
    const today = parseDate(dateOf(Date.now())) as number;
    const toRaw = q("to");
    const fromRaw = q("from");
    const to = toRaw === undefined ? today : parseDate(toRaw);
    if (to === undefined) return adminError(c, 400, "invalid_request", "to must be a date: YYYY-MM-DD");
    const from = fromRaw === undefined ? to - (DEFAULT_DAYS - 1) * DAY_MS : parseDate(fromRaw);
    if (from === undefined) return adminError(c, 400, "invalid_request", "from must be a date: YYYY-MM-DD");
    if (from > to) return adminError(c, 400, "invalid_request", "from must not be after to");
    if ((to - from) / DAY_MS + 1 > MAX_USAGE_DAYS) {
      return adminError(c, 400, "invalid_request", `at most ${MAX_USAGE_DAYS} days per query`);
    }
    const dailyRaw = q("daily");
    if (dailyRaw !== undefined && dailyRaw !== "true" && dailyRaw !== "false") {
      return adminError(c, 400, "invalid_request", "daily must be true or false");
    }
    const daily = dailyRaw === "true";
    if (!state.store) {
      return adminError(
        c,
        503,
        "usage_unavailable",
        "Usage statistics need the server's data directory (ai-gateway serve); this instance has no usage store",
      );
    }
    state.recorder?.flush();

    // Every zone is within UTC-12..UTC+14: read a margin around the UTC days and keep the buckets whose
    // start falls on a requested local date.
    const fromDate = isoDate(from);
    const toDate = isoDate(to);
    const buckets = state.store.range(
      Math.floor((from - 14 * 3_600_000) / HOUR_MS),
      Math.ceil((to + DAY_MS + 12 * 3_600_000) / HOUR_MS),
    );
    const dayCache = new Map<number, string>();
    const groups = new Map<string, Group>();
    const totals = emptyCounts();
    for (const b of buckets) {
      let day = dayCache.get(b.hour);
      if (day === undefined) {
        day = dateOf(b.hour * HOUR_MS);
        dayCache.set(b.hour, day);
      }
      if (day < fromDate || day > toDate) continue;
      const k = groupBy === "key" ? b.keyId : groupBy === "model" ? b.model : b.channel;
      let g = groups.get(k);
      if (!g) {
        g = emptyCounts();
        groups.set(k, g);
      }
      addCounts(g, b);
      addCounts(totals, b);
      if (daily) {
        g.daily ??= new Map();
        let d = g.daily.get(day);
        if (!d) {
          d = emptyCounts();
          g.daily.set(day, d);
        }
        addCounts(d, b);
      }
    }

    const keyNames = groupBy === "key" ? keyNameLookup(state.keyStore) : undefined;
    const data = [...groups.entries()]
      .map(([k, g]) => ({
        ...groupLabel(groupBy, k, keyNames),
        ...view(g),
        ...(daily
          ? {
              daily: [...(g.daily ?? new Map<string, UsageCounts>()).entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([date, d]) => ({ date, ...view(d) })),
            }
          : {}),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);

    return c.json({
      object: "usage",
      groupBy,
      from: fromDate,
      to: toDate,
      tz,
      data,
      totals: view(totals),
    });
  };
}

function keyNameLookup(keyStore: KeyStore | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const k of keyStore?.list() ?? []) out.set(k.id, k.name);
  return out;
}

function groupLabel(groupBy: GroupBy, k: string, keyNames: Map<string, string> | undefined) {
  if (groupBy === "model") return { model: k };
  if (groupBy === "channel") return { channel: k };
  if (k === "") return { key: null, name: null, kind: "none" as const };
  if (k.startsWith("cfg_")) return { key: k, name: null, kind: "config" as const };
  return { key: k, name: keyNames?.get(k) ?? null, kind: keyNames?.has(k) ? ("store" as const) : ("deleted" as const) };
}
