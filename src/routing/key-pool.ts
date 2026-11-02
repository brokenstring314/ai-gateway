/**
 * Upstream key pools (0.3.0 P4): several upstream API keys per channel.
 * A key's weight 0 drains it (never used) in every mode.
 *
 * Per channel a selection mode:
 *  - round_robin (default): rotate through the usable keys;
 *  - weighted: random, proportional to each key's weight (0 = drained);
 *  - fill_first: always the first usable key in list order, the next one
 *    only while it is unusable.
 *
 * Key health, all in memory (the hot path never reads the database):
 *  - upstream 429: the key cools down for Retry-After seconds when the
 *    upstream sent one (capped at one hour), else the channel's
 *    keyCooldownSeconds (default 30), and the request moves on to the
 *    channel's next usable key;
 *  - upstream 402: NOT a permanent disable (review 2026-11-02 C7: some
 *    upstreams answer 402 for a property of the request — OpenRouter's
 *    "requires more credits, or fewer max_tokens", or credit held by
 *    in-flight requests — so any client could otherwise take the operator's
 *    key down). The key cools down like a 429 (Retry-After capped at one
 *    hour, else keyCooldownSeconds), but the cooldown is soft: a channel
 *    whose every other key is unusable still uses a 402-cooling key rather
 *    than going down. Only DISABLE_AFTER_402 consecutive account-level 402s
 *    (no success in between, within PAYMENT_FAILURE_WINDOW_MS) disable the
 *    key (status quota); a 402 whose error names the request (max_tokens,
 *    in-flight requests) never counts toward that;
 *  - upstream 401: the key is disabled (status invalid, with the error
 *    recorded) and the request moves on to the next key; a listener
 *    (Gateway.onKeyEvent) persists a disable asynchronously and audits it.
 * Only when every key of a channel is unusable does the channel itself fail
 * (and the executor fails over to the next channel).
 *
 * State lives in a KeyStateRegistry owned by the Gateway, keyed by channel,
 * key id and key revision, so it survives config reloads; re-enabling a key
 * through the Admin API bumps its revision and starts it fresh.
 */

export type KeyStrategy = "round_robin" | "weighted" | "fill_first";

export const DEFAULT_KEY_COOLDOWN_SECONDS = 30;
export const MAX_KEY_COOLDOWN_SECONDS = 3600;
/** Consecutive account-level 402s (no success in between) that disable a key. */
export const DISABLE_AFTER_402 = 3;
/** Window in which those 402s must fall (counted from the first one). */
export const PAYMENT_FAILURE_WINDOW_MS = 60 * 60 * 1000;

/**
 * A 402 caused by the request rather than the account: OpenRouter's
 * "This request requires more credits, or fewer max_tokens …" and "… given
 * your current in-flight requests. Retry after in-flight requests settle".
 * Such a 402 never disables a key.
 */
const REQUEST_LEVEL_402 = /max[_ ]?tokens|in[- ]flight|fewer tokens|prompt is too long|requested up to/i;

export function isRequestLevel402(error: string): boolean {
  return REQUEST_LEVEL_402.test(error);
}

export interface PoolKey {
  /** Stable id (config-store key id, or a hash for keys from the config file). */
  readonly id: string;
  /** The key itself (env references already expanded). Empty: send no Authorization header. */
  readonly key: string;
  readonly weight: number;
  /** Disambiguates state across admin edits of the same key id. */
  readonly revision: string;
}

export interface KeyState {
  /** Epoch ms until which the key is cooling down after a 429 / 402. */
  cooldownUntil: number;
  /** The cooldown is a 402's: soft (used when no other key is usable). */
  softCooldown?: boolean;
  /** Consecutive account-level 402s since the last success. */
  paymentFailures?: { count: number; since: number };
  /** Set when the key was disabled after a 401/402. */
  disabled?: { status: "invalid" | "quota"; error: string; at: string };
  lastError?: string;
}

export type KeyEvent =
  | {
      readonly kind: "disabled";
      readonly channel: string;
      readonly keyId: string;
      readonly revision: string;
      readonly status: "invalid" | "quota";
      readonly httpStatus: number;
      readonly error: string;
      readonly at: string;
    }
  | {
      readonly kind: "cooldown";
      readonly channel: string;
      readonly keyId: string;
      readonly seconds: number;
      readonly at: string;
      /** Upstream status that caused it (429 rate limit, 402 payment required). */
      readonly httpStatus?: number;
    };

/** Key state across config generations (owned by the Gateway). */
export class KeyStateRegistry {
  private readonly states = new Map<string, KeyState>();
  private readonly listeners = new Set<(e: KeyEvent) => void>();

