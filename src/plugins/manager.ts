import type { ChatCompletionRequest } from "../providers/types.js";
import type { InternalPluginContext } from "./context.js";
import { PluginRejectionError } from "./error.js";
import type { IPlugin, IPluginManager, PluginContext, Stage } from "./types.js";

export class PluginManager implements IPluginManager {
  private readonly plugins: Record<Stage, IPlugin[]> = {
    before_request: [],
    after_request: [],
    on_error: [],
  };

  register(stage: Stage, plugin: IPlugin): void {
    this.plugins[stage].push(plugin);
  }

  /** Remove a previously registered plugin instance from a stage. */
  unregister(stage: Stage, plugin: IPlugin): void {
    const list = this.plugins[stage];
    const idx = list.indexOf(plugin);
    if (idx !== -1) list.splice(idx, 1);
  }

  async runBefore(ctx: PluginContext): Promise<void> {
    const internalCtx = ctx as InternalPluginContext;
    const list = this.plugins.before_request;

    for (const plugin of list) {
      const result = await plugin.execute(ctx);

      if (internalCtx._shortCircuited) {
        internalCtx._shortCircuitedBy ??= plugin.name;
        break;
      }

      if (result.action === "short_circuit") {
        // Must go through shortCircuit() so _shortCircuited is set; the
        // gateway checks that flag to skip the upstream call.
        ctx.shortCircuit(result.response);
        internalCtx._shortCircuitedBy = plugin.name;
        break;
      }

      if (result.action === "reject") {
        throw new PluginRejectionError("before_request", result.reason, plugin.name);
      }

      if (result.action === "modify") {
        if (result.request) {
          applyRequest(ctx, result.request);
          (internalCtx._modifiedBy ??= []).push(plugin.name);
        }
        if (result.response) {
          ctx.response = result.response;
        }
      }

      // "continue" — proceed to next plugin
    }
  }

  async runAfter(ctx: PluginContext): Promise<void> {
    const list = this.plugins.after_request;

    for (const plugin of list) {
      await plugin.execute(ctx);
    }
  }

  async runOnError(ctx: PluginContext): Promise<void> {
    const list = this.plugins.on_error;

    for (const plugin of list) {
      await plugin.execute(ctx);
    }
  }

  hasPlugins(): boolean {
    if (this.plugins.before_request.length > 0) return true;
    if (this.plugins.after_request.length > 0) return true;
    if (this.plugins.on_error.length > 0) return true;
    return false;
  }
}

function applyRequest(ctx: PluginContext, newRequest: ChatCompletionRequest): void {
  // Replace the context's request reference with the modified one.
  // PluginContext.request is not readonly, so direct assignment is valid.
  ctx.request = newRequest;
}
