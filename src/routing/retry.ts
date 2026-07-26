import type { RetryConfig } from "../config/types.js";

const DEFAULT_RETRY: Required<RetryConfig> = {
  attempts: 3,
  initialBackoffMs: 100,
  onStatusCodes: [408, 429, 500, 502, 503, 504],
};

export class RetryExhaustedError extends Error {
  override name = "RetryExhaustedError";
  constructor(
    message: string,
    public override readonly cause: unknown,
  ) {
    super(message);
  }
}

function isRetryableError(err: unknown, onStatusCodes: number[]): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return false;

  if (err !== null && typeof err === "object" && "statusCode" in err) {
    const status = (err as { statusCode: number }).statusCode;
    if (status >= 400 && status < 500 && status !== 429) return false;
    return onStatusCodes.includes(status);
  }

  return true;
}

function fullJitterBackoff(attempt: number, initialBackoffMs: number): number {
  const ceiling = initialBackoffMs * Math.pow(2, attempt - 1);
  return Math.random() * ceiling;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config?: RetryConfig,
  signal?: AbortSignal,
): Promise<T> {
  const attempts = config?.attempts ?? DEFAULT_RETRY.attempts;
  const initialBackoffMs = config?.initialBackoffMs ?? DEFAULT_RETRY.initialBackoffMs;
  const onStatusCodes = config?.onStatusCodes ?? DEFAULT_RETRY.onStatusCodes;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      if (!isRetryableError(err, onStatusCodes)) throw err;
      if (attempt === attempts) break;

      const delay = fullJitterBackoff(attempt, initialBackoffMs);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });

      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    }
  }

  throw new RetryExhaustedError(
    `retryWithBackoff: all ${attempts} attempts failed`,
    lastError,
  );
}
