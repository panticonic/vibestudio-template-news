import { describe, expect, it } from "vitest";
import { fetchFeed, HostPoliteness, type Fetcher } from "./fetch-feed.js";

function stubFetcher(handler: (url: string, init?: RequestInit) => Response): Fetcher {
  return async (url, init) => handler(url, init);
}

describe("fetchFeed", () => {
  it("returns body and caches validators on 200", async () => {
    const result = await fetchFeed("https://example.com/feed", {
      fetcher: stubFetcher(
        () =>
          new Response("<rss/>", {
            status: 200,
            headers: { etag: '"v1"', "last-modified": "Wed, 11 Jun 2025 00:00:00 GMT" },
          }),
      ),
    });
    expect(result).toMatchObject({ status: "ok", body: "<rss/>", etag: '"v1"' });
  });

  it("sends conditional headers and maps 304 to not-modified", async () => {
    let sentHeaders: Record<string, string> = {};
    const result = await fetchFeed("https://example.com/feed", {
      etag: '"v1"',
      lastModified: "Wed, 11 Jun 2025 00:00:00 GMT",
      fetcher: stubFetcher((_url, init) => {
        sentHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(null, { status: 304 });
      }),
    });
    expect(result.status).toBe("not-modified");
    expect(sentHeaders["if-none-match"]).toBe('"v1"');
    expect(sentHeaders["if-modified-since"]).toBe("Wed, 11 Jun 2025 00:00:00 GMT");
  });

  it("maps HTTP errors to error results with the status code", async () => {
    const result = await fetchFeed("https://example.com/feed", {
      fetcher: stubFetcher(() => new Response("nope", { status: 503 })),
    });
    expect(result).toMatchObject({ status: "error", httpStatus: 503 });
  });

  it("refuses non-http(s) feed URLs before the transport sees them", async () => {
    const requested: string[] = [];
    const fetcher = stubFetcher((url) => {
      requested.push(url);
      return new Response("<rss/>", { status: 200 });
    });
    for (const url of [
      "file:///etc/passwd",
      "data:application/rss+xml,<rss/>",
      "javascript:alert(1)",
      "ftp://example.com/feed.xml",
      "example.com/feed.xml",
    ]) {
      expect(await fetchFeed(url, { fetcher })).toEqual({
        status: "error",
        error: "only http(s) feed URLs are supported",
      });
    }
    expect(requested).toEqual([]);
  });

  it("fetches self-hosted http feeds on localhost and the LAN", async () => {
    const requested: string[] = [];
    const fetcher = stubFetcher((url) => {
      requested.push(url);
      return new Response("<rss/>", { status: 200 });
    });
    for (const url of ["http://localhost:8080/feed.xml", "http://192.168.1.20/rss", "https://nas.local/atom"]) {
      expect(await fetchFeed(url, { fetcher })).toMatchObject({ status: "ok", body: "<rss/>" });
    }
    expect(requested).toEqual(["http://localhost:8080/feed.xml", "http://192.168.1.20/rss", "https://nas.local/atom"]);
  });

  it("maps network failures to error results", async () => {
    const result = await fetchFeed("https://example.com/feed", {
      fetcher: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result).toMatchObject({ status: "error", error: "ECONNREFUSED" });
  });
});

describe("HostPoliteness", () => {
  it("allows the first hit immediately and spaces subsequent hits per host", () => {
    const gate = new HostPoliteness(1000);
    expect(gate.delayFor("https://a.com/1", 0)).toBe(0);
    expect(gate.delayFor("https://a.com/2", 0)).toBe(1000);
    expect(gate.delayFor("https://a.com/3", 0)).toBe(2000);
    // Different host is independent
    expect(gate.delayFor("https://b.com/1", 0)).toBe(0);
  });

  it("does not penalize after the interval has elapsed", () => {
    const gate = new HostPoliteness(1000);
    gate.delayFor("https://a.com/1", 0);
    expect(gate.delayFor("https://a.com/2", 5000)).toBe(0);
  });
});
