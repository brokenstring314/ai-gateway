/**
 * Provider registry — stores and looks up provider instances.
 *
 * Implements IProviderSource. Not a singleton; instantiate as needed.
 */

import type { IProvider, IProviderSource, ModelInfo } from "./types.js";

export class ProviderRegistry implements IProviderSource {
  private readonly providers = new Map<string, IProvider>();

  /** Register a provider. Overwrites any existing provider with the same name. */
  register(provider: IProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** Get a provider by name. Returns undefined if not found. */
  get(name: string): IProvider | undefined {
    return this.providers.get(name);
  }

  /** List all registered provider names. */
  list(): string[] {
    return [...this.providers.keys()];
  }

  /** Return all models from all registered providers, deduplicated by model ID. */
  allModels(): readonly ModelInfo[] {
    const seen = new Map<string, ModelInfo>();
    for (const provider of this.providers.values()) {
      for (const model of provider.models()) {
        if (!seen.has(model.id)) {
          seen.set(model.id, model);
        }
      }
    }
    return [...seen.values()];
  }

  /** Find a provider that supports the given model ID. */
  findByModel(model: string): IProvider | undefined {
    for (const provider of this.providers.values()) {
      if (provider.supportsModel(model)) {
        return provider;
      }
    }
    return undefined;
  }

  /** Remove a provider by name. */
  unregister(name: string): boolean {
    return this.providers.delete(name);
  }

  /** Number of registered providers. */
  get size(): number {
    return this.providers.size;
  }
}
