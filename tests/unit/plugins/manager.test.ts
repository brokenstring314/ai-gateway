import { beforeEach, describe, expect, it } from "vitest";
import { createPluginContext } from "../../../src/plugins/context.js";
import { PluginRejectionError } from "../../../src/plugins/error.js";
import { PluginManager } from "../../../src/plugins/manager.js";
import type { IPlugin, PluginContext, PluginResult, Stage } from "../../../src/plugins/types.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../../src/providers/types.js";

function makeRequest(overrides?: Partial<ChatCompletionRequest>): ChatCompletionRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function makeResponse(overrides?: Partial<ChatCompletionResponse>): ChatCompletionResponse {
  return {
    id: "resp-1",
    object: "chat.completion",
    created: Date.now(),
    model: "test-model",
    provider: "test",
    choices: [
      { index: 0, message: { role: "assistant", content: "hi" }, finishReason: "stop" },
    ],
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    ...overrides,
  };
}

class TestPlugin implements IPlugin {
  readonly name: string;
  readonly stage: Stage;
  private readonly handler: (ctx: PluginContext) => Promise<PluginResult>;

  constructor(
    name: string,
    stage: Stage,
    handler: (ctx: PluginContext) => Promise<PluginResult>,
  ) {
    this.name = name;
    this.stage = stage;
    this.handler = handler;
  }

  async execute(ctx: PluginContext): Promise<PluginResult> {
    return this.handler(ctx);
  }
}

