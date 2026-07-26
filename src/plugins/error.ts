export class PluginRejectionError extends Error {
  constructor(
    public readonly stage: string,
    public readonly reason: string,
  ) {
    super(`Plugin rejected at ${stage}: ${reason}`);
    this.name = "PluginRejectionError";
  }
}
