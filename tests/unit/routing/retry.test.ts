import { describe, it, expect, vi } from "bun:test";
import { retryWithBackoff, RetryExhaustedError } from "@/routing/retry";

function createStatusError(statusCode: number, message = "error") {
  const err: Error & { statusCode: number } = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

describe("retryWithBackoff", () => {
  it("succeeds on first attempt (no retry)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { attempts: 3, initialBackoffMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 500 error and succeeds on second attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(createStatusError(500))
      .mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { attempts: 3, initialBackoffMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 400 error", async () => {
    const fn = vi.fn().mockRejectedValue(createStatusError(400));
    await expect(retryWithBackoff(fn, { attempts: 3, initialBackoffMs: 1 }))
      .rejects.toThrow("error");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 401 error", async () => {
    const fn = vi.fn().mockRejectedValue(createStatusError(401));
    await expect(retryWithBackoff(fn, { attempts: 3, initialBackoffMs: 1 }))
      .rejects.toThrow("error");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 403 error", async () => {
    const fn = vi.fn().mockRejectedValue(createStatusError(403));
    await expect(retryWithBackoff(fn, { attempts: 3, initialBackoffMs: 1 }))
      .rejects.toThrow("error");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("DOES retry on 429", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(createStatusError(429))
      .mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { attempts: 3, initialBackoffMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts all attempts and throws RetryExhaustedError", async () => {
    const fn = vi.fn().mockRejectedValue(createStatusError(500));
    await expect(retryWithBackoff(fn, { attempts: 2, initialBackoffMs: 1 }))
      .rejects.toThrow(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(retryWithBackoff(fn, { attempts: 3, initialBackoffMs: 1 }, controller.signal))
      .rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it("backoff increases exponentially", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: () => void, ms?: number) => {
      if (ms !== undefined) delays.push(ms);
      return originalSetTimeout(fn, 0) as ReturnType<typeof setTimeout>;
    });

    const fn = vi.fn()
      .mockRejectedValueOnce(createStatusError(500))
      .mockRejectedValueOnce(createStatusError(500))
      .mockResolvedValue("ok");

    await retryWithBackoff(fn, { attempts: 4, initialBackoffMs: 100 });

    vi.restoreAllMocks();

    expect(delays.length).toBeGreaterThanOrEqual(2);
    expect(delays[0]!).toBeLessThanOrEqual(100);
    expect(delays[1]!).toBeLessThanOrEqual(200);
  });

  it("retries on generic errors (non-status errors)", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { attempts: 3, initialBackoffMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("RetryExhaustedError has cause set to last error", async () => {
    const lastError = createStatusError(503, "service unavailable");
    const fn = vi.fn().mockRejectedValue(lastError);
    try {
      await retryWithBackoff(fn, { attempts: 2, initialBackoffMs: 1 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RetryExhaustedError);
      expect((err as RetryExhaustedError).cause).toBe(lastError);
    }
  });
});
