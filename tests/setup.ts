// Global test hygiene for `bun test`.
// Bun runs every test file in one process, so a spy or fake timer left behind
// by one file leaks into the next. Reset both after every test.
import { afterEach, vi } from "bun:test";

// 0.3.0: bootstrap() stores upstream keys encrypted (config store), which
// needs a master key. A fixed test-only key; tests of the missing-key path
// unset it explicitly.
process.env["GATEWAY_SECRET_KEY"] ??= "dGVzdC1vbmx5LW1hc3Rlci1rZXktMzItYnl0ZXMtbG9uZyEhIQ==";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
