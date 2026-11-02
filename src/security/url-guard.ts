/**
 * SSRF guard for upstream base URLs set through the Admin API (0.3.0 P4,
 * plan §3.7 / §9.5; user decision 2026-11-02: public internet only).
 *
 * A channel whose base URL was written through the Admin API ("public"
 * policy) may only reach public internet addresses. Refused:
 *  - loopback, private (10/8, 172.16/12, 192.168/16), link-local
 *    (169.254/16, incl. the 169.254.169.254 cloud metadata address), CGNAT
 *    (100.64/10), "this network" (0/8), benchmarking, documentation,
 *    multicast and reserved IPv4 ranges;
 *  - IPv6 equivalents: ::, ::1, unique-local fc00::/7, link-local fe80::/10,
 *    site-local fec0::/10, multicast, documentation, discard, and IPv4
 *    embedded in IPv6 (IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible,
 *    NAT64 64:ff9b::/96, 6to4 2002::/16, Teredo 2001::/32) when the embedded
 *    IPv4 address is not public;
 *  - host names that resolve to any such address (every resolved address
 *    must be public), and names that are local by definition (localhost,
 *    *.localhost, *.local, *.internal, *.home.arpa).
 *
 * The check runs when the URL is written and again before every upstream
 * call (resolved addresses cached for a short time), so a name that later
 * re-points at a private address (DNS rebinding) is refused at request time.
 * There is no switch to allow private networks (local model servers are on
 * the roadmap as an explicit opt-in). Channels from the config file
 * ("trusted" policy) are the operator's own and are not checked.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {
  override name = "UnsafeUrlError";
}

/** Resolve a host name to its addresses (injectable for tests). */
export type HostResolver = (host: string) => Promise<string[]>;

export const systemResolver: HostResolver = async (host) => {
  const found = await dnsLookup(host, { all: true, verbatim: true });
  return found.map((a) => a.address);
};

function parseIPv4(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? out : undefined;
}

/** Why an IPv4 address is not public, or undefined when it is. */
function ipv4Problem(ip: string): string | undefined {
  const o = parseIPv4(ip);
  if (!o) return "not an IPv4 address";
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0) return "'this network' address (0.0.0.0/8)";
  if (a === 10) return "private address (10.0.0.0/8)";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT address (100.64.0.0/10)";
  if (a === 127) return "loopback address (127.0.0.0/8)";
  if (a === 169 && b === 254) return "link-local / cloud metadata address (169.254.0.0/16)";
  if (a === 172 && b >= 16 && b <= 31) return "private address (172.16.0.0/12)";
  if (a === 192 && b === 0 && c === 0) return "IETF protocol assignment (192.0.0.0/24)";
  if (a === 192 && b === 0 && c === 2) return "documentation address (192.0.2.0/24)";
  if (a === 192 && b === 88 && c === 99) return "6to4 relay anycast (192.88.99.0/24)";
  if (a === 192 && b === 168) return "private address (192.168.0.0/16)";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking address (198.18.0.0/15)";
  if (a === 198 && b === 51 && c === 100) return "documentation address (198.51.100.0/24)";
  if (a === 203 && b === 0 && c === 113) return "documentation address (203.0.113.0/24)";
  if (a >= 224 && a <= 239) return "multicast address (224.0.0.0/4)";
  if (a >= 240) return "reserved / broadcast address (240.0.0.0/4)";
  return undefined;
}

