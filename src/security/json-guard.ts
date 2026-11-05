/**
 * Structural checks on a JSON request body before anything parses or walks it
 * (red team 2026-11-05):
 *
 *  - D5: nesting depth. `JSON.parse` accepts 100,000 nested arrays, but the
 *    first recursive walk after it (serializing the upstream body, estimating
 *    tokens) overflowed the stack, and that local RangeError was counted as an
 *    upstream failure that opened the circuit breaker. Bodies nested deeper
 *    than MAX_JSON_DEPTH are a 400.
 *  - P1: duplicate top-level keys. The pass-through proxy read the body twice
 *    with different parsers: the access check took the LAST "model", routing
 *    took the FIRST, so `{"model":"forbidden","model":"allowed"}` passed the
 *    key's allowedModels and was sent to the forbidden model's channel.
 *    Pass-through bodies with a repeated top-level key are a 400.
 *
 * One linear pass over the text; strings and escapes are skipped exactly, so
 * brackets inside strings do not count. Malformed JSON is not judged here
 * (the caller's parser does that).
 */

/** Deepest nesting of objects / arrays accepted in a request body. */
export const MAX_JSON_DEPTH = 128;

export interface JsonShape {
  /** Deepest nesting reached (stops counting just past `maxDepth`). */
  readonly depth: number;
  /** The nesting limit was exceeded. */
  readonly tooDeep: boolean;
  /** First top-level key that appears twice (decoded), when asked to look. */
  readonly duplicateKey?: string;
}

/**
 * Scan `text` once: nesting depth (up to `maxDepth` + 1) and, with
 * `topLevelKeys`, the first repeated key of a top-level object (compared
 * after decoding escapes, so "mod\u0065l" and "model" are the same key).
 */
export function inspectJson(text: string, opts: { maxDepth?: number; topLevelKeys?: boolean } = {}): JsonShape {
  const maxDepth = opts.maxDepth ?? MAX_JSON_DEPTH;
  const seen = opts.topLevelKeys ? new Set<string>() : undefined;
  let depth = 0;
  let deepest = 0;
  // Top-level object only: whether the next string is a key.
  let topIsObject = false;
  let expectKey = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 34 /* " */) {
      const start = i;
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92 /* \ */) {
          i += 2;
          continue;
        }
        if (d === 34) break;
        i++;
      }
      if (seen && depth === 1 && topIsObject && expectKey) {
        expectKey = false;
        const raw = text.slice(start, Math.min(i + 1, n));
        let key = raw;
        try {
          key = JSON.parse(raw) as string;
        } catch {
          // malformed: compare the raw text
        }
        if (seen.has(key)) return { depth: deepest, tooDeep: false, duplicateKey: key };
        seen.add(key);
      }
      continue;
    }
    if (c === 123 /* { */ || c === 91 /* [ */) {
      depth++;
      if (depth > deepest) deepest = depth;
      if (depth > maxDepth) return { depth: deepest, tooDeep: true };
      if (depth === 1) {
        topIsObject = c === 123;
        expectKey = topIsObject;
      }
      continue;
    }
    if (c === 125 /* } */ || c === 93 /* ] */) {
      if (depth > 0) depth--;
      continue;
    }
    if (c === 44 /* , */ && depth === 1 && topIsObject) expectKey = true;
  }
  return { depth: deepest, tooDeep: false };
}

/** Whether `text` (after leading whitespace) starts like a JSON object or array. */
export function looksLikeJsonContainer(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) continue;
    return c === 123 || c === 91;
  }
  return false;
}
