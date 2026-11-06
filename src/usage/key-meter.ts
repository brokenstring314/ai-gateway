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
 *  - in-flight reservations (review 2026-11-02 RB3): an admitted request
 *    holds a reservation (its estimated prompt — images, audio and files at
 *    conservative rates — plus its output ceiling, reasoning budgets
 *    included, times n) until it settles;
 *  - one request larger than the key has left (final red team 2026-11-06
 *    FQ-2): a reservation above quota − used is refused with 400
 *    request_exceeds_quota (lower max_tokens / the reasoning budget / n;
 *    never clamped), and above the key's TPM with 400 request_exceeds_tpm —
 *    a single admitted request can no longer overshoot without bound;
 *  - a new request is admitted only while used + reserved + its own
 *    reservation ≤ quota; otherwise 429 quota_in_flight (Retry-After 1 s) —
 *    the in-flight requests may use the rest. Together with the rule above,
 *    the tokens the admitted requests can spend never exceed the quota as
 *    long as the reservations hold (the estimate is conservative; the
 *    upstream's reported usage is what is counted). The same reservations
 *    count toward TPM (see below);
 *    A reservation is released exactly once when the request settles
 *    (success, error, client cancel, failover): Pipeline.finalize;
 *  - safety net for reservation leaks (RB3 follow-up): a reservation that is
 *    never settled (a code path that skips finalize) expires on its own after
 *    a TTL bound to the request lifetime — the longest a request can run
 *    (requestTimeout / server.streamMaxDurationSeconds) plus a minute; when
 *    streams are unbounded, the larger of 1 h and requestTimeout + a minute.
 *    Expired reservations are swept lazily the
 *    next time the key is admitted (no timer, no DB read); a late settle of
 *    an expired reservation still counts its tokens and releases nothing twice;
 *  - a request that was admitted always finishes — a stream is never cut
 *    for quota. Its tokens (estimated when the upstream sends no usage) are
 *    counted when it completes; when the upstream bills more than the
 *    reservation (an estimate), the key can still end up past its quota;
 *  - the quota does not refill by itself: an operator raises it or resets
 *    the usage (POST /admin/keys/:id/reset-usage).
 *
 * RPM / TPM are fixed one-minute windows per key (the window starts at the
 * key's first request in it, like the rate-limit plugin). RPM counts
 * admitted requests; TPM counts tokens of requests that completed in the
 * window and refuses new requests once the window holds ≥ TPM tokens (or,
 * with requests in flight, window tokens + reservations ≥ TPM). One request
 * may reserve at most the TPM (400 request_exceeds_tpm, FQ-2), so a window
 * can hold at most about twice the TPM.
 * A key without its own RPM falls back to the rate-limit plugin (which
 * skips keys that have one); a key without its own TPM uses the plugin's
 * maxTokensPerMinute, if set.
 */

import {
  keyRateLimited,
  quotaExhausted,
  quotaInFlight,
  quotaNotMetered,
  requestExceedsQuota,
  requestExceedsTpm,
} from "../core/errors.js";

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
  /** Tokens reserved by admitted requests still in flight (RB3): the sum of `open`. */
  reserved: number;
  /** Reservations not yet released, for the lazy TTL sweep. */
  open: Set<Reservation>;
  /** Earliest expiresAt in `open` (Infinity when empty): the sweep is skipped until then. */
  nextExpiry: number;
}

/** Reservation TTL when the request lifetime is unbounded (streams without streamMaxDurationSeconds). */
export const DEFAULT_RESERVATION_TTL_MS = 3_600_000;

/** Tokens an admitted request holds until it settles (KeyMeter.settle). */
export interface Reservation {
  readonly id: string;
  readonly tokens: number;
  /** Set once settled: a second settle is a no-op. */
  settled: boolean;
  /** When the leak sweep releases it if it was never settled (epoch ms). */
  readonly expiresAt: number;
  /** Set once its tokens left the key's reserved total (settled or expired). */
  released: boolean;
}

/** The most one request of a key may reserve (AdmitOptions.reserve). */
export interface ReservationRoom {
  /** Tokens left in the key's quota (quota − used), when it has one. */
  readonly quotaLeft?: number;
  /** The key's TPM (its own or the global one), when it has one. */
  readonly tpm?: number;
}

/** What a request reserves, and which request field to name when it is too large. */
export interface ReservationPlan {
  readonly tokens: number;
  /** The request field that sets the reservation (max_tokens, reasoning.max_tokens, n …), for the 400. */
  readonly param?: string;
  /** Explains the reservation in the 400's message ("about 120 input tokens + max_tokens 4096"). */
  readonly describe?: string;
}

export interface AdmitOptions {
  /** TPM for keys without their own (the rate-limit plugin's maxTokensPerMinute). */
  readonly globalTpm?: number;
  /** The route cannot count tokens (pass-through proxy): keys with a quota are refused. */
  readonly unmetered?: boolean;
  /**
   * Tokens to reserve for this request while it runs (estimated prompt +
   * output cap). Only called for a key with a quota or a TPM, with the most
   * this request may reserve (`room`): the quota the key has left and its
   * TPM. A request that sets no output limit gets one that fits (FQ-2); a
   * limit the client set is never lowered — a reservation above `room` is
   * refused (400 request_exceeds_quota / request_exceeds_tpm).
   */
  readonly reserve?: (room: ReservationRoom) => ReservationPlan | number;
  /**
   * How long an unsettled reservation may hold tokens before the leak sweep
   * releases it (ms; default DEFAULT_RESERVATION_TTL_MS). Pipeline passes the
   * request lifetime bound (see reservationTtlMs()).
   */
  readonly reservationTtlMs?: number;
  readonly now?: number;
}

export class KeyMeter {
  private readonly keys = new Map<string, KeyCounters>();
  /** Keys whose used tokens changed since the last drain (persisted by the recorder). */
  private readonly dirty = new Set<string>();
  /** Reservations released by the leak sweep since start (observability, tests). */
  private expiredCount = 0;

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
   * quota_not_metered (unmetered route with a quota), 429 quota_in_flight
   * (in-flight reservations hold the rest of the quota), 400
   * request_exceeds_quota / request_exceeds_tpm (this request alone is
   * larger than the quota left / the TPM, FQ-2), 429 rate_limit_exceeded
   * with Retry-After (RPM / TPM). An admitted request
   * counts toward RPM and, for a key with a quota or TPM, holds a
   * reservation that the caller must settle() exactly once.
   */
  admit(key: MeteredKey | undefined, opts: AdmitOptions = {}): Reservation | undefined {
    const id = key?.id ?? "";
    const limits = key?.limits;
    const tpm = limits?.tpm ?? opts.globalTpm;
    const quota = limits?.quotaTokens ?? null;
    // Nothing to check: do not even allocate counters.
    if (quota === null && (limits?.rpm ?? null) === null && tpm === undefined) return undefined;
    const now = opts.now ?? Date.now();
    const c = this.counters(id, key?.persistedUsed, now);
    this.sweep(id, c, now);

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
    const rpm = limits?.rpm ?? null;
    const hasTpm = tpm !== undefined && tpm !== null;
    // This request's own reservation (FQ-1 / FQ-2), before any check that uses it.
    let want = 0;
    let param = "max_tokens";
    let describe = "";
    if (quota !== null || hasTpm) {
      const room: ReservationRoom = {
        ...(quota !== null ? { quotaLeft: quota - c.used } : {}),
        ...(hasTpm ? { tpm } : {}),
      };
      const plan = opts.reserve?.(room) ?? 0;
      const raw = typeof plan === "number" ? plan : plan.tokens;
      want = Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : 0;
      if (typeof plan === "object") {
        param = plan.param ?? param;
        describe = plan.describe ?? "";
      }
    }
    const needs = describe ? ` (${describe})` : "";
    if (quota !== null) {
      const left = quota - c.used;
      if (want > left) {
        throw requestExceedsQuota(
          `This request may use up to ${want} tokens${needs}, more than this API key has left ` +
            `(${left} of ${quota} tokens). Lower ${param}${param === "n" ? "" : " (or n)"} or shorten the input; ` +
            "it is never lowered for you.",
          param,
        );
      }
      if (c.reserved > 0 && c.used + c.reserved + want > quota) {
        throw quotaInFlight(
          `This API key's requests in flight may use the rest of its token quota (${c.used} of ${quota} tokens used, ` +
            `up to ${c.reserved} more reserved, this request needs up to ${want}). Retry when they have finished.`,
        );
      }
    }
    const retryAfter = (c.minuteStart + MINUTE_MS - now) / 1000;
    if (rpm !== null && c.minuteRequests >= rpm) {
      throw keyRateLimited(`Rate limit exceeded for this API key: ${rpm} requests per minute`, retryAfter);
    }
    if (hasTpm) {
      if (want > tpm) {
        throw requestExceedsTpm(
          `This request may use up to ${want} tokens${needs}, more than this API key's limit of ${tpm} tokens ` +
            `per minute, so it can never be admitted. Lower ${param}${param === "n" ? "" : " (or n)"} or shorten the input.`,
          param,
        );
      }
      if (c.minuteTokens >= tpm) {
        throw keyRateLimited(`Rate limit exceeded for this API key: ${tpm} tokens per minute`, retryAfter);
      }
      if (c.reserved > 0 && c.minuteTokens + c.reserved >= tpm) {
        throw keyRateLimited(
          `Rate limit exceeded for this API key: ${tpm} tokens per minute (including requests in flight)`,
          1,
        );
      }
    }
    c.minuteRequests++;
    if (quota === null && !hasTpm) return undefined;
    const tokens = want;
    const ttl = opts.reservationTtlMs;
    const ttlMs = ttl !== undefined && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_RESERVATION_TTL_MS;
    const r: Reservation = { id, tokens, settled: false, expiresAt: now + ttlMs, released: tokens === 0 };
    if (tokens > 0) {
      c.reserved += tokens;
      c.open.add(r);
      if (r.expiresAt < c.nextExpiry) c.nextExpiry = r.expiresAt;
    }
    return r;
  }

  /**
   * Release an admitted request's reservation and count its actual tokens
   * (record()). Exactly once per reservation: later calls are no-ops.
   */
  settle(key: MeteredKey | undefined, reservation: Reservation | undefined, tokens: number, now = Date.now()): void {
    if (reservation) {
      if (reservation.settled) return;
      reservation.settled = true;
      this.release(reservation);
    }
    this.record(key, tokens, now);
  }

  /** Tokens currently reserved by a key's in-flight requests (0 when unknown); sweeps expired ones first. */
  reserved(id: string, now: number = Date.now()): number {
    const c = this.keys.get(id);
    if (!c) return 0;
    this.sweep(id, c, now);
    return c.reserved;
  }

  /** Reservations the leak sweep released because they were never settled (since start). */
  expiredReservations(): number {
    return this.expiredCount;
  }

  /** Take a reservation's tokens out of its key's reserved total, once (settle or sweep). */
  private release(r: Reservation): void {
    if (r.released) return;
    r.released = true;
    const c = this.keys.get(r.id);
    if (!c || !c.open.delete(r)) return;
    c.reserved = Math.max(0, c.reserved - r.tokens);
    if (c.open.size === 0) {
      c.reserved = 0;
      c.nextExpiry = Number.POSITIVE_INFINITY;
    }
  }

  /**
   * Release reservations past their TTL (leak safety net). O(1) until the
   * earliest one expires, then one pass over the key's open reservations.
   */
  private sweep(id: string, c: KeyCounters, now: number): void {
    if (now < c.nextExpiry) return;
    let next = Number.POSITIVE_INFINITY;
    let expired = 0;
    let tokens = 0;
    for (const r of c.open) {
      if (r.expiresAt <= now) {
        c.open.delete(r);
        r.released = true;
        c.reserved = Math.max(0, c.reserved - r.tokens);
        expired++;
        tokens += r.tokens;
      } else if (r.expiresAt < next) {
        next = r.expiresAt;
      }
    }
    if (c.open.size === 0) c.reserved = 0;
    c.nextExpiry = next;
    if (expired > 0) {
      this.expiredCount += expired;
      console.warn(
        `[key-meter] released ${expired} reservation(s) (${tokens} tokens) of key ${id || "(none)"} ` +
          "that were never settled (TTL expired)",
      );
    }
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

  /** Forget a key's usage (operator reset): used tokens and the current minute window (in-flight reservations stay). */
  reset(id: string): void {
    const old = this.keys.get(id);
    const c = newCounters(0);
    if (old) {
      c.reserved = old.reserved;
      c.open = old.open;
      c.nextExpiry = old.nextExpiry;
    }
    this.keys.set(id, c);
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
  return {
    used: Math.max(0, used),
    minuteStart: now,
    minuteRequests: 0,
    minuteTokens: 0,
    reserved: 0,
    open: new Set(),
    nextExpiry: Number.POSITIVE_INFINITY,
  };
}

function roll(c: KeyCounters, now: number): void {
  if (now - c.minuteStart >= MINUTE_MS) {
    c.minuteStart = now;
    c.minuteRequests = 0;
    c.minuteTokens = 0;
  }
}

/**
 * TTL of an unsettled reservation from the request lifetime bounds: the
 * longest a request may legitimately run (non-streaming: requestTimeout;
 * streaming: server.streamMaxDurationSeconds) plus a one-minute grace. When
 * streams are unbounded (0 / unset) it is the larger of that non-streaming
 * bound and DEFAULT_RESERVATION_TTL_MS (1 h), so a long requestTimeout
 * (e.g. 2 h) never lets a running request's reservation lapse early
 * (review 2026-11-05 F5).
 */
export function reservationTtlMs(requestTimeoutMs: number, streamMaxDurationMs: number): number {
  const requestBound = requestTimeoutMs > 0 ? requestTimeoutMs + 60_000 : 0;
  if (!(streamMaxDurationMs > 0)) return Math.max(DEFAULT_RESERVATION_TTL_MS, requestBound);
  return Math.max(requestTimeoutMs > 0 ? requestTimeoutMs : 0, streamMaxDurationMs) + 60_000;
}
