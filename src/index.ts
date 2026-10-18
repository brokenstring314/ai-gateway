/**
 * AI Gateway — TypeScript + Hono.
 * Entry point for embedded mode; `bun src/index.ts <command>` runs the CLI
 * (src/cli/index.ts), which starts servers through bootstrap()
 * (src/server/bootstrap.ts).
 */

// ── Embedded mode exports ──

export { Gateway } from "./gateway.js";
export { createApp } from "./app.js";
export { loadConfigFromPath, loadConfigFromObject } from "./config/loader.js";
export { parseConfig, safeParseConfig } from "./config/schema.js";
export {
  bootstrap,
  bootstrap as serve,
  clientCredentialWarning,
  resolveIdleTimeout,
  type RunningGateway,
  type ServeOverrides,
} from "./server/bootstrap.js";
export { VERSION } from "./version.js";
export type * from "./providers/types.js";
export type * from "./routing/types.js";
export type * from "./plugins/types.js";
export type * from "./config/types.js";

// Run the CLI only when this file is the entry point (not when imported).
if (import.meta.main) {
  const { runCli } = await import("./cli/index.js");
  await runCli(process.argv.slice(2));
}
