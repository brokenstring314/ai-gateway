/** Moved to core/stream-runner.ts (refactor plan PR 2.5); re-exported for the handlers. */
export {
  createSseStream,
  DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS,
  DONE_MESSAGE,
  streamIdleTimeoutMs,
  streamMaxDurationMs,
  type SseStreamOptions,
} from "../core/stream-runner.js";
