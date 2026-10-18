/**
 * pii-secret-guard: detect PII and credentials in what goes to (and,
 * optionally, what comes back from) the model, and block, redact or log.
 *
 * What is scanned
 *   request  every message whose role is in `roles`: string content, every
 *            text content part, and (scanToolArguments) assistant tool-call
 *            arguments. /v1/completions `prompt` and /v1/embeddings `input`
 *            arrive as user messages; pass-through bodies arrive as the
 *            messages the proxy extracted (messages / input / prompt /
 *            instructions).
 *   response non-streaming chat and completions only: choice message content
 *            and tool-call arguments. Streaming responses are NOT scanned
 *            (documented): a chunk-boundary-aware scanner would have to hold
 *            back output to be safe, and a block decided after bytes have
 *            reached the client cannot be undone. Request scanning still
 *            applies to streaming requests.
 *
 * Actions
 *   block    400 (request) / 422 (response), OpenAI-shaped error with code
 *            `secret_detected` or `pii_detected`. The message names entity
 *            TYPES only; the matched value is never echoed.
 *   redact   the value is replaced by a typed placeholder ([EMAIL],
 *            [SECRET:github_token], [CUSTOM:name]); the text is rewritten in
 *            its canonical (NFKC) form. On pass-through routes, which cannot
 *            forward a rewritten body, a redact detection is blocked instead.
 *   log      recorded (request log `guardrail`, detections metric), forwarded.
 *
 * One request mixing actions: any block → blocked; else redactions applied
 * and log-only detections recorded.
 *
 * Nothing here ever logs, stores or returns a matched value: metadata,
 * metrics and errors carry entity names and counts only.
 */

import { getMetrics } from "../../../metrics/metrics.js";
import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage } from "../../../providers/types.js";
import { PluginRejectionError } from "../../error.js";
import type { IPlugin, PluginContext, PluginResult, Stage } from "../../types.js";
import type { GuardAction, GuardSurface, ResolvedGuardConfig } from "./config.js";
import { canonicalize, detect, type Category, type Finding, redact } from "./detectors.js";

export const PII_SECRET_GUARD_NAME = "pii-secret-guard";

/** What one screening pass decided; also what lands in the request log (`guardrail`). */
export interface GuardrailRecord {
  readonly plugin: string;
  readonly direction: "request" | "response";
  /** Most severe action taken: blocked > redacted > logged. */
  readonly action: "blocked" | "redacted" | "logged";
  /** Entity types detected, sorted, unique. Never values. */
  readonly entities: readonly string[];
}

/** Metadata key the pipeline copies into the request-log entry. */
export const GUARDRAIL_METADATA_KEY = "_guardrail";

type Direction = GuardrailRecord["direction"];

interface Slot {
  /** Canonical text the findings index into. */
  readonly text: string;
  readonly findings: readonly Finding[];
  /** Slot is a JSON document (tool-call arguments): redaction must keep it parseable. */
  readonly json: boolean;
  readonly rawJsonValid: boolean;
}

const SEVERITY: Record<GuardAction, number> = { log: 0, redact: 1, block: 2 };

