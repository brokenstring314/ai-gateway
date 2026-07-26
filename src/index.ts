/**
 * AI Gateway Rewrite — TypeScript + Hono
 * Entry point for embedded mode and CLI.
 */

import { Gateway } from "./gateway.js";
import { createApp } from "./app.js";
import { loadConfigFromPath } from "./config/loader.js";
import { safeParseConfig } from "./config/schema.js";
import type { GatewayConfig } from "./config/types.js";

const VERSION = "1.0.0";

// ── Embedded mode exports ──

export { Gateway } from "./gateway.js";
export { createApp } from "./app.js";
export { loadConfigFromPath, loadConfigFromObject } from "./config/loader.js";
export { parseConfig, safeParseConfig } from "./config/schema.js";
export type * from "./providers/types.js";
export type * from "./routing/types.js";
export type * from "./plugins/types.js";
export type * from "./config/types.js";

// ── CLI mode ──

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    process.exit(0);
  }

  if (subcommand === "version" || subcommand === "--version" || subcommand === "-v") {
    console.log(`ai-gateway v${VERSION}`);
    process.exit(0);
  }

  if (subcommand === "validate") {
    const configPath = findConfigPath(args.slice(1));
    if (!configPath) {
      console.error("Error: config path required. Usage: ai-gateway validate -c <config.yaml>");
      process.exit(1);
    }
    await validateConfig(configPath);
    return;
  }

  if (subcommand === "serve") {
    const configPath = findConfigPath(args.slice(1));
    if (!configPath) {
      console.error("Error: config path required. Usage: ai-gateway serve -c <config.yaml>");
      process.exit(1);
    }
    await serve(configPath);
    return;
  }

  console.error(`Unknown command: ${subcommand}`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`ai-gateway v${VERSION} — OpenAI-compatible AI gateway`);
  console.log("");
  console.log("Commands:");
  console.log("  serve     Start the gateway server (default)");
  console.log("  validate  Validate a config file");
  console.log("  version   Print version information");
  console.log("");
  console.log("Usage:");
  console.log("  ai-gateway serve -c <config.yaml>");
  console.log("  ai-gateway serve --config <config.yaml>");
  console.log("  ai-gateway validate -c <config.yaml>");
  console.log("  ai-gateway version");
}

function findConfigPath(args: string[]): string | undefined {
  const shortIdx = args.indexOf("-c");
  if (shortIdx !== -1 && args[shortIdx + 1]) return args[shortIdx + 1];
  const longIdx = args.indexOf("--config");
  if (longIdx !== -1 && args[longIdx + 1]) return args[longIdx + 1];
  return undefined;
}

async function validateConfig(configPath: string): Promise<void> {
  try {
    const raw = await import("fs").then((fs) => fs.readFileSync(configPath, "utf-8"));
    const yaml = await import("yaml");
    const parsed = yaml.parse(raw);
    const result = safeParseConfig(parsed);

    if (result.success) {
      const config = result.data as GatewayConfig;
      console.log("✓ Config is valid");
      console.log(`  Strategy: ${config.strategy.mode}`);
      console.log(`  Targets: ${config.targets.map((t) => t.name).join(", ")}`);
      console.log(`  Models: ${config.targets.flatMap((t) => t.models).join(", ")}`);
      console.log(`  Auth: ${config.auth?.enabled ? "enabled" : "disabled"}`);
      process.exit(0);
    } else {
      console.error("✗ Config validation failed:");
      for (const issue of result.error.issues) {
        console.error(`  ${issue.path.join(".")}: ${issue.message}`);
      }
      process.exit(1);
    }
  } catch (err) {
    console.error(`✗ Failed to load config from ${configPath}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

async function serve(configPath: string): Promise<void> {
  let config: GatewayConfig;
  try {
    config = loadConfigFromPath(configPath);
  } catch (err) {
    console.error(`Failed to load config from ${configPath}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const gateway = new Gateway(config);
  await gateway.initMcp();
  const app = createApp(gateway, config, configPath);

  const port = config.server?.port ?? 3000;
  const host = config.server?.host ?? "0.0.0.0";

  console.log(`AI Gateway starting on ${host}:${port}`);
  console.log(`Strategy: ${config.strategy.mode}`);
  console.log(`Targets: ${config.targets.map((t) => t.name).join(", ")}`);

  const server = Bun.serve({
    port,
    hostname: host,
    fetch: app.fetch,
  });

  console.log(`AI Gateway listening on http://${host}:${port}`);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    gateway.close();
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("\nShutting down...");
    gateway.close();
    server.stop();
    process.exit(0);
  });
}

// Run CLI if called directly
const isMainModule = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMainModule) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
