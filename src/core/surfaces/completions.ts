/**
 * Legacy completions surface (plan 2.6, T3-7): `POST /v1/completions`.
 *
 * Pure functions, no I/O, so the pipeline can wrap them as a Surface:
 *   parseCompletionsRequest     wire body (snake_case; camelCase still accepted)
 *                               → internal chat request, or a validation error
 *   toTextCompletionResponse    internal chat response → OpenAI `text_completion`
 *   createTextCompletionStreamSerializer
 *                               internal stream chunk → `text_completion` chunk
 *
 * The request is served by the chat pipeline (prompt → one user message), so
 * plugins, routing, breakers and fallback all apply. Options that only the
 * legacy endpoint has and that chat cannot express (`echo`, `suffix`,
 * `best_of` > 1, batched / token-array prompts) are rejected with 400 rather
 * than silently ignored.
 */

import { z } from "zod";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  Choice,
  IProvider,
  IStreamProvider,
  StreamChunk,
} from "../../providers/types.js";
import type { Surface } from "../types.js";
import { REQUEST_EXTRA_KEYS, applyExtras, isJsonObject, pickExtras } from "../../providers/wire-extras.js";
import { dropNullFields, toOpenAIWireUsage } from "../../handlers/openai-wire.js";

type Json = Record<string, unknown>;

const SNAKE_TO_CAMEL: Readonly<Record<string, string>> = {
  max_tokens: "maxTokens",
  top_p: "topP",
  presence_penalty: "presencePenalty",
  frequency_penalty: "frequencyPenalty",
  logit_bias: "logitBias",
  best_of: "bestOf",
  stream_options: "streamOptions",
};

/** Internal (camelCase) shape of a legacy completions request. */
export const CompletionsRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.union([z.string(), z.array(z.string())]),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  n: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  streamOptions: z.object({ includeUsage: z.boolean() }).optional(),
  stop: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .optional(),
  maxTokens: z.number().int().positive().nullable().optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  logitBias: z.record(z.string(), z.number()).optional(),
  user: z.string().optional(),
  seed: z.number().int().optional(),
  /** Legacy: number of most likely tokens per position (0–5), not a boolean. */
  logprobs: z
    .union([z.number().int().min(0).max(5), z.boolean()])
    .nullable()
    .optional(),
  topLogprobs: z.number().int().min(0).max(20).optional(),
  echo: z.boolean().optional(),
  suffix: z.string().nullable().optional(),
  bestOf: z.number().int().positive().optional(),
});

export type CompletionsRequest = z.infer<typeof CompletionsRequestSchema>;

export type ParsedCompletions =
  | { ok: true; request: ChatCompletionRequest; logprobs: boolean }
  | { ok: false; issues: readonly { path: (string | number)[]; message: string }[] };

function renameSnake(body: Json): Json {
  const out: Json = { ...body };
  for (const [snake, camel] of Object.entries(SNAKE_TO_CAMEL)) {
    if (snake in out) {
      const v = out[snake];
      delete out[snake];
      if (out[camel] === undefined) out[camel] = v;
    }
  }
  if (isJsonObject(out["streamOptions"])) {
    const so = { ...out["streamOptions"] };
    if ("include_usage" in so && so["includeUsage"] === undefined) so["includeUsage"] = so["include_usage"];
    delete so["include_usage"];
    out["streamOptions"] = so;
  }
  return out;
}

const unsupported = (path: string, message: string) => ({ ok: false as const, issues: [{ path: [path], message }] });

/** Validate a wire body and map it onto the chat request the pipeline runs. */
export function parseCompletionsRequest(body: unknown): ParsedCompletions {
  const parsed = CompletionsRequestSchema.safeParse(isJsonObject(body) ? renameSnake(dropNullFields(body)) : body);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.map((p) => (typeof p === "symbol" ? String(p) : p)),
        message: i.message,
      })),
    };
  }
  const r = parsed.data;

  let prompt: string;
  if (typeof r.prompt === "string") prompt = r.prompt;
  else if (r.prompt.length === 1) prompt = r.prompt[0]!;
  else
    return unsupported(
      "prompt",
      "batched prompts (an array of more than one prompt) are not supported; send one request per prompt",
    );
  if (r.echo === true) return unsupported("echo", "echo is not supported");
  if (r.suffix !== undefined && r.suffix !== null && r.suffix !== "")
    return unsupported("suffix", "suffix (insertion) is not supported");
  if (r.bestOf !== undefined && r.bestOf > 1) return unsupported("best_of", "best_of > 1 is not supported");

  // Legacy logprobs is an integer (top-N alternatives per token); chat uses
  // logprobs: true + top_logprobs: N.
  const lp = r.logprobs;
  const wantLogprobs = lp === true || typeof lp === "number";
  const topLogprobs = r.topLogprobs ?? (typeof lp === "number" && lp > 0 ? lp : undefined);

  const request: ChatCompletionRequest = {
    model: r.model,
    messages: [{ role: "user", content: prompt }],
    ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
    ...(r.topP !== undefined ? { topP: r.topP } : {}),
    ...(r.n !== undefined ? { n: r.n } : {}),
    ...(r.stream !== undefined ? { stream: r.stream } : {}),
    ...(r.streamOptions !== undefined ? { streamOptions: r.streamOptions } : {}),
    ...(r.stop !== undefined && r.stop !== null ? { stop: r.stop } : {}),
    ...(r.maxTokens !== undefined && r.maxTokens !== null ? { maxTokens: r.maxTokens } : {}),
    ...(r.presencePenalty !== undefined ? { presencePenalty: r.presencePenalty } : {}),
    ...(r.frequencyPenalty !== undefined ? { frequencyPenalty: r.frequencyPenalty } : {}),
    ...(r.logitBias !== undefined ? { logitBias: r.logitBias } : {}),
    ...(r.user !== undefined ? { user: r.user } : {}),
    ...(r.seed !== undefined ? { seed: r.seed } : {}),
    ...(wantLogprobs ? { logprobs: true } : {}),
    ...(wantLogprobs && topLogprobs !== undefined ? { topLogprobs } : {}),
  };
  const extra = pickExtras(body, REQUEST_EXTRA_KEYS);
  if (extra) request.extra = extra;
  return { ok: true, request, logprobs: wantLogprobs };
}

