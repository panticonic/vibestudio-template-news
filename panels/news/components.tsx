import { useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  DropdownMenu,
  Flex,
  Heading,
  IconButton,
  Link,
  Separator,
  Spinner,
  Switch,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import {
  BookmarkFilledIcon,
  BookmarkIcon,
  CheckIcon,
  Cross2Icon,
  DotsHorizontalIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LightningBoltIcon,
  PlusIcon,
  ReaderIcon,
} from "@radix-ui/react-icons";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "@workspace/agentic-chat";
import { NEWS_METHODS } from "@workspace/feeds";
import type { NewsSetupCardState } from "@workspace/feeds/card-types";
import { relativeAge, SUGGESTED_FEEDS, SUGGESTED_TOPICS } from "./bootstrap.js";

export interface ArticleRow {
  articleId: string;
  title: string;
  url: string;
  source: string;
  origin: "feed" | "search";
  blurb?: string;
  publishedAt?: string;
  fetchedAt?: number;
  category?: string;
  clusterKey?: string;
  briefedIn?: string;
  read: boolean;
  saved?: boolean;
}

export interface BriefingRow {
  briefingId: string;
  createdAt: string;
  status: "collecting" | "summarizing" | "ready" | "error" | string;
  tldr?: string;
  sourcesRead?: number;
  lastError?: string;
}

export interface ArticleCluster {
  primary: ArticleRow;
  others: ArticleRow[];
}

export function clusterArticles(articles: ArticleRow[]): ArticleCluster[] {
  const result: ArticleCluster[] = [];
  const keyed = new Map<string, ArticleCluster>();
  for (const article of articles) {
    if (!article.clusterKey) {
      result.push({ primary: article, others: [] });
      continue;
    }
    const existing = keyed.get(article.clusterKey);
    if (existing) existing.others.push(article);
    else {
      const cluster = { primary: article, others: [] };
      keyed.set(article.clusterKey, cluster);
      result.push(cluster);
    }
  }
  return result;
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="message-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents as Components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

function Favicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  let origin: string | null = null;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = null;
  }
  if (!origin || failed) return <GlobeIcon aria-hidden />;
  return (
    <img
      src={`${origin}/favicon.ico`}
      alt=""
      width={16}
      height={16}
      onError={() => setFailed(true)}
      style={{ borderRadius: 3, objectFit: "contain", flex: "0 0 auto" }}
    />
  );
}

export function ArticleCard({
  article,
  others,
  selected,
  fresh,
  disabled,
  onOpen,
  onSave,
  onDeepDive,
  onRead,
  onReact,
}: {
  article: ArticleRow;
  others: ArticleRow[];
  selected: boolean;
  fresh: boolean;
  disabled: boolean;
  onOpen: () => void;
  onSave: (saved: boolean) => void;
  onDeepDive: () => void;
  onRead: () => void;
  onReact: (reaction: "more" | "less" | "mute_source") => void;
}) {
  const age = relativeAge(article.publishedAt);
  const sourceAction =
    article.origin === "feed" ? `Mute ${article.source}` : `See less from ${article.source}`;
  return (
    <article className="news-story" data-read={article.read} data-selected={selected}>
      <Flex direction="column" gap="2">
        <Flex align="start" gap="2">
          <Box mt="1">
            <Favicon url={article.url} />
          </Box>
          <Box style={{ minWidth: 0, flex: 1 }}>
            <Flex align="center" gap="2" wrap="wrap">
              <Link
                className="news-story-title"
                href={article.url}
                target="_blank"
                rel="noreferrer"
                size="3"
                weight={article.read ? "regular" : "bold"}
                onClick={onOpen}
              >
                {article.title}
              </Link>
              {fresh ? (
                <Badge size="1" color="blue">
                  New
                </Badge>
              ) : null}
            </Flex>
            <Flex align="center" gap="1" mt="1" wrap="wrap">
              <Text size="1" color="gray">
                {article.source}
              </Text>
              {age ? (
                <Text size="1" color="gray">
                  · {age}
                </Text>
              ) : null}
              {article.briefedIn ? (
                <Text size="1" color="gray">
                  · in your briefing
                </Text>
              ) : null}
            </Flex>
          </Box>
        </Flex>

        {article.blurb ? (
          <Text className="news-story-summary" size="2" color="gray">
            {article.blurb}
          </Text>
        ) : null}

        {others.length > 0 ? (
          <Flex gap="1" wrap="wrap" align="center">
            <Text size="1" color="gray">
              Also covered by
            </Text>
            {others.map((other) => (
              <Link
                key={other.articleId}
                href={other.url}
                target="_blank"
                rel="noreferrer"
                size="1"
                onClick={() => onRead()}
              >
                {other.source}
              </Link>
            ))}
          </Flex>
        ) : null}

        <Flex className="news-story-actions" align="center" gap="2" wrap="wrap">
          <Button size="1" variant="soft" disabled={disabled} onClick={onDeepDive}>
            <LightningBoltIcon /> Explore
          </Button>
          <IconButton
            size="1"
            variant="ghost"
            color={article.saved ? "amber" : "gray"}
            disabled={disabled}
            aria-label={`${article.saved ? "Remove" : "Save"} ${article.title}`}
            aria-pressed={Boolean(article.saved)}
            onClick={() => onSave(!article.saved)}
          >
            {article.saved ? <BookmarkFilledIcon /> : <BookmarkIcon />}
          </IconButton>
          {!article.read ? (
            <Button size="1" variant="ghost" disabled={disabled} onClick={onRead}>
              Mark read
            </Button>
          ) : null}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                disabled={disabled}
                aria-label={`More actions for ${article.title}`}
              >
                <DotsHorizontalIcon />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="start">
              <DropdownMenu.Item onSelect={() => onReact("more")}>More like this</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => onReact("less")}>Less like this</DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item color="red" onSelect={() => onReact("mute_source")}>
                {sourceAction}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
          <Box flexGrow="1" />
          <IconButton
            asChild
            size="1"
            variant="ghost"
            color="gray"
            aria-label={`Open ${article.title} in a new tab`}
          >
            <a href={article.url} target="_blank" rel="noreferrer" onClick={onOpen}>
              <ExternalLinkIcon />
            </a>
          </IconButton>
        </Flex>
      </Flex>
    </article>
  );
}

