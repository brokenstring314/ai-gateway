import { expect } from "bun:test";
import { safeParseConfig } from "@/config/schema";

export const target = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  provider: "openai",
  apiKey: "sk-x",
  ...extra,
});

export const base = (extra: Record<string, unknown> = {}) => ({
  strategy: { mode: "single" },
  targets: [target("a")],
  ...extra,
});

/** All issues of a failing parse, one "path: message" per line. */
export function errors(input: unknown): string {
  const r = safeParseConfig(input);
  expect(r.success).toBe(false);
  return (r.error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
}

export function ok(input: unknown): void {
  const r = safeParseConfig(input);
  if (!r.success) throw new Error(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
}
