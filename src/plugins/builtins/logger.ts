import type { IPlugin, PluginContext, PluginResult } from "../types.js";

export interface LoggerConfig {
  readonly logBody?: boolean;
}

export class LoggerPlugin implements IPlugin {
  readonly name = "logger";
  readonly stage = "after_request" as const;

  constructor(private readonly config: LoggerConfig) {}

  async execute(ctx: PluginContext): Promise<PluginResult> {
    if (ctx.error !== undefined) {
      this.logError(ctx);
    } else {
      this.logRequest(ctx);
    }
    return { action: "continue" };
  }

  private logRequest(ctx: PluginContext): void {
    const log: Record<string, unknown> = {
      type: "request",
      model: ctx.request.model,
      provider: ctx.response?.provider,
      timestamp: new Date().toISOString(),
    };

    if (ctx.response?.usage !== undefined) {
      log["usage"] = ctx.response.usage;
    }

    if (this.config.logBody === true) {
      log["messages"] = ctx.request.messages;
    }

    console.log(JSON.stringify(log));
  }

  private logError(ctx: PluginContext): void {
    const log: Record<string, unknown> = {
      type: "error",
      model: ctx.request.model,
      error: ctx.error?.message,
      timestamp: new Date().toISOString(),
    };
    console.log(JSON.stringify(log));
  }
}