export function BriefingHero({
  briefing,
  pending,
  onCreate,
  busy,
}: {
  briefing?: BriefingRow;
  pending?: BriefingRow;
  onCreate: () => void;
  busy: boolean;
}) {
  if (pending) {
    return (
      <Card className="news-hero" size="3">
        <Flex className="news-hero-content" direction="column" gap="3">
          <Flex align="center" gap="2">
            <Spinner />
            <Text weight="medium">Building your briefing</Text>
          </Flex>
          <Text size="2" color="gray">
            Reading the strongest sources and connecting the stories that matter.
          </Text>
        </Flex>
      </Card>
    );
  }
  if (briefing?.status === "error") {
    return (
      <Card className="news-hero" size="3">
        <Flex className="news-hero-content" direction="column" gap="3" align="start">
          <Badge color="red">Briefing interrupted</Badge>
          <Text size="2" color="gray">
            {briefing.lastError ?? "This briefing did not complete."}
          </Text>
          <Button size="2" variant="soft" disabled={busy} onClick={onCreate}>
            Try again
          </Button>
        </Flex>
      </Card>
    );
  }
  if (briefing?.tldr) {
    return (
      <Card className="news-hero" size="3">
        <Flex className="news-hero-content" direction="column" gap="3">
          <Flex align="center" gap="2" wrap="wrap">
            <Badge color="blue" variant="soft">
              Your briefing
            </Badge>
            <Text size="1" color="gray">
              {relativeAge(briefing.createdAt) ?? new Date(briefing.createdAt).toLocaleDateString()}{" "}
              ago
            </Text>
            {briefing.sourcesRead ? (
              <Text size="1" color="gray">
                · {briefing.sourcesRead} sources read
              </Text>
            ) : null}
          </Flex>
          <Markdown>{briefing.tldr}</Markdown>
        </Flex>
      </Card>
    );
  }
  return (
    <Card className="news-hero" size="3">
      <Flex className="news-hero-content" direction="column" gap="3" align="start">
        <Flex align="center" gap="2">
          <ReaderIcon />
          <Heading size="4">A calmer way to catch up</Heading>
        </Flex>
        <Text size="2" color="gray">
          Your sources are gathered continuously. Create a briefing when you want the concise
          version.
        </Text>
        <Button disabled={busy} onClick={onCreate}>
          <LightningBoltIcon /> Create my first briefing
        </Button>
      </Flex>
    </Card>
  );
}

type Action = (method: string, args: Record<string, unknown>) => Promise<unknown>;

