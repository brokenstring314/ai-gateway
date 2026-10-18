export class PluginRejectionError extends Error {
  constructor(
    public readonly stage: string,
    public readonly reason: string,
    /** Name of the plugin that rejected (or short-circuited) the request, when known. */
    public readonly plugin?: string,
  ) {
    super(`Plugin rejected at ${stage}: ${reason}`);
    this.name = "PluginRejectionError";
  }
}
