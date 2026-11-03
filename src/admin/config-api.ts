/**
 * Runtime-config Admin API (0.3.0 P4, plan §4): channels and their upstream
 * keys, published models and bindings, routing settings, config versions
 * with rollback, the audit log and provider presets — all JSON under /admin.
 *
 * Reads (any admin or read_only credential) come straight from the config
 * store; they never touch the request path.
 *
 * Every write:
 *  - needs the admin scope and passes the CSRF guard (admin/guards.ts);
 *  - is strictly validated (unknown fields → 400);
 *  - on an existing resource needs If-Match with its revision (missing →
 *    428, stale → 409); revisions are the config version that last changed
 *    the resource, so they only ever grow (rollback included);
 *  - runs in one SQLite transaction: resource rows → config version
 *    snapshot (key ciphertext only) → audit row → the new runtime is built
 *    with the full startup validation and swapped in (Gateway.reload) →
 *    commit. A build failure rolls everything back: 422 with the reason,
 *    the running config is untouched;
 *  - is preceded by an online database backup (newest few kept).
 * With runtimeConfig.source: file there is no store: reads show the file's
 * config, writes answer 403 config_read_only.
 *
 * Upstream keys are never returned (hint only: "sk-…abcd"). Base URLs
 * written here must be public internet addresses (security/url-guard.ts).
 */

import type { Context, Hono } from "hono";
import { z } from "zod";
import { composeConfig } from "../config/runtime-source.js";
import type { GatewayConfig, TargetConfig } from "../config/types.js";
import { knownUpstreamModels } from "../core/model-presets.js";
import {
  baseURLProblem,
  getPreset,
  PROVIDER_PRESETS,
  presetId,
  resolveBaseURL,
  targetKeyEntries,
} from "../core/provider-presets.js";
import type { Gateway } from "../gateway.js";
import {
  ConfigConflictError,
  ConfigNotFoundError,
  type ChannelView,
  type ConfigStore,
  ConfigStoreError,
  type MutationMeta,
  type ModelView,
  newId,
  type PreparedKey,
} from "../persistence/config-store.js";
import { expandEnvRefs } from "../config/envref.js";
import { keyErrorText } from "../routing/key-pool.js";
import { maskSecret } from "../secrets/secret-box.js";
import {
  assertPublicUrl,
  type HostResolver,
  limitedFetch,
  PublicHostGuard,
  systemResolver,
  UnsafeUrlError,
} from "../security/url-guard.js";
import {
  type BindingInput,
  BindingsPutSchema,
  ChannelCreateSchema,
  ChannelPatchSchema,
  ChannelTestSchema,
  KeyPatchSchema,
  KeysAddSchema,
  ModelCreateSchema,
  ModelPatchSchema,
  SettingsPatchSchema,
} from "./config-schemas.js";
import { isSensitiveConfigKey, scrubUrl } from "./config-scrub.js";
import { actorOf, adminError, csrfGuard, etag, parseIfMatch, WindowLimiter } from "./guards.js";
import { requireScope, SCOPE_ADMIN } from "./key-handlers.js";

export interface RuntimeConfigApiOptions {
  readonly gateway: Gateway;
  /** The config store (runtimeConfig.source: database); absent → read-only (file source). */
  readonly store?: ConfigStore;
  /** DNS resolver for the base URL checks (tests inject one). */
  readonly resolver?: HostResolver;
  /** Database backups before each change. */
  readonly backups?: { readonly keep?: number; readonly minIntervalMs?: number };
  /** Channel test / fetch-models limits. */
  readonly probe?: {
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
    readonly perActorPerMinute?: number;
    readonly globalPerMinute?: number;
  };
  /** Origins (besides the server's own) allowed to send admin writes: config.cors.origins. */
  readonly allowedOrigins?: () => readonly string[] | undefined;
}

/** The new runtime could not be built: 422, nothing written. */
class BuildError extends Error {
  override name = "BuildError";
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const MAX_MODELS_FETCHED = 5000;

type BalanceInfo = { available?: boolean; balances: Array<{ currency: string; total: string }> };

function balanceString(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) && v.length <= 32) return v;
  return undefined;
}

/**
 * Providers whose account balance can be read with the channel's key
 * (informational, so the owner knows when to top up). Keyed by preset id.
 */
export const BALANCE_ENDPOINTS: Record<
  string,
  { url: (base: string) => string; parse: (body: unknown) => BalanceInfo | undefined }
> = {
  // GET https://api.deepseek.com/user/balance → { is_available, balance_infos: [{ currency, total_balance, … }] }
  deepseek: {
    url: (base) => `${new URL(base).origin}/user/balance`,
    parse: (body) => {
      const b = body as { is_available?: unknown; balance_infos?: unknown };
      if (!b || typeof b !== "object" || !Array.isArray(b.balance_infos)) return undefined;
      const balances = b.balance_infos.slice(0, 10).flatMap((i: unknown) => {
        const r = i as { currency?: unknown; total_balance?: unknown };
        const total = balanceString(r?.total_balance);
        return typeof r?.currency === "string" && r.currency.length <= 8 && total !== undefined
          ? [{ currency: r.currency, total }]
          : [];
      });
      return { ...(typeof b.is_available === "boolean" ? { available: b.is_available } : {}), balances };
    },
  },
  // GET https://openrouter.ai/api/v1/credits → { data: { total_credits, total_usage } } (USD)
  openrouter: {
    url: (base) => `${base}/credits`,
    parse: (body) => {
      const d = (body as { data?: { total_credits?: unknown; total_usage?: unknown } })?.data;
      if (!d || typeof d.total_credits !== "number" || typeof d.total_usage !== "number") return undefined;
      const left = Math.round((d.total_credits - d.total_usage) * 10_000) / 10_000;
      return { available: left > 0, balances: [{ currency: "USD", total: String(left) }] };
    },
  },
};

function zodMessage(err: z.ZodError): string {
  return z.prettifyError(err);
}

async function readBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON");
  }
}

async function parseBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await readBody(c));
  if (!parsed.success) {
    // `fields` lets the console put each message next to its input.
    throw new HttpError(400, "invalid_request", zodMessage(parsed.error), {
      fields: parsed.error.issues.slice(0, 50).map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    });
  }
  return parsed.data;
}

