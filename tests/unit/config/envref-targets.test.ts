/**
 * Regression tests (H7): ${VAR} references in target apiKey/baseURL are
 * expanded when providers are built, and never sent upstream literally.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Gateway } from "@/gateway";
import { EnvRefError, expandTargetEnvRefs } from "@/config/envref";
import type { GatewayConfig } from "@/config/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env["H7_TEST_KEY"];
  delete process.env["H7_TEST_HOST"];
});

function cfg(apiKey: string, baseURL = "https://up.example/v1"): GatewayConfig {
  return {
    strategy: { mode: "single", targets: ["t"] },
    targets: [{ name: "t", provider: "openai", apiKey, baseURL, models: ["gpt-4o"] }],
  } as GatewayConfig;
}

describe("target env-ref expansion", () => {
  it("sends the expanded apiKey and baseURL upstream, keeping config in template form", async () => {
    process.env["H7_TEST_KEY"] = "sk-real";
    process.env["H7_TEST_HOST"] = "real.example";
    const seen: { url: string; auth?: string }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: (init?.headers as Record<string, string>)["Authorization"] });
      return new Response(
        JSON.stringify({
          id: "1",
          object: "chat.completion",
          created: 1,
          model: "gpt-4o",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const config = cfg("${H7_TEST_KEY}", "https://${H7_TEST_HOST}/v1");
    const gw = new Gateway(config);
    await gw.route({ metadata: {} }, { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });

    expect(seen[0]!.auth).toBe("Bearer sk-real");
    expect(seen[0]!.url).toBe("https://real.example/v1/chat/completions");
    // Stored config keeps the template so admin APIs never reveal the secret.
    expect(config.targets[0]!.apiKey).toBe("${H7_TEST_KEY}");
  });

  it("fails fast when a referenced variable is undefined", () => {
    expect(() => new Gateway(cfg("${H7_TEST_KEY}"))).toThrow(EnvRefError);
  });

  it("expandTargetEnvRefs leaves plain values and bare $ untouched", () => {
    expect(expandTargetEnvRefs({ apiKey: "pa$$w0rd", baseURL: "https://x/v1" })).toEqual({
      apiKey: "pa$$w0rd",
      baseURL: "https://x/v1",
    });
  });
});