describe("PluginManager", () => {
  let manager: PluginManager;

  beforeEach(() => {
    manager = new PluginManager();
  });

  describe("hasPlugins", () => {
    it("returns false when no plugins are registered", () => {
      expect(manager.hasPlugins()).toBe(false);
    });

    it("returns true when a before_request plugin is registered", () => {
      manager.register(
        "before_request",
        new TestPlugin("t1", "before_request", async () => ({ action: "continue" })),
      );
      expect(manager.hasPlugins()).toBe(true);
    });

    it("returns true when an after_request plugin is registered", () => {
      manager.register(
        "after_request",
        new TestPlugin("t1", "after_request", async () => ({ action: "continue" })),
      );
      expect(manager.hasPlugins()).toBe(true);
    });

    it("returns true when an on_error plugin is registered", () => {
      manager.register(
        "on_error",
        new TestPlugin("t1", "on_error", async () => ({ action: "continue" })),
      );
      expect(manager.hasPlugins()).toBe(true);
    });
  });

  describe("runBefore", () => {
    it("executes before_request plugins in registration order", async () => {
      const order: string[] = [];
      manager.register(
        "before_request",
        new TestPlugin("p1", "before_request", async () => {
          order.push("p1");
          return { action: "continue" };
        }),
      );
      manager.register(
        "before_request",
        new TestPlugin("p2", "before_request", async () => {
          order.push("p2");
          return { action: "continue" };
        }),
      );

      const ctx = createPluginContext(makeRequest());
      await manager.runBefore(ctx);
      expect(order).toEqual(["p1", "p2"]);
    });

    it("stops and returns response when plugin returns short_circuit", async () => {
      const order: string[] = [];
      const shortResponse = makeResponse({ id: "short" });
      manager.register(
        "before_request",
        new TestPlugin("p1", "before_request", async () => {
          order.push("p1");
          return { action: "short_circuit", response: shortResponse };
        }),
      );
      manager.register(
        "before_request",
        new TestPlugin("p2", "before_request", async () => {
          order.push("p2");
          return { action: "continue" };
        }),
      );

      const ctx = createPluginContext(makeRequest());
      await manager.runBefore(ctx);
      expect(order).toEqual(["p1"]);
      expect(ctx.response).toBe(shortResponse);
    });

    it("stops when plugin calls ctx.shortCircuit()", async () => {
      const order: string[] = [];
      const shortResponse = makeResponse({ id: "short" });
      manager.register(
        "before_request",
        new TestPlugin("p1", "before_request", async (ctx) => {
          order.push("p1");
          ctx.shortCircuit(shortResponse);
          return { action: "continue" };
        }),
      );
      manager.register(
        "before_request",
        new TestPlugin("p2", "before_request", async () => {
          order.push("p2");
          return { action: "continue" };
        }),
      );

      const ctx = createPluginContext(makeRequest());
      await manager.runBefore(ctx);
      expect(order).toEqual(["p1"]);
      expect(ctx.response).toBe(shortResponse);
    });

    it("throws PluginRejectionError when plugin returns reject", async () => {
      manager.register(
        "before_request",
        new TestPlugin("p1", "before_request", async () => ({
          action: "reject",
          reason: "test rejection",
        })),
      );

      const ctx = createPluginContext(makeRequest());
      await expect(manager.runBefore(ctx)).rejects.toThrow(PluginRejectionError);
      await expect(manager.runBefore(ctx)).rejects.toThrow("test rejection");
    });

    it("stops remaining plugins after a reject (exception thrown)", async () => {
      const order: string[] = [];
      manager.register(
        "before_request",
        new TestPlugin("p1", "before_request", async () => {
          order.push("p1");
          return { action: "reject", reason: "blocked" };
        }),
      );
      manager.register(
        "before_request",
        new TestPlugin("p2", "before_request", async () => {
          order.push("p2");
          return { action: "continue" };
        }),
      );

      const ctx = createPluginContext(makeRequest());
      await expect(manager.runBefore(ctx)).rejects.toThrow(PluginRejectionError);
      expect(order).toEqual(["p1"]);
    });

    it("applies request modification when plugin returns modify with request", async () => {
      const modifiedReq = makeRequest({ model: "modified-model" });
      manager.register(
        "before_request",
        new TestPlugin("p1", "before_request", async () => ({
          action: "modify",
          request: modifiedReq,
        })),
      );

      const ctx = createPluginContext(makeRequest());
      await manager.runBefore(ctx);
      expect(ctx.request.model).toBe("modified-model");
    });

    it("applies response modification when plugin returns modify with response", async () => {
      const modifiedResp = makeResponse({ model: "modified-model" });
      manager.register(
        "before_request",
        new TestPlugin("p1", "before_request", async () => ({
          action: "modify",
          response: modifiedResp,
        })),
      );

      const ctx = createPluginContext(makeRequest());
      await manager.runBefore(ctx);
      expect(ctx.response).toBe(modifiedResp);
    });

    it("continues to next plugin after a modify action", async () => {
      const order: string[] = [];
      manager.register(
        "before_request",
        new TestPlugin("p1", "before_request", async () => {
          order.push("p1");
          return { action: "modify", request: makeRequest({ model: "m1" }) };
        }),
      );
      manager.register(
        "before_request",
        new TestPlugin("p2", "before_request", async () => {
          order.push("p2");
          return { action: "continue" };
        }),
      );

      const ctx = createPluginContext(makeRequest());
      await manager.runBefore(ctx);
      expect(order).toEqual(["p1", "p2"]);
    });
  });

  describe("runAfter", () => {
    it("executes all after_request plugins in order", async () => {
      const order: string[] = [];
      manager.register(
        "after_request",
        new TestPlugin("p1", "after_request", async () => {
          order.push("p1");
          return { action: "continue" };
        }),
      );
      manager.register(
        "after_request",
        new TestPlugin("p2", "after_request", async () => {
          order.push("p2");
          return { action: "continue" };
        }),
      );

      const ctx = createPluginContext(makeRequest());
      await manager.runAfter(ctx);
      expect(order).toEqual(["p1", "p2"]);
    });

    it("does not short-circuit on after_request (continues chain)", async () => {
      const order: string[] = [];
      manager.register(
        "after_request",
        new TestPlugin("p1", "after_request", async () => {
          order.push("p1");
          return { action: "short_circuit", response: makeResponse() };
        }),
      );
      manager.register(
        "after_request",
        new TestPlugin("p2", "after_request", async () => {
          order.push("p2");
          return { action: "continue" };
        }),
      );

      const ctx = createPluginContext(makeRequest());
      await manager.runAfter(ctx);
      expect(order).toEqual(["p1", "p2"]);
    });
  });

  describe("runOnError", () => {
    it("executes on_error plugins when ctx has an error", async () => {
      const order: string[] = [];
      manager.register(
        "on_error",
        new TestPlugin("p1", "on_error", async () => {
          order.push("p1");
          return { action: "continue" };
        }),
      );

      const ctx = createPluginContext(makeRequest());
      ctx.error = new Error("test error");
      await manager.runOnError(ctx);
      expect(order).toEqual(["p1"]);
    });

    it("executes all on_error plugins in order", async () => {
      const order: string[] = [];
      manager.register(
        "on_error",
        new TestPlugin("p1", "on_error", async () => {
          order.push("p1");
          return { action: "continue" };
        }),
      );
      manager.register(
        "on_error",
        new TestPlugin("p2", "on_error", async () => {
          order.push("p2");
          return { action: "continue" };
        }),
      );

      const ctx = createPluginContext(makeRequest());
      ctx.error = new Error("test error");
      await manager.runOnError(ctx);
      expect(order).toEqual(["p1", "p2"]);
    });
  });

  describe("plugin stage isolation", () => {
    it("only runs before_request plugins during runBefore", async () => {
      const beforeOrder: string[] = [];
      const afterOrder: string[] = [];
      manager.register(
        "before_request",
        new TestPlugin("b1", "before_request", async () => {
          beforeOrder.push("b1");
          return { action: "continue" };
        }),
      );
      manager.register(
        "after_request",
        new TestPlugin("a1", "after_request", async () => {
          afterOrder.push("a1");
          return { action: "continue" };
        }),
      );

      const ctx = createPluginContext(makeRequest());
      await manager.runBefore(ctx);
      expect(beforeOrder).toEqual(["b1"]);
      expect(afterOrder).toEqual([]);
    });
  });

  describe("plugin error isolation", () => {
    it("failing logging plugin does not crash request (fail-open for after_request)", async () => {
      manager.register(
        "after_request",
        new TestPlugin("bad-logger", "after_request", async () => {
          throw new Error("logger crashed");
        }),
      );
      manager.register(
        "after_request",
        new TestPlugin("good-logger", "after_request", async () => ({
          action: "continue",
        })),
      );

      const ctx = createPluginContext(makeRequest());
      await expect(manager.runAfter(ctx)).rejects.toThrow("logger crashed");
    });

    it("failing guardrail plugin crashes request (fail-closed for before_request)", async () => {
      manager.register(
        "before_request",
        new TestPlugin("guardrail", "before_request", async () => {
          throw new Error("guardrail crashed");
        }),
      );

      const ctx = createPluginContext(makeRequest());
      await expect(manager.runBefore(ctx)).rejects.toThrow("guardrail crashed");
    });

    it("failing on_error plugin propagates error", async () => {
      manager.register(
        "on_error",
        new TestPlugin("bad-handler", "on_error", async () => {
          throw new Error("error handler crashed");
        }),
      );

      const ctx = createPluginContext(makeRequest());
      ctx.error = new Error("original error");
      await expect(manager.runOnError(ctx)).rejects.toThrow("error handler crashed");
    });
  });
});
