/**
 * Pluggable exporter registry.
 *
 * Exporters (OTLP, console, file, ...) register a factory by name and are
 * resolved from configuration at startup. This module defines the contract
 * only; it ships no concrete exporters.
 */

export interface Exporter {
  name: string;
  init(config: Record<string, unknown>): void;
  export(event: ExporterEvent): void;
  shutdown(): void | Promise<void>;
}

export interface ExporterEvent {
  type: string;
  traceId?: string;
  spanId?: string;
  name?: string;
  status?: string;
  attributes?: Record<string, unknown>;
  errorMessage?: string;
  timestamp: number;
}

export interface ExporterConfigEntry {
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

type ExporterFactory = (config: Record<string, unknown>) => Exporter;

const registry = new Map<string, ExporterFactory>();

export function registerExporter(name: string, factory: ExporterFactory): void {
  registry.set(name, factory);
}

export function lookupExporter(name: string): Exporter | undefined {
  const factory = registry.get(name);
  return factory === undefined ? undefined : factory({});
}

export function resolveEnabledExporters(
  configs: ExporterConfigEntry[],
): { exporters: Exporter[]; skipped: string[] } {
  const exporters: Exporter[] = [];
  const skipped: string[] = [];

  for (const entry of configs) {
    if (!entry.enabled) continue;

    const factory = registry.get(entry.name);
    if (factory === undefined) {
      console.warn(`exporter registry: unknown exporter "${entry.name}", skipping`);
      skipped.push(entry.name);
      continue;
    }

    try {
      const exporter = factory(entry.config);
      exporter.init(entry.config);
      exporters.push(exporter);
    } catch {
      console.warn(`exporter registry: failed to initialize exporter "${entry.name}", skipping`);
      skipped.push(entry.name);
    }
  }

  return { exporters, skipped };
}

export function resetExporters(): void {
  registry.clear();
}