function requireIfMatch(c: Context): number {
  const v = parseIfMatch(c.req.header("If-Match"));
  if (v === undefined) {
    throw new HttpError(
      428,
      "precondition_required",
      "This write needs an If-Match header with the resource's current revision (its ETag); GET it first",
    );
  }
  if (Number.isNaN(v)) throw new HttpError(400, "invalid_if_match", 'If-Match must be a revision such as "12"');
  return v;
}

function errorResponse(c: Context, err: unknown) {
  if (err instanceof HttpError) return adminError(c, err.status, err.code, err.message, err.extra);
  if (err instanceof ConfigNotFoundError) return adminError(c, 404, "not_found", err.message);
  if (err instanceof ConfigConflictError) {
    return adminError(
      c,
      409,
      err.code,
      err.message,
      err.currentRevision !== undefined ? { currentRevision: err.currentRevision } : {},
    );
  }
  if (err instanceof BuildError) {
    return adminError(c, 422, "config_invalid", `The change was not applied: ${err.message}`);
  }
  if (err instanceof UnsafeUrlError) {
    // Placed on the form field by the console (it only ever comes from a base URL).
    return adminError(c, 422, "unsafe_base_url", err.message, { fields: [{ path: "baseURL", message: err.message }] });
  }
  if (err instanceof ConfigStoreError) return adminError(c, 422, "config_invalid", err.message);
  console.error(`[admin] config write failed: ${err instanceof Error ? err.stack : String(err)}`);
  return adminError(c, 500, "internal_error", "Internal error; the change was not applied");
}

/** A base URL must not carry a credential in its query (it would show in listings and logs). */
function assertNoQueryCredential(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return; // reported by the URL checks
  }
  for (const name of parsed.searchParams.keys()) {
    if (isSensitiveConfigKey(name) || /^(sig|signature|code|pwd|pass|session|jwt|bearer)$/i.test(name)) {
      const message = `baseURL must not carry a credential in its query ("${name}"); add the key as a channel key`;
      throw new HttpError(422, "unsafe_base_url", message, { fields: [{ path: "baseURL", message }] });
    }
  }
}

function presetOrThrow(preset: string, baseURL: string | null | undefined, name: string): void {
  const problem = baseURLProblem({ name, provider: preset, baseURL: baseURL ?? undefined });
  if (problem) throw new HttpError(422, "config_invalid", problem);
}

/** The URL a channel will call: its own, else its preset's default. */
/** Scheme + host + port of a URL (the raw text when it does not parse; undefined stays undefined). */
function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return url;
  }
}

function effectiveBaseURL(preset: string, baseURL: string | null | undefined): string | undefined {
  if (baseURL) return baseURL;
  return getPreset(preset)?.baseURL;
}

