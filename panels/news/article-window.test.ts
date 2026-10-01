import { describe, expect, it, vi } from "vitest";
import { refreshArticleWindow } from "./article-window.js";
const row = (n: number) => ({ articleId: String(n), fetchedAt: n });
describe("the reader's loaded window", () => {
  it("retains older loaded pages when new stories arrive and stops at the owned boundary", async () => {
    const fetch = vi.fn(async (cursor?: string) =>
      cursor === "page-2"
        ? {
            articles: [row(5), row(4), row(3), row(2)],
            hasMore: true,
            nextCursor: "page-3",
          }
        : {
            articles: [row(9), row(8), row(7), row(6)],
            hasMore: true,
            nextCursor: "page-2",
          },
    );
    const next = await refreshArticleWindow(
      [row(7), row(6), row(5), row(4), row(3)],
      fetch,
    );
    expect(next.articles.map((item) => item.articleId)).toEqual([
      "9",
      "8",
      "7",
      "6",
      "5",
      "4",
      "3",
      "2",
    ]);
    expect(next.nextCursor).toBe("page-3");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("uses ordering to retain the range when the old last story was deleted", async () => {
    const fetch = vi.fn(async () => ({
      articles: [row(7), row(5), row(2)],
      hasMore: true,
      nextCursor: "older",
    }));
    expect(
      (await refreshArticleWindow([row(5), row(3)], fetch)).articles.map(
        (item) => item.articleId,
      ),
    ).toEqual(["7", "5", "2"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects a broken pagination contract instead of looping forever", async () => {
    await expect(
      refreshArticleWindow([row(1)], async () => ({
        articles: [row(9)],
        hasMore: true,
        nextCursor: "same",
      })),
    ).rejects.toThrow("did not advance");
  });
});
