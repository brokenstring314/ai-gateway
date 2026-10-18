/**
 * The one CLI (`ai-gateway`, `bun src/index.ts`, `bun src/cli/index.ts`).
 * Raw argv parsing, no external CLI library.
 *
 * Commands:
 *   ai-gateway serve    -c <config.yaml> [-p <port>] [-h <host>]
 *   ai-gateway validate -c <config.yaml>
 *   ai-gateway version
 */

import { loadConfigFromPath } from "../config/loader.js";
import { isClientAuthEnabled } from "../config/production-safety.js";
import { VERSION } from "../version.js";

export interface ParsedArgs {
  command: string;
  configPath?: string;
  port?: number;
  host?: string;
  help?: boolean;
  error?: string;
}

/** Parse CLI arguments (without the runtime/script prefix). */
export function parseArgs(args: readonly string[]): ParsedArgs {
  const first = args[0] ?? "";
  const parsed: ParsedArgs = { command: first };
  if (first === "--help" || first === "help") return { command: "", help: true };
  if (first === "--version" || first === "-v") return { command: "version" };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-c" || arg === "--config") {
      parsed.configPath = args[++i];
    } else if (arg === "-p" || arg === "--port") {
      const raw = args[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isInteger(n) || n <= 0 || n > 65535) {
        parsed.error = `invalid port "${raw ?? ""}"`;
      } else {
        parsed.port = n;
      }
    } else if (arg === "-h" || arg === "--host") {
      parsed.host = args[++i];
    } else if (arg === "--help") {
      parsed.help = true;
    } else {
      parsed.error = `unknown option "${arg}"`;
    }
  }
  return parsed;
}

export function usage(): string {
  return `ai-gateway v${VERSION} — OpenAI-compatible AI gateway

Usage:
  ai-gateway serve    -c <config.yaml> [-p <port>] [-h <host>]
  ai-gateway validate -c <config.yaml>
  ai-gateway version

Commands:
  serve      Start the gateway server
  validate   Validate a config file and report errors
  version    Print version

Options:
  -c, --config <path>   Config file path (YAML or JSON)
  -p, --port <port>     Override server.port
  -h, --host <host>     Override server.host
`;
}

/** Validate a config file; returns the process exit code. */
export function validateCommand(configPath: string, out: Pick<Console, "log" | "error"> = console): number {
  try {
    const config = loadConfigFromPath(configPath);
    out.log("✓ Config is valid");
    out.log(`  Strategy: ${config.strategy.mode}`);
    out.log(`  Targets: ${config.targets.map((t) => t.name).join(", ")}`);
    out.log(`  Auth: ${isClientAuthEnabled(config.auth) ? "enabled" : "disabled"}`);
    return 0;
  } catch (err) {
    out.error(`✗ Config validation failed (${configPath}):`);
    out.error(`  ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Run the CLI. Exits the process except for `serve`, which keeps running. */
export async function runCli(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.help || parsed.command === "") {
    console.log(usage());
    process.exit(parsed.help ? 0 : 1);
  }
  if (parsed.error !== undefined) {
    console.error(`Error: ${parsed.error}\n`);
    console.error(usage());
    process.exit(1);
  }

  switch (parsed.command) {
    case "version":
      console.log(`ai-gateway v${VERSION}`);
      process.exit(0);
      break;
    case "validate":
      if (!parsed.configPath) {
        console.error("Error: -c/--config is required for validate");
        process.exit(1);
      }
      process.exit(validateCommand(parsed.configPath));
      break;
    case "serve": {
      if (!parsed.configPath) {
        console.error("Error: -c/--config is required for serve");
        process.exit(1);
      }
      // Same bootstrap as every other server entry point: key store,
      // production safety, client auth, OTel, graceful shutdown.
      const { bootstrap } = await import("../server/bootstrap.js");
      try {
        await bootstrap(parsed.configPath, { port: parsed.port, host: parsed.host });
      } catch (err) {
        console.error(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }
    default:
      console.error(`Error: unknown command "${parsed.command}"\n`);
      console.error(usage());
      process.exit(1);
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
