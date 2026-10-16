import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Exporter, ExporterEvent } from "@/observability/exporter-registry";
import {
  lookupExporter,
  registerExporter,
  resetExporters,
  resolveEnabledExporters,
} from "@/observability/exporter-registry";

interface ExporterHooks {
  onInit?: (config: Record<string, unknown>) => void;
  onExport?: (event: ExporterEvent) => void;
  onShutdown?: () => void;
}

function makeExporter(name: string, hooks: ExporterHooks = {}): Exporter {
  return {
    name,
    init(config: Record<string, unknown>): void {
      hooks.onInit?.(config);
    },
    export(event: ExporterEvent): void {
      hooks.onExport?.(event);
    },
    shutdown(): void {
      hooks.onShutdown?.();
    },
  };
}

describe("exporter registry", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetExporters();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("registers and looks up an exporter", () => {
    registerExporter("console", () => makeExporter("console"));
    const exporter = lookupExporter("console");
    expect(exporter).toBeDefined();
    expect(exporter?.name).toBe("console");
    expect(typeof exporter?.init).toBe("function");
    expect(typeof exporter?.export).toBe("function");
    expect(typeof exporter?.shutdown).toBe("function");
  });

  it("returns undefined for an unregistered exporter name", () => {
    expect(lookupExporter("missing")).toBeUndefined();
  });

  it("skips exporters with enabled=false", () => {
    registerExporter("console", () => makeExporter("console"));
    const { exporters, skipped } = resolveEnabledExporters([
      { name: "console", enabled: false, config: {} },
    ]);
    expect(exporters).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("skips unknown exporter names, records them and warns", () => {
    const { exporters, skipped } = resolveEnabledExporters([
      { name: "ghost", enabled: true, config: {} },
    ]);
    expect(exporters).toEqual([]);
    expect(skipped).toEqual(["ghost"]);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("skips exporters whose init throws, records them and warns", () => {
    registerExporter("broken", () => ({
      name: "broken",
      init(): void {
        throw new Error("boom");
      },
      export(): void {},
      shutdown(): void {},
    }));
    const { exporters, skipped } = resolveEnabledExporters([
      { name: "broken", enabled: true, config: {} },
    ]);
    expect(exporters).toEqual([]);
    expect(skipped).toEqual(["broken"]);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("overrides a previously registered factory for the same name", () => {
    registerExporter("dup", () => makeExporter("first"));
    registerExporter("dup", () => makeExporter("second"));
    const { exporters } = resolveEnabledExporters([{ name: "dup", enabled: true, config: {} }]);
    expect(exporters).toHaveLength(1);
    expect(exporters[0]?.name).toBe("second");
  });

  it("passes the entry config through to the exporter init", () => {
    const initConfigs: Array<Record<string, unknown>> = [];
    registerExporter("cfg", () => makeExporter("cfg", { onInit: (c) => initConfigs.push(c) }));
    resolveEnabledExporters([
      {
        name: "cfg",
        enabled: true,
        config: { endpoint: "http://collector:4318", headers: { Authorization: "Bearer x" } },
      },
    ]);
    expect(initConfigs).toEqual([
      { endpoint: "http://collector:4318", headers: { Authorization: "Bearer x" } },
    ]);
  });

  it("delivers export events to the resolved exporter", () => {
    const events: ExporterEvent[] = [];
    registerExporter("sink", () => makeExporter("sink", { onExport: (e) => events.push(e) }));
    const { exporters } = resolveEnabledExporters([{ name: "sink", enabled: true, config: {} }]);
    const event: ExporterEvent = {
      type: "span",
      traceId: "abcdef0123456789",
      spanId: "0123456789abcdef",
      name: "proxy.request",
      status: "ok",
      timestamp: 1_700_000_000_000,
    };
    exporters[0]?.export(event);
    expect(events).toEqual([event]);
  });

  it("calls shutdown on resolved exporters", async () => {
    const shutDown: string[] = [];
    registerExporter("sink", () =>
      makeExporter("sink", { onShutdown: () => shutDown.push("sink") }),
    );
    const { exporters } = resolveEnabledExporters([{ name: "sink", enabled: true, config: {} }]);
    for (const exporter of exporters) {
      await exporter.shutdown();
    }
    expect(shutDown).toEqual(["sink"]);
  });

  it("handles an empty config array", () => {
    const { exporters, skipped } = resolveEnabledExporters([]);
    expect(exporters).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("resets the registry so it does not leak between callers", () => {
    registerExporter("iso", () => makeExporter("iso"));
    expect(lookupExporter("iso")).toBeDefined();
    resetExporters();
    expect(lookupExporter("iso")).toBeUndefined();
  });

  it("resolves a mix of enabled, disabled and unknown entries", () => {
    registerExporter("a", () => makeExporter("a"));
    registerExporter("b", () => makeExporter("b"));
    const { exporters, skipped } = resolveEnabledExporters([
      { name: "a", enabled: true, config: {} },
      { name: "b", enabled: false, config: {} },
      { name: "ghost", enabled: true, config: {} },
    ]);
    expect(exporters.map((e) => e.name)).toEqual(["a"]);
    expect(skipped).toEqual(["ghost"]);
  });
});
