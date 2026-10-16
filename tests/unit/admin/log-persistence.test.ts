import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { RequestLogStore, type RequestLogEntry } from "@/persistence/request-log-store";
import {
  LogBuffer,
  getLogsHandler,
  getLogsStatsHandler,
  deleteLogsHandler,
  type LogHandlerState,
} from "@/admin/log-handlers";

interface LogEntryResponse {
  traceId: string;
  stage: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  errorMessage: string;
  createdAt: string;
}

interface StatsResponse {
  totalEntries: number;
  errorEntries: number;
  totalTokens: number;
  byStage: Record<string, number>;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
}

function makeEntry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    traceId: overrides.traceId ?? "trace-1",
    stage: overrides.stage ?? "before_request",
    model: overrides.model ?? "gpt-4",
    provider: overrides.provider ?? "openai",
    promptTokens: overrides.promptTokens ?? 100,
    completionTokens: overrides.completionTokens ?? 50,
    totalTokens: overrides.totalTokens ?? 150,
    errorMessage: overrides.errorMessage ?? "",
    createdAt: overrides.createdAt ?? new Date(),
  };
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function createApp(store: RequestLogStore | null): Hono {
  const state: LogHandlerState = { logStore: store };
  const app = new Hono();
  app.get("/logs", getLogsHandler(state));
  app.get("/logs/stats", getLogsStatsHandler(state));
  app.delete("/logs", deleteLogsHandler(state));
  return app;
}

