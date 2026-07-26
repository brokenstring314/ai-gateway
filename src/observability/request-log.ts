/**
 * Structured request logger — writes JSON log entries to console and optionally to a file.
 */

export interface RequestLogEntry {
  timestamp: string;
  requestId: string;
  model: string;
  provider: string;
  strategy: string;
  durationMs: number;
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
  };
  error?: string;
}

export interface RequestLogConfig {
  /** Write logs to a file path in addition to console. */
  filePath?: string;
}

export class RequestLogger {
  private fileHandle: ReturnType<typeof Bun.file> | null = null;

  constructor(config?: RequestLogConfig) {
    if (config?.filePath) {
      this.fileHandle = Bun.file(config.filePath);
    }
  }

  /** Log a structured request entry. */
  async logRequest(entry: RequestLogEntry): Promise<void> {
    const line = JSON.stringify(entry);

    // Always write to console as JSON
    console.log(line);

    // Optionally write to file (append)
    if (this.fileHandle) {
      try {
        const writer = this.fileHandle.writer();
        writer.write(line + "\n");
        writer.end();
      } catch {
        // File write failure must not break the gateway
      }
    }
  }
}

/** Global request logger. */
let globalLogger: RequestLogger = new RequestLogger();

/** Initialize the global request logger with config. */
export function initRequestLogger(config?: RequestLogConfig): RequestLogger {
  globalLogger = new RequestLogger(config);
  return globalLogger;
}

/** Get the global request logger. */
export function getRequestLogger(): RequestLogger {
  return globalLogger;
}
