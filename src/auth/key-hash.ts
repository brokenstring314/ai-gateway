import { createHash } from "node:crypto";

/**
 * Hash an API key using SHA-256.
 * Matches Go's hashKey: one round SHA-256 over the full key.
 * Keys are not user passwords — KDF adds cost without security benefit.
 */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Create a display-safe version of an API key.
 * Shows first 8 chars + "..." + last 4 chars.
 * Matches Go's displayKey format.
 */
export function displayKey(key: string): string {
  if (key.length <= 12) return key;
  return key.slice(0, 8) + "..." + key.slice(-4);
}

/**
 * Generate a new API key string with "fgw_" prefix.
 * Format: "fgw_" + 32 random bytes as hex (64 hex chars).
 * Matches Go's generateAPIKeyString.
 */
export function generateAPIKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "fgw_" + hex;
}

/**
 * Generate a unique ID in UUID v4 format.
 * Matches Go's generateID.
 */
export function generateID(): string {
  return crypto.randomUUID();
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Uses manual byte-by-byte XOR to avoid early-exit on differing bytes.
 * MUST NOT use early-exit comparison (===, !==) for key validation.
 * Returns true if strings are equal, false otherwise.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = new TextEncoder().encode(a);
  const bBuf = new TextEncoder().encode(b);
  let result = a.length ^ b.length;
  const maxLen = Math.max(aBuf.length, bBuf.length);
  for (let i = 0; i < maxLen; i++) {
    const aByte = i < aBuf.length ? aBuf[i]! : 0;
    const bByte = i < bBuf.length ? bBuf[i]! : 0;
    result |= aByte ^ bByte;
  }
  return result === 0;
}
