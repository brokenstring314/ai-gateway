// Round-2 中 item still reproducing ((a) non-string scopes was fixed in 91d85e1 and removed):
//  (b) nothing writes to RequestLogStore / initRequestLogger never called: /admin/logs empty after traffic
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { RequestLogStore } from "@/persistence/request-log-store";
import { startUpstream, completion } from "./prev/harness";

describe("round-2: initRequestLogger never called", () => {
  it.failing("(b) request log store stays empty after a successful request", async () => {
    const up = startUpstream(() => Response.json(completion({ role: "assistant", content: "hi" })));
    const ls = await RequestLogStore.create(new Database(":memory:"));
    const cfg: any = { auth: { enabled: false }, strategy: { mode: "single", targets: ["a"] }, targets: [{ name: "a", provider: "openai", apiKey: "k", baseURL: up.url }] };
    const app = createApp(new Gateway(cfg), cfg, undefined, undefined, { logStore: ls });
    const r = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }) });
    up.stop();
    const rows = (ls as any).db ? (ls as any).db.query("SELECT count(*) AS n FROM request_logs").get() : null;
    console.log("chat status", r.status, "rows", rows);
    expect(r.status).toBe(200);
    expect(rows?.n ?? 0).toBeGreaterThan(0); // FAILS: 0
  });
});
