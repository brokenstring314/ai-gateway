/**
 * Input bounds checked before a request does any work (red team 2026-11-05):
 *
 *  - D3: the requested model name. It is echoed into error messages, request
 *    logs, usage rows and stdout, so an unbounded name multiplied every
 *    request into megabytes on disk (5 × 9 MB names → +352 MB). A name longer
 *    than MAX_MODEL_NAME_LENGTH characters, or one carrying control / bidi
 *    characters, is a 400 before plugins, the model lookup or any upstream.
 *  - D3: every user- or upstream-derived string written to the request log
 *    (model, published model, error text …) is cut to a fixed size as well.
 */

import { clampText } from "../observability/redact.js";
import type { RequestLogEntry } from "../observability/request-log.js";
import { invalidRequest, type GatewayError } from "./errors.js";

/** Longest model name a request may name (published names are much shorter in practice). */
export const MAX_MODEL_NAME_LENGTH = 256;

/** Longest model / channel / plugin string kept in a request-log entry. */
export const MAX_LOG_NAME_LENGTH = 256;
/** Longest error text kept in a request-log entry. */
export const MAX_LOG_ERROR_LENGTH = 2048;

/** C0 / DEL / C1 controls, line / paragraph separators, bidi embeddings / overrides / isolates, BOM. */
function isForbiddenModelChar(c: number): boolean {
  return (
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0xfeff
  );
}

/** The 400 for a model name that is too long or carries control characters, else undefined. */
export function modelNameProblem(name: string): GatewayError | undefined {
  if (name.length > MAX_MODEL_NAME_LENGTH) {
    return invalidRequest(
      `The model name is ${name.length} characters long; model names are at most ${MAX_MODEL_NAME_LENGTH} characters. ` +
        "GET /v1/models lists the models you can use.",
      "invalid_model_name",
      "model",
    );
  }
  for (let i = 0; i < name.length; i++) {
    if (isForbiddenModelChar(name.charCodeAt(i))) {
      return invalidRequest(
        "The model name contains control or formatting characters. GET /v1/models lists the models you can use.",
        "invalid_model_name",
        "model",
      );
    }
  }
  return undefined;
}

/** A model name safe to log / label: at most MAX_MODEL_NAME_LENGTH characters. */
export function loggableModelName(name: string): string {
  return clampText(name, MAX_MODEL_NAME_LENGTH);
}

/** `entry` with every free-form string cut to its log size (a copy only when something was cut). */
export function boundLogEntry(entry: RequestLogEntry): RequestLogEntry {
  const model = clampText(entry.model, MAX_LOG_NAME_LENGTH);
  const publishedModel =
    entry.publishedModel === undefined ? undefined : clampText(entry.publishedModel, MAX_LOG_NAME_LENGTH);
  const provider = clampText(entry.provider, MAX_LOG_NAME_LENGTH);
  const plugin = entry.plugin === undefined ? undefined : clampText(entry.plugin, MAX_LOG_NAME_LENGTH);
  const error = entry.error === undefined ? undefined : clampText(entry.error, MAX_LOG_ERROR_LENGTH);
  const requestId = clampText(entry.requestId, MAX_LOG_NAME_LENGTH);
  if (
    model === entry.model &&
    publishedModel === entry.publishedModel &&
    provider === entry.provider &&
    plugin === entry.plugin &&
    error === entry.error &&
    requestId === entry.requestId
  ) {
    return entry;
  }
  return {
    ...entry,
    model,
    provider,
    requestId,
    ...(publishedModel !== undefined ? { publishedModel } : {}),
    ...(plugin !== undefined ? { plugin } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}
