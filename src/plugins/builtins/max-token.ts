import type { IPlugin, PluginContext, PluginResult } from "../types.js";
import type { ChatCompletionRequest } from "../../providers/types.js";

export interface MaxTokenConfig {
  readonly maxTokens: number;
}

export class MaxTokenPlugin implements IPlugin {
  readonly name = "max-token";
  readonly stage = "before_request" as const;

  constructor(private readonly config: MaxTokenConfig) {}

  async execute(ctx: PluginContext): Promise<PluginResult> {
    const req = ctx.request;
    let modified = false;
    let newMaxTokens = req.maxTokens;
    let newMaxCompletionTokens = req.maxCompletionTokens;

    if (req.maxTokens !== undefined && req.maxTokens > this.config.maxTokens) {
      newMaxTokens = this.config.maxTokens;
      modified = true;
      console.log(
        JSON.stringify({
          type: "max-token",
          message: `Capped maxTokens from ${String(req.maxTokens)} to ${String(this.config.maxTokens)}`,
        }),
      );
    }

    if (req.maxCompletionTokens !== undefined && req.maxCompletionTokens > this.config.maxTokens) {
      newMaxCompletionTokens = this.config.maxTokens;
      modified = true;
      console.log(
        JSON.stringify({
          type: "max-token",
          message: `Capped maxCompletionTokens from ${String(req.maxCompletionTokens)} to ${String(this.config.maxTokens)}`,
        }),
      );
    }

    // Neither limit given: the upstream would run to the model's default
    // (often the full context), bypassing the cap (T3-11). Inject the cap.
    if (req.maxTokens === undefined && req.maxCompletionTokens === undefined) {
      newMaxTokens = this.config.maxTokens;
      modified = true;
    }

    if (!modified) {
      return { action: "continue" };
    }

    const newRequest: ChatCompletionRequest = {
      ...ctx.request,
      maxTokens: newMaxTokens,
      maxCompletionTokens: newMaxCompletionTokens,
    };

    return { action: "modify", request: newRequest };
  }
}