// ── Response (internal chat → text_completion) ──

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (isJsonObject(p) && typeof p["text"] === "string" ? p["text"] : "")).join("");
  }
  return "";
}

/**
 * Chat logprobs (`{content: [{token, logprob, top_logprobs: [{token, logprob}]}]}`)
 * → legacy completions logprobs (`{tokens, token_logprobs, top_logprobs, text_offset}`).
 * `offset` is the character offset of the first token (streams continue it).
 */
export function chatLogprobsToLegacy(lp: unknown, offset = 0): Json | null {
  if (!isJsonObject(lp) || !Array.isArray(lp["content"])) return null;
  const tokens: string[] = [];
  const tokenLogprobs: (number | null)[] = [];
  const top: (Record<string, number> | null)[] = [];
  const textOffset: number[] = [];
  let pos = offset;
  for (const item of lp["content"]) {
    if (!isJsonObject(item)) continue;
    const token = typeof item["token"] === "string" ? item["token"] : "";
    tokens.push(token);
    tokenLogprobs.push(typeof item["logprob"] === "number" ? item["logprob"] : null);
    textOffset.push(pos);
    pos += token.length;
    if (Array.isArray(item["top_logprobs"])) {
      const alts: Record<string, number> = {};
      for (const alt of item["top_logprobs"]) {
        if (isJsonObject(alt) && typeof alt["token"] === "string" && typeof alt["logprob"] === "number") {
          alts[alt["token"]] = alt["logprob"];
        }
      }
      top.push(alts);
    } else {
      top.push(null);
    }
  }
  return { tokens, token_logprobs: tokenLogprobs, top_logprobs: top, text_offset: textOffset };
}

function finishReason(reason: string | undefined): string | null {
  return reason ? reason : null;
}

/** Serialise a chat completion as an OpenAI legacy `text_completion`. */
export function toTextCompletionResponse(res: ChatCompletionResponse): Json {
  const out: Json = {
    id: res.id,
    object: "text_completion",
    created: res.created,
    model: res.model,
    choices: res.choices.map((c: Choice) => ({
      text: messageText(c.message?.content),
      index: c.index,
      logprobs: chatLogprobsToLegacy(c.logprobs),
      finish_reason: finishReason(c.finishReason),
    })),
    usage: toOpenAIWireUsage(res.usage),
  };
  return applyExtras(out, res.extra);
}

/**
 * Stateful per-stream serialiser to `text_completion` chunks. Tracks each
 * choice's character offset for legacy logprobs `text_offset`.
 */
export function createTextCompletionStreamSerializer(): (chunk: StreamChunk) => Json {
  const offsets = new Map<number, number>();
  return (chunk) => {
    const out: Json = {
      id: chunk.id,
      object: "text_completion",
      created: chunk.created,
      model: chunk.model,
      choices: chunk.choices.map((c) => {
        const text = messageText((c.delta ?? c.message)?.content);
        const offset = offsets.get(c.index) ?? 0;
        offsets.set(c.index, offset + text.length);
        return {
          text,
          index: c.index,
          logprobs: chatLogprobsToLegacy(c.logprobs, offset),
          finish_reason: finishReason(c.finishReason),
        };
      }),
    };
    if (chunk.usage) out["usage"] = toOpenAIWireUsage(chunk.usage);
    return applyExtras(out, chunk.extra);
  };
}

// ── Surface (core/types.ts) ──

function isStreamProvider(p: IProvider): p is IStreamProvider {
  return typeof (p as Partial<IStreamProvider>).completeStream === "function";
}

/**
 * Pipeline surface for /v1/completions. The request is already mapped to a
 * chat request by parseCompletionsRequest, so upstream calls, plugins and
 * usage are chat's; only the wire shape (serializers above) differs.
 */
export const completionsSurface: Surface<ChatCompletionRequest, ChatCompletionResponse, StreamChunk> = {
  name: "completions",
  capability: "chat",
  logLabel: "completions",
  candidates: "strategy",
  model: (req) => req.model,
  withModel: (req, model) => ({ ...req, model }),
  toPluginView: (req) => req,
  applyPluginView: (_req, view) => view,
  supports: (p) => typeof p.complete === "function",
  call: (p, ctx, req) => p.complete(ctx, req),
  callStream(p, ctx, req) {
    if (!isStreamProvider(p)) throw new Error(`provider ${p.name} does not support streaming`);
    return p.completeStream(ctx, req);
  },
  usage: (res) => res.usage,
  toPluginResponse: (res) => res,
  fromPluginResponse: (_res, view) => view,
  // A short-circuit answers with a chat response, which the serializer
  // renders as a text_completion like any other.
  fromShortCircuit: (pc) => pc.response,
};