/** Expand an IPv6 address (no zone) to 8 16-bit groups; handles an embedded dotted IPv4 tail. */
function parseIPv6(ip: string): number[] | undefined {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return undefined;
    tail = [((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)];
    text = `${text.slice(0, lastColon + 1)}`;
    if (text.endsWith("::")) {
      // "::a.b.c.d" / "x::a.b.c.d": keep the double colon
    } else {
      text = text.slice(0, -1);
    }
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (s: string) =>
    s === "" ? [] : s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  const head = toGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if ([...head, ...rest].some((n) => Number.isNaN(n))) return undefined;
  const fixed = head.length + rest.length + tail.length;
  if (halves.length === 1) {
    return fixed === 8 ? [...head, ...tail] : undefined;
  }
  if (fixed > 7) return undefined;
  return [...head, ...new Array<number>(8 - fixed).fill(0), ...rest, ...tail];
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** Why an IPv6 address is not public, or undefined when it is. */
function ipv6Problem(ip: string): string | undefined {
  const g = parseIPv6(ip);
  if (!g) return "not an IPv6 address";
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const embedded = (what: string, hi: number, lo: number) => {
    const v4 = v4FromGroups(hi, lo);
    const p = ipv4Problem(v4);
    return p === undefined ? undefined : `${what} embedding ${v4}: ${p}`;
  };
  if (g.every((x) => x === 0)) return "unspecified address (::)";
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return "loopback address (::1)";
  // IPv4-mapped ::ffff:a.b.c.d (and the deprecated IPv4-compatible ::a.b.c.d).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return embedded("IPv4-mapped address", g6, g7);
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return embedded("IPv4-compatible address", g6, g7) ?? "IPv4-compatible address (::/96, deprecated)";
  }
  // IPv4/IPv6 translation (SIIT) ::ffff:0:a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return embedded("IPv4-translated address", g6, g7) ?? "IPv4-translated address (::ffff:0:0/96)";
  }
  if (g0 === 0x64 && g1 === 0xff9b)
    return embedded("NAT64 address", g6, g7) ?? (g2 === 1 ? "local-use NAT64 (64:ff9b:1::/48)" : undefined);
  if (g0 === 0x2002) return embedded("6to4 address", g1, g2);
  if (g0 === 0x2001 && g1 === 0) return "Teredo address (2001::/32)";
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return "discard-only address (100::/64)";
  if (g0 === 0x2001 && g1 === 0x0db8) return "documentation address (2001:db8::/32)";
  if (g0 === 0x2001 && g1 >= 0x0010 && g1 <= 0x002f) return "ORCHID address (2001:10::/28, 2001:20::/28)";
  if ((g0 & 0xfe00) === 0xfc00) return "unique-local address (fc00::/7)";
  if ((g0 & 0xffc0) === 0xfe80) return "link-local address (fe80::/10)";
  if ((g0 & 0xffc0) === 0xfec0) return "site-local address (fec0::/10)";
  if ((g0 & 0xff00) === 0xff00) return "multicast address (ff00::/8)";
  void g3;
  void g4;
  return undefined;
}

/** Why an IP address (v4 or v6) is not a public internet address, or undefined when it is. */
export function nonPublicReason(ip: string): string | undefined {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const kind = isIP(bare.split("%")[0] ?? "");
  if (kind === 4) return ipv4Problem(bare);
  if (kind === 6) return ipv6Problem(bare);
  return "not an IP address";
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".localdomain"];

/**
 * Syntax checks that need no DNS: http(s) only, no credentials, no `${VAR}`
 * reference, no local-only host name, and an IP literal must be public.
 * Returns the parsed URL; throws UnsafeUrlError.
 */
export function checkPublicUrlSyntax(raw: string): URL {
  if (raw.includes("${")) {
    throw new UnsafeUrlError(
      "baseURL must be a literal URL (environment references are only allowed in the config file)",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("baseURL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError("baseURL must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeUrlError("baseURL must not contain credentials (user:password@); add the key as a channel key");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") throw new UnsafeUrlError("baseURL has no host");
  const literal = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(literal) !== 0) {
    const problem = nonPublicReason(literal);
    if (problem) throw new UnsafeUrlError(`baseURL points to a ${problem}; only public internet addresses are allowed`);
    return url;
  }
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError(`baseURL host "${host}" is a local name; only public internet hosts are allowed`);
  }
  if (!host.includes(".")) {
    throw new UnsafeUrlError(`baseURL host "${host}" is not a fully qualified public host name`);
  }
  return url;
}

/** Resolve `host` and require every address to be public; throws UnsafeUrlError. */
export async function assertPublicHost(host: string, resolve: HostResolver = systemResolver): Promise<void> {
  const literal = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(literal) !== 0) {
    const problem = nonPublicReason(literal);
    if (problem) throw new UnsafeUrlError(`host ${host} is a ${problem}`);
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    throw new UnsafeUrlError(`cannot resolve host "${host}": ${err instanceof Error ? err.message : String(err)}`);
  }
  if (addresses.length === 0) throw new UnsafeUrlError(`host "${host}" did not resolve to any address`);
  for (const a of addresses) {
    const problem = nonPublicReason(a);
    if (problem) {
      throw new UnsafeUrlError(
        `host "${host}" resolves to ${a}, a ${problem}; only public internet addresses are allowed`,
      );
    }
  }
}

