/**
 * Pass-through proxy surface (plan 2.8, S3-6).
 *
 * The pipeline surface for proxied `/v1/*` requests (before plugins only;
 * the proxy forwards the body) plus pure helpers:
 *  - the method+path allow-list for `/v1/*` routes the gateway does not own
 *    (default: stateless POST endpoints only, so one tenant can never list,
 *    read or delete the upstream account's stored objects — files, stored
 *    completions, responses, batches, vector stores — with the operator key);
 *  - the methods of gateway-owned routes (any other method → 405);
 *  - mapping a proxied body's token limit (`max_output_tokens` /
 *    `max_tokens` / `max_completion_tokens`) into the plugin view and writing
 *    a capped value back, so the max-token plugin applies to proxied bodies.
 */

import { PluginRejectionError } from "../../plugins/error.js";
import { settlePluginContext } from "../../plugins/context.js";
import type { ChatCompletionRequest, RequestContext } from "../../providers/types.js";
import type { Pipeline } from "../pipeline.js";
import type { Surface } from "../types.js";

/** Routes forwarded when `passthroughProxy.routes` is not configured. */
export const DEFAULT_PASSTHROUGH_ROUTES: readonly string[] = [
  "POST /v1/responses",
  "POST /v1/moderations",
  "POST /v1/audio/*",
];

/** Allowed methods of the gateway's own /v1 routes (see server/route-path.ts). */
export const GATEWAY_ROUTE_METHODS: Readonly<Record<string, readonly string[]>> = {
  "/v1/chat/completions": ["POST"],
  "/v1/completions": ["POST"],
  "/v1/embeddings": ["POST"],
  "/v1/images/generations": ["POST"],
  "/v1/models": ["GET", "HEAD"],
  "/v1/capabilities": ["GET", "HEAD"],
};

