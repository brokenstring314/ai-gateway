/**
 * Config scrubbing — replaces secrets with "***" for admin API responses.
 *
 * Env templates (${VAR}) are preserved as-is; materialized values are never exposed.
 *
 * Redacted:
 *   - targets[].apiKey, adminSecret, auth.keys[]
 *   - observability.tracing.headers (all values — OTLP headers carry credentials)
 *   - mcpServers[].env (all values)
 *   - mcpServers[].headers, plugins[].config, observability.exporters[].config:
 *     any key matching auth|key|token|secret|password|cookie (case-insensitive),
 *     recursively.
 */

import type { GatewayConfig } from "../config/types.js";

const REDACTED = "***";

const SENSITIVE_KEY_RE = /auth|key|token|secret|password|passwd|cookie|credential/i;

function isEnvTemplate(value: string): boolean {
  return value.startsWith("${") && value.endsWith("}");
}

function redactString(value: string): string {
  return isEnvTemplate(value) ? value : REDACTED;
}

/** Whether a header/env/config key name looks like it carries a secret. */
export function isSensitiveConfigKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/** Replace every leaf value (strings keep ${VAR} templates). */
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

/** Redact values under sensitive-looking keys, recursively. */
function redactSensitiveKeys(value: unknown): unknown {
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
    if (typeof target.apiKey === "string" && !isEnvTemplate(target.apiKey)) {
      target.apiKey = REDACTED;
    }
  }

  if (copy.adminSecret !== undefined) {
    copy.adminSecret = REDACTED;
  }

  if (copy.auth?.keys !== undefined) {
    copy.auth.keys = copy.auth.keys.map((k) => (typeof k === "string" ? redactString(k) : REDACTED));
  }

  if (copy.mcpServers !== undefined) {
    for (const server of copy.mcpServers) {
      if (server.headers !== undefined) {
        server.headers = redactSensitiveKeys(server.headers) as Record<string, string>;
      }
      if (server.env !== undefined) {
        for (const key of Object.keys(server.env)) {
          server.env[key] = REDACTED;
        }
      }
    }
  }

  const tracing = copy.observability?.tracing;
  if (tracing?.headers !== undefined) {
    tracing.headers = redactAll(tracing.headers) as Record<string, string>;
  }

  for (const exporter of copy.observability?.exporters ?? []) {
    if (exporter.config !== undefined) {
      exporter.config = redactSensitiveKeys(exporter.config) as Record<string, unknown>;
    }
  }

  for (const plugin of copy.plugins ?? []) {
    if (plugin.config !== undefined) {
      plugin.config = redactSensitiveKeys(plugin.config) as Record<string, unknown>;
    }
  }

  return copy;
}

export function scrubConfigJson(configJson: string): string {
  return JSON.stringify(scrubConfig(JSON.parse(configJson) as GatewayConfig));
}
