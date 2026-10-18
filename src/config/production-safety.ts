export class ProductionSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionSafetyError";
  }
}

export interface ProductionSafetyContext {
  gatewayEnv?: string;
  allowUnauthenticatedProxy?: boolean;
  adminSecret?: string;
  authEnabled?: boolean;
  hasAuthKeys?: boolean;
  keyStoreEmpty?: boolean;
}

export function validateProductionSafety(ctx: ProductionSafetyContext): void {
  if (ctx.gatewayEnv !== "production") return;

  if (ctx.allowUnauthenticatedProxy === true) {
    throw new ProductionSafetyError("production mode must not allow unauthenticated proxy access");
  }

  if (ctx.adminSecret !== undefined && ctx.adminSecret.length < 16) {
    throw new ProductionSafetyError("production mode requires an admin secret of at least 16 characters");
  }

  if (ctx.authEnabled === false) {
    throw new ProductionSafetyError("production mode requires authentication to be enabled");
  }

  if (!ctx.hasAuthKeys && ctx.keyStoreEmpty !== false) {
    throw new ProductionSafetyError("production mode requires at least one API key");
  }
}

export function isProductionMode(): boolean {
  return process.env["GATEWAY_ENV"] === "production";
}

export function parseAllowUnauthenticatedProxy(): boolean {
  return process.env["ALLOW_UNAUTHENTICATED_PROXY"] === "true";
}

/**
 * Client auth on non-admin routes is disabled only by an explicit
 * `auth.enabled: false`. A missing `auth` block or a missing `enabled` field
 * means auth stays on (fail closed).
 */
export function isClientAuthEnabled(auth: { enabled?: boolean } | undefined): boolean {
  return auth?.enabled !== false;
}

/** True when the host listens on all interfaces (IPv4 or IPv6 wildcard). */
export function isWildcardHost(host: string | undefined): boolean {
  const h = (host ?? "0.0.0.0").trim().toLowerCase();
  return h === "0.0.0.0" || h === "::" || h === "[::]" || h === "";
}

/**
 * Loud startup warning when client auth is explicitly disabled while the
 * server binds to every interface. Returns undefined when nothing to warn.
 */
export function authExposureWarning(
  auth: { enabled?: boolean } | undefined,
  host: string | undefined,
): string | undefined {
  if (isClientAuthEnabled(auth) || !isWildcardHost(host)) return undefined;
  return (
    `WARNING: client authentication is DISABLED (auth.enabled: false) and the server binds ` +
    `${host ?? "0.0.0.0"} (all interfaces). Anyone who can reach this port can use /v1/* ` +
    `with your upstream provider keys. Set auth.enabled: true or bind server.host to 127.0.0.1.`
  );
}
