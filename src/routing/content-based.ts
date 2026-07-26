/**
 * ContentBased strategy — routes based on text content of prompt messages.
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
} from "./strategy-factory.js";

export class ContentBasedStrategy implements IStrategy {
  public readonly mode: StrategyMode = "content_based";
  private readonly keywords: readonly ContentBasedMapping[];
  private readonly defaultTarget: string | undefined;
  private readonly lookup: ProviderLookup;

  constructor(lookup: ProviderLookup, config: ContentBasedConfig) {
    this.lookup = lookup;
    this.keywords = config.keywords;
    this.defaultTarget = config.defaultTarget;
  }

  selectTargets(req: ChatCompletionRequest): string[] {
    const matched = this.findMatchingKeyword(req);
    const result: string[] = [];
    if (matched) result.push(matched.target);

    if (this.defaultTarget && this.defaultTarget !== matched?.target) {
      result.push(this.defaultTarget);
    }

    for (const kw of this.keywords) {
      if (
        kw.target !== matched?.target &&
        kw.target !== this.defaultTarget
      ) {
        if (!result.includes(kw.target)) result.push(kw.target);
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
    const matched = this.findMatchingKeyword(req);
    if (matched) return matched.target;
    if (this.defaultTarget) return this.defaultTarget;
    throw new Error(
      "ContentBasedStrategy: no keyword matched and no defaultTarget configured",
    );
  }

  private findMatchingKeyword(
    req: ChatCompletionRequest,
  ): ContentBasedMapping | undefined {
    const text = extractUserContent(req);
    const lowered = text.toLowerCase();
    // Reversed so last defined keyword wins (config order priority)
    for (let i = this.keywords.length - 1; i >= 0; i--) {
      const kw = this.keywords[i]!;
      if (lowered.includes(kw.keyword.toLowerCase())) return kw;
    }
    return undefined;
  }
}

function extractUserContent(req: ChatCompletionRequest): string {
  for (const msg of req.messages) {
    if (msg.role === "user" && typeof msg.content === "string") {
      return msg.content;
    }
    if (msg.role === "developer" && typeof msg.content === "string") {
      return msg.content;
    }
  }
  return "";
}
