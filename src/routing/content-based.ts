/**
 * ContentBased strategy — routes based on text content of prompt messages.
 *
 * Two rule forms are supported:
 *   - `keywords`: keyword → target mappings (legacy config). A message
 *     containing the keyword routes to its target; when several keywords
 *     match, the last defined keyword wins (preserves historical behavior).
 *   - `contentConditions`: ordered Go-style rules with a match type
 *     (prompt_contains | prompt_not_contains | prompt_regex). Rules are
 *     evaluated in declaration order and the first match wins. Regex
 *     patterns are compiled at construction time so an invalid pattern fails
 *     loudly at startup rather than silently misrouting traffic.
 *
 * When no rule matches, the default target is used; without a default target
 * the strategy throws.
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
  ContentBasedConfig,
  ContentBasedMapping,
  ContentBasedRule,
} from "./strategy-factory.js";

interface CompiledCondition {
  readonly rule: ContentBasedRule;
  readonly re: RegExp | undefined;
}

export class ContentBasedStrategy implements IStrategy {
  public readonly mode: StrategyMode = "content_based";
  private readonly keywords: readonly ContentBasedMapping[];
  private readonly conditions: readonly CompiledCondition[];
  private readonly defaultTarget: string | undefined;
  private readonly lookup: ProviderLookup;

  constructor(lookup: ProviderLookup, config: ContentBasedConfig) {
    this.lookup = lookup;
    this.keywords = config.keywords ?? [];
    this.defaultTarget = config.defaultTarget;

    // Compile prompt_regex rules at construction; a malformed pattern is a
    // configuration error and must surface immediately (Go parity).
    this.conditions = (config.contentConditions ?? []).map((rule, index) => {
      let re: RegExp | undefined;
      if (rule.type === "prompt_regex") {
        try {
          re = new RegExp(rule.value);
        } catch (err) {
          throw new Error(
            `ContentBasedStrategy: invalid regex "${rule.value}" in rule ${index}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return { rule, re };
    });
  }

  selectTargets(req: ChatCompletionRequest): string[] {
    const matched = this.findMatchingTarget(req);
    const result: string[] = [];
    if (matched) result.push(matched);

    if (this.defaultTarget && this.defaultTarget !== matched) {
      result.push(this.defaultTarget);
    }

    const others = [
      ...this.keywords.map((k) => k.target),
      ...this.conditions.map((c) => c.rule.target),
    ];
    for (const target of others) {
      if (target !== matched && target !== this.defaultTarget) {
        if (!result.includes(target)) result.push(target);
      }
    }

    return result;
  }

  async execute(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const target = this.resolveTarget(req);
    const provider = this.lookup(target);
    if (!provider) {
      throw new Error(
        `ContentBasedStrategy: provider "${target}" not found`,
      );
    }
    return provider.complete(ctx, req);
  }

  async *executeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    const target = this.resolveTarget(req);
    const provider = this.lookup(target);
    if (!provider || !("completeStream" in provider)) {
      throw new Error(
        `ContentBasedStrategy: streaming provider "${target}" not found`,
      );
    }
    yield* (provider as IStreamProvider).completeStream(ctx, req);
  }

  private resolveTarget(req: ChatCompletionRequest): string {
    const matched = this.findMatchingTarget(req);
    if (matched) return matched;
    if (this.defaultTarget) return this.defaultTarget;
    throw new Error(
      "ContentBasedStrategy: no keyword matched and no defaultTarget configured",
    );
  }

  private findMatchingTarget(
    req: ChatCompletionRequest,
  ): string | undefined {
    const text = extractUserContent(req);
    if (text !== undefined) {
      const lowered = text.toLowerCase();
      // Keywords: last defined keyword wins (config order priority).
      for (let i = this.keywords.length - 1; i >= 0; i--) {
        const kw = this.keywords[i]!;
        if (lowered.includes(kw.keyword.toLowerCase())) return kw.target;
      }
    }

    // Content conditions: first matching rule wins (Go declaration order).
    const contents = userMessageContents(req);
    for (const compiled of this.conditions) {
      if (this.matchesCondition(compiled, contents)) {
        return compiled.rule.target;
      }
    }

    return undefined;
  }

  private matchesCondition(
    compiled: CompiledCondition,
    contents: string[],
  ): boolean {
    switch (compiled.rule.type) {
      case "prompt_contains": {
        const needle = compiled.rule.value.toLowerCase();
        return contents.some((c) => c.toLowerCase().includes(needle));
      }
      case "prompt_not_contains": {
        const needle = compiled.rule.value.toLowerCase();
        return !contents.some((c) => c.toLowerCase().includes(needle));
      }
      case "prompt_regex":
        return compiled.re !== undefined
          ? contents.some((c) => compiled.re!.test(c))
          : false;
      default:
        return false;
    }
  }
}

function extractUserContent(
  req: ChatCompletionRequest,
): string | undefined {
  for (const msg of req.messages) {
    if (typeof msg.content !== "string") continue;
    if (msg.role === "user" || msg.role === "developer") {
      return msg.content;
    }
  }
  return undefined;
}

function userMessageContents(req: ChatCompletionRequest): string[] {
  const contents: string[] = [];
  for (const msg of req.messages) {
    if (msg.role === "user" && typeof msg.content === "string") {
      contents.push(msg.content);
    }
  }
  return contents;
}
