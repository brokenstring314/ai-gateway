/**
 * Go-style duration strings, one parser for every duration in the config
 * (`requestTimeout`, `observability.tracing.shutdownGrace`): the schema
 * validates with it and the runtime converts with it, so a value that passes
 * `ai-gateway validate` always means the same thing at runtime.
 *
 * Grammar: one or more `<integer><unit>` terms, unit `ms | s | m | h`, no
 * spaces or signs, total > 0. Examples: `500ms`, `30s`, `5m`, `1h`, `1m30s`.
 */

const TERM = /(\d+)(ms|h|m|s)/y;

const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

export const DURATION_HINT =
  'expected a positive duration like "500ms", "30s", "5m", "1h" or "1m30s" (units ms, s, m, h)';

/** Milliseconds for a valid duration string, or undefined when it is not one. */
export function parseDuration(value: string): number | undefined {
  if (value === "") return undefined;
  let total = 0;
  TERM.lastIndex = 0;
  while (TERM.lastIndex < value.length) {
    const match = TERM.exec(value);
    if (match === null) return undefined;
    total += Number(match[1]) * (UNIT_MS[match[2] ?? ""] ?? Number.NaN);
  }
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

/** Like parseDuration, but throws `<field>: invalid duration ...` (code paths that skip the schema). */
export function parseDurationOrThrow(field: string, value: string): number {
  const ms = parseDuration(value);
  if (ms === undefined) throw new Error(`${field}: invalid duration "${value}"; ${DURATION_HINT}`);
  return ms;
}
