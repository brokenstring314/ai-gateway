/** core/stream-runner: executeStream / iterateStream (PR 2.5). */
import { describe, it, expect } from "bun:test";
import { TargetExecutor } from "@/core/executor";
import { executeStream, iterateStream } from "@/core/stream-runner";
import type { StreamEnd } from "@/core/types";
import { ReadableStreamError } from "@/providers/sse-parser";
import type { IProvider, RequestContext } from "@/providers/types";

type Script = () => AsyncGenerator<string>;

function fixture(scripts: Record<string, Script>) {
  const providers = new Map<string, IProvider>(
    Object.keys(scripts).map((name) => [name, { name, completeStream: () => scripts[name]!() } as unknown as IProvider]),
  );
  const executor = new TargetExecutor({ lookup: (n) => providers.get(n) });
  const ends: { end: StreamEnd; target: string | undefined }[] = [];
  const plan = {
    executor,
    candidates: Object.keys(scripts),
    open: (p: IProvider) => (p as unknown as { completeStream: () => AsyncIterable<string> }).completeStream(),
    run: { label: "test" },
  };
  const hooks = { finalize: async (end: StreamEnd, target: string | undefined) => { ends.push({ end, target }); } };
  return { plan, hooks, ends };
}

const ctx = (signal?: AbortSignal): RequestContext => ({ signal }) as RequestContext;

describe("executeStream", () => {
  it("fails over when the first target yields zero chunks; target = the one that produced the first chunk", async () => {
    const { plan, hooks, ends } = fixture({
      a: async function* () {},
      b: async function* () { yield "x"; yield "y"; },
    });
    const r = await executeStream(ctx(), plan, hooks);
    expect(r.target).toBe("b");
    const out: string[] = [];
    for await (const c of iterateStream(r)) out.push(c);
    expect(out).toEqual(["x", "y"]);
    expect(ends).toEqual([{ end: { reason: "done" }, target: "b" }]);
  });

  it("fails over on a truncated stream before the first chunk", async () => {
    const { plan, hooks } = fixture({
      a: async function* () { throw new ReadableStreamError("cut", "upstream_stream_truncated"); },
      b: async function* () { yield "ok"; },
    });
    expect((await executeStream(ctx(), plan, hooks)).target).toBe("b");
  });

  it("settles once with upstream_error when no candidate produced a chunk", async () => {
    const { plan, hooks, ends } = fixture({ a: async function* () {} });
    await expect(executeStream(ctx(), plan, hooks)).rejects.toBeInstanceOf(ReadableStreamError);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.end.reason).toBe("upstream_error");
    expect(ends[0]!.target).toBeUndefined();
  });
});

describe("iterateStream", () => {
  it("truncation after output: no failover, settled as truncated, error rethrown", async () => {
    const { plan, hooks, ends } = fixture({
      a: async function* () { yield "part"; throw new ReadableStreamError("cut", "upstream_stream_truncated"); },
      b: async function* () { yield "never"; },
    });
    const r = await executeStream(ctx(), plan, hooks);
    const out: string[] = [];
    const err = await (async () => { for await (const c of iterateStream(r)) out.push(c); })().then(() => null, (e: unknown) => e);
    expect(out).toEqual(["part"]);
    expect(err).toBeInstanceOf(ReadableStreamError);
    expect(ends.map((e) => e.end.reason)).toEqual(["truncated"]);
  });

  it("early return settles client_cancel once and releases the upstream iterator", async () => {
    let released = false;
    const { plan, hooks, ends } = fixture({
      a: async function* () { try { yield "1"; yield "2"; yield "3"; } finally { released = true; } },
    });
    const r = await executeStream(ctx(), plan, hooks);
    for await (const c of iterateStream(r)) { if (c === "2") break; }
    expect(released).toBe(true);
    expect(ends.map((e) => e.end.reason)).toEqual(["client_cancel"]);
    await r.settle({ reason: "done" }); // idempotent
    expect(ends).toHaveLength(1);
  });

  it("early return after the gateway idle timer aborted the request settles idle_timeout", async () => {
    const ac = new AbortController();
    const { plan, hooks, ends } = fixture({ a: async function* () { yield "1"; yield "2"; } });
    const r = await executeStream(ctx(ac.signal), plan, hooks);
    for await (const _ of iterateStream(r, ac.signal)) {
      ac.abort(new DOMException("idle", "TimeoutError"));
      break;
    }
    expect(ends.map((e) => e.end.reason)).toEqual(["idle_timeout"]);
  });
});
