import { Gateway } from "@/gateway";
import type { GatewayConfig } from "@/config/types";
export const req = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };
export const resp = (p: string) => ({
  id: "x",
  object: "chat.completion",
  created: 0,
  model: "m",
  provider: p,
  choices: [{ index: 0, message: { role: "assistant" as const, content: "ok" }, finishReason: "stop" }],
  usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
});
export type Mode = "ok" | "fail" | "401" | "403" | "404" | "400" | "413" | "422" | "slow";
export function mk(cfg: any, names: string[], modes: Record<string, Mode>, delayMs = 0) {
  const g = new Gateway(cfg as GatewayConfig);
  const calls: Record<string, number> = {};
  for (const n of names) {
    calls[n] = 0;
    const p: any = { name: n, supportedModels: () => [], supportsModel: () => true, models: () => [] };
    p.complete = async (ctx: any) => {
      calls[n] = (calls[n] ?? 0) + 1;
      if (ctx?.signal?.aborted) throw ctx.signal.reason;
      const m = modes[n];
      if (m === "fail") throw Object.assign(new Error("down"), { statusCode: 503 });
      if (m === "401" || m === "403" || m === "404" || m === "400" || m === "413" || m === "422") {
        throw Object.assign(new Error("upstream " + m), { statusCode: Number(m) });
      }
      if (m === "slow")
        await new Promise((r, j) => {
          const t = setTimeout(r, delayMs);
          ctx?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            j(ctx.signal.reason);
          });
        });
      return resp(n);
    };
    g.registerProvider(p);
  }
  return { g, calls };
}
export const tgt = (name: string, extra: any = {}) => ({
  name,
  provider: "openai",
  apiKey: "k",
  baseURL: "http://127.0.0.1:1/v1",
  ...extra,
});
export const code = (p: Promise<any>) =>
  p.then(
    (r) => "ok:" + r.provider,
    (e) => String(e.statusCode ?? e.name),
  );
