/**
 * Strict Zod objects whose unknown-key error names each key and either its
 * migration hint (removed key) or the closest valid key (typo). Shared by the
 * gateway config schema and the built-in plugin config schemas.
 */

import { z } from "zod";

export function strictObject<T extends z.ZodRawShape>(shape: T, removed: Readonly<Record<string, string>> = {}) {
  return z.strictObject(shape, {
    error: (iss) =>
      iss.code === "unrecognized_keys" ? unknownKeysMessage(iss.keys, Object.keys(shape), removed) : undefined,
  });
}

export function unknownKeysMessage(
  keys: readonly string[],
  valid: readonly string[],
  removed: Readonly<Record<string, string>> = {},
): string {
  const parts: string[] = [];
  let unknown = false;
  for (const key of keys) {
    const hint = removed[key];
    if (hint !== undefined) {
      parts.push(hint);
      continue;
    }
    unknown = true;
    const guess = closestKey(key, valid);
    parts.push(`unknown key "${key}"${guess !== undefined ? ` (did you mean "${guess}"?)` : ""}`);
  }
  if (unknown) parts.push(`valid keys: ${valid.join(", ")}`);
  return parts.join("; ");
}

function closestKey(key: string, valid: readonly string[]): string | undefined {
  const k = key.toLowerCase().replace(/[_-]/g, "");
  let best: string | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const v of valid) {
    const d = editDistance(k, v.toLowerCase());
    if (d < bestDist) {
      best = v;
      bestDist = d;
    }
  }
  if (best !== undefined && bestDist <= Math.max(2, Math.floor(key.length / 3)) && bestDist < key.length) return best;
  // Plural/suffix slips: retries → retry, keyss → keys.
  return valid.find((v) => v.length >= 4 && k.startsWith(v.toLowerCase().slice(0, -1)));
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}