function surfaceOf(ctx: PluginContext): GuardSurface | "images" | undefined {
  const s = ctx.metadata["_surfaceName"];
  if (s === undefined) return "chat"; // plugin driven directly (no pipeline): the chat default
  if (s === "chat" || s === "completions" || s === "embeddings" || s === "passthrough" || s === "images") return s;
  return undefined;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export class PiiSecretGuardPlugin implements IPlugin {
  readonly name = PII_SECRET_GUARD_NAME;

  constructor(
    private readonly cfg: ResolvedGuardConfig,
    readonly stage: Stage = "before_request",
  ) {}

  async execute(ctx: PluginContext): Promise<PluginResult> {
    if (this.stage === "before_request") return this.screenRequest(ctx);
    if (this.stage === "after_request") this.screenResponse(ctx);
    return { action: "continue" };
  }

  // ── request ──

  private screenRequest(ctx: PluginContext): PluginResult {
    if (!this.cfg.scanRequest) return { action: "continue" };
    const surface = surfaceOf(ctx);
    if (surface === undefined || surface === "images" || !this.cfg.surfaces.has(surface)) return { action: "continue" };

    const slots = new Map<string, Slot>();
    const all: Finding[] = [];
    const messages = ctx.request.messages ?? [];
    messages.forEach((msg, mi) => {
      if (!this.cfg.roles.has(msg.role)) return;
      if (typeof msg.content === "string") this.scanSlot(slots, all, `${mi}`, msg.content, false);
      else if (Array.isArray(msg.content)) {
        msg.content.forEach((part, pi) => {
          if (typeof part.text === "string") this.scanSlot(slots, all, `${mi}:p${pi}`, part.text, false);
        });
      }
      if (this.cfg.scanToolArguments && Array.isArray(msg.toolCalls)) {
        msg.toolCalls.forEach((tc, ti) => {
          const args = tc?.function?.arguments;
          if (typeof args === "string") this.scanSlot(slots, all, `${mi}:t${ti}`, args, true);
        });
      }
    });
    if (all.length === 0) return { action: "continue" };

    const verdict = this.verdict(all);
    if (verdict === "block") return this.reject(ctx, all, "request");

    if (verdict === "redact") {
      if (surface === "passthrough") {
        return this.reject(ctx, all, "request", "; content cannot be redacted on pass-through routes");
      }
      const rewritten = this.rewriteRequest(ctx.request, slots);
      if (rewritten === undefined) {
        return this.reject(ctx, all, "request", "; content could not be redacted safely");
      }
      this.record(ctx, all, "request", "redacted");
      return { action: "modify", request: rewritten };
    }

    this.record(ctx, all, "request", "logged");
    return { action: "continue" };
  }

  private rewriteRequest(req: ChatCompletionRequest, slots: Map<string, Slot>): ChatCompletionRequest | undefined {
    let failed = false;
    const fix = (key: string, original: string): string => {
      const slot = slots.get(key);
      if (!slot) return original;
      const out = this.redactSlot(slot);
      if (out === undefined) failed = true;
      return out ?? original;
    };
    const messages: ChatMessage[] = req.messages.map((msg, mi) => {
      if (!this.cfg.roles.has(msg.role)) return msg;
      let next: ChatMessage = msg;
      if (typeof msg.content === "string") {
        const content = fix(`${mi}`, msg.content);
        if (content !== msg.content) next = { ...next, content };
      } else if (Array.isArray(msg.content)) {
        let changed = false;
        const parts = msg.content.map((part, pi) => {
          if (typeof part.text !== "string") return part;
          const text = fix(`${mi}:p${pi}`, part.text);
          if (text === part.text) return part;
          changed = true;
          return { ...part, text };
        });
        if (changed) next = { ...next, content: parts };
      }
      if (this.cfg.scanToolArguments && Array.isArray(msg.toolCalls)) {
        let changed = false;
        const calls = msg.toolCalls.map((tc, ti) => {
          const args = tc?.function?.arguments;
          if (typeof args !== "string") return tc;
          const fixed = fix(`${mi}:t${ti}`, args);
          if (fixed === args) return tc;
          changed = true;
          return { ...tc, function: { ...tc.function, arguments: fixed } };
        });
        if (changed) next = { ...next, toolCalls: calls };
      }
      return next;
    });
    return failed ? undefined : { ...req, messages };
  }

  // ── response (non-streaming) ──

  private screenResponse(ctx: PluginContext): void {
    if (!this.cfg.scanResponse) return;
    const surface = surfaceOf(ctx);
    if (surface !== "chat" && surface !== "completions") return;
    if (!this.cfg.surfaces.has(surface)) return;
    // Streaming responses are not scanned (see the module comment).
    if (ctx.metadata["_streaming"] === true || ctx.request.stream === true) return;
    const res = ctx.response;
    if (!res || !Array.isArray(res.choices as unknown)) return;

    const slots = new Map<string, Slot>();
    const all: Finding[] = [];
    res.choices.forEach((choice, ci) => {
      const msg = choice.message;
      if (!msg) return;
      if (typeof msg.content === "string") this.scanSlot(slots, all, `${ci}`, msg.content, false);
      else if (Array.isArray(msg.content)) {
        msg.content.forEach((part, pi) => {
          if (typeof part.text === "string") this.scanSlot(slots, all, `${ci}:p${pi}`, part.text, false);
        });
      }
      if (this.cfg.scanToolArguments && Array.isArray(msg.toolCalls)) {
        msg.toolCalls.forEach((tc, ti) => {
          const args = tc?.function?.arguments;
          if (typeof args === "string") this.scanSlot(slots, all, `${ci}:t${ti}`, args, true);
        });
      }
    });
    if (all.length === 0) return;

    const verdict = this.verdict(all);
    if (verdict === "redact") {
      const rewritten = this.rewriteResponse(res, slots);
      if (rewritten !== undefined) {
        this.record(ctx, all, "response", "redacted");
        ctx.response = rewritten;
        return;
      }
    }
    if (verdict === "block" || verdict === "redact") {
      const result = this.reject(ctx, all, "response");
      throw new PluginRejectionError("after_request", result.reason, this.name, result.status, undefined, {
        code: result.code,
        type: result.type,
      });
    }
    this.record(ctx, all, "response", "logged");
  }

  private rewriteResponse(res: ChatCompletionResponse, slots: Map<string, Slot>): ChatCompletionResponse | undefined {
    let failed = false;
    const fix = (key: string, original: string): string => {
      const slot = slots.get(key);
      if (!slot) return original;
      const out = this.redactSlot(slot);
      if (out === undefined) failed = true;
      return out ?? original;
    };
    const choices = res.choices.map((choice, ci) => {
      const msg = choice.message;
      if (!msg) return choice;
      let next: ChatMessage = msg;
      if (typeof msg.content === "string") {
        const content = fix(`${ci}`, msg.content);
        if (content !== msg.content) next = { ...next, content };
      } else if (Array.isArray(msg.content)) {
        next = {
          ...next,
          content: msg.content.map((part, pi) =>
            typeof part.text === "string" ? { ...part, text: fix(`${ci}:p${pi}`, part.text) } : part,
          ),
        };
      }
      if (this.cfg.scanToolArguments && Array.isArray(msg.toolCalls)) {
        next = {
          ...next,
          toolCalls: msg.toolCalls.map((tc, ti) =>
            typeof tc?.function?.arguments === "string"
              ? { ...tc, function: { ...tc.function, arguments: fix(`${ci}:t${ti}`, tc.function.arguments) } }
              : tc,
          ),
        };
      }
      return next === msg ? choice : { ...choice, message: next };
    });
    return failed ? undefined : { ...res, choices };
  }

  // ── shared ──

  private scanSlot(slots: Map<string, Slot>, all: Finding[], key: string, raw: string, json: boolean): void {
    if (raw === "") return;
    const text = canonicalize(raw);
    const findings = detect(
      text,
      this.cfg.detectors,
      { entropyThreshold: this.cfg.entropyThreshold },
      this.cfg.allowlist,
    );
    if (findings.length === 0) return;
    slots.set(key, { text, findings, json, rawJsonValid: json && isJson(raw) });
    all.push(...findings);
  }

  /** Redacted canonical text, or undefined when a JSON slot would stop parsing. */
  private redactSlot(slot: Slot): string | undefined {
    const out = redact(
      slot.text,
      slot.findings,
      (f) => this.cfg.actionOf(f.entity, f.category) === "redact",
      (f) => this.placeholder(f),
    );
    if (slot.json && slot.rawJsonValid && !isJson(out)) return undefined;
    return out;
  }

  private placeholder(f: Finding): string {
    if (this.cfg.customEntities.has(f.entity)) return `[CUSTOM:${f.entity}]`;
    if (f.category === "secret") return `[SECRET:${f.entity}]`;
    return `[${f.entity.toUpperCase()}]`;
  }

  private verdict(findings: readonly Finding[]): GuardAction {
    let worst: GuardAction = "log";
    for (const f of findings) {
      const a = this.cfg.actionOf(f.entity, f.category);
      if (SEVERITY[a] > SEVERITY[worst]) worst = a;
    }
    return worst;
  }

  private reject(
    ctx: PluginContext,
    findings: readonly Finding[],
    direction: Direction,
    suffix = "",
  ): { action: "reject"; reason: string; status: number; code: string; type: string } {
    this.record(ctx, findings, direction, "blocked");
    const enforced = findings.filter((f) => this.cfg.actionOf(f.entity, f.category) !== "log");
    const secret = enforced.some((f) => f.category === "secret");
    const category: Category = secret ? "secret" : "pii";
    const entities = [...new Set(enforced.filter((f) => f.category === category).map((f) => f.entity))].sort();
    const what = category === "secret" ? "secret" : "PII";
    const subject = direction === "request" ? "Request" : "Response";
    return {
      action: "reject",
      reason: `${subject} blocked by content policy: ${what} detected (${entities.join(", ")})${suffix}`,
      status: direction === "request" ? 400 : 422,
      code: secret ? "secret_detected" : "pii_detected",
      type: "invalid_request_error",
    };
  }

  /** Request-log record and detection metrics: entity types and counts only. */
  private record(
    ctx: PluginContext,
    findings: readonly Finding[],
    direction: Direction,
    action: GuardrailRecord["action"],
  ): void {
    const entities = [...new Set(findings.map((f) => f.entity))].sort();
    const rec: GuardrailRecord = { plugin: this.name, direction, action, entities };
    const prev = ctx.metadata[GUARDRAIL_METADATA_KEY];
    ctx.metadata[GUARDRAIL_METADATA_KEY] = Array.isArray(prev) ? [...prev, rec] : [rec];
    const metrics = getMetrics();
    for (const f of findings) {
      metrics.recordGuardrailDetection(f.entity, f.category, this.cfg.actionOf(f.entity, f.category), direction);
    }
  }
}
