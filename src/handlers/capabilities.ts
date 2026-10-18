import type { AppType } from "../app.js";
import type { Gateway } from "../gateway.js";
import { getCapabilities, ProviderCapability } from "../providers/capabilities.js";

const ALL_CAPABILITY_NAMES: readonly string[] = Object.values(ProviderCapability);

export function registerCapabilitiesHandler(app: AppType, gateway: Gateway): void {
  app.get("/v1/capabilities", (c) => {
    const registry = gateway.getRegistry();
    const providerNames = registry.list();

    const providers: Record<string, { capabilities: string[] }> = {};

    for (const name of providerNames) {
      const caps = getCapabilities(name);
      providers[name] = {
        capabilities: ALL_CAPABILITY_NAMES.filter((cap): cap is ProviderCapability =>
          caps.has(cap as ProviderCapability),
        ),
      };
    }

    return c.json({ providers }, 200);
  });
}
