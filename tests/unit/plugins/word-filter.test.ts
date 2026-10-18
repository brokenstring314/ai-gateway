import { describe, expect, it } from "bun:test";
import { createPluginContext } from "../../../src/plugins/context.js";
import { WordFilterPlugin } from "../../../src/plugins/builtins/word-filter.js";
import type { ChatCompletionRequest, } from "../../../src/providers/types.js";

function makeRequest(overrides?: Partial<ChatCompletionRequest>): ChatCompletionRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

describe("WordFilterPlugin", () => {
  describe("reject mode", () => {
    it("allows clean content through", async () => {
      const plugin = new WordFilterPlugin({
        blocklist: ["badword"],
        mode: "reject",
      });
      const ctx = createPluginContext(makeRequest());

      const result = await plugin.execute(ctx);
      expect(result.action).toBe("continue");
    });

    it("rejects when a blocked word is found in string content", async () => {
      const plugin = new WordFilterPlugin({
        blocklist: ["badword"],
        mode: "reject",
      });
      const ctx = createPluginContext(
        makeRequest({
          messages: [{ role: "user", content: "this contains badword here" }],
        }),
      );

      const result = await plugin.execute(ctx);
      expect(result).toEqual({
        action: "reject",
        reason: "Content blocked by word filter",
      });
    });

    it("rejects case-insensitively", async () => {
      const plugin = new WordFilterPlugin({
        blocklist: ["BADWORD"],
        mode: "reject",
      });
      const ctx = createPluginContext(
        makeRequest({
          messages: [{ role: "user", content: "this has BadWord" }],
        }),
      );

      const result = await plugin.execute(ctx);
      expect(result.action).toBe("reject");
    });

    it("rejects when blocked word is in content parts", async () => {
      const plugin = new WordFilterPlugin({
        blocklist: ["forbidden"],
        mode: "reject",
      });
      const ctx = createPluginContext(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "this contains forbidden text" }],
            },
          ],
        }),
      );

      const result = await plugin.execute(ctx);
      expect(result.action).toBe("reject");
    });

    it("checks all messages in the request", async () => {
      const plugin = new WordFilterPlugin({
        blocklist: ["spam"],
        mode: "reject",
      });
      const ctx = createPluginContext(
        makeRequest({
          messages: [
            { role: "system", content: "clean" },
            { role: "user", content: "contains spam word" },
          ],
        }),
      );

      const result = await plugin.execute(ctx);
      expect(result.action).toBe("reject");
    });
  });

  describe("redact mode", () => {
    it("redacts blocked words in string content", async () => {
      const plugin = new WordFilterPlugin({
        blocklist: ["badword"],
        mode: "redact",
      });
      const ctx = createPluginContext(
        makeRequest({
          messages: [{ role: "user", content: "this has badword in it" }],
        }),
      );

      const result = await plugin.execute(ctx);
      expect(result.action).toBe("modify");
      if (result.action === "modify" && result.request) {
        const msg = result.request.messages[0];
        expect(msg?.content).toBe("this has *** in it");
      }
    });

    it("redacts multiple occurrences", async () => {
      const plugin = new WordFilterPlugin({
        blocklist: ["bad"],
        mode: "redact",
      });
      const ctx = createPluginContext(
        makeRequest({
          messages: [{ role: "user", content: "bad bad bad" }],
        }),
      );

      const result = await plugin.execute(ctx);
      expect(result.action).toBe("modify");
      if (result.action === "modify" && result.request) {
        const msg = result.request.messages[0];
        expect(msg?.content).toBe("*** *** ***");
      }
    });

    it("redacts multiple different blocked words", async () => {
      const plugin = new WordFilterPlugin({
        blocklist: ["foo", "bar"],
        mode: "redact",
      });
      const ctx = createPluginContext(
        makeRequest({
          messages: [{ role: "user", content: "foo and bar are blocked" }],
        }),
      );

      const result = await plugin.execute(ctx);
      expect(result.action).toBe("modify");
      if (result.action === "modify" && result.request) {
        const msg = result.request.messages[0];
        expect(msg?.content).toBe("*** and *** are blocked");
      }
    });

    it("redacts in content parts as well", async () => {
      const plugin = new WordFilterPlugin({
        blocklist: ["secret"],
        mode: "redact",
      });
      const ctx = createPluginContext(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "the secret is 42" },
                { type: "text", text: "also here: secret" },
              ],
            },
          ],
        }),
      );

      const result = await plugin.execute(ctx);
      expect(result.action).toBe("modify");
      if (result.action === "modify" && result.request) {
        const msg = result.request.messages[0];
        if (Array.isArray(msg?.content)) {
          expect(msg.content[0]?.text).toBe("the *** is 42");
          expect(msg.content[1]?.text).toBe("also here: ***");
        }
      }
    });

    it("does not modify content when no blocked words found", async () => {
      const plugin = new WordFilterPlugin({
        blocklist: ["evil"],
        mode: "redact",
      });
      const ctx = createPluginContext(
        makeRequest({
          messages: [{ role: "user", content: "clean content" }],
        }),
      );

      const result = await plugin.execute(ctx);
      expect(result.action).toBe("continue");
    });
  });
});
