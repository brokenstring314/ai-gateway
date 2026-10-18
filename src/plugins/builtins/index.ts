import type { IPlugin } from "../types.js";
import type { BudgetConfig } from "./budget.js";
import type { CacheConfig } from "./cache.js";
import type { MaxTokenConfig } from "./max-token.js";
import type { RateLimitConfig } from "./rate-limit.js";
import type { WordFilterConfig } from "./word-filter.js";
import { BudgetPlugin } from "./budget.js";
import { CachePlugin } from "./cache.js";
import { MaxTokenPlugin } from "./max-token.js";
import { RateLimitPlugin } from "./rate-limit.js";
import { WordFilterPlugin } from "./word-filter.js";
import { PiiSecretGuardPlugin, resolveGuardConfig, type PiiSecretGuardInput } from "./pii-secret-guard/index.js";

export { RateLimitPlugin, type RateLimitConfig } from "./rate-limit.js";
export { CachePlugin, type CacheConfig } from "./cache.js";
export { WordFilterPlugin, type WordFilterConfig } from "./word-filter.js";
export { MaxTokenPlugin, type MaxTokenConfig } from "./max-token.js";
export { BudgetPlugin, type BudgetConfig } from "./budget.js";
export {
  PiiSecretGuardPlugin,
  resolveGuardConfig,
  piiSecretGuardConfigIssues,
  type PiiSecretGuardInput,
} from "./pii-secret-guard/index.js";
export { buildPluginsFromConfig, type PluginRegistration } from "./from-config.js";

export type BuiltinPluginName = "rate-limit" | "cache" | "word-filter" | "max-token" | "budget" | "pii-secret-guard";

export type BuiltinPluginConfig = {
  "rate-limit": RateLimitConfig;
  cache: CacheConfig;
  "word-filter": WordFilterConfig;
  "max-token": MaxTokenConfig;
  budget: BudgetConfig;
  "pii-secret-guard": PiiSecretGuardInput;
};

const builtinConstructors: Record<BuiltinPluginName, (config: BuiltinPluginConfig[BuiltinPluginName]) => IPlugin> = {
  "rate-limit": (c) => new RateLimitPlugin(c as RateLimitConfig),
  cache: (c) => new CachePlugin(c as CacheConfig, "before_request"),
  "word-filter": (c) => new WordFilterPlugin(c as WordFilterConfig),
  "max-token": (c) => new MaxTokenPlugin(c as MaxTokenConfig),
  budget: (c) => new BudgetPlugin(c as BudgetConfig, "before_request"),
  "pii-secret-guard": (c) => new PiiSecretGuardPlugin(resolveGuardConfig(c), "before_request"),
};

export function createBuiltinPlugin<N extends BuiltinPluginName>(name: N, config: BuiltinPluginConfig[N]): IPlugin {
  const ctor = builtinConstructors[name];
  return ctor(config);
}
