/**
 * Admin API client. The console never holds the admin key: it signs in once
 * (POST /admin/session/login) and from then on the browser sends the
 * HttpOnly session cookie; every write echoes the CSRF token in X-CSRF-Token.
 */

export interface FieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: FieldError[] = [],
    readonly currentRevision?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

let csrfToken = "";
let onUnauthorized: () => void = () => {};

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

function cookieCsrf(): string {
  if (typeof document === "undefined") return "";
  const m = document.cookie.match(/(?:^|;\s*)aigw_csrf=([^;]+)/);
  return m?.[1] ?? "";
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  /** Resource revision for If-Match. */
  revision?: number;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

export interface ApiResult<T> {
  data: T;
  /** X-Config-Version of a runtime-config write, when present. */
  configVersion?: number;
  etag?: number;
}

function url(path: string, query?: ApiOptions["query"]): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return `/admin${path}${s ? `?${s}` : ""}`;
}

export async function rawRequest(path: string, opts: ApiOptions = {}): Promise<Response> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") headers["X-CSRF-Token"] = csrfToken || cookieCsrf();
  if (opts.revision !== undefined) headers["If-Match"] = `"${opts.revision}"`;
  return fetch(url(path, opts.query), {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

export async function errorFrom(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const e = (body as { error?: Record<string, unknown> } | undefined)?.error;
  const message = typeof e?.["message"] === "string" ? e["message"] : typeof e === "string" ? e : `HTTP ${res.status}`;
  const code = typeof e?.["code"] === "string" ? e["code"] : String(res.status);
  const fields: FieldError[] = Array.isArray(e?.["fields"])
    ? (e["fields"] as FieldError[]).filter((f) => typeof f?.path === "string")
    : typeof e?.["param"] === "string"
      ? [{ path: e["param"], message }]
      : [];
  const rev = typeof e?.["currentRevision"] === "number" ? e["currentRevision"] : undefined;
  const ra = Number(res.headers.get("Retry-After"));
  return new ApiError(res.status, code, message, fields, rev, Number.isFinite(ra) && ra > 0 ? ra : undefined);
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<ApiResult<T>> {
  const res = await rawRequest(path, opts);
  if (!res.ok) {
    const err = await errorFrom(res);
    if (res.status === 401 && path !== "/session/login") onUnauthorized();
    throw err;
  }
  const text = res.status === 204 ? "" : await res.text();
  const data = (text ? JSON.parse(text) : undefined) as T;
  const cv = Number(res.headers.get("X-Config-Version"));
  const tag = res.headers.get("ETag")?.match(/(\d+)/)?.[1];
  return {
    data,
    ...(Number.isFinite(cv) && cv > 0 ? { configVersion: cv } : {}),
    ...(tag !== undefined ? { etag: Number(tag) } : {}),
  };
}

export async function get<T>(path: string, query?: ApiOptions["query"]): Promise<T> {
  return (await api<T>(path, { ...(query ? { query } : {}) })).data;
}

// ── Shapes used by the pages (subset of the Admin API views) ──

export interface SessionInfo {
  via: "session" | "header";
  actor: string;
  scopes: string[];
  sessionId?: string;
  csrfToken?: string;
  expiresAt?: string;
}

export interface ChannelKey {
  id: string;
  kind: string;
  hint: string;
  enabled: boolean;
  status: string;
  weight: number;
  lastError: string | null;
  lastErrorAt: string | null;
  cooldownUntil?: string | null;
}

export interface Channel {
  id: string;
  name: string;
  preset: string;
  baseURL: string | null;
  effectiveBaseURL: string | null;
  enabled: boolean;
  priority: number;
  models: string[];
  keyStrategy: string;
  keyCooldownSeconds: number | null;
  urlPolicy: string;
  revision: number;
  keys: ChannelKey[];
  settings?: Record<string, unknown>;
}

export interface Binding {
  channelId?: string;
  channel?: string;
  upstreamModel?: string;
  priority?: number;
  weight?: number;
  enabled?: boolean;
  params?: Record<string, unknown>;
}

export interface ModelMeta {
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  tools?: boolean;
  parallelTools?: boolean;
  structuredOutput?: string;
  reasoning?: boolean | { efforts?: string[]; map?: Record<string, Record<string, unknown>> };
  webSearch?: boolean;
  logprobs?: boolean;
  systemMessage?: string;
  developerRole?: string;
}

export interface Model {
  id: string;
  name: string;
  displayName?: string | null;
  description?: string | null;
  enabled: boolean;
  strategy?: string | null;
  balance?: string | null;
  metadata: ModelMeta;
  bindings: Binding[];
  revision: number;
}

export interface ClientKey {
  id: string;
  name: string;
  key?: string;
  scopes: string[];
  allowedModels: string[] | null;
  expiresAt: string | null;
  quotaTokens: number | null;
  rpm: number | null;
  tpm: number | null;
  usedTokens: number;
  remainingTokens: number | null;
  quotaExhausted: boolean;
  usageResetAt: string | null;
  revision: number;
  active?: boolean;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
  createdAt?: string;
}

export interface UsageCounts {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  reasoningTokens: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
}

export interface UsageGroup extends UsageCounts {
  key?: string | null;
  name?: string | null;
  kind?: string;
  model?: string;
  channel?: string;
  daily?: Array<UsageCounts & { date: string }>;
}

export interface UsageReport {
  from: string;
  to: string;
  tz: string;
  data: UsageGroup[];
  totals: UsageCounts;
}

export interface Preset {
  id: string;
  baseURL?: string | null;
  baseURLRequired?: boolean;
  adminUsable?: boolean;
  models?: Array<{ model: string; metadata?: ModelMeta }>;
}
