/**
 * Red team 2026-11-05 P3: upstream error text was passed on verbatim. An
 * upstream that echoes the key it received ("Incorrect API key provided:
 * Bearer sk-…") leaked the operator's upstream key to the client (chat,
 * stream, embeddings, pass-through 400 and 401), to GET /admin/logs
 * (read_only) and to stdout (repros/perimeter/t_leak.sh).
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createApp } from "@/app";
import { loadConfigFromObject } from "@/config/loader";
import { Gateway } from "@/gateway";
import type { RequestLogEntry } from "@/observability/request-log";
import { scrubSecrets } from "@/security/secret-scrub";
import { fakeFetch } from "../core/_review";

const KEY = "sk-UPSTREAM-CHEAP-SECRET-1234567890";
const OTHER_KEY = "zz9-other-pool-key-ABCDEFGH"; // a second key of the same channel, not sk- shaped

let restore: (() => void) | undefined;
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  restore?.();
  for (const s of spies.splice(0)) s.mockRestore();
});

function echo(status: number, init?: RequestInit) {
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  return Response.json(
    {
      error: {
        message: `Incorrect API key provided: ${auth} (also tried ${OTHER_KEY}; masked sk-abc***wxyz)`,
        type: "invalid_request_error",
        code: "invalid_api_key",
        param: auth,
      },
    },
    { status },
  );
}

function setup() {
  const f = fakeFetch((url, init, body) => {
    const model = String(body?.model ?? "");
    if (url.pathname.endsWith("/responses")) return echo(model === "leak401" ? 401 : 400, init);
    if (model === "stream-err") {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(`data: ${JSON.stringify({ error: { message: `upstream says ${auth}` } })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return echo(400, init);
  });
  restore = f.restore;
  const config = loadConfigFromObject({
    strategy: { mode: "single" },
    targets: [
      {
        name: "chan-cheap",
        provider: "openai",
        apiKey: KEY,
        baseURL: "https://chan-cheap.upstream.test/v1",
        models: ["leak", "leak401", "stream-err", "emb"],
      },
    ],
    auth: { enabled: false },
    passthroughProxy: { enabled: true },
  });
  const gw = new Gateway(config);
  const logs: RequestLogEntry[] = [];
  gw.addRequestLogSink((e) => logs.push(e));
  const app = createApp(gw, config);
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out: string[] = [];
  for (const m of ["log", "error", "warn"] as const) {
    spies.push(spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" "))));
  }
  return { post, logs, out };
}

const leaks = (s: string) => s.includes(KEY) || s.includes("SECRET-1234567890") || s.includes("abc***wxyz");

describe("P3 upstream error text is scrubbed", () => {
  it("scrubSecrets: known secrets and key-shaped tokens", () => {
    expect(scrubSecrets(`Incorrect API key provided: Bearer ${KEY}`, [KEY])).toBe(
      "Incorrect API key provided: Bearer [key]",
    );
    expect(scrubSecrets(`tried ${OTHER_KEY}`, [KEY, OTHER_KEY])).toBe("tried [key]");
    expect(scrubSecrets("masked sk-abc***wxyz and fgw_abcdef123")).toBe("masked [key] and [key]");
    expect(scrubSecrets("Missing bearer token")).toBe("Missing bearer token"); // ordinary words survive
  });

  it("t_leak repro: chat, chat stream, embeddings and pass-through 400 / 401 never show the key", async () => {
    const { post, logs, out } = setup();
    const answers = [
      await post("/v1/chat/completions", { model: "leak", messages: [{ role: "user", content: "x" }] }),
      await post("/v1/chat/completions", { model: "leak", stream: true, messages: [{ role: "user", content: "x" }] }),
      await post("/v1/chat/completions", {
        model: "stream-err",
        stream: true,
        messages: [{ role: "user", content: "x" }],
      }),
      await post("/v1/embeddings", { model: "emb", input: "x" }),
      await post("/v1/responses", { model: "leak", input: "x" }),
      await post("/v1/responses", { model: "leak401", input: "x" }),
    ];
    const bodies = await Promise.all(answers.map((r) => r.text()));
    expect(answers.map((r) => r.status)).toEqual([400, 400, 502, 400, 400, 401]);
    for (const b of bodies) expect(leaks(b)).toBe(false);
    expect(bodies[0]).toContain("Incorrect API key provided: Bearer [key]"); // still useful to the caller
    expect(bodies[4]).toContain("[key]");
    // Request log entries (what GET /admin/logs serves) and stdout.
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(leaks(JSON.stringify(l))).toBe(false);
    expect(out.some(leaks)).toBe(false);
  });

  it("every key of a multi-key channel is scrubbed, not only the one used", async () => {
    const f = fakeFetch((_u, init) => echo(400, init));
    restore = f.restore;
    const config = loadConfigFromObject({
      strategy: { mode: "single" },
      targets: [
        {
          name: "multi",
          provider: "openai",
          apiKeys: [KEY, OTHER_KEY],
          baseURL: "https://multi.upstream.test/v1",
          models: ["m"],
        },
      ],
      auth: { enabled: false },
    });
    const app = createApp(new Gateway(config), config);
    const r = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }),
    });
    const text = await r.text();
    expect(text).not.toContain(OTHER_KEY);
    expect(leaks(text)).toBe(false);
  });
});
