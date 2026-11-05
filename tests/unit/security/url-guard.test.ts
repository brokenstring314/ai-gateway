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
  pinnedRequest,
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

describe("pinned connections (red team 2026-11-02 RA3 / K5: no second DNS lookup)", () => {
  it("pinnedRequest: connect to the IP, keep Host, SNI and the certificate name; redirects manual", () => {
    const p = pinnedRequest(new URL("https://api.example.com:8443/v1/models?x=1"), "93.184.216.34", {
      headers: { Authorization: "Bearer k", Host: "spoofed.example" },
      redirect: "follow",
    });
    expect(p.url).toBe("https://93.184.216.34:8443/v1/models?x=1");
    const h = new Headers(p.init.headers);
    expect(h.get("host")).toBe("api.example.com:8443");
    expect(h.get("authorization")).toBe("Bearer k");
    expect(p.init.redirect).toBe("manual");
    const tls = (p.init as { tls?: { serverName?: string; checkServerIdentity?: unknown } }).tls;
    expect(tls?.serverName).toBe("api.example.com");
    expect(typeof tls?.checkServerIdentity).toBe("function");
    const v6 = pinnedRequest(new URL("http://api.example.com/v1"), "2606:2800:220:1::1");
    expect(v6.url).toBe("http://[2606:2800:220:1::1]/v1");
    expect(new Headers(v6.init.headers).get("host")).toBe("api.example.com");
    expect((v6.init as { tls?: unknown }).tls).toBeUndefined(); // plain http: no TLS options
    // An IP-literal base URL is used as is.
    expect(pinnedRequest(new URL("https://93.184.216.34/v1"), "93.184.216.34").url).toBe("https://93.184.216.34/v1");
  });

  it("PoC: the guard checks a public answer while the system would resolve the name inside → the request goes to the checked IP", async () => {
    // Red team k5_poc.ts: the guard's resolver says public, the OS says 127.0.0.1 (localtest.me). Before the fix the
    // fetch resolved the name again and reached the internal server. Now it is sent to the checked address only.
    let lookups = 0;
    const guard = new PublicHostGuard(async () => {
      lookups++;
      return ["93.184.216.34"];
    }, 30_000);
    const seen: Array<{ url: string; host: string | null; redirect: RequestInit["redirect"] }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), host: new Headers(init?.headers).get("host"), redirect: init?.redirect });
      return new Response("public");
    }) as typeof fetch;
    try {
      const f = guard.fetch();
      await f("http://localtest.me:8080/latest/meta-data/", { method: "GET" });
      await f(new Request("http://localtest.me:8080/v1/models", { headers: { "x-a": "1" } }));
      const r = await limitedFetch(
        "http://localtest.me:8080/v1/models",
        { method: "GET" },
        { timeoutMs: 2000, maxBytes: 1024, guard },
      );
      expect(r.body).toBe("public");
    } finally {
      globalThis.fetch = original;
    }
    expect(seen.map((x) => x.url)).toEqual([
      "http://93.184.216.34:8080/latest/meta-data/",
      "http://93.184.216.34:8080/v1/models",
      "http://93.184.216.34:8080/v1/models",
    ]);
    expect(seen.every((x) => x.host === "localtest.me:8080" && x.redirect === "manual")).toBe(true);
    expect(lookups).toBe(1); // one lookup, its addresses are what the connection uses
  });

  it("IPv4 first; a refused connection falls back to the next checked address only (never re-resolves)", async () => {
    const guard = new PublicHostGuard(async () => ["2606:2800:220:1::1", "93.184.216.34", "93.184.216.35"]);
    const tried: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      tried.push(new URL(String(input)).hostname);
      if (tried.length === 1) throw Object.assign(new TypeError("ECONNREFUSED"), { code: "ECONNREFUSED" });
      return new Response("ok");
    }) as typeof fetch;
    try {
      expect(await (await guard.fetch()("https://multi.example.com/v1", { method: "POST", body: "{}" })).text()).toBe(
        "ok",
      );
      expect(tried).toEqual(["93.184.216.34", "93.184.216.35"]); // IPv4 first, then the next checked one
      // A failure after connecting (e.g. a reset mid-answer) is not retried: the POST is never sent twice.
      tried.length = 0;
      globalThis.fetch = (async (input: string | URL | Request) => {
        tried.push(new URL(String(input)).hostname);
        throw Object.assign(new TypeError("socket closed"), { code: "ECONNRESET" });
      }) as unknown as typeof fetch;
      await expect(guard.fetch()("https://multi.example.com/v1", { method: "POST", body: "{}" })).rejects.toThrow();
    } finally {
      globalThis.fetch = original;
    }
    expect(tried).toEqual(["93.184.216.34"]);
  });

  describe("real TLS to a pinned address", () => {
    const dir = `${import.meta.dir}/../../fixtures/tls`;
    let server: ReturnType<typeof Bun.serve>;
    let ca: string;
    beforeAll(async () => {
      ca = await Bun.file(`${dir}/pinned.cert.pem`).text();
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        tls: { cert: ca, key: await Bun.file(`${dir}/pinned.key.pem`).text() },
        fetch: (req) => new Response(`host=${req.headers.get("host")}`),
      });
    });
    afterAll(() => server.stop(true));

    it("SNI, Host and the certificate check use the original name", async () => {
      const ok = pinnedRequest(new URL(`https://pinned.upstream.test:${server.port}/v1`), "127.0.0.1", {
        tls: { ca },
      } as RequestInit);
      const res = await fetch(ok.url, ok.init);
      expect(await res.text()).toBe(`host=pinned.upstream.test:${server.port}`);
    });

    it("a certificate for another name is refused (verification is not switched off by pinning)", async () => {
      const bad = pinnedRequest(new URL(`https://evil.upstream.test:${server.port}/v1`), "127.0.0.1", {
        tls: { ca },
      } as RequestInit);
      await expect(fetch(bad.url, bad.init)).rejects.toThrow();
    });
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
