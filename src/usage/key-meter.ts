/**
 * Per-key limits on the request path (0.3.0 P5, plan §3.6): token quota,
 * requests per minute (RPM) and tokens per minute (TPM).
 *
 * Everything here is in memory: admission and accounting never touch the
 * database. The meter lives on the Gateway, outside the runtime snapshots,
 * so a config reload never resets a counter. Used-token counters are
 * persisted asynchronously (usage/recorder.ts → KeyStore.saveUsedTokens)
 * and restored from the key store at startup.
 *
 * Quota semantics (user decision, 2026-11-02):
 *  - a request is refused before it starts when the key has already used
 *    its quota (used ≥ quota): 403 quota_exhausted;
 *  - a request that was admitted always finishes — a stream is never cut
 *    for quota. Its tokens (estimated when the upstream sends no usage) are
 *    counted when it completes, so the last request(s), and requests that
 *    were already in flight, may take the key past its quota;
 *  - the quota does not refill by itself: an operator raises it or resets
 *    the usage (POST /admin/keys/:id/reset-usage).
 *
 * RPM / TPM are fixed one-minute windows per key (the window starts at the
 * key's first request in it, like the rate-limit plugin). RPM counts
 * admitted requests; TPM counts tokens of requests that completed in the
 * window and refuses new requests once the window holds ≥ TPM tokens.
 * A key without its own RPM falls back to the rate-limit plugin (which
 * skips keys that have one); a key without its own TPM uses the plugin's
 * maxTokensPerMinute, if set.
 */

import { keyRateLimited, quotaExhausted, quotaNotMetered } from "../core/errors.js";

const MINUTE_MS = 60_000;

/** The limits of the key a request authenticated with; null = no own limit. */
export interface MeteredKeyLimits {
  readonly quotaTokens: number | null;
  readonly rpm: number | null;
  readonly tpm: number | null;
}

/** Who a request is metered as: a key-store key (its id and limits) or another credential (id only). */
export interface MeteredKey {
  /** Key-store id, `cfg_…` for a config auth key, absent for unauthenticated callers. */
  readonly id: string;
  readonly limits?: MeteredKeyLimits;
  /**
   * Used tokens as persisted in the key store (read with the key at auth
   * time). Only used the first time the meter sees the key, e.g. a key
   * created by the CLI after startup; the in-memory counter wins afterwards.
   */
  readonly persistedUsed?: number;
}

interface KeyCounters {
  used: number;
  minuteStart: number;
  minuteRequests: number;
  minuteTokens: number;
}

export interface AdmitOptions {
  /** TPM for keys without their own (the rate-limit plugin's maxTokensPerMinute). */
  readonly globalTpm?: number;
  /** The route cannot count tokens (pass-through proxy): keys with a quota are refused. */
  readonly unmetered?: boolean;
  readonly now?: number;
}

export class KeyMeter {
  private readonly keys = new Map<string, KeyCounters>();
  /** Keys whose used tokens changed since the last drain (persisted by the recorder). */
  private readonly dirty = new Set<string>();

  /**
   * Restore persisted used-token counters (startup). Keys the meter already
   * counts keep their live value.
   */
  restore(entries: Iterable<readonly [id: string, used: number]>): void {
    for (const [id, used] of entries) {
      if (!this.keys.has(id)) this.keys.set(id, newCounters(used));
    }
  }

  /**
   * Admit a request or throw: 403 quota_exhausted (quota used up), 403
   * quota_not_metered (unmetered route with a quota), 429 rate_limit_exceeded
   * with Retry-After (RPM / TPM). An admitted request counts toward RPM.
   */
  admit(key: MeteredKey | undefined, opts: AdmitOptions = {}): void {
    const id = key?.id ?? "";
    const limits = key?.limits;
    const tpm = limits?.tpm ?? opts.globalTpm;
    const quota = limits?.quotaTokens ?? null;
    // Nothing to check: do not even allocate counters.
    if (quota === null && (limits?.rpm ?? null) === null && tpm === undefined) return;
    const now = opts.now ?? Date.now();
    const c = this.counters(id, key?.persistedUsed, now);

    if (quota !== null) {
      if (opts.unmetered === true) {
        throw quotaNotMetered(
          "This API key has a token quota, and this route's usage cannot be counted in tokens " +
            "(image generation, pass-through routes). Use /v1/chat/completions, /v1/completions or /v1/embeddings.",
        );
      }
      if (c.used >= quota) {
        throw quotaExhausted(
          `This API key has used its token quota (${c.used} of ${quota} tokens). ` +
            "The quota does not refill by itself: ask the gateway owner to raise it or reset the usage.",
        );
      }
    }
    roll(c, now);
    const retryAfter = (c.minuteStart + MINUTE_MS - now) / 1000;
    const rpm = limits?.rpm ?? null;
    if (rpm !== null && c.minuteRequests >= rpm) {
      throw keyRateLimited(`Rate limit exceeded for this API key: ${rpm} requests per minute`, retryAfter);
    }
    if (tpm !== undefined && tpm !== null && c.minuteTokens >= tpm) {
      throw keyRateLimited(`Rate limit exceeded for this API key: ${tpm} tokens per minute`, retryAfter);
    }
    c.minuteRequests++;
  }

  /**
   * Count the tokens of a finished request (prompt + completion, estimated
   * when the upstream sent no usage) toward the key's quota and TPM window.
   * Never throws and never refuses: the request already ran.
   */
  record(key: MeteredKey | undefined, tokens: number, now: number = Date.now()): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const id = key?.id ?? "";
    const c = this.counters(id, key?.persistedUsed, now);
    roll(c, now);
    c.minuteTokens += tokens;
    if (id !== "") {
      c.used += tokens;
      this.dirty.add(id);
    }
  }

  /** Live used tokens of a key; undefined when the meter has not seen it. */
  used(id: string): number | undefined {
    return this.keys.get(id)?.used;
  }

  /** Forget a key's usage (operator reset): used tokens and the current minute window. */
  reset(id: string): void {
    this.keys.set(id, newCounters(0));
    this.dirty.delete(id);
  }

  /** Forget a deleted key entirely. */
  forget(id: string): void {
    this.keys.delete(id);
    this.dirty.delete(id);
  }

  /** Used tokens changed since the last call (absolute values), for persistence. */
  drainDirty(): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    for (const id of this.dirty) {
      const c = this.keys.get(id);
      if (c) out.push([id, c.used]);
    }
    this.dirty.clear();
    return out;
  }

  /** Put entries back after a failed persist so the next flush retries them. */
  markDirty(ids: Iterable<string>): void {
    for (const id of ids) if (this.keys.has(id)) this.dirty.add(id);
  }

  private counters(id: string, persistedUsed: number | undefined, now: number): KeyCounters {
    let c = this.keys.get(id);
    if (!c) {
      c = newCounters(id !== "" && persistedUsed !== undefined && persistedUsed > 0 ? persistedUsed : 0, now);
      this.keys.set(id, c);
    }
    return c;
  }
}

function newCounters(used: number, now = 0): KeyCounters {
  return { used: Math.max(0, used), minuteStart: now, minuteRequests: 0, minuteTokens: 0 };
}

function roll(c: KeyCounters, now: number): void {
  if (now - c.minuteStart >= MINUTE_MS) {
    c.minuteStart = now;
    c.minuteRequests = 0;
    c.minuteTokens = 0;
  }
}
