/**
 * Channel-level load balancing for a published model (0.3.0 P4).
 *
 * A model's bindings form priority groups (lower `priority` first). A
 * request goes to the highest-priority group; the next group is tried only
 * when every channel of the group is unavailable or failed (the executor
 * fails over along the candidate order this strategy returns). Within a
 * group the order is chosen by the model's `balance` mode:
 *  - weighted (default): random, proportional to the binding weights;
 *  - round_robin: rotate through the group's channels;
 *  - least_inflight: fewest requests in flight on the channel first (per
 *    unit of weight), ties random.
 * Weight 0 drains a binding (never selected) in every mode.
 *
 * Legacy shapes map onto this: `strategy: fallback` = one group per
 * distinct priority (priority defaults to list order, so by default one
 * channel per group: classic ordered fallback); `strategy: loadbalance` =
 * one group with every binding.
 */

import type { ChatCompletionRequest } from "../providers/types.js";
import type { IStrategy, StrategyMode } from "./types.js";

export type BalanceMode = "weighted" | "round_robin" | "least_inflight";

/** Requests in flight per target, shared across config generations. */
export class TargetLoad {
  private readonly counts = new Map<string, number>();

  inc(name: string): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }

  dec(name: string): void {
    const n = (this.counts.get(name) ?? 0) - 1;
    if (n <= 0) this.counts.delete(name);
    else this.counts.set(name, n);
  }

  get(name: string): number {
    return this.counts.get(name) ?? 0;
  }
}

export interface GroupMember {
  readonly name: string;
  readonly weight: number;
}

function weightedOrder(members: readonly GroupMember[]): string[] {
  const remaining = [...members];
  const order: string[] = [];
  while (remaining.length > 0) {
    const total = remaining.reduce((s, m) => s + m.weight, 0);
    let r = Math.random() * total;
    let idx = remaining.length - 1;
    for (let k = 0; k < remaining.length; k++) {
      r -= remaining[k]!.weight;
      if (r < 0) {
        idx = k;
        break;
      }
    }
    order.push(remaining[idx]!.name);
    remaining.splice(idx, 1);
  }
  return order;
}

export class PriorityGroupStrategy implements IStrategy {
  readonly mode: StrategyMode;
  private readonly groups: readonly (readonly GroupMember[])[];
  private readonly cursors: number[];

  /**
   * `groups` in priority order; members with weight ≤ 0 are dropped, and so
   * are groups left empty. `mode` is the label used for logs/metrics.
   */
  constructor(
    groups: readonly (readonly GroupMember[])[],
    private readonly balance: BalanceMode,
    private readonly load: TargetLoad,
    mode: StrategyMode = "fallback",
  ) {
    this.mode = mode;
    this.groups = groups.map((g) => g.filter((m) => m.weight > 0)).filter((g) => g.length > 0);
    this.cursors = this.groups.map(() => 0);
  }

  /** Channels in priority order (for listings). */
  members(): readonly (readonly GroupMember[])[] {
    return this.groups;
  }

  selectTargets(_req: ChatCompletionRequest): string[] {
    const out: string[] = [];
    this.groups.forEach((g, i) => {
      for (const name of this.order(g, i)) if (!out.includes(name)) out.push(name);
    });
    return out;
  }

  private order(group: readonly GroupMember[], i: number): string[] {
    if (group.length === 1) return [group[0]!.name];
    switch (this.balance) {
      case "round_robin": {
        const start = this.cursors[i]! % group.length;
        this.cursors[i] = (start + 1) % group.length;
        return [...group.slice(start), ...group.slice(0, start)].map((m) => m.name);
      }
      case "least_inflight": {
        return group
          .map((m) => ({ name: m.name, score: this.load.get(m.name) / m.weight, tie: Math.random() }))
          .sort((a, b) => a.score - b.score || a.tie - b.tie)
          .map((x) => x.name);
      }
      default:
        return weightedOrder(group);
    }
  }
}

/** Group bindings by priority (ascending, stable). */
export function priorityGroups<T extends { priority: number }>(items: readonly T[]): T[][] {
  const sorted = items.map((it, i) => ({ it, i })).sort((a, b) => a.it.priority - b.it.priority || a.i - b.i);
  const groups: T[][] = [];
  let last: number | undefined;
  for (const { it } of sorted) {
    if (last === undefined || it.priority !== last) {
      groups.push([]);
      last = it.priority;
    }
    groups[groups.length - 1]!.push(it);
  }
  return groups;
}
