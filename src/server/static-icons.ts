/**
 * Icons browsers request on their own (B5, UI test 2026-11-05: every console
 * page load logged a 401 for /favicon.ico). Public — an icon carries no
 * data — and served before the client-key / admin auth.
 */

import type { Hono } from "hono";

/** Paths answered with the gateway icon (the console lives under /admin/dashboard). */
export const STATIC_ICON_PATHS: readonly string[] = [
  "/favicon.ico",
  "/admin/favicon.ico",
  "/admin/dashboard/favicon.ico",
];

let faviconBytes: Uint8Array | undefined;

/**
 * A 16×16 32-bit ICO drawn in code (no binary file in the repo): a rounded
 * indigo square with a white diamond. 1,150 bytes.
 */
export function favicon(): Uint8Array {
  if (faviconBytes) return faviconBytes;
  const size = 16;
  const pixels = size * size * 4;
  const mask = size * 4; // 1-bit AND mask, rows padded to 32 bits: all 0 (alpha decides)
  const image = 40 + pixels + mask;
  const buf = new Uint8Array(6 + 16 + image);
  const v = new DataView(buf.buffer);
  v.setUint16(2, 1, true); // type: icon
  v.setUint16(4, 1, true); // one image
  buf[6] = size;
  buf[7] = size;
  v.setUint16(10, 1, true); // planes
  v.setUint16(12, 32, true); // bits per pixel
  v.setUint32(14, image, true);
  v.setUint32(18, 22, true); // offset of the image
  const h = 22;
  v.setUint32(h, 40, true); // BITMAPINFOHEADER
  v.setInt32(h + 4, size, true);
  v.setInt32(h + 8, size * 2, true); // XOR + AND masks
  v.setUint16(h + 12, 1, true);
  v.setUint16(h + 14, 32, true);
  v.setUint32(h + 20, pixels + mask, true);
  for (let row = 0; row < size; row++) {
    const y = size - 1 - row; // rows are stored bottom-up
    for (let x = 0; x < size; x++) {
      const o = h + 40 + (row * size + x) * 4;
      const corner = (x === 0 || x === size - 1) && (y === 0 || y === size - 1);
      const diamond = Math.abs(x - 7.5) + Math.abs(y - 7.5) <= 4;
      const [r, g, b, a] = corner ? [0, 0, 0, 0] : diamond ? [255, 255, 255, 255] : [79, 70, 229, 255];
      buf[o] = b;
      buf[o + 1] = g;
      buf[o + 2] = r;
      buf[o + 3] = a;
    }
  }
  faviconBytes = buf;
  return buf;
}

/** Register the icon routes (call before the console and /admin routes). */
export function registerStaticIcons(app: Hono<never>): void {
  const r = app as unknown as Hono;
  for (const path of STATIC_ICON_PATHS) {
    r.get(
      path,
      () =>
        new Response(favicon(), {
          headers: {
            "Content-Type": "image/x-icon",
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff",
          },
        }),
    );
  }
}
