/** Default HTTP status for a plugin rejection. */
export const DEFAULT_PLUGIN_REJECTION_STATUS = 403;

export class PluginRejectionError extends Error {
  constructor(
    public readonly stage: string,
    public readonly reason: string,
    /** Name of the plugin that rejected (or short-circuited) the request, when known. */
    public readonly plugin?: string,
    /** HTTP status to answer with: 403 by default, 429 for rate-limit / budget. */
    public readonly status: number = DEFAULT_PLUGIN_REJECTION_STATUS,
    /** Seconds the client should wait before retrying (Retry-After), when known. */
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Plugin rejected at ${stage}: ${reason}`);
    this.name = "PluginRejectionError";
  }
}
