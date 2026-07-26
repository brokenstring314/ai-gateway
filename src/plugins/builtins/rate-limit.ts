import type { IPlugin, PluginContext, PluginResult } from "../types.js";

export interface RateLimitConfig {
  readonly maxRequestsPerMinute: number;
  readonly maxRequestsPerDay?: number;
  readonly key?: string;
}

interface RequestWindow {
  minuteTimestamps: number[];
  dayTimestamps: number[];
}

export class RateLimitPlugin implements IPlugin {
  readonly name = "rate-limit";
  readonly stage = "before_request" as const;
  private readonly windows = new Map<string, RequestWindow>();

  constructor(private readonly config: RateLimitConfig) {}

  async execute(ctx: PluginContext): Promise<PluginResult> {
    const identifier = this.getIdentifier(ctx);
    const now = Date.now();
    const window = this.getOrCreateWindow(identifier);

    // Clean expired timestamps
    const minuteAgo = now - 60_000;
    const dayAgo = now - 86_400_000;
    window.minuteTimestamps = window.minuteTimestamps.filter((t) => t > minuteAgo);
    window.dayTimestamps = window.dayTimestamps.filter((t) => t > dayAgo);

    // Check limits
    if (window.minuteTimestamps.length >= this.config.maxRequestsPerMinute) {
      return {
        action: "reject",
        reason: `Rate limit exceeded: ${String(this.config.maxRequestsPerMinute)} requests per minute`,
      };
    }

    const maxPerDay = this.config.maxRequestsPerDay;
    if (maxPerDay !== undefined && window.dayTimestamps.length >= maxPerDay) {
      return {
        action: "reject",
        reason: `Rate limit exceeded: ${String(maxPerDay)} requests per day`,
      };
    }

    // Record this request
    window.minuteTimestamps.push(now);
    window.dayTimestamps.push(now);

    return { action: "continue" };
  }

  private getIdentifier(ctx: PluginContext): string {
    const apiKey = ctx.metadata["api_key"];
    if (typeof apiKey === "string") return apiKey;
    return this.config.key ?? "default";
  }

  private getOrCreateWindow(identifier: string): RequestWindow {
    const existing = this.windows.get(identifier);
    if (existing !== undefined) return existing;
    const window: RequestWindow = { minuteTimestamps: [], dayTimestamps: [] };
    this.windows.set(identifier, window);
    return window;
  }
}
