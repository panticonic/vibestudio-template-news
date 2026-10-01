/** Refresh the loaded range, including new arrivals above its previous end. */
export interface ArticleWindowRow {
  articleId: string;
  publishedAt?: string;
  fetchedAt?: number;
}
export interface ArticleWindow<T> {
  articles: T[];
  hasMore?: boolean;
  nextCursor?: string;
}
function order(row: ArticleWindowRow): [number, string] {
  return [
    row.publishedAt ? Date.parse(row.publishedAt) : (row.fetchedAt ?? 0),
    row.articleId,
  ];
}
function newer(a: ArticleWindowRow, b: ArticleWindowRow): boolean {
  const [at, ai] = order(a),
    [bt, bi] = order(b);
  return at > bt || (at === bt && ai > bi);
}
export async function refreshArticleWindow<T extends ArticleWindowRow>(
  previous: readonly T[],
  fetchPage: (cursor?: string) => Promise<ArticleWindow<T>>,
): Promise<ArticleWindow<T>> {
  const boundary = previous.at(-1);
  const articles: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    articles.push(...page.articles);
    const tail = page.articles.at(-1);
    if (!page.hasMore || !boundary || !tail || !newer(tail, boundary)) {
      return { articles, hasMore: page.hasMore, nextCursor: page.nextCursor };
    }
    if (!page.nextCursor || page.nextCursor === cursor)
      throw new Error("News pagination did not advance its cursor");
    cursor = page.nextCursor;
  }
}
