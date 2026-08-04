/**
 * Trusted proxy IP parsing and client-IP resolution.
 *
 * X-Forwarded-For / X-Real-IP headers are only honored when the request
 * arrives from a trusted proxy — i.e. the remote address matches one of the
 * configured CIDR ranges. Untrusted clients can spoof these headers, so the
 * raw remote address is always returned for them.
 */

/** Default trusted proxies when none are configured: loopback IPv4 and IPv6. */
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = ["127.0.0.1", "::1"];

export interface ParsedIp {
  readonly bytes: Uint8Array;
  readonly family: 4 | 6;
}

export interface ParsedCidr {
  readonly network: Uint8Array;
  readonly prefix: number;
  readonly family: 4 | 6;
}

export type HeaderMap = Readonly<Record<string, string | undefined>>;

/**
 * Parse a comma-separated list of CIDR ranges. Entries are trimmed and
 * empty entries are ignored. When `env` is undefined or contains no usable
 * entries, the default loopback proxies are returned.
 */
export function parseTrustedProxies(env?: string): string[] {
  const entries = (env ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries.length > 0 ? entries : [...DEFAULT_TRUSTED_PROXIES];
}

/**
 * Check whether `ip` is inside the `cidr` network. Supports IPv4 and IPv6
 * CIDRs (with or without an explicit prefix), compressed IPv6 notation,
 * /0 wildcards, exact /32 and /128 host masks, and IPv4-mapped IPv6
 * addresses (e.g. ::ffff:192.168.0.1 within a 192.168.0.0/24 range).
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const parsedIp = parseIp(ip);
  const parsedCidr = parseCidr(cidr);
  if (parsedIp === null || parsedCidr === null) return false;
  return ipMatchesCidr(parsedIp, parsedCidr);
}

/**
 * Resolve the real client IP. Forwarded headers are only consulted when
 * `remoteAddress` itself is one of the `trustedProxies`. When trusted,
 * X-Forwarded-For wins and its leftmost (trimmed) hop is returned; falling
 * back to X-Real-IP, then the remote address itself.
 */
export function resolveClientIp(
  remoteAddress: string,
  headers: HeaderMap,
  trustedProxies: readonly string[],
): string {
  const isTrusted = trustedProxies.some((cidr) => ipInCidr(remoteAddress, cidr));
  if (!isTrusted) return remoteAddress;

  const forwardedFor = getHeader(headers, "x-forwarded-for");
  if (forwardedFor !== undefined) {
    const leftmost = forwardedFor.split(",")[0]?.trim();
    if (leftmost !== undefined && leftmost !== "") return leftmost;
  }

  const realIp = getHeader(headers, "x-real-ip");
  if (realIp !== undefined && realIp.trim() !== "") return realIp.trim();

  return remoteAddress;
}

function getHeader(headers: HeaderMap, name: string): string | undefined {
  if (headers[name] !== undefined) return headers[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const value = headers[key];
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function parseIp(ip: string): ParsedIp | null {
  const value = ip.trim();
  if (value === "") return null;
  return value.includes(":") ? parseIpv6(value) : parseIpv4(value);
}

function parseIpv4(ip: string): ParsedIp | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    bytes[i] = octet;
  }
  return { bytes, family: 4 };
}

function parseIpv6(ip: string): ParsedIp | null {
  let value = ip.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  if (value === "::") return { bytes: new Uint8Array(16), family: 6 };

  const compressionParts = value.split("::");
  if (compressionParts.length > 2) return null;

  const head = compressionParts[0] === "" ? [] : (compressionParts[0] ?? "").split(":");
  const tail =
    compressionParts.length === 2 && compressionParts[1] !== ""
      ? (compressionParts[1] ?? "").split(":")
      : [];

  const headValues = parseHexGroups(head);
  const tailValues = parseHexGroups(tail);
  if (headValues === null || tailValues === null) return null;

  const total = headValues.length + tailValues.length;
  const hasCompression = compressionParts.length === 2;
  if (hasCompression ? total > 7 : total !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < headValues.length; i++) {
    bytes[i * 2] = (headValues[i]! >> 8) & 0xff;
    bytes[i * 2 + 1] = headValues[i]! & 0xff;
  }
  const tailStart = 8 - tailValues.length;
  for (let i = 0; i < tailValues.length; i++) {
    const idx = tailStart + i;
    bytes[idx * 2] = (tailValues[i]! >> 8) & 0xff;
    bytes[idx * 2 + 1] = tailValues[i]! & 0xff;
  }
  return { bytes, family: 6 };
}

/**
 * Parse a list of colon-separated IPv6 groups into 16-bit values. The final
 * group may be an embedded IPv4 address (e.g. ::ffff:192.168.0.1), which
 * contributes two 16-bit values. Returns null on any malformed group.
 */
function parseHexGroups(groups: string[]): number[] | null {
  const values: number[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    if (group === "") return null;
    if (group.includes(".")) {
      if (i !== groups.length - 1) return null;
      const v4 = parseIpv4(group);
      if (v4 === null) return null;
      values.push(((v4.bytes[0]! << 8) | v4.bytes[1]!) & 0xffff);
      values.push(((v4.bytes[2]! << 8) | v4.bytes[3]!) & 0xffff);
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      values.push(parseInt(group, 16));
    }
  }
  return values;
}

function parseCidr(cidr: string): ParsedCidr | null {
  const value = cidr.trim();
  const slashIndex = value.lastIndexOf("/");
  if (slashIndex === -1) {
    const ip = parseIp(value);
    if (ip === null) return null;
    return {
      network: ip.bytes,
      prefix: ip.family === 4 ? 32 : 128,
      family: ip.family,
    };
  }
  const ipPart = value.slice(0, slashIndex);
  const prefixPart = value.slice(slashIndex + 1);
  if (!/^\d{1,3}$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  const ip = parseIp(ipPart);
  if (ip === null) return null;
  const maxPrefix = ip.family === 4 ? 32 : 128;
  if (prefix > maxPrefix) return null;
  return { network: ip.bytes, prefix, family: ip.family };
}

function ipMatchesCidr(ip: ParsedIp, cidr: ParsedCidr): boolean {
  if (ip.family === cidr.family) {
    return bitsMatch(ip.bytes, cidr.network, cidr.prefix);
  }
  // IPv4-mapped IPv6 address (::ffff:a.b.c.d) inside an IPv4 CIDR.
  if (ip.family === 6 && cidr.family === 4 && isIpv4MappedIpv6(ip.bytes)) {
    return bitsMatch(ip.bytes.subarray(12), cidr.network, cidr.prefix);
  }
  // Plain IPv4 address inside an IPv4-mapped IPv6 CIDR (::ffff:0:0/96 or wider).
  if (ip.family === 4 && cidr.family === 6 && isIpv4MappedIpv6(cidr.network) && cidr.prefix >= 96) {
    return bitsMatch(ip.bytes, cidr.network.subarray(12), cidr.prefix - 96);
  }
  return false;
}

function bitsMatch(bytes: Uint8Array, network: Uint8Array, prefix: number): boolean {
  const fullBytes = Math.floor(prefix / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== network[i]) return false;
  }
  const remainingBits = prefix % 8;
  if (remainingBits > 0) {
    const mask = (0xff << (8 - remainingBits)) & 0xff;
    if ((bytes[fullBytes]! & mask) !== (network[fullBytes]! & mask)) return false;
  }
  return true;
}

function isIpv4MappedIpv6(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) {
    if (bytes[i] !== 0) return false;
  }
  return bytes[10] === 0xff && bytes[11] === 0xff;
}
