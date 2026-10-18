/**
 * Fallback strategy — tries targets in order (the executor advances on failure).
 */

import type { IStrategy, StrategyMode } from "./types.js";
import type { ChatCompletionRequest } from "../providers/types.js";
import type { FallbackConfig } from "./strategy-factory.js";

export class FallbackStrategy implements IStrategy {
  public readonly mode: StrategyMode = "fallback";
  private readonly targets: readonly string[];

  constructor(config: FallbackConfig) {
    this.targets = config.targets;
  }

  selectTargets(_req: ChatCompletionRequest): string[] {
    return [...this.targets];
  }
}

/** Thrown by the executor when every target of a fallback chain failed; `cause` is the reported attempt error. */
export class FallbackExhaustedError extends Error {
  public override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "FallbackExhaustedError";
    this.cause = cause;
  }
}
