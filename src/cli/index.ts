/**
 * CLI entry point — raw argv parsing, no external CLI library.
 *
 * Commands:
 *   ai-gateway serve    -c <config.yaml> [-p <port>] [-h <host>]
 *   ai-gateway validate -c <config.yaml>
 *   ai-gateway version
 */

import { loadConfigFromPath } from "../config/loader.js";

const VERSION = "0.1.0";

// --- Arg parser ---

interface ParsedArgs {
  command: string;
  configPath?: string;
  port?: number;
  host?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "";
  let configPath: string | undefined;
  let port: number | undefined;
  let host: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-c" || arg === "--config") {
      configPath = args[++i];
    } else if (arg === "-p" || arg === "--port") {
      const raw = args[++i];
      if (raw !== undefined) {
        const n = Number(raw);
        if (Number.isNaN(n) || !Number.isInteger(n) || n <= 0) {
          console.error(`Error: invalid port "${raw}"`);
          process.exit(1);
        }
        port = n;
      }
    } else if (arg === "-h" || arg === "--host") {
      host = args[++i];
    }
  }

  return { command, configPath, port, host };
}

// --- Commands ---

async function cmdServe(parsed: ParsedArgs): Promise<void> {
  if (!parsed.configPath) {
    console.error("Error: -c/--config is required for serve command");
    process.exit(1);
  }

  // Reuse the main bootstrap (key store, persisted config, production safety,
  // client auth, shutdown) so `ai-gateway serve` enforces the same auth as
  // `bun src/index.ts serve`.
  const { serve } = await import("../index.js");
  await serve(parsed.configPath, { port: parsed.port, host: parsed.host });
}

async function cmdValidate(parsed: ParsedArgs): Promise<void> {
  if (!parsed.configPath) {
    console.error("Error: -c/--config is required for validate command");
    process.exit(1);
  }

  try {
    loadConfigFromPath(parsed.configPath);
    console.log("Config is valid");
    process.exit(0);
  } catch (err) {
    console.error(`Config validation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function cmdVersion(): void {
  console.log(`ai-gateway v${VERSION}`);
}

function printUsage(): void {
  console.log(`ai-gateway v${VERSION}

Usage:
  ai-gateway serve    -c <config.yaml> [-p <port>] [-h <host>]
  ai-gateway validate -c <config.yaml>
  ai-gateway version

Commands:
  serve      Start the AI Gateway HTTP server
  validate   Validate a config file and report errors
  version    Print version

Options:
  -c, --config <path>   Config file path (YAML or JSON)
  -p, --port <port>     Override server port
  -h, --host <host>     Override server host
`);
}

// --- Main ---

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  switch (parsed.command) {
    case "serve":
      await cmdServe(parsed);
      break;
    case "validate":
      await cmdValidate(parsed);
      break;
    case "version":
      cmdVersion();
      break;
    case "":
      console.error("Error: no command specified\n");
      printUsage();
      process.exit(1);
      break;
    default:
      console.error(`Error: unknown command "${parsed.command}"\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
