/** Abort `controller` when any of `sources` aborts; returns its signal. */
export function linkAbortSignals(controller: AbortController, sources: (AbortSignal | undefined)[]): AbortSignal {
  for (const src of sources) {
    if (!src) continue;
    if (src.aborted) {
      controller.abort(src.reason);
      break;
    }
    src.addEventListener("abort", () => controller.abort(src.reason), { once: true });
  }
  return controller.signal;
}
