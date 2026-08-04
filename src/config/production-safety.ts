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
    throw new ProductionSafetyError(
      "production mode must not allow unauthenticated proxy access",
    );
  }

  if (ctx.adminSecret !== undefined && ctx.adminSecret.length < 16) {
    throw new ProductionSafetyError(
      "production mode requires an admin secret of at least 16 characters",
    );
  }

  if (ctx.authEnabled === false) {
    throw new ProductionSafetyError(
      "production mode requires authentication to be enabled",
    );
  }

  if (!ctx.hasAuthKeys && ctx.keyStoreEmpty !== false) {
    throw new ProductionSafetyError(
      "production mode requires at least one API key",
    );
  }
}

export function isProductionMode(): boolean {
  return process.env["GATEWAY_ENV"] === "production";
}

export function parseAllowUnauthenticatedProxy(): boolean {
  return process.env["ALLOW_UNAUTHENTICATED_PROXY"] === "true";
}
