// expandTargetEnvRefs() materialises ${VAR} in target.baseURL at construction time, but the
// schema validates baseURL with z.string().url() BEFORE expansion, so "${OPENAI_BASE_URL}" or
// "http://localhost:${PORT}/v1" is rejected at startup ("Invalid URL"). Only refs that happen to
// parse as a URL (inside the hostname) pass. Same for PUT /admin/config.
import { describe, it, expect } from "bun:test";
import { safeParseConfig } from "@/config/schema";

describe("baseURL ${VAR}", () => {
  const ok = (u: string) => {
    const r = safeParseConfig({ strategy: { mode: "single" }, targets: [{ name: "a", provider: "openai", apiKey: "${K}", baseURL: u }] });
    if (!r.success) console.log(u, "->", r.error.issues[0]!.message);
    expect(r.success).toBe(true);
  };
  // C3-10: fixed in 5ef4091 (1.4); regression guard.
  for (const u of ["${OPENAI_BASE_URL}", "http://localhost:${PORT}/v1"]) {
    it(`accepts baseURL ${u}`, () => ok(u));
  }
  // Already accepted (ref inside the hostname parses as a URL); must keep working.
  it("accepts baseURL https://${AZ_RESOURCE}.openai.azure.com/v1", () => ok("https://${AZ_RESOURCE}.openai.azure.com/v1"));
});