export function registerRuntimeConfigApi(app: Hono<never>, opts: RuntimeConfigApiOptions): void {
  const { gateway, store } = opts;
  const resolver = opts.resolver ?? systemResolver;
  const probeGuard = new PublicHostGuard(resolver, 5_000);
  const probeTimeout = opts.probe?.timeoutMs ?? 10_000;
  const probeMaxBytes = opts.probe?.maxBytes ?? 2 * 1024 * 1024;
  const perActor = new WindowLimiter(opts.probe?.perActorPerMinute ?? 10, 60_000);
  const globalProbe = new WindowLimiter(opts.probe?.globalPerMinute ?? 30, 60_000);
  const backupKeep = opts.backups?.keep ?? 5;
  const backupInterval = opts.backups?.minIntervalMs ?? 0;
  const r = app as unknown as Hono;

  const write = [requireScope(SCOPE_ADMIN), csrfGuard({ allowedOrigins: opts.allowedOrigins })] as const;

  /** The store, or 403 when the runtime config is read-only (file source). */
  const writable = (): ConfigStore => {
    if (!store) {
      throw new HttpError(
        403,
        "config_read_only",
        "The runtime config is read-only (runtimeConfig.source: file): edit the config file and restart, " +
          "or switch to runtimeConfig.source: database",
      );
    }
    return store;
  };

  /**
   * One change: backup, then the store's transaction with the runtime build
   * and swap as its last step. If the commit itself fails after the swap,
   * the previous runtime is swapped back.
   */
  function commit<T>(
    s: ConfigStore,
    meta: MutationMeta,
    fn: (version: number, now: string) => T,
    cacheKeys: readonly PreparedKey[] = [],
  ): { result: T; version: number } {
    s.backup(backupKeep, backupInterval);
    const previous = gateway.currentSnapshot().config;
    let swapped = false;
    try {
      const out = s.mutate(
        meta,
        fn,
        (runtime) => {
          let next: GatewayConfig;
          try {
            next = composeConfig(gateway.getConfig() as GatewayConfig, runtime);
          } catch (err) {
            throw new BuildError(
              err instanceof Error ? err.message.replace(/^stored runtime config is invalid:\n?/, "") : String(err),
            );
          }
          try {
            gateway.reload(next);
          } catch (err) {
            throw new BuildError(err instanceof Error ? err.message : String(err));
          }
          swapped = true;
        },
        cacheKeys,
      );
      return { result: out.result, version: out.version.version };
    } catch (err) {
      if (swapped) {
        try {
          gateway.reload(previous);
        } catch (restoreErr) {
          console.error("[admin] could not restore the previous runtime after a failed commit:", restoreErr);
        }
      }
      throw err;
    }
  }

  const handle =
    (fn: (c: Context) => Promise<Response> | Response) =>
    async (c: Context): Promise<Response> => {
      try {
        return await fn(c);
      } catch (err) {
        return errorResponse(c, err);
      }
    };

  // ── Views ──

  function channelOut(ch: ChannelView) {
    const runtime = new Map(gateway.keyRuntimeState(ch.name).map((k) => [k.id, k]));
    const { keyStrategy, keyCooldownSeconds, ...settings } = ch.settings as Record<string, unknown>;
    return {
      id: ch.id,
      name: ch.name,
      preset: ch.preset,
      baseURL: scrubOptional(ch.baseURL),
      effectiveBaseURL: scrubOptional(effectiveBaseURL(ch.preset, ch.baseURL)),
      enabled: ch.enabled,
      priority: ch.priority,
      models: ch.models,
      keyStrategy: (keyStrategy as string | undefined) ?? "round_robin",
      keyCooldownSeconds: (keyCooldownSeconds as number | undefined) ?? null,
      settings,
      urlPolicy: ch.urlPolicy,
      revision: ch.revision,
      createdAt: ch.createdAt,
      updatedAt: ch.updatedAt,
      keys: ch.keys.map((k) => {
        const rt = runtime.get(k.id);
        return {
          id: k.id,
          kind: k.kind,
          hint: k.hint,
          enabled: k.enabled,
          status: rt?.disabled ? (rt.disabled as { status: string }).status : k.status,
          weight: k.weight,
          lastError: k.lastError,
          lastErrorAt: k.lastErrorAt,
          ...(rt?.cooldownUntil ? { cooldownUntil: rt.cooldownUntil } : {}),
        };
      }),
    };
  }

  function modelOut(m: ModelView) {
    const entry = gateway.modelCatalog().lookup(m.name);
    return { ...m, available: entry?.available ?? false };
  }

  /** File source: the running config as read-only resources. */
  function fileChannels(): unknown[] {
    const config = gateway.getConfig();
    return config.targets.map((t: TargetConfig, i) => {
      const {
        name,
        provider,
        baseURL,
        models,
        enabled,
        keyStrategy,
        keyCooldownSeconds,
        apiKey: _k,
        apiKeys: _ks,
        publicNetworkOnly: _p,
        ...settings
      } = t;
      const runtime = new Map(gateway.keyRuntimeState(name).map((k) => [k.id, k]));
      return {
        id: name,
        name,
        preset: provider,
        baseURL: scrubOptional(baseURL),
        effectiveBaseURL: scrubOptional(effectiveBaseURL(provider, baseURL)),
        enabled: enabled !== false,
        priority: i,
        models: models ?? [],
        keyStrategy: keyStrategy ?? "round_robin",
        keyCooldownSeconds: keyCooldownSeconds ?? null,
        settings,
        urlPolicy: "trusted",
        revision: 0,
        keys: targetKeyEntries(t).map((k) => {
          const isRef = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(k.raw);
          const rt = runtime.get(k.id);
          return {
            id: k.id,
            kind: isRef ? "env_ref" : "literal",
            hint: isRef ? k.raw : maskSecret(k.raw),
            enabled: k.enabled,
            status: rt?.disabled ? (rt.disabled as { status: string }).status : "ok",
            weight: k.weight,
            ...(rt?.cooldownUntil ? { cooldownUntil: rt.cooldownUntil } : {}),
          };
        }),
      };
    });
  }

  const sourceInfo = () => ({ source: store ? "database" : "file", readOnly: store === undefined });

  // ── Channels ──

  r.get(
    "/channels",
    handle((c) =>
      c.json({ object: "list", ...sourceInfo(), data: store ? store.listChannels().map(channelOut) : fileChannels() }),
    ),
  );

  r.get(
    "/channels/:id",
    handle((c) => {
      const id = c.req.param("id") ?? "";
      if (!store) {
        const found = (fileChannels() as Array<{ id: string }>).find((ch) => ch.id === id);
        if (!found) throw new ConfigNotFoundError(`channel ${id} not found`);
        return c.json(found);
      }
      const ch = store.getChannel(id);
      if (!ch) throw new ConfigNotFoundError(`channel ${id} not found`);
      c.header("ETag", etag(ch.revision));
      return c.json(channelOut(ch));
    }),
  );

  function respondChannel(c: Context, s: ConfigStore, id: string, version: number, status: 200 | 201 = 200) {
    const ch = s.getChannel(id);
    if (!ch) return c.json({ deleted: true, id, configVersion: version });
    c.header("ETag", etag(ch.revision));
    c.header("X-Config-Version", String(version));
    return c.json({ ...channelOut(ch), configVersion: version }, status);
  }

  r.post(
    "/channels",
    ...write,
    handle(async (c) => {
      const s = writable();
      const body = await parseBody(c, ChannelCreateSchema);
      presetOrThrow(body.preset, body.baseURL, body.name);
      const url = effectiveBaseURL(body.preset, body.baseURL);
      if (url === undefined) throw new HttpError(422, "config_invalid", `channel "${body.name}" needs a baseURL`);
      assertNoQueryCredential(url);
      await assertPublicUrl(url, resolver);
      const id = newId("ch");
      const keys = await prepareKeys(s, id, body.keys ?? []);
      const settings: Record<string, unknown> = { ...(body.settings ?? {}) };
      if (body.keyStrategy !== undefined) settings["keyStrategy"] = body.keyStrategy;
      if (body.keyCooldownSeconds !== undefined) settings["keyCooldownSeconds"] = body.keyCooldownSeconds;
      const priority = body.priority ?? Math.max(-1, ...s.listChannels().map((ch) => ch.priority)) + 1;
      const { version } = commit(
        s,
        {
          actor: actorOf(c),
          action: "create",
          resourceType: "channel",
          resourceId: id,
          summary: `Create channel "${body.name}"`,
          detail: {
            name: body.name,
            preset: body.preset,
            baseURL: scrubOptional(body.baseURL),
            keys: keys.map((k) => ({ id: k.id, hint: k.hint })),
          },
        },
        (v, now) => {
          s.insertChannelRow(
            {
              id,
              name: body.name,
              preset: body.preset,
              baseURL: body.baseURL ?? null,
              enabled: body.enabled !== false,
              priority,
              models: body.models ?? [],
              settings,
              urlPolicy: "public",
            },
            v,
            now,
          );
          keys.forEach((k, i) => {
            s.insertKeyRow(id, k, i, v, now);
          });
        },
        keys,
      );
      return respondChannel(c, s, id, version, 201);
    }),
  );

  async function prepareKeys(
    s: ConfigStore,
    channelId: string,
    keys: ReadonlyArray<{ key: string; weight?: number; enabled?: boolean }>,
  ): Promise<PreparedKey[]> {
    if (keys.length > 0 && !s.canEncrypt) {
      throw new HttpError(
        422,
        "secret_key_missing",
        "Storing an upstream key requires GATEWAY_SECRET_KEY (keys are encrypted at rest); set it and restart",
      );
    }
    return Promise.all(keys.map((k) => s.prepareKey(channelId, k.key, { weight: k.weight, enabled: k.enabled })));
  }

  r.patch(
    "/channels/:id",
    ...write,
    handle(async (c) => {
      const s = writable();
      const id = c.req.param("id") ?? "";
      const expected = requireIfMatch(c);
      const body = await parseBody(c, ChannelPatchSchema);
      const current = s.getChannel(id);
      if (!current) throw new ConfigNotFoundError(`channel ${id} not found`);
      const preset = body.preset ?? current.preset;
      const baseURL = body.baseURL !== undefined ? body.baseURL : (current.baseURL ?? null);
      const urlChanged = body.preset !== undefined || body.baseURL !== undefined;
      const oldOrigin = originOf(effectiveBaseURL(current.preset, current.baseURL));
      let newOrigin = oldOrigin;
      if (urlChanged) {
        presetOrThrow(preset, baseURL, body.name ?? current.name);
        const url = effectiveBaseURL(preset, baseURL);
        if (url === undefined) throw new HttpError(422, "config_invalid", "the channel needs a baseURL");
        assertNoQueryCredential(url);
        await assertPublicUrl(url, resolver);
        newOrigin = originOf(url);
      }
      // RC1 / RC2 (red team 2026-11-02): the stored keys (encrypted, or an
      // env reference resolved on use) were sent to whatever origin the base
      // URL was changed to, e.g. by channel test / fetch-models / balance.
      // Moving a channel to another origin now requires its keys again.
      const originChanged = newOrigin !== oldOrigin;
      if (originChanged && current.keys.length > 0 && body.apiKeys === undefined) {
        const message =
          `Changing the channel's base URL to another origin (${scrubOptional(newOrigin) ?? "?"}) requires its API key(s) ` +
          'again in the same request ("apiKeys": [{"key": "…"}]): stored keys are never sent to a new origin.';
        throw new HttpError(400, "api_keys_required_on_base_url_change", message, {
          fields: [{ path: "apiKeys", message }],
        });
      }
      const replacedKeys = body.apiKeys !== undefined ? await prepareKeys(s, id, body.apiKeys) : undefined;
      let settings: Record<string, unknown> | undefined;
      if (body.settings !== undefined || body.keyStrategy !== undefined || body.keyCooldownSeconds !== undefined) {
        const base: Record<string, unknown> =
          body.settings !== undefined
            ? { ...body.settings }
            : Object.fromEntries(
                Object.entries(current.settings).filter(([k]) => k !== "keyStrategy" && k !== "keyCooldownSeconds"),
              );
        const ks = body.keyStrategy !== undefined ? body.keyStrategy : current.settings["keyStrategy"];
        const kc =
          body.keyCooldownSeconds !== undefined ? body.keyCooldownSeconds : current.settings["keyCooldownSeconds"];
        if (ks !== null && ks !== undefined) base["keyStrategy"] = ks;
        if (kc !== null && kc !== undefined) base["keyCooldownSeconds"] = kc;
        settings = base;
      }
      const fields = Object.keys(body);
      const { version } = commit(
        s,
        {
          actor: actorOf(c),
          action: "update",
          resourceType: "channel",
          resourceId: id,
          summary: `Update channel "${current.name}" (${fields.join(", ") || "no fields"})`,
          detail: {
            fields,
            ...(urlChanged ? { baseURL: scrubOptional(baseURL), preset } : {}),
            ...(originChanged
              ? { originChange: { from: scrubOptional(oldOrigin) ?? null, to: scrubOptional(newOrigin) ?? null } }
              : {}),
            ...(replacedKeys
              ? {
                  keysReplaced: {
                    removed: current.keys.map((k) => ({ id: k.id, hint: k.hint })),
                    added: replacedKeys.map((k) => ({ id: k.id, hint: k.hint })),
                  },
                }
              : {}),
          },
        },
        (v, now) => {
          s.expectRevision("channels", id, expected, "channel");
          if (replacedKeys) {
            s.deleteChannelKeyRows(id);
            replacedKeys.forEach((k, i) => {
              s.insertKeyRow(id, k, i, v, now);
            });
          }
          s.updateChannelRow(
            id,
            {
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.preset !== undefined ? { preset: body.preset } : {}),
              ...(body.baseURL !== undefined ? { baseURL: body.baseURL } : {}),
              ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
              ...(body.priority !== undefined ? { priority: body.priority } : {}),
              ...(body.models !== undefined ? { models: body.models } : {}),
              ...(settings !== undefined ? { settings } : {}),
              ...(urlChanged ? { urlPolicy: "public" as const } : {}),
            },
            v,
            now,
          );
        },
        replacedKeys ?? [],
      );
      return respondChannel(c, s, id, version);
    }),
  );

  r.delete(
    "/channels/:id",
    ...write,
    handle((c) => {
      const s = writable();
      const id = c.req.param("id") ?? "";
      const expected = requireIfMatch(c);
      const current = s.getChannel(id);
      if (!current) throw new ConfigNotFoundError(`channel ${id} not found`);
      const { version } = commit(
        s,
        {
          actor: actorOf(c),
          action: "delete",
          resourceType: "channel",
          resourceId: id,
          summary: `Delete channel "${current.name}"`,
          detail: { name: current.name },
        },
        (v) => {
          void v;
          s.expectRevision("channels", id, expected, "channel");
          s.deleteChannelRow(id);
        },
      );
      c.header("X-Config-Version", String(version));
      return c.json({ deleted: true, id, configVersion: version });
    }),
  );

  // ── Channel keys ──

  r.post(
    "/channels/:id/keys",
    ...write,
    handle(async (c) => {
      const s = writable();
      const id = c.req.param("id") ?? "";
      const expected = requireIfMatch(c);
      const body = await parseBody(c, KeysAddSchema);
      const current = s.getChannel(id);
      if (!current) throw new ConfigNotFoundError(`channel ${id} not found`);
      const keys = await prepareKeys(s, id, body.keys);
      const { version } = commit(
        s,
        {
          actor: actorOf(c),
          action: "add_keys",
          resourceType: "channel",
          resourceId: id,
          summary: `Add ${keys.length} key(s) to channel "${current.name}"`,
          detail: { keys: keys.map((k) => ({ id: k.id, hint: k.hint })) },
        },
        (v, now) => {
          s.expectRevision("channels", id, expected, "channel");
          let pos = s.nextKeyPosition(id);
          for (const k of keys) s.insertKeyRow(id, k, pos++, v, now);
          s.touchChannel(id, v, now);
        },
        keys,
      );
      return respondChannel(c, s, id, version, 201);
    }),
  );

  const keyChange =
    (action: "update_key" | "enable_key" | "disable_key" | "delete_key") =>
    async (c: Context): Promise<Response> => {
      const s = writable();
      const id = c.req.param("id") ?? "";
      const keyId = c.req.param("keyId") ?? "";
      const expected = requireIfMatch(c);
      const patch =
        action === "update_key"
          ? await parseBody(c, KeyPatchSchema)
          : action === "enable_key"
            ? { enabled: true }
            : action === "disable_key"
              ? { enabled: false }
              : {};
      if (action !== "update_key") await parseBody(c, z.strictObject({}));
      const current = s.getChannel(id);
      if (!current) throw new ConfigNotFoundError(`channel ${id} not found`);
      const { hint } = s.expectKey(id, keyId);
      const { version } = commit(
        s,
        {
          actor: actorOf(c),
          action,
          resourceType: "channel_key",
          resourceId: keyId,
          summary: `${action.replace("_", " ")} ${hint} on channel "${current.name}"`,
          detail: { channelId: id, hint, ...patch },
        },
        (v, now) => {
          s.expectRevision("channels", id, expected, "channel");
          if (action === "delete_key") s.deleteKeyRow(keyId);
          else s.updateKeyRow(keyId, patch, v, now);
          s.touchChannel(id, v, now);
        },
      );
      // An operator re-enabled the key: forget its cooldown / automatic disable.
      if ((patch as { enabled?: boolean }).enabled === true) gateway.resetKeyState(current.name, keyId);
      return respondChannel(c, s, id, version);
    };

  r.patch("/channels/:id/keys/:keyId", ...write, handle(keyChange("update_key")));
  r.post("/channels/:id/keys/:keyId/enable", ...write, handle(keyChange("enable_key")));
  r.post("/channels/:id/keys/:keyId/disable", ...write, handle(keyChange("disable_key")));
  r.delete("/channels/:id/keys/:keyId", ...write, handle(keyChange("delete_key")));

  // ── Channel probes: test / fetch models ──

  async function probeChannel(c: Context, kind: "test" | "fetch_models"): Promise<Response> {
    const s = writable();
    const id = c.req.param("id") ?? "";
    const body =
      kind === "test"
        ? await parseBody(c, ChannelTestSchema)
        : await parseBody(c, z.strictObject({ keyId: z.string().min(1).max(100).optional() }));
    const actor = actorOf(c);
    const wait = perActor.take(actor) ?? globalProbe.take("*");
    if (wait !== undefined) {
      c.header("Retry-After", String(wait));
      throw new HttpError(429, "rate_limited", `Too many channel probes; retry in ${wait}s`);
    }
    const ch = s.getChannel(id);
    if (!ch) throw new ConfigNotFoundError(`channel ${id} not found`);
    const keyRow = body.keyId !== undefined ? ch.keys.find((k) => k.id === body.keyId) : ch.keys.find((k) => k.enabled);
    if (body.keyId !== undefined && !keyRow)
      throw new ConfigNotFoundError(`key ${body.keyId} not found on channel ${id}`);
    let key = "";
    if (keyRow) {
      const v = await s.keyValue(keyRow.id);
      key = v.kind === "env_ref" ? expandEnvRefsSafe(v.value) : v.value;
    }
    key ||= getPreset(ch.preset)?.defaultApiKey ?? "";
    let base: string;
    try {
      base = resolveBaseURL({ name: ch.name, provider: ch.preset, baseURL: ch.baseURL });
    } catch (err) {
      throw new HttpError(422, "config_invalid", err instanceof Error ? err.message : String(err));
    }
    base = base.replace(/\/+$/, "");
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(getPreset(ch.preset)?.extraHeaders ?? {}),
    };
    if (key) headers["Authorization"] = `Bearer ${key}`;
    const model = kind === "test" ? (body as { model?: string }).model : undefined;
    const started = performance.now();
    const fetchOpts = {
      timeoutMs: probeTimeout,
      maxBytes: probeMaxBytes,
      ...(ch.urlPolicy === "public" ? { guard: probeGuard } : {}),
    };
    let result: { status: number; body: string };
    try {
      result =
        model !== undefined
          ? await limitedFetch(
              `${base}/chat/completions`,
              {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
              },
              fetchOpts,
            )
          : await limitedFetch(`${base}/models`, { method: "GET", headers }, fetchOpts);
    } catch (err) {
      const message = keyErrorText(0, err instanceof Error ? err.message : String(err), key).replace(/^0: /, "");
      s.auditOnly(actor, kind === "test" ? "channel_test" : "channel_fetch_models", "channel", id, {
        ok: false,
        error: message,
      });
      if (kind === "fetch_models") throw new HttpError(502, "upstream_unreachable", message);
      return c.json({ ok: false, status: null, latencyMs: Math.round(performance.now() - started), error: message });
    }
    const latencyMs = Math.round(performance.now() - started);
    const ok = result.status >= 200 && result.status < 300;
    let upstreamMessage: string | undefined;
    if (!ok) {
      try {
        const parsed = JSON.parse(result.body) as { error?: { message?: unknown } | string };
        const e = parsed.error;
        upstreamMessage = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : undefined;
      } catch {
        upstreamMessage = undefined;
      }
    }
    const error = ok ? undefined : keyErrorText(result.status, upstreamMessage ?? `HTTP ${result.status}`, key);
    if (kind === "test") {
      s.auditOnly(actor, "channel_test", "channel", id, { ok, status: result.status, ...(model ? { model } : {}) });
      return c.json({
        ok,
        status: result.status,
        latencyMs,
        ...(model ? { model } : {}),
        ...(keyRow ? { keyId: keyRow.id } : {}),
        ...(error ? { error } : {}),
      });
    }
    s.auditOnly(actor, "channel_fetch_models", "channel", id, { ok, status: result.status });
    if (!ok)
      throw new HttpError(502, "upstream_error", error ?? `upstream answered ${result.status}`, {
        status: result.status,
      });
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(result.body) as { data?: unknown };
      if (Array.isArray(parsed.data)) {
        ids = parsed.data
          .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
          .filter((x): x is string => typeof x === "string" && x !== "" && x.length <= 200);
      }
    } catch {
      throw new HttpError(502, "upstream_invalid_response", "the upstream model list is not valid JSON");
    }
    const unique = [...new Set(ids)].slice(0, MAX_MODELS_FETCHED);
    return c.json({
      object: "list",
      channelId: id,
      latencyMs,
      models: unique,
      truncated: ids.length > MAX_MODELS_FETCHED,
    });
  }

  r.post(
    "/channels/:id/test",
    ...write,
    handle((c) => probeChannel(c, "test")),
  );
  r.post(
    "/channels/:id/fetch-models",
    ...write,
    handle((c) => probeChannel(c, "fetch_models")),
  );

  // ── Channel account balance (informational; P6 user decision) ──
  // Only for providers that expose it; fetched on demand, never stored, no cost is computed anywhere.

  const balanceLimiter = new WindowLimiter(
    opts.probe?.perActorPerMinute ? opts.probe.perActorPerMinute * 3 : 30,
    60_000,
  );
  const balanceGlobal = new WindowLimiter(opts.probe?.globalPerMinute ? opts.probe.globalPerMinute * 2 : 60, 60_000);

  r.get(
    "/channels/:id/balance",
    handle(async (c) => {
      const id = c.req.param("id") ?? "";
      const ch = store?.getChannel(id);
      if (!ch) throw new ConfigNotFoundError(`channel ${id} not found`);
      c.header("Cache-Control", "no-store");
      const endpoint = BALANCE_ENDPOINTS[presetId(ch.preset)];
      if (!endpoint) return c.json({ channelId: id, supported: false });
      const wait = balanceLimiter.take(actorOf(c)) ?? balanceGlobal.take("*");
      if (wait !== undefined) {
        c.header("Retry-After", String(wait));
        throw new HttpError(429, "rate_limited", `Too many balance lookups; retry in ${wait}s`);
      }
      const keyRow = ch.keys.find((k) => k.enabled && k.status === "ok") ?? ch.keys.find((k) => k.enabled);
      if (!keyRow) return c.json({ channelId: id, supported: true, ok: false, error: "no enabled key" });
      const v = await store!.keyValue(keyRow.id);
      const key = v.kind === "env_ref" ? expandEnvRefsSafe(v.value) : v.value;
      if (!key) return c.json({ channelId: id, supported: true, ok: false, error: "the key is empty" });
      let base: string;
      try {
        base = resolveBaseURL({ name: ch.name, provider: ch.preset, baseURL: ch.baseURL }).replace(/\/+$/, "");
      } catch (err) {
        throw new HttpError(422, "config_invalid", err instanceof Error ? err.message : String(err));
      }
      const fetchedAt = new Date().toISOString();
      let result: { status: number; body: string };
      try {
        result = await limitedFetch(
          endpoint.url(base),
          { method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${key}` } },
          {
            timeoutMs: probeTimeout,
            maxBytes: 64 * 1024,
            ...(ch.urlPolicy === "public" ? { guard: probeGuard } : {}),
          },
        );
      } catch (err) {
        const message = keyErrorText(0, err instanceof Error ? err.message : String(err), key).replace(/^0: /, "");
        return c.json({ channelId: id, supported: true, ok: false, keyId: keyRow.id, fetchedAt, error: message });
      }
      if (result.status < 200 || result.status >= 300) {
        return c.json({
          channelId: id,
          supported: true,
          ok: false,
          keyId: keyRow.id,
          fetchedAt,
          error: keyErrorText(result.status, `HTTP ${result.status}`, key),
        });
      }
      let parsed: { available?: boolean; balances: Array<{ currency: string; total: string }> } | undefined;
      try {
        parsed = endpoint.parse(JSON.parse(result.body) as unknown);
      } catch {
        parsed = undefined;
      }
      if (!parsed) {
        return c.json({
          channelId: id,
          supported: true,
          ok: false,
          keyId: keyRow.id,
          fetchedAt,
          error: "unexpected response",
        });
      }
      return c.json({ channelId: id, supported: true, ok: true, keyId: keyRow.id, fetchedAt, ...parsed });
    }),
  );

  // ── Models ──

  r.get(
    "/models",
    handle((c) => {
      if (!store) {
        const config = gateway.getConfig();
        return c.json({
          object: "list",
          ...sourceInfo(),
          modelSource: config.models !== undefined ? "explicit" : "derived",
          data: config.models ?? [],
          published: gateway
            .modelCatalog()
            .list()
            .map((e) => ({ name: e.name, enabled: e.enabled, available: e.available, channels: e.targets })),
        });
      }
      const settings = store.getSettings();
      return c.json({
        object: "list",
        ...sourceInfo(),
        modelSource: settings.modelSource,
        data: store.listModels().map(modelOut),
        published: gateway
          .modelCatalog()
          .list()
          .map((e) => ({ name: e.name, enabled: e.enabled, available: e.available, channels: e.targets })),
      });
    }),
  );

  r.get(
    "/models/:id",
    handle((c) => {
      const id = c.req.param("id") ?? "";
      const m = store?.getModel(id);
      if (!m) throw new ConfigNotFoundError(`model ${id} not found`);
      c.header("ETag", etag(m.revision));
      return c.json(modelOut(m));
    }),
  );

  function respondModel(c: Context, s: ConfigStore, id: string, version: number, status: 200 | 201 = 200) {
    const m = s.getModel(id);
    if (!m) return c.json({ deleted: true, id, configVersion: version });
    c.header("ETag", etag(m.revision));
    c.header("X-Config-Version", String(version));
    return c.json({ ...modelOut(m), configVersion: version }, status);
  }

  function requireExplicit(s: ConfigStore): void {
    if (s.getSettings().modelSource !== "explicit") {
      throw new HttpError(
        409,
        "models_derived",
        "Published models are derived from the channels' model lists (no models: section). " +
          'Switch first: PATCH /admin/settings {"modelSource": "explicit"} turns the current list into editable models.',
      );
    }
  }

  function writeBindings(s: ConfigStore, modelId: string, modelName: string, bindings: readonly BindingInput[]): void {
    const seen = new Set<string>();
    bindings.forEach((b, i) => {
      const channelId = s.channelIdOf(b);
      if (seen.has(channelId)) throw new ConfigStoreError(`model "${modelName}" binds the same channel twice`);
      seen.add(channelId);
      s.insertBindingRow(modelId, {
        channelId,
        upstreamModel: b.upstreamModel ?? modelName,
        priority: b.priority ?? i,
        weight: b.weight ?? 1,
        enabled: b.enabled !== false,
        params: (b.params ?? {}) as Record<string, unknown>,
      });
    });
  }

  r.post(
    "/models",
    ...write,
    handle(async (c) => {
      const s = writable();
      const body = await parseBody(c, ModelCreateSchema);
      requireExplicit(s);
      const id = newId("mdl");
      const { version } = commit(
        s,
        {
          actor: actorOf(c),
          action: "create",
          resourceType: "model",
          resourceId: id,
          summary: `Create model "${body.name}"`,
          detail: { name: body.name, bindings: (body.bindings ?? []).length },
        },
        (v, now) => {
          s.insertModelRow(
            {
              id,
              name: body.name,
              displayName: body.displayName ?? null,
              description: body.description ?? null,
              enabled: body.enabled !== false,
              metadata: (body.metadata ?? {}) as Record<string, unknown>,
              strategy: body.strategy ?? "fallback",
              ...(body.balance !== undefined ? { balance: body.balance } : {}),
            },
            v,
            now,
          );
          writeBindings(s, id, body.name, body.bindings ?? []);
        },
      );
      return respondModel(c, s, id, version, 201);
    }),
  );

  r.patch(
    "/models/:id",
    ...write,
    handle(async (c) => {
      const s = writable();
      const id = c.req.param("id") ?? "";
      const expected = requireIfMatch(c);
      const body = await parseBody(c, ModelPatchSchema);
      requireExplicit(s);
      const current = s.getModel(id);
      if (!current) throw new ConfigNotFoundError(`model ${id} not found`);
      const fields = Object.keys(body);
      const { version } = commit(
        s,
        {
          actor: actorOf(c),
          action: "update",
          resourceType: "model",
          resourceId: id,
          summary: `Update model "${current.name}" (${fields.join(", ") || "no fields"})`,
          detail: { fields },
        },
        (v, now) => {
          s.expectRevision("models", id, expected, "model");
          s.updateModelRow(
            id,
            {
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
              ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
              ...(body.metadata !== undefined ? { metadata: body.metadata as Record<string, unknown> } : {}),
              ...(body.strategy !== undefined ? { strategy: body.strategy } : {}),
              ...(body.balance !== undefined ? { balance: body.balance } : {}),
            },
            v,
            now,
          );
          // `bindings` replaces them all, in the same transaction (one version, all or nothing).
          if (body.bindings !== undefined) {
            s.deleteBindings(id);
            writeBindings(s, id, body.name ?? current.name, body.bindings);
          } else if (body.name !== undefined && body.name !== current.name) {
            // A rename changes the upstream name of bindings that used the published name.
            s.deleteBindings(id);
            writeBindings(
              s,
              id,
              body.name,
              current.bindings.map((b) => ({
                channelId: b.channelId,
                upstreamModel: b.upstreamModel,
                priority: b.priority,
                weight: b.weight,
                enabled: b.enabled,
                params: b.params as Record<string, unknown>,
              })),
            );
          }
        },
      );
      return respondModel(c, s, id, version);
    }),
  );

  r.put(
    "/models/:id/bindings",
    ...write,
    handle(async (c) => {
      const s = writable();
      const id = c.req.param("id") ?? "";
      const expected = requireIfMatch(c);
      const body = await parseBody(c, BindingsPutSchema);
      requireExplicit(s);
      const current = s.getModel(id);
      if (!current) throw new ConfigNotFoundError(`model ${id} not found`);
      const { version } = commit(
        s,
        {
          actor: actorOf(c),
          action: "set_bindings",
          resourceType: "model",
          resourceId: id,
          summary: `Set ${body.bindings.length} binding(s) of model "${current.name}"`,
          detail: {
            bindings: body.bindings.map((b) => ({
              channel: b.channelId ?? b.channel,
              upstreamModel: b.upstreamModel,
              priority: b.priority,
              weight: b.weight,
              enabled: b.enabled,
            })),
          },
        },
        (v, now) => {
          s.expectRevision("models", id, expected, "model");
          s.deleteBindings(id);
          writeBindings(s, id, current.name, body.bindings);
          s.updateModelRow(id, {}, v, now);
        },
      );
      return respondModel(c, s, id, version);
    }),
  );

  r.delete(
    "/models/:id",
    ...write,
    handle((c) => {
      const s = writable();
      const id = c.req.param("id") ?? "";
      const expected = requireIfMatch(c);
      requireExplicit(s);
      const current = s.getModel(id);
      if (!current) throw new ConfigNotFoundError(`model ${id} not found`);
      const { version } = commit(
        s,
        {
          actor: actorOf(c),
          action: "delete",
          resourceType: "model",
          resourceId: id,
          summary: `Delete model "${current.name}"`,
          detail: { name: current.name },
        },
        () => {
          s.expectRevision("models", id, expected, "model");
          s.deleteModelRow(id);
        },
      );
      c.header("X-Config-Version", String(version));
      return c.json({ deleted: true, id, configVersion: version });
    }),
  );

  // ── Settings ──

  function settingsOut() {
    if (!store) {
      const config = gateway.getConfig();
      return {
        ...sourceInfo(),
        strategy: config.strategy,
        aliases: config.aliases ?? {},
        plugins: config.plugins ?? [],
        compatibility: config.compatibility ?? null,
        limits: config.limits ?? {},
        modelSource: config.models !== undefined ? "explicit" : "derived",
        revision: 0,
      };
    }
    return { ...sourceInfo(), ...store.getSettings() };
  }

  r.get(
    "/settings",
    handle((c) => {
      const out = settingsOut();
      c.header("ETag", etag(out.revision));
      return c.json(out);
    }),
  );

  r.patch(
    "/settings",
    ...write,
    handle(async (c) => {
      const s = writable();
      const expected = requireIfMatch(c);
      const body = await parseBody(c, SettingsPatchSchema);
      const fields = Object.keys(body);
      const { version } = commit(
        s,
        {
          actor: actorOf(c),
          action: "update",
          resourceType: "settings",
          resourceId: null,
          summary: `Update settings (${fields.join(", ") || "no fields"})`,
          detail: { fields, ...(body.modelSource !== undefined ? { modelSource: body.modelSource } : {}) },
        },
        (v, now) => {
          s.expectSettingsRevision(expected);
          if (body.strategy !== undefined) s.writeSetting("strategy", body.strategy, v, now);
          if (body.aliases !== undefined) {
            s.writeSetting("aliases", Object.keys(body.aliases).length > 0 ? body.aliases : null, v, now);
          }
          if (body.plugins !== undefined)
            s.writeSetting("plugins", body.plugins.length > 0 ? body.plugins : null, v, now);
          if (body.compatibility !== undefined) s.writeSetting("compatibility", body.compatibility, v, now);
          if (body.limits !== undefined) {
            const limits = body.limits === null ? {} : body.limits;
            s.writeSetting("limits", Object.keys(limits).length > 0 ? limits : null, v, now);
          }
          if (body.modelSource !== undefined && body.modelSource !== s.getSettings().modelSource) {
            if (body.modelSource === "explicit") s.materializeDerivedModels(v, now);
            else s.setModelSource("derived");
          }
          s.setSettingsRevision(v);
        },
      );
      const out = settingsOut();
      c.header("ETag", etag(out.revision));
      c.header("X-Config-Version", String(version));
      return c.json({ ...out, configVersion: version });
    }),
  );

  // ── Versions, rollback, audit ──

  const limitParam = (c: Context, max: number, def: number) => {
    const raw = c.req.query("limit");
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "invalid_request", "limit must be a positive integer");
    return Math.min(n, max);
  };
  const beforeParam = (c: Context) => {
    const raw = c.req.query("before");
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "invalid_request", "before must be a positive integer");
    return n;
  };

  r.get(
    "/config/versions",
    handle((c) => {
      const limit = limitParam(c, 200, 50);
      const before = beforeParam(c);
      if (!store) return c.json({ object: "list", ...sourceInfo(), head: null, data: [] });
      const head = store.headVersion();
      c.header("ETag", etag(head));
      return c.json({ object: "list", ...sourceInfo(), head, data: store.listVersions(limit, before) });
    }),
  );

  r.get(
    "/config/versions/:v",
    handle((c) => {
      const v = Number(c.req.param("v"));
      if (!Number.isInteger(v) || v < 1)
        throw new HttpError(400, "invalid_request", "version must be a positive integer");
      const found = store?.getVersion(v);
      if (!found) throw new ConfigNotFoundError(`config version ${v} not found`);
      const snap = found.snapshot as { channels?: Array<Record<string, unknown>> };
      if (Array.isArray(snap.channels)) {
        snap.channels = snap.channels.map((ch) =>
          typeof ch["base_url"] === "string" ? { ...ch, base_url: scrubUrl(ch["base_url"]) } : ch,
        );
      }
      return c.json(found);
    }),
  );

  r.post(
    "/config/versions/:v/rollback",
    ...write,
    handle(async (c) => {
      const s = writable();
      const target = Number(c.req.param("v"));
      if (!Number.isInteger(target) || target < 1)
        throw new HttpError(400, "invalid_request", "version must be a positive integer");
      const expected = requireIfMatch(c);
      await parseBody(c, z.strictObject({}));
      await s.prepareRestore(target);
      const { version } = commit(
        s,
        {
          actor: actorOf(c),
          action: "rollback",
          resourceType: "runtime_config",
          resourceId: String(target),
          summary: `Roll back to config version ${target}`,
          detail: { to: target },
          expectHead: expected,
        },
        (v, now) => {
          s.restoreVersion(target, v, now);
        },
      );
      c.header("ETag", etag(version));
      c.header("X-Config-Version", String(version));
      return c.json({ rolledBackTo: target, configVersion: version });
    }),
  );

  r.get(
    "/audit",
    handle((c) => {
      const limit = limitParam(c, 500, 100);
      const before = beforeParam(c);
      return c.json({ object: "list", ...sourceInfo(), data: store ? store.listAudit(limit, before) : [] });
    }),
  );

  // ── Presets ──

  r.get(
    "/presets",
    handle((c) =>
      c.json({
        object: "list",
        data: Object.entries(PROVIDER_PRESETS).map(([id, p]) => ({
          id,
          baseURL: p.baseURL ?? null,
          baseURLRequired: p.baseURL === undefined,
          ...(p.baseURLHint ? { baseURLHint: p.baseURLHint } : {}),
          // Local-only defaults cannot be used by Admin API channels (public internet only).
          adminUsable: p.baseURL === undefined || isPublicDefault(p.baseURL),
          models: Object.entries(knownUpstreamModels(presetId(id))).map(([model, meta]) => ({
            id: model,
            metadata: meta,
          })),
        })),
      }),
    ),
  );
}

function scrubOptional(url: string | null | undefined): string | null {
  return url === null || url === undefined ? null : scrubUrl(url);
}

function isPublicDefault(url: string): boolean {
  const host = new URL(url).hostname;
  return host !== "localhost" && !host.startsWith("127.");
}

/** Expand an env reference for a channel probe; a missing variable probes without a key. */
function expandEnvRefsSafe(v: string): string {
  try {
    return expandEnvRefs(v);
  } catch {
    return "";
  }
}
