/**
 * Single strategy — always routes to exactly one configured target.
 */

import type { IStrategy, StrategyMode } from "./types.js";
import type { ChatCompletionRequest } from "../providers/types.js";
import type { SingleConfig } from "./strategy-factory.js";

export class SingleStrategy implements IStrategy {
  public readonly mode: StrategyMode = "single";
  private readonly target: string;

  constructor(config: SingleConfig) {
    this.target = config.target;
  }

  selectTargets(_req: ChatCompletionRequest): string[] {
    return [this.target];
  }
}
