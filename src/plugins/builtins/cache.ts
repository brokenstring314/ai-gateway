import { createHash } from "node:crypto";
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

/** Collision-resistant hash for cache keys (a 32-bit hash could serve one tenant's response to another). */
function hashString(str: string): string {
  return createHash("sha256").update(str).digest("hex");
}

/** JSON.stringify with object keys sorted, so key order never changes the cache key. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
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
    // Only non-streaming chat completions are cacheable: a short-circuit is
    // rejected on the streaming path, and embedding/image surfaces reuse the
    // plugin context with a synthetic chat request.
    if (ctx.request.stream === true || ctx.metadata["_surface"] !== undefined) {
      return { action: "continue" };
    }

    const key = this.computeCacheKey(ctx);
    const entry = cacheStore.get(key);

    if (entry !== undefined && entry.expiresAt > Date.now()) {
      return { action: "short_circuit", response: structuredClone(entry.response) };
    }
    if (entry !== undefined) {
      cacheStore.delete(key);
    }

    // Store key in metadata so after_request plugin can access it
    ctx.metadata["_cacheKey"] = key;
    return { action: "continue" };
  }

  private handleAfterRequest(ctx: PluginContext): PluginResult {
    const key = ctx.metadata["_cacheKey"];
    if (typeof key !== "string" || ctx.response === undefined || ctx.error !== undefined) {
      return { action: "continue" };
    }

    // Re-insert so the entry becomes newest, then evict oldest until within maxSize
    cacheStore.delete(key);
    const maxSize = this.config.maxSize;
    while (maxSize !== undefined && cacheStore.size > 0 && cacheStore.size >= maxSize) {
      const firstKey = cacheStore.keys().next().value;
      if (firstKey === undefined) break;
      cacheStore.delete(firstKey);
    }

    cacheStore.set(key, {
      response: structuredClone(ctx.response),
      expiresAt: Date.now() + this.config.ttlSeconds * 1000,
    });

    return { action: "continue" };
  }

  private computeCacheKey(ctx: PluginContext): string {
    // Every request field can affect the response (n, topP, stop,
    // responseFormat, toolChoice, user, stream, tools, ...), so key on the
    // whole request, scoped to the caller's API key (tenant isolation).
    const tenant = ctx.metadata["api_key"];
    const raw = stableStringify({
      tenant: typeof tenant === "string" ? tenant : null,
      request: ctx.request,
    });
    return hashString(raw);
  }
}
