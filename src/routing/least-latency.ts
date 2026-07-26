/**
 * LeastLatency strategy — routes to target with lowest p50 latency.
 * Tracks latency in a rolling window per target.
 */

import type { IStrategy, StrategyMode, ProviderLookup } from "./types.js";
import type {
  RequestContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  IStreamProvider,
} from "../providers/types.js";
import type { LeastLatencyConfig } from "./strategy-factory.js";

const DEFAULT_WINDOW_SIZE = 100;

export class LeastLatencyStrategy implements IStrategy {
  public readonly mode: StrategyMode = "least_latency";
  private readonly targets: readonly string[];
  private readonly lookup: ProviderLookup;
  private readonly windowSize: number;
  private readonly latencies: Map<string, number[]> = new Map();

  constructor(lookup: ProviderLookup, config: LeastLatencyConfig) {
    this.lookup = lookup;
    this.targets = config.targets;
    this.windowSize = config.windowSize ?? DEFAULT_WINDOW_SIZE;
    for (const name of this.targets) {
      this.latencies.set(name, []);
    }
  }

  selectTargets(_req: ChatCompletionRequest): string[] {
    return this.targetsSortedByLatency();
  }

  async execute(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const picked = this.pickByLatency();
    const provider = this.lookup(picked);
    if (!provider) {
      throw new Error(
        `LeastLatencyStrategy: provider "${picked}" not found`,
      );
    }

    const start = performance.now();
    const response = await provider.complete(ctx, req);
    const elapsed = performance.now() - start;
    this.recordLatency(picked, elapsed);

    return response;
  }

  async *executeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    const picked = this.pickByLatency();
    const provider = this.lookup(picked);
    if (!provider || !("completeStream" in provider)) {
      throw new Error(
        `LeastLatencyStrategy: streaming provider "${picked}" not found`,
      );
    }

    const start = performance.now();
    const stream = (provider as IStreamProvider).completeStream(ctx, req);
    let firstChunk = true;
    for await (const chunk of stream) {
      if (firstChunk) {
        const elapsed = performance.now() - start;
        this.recordLatency(picked, elapsed);
        firstChunk = false;
      }
      yield chunk;
    }
  }

  private pickByLatency(): string {
    const sorted = this.targetsSortedByLatency();
    if (sorted.length === 0) {
      throw new Error(
        "LeastLatencyStrategy: no targets configured",
      );
    }
    return sorted[0]!;
  }

  private targetsSortedByLatency(): string[] {
    const withLatency = this.targets.map((name) => ({
      name,
      p50: this.computeP50(name),
    }));
    withLatency.sort((a, b) => a.p50 - b.p50);
    return withLatency.map((t) => t.name);
  }

  private computeP50(name: string): number {
    const samples = this.latencies.get(name) ?? [];
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1]! + sorted[mid]!) / 2
      : sorted[mid]!;
  }

  private recordLatency(name: string, ms: number): void {
    const samples = this.latencies.get(name) ?? [];
    samples.push(ms);
    while (samples.length > this.windowSize) {
      samples.shift();
    }
    this.latencies.set(name, samples);
  }
}
