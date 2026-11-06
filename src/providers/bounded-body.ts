/**
 * Bounded reads of upstream response bodies (final red team 2026-11-06 FS-1).
 *
 * Bun's fetch decompresses gzip / deflate / br / zstd bodies on its own, so a
 * few hundred KB on the wire can become hundreds of MB in memory when a body
 * is read whole (`response.json()` / `.text()`). Every non-streaming upstream
 * body is read through `readBodyBounded` instead: it counts the bytes as they
 * come out of the decoder (the decompressed size) and, as soon as the total
 * passes the limit, cancels the body (which aborts the upstream transfer) and
 * throws `UpstreamResponseTooLargeError`. Nothing past the limit is buffered.
 */

/** Default ceiling for a successful (2xx) non-streaming upstream body, decompressed: 32 MiB. */
export const DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Default ceiling for an upstream error (non-2xx) body, decompressed: 64 KiB. */
export const DEFAULT_MAX_UPSTREAM_ERROR_BODY_BYTES = 64 * 1024;

export interface UpstreamResponseLimits {
  /** Largest successful non-streaming body, in decompressed bytes. */
  readonly maxResponseBytes: number;
  /** Largest error body read for its message, in decompressed bytes. */
  readonly maxErrorBodyBytes: number;
}

export const DEFAULT_UPSTREAM_RESPONSE_LIMITS: UpstreamResponseLimits = Object.freeze({
  maxResponseBytes: DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES,
  maxErrorBodyBytes: DEFAULT_MAX_UPSTREAM_ERROR_BODY_BYTES,
});

/** Limits from the config file (`maxUpstreamResponseBytes`, `maxUpstreamErrorBodyBytes`), defaults filled in. */
export function upstreamResponseLimits(config: {
  maxUpstreamResponseBytes?: number | undefined;
  maxUpstreamErrorBodyBytes?: number | undefined;
}): UpstreamResponseLimits {
  return {
    maxResponseBytes: config.maxUpstreamResponseBytes ?? DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES,
    maxErrorBodyBytes: config.maxUpstreamErrorBodyBytes ?? DEFAULT_MAX_UPSTREAM_ERROR_BODY_BYTES,
  };
}

export class UpstreamResponseTooLargeError extends Error {
  override name = "UpstreamResponseTooLargeError";
  constructor(readonly limit: number) {
    super(`upstream response body is larger than ${limit} bytes`);
  }
}

/**
 * The whole body as bytes, or UpstreamResponseTooLargeError once more than
 * `max` (decompressed) bytes arrived — the body is cancelled then, so the
 * upstream connection is dropped instead of drained. A declared
 * Content-Length above `max` is refused before reading anything. Read errors
 * (including aborts) propagate unchanged.
 */
export async function readBodyBounded(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new UpstreamResponseTooLargeError(max);
  }
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel("response too large").catch(() => undefined);
      throw new UpstreamResponseTooLargeError(max);
    }
    parts.push(value);
  }
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** `readBodyBounded` decoded as UTF-8. */
export async function readTextBounded(res: Response, max: number): Promise<string> {
  return new TextDecoder().decode(await readBodyBounded(res, max));
}

/**
 * A ReadableStream that passes `body` through unchanged but errors (and
 * cancels the upstream) once more than `max` bytes went by. For streamed
 * pass-through bodies whose size is not known up front.
 */
export function limitStream(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let total = 0;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > max) {
          await reader.cancel("response too large").catch(() => undefined);
          controller.error(new UpstreamResponseTooLargeError(max));
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}