/** `METHOD /v1/path`, path optionally ending in `/*` (any sub-path, at least one segment). */
export const PASSTHROUGH_ROUTE_PATTERN = /^(GET|POST|PUT|PATCH|DELETE|\*) (\/v1(?:\/[A-Za-z0-9._~:@!$&'()+,;=-]+)*)(\/\*)?$/;

interface CompiledRoute {
  readonly method: string;
  readonly path: string;
  readonly prefix: boolean;
}

export type RouteAllowlist = (method: string, path: string) => boolean;

/** Compile allow-list entries ("POST /v1/responses", "POST /v1/audio/*"). Throws on a malformed entry. */
export function compileRouteAllowlist(routes: readonly string[] = DEFAULT_PASSTHROUGH_ROUTES): RouteAllowlist {
  const compiled: CompiledRoute[] = routes.map((entry) => {
    const m = PASSTHROUGH_ROUTE_PATTERN.exec(entry.trim());
    if (!m) throw new Error(`invalid passthroughProxy.routes entry: ${JSON.stringify(entry)} (expected "METHOD /v1/path" or "METHOD /v1/prefix/*")`);
    return { method: m[1]!, path: m[2]!, prefix: m[3] !== undefined };
  });
  return (method, path) => {
    // Encoded separators / backslashes could address a different upstream
    // path than the one checked here: never forward them.
    if (/%2f|%5c|\\/i.test(path)) return false;
    const p = path.replace(/\/{2,}/g, "/");
    const verb = method.toUpperCase();
    return compiled.some((r) =>
      (r.method === "*" || r.method === verb) &&
      (r.prefix ? p.startsWith(`${r.path}/`) && p.length > r.path.length + 1 : p === r.path));
  };
}

// ── Token limit ↔ plugin view ──

const TOKEN_FIELDS = ["max_output_tokens", "max_completion_tokens", "max_tokens"] as const;
export type PassthroughTokenField = (typeof TOKEN_FIELDS)[number];

/**
 * Which body field carries the output token limit: the one the client sent,
 * else `max_output_tokens` for the Responses API (so a cap can be injected
 * when the client omitted it), else none (moderations, audio: no limit).
 */
export function passthroughTokenField(path: string, body: Readonly<Record<string, unknown>>): PassthroughTokenField | undefined {
  for (const f of TOKEN_FIELDS) {
    if (typeof body[f] === "number") return f;
  }
  if (path === "/v1/responses" || path.startsWith("/v1/responses/")) return "max_output_tokens";
  return undefined;
}

/** The plugin view's `maxTokens` for a proxied body (undefined when absent / not applicable). */
export function passthroughMaxTokens(body: Readonly<Record<string, unknown>>, field: PassthroughTokenField | undefined): number | undefined {
  if (field === undefined) return undefined;
  const v = body[field];
  return typeof v === "number" ? v : undefined;
}

/**
 * Write the plugin view's token limit back onto the body. Returns the new body
 * text, or undefined when nothing changed. Only lowering (or setting an
 * absent) limit is honoured; content changes are handled by the caller.
 */
export function applyPassthroughMaxTokens(
  body: Readonly<Record<string, unknown>>,
  field: PassthroughTokenField | undefined,
  viewMaxTokens: number | undefined,
): string | undefined {
  if (field === undefined || viewMaxTokens === undefined) return undefined;
  const current = body[field];
  if (typeof current === "number" && current <= viewMaxTokens) return undefined;
  return JSON.stringify({ ...body, [field]: viewMaxTokens });
}

// ── Before plugins for a proxied request ──

/**
 * Run the before-request plugins for a pass-through proxy request whose
 * body shape is unknown. Text is taken from top-level `messages`, `input`
 * (string, string[] or Responses-style items) or `prompt`; bodies that are
 * not JSON still go through key-scoped plugins (rate-limit, budget check)
 * with no messages. Throws PluginRejectionError to block the request.
 * The body's output token limit is the plugin view's `maxTokens`; when a
 * plugin caps it (max-token) the rewritten body text is returned and must be
 * forwarded instead of the original (S3-6). Otherwise returns undefined.
 */
export async function runPassthroughBefore(
  pipeline: Pipeline,
  ctx: RequestContext,
  bodyText: string | undefined,
  path = "",
): Promise<string | undefined> {
  let body: unknown;
  try {
    body = bodyText !== undefined && bodyText !== "" ? JSON.parse(bodyText) : undefined;
  } catch {
    body = undefined;
  }
  const obj = body !== null && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const isJsonObject = body !== null && typeof body === "object" && !Array.isArray(body);
  const tokenField = isJsonObject ? passthroughTokenField(path, obj) : undefined;
  const maxTokens = passthroughMaxTokens(obj, tokenField);
  const request: ChatCompletionRequest = {
    model: typeof obj["model"] === "string" ? obj["model"] : "",
    messages: extractPassthroughMessages(obj),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
  const begun = await pipeline.begin(passthroughSurface, request, ctx);
  // Forwarded by the proxy: nothing more to account here, but release
  // whatever the before plugins reserved (budget).
  settlePluginContext(begun.run.pluginCtx);
  const view = begun.run.pluginCtx.request;
  return applyPassthroughMaxTokens(obj, tokenField, view.maxTokens ?? view.maxCompletionTokens);
}

// ── Surface ──

/**
 * Pass-through proxy routes: an arbitrary body cannot be rewritten
 * faithfully, so a plugin that modifies the message content (e.g.
 * word-filter redact) or short-circuits causes a rejection instead of
 * forwarding the original text.
 */
export const passthroughSurface: Surface<ChatCompletionRequest, never> = {
  name: "passthrough",
  capability: "raw",
  logLabel: "passthrough",
  pluginSurfaceTag: "passthrough",
  candidates: "strategy",
  model: (req) => req.model,
  withModel: (req, model) => (model === req.model ? req : { ...req, model }),
  toPluginView: (req) => req,
  applyPluginView: (req, view) => {
    if (JSON.stringify(view.messages) !== JSON.stringify(req.messages)) {
      throw new PluginRejectionError(
        "before_request",
        "Request content was modified by a plugin; pass-through proxy routes cannot forward modified content",
        undefined,
      );
    }
    return req;
  },
  supports: () => false,
  call: () => Promise.reject(new Error("pass-through requests are forwarded by the proxy")),
  usage: () => undefined,
  toPluginResponse: () => undefined,
  fromShortCircuit: () => undefined,
  shortCircuitUnsupported: "Plugin short-circuit is not supported on pass-through proxy routes",
};

type PassthroughMessage = ChatCompletionRequest["messages"][number];

/** Best-effort text extraction from an unknown OpenAI-style request body. */
function extractPassthroughMessages(body: Record<string, unknown>): PassthroughMessage[] {
  const out: PassthroughMessage[] = [];
  const pushText = (text: unknown, role: unknown = "user") => {
    const t = textOf(text);
    if (t !== undefined) out.push({ role: (typeof role === "string" ? role : "user") as PassthroughMessage["role"], content: t });
  };
  const fromItems = (items: unknown) => {
    if (typeof items === "string") return pushText(items);
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (typeof item === "string") pushText(item);
      else if (item !== null && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        pushText(rec["content"] ?? rec["text"], rec["role"]);
      }
    }
  };
  fromItems(body["messages"]);
  fromItems(body["input"]);
  fromItems(body["prompt"]);
  pushText(body["instructions"], "system");
  return out;
}

function textOf(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const parts = v.map((p) => {
      if (typeof p === "string") return p;
      if (p !== null && typeof p === "object") {
        const t = (p as Record<string, unknown>)["text"];
        return typeof t === "string" ? t : "";
      }
      return "";
    }).filter((t) => t !== "");
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
}