function settle(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

export function SettingsContent({
  setup,
  action,
  activeAction,
}: {
  setup: NewsSetupCardState;
  action: Action;
  activeAction: string | null;
}) {
  const [feed, setFeed] = useState("");
  const [topic, setTopic] = useState("");
  const [preferences, setPreferences] = useState(setup.preferencesText ?? "");
  const [opml, setOpml] = useState("");
  const [importResult, setImportResult] = useState<string | null>(null);
  const busy = activeAction !== null;

  const submitFeed = async () => {
    const value = feed.trim();
    if (!value) return;
    try {
      await action(NEWS_METHODS.addFeed, { url: value });
      setFeed("");
    } catch {
      /* keep input */
    }
  };
  const submitTopic = async () => {
    const value = topic.trim();
    if (!value) return;
    try {
      await action(NEWS_METHODS.followTopic, { topic: value });
      setTopic("");
    } catch {
      /* keep input */
    }
  };

  return (
    <Box className="news-settings-grid">
      <Flex direction="column" gap="5">
        <Box>
          <Heading size="3" mb="1">
            Sources
          </Heading>
          <Text size="2" color="gray">
            Feeds are checked in the background. Pause one without losing its history.
          </Text>
        </Box>
        <Box>
          {setup.feeds.length === 0 ? (
            <Text size="2" color="gray">
              No feeds yet.
            </Text>
          ) : null}
          {setup.feeds.map((item) => (
            <Flex className="news-source-row" key={item.feedId} align="center" gap="2">
              <Switch
                checked={item.enabled}
                disabled={busy}
                aria-label={`${item.enabled ? "Pause" : "Resume"} ${item.title ?? item.url}`}
                onCheckedChange={(enabled) =>
                  settle(action(NEWS_METHODS.setFeedEnabled, { feedId: item.feedId, enabled }))
                }
              />
              <Box style={{ minWidth: 0, flex: 1 }}>
                <Text size="2" weight="medium" truncate>
                  {item.title ?? item.url}
                </Text>
                <Text size="1" color={item.failCount > 0 ? "red" : "gray"} truncate>
                  {item.failCount > 0
                    ? (item.lastStatus ?? `${item.failCount} recent failures`)
                    : item.url}
                </Text>
              </Box>
              <IconButton
                variant="ghost"
                color="red"
                disabled={busy}
                aria-label={`Remove ${item.title ?? item.url}`}
                onClick={() => settle(action(NEWS_METHODS.removeFeed, { feedId: item.feedId }))}
              >
                <Cross2Icon />
              </IconButton>
            </Flex>
          ))}
        </Box>
        <Box className="news-form-row">
          <TextField.Root
            value={feed}
            placeholder="Paste a site or feed URL"
            style={{ flex: 1 }}
            onChange={(event) => setFeed(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitFeed();
            }}
          />
          <Button disabled={busy || !feed.trim()} onClick={() => void submitFeed()}>
            {activeAction === NEWS_METHODS.addFeed ? <Spinner /> : <PlusIcon />} Add feed
          </Button>
        </Box>

        <Separator size="4" />

        <Box>
          <Heading size="3" mb="1">
            Topics
          </Heading>
          <Text size="2" color="gray">
            Topics are researched when a briefing is created.
          </Text>
        </Box>
        <Flex gap="2" wrap="wrap">
          {setup.followedTopics.map((item) => (
            <Badge key={item.topic} size="2" color={item.enabled ? "blue" : "gray"}>
              {item.topic}
              <IconButton
                size="1"
                variant="ghost"
                disabled={busy}
                aria-label={`Unfollow ${item.topic}`}
                onClick={() => settle(action(NEWS_METHODS.unfollowTopic, { topic: item.topic }))}
              >
                <Cross2Icon />
              </IconButton>
            </Badge>
          ))}
        </Flex>
        <Box className="news-form-row">
          <TextField.Root
            value={topic}
            placeholder="A topic you care about"
            style={{ flex: 1 }}
            onChange={(event) => setTopic(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitTopic();
            }}
          />
          <Button disabled={busy || !topic.trim()} onClick={() => void submitTopic()}>
            {activeAction === NEWS_METHODS.followTopic ? <Spinner /> : <PlusIcon />} Follow
          </Button>
        </Box>
      </Flex>

      <Flex direction="column" gap="5">
        <Box>
          <Heading size="3" mb="1">
            Taste
          </Heading>
          <Text size="2" color="gray">
            Tell News what to favor, ignore, and how concise to be.
          </Text>
        </Box>
        <TextArea
          rows={5}
          value={preferences}
          placeholder="More independent reporting, less product launch noise…"
          onChange={(event) => setPreferences(event.target.value)}
        />
        <Button
          variant="soft"
          disabled={busy || preferences === (setup.preferencesText ?? "")}
          onClick={() => settle(action(NEWS_METHODS.setPreferences, { text: preferences }))}
        >
          Save preferences
        </Button>

        <Separator size="4" />
        <Box>
          <Heading size="3" mb="1">
            Briefing rhythm
          </Heading>
          <Text size="2" color="gray">
            {setup.scheduleSummary}
          </Text>
        </Box>
        <Flex align="center" justify="between" gap="3">
          <Box>
            <Text size="2" weight="medium">
              Automatic briefings
            </Text>
            <br />
            <Text size="1" color="gray">
              Pause while you are away.
            </Text>
          </Box>
          <Switch
            checked={!setup.briefingPaused}
            disabled={busy}
            aria-label="Automatic briefings"
            onCheckedChange={(active) =>
              settle(action(NEWS_METHODS.setBriefingPaused, { paused: !active }))
            }
          />
        </Flex>
        <label>
          <Text as="div" size="2" weight="medium" mb="1">
            Daily at
          </Text>
          <input
            type="time"
            value={
              typeof setup.briefingAtMinutes === "number"
                ? `${String(Math.floor(setup.briefingAtMinutes / 60)).padStart(2, "0")}:${String(setup.briefingAtMinutes % 60).padStart(2, "0")}`
                : ""
            }
            disabled={busy}
            onChange={(event) => {
              if (event.target.value)
                settle(action(NEWS_METHODS.setSchedule, { briefingAt: event.target.value }));
            }}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid var(--gray-a7)",
              background: "var(--color-surface)",
              color: "var(--gray-12)",
            }}
          />
        </label>

        <Separator size="4" />
        <Box>
          <Heading size="3" mb="1">
            Import OPML
          </Heading>
          <Text size="2" color="gray">
            Move subscriptions from another reader.
          </Text>
        </Box>
        <TextArea
          rows={4}
          value={opml}
          placeholder="Paste OPML here…"
          onChange={(event) => setOpml(event.target.value)}
        />
        <Button
          variant="soft"
          disabled={busy || !opml.trim()}
          onClick={() =>
            void (async () => {
              try {
                const result = (await action(NEWS_METHODS.importOpml, { opml: opml.trim() })) as {
                  imported?: number;
                  failed?: number;
                  total?: number;
                };
                setImportResult(
                  `${result.imported ?? 0} imported · ${result.failed ?? 0} failed · ${result.total ?? 0} found`
                );
                setOpml("");
              } catch {
                /* keep input */
              }
            })()
          }
        >
          Import feeds
        </Button>
        {importResult ? (
          <Text size="1" color="gray">
            {importResult}
          </Text>
        ) : null}
      </Flex>
    </Box>
  );
}

