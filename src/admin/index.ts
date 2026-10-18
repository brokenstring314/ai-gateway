/**
 * Admin API — barrel export.
 */

export { createAdminApp, type AdminAppOptions } from "./handlers.js";
export {
  type ConfigState,
  getConfigHandler,
  removedConfigWriteHandler,
} from "./config-handlers.js";
export { scrubConfig, scrubConfigJson } from "./config-scrub.js";
export {
  type KeyHandlerState,
  SCOPE_ADMIN,
  SCOPE_READ_ONLY,
  requireScope,
  listKeysHandler,
  getKeyHandler,
  createKeyHandler,
  updateKeyHandler,
  deleteKeyHandler,
  revokeKeyHandler,
  rotateKeyHandler,
  keyUsageHandler,
  getKeysHandler,
  addKeyHandler,
} from "./key-handlers.js";
export {
  type LogHandlerState,
  LogBuffer,
  logBuffer,
  getLogsHandler,
  getLogsStatsHandler,
  deleteLogsHandler,
  type LogEntry,
} from "./log-handlers.js";
