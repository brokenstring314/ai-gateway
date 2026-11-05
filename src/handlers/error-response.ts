/**
 * Hono rendering of the shared error model (core/errors.ts). Every /v1
 * handler answers failures through these two helpers, so status codes and
 * the OpenAI error shape are decided in exactly one place.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  errorBody,
  errorHeaders,
  invalidRequest,
  logGatewayError,
  toGatewayError,
  type GatewayError,
} from "../core/errors.js";
import { inspectJson, MAX_JSON_DEPTH } from "../security/json-guard.js";

/** Render any thrown value as an OpenAI-shaped error response. */
export function respondError(c: Context, err: unknown, signal?: AbortSignal | null): Response {
  const e = toGatewayError(err, {
    signal: signal ?? (c.get("abortController") as AbortController | undefined)?.signal,
  });
  logGatewayError(e);
  return renderError(c, e);
}

export function renderError(c: Context, e: GatewayError): Response {
  return c.json(errorBody(e), e.status as ContentfulStatusCode, errorHeaders(e));
}

/** 400 for a body that is not JSON. */
export function respondInvalidJson(c: Context): Response {
  return renderError(c, invalidRequest("Invalid JSON in request body", "invalid_json"));
}

/** 400 for a body that failed schema validation. */
export function respondValidation(
  c: Context,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Response {
  const text = issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ");
  return renderError(c, invalidRequest(`Validation error: ${text}`, "validation_failed"));
}

/** 400 for a JSON body nested deeper than MAX_JSON_DEPTH (red team 2026-11-05 D5). */
export function jsonTooDeep(): GatewayError {
  return invalidRequest(`The JSON body is nested more than ${MAX_JSON_DEPTH} levels deep.`, "json_too_deep");
}

/**
 * Read and parse a JSON request body, refusing (400) a body that is not JSON
 * or is nested deeper than MAX_JSON_DEPTH: a deeper body would overflow the
 * stack in the first recursive walk after parsing (D5).
 */
export async function readJsonBody(
  c: Context,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return { ok: false, response: respondInvalidJson(c) };
  }
  if (inspectJson(text).tooDeep) return { ok: false, response: renderError(c, jsonTooDeep()) };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: respondInvalidJson(c) };
  }
}
