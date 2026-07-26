/**
 * Databricks provider definition.
 *
 * Base URL is configurable — defaults to Databricks serving endpoint pattern.
 * API key format: `dapi<...>` (Databricks personal access token).
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createDatabricks(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "databricks",
    baseURL: baseURL ?? "https://<workspace>.cloud.databricks.com/serving-endpoints",
    apiKey,
    models: [
      "databricks-dbrx-instruct",
      "databricks-meta-llama-3.1-70b-instruct",
      "databricks-mixtral-8x7b-instruct",
    ],
  });
}
