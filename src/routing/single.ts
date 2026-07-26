/**
 * Single strategy — always routes to exactly one configured target.
 */

import type { IStrategy, StrategyMode, ProviderLookup } from "./types.js";
import type {
  RequestContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  IProvider,
  IStreamProvider,
} from "../providers/types.js";
import type { SingleConfig } from "./strategy-factory.js";

export class SingleStrategy implements IStrategy {
  public readonly mode: StrategyMode = "single";
  private readonly target: string;
  private readonly lookup: ProviderLookup;

  constructor(lookup: ProviderLookup, config: SingleConfig) {
    this.lookup = lookup;
    this.target = config.target;
  }

  selectTargets(_req: ChatCompletionRequest): string[] {
    return [this.target];
  }

  async execute(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const provider = this.lookupProvider(this.target);
    return provider.complete(ctx, req);
  }

  async *executeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    const provider = this.lookupStreamProvider(this.target);
    yield* provider.completeStream(ctx, req);
  }

  private lookupProvider(name: string): IProvider {
    const p = this.lookup(name);
    if (!p) throw new Error(`SingleStrategy: provider "${name}" not found`);
    return p;
  }

  private lookupStreamProvider(name: string): IStreamProvider {
    const p = this.lookup(name);
    if (!p) throw new Error(`SingleStrategy: provider "${name}" not found`);
    if (!("completeStream" in p)) {
      throw new Error(
        `SingleStrategy: provider "${name}" does not support streaming`,
      );
    }
    return p as IStreamProvider;
  }
}
