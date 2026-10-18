// Shared helpers for round-3 security repros. Copy this dir to <repo>/tests/h3/ and run:
//   NO_PROXY=127.0.0.1,localhost bun test tests/h3
import { Database } from "bun:sqlite";
import { KeyStore } from "@/persistence/key-store";
import type { GatewayConfig } from "@/config/types";

export function cfg(extra: Record<string, unknown> = {}): GatewayConfig {
  return {
    strategy: { mode: "single", targets: ["t"] },
    targets: [
      {
        name: "t",
        provider: "openai",
        apiKey: "sk-OPERATOR-SECRET",
        baseURL: "https://up.example/v1",
        models: ["gpt-4o"],
      },
    ],
    ...extra,
  } as unknown as GatewayConfig;
}
export async function memKeyStore(): Promise<KeyStore> {
  return KeyStore.create(new Database(":memory:"));
}
export const okChat = () =>
  new Response(
    JSON.stringify({
      id: "c",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
export const chatBody = (content = "hi", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content }], ...extra });
