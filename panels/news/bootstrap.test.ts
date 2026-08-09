import { describe, expect, it } from "vitest";
import {
  newsAgentKey,
  newsChannelName,
  isNewsReaderDataEvent,
  relativeAge,
  requireNewsContextId,
  SUGGESTED_FEEDS,
  SUGGESTED_TOPICS,
} from "./bootstrap.js";

describe("requireNewsContextId", () => {
  it("uses only the host-bound panel context", () => {
    expect(requireNewsContextId("ctx-b")).toBe("ctx-b");
    expect(() => requireNewsContextId(undefined)).toThrow(/runtime has no workspace context/);
  });
});

describe("name minting", () => {
  it("derives stable, per-context, format-safe reader ids", () => {
    const channel = newsChannelName("ctx-a");
    const agent = newsAgentKey("ctx-a");
    // Deterministic: same context → same ids (so reloads re-resolve one reader).
    expect(newsChannelName("ctx-a")).toBe(channel);
    expect(newsAgentKey("ctx-a")).toBe(agent);
    // Per-context: a different context → a different reader.
    expect(newsChannelName("ctx-b")).not.toBe(channel);
    // Format-safe ids that share the context digest.
    expect(channel).toMatch(/^news-[a-z0-9]+$/);
    expect(agent).toBe(`news-agent-${channel.slice("news-".length)}`);
  });
});

describe("relativeAge", () => {
  const now = Date.parse("2026-06-18T12:00:00Z");
  it("renders compact buckets and rejects junk/future", () => {
    expect(relativeAge(undefined, now)).toBeNull();
    expect(relativeAge("not-a-date", now)).toBeNull();
    expect(relativeAge("2026-06-18T12:30:00Z", now)).toBeNull(); // future
    expect(relativeAge("2026-06-18T11:59:30Z", now)).toBe("now");
    expect(relativeAge("2026-06-18T11:30:00Z", now)).toBe("30m");
    expect(relativeAge("2026-06-18T09:00:00Z", now)).toBe("3h");
    expect(relativeAge("2026-06-16T12:00:00Z", now)).toBe("2d");
    expect(relativeAge("2026-06-04T12:00:00Z", now)).toBe("2w");
  });
});

describe("quick-start suggestions", () => {
  it("offers curated http(s) feeds and non-empty topics", () => {
    expect(SUGGESTED_FEEDS.length).toBeGreaterThan(0);
    for (const feed of SUGGESTED_FEEDS) {
      expect(feed.url).toMatch(/^https?:\/\//);
      expect(feed.label.length).toBeGreaterThan(0);
    }
    expect(SUGGESTED_TOPICS.length).toBeGreaterThan(0);
    expect(new Set(SUGGESTED_TOPICS).size).toBe(SUGGESTED_TOPICS.length);
  });
});

describe("reader event refresh boundary", () => {
  it("refreshes only for durable card state changes", () => {
    expect(
      isNewsReaderDataEvent({
        type: "agentic.trajectory.v1/event",
        payload: { kind: "custom.updated" },
      })
    ).toBe(true);
    expect(
      isNewsReaderDataEvent({
        type: "agentic.trajectory.v1/event",
        payload: { kind: "invocation.completed" },
      })
    ).toBe(false);
    expect(isNewsReaderDataEvent({ type: "presence", payload: { kind: "custom.updated" } })).toBe(
      false
    );
  });
});
