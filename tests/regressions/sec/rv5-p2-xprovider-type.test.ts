/**
 * Red team 2026-11-05 P2: with two channels of the same provider type,
 * `X-Provider: openai` on a pass-through request was checked against "any
 * openai channel serves the model" but forwarded to the FIRST openai channel,
 * so a request for "cheap" (bound only to chan-cheap) went out through
 * chan-premium with chan-premium's upstream key (repros/perimeter/t_xprovider.sh).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { createApp } from "@/app";
import { loadConfigFromObject } from "@/config/loader";
import { Gateway } from "@/gateway";
import { KeyStore } from "@/persistence/key-store";
import { fakeFetch } from "../core/_review";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

const chan = (name: string, models: string[]) => ({
  name,
  provider: "openai",
  apiKey: `sk-${name.toUpperCase()}-ACCOUNT-KEY`,
  baseURL: `https://${name}.upstream.test/v1`,
  models,
});

async function setup() {
  const auths: string[] = [];
  const f = fakeFetch((_url, init) => {
    auths.push(new Headers(init?.headers).get("authorization") ?? "");
    return Response.json({ id: "r", object: "response" });
  });
  restore = f.restore;
  const config = loadConfigFromObject({
    strategy: { mode: "fallback", targets: ["chan-premium", "chan-cheap"] },
    targets: [chan("chan-premium", ["exp", "both"]), chan("chan-cheap", ["cheap", "both"])],
    auth: { enabled: true },
    passthroughProxy: { enabled: true },
  });
  const store = await KeyStore.create(new Database(":memory:"));
  const key = store.create("r", ["inference"], undefined, { allowedModels: ["cheap", "both"] }).key;
  const app = createApp(new Gateway(config), config, undefined, store);
  const send = (provider: string, model: string) =>
    app.request("/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-provider": provider },
      body: JSON.stringify({ model, input: "x" }),
    });
  return { send, auths, calls: f.calls };
}

describe("P2 X-Provider by provider type", () => {
  it("t_xprovider repro: X-Provider: openai for 'cheap' goes to chan-cheap, never chan-premium", async () => {
    const { send, auths, calls } = await setup();
    const named = await send("chan-premium", "cheap");
    expect(named.status).toBe(400);
    expect(((await named.json()) as { error: { code: string } }).error.code).toBe("provider_not_bound");
    const byType = await send("openai", "cheap");
    expect(byType.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("chan-cheap.upstream.test");
    expect(auths).toEqual(["Bearer sk-CHAN-CHEAP-ACCOUNT-KEY"]); // was sk-…PREMIUM…
  });

  it("a type matching no bound channel is provider_not_bound; a model bound to both follows the routing order", async () => {
    const { send, calls } = await setup();
    const wrongType = await send("deepseek", "cheap");
    expect(wrongType.status).toBe(400);
    const both = await send("openai", "both");
    expect(both.status).toBe(200);
    expect(calls.at(-1)!.url).toContain("chan-premium.upstream.test"); // fallback order: premium first
    const byName = await send("chan-cheap", "both");
    expect(byName.status).toBe(200);
    expect(calls.at(-1)!.url).toContain("chan-cheap.upstream.test");
  });
});
