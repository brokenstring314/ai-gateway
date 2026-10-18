/**
 * Bootstrap admin keys (ADMIN_BOOTSTRAP_KEY / ADMIN_BOOTSTRAP_READ_ONLY_KEY).
 *
 * They exist only to get a fresh install to its first real admin credential.
 * They are accepted while NO real admin credential exists and are refused as
 * soon as any of these holds:
 *   - the key store's bootstrap latch is set: an admin-scoped key has existed
 *     at some point (created through the bootstrap key or otherwise). The
 *     latch is one-way, so revoking, expiring or deleting every admin key
 *     does NOT re-enable the bootstrap keys; recover with
 *     `ai-gateway keys create --admin -c <config>` instead;
 *   - an admin secret (adminSecret) is configured;
 *   - static client keys (auth.keys) are configured.
 * They are never accepted without a key store.
 *
 * The state is evaluated on every check (keys can be created at runtime, also
 * by the CLI in another process) and every transition is logged once.
 */

import { timingSafeEqual } from "@/auth/key-hash";
import type { KeyStore } from "@/persistence/key-store";

const SCOPE_ADMIN = "admin";
const SCOPE_READ_ONLY = "read_only";

export interface BootstrapGateOptions {
  bootstrapKey?: string;
  bootstrapReadOnlyKey?: string;
  keyStore?: Pick<KeyStore, "bootstrapLatchedAt">;
  adminSecret?: () => string | undefined;
  configKeys?: () => readonly unknown[] | undefined;
  log?: (message: string) => void;
}

export interface BootstrapGate {
  /** Scopes granted if `token` is an active bootstrap key, else undefined. */
  match(token: string): string[] | undefined;
  /** Why bootstrap keys are refused right now, or undefined while they are accepted. */
  disabledReason(): string | undefined;
  /** True when at least one bootstrap key is set in the environment. */
  readonly configured: boolean;
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

const LATCHED_PREFIX = "bootstrap latch is set";

export function createBootstrapGate(opts: BootstrapGateOptions): BootstrapGate {
  const bootstrapKey = nonEmpty(opts.bootstrapKey) ? opts.bootstrapKey : undefined;
  const bootstrapReadOnlyKey = nonEmpty(opts.bootstrapReadOnlyKey) ? opts.bootstrapReadOnlyKey : undefined;
  const configured = bootstrapKey !== undefined || bootstrapReadOnlyKey !== undefined;
  const log = opts.log ?? ((message: string) => console.warn(message));
  let lastReason: string | undefined | null = null; // null = not evaluated yet

  function computeReason(): string | undefined {
    if (opts.keyStore === undefined) return "no API key store";
    if (nonEmpty(opts.adminSecret?.())) return "adminSecret is configured";
    if ((opts.configKeys?.() ?? []).some((k) => typeof k === "string" && k !== "")) {
      return "auth.keys are configured";
    }
    const latchedAt = opts.keyStore.bootstrapLatchedAt();
    if (latchedAt !== null) {
      return `${LATCHED_PREFIX} (the first admin key was created at ${latchedAt.toISOString()})`;
    }
    return undefined;
  }

  function disabledReason(): string | undefined {
    const reason = computeReason();
    if (configured && reason !== lastReason) {
      if (reason?.startsWith(LATCHED_PREFIX)) {
        log(
          `[auth] ADMIN_BOOTSTRAP_KEY / ADMIN_BOOTSTRAP_READ_ONLY_KEY permanently disabled: ${reason}. ` +
            "Bootstrap keys are refused from now on, even if every admin key is later revoked or expires; " +
            "remove them from the environment. To recover admin access run " +
            "`ai-gateway keys create --admin -c <config>` on the gateway host.",
        );
      } else if (reason !== undefined) {
        log(
          `[auth] ADMIN_BOOTSTRAP_KEY / ADMIN_BOOTSTRAP_READ_ONLY_KEY disabled: ${reason}. ` +
            "Bootstrap keys are refused; remove them from the environment.",
        );
      } else if (lastReason !== null) {
        log(
          "[auth] ADMIN_BOOTSTRAP_KEY / ADMIN_BOOTSTRAP_READ_ONLY_KEY re-enabled: no admin credential exists " +
            "(no admin key has been created in the store, no adminSecret, no auth.keys).",
        );
      }
      lastReason = reason;
    }
    return reason;
  }

  return {
    configured,
    disabledReason,

    match(token: string): string[] | undefined {
      if (!configured) return undefined;
      // Compare both before deciding, so timing does not reveal which one matched.
      const isAdmin = bootstrapKey !== undefined && timingSafeEqual(token, bootstrapKey);
      const isReadOnly = bootstrapReadOnlyKey !== undefined && timingSafeEqual(token, bootstrapReadOnlyKey);
      if (!isAdmin && !isReadOnly) return undefined;
      if (disabledReason() !== undefined) return undefined;
      return isAdmin ? [SCOPE_ADMIN] : [SCOPE_READ_ONLY];
    },
  };
}
