/**
 * Models handler — GET /v1/models
 *
 * Lists all models from all registered providers in OpenAI-compatible format.
 */

import type { AppType } from "../app.js";
import type { Gateway } from "../gateway.js";

export function registerModelsHandler(app: AppType, gateway: Gateway): void {
  app.get("/v1/models", (c) => {
    const models = gateway.listModels();
    const data = models.map((m) => ({
      id: m.id,
      object: "model",
      created: m.created ?? 0,
      owned_by: m.ownedBy,
    }));

    return c.json({
      object: "list",
      data,
    }, 200);
  });
}
