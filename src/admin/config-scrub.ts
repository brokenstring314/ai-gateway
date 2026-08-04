/**
 * Config scrubbing — replaces secrets with "***" for admin API responses.
 *
 * Env templates (${VAR}) are preserved as-is; materialized values are never exposed.
 */

import type { GatewayConfig } from "../config/types.js";

const REDACTED = "***";

function isEnvTemplate(value: string): boolean {
  return value.startsWith("${") && value.endsWith("}");
}

export function scrubConfig(config: GatewayConfig): GatewayConfig {
  const copy = structuredClone(config);

  for (const target of copy.targets) {
    if (!isEnvTemplate(target.apiKey)) {
      target.apiKey = REDACTED;
    }
  }

  if (copy.adminSecret !== undefined) {
    copy.adminSecret = REDACTED;
  }

  if (copy.mcpServers !== undefined) {
    for (const server of copy.mcpServers) {
      if (server.headers !== undefined && server.headers["Authorization"] !== undefined) {
        server.headers["Authorization"] = REDACTED;
      }
      if (server.env !== undefined) {
        for (const key of Object.keys(server.env)) {
          server.env[key] = REDACTED;
        }
      }
    }
  }

  return copy;
}

export function scrubConfigJson(configJson: string): string {
  return JSON.stringify(scrubConfig(JSON.parse(configJson) as GatewayConfig));
}