  stateFor(channel: string, key: PoolKey): KeyState {
    const id = `${channel}\u0000${key.id}\u0000${key.revision}`;
    let s = this.states.get(id);
    if (!s) {
      s = { cooldownUntil: 0 };
      this.states.set(id, s);
    }
    return s;
  }

  /** Drop state of keys no longer configured (after a reload). */
  retain(live: ReadonlySet<string>): void {
    for (const id of this.states.keys()) if (!live.has(id)) this.states.delete(id);
  }

  /** Forget every state of `keyId` on `channel` (re-enabled by an operator). */
  reset(channel: string, keyId: string): void {
    const prefix = `${channel}\u0000${keyId}\u0000`;
    for (const [id, s] of this.states) {
      if (!id.startsWith(prefix)) continue;
      // Pools hold the object itself: clear it in place.
      s.cooldownUntil = 0;
      delete s.softCooldown;
      delete s.paymentFailures;
      delete s.disabled;
      delete s.lastError;
    }
  }

  static stateId(channel: string, key: PoolKey): string {
    return `${channel}\u0000${key.id}\u0000${key.revision}`;
  }

  onEvent(listener: (e: KeyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(e: KeyEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error(`[keys] key event listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export interface Lease {
  readonly id: string;
  readonly key: string;
}

/** Thrown when a channel has no usable key right now. */
export class NoUsableKeyError extends Error {
  override name = "NoUsableKeyError";
  constructor(
    readonly channel: string,
    /** Seconds until the first cooling key is usable again; undefined when every key is disabled. */
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(
      retryAfterSeconds !== undefined
        ? `every upstream key of this channel is cooling down after rate limiting`
        : `this channel has no usable upstream key (all disabled)`,
    );
  }
}

export class KeyPool {
  private rr = 0;
  private readonly states: KeyState[];

  constructor(
    readonly channel: string,
    private readonly keys: readonly PoolKey[],
    private readonly strategy: KeyStrategy,
    private readonly cooldownSeconds: number,
    private readonly registry: KeyStateRegistry,
    private readonly now: () => number = Date.now,
  ) {
    this.states = keys.map((k) => registry.stateFor(channel, k));
  }

  get size(): number {
    return this.keys.length;
  }

  /** `soft`: a key in a 402 (soft) cooldown counts as usable. */
  private usable(i: number, t: number, exclude?: ReadonlySet<string>, soft = false): boolean {
    const k = this.keys[i]!;
    const s = this.states[i]!;
    if (exclude?.has(k.id)) return false;
    if (s.disabled) return false;
    if (s.cooldownUntil > t && !(soft && s.softCooldown)) return false;
    // Weight 0 drains a key in every mode.
    return k.weight > 0;
  }

  /** Whether any key can be used right now (no state change). */
  available(): boolean {
    const t = this.now();
    for (let i = 0; i < this.keys.length; i++) if (this.usable(i, t, undefined, true)) return true;
    return false;
  }

  /** Pick a key for one upstream call; throws NoUsableKeyError when none is usable. */
  acquire(exclude?: ReadonlySet<string>): Lease {
    const t = this.now();
    const n = this.keys.length;
    const candidates: number[] = [];
    for (let i = 0; i < n; i++) if (this.usable(i, t, exclude)) candidates.push(i);
    // Only 402-cooling keys left: use them rather than take the channel down.
    if (candidates.length === 0) for (let i = 0; i < n; i++) if (this.usable(i, t, exclude, true)) candidates.push(i);
    if (candidates.length === 0) throw this.noKey(t);
    let pick: number;
    if (this.strategy === "fill_first") {
      pick = candidates[0]!;
    } else if (this.strategy === "weighted") {
      const total = candidates.reduce((s, i) => s + this.keys[i]!.weight, 0);
      let r = Math.random() * total;
      pick = candidates[candidates.length - 1]!;
      for (const i of candidates) {
        r -= this.keys[i]!.weight;
        if (r < 0) {
          pick = i;
          break;
        }
      }
    } else {
      // Round robin over the whole list, skipping unusable keys.
      const start = this.rr % n;
      pick = candidates.find((i) => i >= start) ?? candidates[0]!;
      this.rr = (pick + 1) % n;
    }
    const k = this.keys[pick]!;
    return { id: k.id, key: k.key };
  }

  private noKey(t: number): NoUsableKeyError {
    let soonest: number | undefined;
    for (const s of this.states) {
      if (s.disabled || s.cooldownUntil <= t) continue;
      soonest = soonest === undefined ? s.cooldownUntil : Math.min(soonest, s.cooldownUntil);
    }
    return new NoUsableKeyError(
      this.channel,
      soonest === undefined ? undefined : Math.max(1, Math.ceil((soonest - t) / 1000)),
    );
  }

  private indexOf(id: string): number {
    return this.keys.findIndex((k) => k.id === id);
  }

  /**
   * Record an upstream answer for the key that sent it. Returns true when
   * the key was taken out (cooldown or disabled), i.e. another key should be
   * tried for this request.
   */
  report(id: string, httpStatus: number, retryAfter: string | null | undefined, error: string): boolean {
    const i = this.indexOf(id);
    if (i < 0) return false;
    const s = this.states[i]!;
    const at = new Date(this.now()).toISOString();
    if (httpStatus === 402 && !s.disabled) {
      const t = this.now();
      if (!isRequestLevel402(error)) {
        const pf = s.paymentFailures;
        s.paymentFailures =
          pf && t - pf.since <= PAYMENT_FAILURE_WINDOW_MS
            ? { count: pf.count + 1, since: pf.since }
            : { count: 1, since: t };
      }
      if ((s.paymentFailures?.count ?? 0) < DISABLE_AFTER_402) {
        const capped = this.cooldown(s, retryAfter, error, true);
        this.registry.emit({ kind: "cooldown", channel: this.channel, keyId: id, seconds: capped, at, httpStatus });
        return true;
      }
      // DISABLE_AFTER_402 consecutive account-level 402s: out of credit.
    }
    if (httpStatus === 429) {
      const capped = this.cooldown(s, retryAfter, error, false);
      this.registry.emit({ kind: "cooldown", channel: this.channel, keyId: id, seconds: capped, at, httpStatus });
      return true;
    }
    if (httpStatus === 401 || httpStatus === 402) {
      if (s.disabled) return true;
      const status = httpStatus === 401 ? "invalid" : "quota";
      s.disabled = { status, error, at };
      s.lastError = error;
      this.registry.emit({
        kind: "disabled",
        channel: this.channel,
        keyId: id,
        revision: this.keys[i]!.revision,
        status,
        httpStatus,
        error,
        at,
      });
      return true;
    }
    return false;
  }

  /** Cool a key down for Retry-After (else the channel's default), capped; returns the seconds. */
  private cooldown(s: KeyState, retryAfter: string | null | undefined, error: string, soft: boolean): number {
    const t = this.now();
    const seconds = parseRetryAfter(retryAfter, t) ?? this.cooldownSeconds;
    const capped = Math.min(MAX_KEY_COOLDOWN_SECONDS, Math.max(1, seconds));
    const until = t + capped * 1000;
    // A soft (402) cooldown never shortens or softens a running 429 cooldown.
    if (soft && s.cooldownUntil > t && !s.softCooldown) {
      s.cooldownUntil = Math.max(s.cooldownUntil, until);
    } else {
      s.cooldownUntil = until;
      s.softCooldown = soft;
    }
    s.lastError = error;
    return capped;
  }

  /**
   * An upstream call with this key succeeded: ends its run of 402s (and a
   * soft cooldown, since the key evidently has credit).
   */
  reportSuccess(id: string): void {
    const i = this.indexOf(id);
    if (i < 0) return;
    const s = this.states[i]!;
    if (s.paymentFailures) delete s.paymentFailures;
    if (s.softCooldown) {
      s.cooldownUntil = 0;
      delete s.softCooldown;
    }
  }

  /** Per-key runtime state (for the Admin API). */
  snapshot(): Array<{ id: string; cooldownUntil?: string; disabled?: KeyState["disabled"] }> {
    const t = this.now();
    return this.keys.map((k, i) => {
      const s = this.states[i]!;
      return {
        id: k.id,
        ...(s.cooldownUntil > t ? { cooldownUntil: new Date(s.cooldownUntil).toISOString() } : {}),
        ...(s.disabled ? { disabled: s.disabled } : {}),
      };
    });
  }
}

/** Retry-After as seconds (delta-seconds or HTTP date); undefined when absent or unparsable. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value.trim();
  if (v === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.ceil(Number(v));
  const date = Date.parse(v);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

/** A short, secret-free description of an upstream error for key status / audit. */
export function keyErrorText(status: number, message: string, key: string): string {
  let text = `${status}: ${message}`;
  if (key.length >= 6) text = text.split(key).join("[key]");
  // Some upstreams echo a masked key ("sk-abc***xyz"); drop anything key-like.
  text = text.replace(/\b(sk|pk|rk|key)[-_][A-Za-z0-9_*.-]{6,}/gi, "[key]");
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}
