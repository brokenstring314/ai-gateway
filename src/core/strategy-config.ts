/**
 * Config → routing strategy (refactor plan §1.2): the strategy mode and its
 * per-mode config derived from `config.strategy` and the targets.
 */

import { resolveStrategyMode } from "../config/removed.js";
import type { GatewayConfig } from "../config/types.js";
import type { StrategyConfig as RoutingStrategyConfig } from "../routing/strategy-factory.js";
import type { StrategyMode } from "../routing/types.js";

export function buildStrategyConfig(config: GatewayConfig): {
  mode: StrategyMode;
  config: RoutingStrategyConfig;
} {
  const sc = config.strategy;
  const targetNames = config.targets.map((t) => t.name);

  const mode = resolveStrategyMode(sc.mode);
  switch (mode) {
    case "single": {
      const target = sc.targets?.[0] ?? targetNames[0];
      if (!target) throw new Error("single strategy requires at least one target");
      return { mode: "single", config: { target } };
    }
    case "fallback": {
      const fallbackTargets = sc.targets ?? targetNames;
      return { mode: "fallback", config: { targets: fallbackTargets } };
    }
    case "loadbalance": {
      // Weight 0 drains a target: it gets no traffic (not even as failover).
      const targets = (sc.targets ?? targetNames).map((name) => {
        const t = config.targets.find((tgt) => tgt.name === name);
        return { name, weight: t?.weight ?? sc.weights?.[name] ?? 1 };
      });
      return { mode: "loadbalance", config: { targets } };
    }
    case "conditional": {
      return {
        mode: "conditional",
        config: {
          rules: sc.rules ?? [],
          defaultTarget: sc.targets?.[0] ?? targetNames[0],
        },
      };
    }
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown strategy mode: ${String(_exhaustive)}`);
    }
  }
}
