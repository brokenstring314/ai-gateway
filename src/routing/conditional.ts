/**
 * Conditional strategy — routes based on request field matching rules.
 */

import type { IStrategy, StrategyMode, ProviderLookup } from "./types.js";
import type {
  RequestContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  IStreamProvider,
} from "../providers/types.js";
import type {
  ConditionalConfig,
  ConditionalRule,
} from "./strategy-factory.js";
import type { RetryConfig } from "../config/types.js";
import { executeCandidates, streamCandidates, type CandidateHooks } from "./executor.js";

export class ConditionalStrategy implements IStrategy {
  public readonly mode: StrategyMode = "conditional";
  private readonly rules: readonly ConditionalRule[];
  private readonly defaultTarget: string | undefined;
  private readonly lookup: ProviderLookup;
  private readonly retryConfigs: ReadonlyMap<string, RetryConfig>;

  private readonly matchers: ReadonlyArray<(value: string) => boolean>;

  constructor(lookup: ProviderLookup, config: ConditionalConfig) {
    this.lookup = lookup;
    this.retryConfigs = config.retryConfigs ?? new Map();
    this.rules = config.rules;
    this.defaultTarget = config.defaultTarget;
    // Compile once; a malformed regex fails at startup, not per request.
    this.matchers = this.rules.map((rule) => compileRule(rule));
  }

  selectTargets(req: ChatCompletionRequest): string[] {
    const matched = this.findMatchingRule(req);
    const result: string[] = [];
    if (matched) result.push(matched.target);

    // Append default if not already included
    if (this.defaultTarget && this.defaultTarget !== matched?.target) {
      result.push(this.defaultTarget);
    }

    // Append other unique targets from rules
    for (const rule of this.rules) {
      if (rule.target !== matched?.target && rule.target !== this.defaultTarget) {
        if (!result.includes(rule.target)) result.push(rule.target);
      }
    }

    return result;
  }

  private hooks(): CandidateHooks {
    return {
      label: "ConditionalStrategy",
      retryConfigFor: (name) => this.retryConfigs.get(name),
    };
  }

  async execute(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    return executeCandidates(ctx, this.executionTargets(req), this.lookup, (p) => p.complete(ctx, req), this.hooks());
  }

  async *executeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    yield* streamCandidates(
      ctx,
      this.executionTargets(req),
      this.lookup,
      (p) => (p as IStreamProvider).completeStream(ctx, req),
      this.hooks(),
    );
  }

  /**
   * Execution candidates: the matched rule's target, then the default
   * target as failover. Other rules' targets are not used: they serve
   * different request content.
   */
  private executionTargets(req: ChatCompletionRequest): string[] {
    const matched = this.findMatchingRule(req)?.target;
    if (!matched && !this.defaultTarget) {
      throw new Error(
        "ConditionalStrategy: no rule matched and no defaultTarget configured",
      );
    }
    const out: string[] = [];
    if (matched) out.push(matched);
    if (this.defaultTarget && this.defaultTarget !== matched) out.push(this.defaultTarget);
    return out;
  }


  private findMatchingRule(
    req: ChatCompletionRequest,
  ): ConditionalRule | undefined {
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i]!;
      const fieldValue = getRequestField(req, rule.field);
      if (fieldValue !== undefined && this.matchers[i]!(fieldValue)) return rule;
    }
    return undefined;
  }
}

function compileRule(rule: ConditionalRule): (value: string) => boolean {
  if (rule.contains !== undefined) {
    const needle = rule.contains.toLowerCase();
    return (value) => value.toLowerCase().includes(needle);
  }
  if (rule.pattern !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern);
    } catch (err) {
      throw new Error(
        `ConditionalStrategy: invalid pattern for rule → ${rule.target}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return (value) => re.test(value);
  }
  throw new Error(`ConditionalStrategy: rule → ${rule.target} needs "pattern" or "contains"`);
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((p): p is { type: string; text: string } =>
        typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => p.text);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
}

function getRequestField(
  req: ChatCompletionRequest,
  field: string,
): string | undefined {
  switch (field) {
    case "model":
      return req.model;
    case "user":
      return req.user;
    case "message": {
      const first = req.messages[0];
      if (first && typeof first.content === "string") return first.content;
      return undefined;
    }
    case "prompt": {
      // Text of every user message, newline-joined (what content_based matched on).
      const texts: string[] = [];
      for (const m of req.messages) {
        if (m.role !== "user") continue;
        const t = textOf(m.content);
        if (t !== undefined) texts.push(t);
      }
      return texts.length > 0 ? texts.join("\n") : undefined;
    }
    default:
      return undefined;
  }
}
