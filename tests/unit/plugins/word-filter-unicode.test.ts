// S3-7 regression: detection and redaction must use the same (NFKC +
// lower-case) representation; a detected word is never forwarded unchanged.
import { describe, expect, it } from "bun:test";
import { WordFilterPlugin } from "@/plugins/builtins/word-filter";
import { createPluginContext } from "@/plugins/context";
import type { PluginResult } from "@/plugins/types";

async function run(mode: "reject" | "redact", blocklist: string[], content: unknown): Promise<PluginResult> {
  const p = new WordFilterPlugin({ blocklist, mode });
  const ctx = createPluginContext({ model: "m", messages: [{ role: "user", content }] } as never, { metadata: {} } as never);
  return p.execute(ctx);
}

function firstContent(res: PluginResult): unknown {
  return (res as unknown as { request: { messages: { content: unknown }[] } }).request.messages[0]?.content;
}

describe("S3-7 word-filter Unicode handling", () => {
  const cases: Array<[string, string]> = [
    ["kill", "how to \u212Aill a process"], // KELVIN SIGN K
    ["kill", "how to ｋｉｌｌ a process"], // fullwidth
    ["secret", "the \u017Fecret plan"], // LATIN SMALL LONG S
    ["kill", "KILL it"],
  ];
  for (const [word, text] of cases) {
    it(`redact mode never forwards ${JSON.stringify(text)} unchanged`, async () => {
      const res = await run("redact", [word], text);
      expect(res.action).toBe("modify");
      const out = firstContent(res) as string;
      expect(out).not.toBe(text);
      expect(out).toContain("***");
      expect(out.normalize("NFKC").toLowerCase()).not.toContain(word);
    });
    it(`reject mode rejects ${JSON.stringify(text)}`, async () => {
      expect((await run("reject", [word], text)).action).toBe("reject");
    });
  }

  it("redacts inside content parts too", async () => {
    const res = await run("redact", ["kill"], [{ type: "text", text: "\u212Aill" }]);
    expect(res.action).toBe("modify");
    expect(firstContent(res)).toEqual([{ type: "text", text: "***" }]);
  });

  it("text without a blocked word is left byte-for-byte untouched", async () => {
    const p = new WordFilterPlugin({ blocklist: ["kill"], mode: "redact" });
    const ctx = createPluginContext({
      model: "m",
      messages: [
        { role: "system", content: "ｆｕｌｌｗｉｄｔｈ stays" },
        { role: "user", content: "please kill it" },
      ],
    } as never, { metadata: {} } as never);
    const res = await p.execute(ctx);
    const msgs = (res as unknown as { request: { messages: { content: string }[] } }).request.messages;
    expect(msgs[0]?.content).toBe("ｆｕｌｌｗｉｄｔｈ stays");
    expect(msgs[1]?.content).toBe("please *** it");
  });

  it("detected but not redactable (case-mapping edge) → reject instead of forwarding", async () => {
    // "İ".toLowerCase() is "i̇" (two code points); /i̇stanbul/iu cannot match "İstanbul".
    const res = await run("redact", ["i̇stanbul"], "visit İstanbul");
    expect(res.action).toBe("reject");
  });

  it("clean text continues", async () => {
    expect((await run("redact", ["kill"], "hello")).action).toBe("continue");
  });
});
