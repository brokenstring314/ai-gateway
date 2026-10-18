import { describe, it, expect } from "bun:test";
import { parseTrustedProxies, ipInCidr, resolveClientIp } from "@/middleware/trusted-proxy";

describe("parseTrustedProxies", () => {
  it("defaults to loopback IPv4 and IPv6 when no env is given", () => {
    expect(parseTrustedProxies()).toEqual(["127.0.0.1", "::1"]);
    expect(parseTrustedProxies(undefined)).toEqual(["127.0.0.1", "::1"]);
  });

  it("parses a comma-separated list and trims whitespace", () => {
    expect(parseTrustedProxies("10.0.0.0/8, 192.168.0.0/16 ,172.16.0.0/12")).toEqual([
      "10.0.0.0/8",
      "192.168.0.0/16",
      "172.16.0.0/12",
    ]);
  });

  it("ignores empty entries and falls back to defaults when nothing usable remains", () => {
    expect(parseTrustedProxies(" , 10.0.0.1/32 , ")).toEqual(["10.0.0.1/32"]);
    expect(parseTrustedProxies("  ,  ")).toEqual(["127.0.0.1", "::1"]);
    expect(parseTrustedProxies("")).toEqual(["127.0.0.1", "::1"]);
  });
});

describe("ipInCidr", () => {
  it("matches and rejects IPv4 addresses within a /24", () => {
    expect(ipInCidr("192.168.1.42", "192.168.1.0/24")).toBe(true);
    expect(ipInCidr("192.168.1.255", "192.168.1.0/24")).toBe(true);
    expect(ipInCidr("192.168.2.1", "192.168.1.0/24")).toBe(false);
  });

  it("handles /32 exact host masks and /0 wildcards", () => {
    expect(ipInCidr("10.1.2.3", "10.1.2.3/32")).toBe(true);
    expect(ipInCidr("10.1.2.4", "10.1.2.3/32")).toBe(false);
    expect(ipInCidr("8.8.8.8", "0.0.0.0/0")).toBe(true);
    expect(ipInCidr("::1", "::/0")).toBe(true);
    expect(ipInCidr("2001:db8::1", "::/0")).toBe(true);
  });

  it("matches compressed IPv6 addresses against IPv6 CIDRs", () => {
    expect(ipInCidr("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(ipInCidr("2001:db8:1234:5678:9abc:def0::", "2001:db8::/32")).toBe(true);
    expect(ipInCidr("2001:db9::1", "2001:db8::/32")).toBe(false);
  });

  it("handles /128 exact IPv6 host masks", () => {
    expect(ipInCidr("2001:db8::1", "2001:db8::1/128")).toBe(true);
    expect(ipInCidr("2001:db8::2", "2001:db8::1/128")).toBe(false);
  });

  it("handles CIDRs without an explicit prefix as exact host masks", () => {
    expect(ipInCidr("10.0.0.5", "10.0.0.5")).toBe(true);
    expect(ipInCidr("10.0.0.6", "10.0.0.5")).toBe(false);
    expect(ipInCidr("fe80::1", "fe80::1")).toBe(true);
    expect(ipInCidr("fe80::2", "fe80::1")).toBe(false);
  });

  it("matches IPv4-mapped IPv6 addresses against IPv4 CIDRs", () => {
    expect(ipInCidr("::ffff:192.168.1.9", "192.168.1.0/24")).toBe(true);
    expect(ipInCidr("::ffff:192.168.2.9", "192.168.1.0/24")).toBe(false);
    expect(ipInCidr("::ffff:192.168.0.7", "::ffff:0:0/96")).toBe(true);
    expect(ipInCidr("::ffff:192.168.0.7", "::ffff:192.168.0.0/120")).toBe(true);
    expect(ipInCidr("::ffff:192.168.1.7", "::ffff:192.168.0.0/120")).toBe(false);
  });

  it("does not match across plain IPv4/IPv6 families", () => {
    expect(ipInCidr("192.168.1.5", "2001:db8::/32")).toBe(false);
    expect(ipInCidr("192.168.1.5", "::/0")).toBe(false);
    expect(ipInCidr("2001:db8::1", "192.168.1.0/24")).toBe(false);
  });

  it("returns false for invalid IPs and CIDRs", () => {
    expect(ipInCidr("not-an-ip", "192.168.1.0/24")).toBe(false);
    expect(ipInCidr("999.1.1.1", "192.168.1.0/24")).toBe(false);
    expect(ipInCidr("192.168.1.5", "not-a-cidr")).toBe(false);
    expect(ipInCidr("192.168.1.5", "192.168.1.0/33")).toBe(false);
    expect(ipInCidr("192.168.1.5", "192.168.1.0/")).toBe(false);
    expect(ipInCidr("", "192.168.1.0/24")).toBe(false);
  });
});

describe("resolveClientIp", () => {
  const trusted = ["127.0.0.1", "10.0.0.0/8"];

  it("returns remoteAddress for an untrusted remote even with spoofed headers", () => {
    const ip = resolveClientIp("203.0.113.9", { "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" }, trusted);
    expect(ip).toBe("203.0.113.9");
  });

  it("trusts X-Forwarded-For from a trusted proxy and takes the leftmost hop", () => {
    const ip = resolveClientIp("10.1.2.3", { "x-forwarded-for": "203.0.113.5, 10.0.0.1, 127.0.0.1" }, trusted);
    expect(ip).toBe("203.0.113.5");
  });

  it("trims whitespace around X-Forwarded-For entries", () => {
    const ip = resolveClientIp("127.0.0.1", { "x-forwarded-for": "  203.0.113.7  , 10.0.0.2" }, trusted);
    expect(ip).toBe("203.0.113.7");
  });

  it("falls back to X-Real-IP when X-Forwarded-For is absent or empty", () => {
    expect(resolveClientIp("127.0.0.1", { "x-real-ip": " 198.51.100.4 " }, trusted)).toBe("198.51.100.4");
    expect(resolveClientIp("127.0.0.1", { "x-forwarded-for": "   ", "x-real-ip": "198.51.100.4" }, trusted)).toBe(
      "198.51.100.4",
    );
  });

  it("returns remoteAddress when trusted but no forwarded headers are present", () => {
    expect(resolveClientIp("10.1.2.3", {}, trusted)).toBe("10.1.2.3");
    expect(resolveClientIp("127.0.0.1", { "x-real-ip": "   " }, trusted)).toBe("127.0.0.1");
  });

  it("matches header names case-insensitively", () => {
    expect(resolveClientIp("127.0.0.1", { "X-Forwarded-For": "203.0.113.8" }, trusted)).toBe("203.0.113.8");
    expect(resolveClientIp("127.0.0.1", { "X-Real-IP": "198.51.100.8" }, trusted)).toBe("198.51.100.8");
  });

  it("handles an IPv6 trusted proxy and IPv6 client via X-Forwarded-For", () => {
    expect(resolveClientIp("::1", { "x-forwarded-for": "2001:db8::42" }, ["::1", "127.0.0.1"])).toBe("2001:db8::42");
    expect(resolveClientIp("2001:db8::ffff", { "x-forwarded-for": "2001:db8::1" }, ["2001:db8::/64"])).toBe(
      "2001:db8::1",
    );
  });

  it("does not trust a header value when the proxy itself is untrusted", () => {
    const ip = resolveClientIp("10.9.9.9", { "x-forwarded-for": "203.0.113.1" }, ["127.0.0.1"]);
    expect(ip).toBe("10.9.9.9");
  });
});