describe("Admin log handlers (RequestLogStore-backed)", () => {
  let db: Database;
  let store: RequestLogStore;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new RequestLogStore(db);
    app = createApp(store);
  });

  afterEach(() => {
    db.close();
  });

  it("write then GET /logs returns the entry with total", async () => {
    store.write(makeEntry({ traceId: "t1", stage: "before_request" }));

    const res = await app.request("/logs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: LogEntryResponse[]; total: number };
    expect(body.total).toBe(1);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.traceId).toBe("t1");
    expect(body.entries[0]!.stage).toBe("before_request");
    expect(body.entries[0]!.model).toBe("gpt-4");
    expect(body.entries[0]!.provider).toBe("openai");
    expect(body.entries[0]!.promptTokens).toBe(100);
    expect(body.entries[0]!.completionTokens).toBe(50);
    expect(body.entries[0]!.totalTokens).toBe(150);
  });

  it("GET /logs honors limit/offset pagination", async () => {
    for (let i = 0; i < 10; i++) {
      store.write(makeEntry({ traceId: `t${i}`, createdAt: new Date(Date.now() - i * 1000) }));
    }

    const page1 = (await (await app.request("/logs?limit=3&offset=0")).json()) as {
      entries: LogEntryResponse[];
      total: number;
    };
    expect(page1.entries).toHaveLength(3);
    expect(page1.total).toBe(10);
    expect(page1.entries[0]!.traceId).toBe("t0");

    const page2 = (await (await app.request("/logs?limit=3&offset=3")).json()) as {
      entries: LogEntryResponse[];
      total: number;
    };
    expect(page2.entries).toHaveLength(3);
    expect(page2.entries[0]!.traceId).toBe("t3");
    expect(page2.entries[0]!.traceId).not.toBe(page1.entries[0]!.traceId);
  });

  it("GET /logs clamps limit to max 200", async () => {
    for (let i = 0; i < 300; i++) {
      store.write(makeEntry({ traceId: `t${i}` }));
    }

    const body = (await (await app.request("/logs?limit=999")).json()) as {
      entries: LogEntryResponse[];
      total: number;
    };
    expect(body.entries).toHaveLength(200);
    expect(body.total).toBe(300);
  });

  it("GET /logs filters by stage", async () => {
    store.write(makeEntry({ stage: "before_request" }));
    store.write(makeEntry({ stage: "after_request" }));
    store.write(makeEntry({ stage: "before_request" }));

    const body = (await (await app.request("/logs?stage=before_request")).json()) as {
      entries: LogEntryResponse[];
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.entries).toHaveLength(2);
    for (const entry of body.entries) {
      expect(entry.stage).toBe("before_request");
    }
  });

  it("GET /logs filters by model", async () => {
    store.write(makeEntry({ model: "gpt-4" }));
    store.write(makeEntry({ model: "claude-3" }));
    store.write(makeEntry({ model: "gpt-4" }));

    const body = (await (await app.request("/logs?model=gpt-4")).json()) as {
      entries: LogEntryResponse[];
      total: number;
    };
    expect(body.total).toBe(2);
    for (const entry of body.entries) {
      expect(entry.model).toBe("gpt-4");
    }
  });

  it("GET /logs filters by provider", async () => {
    store.write(makeEntry({ provider: "openai" }));
    store.write(makeEntry({ provider: "anthropic" }));

    const body = (await (await app.request("/logs?provider=openai")).json()) as {
      entries: LogEntryResponse[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.entries[0]!.provider).toBe("openai");
  });

  it("GET /logs filters by since", async () => {
    store.write(makeEntry({ traceId: "old", createdAt: daysAgo(3) }));
    store.write(makeEntry({ traceId: "recent", createdAt: new Date() }));

    const body = (await (await app.request(`/logs?since=${daysAgo(1).toISOString()}`)).json()) as {
      entries: LogEntryResponse[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.entries[0]!.traceId).toBe("recent");
  });

  it("GET /logs/stats aggregates byStage/byProvider/byModel", async () => {
    store.write(makeEntry({ stage: "before_request", provider: "openai", model: "gpt-4" }));
    store.write(makeEntry({ stage: "after_request", provider: "anthropic", model: "claude-3" }));
    store.write(makeEntry({ stage: "before_request", provider: "openai", model: "gpt-4" }));

    const body = (await (await app.request("/logs/stats")).json()) as StatsResponse;
    expect(body.totalEntries).toBe(3);
    expect(body.byStage["before_request"]).toBe(2);
    expect(body.byStage["after_request"]).toBe(1);
    expect(body.byProvider["openai"]).toBe(2);
    expect(body.byProvider["anthropic"]).toBe(1);
    expect(body.byModel["gpt-4"]).toBe(2);
    expect(body.byModel["claude-3"]).toBe(1);
  });

  it("GET /logs/stats reports error entries and total tokens", async () => {
    store.write(makeEntry({ errorMessage: "", totalTokens: 100 }));
    store.write(makeEntry({ errorMessage: "rate limited", totalTokens: 200 }));
    store.write(makeEntry({ errorMessage: "", stage: "on_error", totalTokens: 300 }));

    const body = (await (await app.request("/logs/stats")).json()) as StatsResponse;
    expect(body.totalEntries).toBe(3);
    expect(body.errorEntries).toBe(2);
    expect(body.totalTokens).toBe(600);
  });

  it("GET /logs/stats respects filters", async () => {
    store.write(makeEntry({ stage: "before_request", provider: "openai", model: "gpt-4" }));
    store.write(makeEntry({ stage: "before_request", provider: "openai", model: "gpt-4" }));
    store.write(makeEntry({ stage: "after_request", provider: "anthropic", model: "claude-3" }));

    const body = (await (await app.request("/logs/stats?stage=before_request")).json()) as StatsResponse;
    expect(body.totalEntries).toBe(2);
    expect(body.byStage["before_request"]).toBe(2);
    expect(body.byStage["after_request"]).toBeUndefined();
    expect(body.byProvider["anthropic"]).toBeUndefined();
    expect(body.totalTokens).toBe(300);
  });

  it("DELETE /logs removes entries older than before and returns count", async () => {
    store.write(makeEntry({ traceId: "old1", createdAt: daysAgo(3) }));
    store.write(makeEntry({ traceId: "old2", createdAt: daysAgo(3) }));
    store.write(makeEntry({ traceId: "recent", createdAt: daysAgo(1) }));

    const res = await app.request(`/logs?before=${daysAgo(2).toISOString()}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(2);

    const remaining = (await (await app.request("/logs")).json()) as { total: number };
    expect(remaining.total).toBe(1);
  });

  it("DELETE /logs without before returns 400", async () => {
    const res = await app.request("/logs", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("DELETE /logs with invalid before returns 400", async () => {
    const res = await app.request("/logs?before=not-a-date", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("DELETE /logs with stage filter only deletes matching entries", async () => {
    store.write(makeEntry({ traceId: "a", stage: "before_request", createdAt: daysAgo(3) }));
    store.write(makeEntry({ traceId: "b", stage: "after_request", createdAt: daysAgo(3) }));

    const res = await app.request(`/logs?before=${daysAgo(2).toISOString()}&stage=before_request`, {
      method: "DELETE",
    });
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(1);

    const remaining = (await (await app.request("/logs")).json()) as {
      entries: LogEntryResponse[];
      total: number;
    };
    expect(remaining.total).toBe(1);
    expect(remaining.entries[0]!.stage).toBe("after_request");
  });

  it("no store → GET /logs returns empty and GET /logs/stats returns zeros", async () => {
    const emptyApp = createApp(null);

    const listBody = (await (await emptyApp.request("/logs")).json()) as {
      entries: LogEntryResponse[];
      total: number;
    };
    expect(listBody.entries).toHaveLength(0);
    expect(listBody.total).toBe(0);

    const statsBody = (await (await emptyApp.request("/logs/stats")).json()) as StatsResponse;
    expect(statsBody.totalEntries).toBe(0);
    expect(statsBody.errorEntries).toBe(0);
    expect(statsBody.totalTokens).toBe(0);
    expect(statsBody.byStage).toEqual({});
    expect(statsBody.byProvider).toEqual({});
    expect(statsBody.byModel).toEqual({});
  });

  it("no store → DELETE /logs returns 0 deleted", async () => {
    const emptyApp = createApp(null);
    const res = await emptyApp.request("/logs?before=2026-01-01T00:00:00.000Z", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(0);
  });

  it("getLogsHandler still serves the legacy LogBuffer", async () => {
    const buffer = new LogBuffer(10);
    buffer.push({ timestamp: "t", level: "info", message: "hello" });
    const legacyApp = new Hono();
    legacyApp.get("/logs", getLogsHandler(buffer));

    const body = (await (await legacyApp.request("/logs")).json()) as {
      entries: { message: string }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.entries[0]!.message).toBe("hello");
  });
});
