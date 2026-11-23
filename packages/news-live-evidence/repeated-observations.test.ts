import { expect, it, vi } from "vitest";
import { prepareLiveNews } from "./live.js";
const { capture } = vi.hoisted(() => ({
  capture: vi.fn(async () => ({
    kind: "reader",
    view: "inbox",
    overview: { id: "owned-overview" },
    pages: [],
  })),
}));
vi.mock("@workspace/pubsub", () => ({
  connectViaRpc: () => ({ contextId: "owned", close() {} }),
}));
vi.mock("@workspace/feeds", () => ({
  captureNewsReaderReadback: capture,
  NEWS_METHODS: {},
  newsOverviewResultSchema: {},
}));
it("shares repeated/concurrent reads of the same owned initial News evidence", async () => {
  const prepared = prepareLiveNews(
    {
      contextId: "owned",
      channelId: "room",
      channelTargetId: "owned-room",
      participantId: "reader",
      agentKey: "news",
    },
    {
      id: "owned-read",
      goal: "Review the owned reader",
      checks: [{ kind: "reader", view: "inbox" }],
      setup: [],
      expected: [],
    },
  );
  const [first, second] = await Promise.all([
    prepared.services.newsRead.observe(),
    prepared.services.newsRead.observe(),
  ]);
  expect(second).toEqual(first);
  expect(capture).toHaveBeenCalledTimes(1);
  second.length = 0;
  expect(await prepared.services.newsRead.observe()).toEqual(first);
});
