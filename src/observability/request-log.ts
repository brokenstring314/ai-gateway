import { appendFile } from "node:fs/promises";
import type { RequestLogStore } from "../persistence/request-log-store.js";

/**
 * Structured request logger — writes JSON log entries to console and optionally to a file.
 */

export interface RequestLogEntry {
  timestamp: string;
  requestId: string;
  /**
   * Published model the request asked for, aliases resolved — for successes
   * and failures alike (B3). A name that is not published is kept as sent
   * (cut to its log size).
   */
  model: string;
  /**
   * Model name the upstream answered with (else the binding's upstream name
   * for the channel that served / failed it). Unset when no upstream was
   * involved (rejected before routing, plugin short-circuit).
   */
  upstreamModel?: string;
  /** Usage-rollup model: `model`, or "(unknown)" for a failed request naming no published model (D3). */
  publishedModel?: string;
  provider: string;
  strategy: string;
  durationMs: number;
  /** Id of the client key (key-store id, or `cfg_…` for a config auth key); never the secret. */
  keyId?: string;
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
    /** Prompt tokens served from the upstream's cache (cached_tokens / prompt_cache_hit_tokens). */
    cacheHit?: number;
    /** Reasoning tokens inside the completion (completion_tokens_details.reasoning_tokens). */
    reasoning?: number;
  };
  error?: string;
  /** Token counts were estimated (stream without a usage chunk). */
  usageEstimated?: boolean;
  /** HTTP status the gateway answered with (set for plugin-blocked requests). */
  status?: number;
  /** Before-request plugin that rejected or short-circuited the request. */
  plugin?: string;
  /** Which API surface the request came in on (chat, chat_stream, embedding, image, passthrough). */
  surface?: string;
  /** Set when a before-request plugin ended the request without an upstream call. */
  outcome?: "plugin_rejected" | "plugin_short_circuit";
  /** Guardrail detections (pii-secret-guard): entity TYPES and the action taken, never matched text. */
  guardrail?: {
    plugin: string;
    direction: "request" | "response";
    action: "blocked" | "redacted" | "logged";
    entities: readonly string[];
  }[];
}

export interface RequestLogConfig {
  /** Write logs to a file path in addition to console. */
  filePath?: string;
}

export class RequestLogger {
  private readonly filePath: string | null;
  /** Tail of the serialized write chain — each append waits for the previous one. */
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(config?: RequestLogConfig) {
    this.filePath = config?.filePath ?? null;
  }

  /**
   * Log a structured request entry. Never rejects: callers may fire-and-forget.
   * File writes are appended (never truncating) and serialized in call order.
   */
  logRequest(entry: RequestLogEntry): Promise<void> {
    const line = JSON.stringify(entry);

    // Always write to console as JSON
    console.log(line);

    const filePath = this.filePath;
    if (!filePath || this.closed) return Promise.resolve();

    this.writeChain = this.writeChain.then(() =>
      appendFile(filePath, line + "\n", { encoding: "utf8" }).catch((err: unknown) => {
        // File write failure must not break the gateway
        console.error(
          `[request-log] failed to append to ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }),
    );
    return this.writeChain;
  }

  /** Resolve once every queued file write has completed. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  /** Stop accepting file writes and wait for pending ones to finish. */
  async close(): Promise<void> {
    this.closed = true;
    await this.writeChain;
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

/** One sink function per store, so wiring the same store twice does not double-write. */
const storeSinks = new WeakMap<RequestLogStore, (entry: RequestLogEntry) => void>();

/**
 * Request-log sink writing to the SQLite log store (/admin/logs, dashboard).
 * `stage` is the API surface (chat, chat_stream, embedding, image, …).
 * Write failures (e.g. store closed during shutdown) are reported, never thrown.
 */
export function requestLogStoreSink(store: RequestLogStore): (entry: RequestLogEntry) => void {
  let sink = storeSinks.get(store);
  if (sink) return sink;
  sink = (entry) => {
    try {
      store.write({
        traceId: entry.requestId,
        stage: entry.surface ?? "chat",
        model: entry.model,
        ...(entry.upstreamModel !== undefined ? { upstreamModel: entry.upstreamModel } : {}),
        provider: entry.provider,
        promptTokens: entry.tokens?.prompt ?? 0,
        completionTokens: entry.tokens?.completion ?? 0,
        totalTokens: entry.tokens?.total ?? 0,
        errorMessage: entry.error ?? "",
        createdAt: new Date(entry.timestamp),
        ...(entry.keyId !== undefined ? { keyId: entry.keyId } : {}),
        cacheHitTokens: entry.tokens?.cacheHit ?? 0,
        reasoningTokens: entry.tokens?.reasoning ?? 0,
        durationMs: entry.durationMs,
        ...(entry.status !== undefined ? { status: entry.status } : {}),
      });
    } catch (err) {
      console.error(`[request-log] store write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  storeSinks.set(store, sink);
  return sink;
}
