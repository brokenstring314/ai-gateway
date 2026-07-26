import type { IPlugin, PluginContext, PluginResult, Stage } from "../types.js";
import type { ChatCompletionResponse } from "../../providers/types.js";

export interface CacheConfig {
  readonly ttlSeconds: number;
  readonly maxSize?: number;
}

interface CacheEntry {
  response: ChatCompletionResponse;
  expiresAt: number;
}

/** Module-level shared cache store so separate before/after instances share the same cache. */
const cacheStore = new Map<string, CacheEntry>();

/** Simple FNV-1a hash for cache key compaction. */
function hashString(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export class CachePlugin implements IPlugin {
  readonly name = "cache";
  readonly stage: Stage;

  constructor(
    private readonly config: CacheConfig,
    stage: "before_request" | "after_request",
  ) {
    this.stage = stage;
  }

  async execute(ctx: PluginContext): Promise<PluginResult> {
    if (this.stage === "before_request") {
      return this.handleBeforeRequest(ctx);
    }
    return this.handleAfterRequest(ctx);
  }

  private handleBeforeRequest(ctx: PluginContext): PluginResult {
    const key = this.computeCacheKey(ctx);
    const entry = cacheStore.get(key);

    if (entry !== undefined && entry.expiresAt > Date.now()) {
      return { action: "short_circuit", response: entry.response };
    }

    // Store key in metadata so after_request plugin can access it
    ctx.metadata["_cacheKey"] = key;
    return { action: "continue" };
  }

  private handleAfterRequest(ctx: PluginContext): PluginResult {
    const key = ctx.metadata["_cacheKey"];
    if (typeof key !== "string" || ctx.response === undefined) {
      return { action: "continue" };
    }

    // Enforce max size by evicting oldest entry
    const maxSize = this.config.maxSize;
    if (maxSize !== undefined && cacheStore.size >= maxSize) {
      const firstKey = cacheStore.keys().next().value;
      if (firstKey !== undefined) {
        cacheStore.delete(firstKey);
      }
    }

    cacheStore.set(key, {
      response: ctx.response,
      expiresAt: Date.now() + this.config.ttlSeconds * 1000,
    });

    return { action: "continue" };
  }

  private computeCacheKey(ctx: PluginContext): string {
    const raw = JSON.stringify({
      model: ctx.request.model,
      messages: ctx.request.messages,
    });
    return hashString(raw);
  }
}
