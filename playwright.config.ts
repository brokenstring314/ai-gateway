/**
 * Browser e2e (0.3.0 P7): the admin console in a real Chromium against the
 * real server. `bun run test:browser`. Each suite starts its own gateway
 * (tests/browser/support/gateway.ts). Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to
 * use a system Chromium instead of Playwright's download (e.g. on arm64).
 */
import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];

export default defineConfig({
  testDir: "tests/browser",
  testMatch: /.*\.browser\.ts$/,
  fullyParallel: false,
  workers: 2,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env["CI"],
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  outputDir: "test-results",
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
});