/** Full check of a URL being written: syntax, then every resolved address. */
export async function assertPublicUrl(raw: string, resolve: HostResolver = systemResolver): Promise<URL> {
  const url = checkPublicUrlSyntax(raw);
  await assertPublicHost(url.hostname, resolve);
  return url;
}

/**
 * Request-time guard: host → verdict cache with a short TTL, so the hot path
 * pays one DNS lookup per host per TTL, never per request.
 */
export class PublicHostGuard {
  private readonly cache = new Map<string, { until: number; problem?: string }>();

  constructor(
    private readonly resolve: HostResolver = systemResolver,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws UnsafeUrlError when `url`'s host is (or now resolves to) a non-public address. */
  async check(url: string | URL): Promise<void> {
    const u = typeof url === "string" ? new URL(url) : url;
    const host = u.hostname.toLowerCase();
    const hit = this.cache.get(host);
    const t = this.now();
    if (hit && hit.until > t) {
      if (hit.problem) throw new UnsafeUrlError(hit.problem);
      return;
    }
    try {
      checkPublicUrlSyntax(u.toString());
      await assertPublicHost(host, this.resolve);
      this.remember(host, { until: t + this.ttlMs });
    } catch (err) {
      const problem = err instanceof Error ? err.message : String(err);
      // Failed lookups are cached briefly too, so a dead name cannot turn every request into a DNS query.
      this.remember(host, { until: t + Math.min(this.ttlMs, 5_000), problem });
      throw err instanceof UnsafeUrlError ? err : new UnsafeUrlError(problem);
    }
  }

  private remember(host: string, v: { until: number; problem?: string }): void {
    if (this.cache.size > 1000) this.cache.clear();
    this.cache.set(host, v);
  }

  /**
   * A fetch that checks the URL first and never follows redirects (a public
   * host could otherwise bounce the request to a private one).
   */
  fetch(): typeof fetch {
    const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = input instanceof Request ? input.url : input;
      await this.check(target);
      return globalThis.fetch(input, { ...init, redirect: "manual" });
    };
    return guarded as typeof fetch;
  }
}

/** Shared request-time guard for every public-policy channel. */
export const defaultPublicHostGuard = new PublicHostGuard();

export interface LimitedFetchOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Check the host of the URL before connecting (public-policy channels). */
  readonly guard?: PublicHostGuard;
}

export interface LimitedFetchResult {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

/**
 * fetch for admin-triggered upstream calls (channel test / fetch models):
 * timeout, response size cap, no redirect following (a 3xx is an error).
 */
export async function limitedFetch(
  url: string,
  init: RequestInit,
  opts: LimitedFetchOptions,
): Promise<LimitedFetchResult> {
  if (opts.guard) await opts.guard.check(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("timed out", "TimeoutError")), opts.timeoutMs);
  try {
    const res = await globalThis.fetch(url, { ...init, redirect: "manual", signal: ctrl.signal });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new UnsafeUrlError(`upstream answered ${res.status} (redirect); redirects are not followed`);
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > opts.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`upstream response exceeds ${opts.maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    return { status: res.status, headers: res.headers, body: new TextDecoder().decode(buf) };
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`upstream did not answer within ${opts.timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