export function Onboarding({
  action,
  activeAction,
}: {
  action: Action;
  activeAction: string | null;
}) {
  const [feed, setFeed] = useState("");
  const busy = activeAction !== null;
  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <Box>
          <Badge color="blue" mb="2">
            Make it yours
          </Badge>
          <Heading size="5" mb="2">
            What do you want to keep up with?
          </Heading>
          <Text size="2" color="gray">
            Choose a few trusted sources or topics. News will quietly gather them and help you catch
            up when you are ready.
          </Text>
        </Box>
        <Box className="news-onboarding-grid">
          {SUGGESTED_FEEDS.slice(0, 4).map((item) => (
            <Button
              key={item.url}
              size="3"
              variant="surface"
              disabled={busy}
              onClick={() => settle(action(NEWS_METHODS.addFeed, { url: item.url }))}
            >
              <PlusIcon /> {item.label}
              <Text size="1" color="gray">
                {item.blurb}
              </Text>
            </Button>
          ))}
        </Box>
        <Flex gap="2" wrap="wrap">
          {SUGGESTED_TOPICS.map((item) => (
            <Button
              key={item}
              size="1"
              variant="outline"
              disabled={busy}
              onClick={() => settle(action(NEWS_METHODS.followTopic, { topic: item }))}
            >
              <PlusIcon /> {item}
            </Button>
          ))}
        </Flex>
        <Box className="news-form-row">
          <TextField.Root
            value={feed}
            placeholder="Or paste any site or feed URL"
            style={{ flex: 1 }}
            onChange={(event) => setFeed(event.target.value)}
          />
          <Button
            disabled={busy || !feed.trim()}
            onClick={() =>
              void (async () => {
                try {
                  await action(NEWS_METHODS.addFeed, { url: feed.trim() });
                  setFeed("");
                } catch {
                  /* keep input */
                }
              })()
            }
          >
            {activeAction === NEWS_METHODS.addFeed ? <Spinner /> : <PlusIcon />} Add source
          </Button>
        </Box>
        <Flex align="center" gap="2">
          <CheckIcon color="var(--green-9)" />
          <Text size="1" color="gray">
            No algorithmic firehose. You control every source.
          </Text>
        </Flex>
      </Flex>
    </Card>
  );
}
