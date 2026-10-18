/**
 * Config scrubbing — replaces secrets with "***" for admin API responses
 * (GET /admin/config, readable with read_only credentials).
 *
 * A value is kept verbatim only when it is exactly one env template
 * (`${VAR}`); anything else that could carry a secret is redacted, so
 * `"${A}sk-literal${B}"` is redacted too.
 *
 * Redacted:
 *   - targets[].apiKey, adminSecret, auth.keys[]
 *   - URL credentials everywhere a URL appears (targets[].baseURL,
 *     observability.tracing.otlpEndpoint, URL strings inside plugin config):
 *     userinfo (`https://user:pass@host`) and the values of sensitive query
 *     parameters (`?key=`, `?api_key=`, `?token=`, `?sig=` …)
 *   - observability.tracing.headers (all values — OTLP headers carry credentials)
 *   - mcpServers[].env (all values) and mcpServers[].args (all values: DB
 *     URLs, `--api-key X` and the like)
 *   - plugins[].config: any key matching auth|key|token|secret|password|
 *     cookie|credential (case-insensitive), recursively
 */

import type { GatewayConfig } from "../config/types.js";

const REDACTED = "***";

const SENSITIVE_KEY_RE = /auth|key|token|secret|password|passwd|cookie|credential/i;
/** Query parameter names whose values are credentials (in addition to SENSITIVE_KEY_RE). */
const SENSITIVE_QUERY_RE = /^(sig|signature|code|pwd|pass|session|jwt|bearer)$/i;
/** Exactly one env reference, nothing else (same name syntax as config/envref.ts). */
const ENV_TEMPLATE_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export function isEnvTemplate(value: string): boolean {
  return ENV_TEMPLATE_RE.test(value);
}

function redactString(value: string): string {
  return isEnvTemplate(value) ? value : REDACTED;
}

/** Whether a header/env/config key name looks like it carries a secret. */
export function isSensitiveConfigKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/**
 * Remove credentials from a URL-ish string: userinfo and sensitive query
 * values. Works on strings that are not parseable URLs (e.g. containing
 * `${VAR}`), so it is regex-based rather than `new URL()`.
 */
export function scrubUrl(value: string): string {
  if (isEnvTemplate(value)) return value;
  let out = value.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)/i, (_m, scheme: string) => `${scheme}${REDACTED}@`);
  out = out.replace(/([?&;])([^=&#;]+)=([^&#;]*)/g, (m, sep: string, name: string, v: string) => {
    let decoded = name;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      // keep raw name
    }
    if (v === "" || isEnvTemplate(v)) return m;
    return SENSITIVE_KEY_RE.test(decoded) || SENSITIVE_QUERY_RE.test(decoded) ? `${sep}${name}=${REDACTED}` : m;
  });
  return out;
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/** Replace every leaf value (strings keep exact ${VAR} templates). */
function redactAll(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactAll);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactAll(v);
    return out;
  }
  return value === undefined || value === null ? value : REDACTED;
}

/** Redact values under sensitive-looking keys and URL credentials, recursively. */
function redactSensitiveKeys(value: unknown): unknown {
  if (typeof value === "string") return looksLikeUrl(value) ? scrubUrl(value) : value;
  if (Array.isArray(value)) return value.map(redactSensitiveKeys);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveConfigKey(k) ? redactAll(v) : redactSensitiveKeys(v);
    }
    return out;
  }
  return value;
}

export function scrubConfig(config: GatewayConfig): GatewayConfig {
  const copy = structuredClone(config);

  for (const target of copy.targets ?? []) {
    if (typeof target.apiKey === "string" && target.apiKey !== "") {
      target.apiKey = redactString(target.apiKey);
    }
    if (typeof target.baseURL === "string") {
      target.baseURL = scrubUrl(target.baseURL);
    }
  }

  if (copy.adminSecret !== undefined) {
    copy.adminSecret = redactString(copy.adminSecret);
  }

  if (copy.auth?.keys !== undefined) {
    copy.auth.keys = copy.auth.keys.map((k) => (typeof k === "string" ? redactString(k) : REDACTED));
  }

  for (const server of copy.mcpServers ?? []) {
    if (server.env !== undefined) {
      for (const key of Object.keys(server.env)) server.env[key] = REDACTED;
    }
    if (server.args !== undefined) {
      server.args = server.args.map(() => REDACTED);
    }
  }

  const tracing = copy.observability?.tracing;
  if (tracing?.headers !== undefined) {
    tracing.headers = redactAll(tracing.headers) as Record<string, string>;
  }
  if (typeof tracing?.otlpEndpoint === "string") {
    tracing.otlpEndpoint = scrubUrl(tracing.otlpEndpoint);
  }

  for (const plugin of copy.plugins ?? []) {
    if (plugin.config !== undefined) {
      plugin.config = redactSensitiveKeys(plugin.config) as Record<string, unknown>;
    }
  }

  return copy;
}
