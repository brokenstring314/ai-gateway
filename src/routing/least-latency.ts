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
import type { RetryConfig } from "../config/types.js";
import { executeCandidates, streamCandidates, type CandidateHooks } from "./executor.js";

const DEFAULT_WINDOW_SIZE = 100;
/** How long a failed target is ranked last (unless it succeeds as a failover candidate). */
const DEFAULT_FAILURE_PENALTY_MS = 30_000;

export class LeastLatencyStrategy implements IStrategy {
  public readonly mode: StrategyMode = "least_latency";
  private readonly targets: readonly string[];
  private readonly lookup: ProviderLookup;
  private readonly retryConfigs: ReadonlyMap<string, RetryConfig>;
  private readonly windowSize: number;
  private readonly latencies: Map<string, number[]> = new Map();
  private readonly lastFailureAt: Map<string, number> = new Map();
  private readonly failurePenaltyMs: number;

  constructor(lookup: ProviderLookup, config: LeastLatencyConfig) {
    this.lookup = lookup;
    this.retryConfigs = config.retryConfigs ?? new Map();
    this.targets = config.targets;
    this.windowSize = config.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.failurePenaltyMs = config.failurePenaltyMs ?? DEFAULT_FAILURE_PENALTY_MS;
    for (const name of this.targets) {
      this.latencies.set(name, []);
    }
  }

  selectTargets(_req: ChatCompletionRequest): string[] {
    return this.targetsSortedByLatency();
  }

  private hooks(): CandidateHooks {
    return {
      label: "LeastLatencyStrategy",
      retryConfigFor: (name) => this.retryConfigs.get(name),
      onSuccess: (name, elapsedMs) => this.recordLatency(name, elapsedMs),
      onFailure: (name) => this.recordFailure(name),
    };
  }

  async execute(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    return executeCandidates(ctx, this.candidates(), this.lookup, (p) => p.complete(ctx, req), this.hooks());
  }

  async *executeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    yield* streamCandidates(
      ctx,
      this.candidates(),
      this.lookup,
      (p) => (p as IStreamProvider).completeStream(ctx, req),
      this.hooks(),
    );
  }

  /**
   * Candidate order:
   *  1. healthy targets with no samples yet (unknown latency: explored first,
   *     in declared order, so a new target gets measured);
   *  2. healthy measured targets by p50 ascending;
   *  3. targets that failed within the last failurePenaltyMs (most recent
   *     failure last). They stay as last-resort failover candidates, and a
   *     success clears the penalty.
   * A target that never answers therefore never wins with an empty window
   * (previously p50 = 0 for "no samples" made a dead target win every pick).
   */
  private targetsSortedByLatency(): string[] {
    const now = Date.now();
    const unknown: string[] = [];
    const measured: { name: string; p50: number }[] = [];
    const penalized: { name: string; at: number }[] = [];
    for (const name of this.targets) {
      const failedAt = this.lastFailureAt.get(name);
      if (failedAt !== undefined && now - failedAt < this.failurePenaltyMs) {
        penalized.push({ name, at: failedAt });
        continue;
      }
      const p50 = this.computeP50(name);
      if (p50 === undefined) unknown.push(name);
      else measured.push({ name, p50 });
    }
    measured.sort((a, b) => a.p50 - b.p50);
    penalized.sort((a, b) => a.at - b.at);
    return [...unknown, ...measured.map((t) => t.name), ...penalized.map((t) => t.name)];
  }

  private candidates(): string[] {
    if (this.targets.length === 0) {
      throw new Error(
        "LeastLatencyStrategy: no targets configured",
      );
    }
    return this.targetsSortedByLatency();
  }

  private recordFailure(name: string): void {
    this.lastFailureAt.set(name, Date.now());
  }

  private computeP50(name: string): number | undefined {
    const samples = this.latencies.get(name) ?? [];
    if (samples.length === 0) return undefined;
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1]! + sorted[mid]!) / 2
      : sorted[mid]!;
  }

  private recordLatency(name: string, ms: number): void {
    this.lastFailureAt.delete(name);
    const samples = this.latencies.get(name) ?? [];
    samples.push(ms);
    while (samples.length > this.windowSize) {
      samples.shift();
    }
    this.latencies.set(name, samples);
  }
}
