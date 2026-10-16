// Global test hygiene for `bun test`.
// Bun runs every test file in one process, so a spy or fake timer left behind
// by one file leaks into the next. Reset both after every test.
import { afterEach, vi } from "bun:test";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
