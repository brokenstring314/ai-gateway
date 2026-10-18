/**
 * Body limit middleware — rejects requests exceeding maxRequestBytes.
 *
 * - A valid Content-Length above the limit is rejected up front (413).
 * - A malformed Content-Length (non-numeric, negative, list) is rejected (400).
 * - Bodies without Content-Length (chunked, streamed) are read with a running
 *   byte count and rejected as soon as the limit is crossed (413), so memory
 *   use stays bounded by the limit. The buffered body is then handed to the
 *   downstream handler via a fresh Request.
 */

import type { Context, MiddlewareHandler } from "hono";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const CONTENT_LENGTH_RE = /^\d+$/;

function tooLarge(c: Context, limit: number) {
  return c.json(
    {
      error: {
        message: `Request body exceeds maximum allowed size of ${limit} bytes`,
        type: "request_too_large",
        code: "request_entity_too_large",
      },
    },
    413,
  );
}

function badContentLength(c: Context) {
  return c.json(
    {
      error: {
        message: "Invalid Content-Length header",
        type: "invalid_request_error",
        code: "invalid_content_length",
      },
    },
    400,
  );
}

/** Read at most `limit` bytes; returns null as soon as the stream exceeds it. */
async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function bodyLimitMiddleware(maxBytes?: number): MiddlewareHandler {
  const limit = maxBytes ?? DEFAULT_MAX_BYTES;

  return async function bodyLimit(c, next) {
    const raw = c.req.raw;
    const contentLength = raw.headers.get("Content-Length");
    const transferEncoding = raw.headers.get("Transfer-Encoding");

    if (contentLength !== null) {
      const trimmed = contentLength.trim();
      if (!CONTENT_LENGTH_RE.test(trimmed)) {
        return badContentLength(c);
      }
      if (Number(trimmed) > limit) {
        return tooLarge(c, limit);
      }
    }

    // Trust a valid Content-Length (the runtime enforces it) unless chunked
    // framing is also present; otherwise count bytes as they arrive.
    if (raw.body !== null && (contentLength === null || transferEncoding !== null)) {
      const body = await readBounded(raw.body, limit);
      if (body === null) {
        return tooLarge(c, limit);
      }
      const headers = new Headers(raw.headers);
      headers.delete("Transfer-Encoding");
      headers.set("Content-Length", String(body.byteLength));
      c.req.raw = new Request(raw, { body, headers });
    }

    await next();
  };
}
