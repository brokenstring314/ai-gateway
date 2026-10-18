import type { IPlugin, PluginContext, PluginResult, Stage } from "../types.js";

export interface BudgetConfig {
  readonly dailyBudget: number;
  readonly costPer1kInput?: number;
  readonly costPer1kOutput?: number;
}

interface BudgetEntry {
  spent: number;
  date: string; // YYYY-MM-DD
}

/** Module-level shared budget store so separate before/after instances share the same data. */
const budgets = new Map<string, BudgetEntry>();

/** Clear all accrued spend (test isolation; the store is process-wide). */
export function resetBudgetStore(): void {
  budgets.clear();
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

  private handleBeforeRequest(ctx: PluginContext): PluginResult {
    const identifier = this.getIdentifier(ctx);
    const today = todayKey();
    const entry = this.getOrResetEntry(identifier, today);

    if (entry.spent >= this.config.dailyBudget) {
      return {
        action: "reject",
        reason: `Daily budget exceeded: ${String(entry.spent)}/${String(this.config.dailyBudget)}`,
        status: 429,
      };
    }

    return { action: "continue" };
  }

  private handleAfterRequest(ctx: PluginContext): PluginResult {
    const usage = ctx.response?.usage;
    if (usage === undefined) {
      return { action: "continue" };
    }

    const identifier = this.getIdentifier(ctx);
    const today = todayKey();
    const entry = this.getOrResetEntry(identifier, today);

    const costPer1kInput = this.config.costPer1kInput ?? 0;
    const costPer1kOutput = this.config.costPer1kOutput ?? 0;

    const inputCost = (usage.promptTokens / 1000) * costPer1kInput;
    const outputCost = (usage.completionTokens / 1000) * costPer1kOutput;
    entry.spent += inputCost + outputCost;

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
      const entry: BudgetEntry = { spent: 0, date: today };
      budgets.set(identifier, entry);
      return entry;
    }
    return existing;
  }
}
