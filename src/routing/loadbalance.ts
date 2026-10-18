/**
 * LoadBalance strategy — weighted random selection across targets.
 */

import type { IStrategy, StrategyMode } from "./types.js";
import type { ChatCompletionRequest } from "../providers/types.js";
import type { LoadBalanceConfig, LoadBalanceTarget } from "./strategy-factory.js";

export class LoadBalanceStrategy implements IStrategy {
  public readonly mode: StrategyMode = "loadbalance";
  private readonly targets: readonly LoadBalanceTarget[];

  constructor(config: LoadBalanceConfig) {
    // Weight 0 (or less) means "drained": never selected, not even as a
    // failover candidate.
    this.targets = config.targets.filter((t) => t.weight > 0);
    if (this.targets.length === 0) {
      throw new Error("LoadBalanceStrategy: every target has weight 0; at least one weight must be > 0");
    }
  }

  /**
   * Candidate order: weighted sampling without replacement. The first
   * candidate is picked with probability proportional to its weight; the
   * rest follow in weighted order so the executor can fail over to them.
   */
  selectTargets(_req: ChatCompletionRequest): string[] {
    const remaining = [...this.targets];
    const order: string[] = [];
    while (remaining.length > 0) {
      const total = remaining.reduce((s, t) => s + t.weight, 0);
      let r = Math.random() * total;
      let idx = remaining.length - 1;
      for (let k = 0; k < remaining.length; k++) {
        r -= remaining[k]!.weight;
        if (r <= 0) {
          idx = k;
          break;
        }
      }
      order.push(remaining[idx]!.name);
      remaining.splice(idx, 1);
    }
    return order;
  }
}
