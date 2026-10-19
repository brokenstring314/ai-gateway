/**
 * Legacy completions handler — POST /v1/completions
 *
 * Parses the legacy wire format (core/surfaces/completions.ts), runs it
 * through the pipeline as the completions surface (execute /
 * executeStream), and answers in the OpenAI `text_completion` shape.
 */

import type { AppType } from "../app.js";
import { respondError, respondInvalidJson, respondValidation } from "./error-response.js";
import type { Gateway } from "../gateway.js";
import {
  completionsSurface,
  createTextCompletionStreamSerializer,
  parseCompletionsRequest,
  toTextCompletionResponse,
} from "../core/surfaces/completions.js";
import { mergeForwardedHeaders } from "../providers/response-headers.js";
import { handlerRequest, respondSse } from "./request.js";

export function registerCompletionsHandler(app: AppType, gateway: Gateway): void {
  app.post("/v1/completions", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return respondInvalidJson(c);
    }

    // snake_case wire params (max_tokens, top_p …) mapped onto the chat
    // request the pipeline runs; legacy-only options chat can't express → 400.
    const parsed = parseCompletionsRequest(body);
    if (!parsed.ok) {
      return respondValidation(c, parsed.issues);
    }
    const req = parsed.request;
    const hr = handlerRequest(c);

    if (req.stream) {
      return respondSse(c, gateway, hr, gateway.executeStream(completionsSurface, req, hr.ctx), {
        serialize: createTextCompletionStreamSerializer(),
        headers: () => ({ "X-Gateway-Provider": hr.ctx.servedTarget ?? "unknown" }),
      });
    }

    try {
      const { value } = await gateway.execute(completionsSurface, req, hr.ctx);
      return c.json(
        toTextCompletionResponse(value),
        200,
        mergeForwardedHeaders({ "X-Gateway-Provider": hr.ctx.servedTarget ?? "unknown" }, value.upstreamHeaders),
      );
    } catch (err) {
      return respondError(c, err);
    }
  });
}
