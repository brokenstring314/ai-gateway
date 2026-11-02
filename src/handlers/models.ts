/**
 * Models handler — GET /v1/models
 *
 * Lists the published models (and aliases of them) the caller's API key may
 * use, in OpenAI's format. Published metadata rides along as extension
 * fields (OpenAI SDKs ignore unknown fields). Disabled models are hidden;
 * a published model with no usable channel right now is listed with
 * `available: false` (requests get 503 model_unavailable).
 */

import type { AppType } from "../app.js";
import type { Gateway } from "../gateway.js";
import { modelAllowed } from "../routing/model-catalog.js";

export function registerModelsHandler(app: AppType, gateway: Gateway): void {
  app.get("/v1/models", (c) => {
    const allowed = c.get("allowedModels");
    const catalog = gateway.modelCatalog();
    const data: Record<string, unknown>[] = [];
    for (const e of catalog.list()) {
      if (!e.enabled || !modelAllowed(allowed, e.name, e.name)) continue;
      data.push({
        id: e.name,
        object: "model",
        created: 0,
        owned_by: e.targets[0] ?? "gateway",
        ...(e.displayName !== undefined ? { display_name: e.displayName } : {}),
        ...(e.description !== undefined ? { description: e.description } : {}),
        ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
        ...(e.available ? {} : { available: false }),
      });
    }
    for (const [alias, target] of Object.entries(catalog.aliasMap())) {
      const e = catalog.lookup(alias);
      if (!e || !e.enabled || !modelAllowed(allowed, alias, target)) continue;
      data.push({
        id: alias,
        object: "model",
        created: 0,
        owned_by: e.targets[0] ?? "gateway",
        alias_of: target,
        ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
        ...(e.available ? {} : { available: false }),
      });
    }
    return c.json({ object: "list", data }, 200);
  });
}
