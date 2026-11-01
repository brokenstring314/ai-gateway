/**
 * Encryption at rest for upstream API keys (0.3.0, plan §3.7 / §9.5).
 *
 * - Master key: GATEWAY_SECRET_KEY, at least 32 random bytes given as
 *   base64 / base64url or hex. It never touches the database.
 * - Data key: HKDF-SHA256(master, salt = "ai-gateway/secret-box", info = "v1")
 *   → AES-256-GCM. The master key is never used to encrypt directly.
 * - Each encryption draws a fresh random 96-bit nonce, and binds the caller's
 *   context (e.g. "channel_key:<channel id>") as AES-GCM additional data, so a
 *   ciphertext copied to another row fails to decrypt.
 * - Envelope: "v1.<kid>.<nonce b64url>.<ciphertext+tag b64url>". `kid` names
 *   the master key (first 8 bytes of SHA-256 over a derived id key), so a
 *   rotation can keep the previous key around for decryption
 *   (GATEWAY_SECRET_KEY_PREVIOUS) and re-encrypt lazily.
 *
 * Only WebCrypto primitives; nothing hand-rolled.
 */

const VERSION = "v1";
const SALT = new TextEncoder().encode("ai-gateway/secret-box");
const MIN_KEY_BYTES = 32;

export class SecretKeyError extends Error {
  override name = "SecretKeyError";
}

/** Decryption failed: wrong key, tampered data, or a ciphertext moved to another row. */
export class SecretDecryptError extends Error {
  override name = "SecretDecryptError";
}

export const SECRET_KEY_HELP =
  "Generate one with `openssl rand -base64 32` and set it as GATEWAY_SECRET_KEY. " +
  "Keep it safe: without it the stored upstream keys cannot be decrypted.";

/** Decode a master key from base64 / base64url / hex; throws SecretKeyError when too short or malformed. */
export function decodeMasterKey(raw: string, varName = "GATEWAY_SECRET_KEY"): Uint8Array {
  const text = raw.trim();
  let bytes: Uint8Array | undefined;
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0 && text.length >= MIN_KEY_BYTES * 2) {
    bytes = Uint8Array.from(text.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
  } else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    try {
      bytes = Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    } catch {
      bytes = undefined;
    }
  }
  if (!bytes) throw new SecretKeyError(`${varName} must be base64 or hex. ${SECRET_KEY_HELP}`);
  if (bytes.length < MIN_KEY_BYTES) {
    throw new SecretKeyError(
      `${varName} must decode to at least ${MIN_KEY_BYTES} bytes (got ${bytes.length}). ${SECRET_KEY_HELP}`,
    );
  }
  return bytes;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
}

interface KeyEntry {
  readonly kid: string;
  readonly key: CryptoKey;
}

async function deriveEntry(master: Uint8Array): Promise<KeyEntry> {
  const ikm = await crypto.subtle.importKey("raw", new Uint8Array(master), "HKDF", false, ["deriveKey", "deriveBits"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(`${VERSION}/aes-gcm`) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const idBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(`${VERSION}/kid`) },
    ikm,
    256,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", idBits));
  const kid = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  return { kid, key };
}

export class SecretBox {
  private constructor(
    private readonly current: KeyEntry,
    private readonly byKid: ReadonlyMap<string, KeyEntry>,
  ) {}

  /** Build from the current master key and any previous ones (still accepted for decryption). */
  static async create(master: Uint8Array, previous: readonly Uint8Array[] = []): Promise<SecretBox> {
    const current = await deriveEntry(master);
    const byKid = new Map<string, KeyEntry>([[current.kid, current]]);
    for (const old of previous) {
      const entry = await deriveEntry(old);
      if (!byKid.has(entry.kid)) byKid.set(entry.kid, entry);
    }
    return new SecretBox(current, byKid);
  }

  /**
   * From GATEWAY_SECRET_KEY (+ optional GATEWAY_SECRET_KEY_PREVIOUS,
   * comma-separated). Returns undefined when GATEWAY_SECRET_KEY is unset;
   * throws SecretKeyError when it is set but unusable.
   */
  static async fromEnv(env: Record<string, string | undefined> = process.env): Promise<SecretBox | undefined> {
    const raw = env["GATEWAY_SECRET_KEY"];
    if (raw === undefined || raw.trim() === "") return undefined;
    const master = decodeMasterKey(raw);
    const previous = (env["GATEWAY_SECRET_KEY_PREVIOUS"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map((s) => decodeMasterKey(s, "GATEWAY_SECRET_KEY_PREVIOUS"));
    return SecretBox.create(master, previous);
  }

  /** Id of the current master key (recorded with each ciphertext). */
  get kid(): string {
    return this.current.kid;
  }

  async encrypt(plaintext: string, context: string): Promise<string> {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(context) },
      this.current.key,
      new TextEncoder().encode(plaintext),
    );
    return `${VERSION}.${this.current.kid}.${b64url(nonce)}.${b64url(new Uint8Array(ct))}`;
  }

  async decrypt(envelope: string, context: string): Promise<string> {
    const parts = envelope.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretDecryptError("unrecognized ciphertext format");
    const entry = this.byKid.get(parts[1] ?? "");
    if (!entry) {
      throw new SecretDecryptError(
        `ciphertext was made with master key ${parts[1]}, which is not GATEWAY_SECRET_KEY or GATEWAY_SECRET_KEY_PREVIOUS`,
      );
    }
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64url(parts[2] ?? ""), additionalData: new TextEncoder().encode(context) },
        entry.key,
        new Uint8Array(fromB64url(parts[3] ?? "")),
      );
      return new TextDecoder().decode(pt);
    } catch {
      throw new SecretDecryptError("decryption failed (tampered data or ciphertext from another record)");
    }
  }

  /** Whether `envelope` was made with an older master key (re-encrypt it). */
  isStale(envelope: string): boolean {
    return envelope.split(".")[1] !== this.current.kid;
  }
}

/** "sk-…abcd": enough to recognize a key, never enough to use it. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "****";
  const prefix = secret.match(/^[A-Za-z]{1,4}-/)?.[0] ?? "";
  return `${prefix}…${secret.slice(-4)}`;
}
