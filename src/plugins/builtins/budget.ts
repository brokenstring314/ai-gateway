/**
 * Daily spend budget per API key (C3-5, plan 3.6).
 *
 * before_request reserves the request's estimated cost; after_request
 * charges the actual cost; the reservation is released when the request is
 * settled (PluginContext.onSettled), however it ended. A request is
 * admitted when the budget is not yet spent and — while other requests are
 * in flight — its estimate fits next to their reservations, so concurrent
 * requests can no longer all pass a check-then-accrue race.
 *
 * Cost: the plugin's own rates (costPer1kInput / costPer1kOutput) when set,
 * otherwise the serving target's costPer1kInputTokens / costPer1kOutputTokens
 * (the pipeline exposes it as metadata._costUsd). Config validation rejects a
 * budget that has neither (every request would cost $0).
 */

import { costOf, estimatePromptTokens, hasCostRates, type CostRates } from "../../core/usage.js";
import type { IPlugin, PluginContext, PluginResult, Stage } from "../types.js";

export interface BudgetConfig {
  readonly dailyBudget: number;
  readonly costPer1kInput?: number;
  readonly costPer1kOutput?: number;
  /** Output tokens assumed for the reservation when the request sets no max_tokens (default 1024). */
  readonly reserveOutputTokens?: number;
  /**
   * Rates used for the reservation estimate when the plugin has no own rates:
   * the highest target rates (set by buildPluginsFromConfig).
   */
  readonly estimateRates?: CostRates;
}

export const DEFAULT_RESERVE_OUTPUT_TOKENS = 1024;

interface BudgetEntry {
  spent: number;
  /** Estimated cost of admitted requests that have not settled yet. */
  reserved: number;
  date: string; // YYYY-MM-DD
}

/** Module-level shared budget store so separate before/after instances share the same data. */
const budgets = new Map<string, BudgetEntry>();

/** Clear all accrued spend and reservations (test isolation; the store is process-wide). */
export function resetBudgetStore(): void {
  budgets.clear();
}

/** Current spend / reservations for an identifier (tests, diagnostics). */
export function budgetSnapshot(identifier: string): { spent: number; reserved: number } | undefined {
  const e = budgets.get(identifier);
  return e ? { spent: e.spent, reserved: e.reserved } : undefined;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export class BudgetPlugin implements IPlugin {
  readonly name = "budget";
  readonly stage: Stage;

  constructor(
    private readonly config: BudgetConfig,
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

  private ownRates(): CostRates {
    return { costPer1kInputTokens: this.config.costPer1kInput, costPer1kOutputTokens: this.config.costPer1kOutput };
  }

  /** Estimated cost of a request: prompt (~4 chars/token) + its max tokens (or the default reserve). */
  private estimate(ctx: PluginContext): number {
    const own = this.ownRates();
    const rates = hasCostRates(own) ? own : this.config.estimateRates;
    const req = ctx.request;
    const promptTokens = estimatePromptTokens(req);
    const completionTokens = req.maxTokens ?? req.maxCompletionTokens ?? this.config.reserveOutputTokens ?? DEFAULT_RESERVE_OUTPUT_TOKENS;
    return costOf(rates, { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens });
  }

  private handleBeforeRequest(ctx: PluginContext): PluginResult {
    const identifier = this.getIdentifier(ctx);
    const entry = this.getOrResetEntry(identifier, todayKey());
    const budget = this.config.dailyBudget;

    if (entry.spent >= budget) {
      return this.reject(entry);
    }
    // No reservation without a settle hook (a context outside the pipeline).
    if (typeof ctx.onSettled !== "function") return { action: "continue" };

    const estimate = this.estimate(ctx);
    // Alone: admitted while the budget is not spent (as before). With others
    // in flight: only if this estimate fits next to their reservations.
    if (entry.reserved > 0 && entry.spent + entry.reserved + estimate > budget) {
      return this.reject(entry);
    }
    entry.reserved += estimate;
    ctx.onSettled(() => {
      entry.reserved = Math.max(0, entry.reserved - estimate);
    });
    return { action: "continue" };
  }

  private reject(entry: BudgetEntry): PluginResult {
    const committed = entry.spent + entry.reserved;
    return {
      action: "reject",
      reason: `Daily budget exceeded: ${round(committed)}/${String(this.config.dailyBudget)}` +
        (entry.reserved > 0 ? ` (including ${round(entry.reserved)} reserved by requests in flight)` : ""),
      status: 429,
    };
  }

  private handleAfterRequest(ctx: PluginContext): PluginResult {
    const usage = ctx.response?.usage;
    if (usage === undefined) {
      return { action: "continue" };
    }
    const own = this.ownRates();
    const pipelineCost = ctx.metadata["_costUsd"];
    const cost = hasCostRates(own) ? costOf(own, usage) : typeof pipelineCost === "number" ? pipelineCost : 0;

    const identifier = this.getIdentifier(ctx);
    const entry = this.getOrResetEntry(identifier, todayKey());
    entry.spent += cost;
    return { action: "continue" };
  }

  private getIdentifier(ctx: PluginContext): string {
    const apiKey = ctx.metadata["api_key"];
    if (typeof apiKey === "string") return apiKey;
    return "default";
  }

  private getOrResetEntry(identifier: string, today: string): BudgetEntry {
    const existing = budgets.get(identifier);
    if (existing === undefined || existing.date !== today) {
      const entry: BudgetEntry = { spent: 0, reserved: 0, date: today };
      budgets.set(identifier, entry);
      return entry;
    }
    return existing;
  }
}

function round(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}
