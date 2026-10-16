import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestLogger, type RequestLogEntry } from "@/observability/request-log";

function entry(requestId: string): RequestLogEntry {
  return { timestamp: "t", requestId, model: "m", provider: "p", strategy: "s", durationMs: 1 };
}

describe("RequestLogger file output", () => {
  let dir: string;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agw-reqlog-"));
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends every line instead of overwriting the file", async () => {
    const path = join(dir, "log.jsonl");
    const logger = new RequestLogger({ filePath: path });
    for (let i = 0; i < 3; i++) await logger.logRequest(entry(`r${i}`));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).requestId)).toEqual(["r0", "r1", "r2"]);
  });

  it("serializes un-awaited concurrent writes in call order and flushes on close", async () => {
    const path = join(dir, "log.jsonl");
    const logger = new RequestLogger({ filePath: path });
    // Fire-and-forget, as the gateway does.
    for (let i = 0; i < 50; i++) void logger.logRequest(entry(`r${i}`));
    await logger.close();
    const ids = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l).requestId);
    expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => `r${i}`));
  });

  it("never rejects when the file cannot be written", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = new RequestLogger({ filePath: join(dir, "missing-dir", "log.jsonl") });
      await expect(logger.logRequest(entry("r0"))).resolves.toBeUndefined();
      await expect(logger.flush()).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
