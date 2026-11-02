/**
 * SSRF guard (0.3.0 P4, user decision 2026-11-02: Admin API base URLs are
 * public internet only, no switch for private networks).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  assertPublicHost,
  assertPublicUrl,
  checkPublicUrlSyntax,
  limitedFetch,
  nonPublicReason,
  PublicHostGuard,
  UnsafeUrlError,
} from "../../../src/security/url-guard.js";

describe("nonPublicReason", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "169.254.0.1",
    "100.64.0.1", // CGNAT
    "100.127.255.255",
    "0.0.0.0",
    "0.1.2.3",
    "192.0.0.8",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1",
    "fe80::1%eth0",
    "febf::1",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1", // IPv4-mapped
    "::ffff:7f00:1", // IPv4-mapped, hex form
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "::127.0.0.1", // IPv4-compatible
    "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
    "64:ff9b::10.0.0.1",
    "2002:7f00:0001::1", // 6to4 of 127.0.0.1
    "2002:a9fe:a9fe::1", // 6to4 of 169.254.169.254
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "100::1",
    "[::1]",
  ];
  for (const ip of blocked) {
    it(`refuses ${ip}`, () => {
      expect(nonPublicReason(ip)).toBeString();
    });
  }

  const allowed = [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.253.255.255",
    "192.169.0.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001:80b::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:0808:0808::1",
  ];
  for (const ip of allowed) {
    it(`allows ${ip}`, () => {
      expect(nonPublicReason(ip)).toBeUndefined();
    });
  }

  it("refuses things that are not IP addresses", () => {
    expect(nonPublicReason("example.com")).toBeString();
    expect(nonPublicReason("1.2.3")).toBeString();
  });
});

describe("checkPublicUrlSyntax", () => {
  const bad: Array<[string, RegExp]> = [
    ["http://localhost:11434/v1", /local name/],
    ["http://ollama.local/v1", /local name/],
    ["http://metadata.google.internal/computeMetadata", /local name/],
    ["http://foo.localhost/", /local name/],
    ["http://router.home.arpa/", /local name/],
    ["http://intranet/v1", /fully qualified/],
    ["http://127.0.0.1:8080/v1", /loopback/],
    ["http://2130706433/v1", /loopback/], // decimal 127.0.0.1, normalized by the URL parser
    ["http://0x7f.1/v1", /loopback/],
    ["http://[::1]:8080/v1", /loopback/],
    ["http://[::ffff:169.254.169.254]/latest", /metadata|link-local/],
    ["http://169.254.169.254/latest/meta-data", /metadata/],
    ["http://10.0.0.8/v1", /private/],
    ["http://user:pass@api.example.com/v1", /credentials/],
    ["ftp://api.example.com/v1", /http or https/],
    ["file:///etc/passwd", /http or https/],
    ["https://api.example.com/${GATEWAY_SECRET_KEY}", /environment references/],
    ["not a url", /not a valid URL/],
  ];
  for (const [url, why] of bad) {
    it(`refuses ${url}`, () => {
      expect(() => checkPublicUrlSyntax(url)).toThrow(why);
    });
  }

  it("accepts a public https URL and a public IP literal", () => {
    expect(checkPublicUrlSyntax("https://api.deepseek.com/v1").hostname).toBe("api.deepseek.com");
    expect(checkPublicUrlSyntax("http://8.8.8.8:8000/v1").hostname).toBe("8.8.8.8");
  });
});

describe("assertPublicHost / assertPublicUrl (DNS)", () => {
  const resolver = async (host: string) => {
    if (host === "inside.example.com") return ["10.0.0.7"];
    if (host === "mixed.example.com") return ["93.184.216.34", "192.168.0.10"];
    if (host === "v6meta.example.com") return ["::ffff:169.254.169.254"];
    if (host === "nx.example.com") throw new Error("ENOTFOUND");
    if (host === "empty.example.com") return [];
    return ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"];
  };

  it("accepts a name whose every address is public", async () => {
    await assertPublicUrl("https://api.example.com/v1", resolver);
  });

  it("refuses a name resolving to a private address", async () => {
    await expect(assertPublicUrl("https://inside.example.com/v1", resolver)).rejects.toThrow(/10\.0\.0\.7.*private/);
  });

  it("refuses when ANY resolved address is non-public", async () => {
    await expect(assertPublicHost("mixed.example.com", resolver)).rejects.toThrow(/192\.168\.0\.10/);
  });

  it("refuses IPv4-mapped metadata addresses from DNS", async () => {
    await expect(assertPublicHost("v6meta.example.com", resolver)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("refuses names that do not resolve", async () => {
    await expect(assertPublicHost("nx.example.com", resolver)).rejects.toThrow(/cannot resolve/);
    await expect(assertPublicHost("empty.example.com", resolver)).rejects.toThrow(/did not resolve/);
  });
});

describe("PublicHostGuard (request time, DNS rebinding)", () => {
  it("re-resolves after the TTL and refuses a name that now points inside", async () => {
    let answer = ["93.184.216.34"];
    let lookups = 0;
    let now = 0;
    const guard = new PublicHostGuard(
      async () => {
        lookups++;
        return answer;
      },
      1000,
      () => now,
    );
    await guard.check("https://rebind.example.com/v1/chat/completions");
    await guard.check("https://rebind.example.com/v1/models");
    expect(lookups).toBe(1); // cached within the TTL
    answer = ["127.0.0.1"];
    now = 1500;
    await expect(guard.check("https://rebind.example.com/v1/models")).rejects.toThrow(/loopback/);
    // The refusal is cached briefly too.
    await expect(guard.check("https://rebind.example.com/v1/models")).rejects.toThrow(/loopback/);
    expect(lookups).toBe(2);
  });

  it("guarded fetch refuses before connecting and never follows redirects", async () => {
    const guard = new PublicHostGuard(async () => ["10.0.0.1"]);
    await expect(guard.fetch()("https://inside.example.com/v1/models")).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});

describe("limitedFetch (channel test / fetch models)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/redirect")
          return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } });
        if (path === "/big") return new Response("x".repeat(64 * 1024));
        if (path === "/slow") return new Promise((r) => setTimeout(() => r(new Response("late")), 2000));
        return Response.json({ data: [{ id: "m1" }] });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  it("reads a small answer", async () => {
    const r = await limitedFetch(`${base}/ok`, { method: "GET" }, { timeoutMs: 2000, maxBytes: 1024 });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ data: [{ id: "m1" }] });
  });

  it("does not follow a redirect", async () => {
    await expect(
      limitedFetch(`${base}/redirect`, { method: "GET" }, { timeoutMs: 2000, maxBytes: 1024 }),
    ).rejects.toThrow(/redirect/);
  });

  it("caps the response size", async () => {
    await expect(limitedFetch(`${base}/big`, { method: "GET" }, { timeoutMs: 2000, maxBytes: 1024 })).rejects.toThrow(
      /exceeds 1024 bytes/,
    );
  });

  it("times out", async () => {
    await expect(limitedFetch(`${base}/slow`, { method: "GET" }, { timeoutMs: 100, maxBytes: 1024 })).rejects.toThrow(
      /within 100 ms/,
    );
  });

  it("checks the host first when a guard is given (loopback refused)", async () => {
    const guard = new PublicHostGuard(async () => ["127.0.0.1"]);
    await expect(
      limitedFetch(`${base}/ok`, { method: "GET" }, { timeoutMs: 2000, maxBytes: 1024, guard }),
    ).rejects.toThrow(/loopback/);
  });
});
