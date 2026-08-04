/**
 * Environment variable reference resolver — matches Go's internal/envref/envref.go.
 *
 * Only the braced form `${VAR}` is a reference; bare `$` is literal data.
 * Undefined variables throw EnvRefError (never silently blanked).
 * Resolution happens at component construction time, NOT at config load time.
 */

/** Pattern matching ${VAR} references — only braced form is a reference */
const ENV_REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Error thrown when an environment variable reference is undefined */
export class EnvRefError extends Error {
  readonly varName: string;

  constructor(varName: string) {
    super(`environment variable ${varName} is not defined`);
    this.name = "EnvRefError";
    this.varName = varName;
  }
}

/**
 * Expand all ${VAR} references in a string using process.env.
 * Bare $ is preserved (e.g. "$100", "pa$$w0rd").
 * Throws if a referenced variable is not defined in process.env.
 *
 * @param value - String potentially containing ${VAR} references
 * @returns String with all ${VAR} references replaced by their env values
 * @throws {EnvRefError} If a referenced variable is not defined
 */
export function expandEnvRefs(value: string): string {
  // Fast path: empty string or no references
  if (value.length === 0) return value;

  ENV_REF_PATTERN.lastIndex = 0;
  if (!ENV_REF_PATTERN.test(value)) return value;

  ENV_REF_PATTERN.lastIndex = 0;
  return value.replace(ENV_REF_PATTERN, (_match, varName: string): string => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new EnvRefError(varName);
    }
    return envValue;
  });
}

/**
 * Returns the template form of a string for admin API responses.
 * ${VAR} references are preserved as-is (never materialized).
 * This ensures secrets never appear in GET /admin/config or config history.
 *
 * @param value - String potentially containing ${VAR} references
 * @returns Same string with ${VAR} references preserved as templates
 */
export function templateForm(value: string): string {
  return value;
}

/**
 * Expand all ${VAR} references in a Record<string, string> map.
 * Used for MCP headers, MCP env, OTLP headers, plugin config.
 *
 * @param map - String map potentially containing ${VAR} references
 * @returns New map with all ${VAR} references expanded
 * @throws {EnvRefError} If a referenced variable is not defined
 */
export function expandStringMap(map: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(map)) {
    result[key] = expandEnvRefs(map[key]!);
  }
  return result;
}

/**
 * Expand all ${VAR} references in a nested config object.
 * Walks the object recursively, expanding string values.
 * Non-string values (numbers, booleans, null, undefined) are preserved as-is.
 *
 * @param obj - Config object potentially containing ${VAR} references
 * @returns New object with all string ${VAR} references expanded
 * @throws {EnvRefError} If a referenced variable is not defined
 */
export function expandAnyMap(obj: unknown): unknown {
  if (typeof obj === "string") {
    return expandEnvRefs(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(expandAnyMap);
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      result[key] = expandAnyMap((obj as Record<string, unknown>)[key]);
    }
    return result;
  }

  // Primitives (number, boolean, null, undefined) pass through unchanged
  return obj;
}
