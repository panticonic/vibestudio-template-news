import {
  Badge,
  Button,
  Code,
  Flex,
  Heading,
  IconButton,
  Link,
  Spinner,
  Text,
} from "@radix-ui/themes";
import {
  EyeNoneIcon,
  GlobeIcon,
  ReaderIcon,
  ThickArrowDownIcon,
  ThickArrowUpIcon,
} from "@radix-ui/react-icons";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NewsBriefingCardState, NewsStoryRef } from "@workspace/feeds/card-types";

type BriefingState = Partial<NewsBriefingCardState> & { briefingId: string };

const MD_REMARK_PLUGINS = [remarkGfm];

// Markdown → radix component map for the briefing TLDR. react-markdown and
// remark-gfm are declared in NEWS_UI_IMPORTS, so the sandbox build service loads
// them on demand (same path as @radix-ui), keeping the card in sync with how the
// news panel renders the same digest.
const MD_COMPONENTS: Components = {
  p: ({ children }) => (
    <Text as="p" size="2" style={{ margin: 0, wordBreak: "break-word" }}>
      {children}
    </Text>
  ),
  h1: ({ children }) => (
    <Heading size="4" style={{ margin: 0 }}>
      {children}
    </Heading>
  ),
  h2: ({ children }) => (
    <Heading size="3" style={{ margin: 0 }}>
      {children}
    </Heading>
  ),
  h3: ({ children }) => (
    <Heading size="2" style={{ margin: 0 }}>
      {children}
    </Heading>
  ),
  h4: ({ children }) => (
    <Heading size="2" style={{ margin: 0 }}>
      {children}
    </Heading>
  ),
  ul: ({ children }) => (
    <ul
      style={{
        margin: 0,
        paddingLeft: "var(--space-4)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-1)",
      }}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol
      style={{
        margin: 0,
        paddingLeft: "var(--space-4)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-1)",
      }}
    >
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li style={{ wordBreak: "break-word" }}>
      <Text size="2">{children}</Text>
    </li>
  ),
  a: ({ href, children }) => (
    <Link href={href ?? ""} target="_blank" rel="noreferrer">
      {children}
    </Link>
  ),
  code: ({ children }) => <Code size="1">{children}</Code>,
  strong: ({ children }) => <Text weight="bold">{children}</Text>,
  em: ({ children }) => <Text style={{ fontStyle: "italic" }}>{children}</Text>,
};

/** Render the briefing TLDR as markdown, styled with radix to match the panel. */
function Markdown({ children }: { children: string }) {
  return (
    <Flex direction="column" gap="2">
      <ReactMarkdown remarkPlugins={MD_REMARK_PLUGINS} components={MD_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </Flex>
  );
}

interface NewsChat {
  callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown>;
}

export function Pill({ state }: { state: BriefingState }) {
  const count = state.stories?.length ?? 0;
  return (
    <Flex align="center" gap="1">
      <ReaderIcon />
      <Text size="1" weight="medium" truncate style={{ minWidth: 0 }}>
        {state.status === "ready" ? "News briefing" : "Briefing in progress…"}
      </Text>
      {count > 0 ? (
        <Badge size="1" color="blue">
          {count}
        </Badge>
      ) : null}
    </Flex>
  );
}

function ageLabel(publishedAt?: string): string | null {
  if (!publishedAt) return null;
  const ms = Date.now() - Date.parse(publishedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "now";
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "3h ago" / "just now" / a date for the briefing header. */
function agoLabel(iso: string): string {
  const age = ageLabel(iso);
  if (!age) return new Date(iso).toLocaleDateString();
  return age === "now" ? "just now" : `${age} ago`;
}

/** A site favicon (from the article's own origin) with a globe fallback. */
function Favicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  let origin: string | null = null;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = null;
  }
  if (!origin || failed) {
    return <GlobeIcon style={{ flexShrink: 0, color: "var(--gray-9)" }} />;
  }
  return (
    <img
      src={`${origin}/favicon.ico`}
      alt=""
      width={16}
      height={16}
      onError={() => setFailed(true)}
      style={{ flexShrink: 0, borderRadius: 3, objectFit: "contain" }}
    />
  );
}

function StoryRow({
  story,
  busy,
  onDeepDive,
  onMarkRead,
  onReact,
}: {
  story: NewsStoryRef;
  busy: boolean;
  onDeepDive: (story: NewsStoryRef) => void;
  onMarkRead: (story: NewsStoryRef) => void;
  onReact: (story: NewsStoryRef, reaction: "more" | "less" | "mute_source") => void;
}) {
  const age = ageLabel(story.publishedAt);
  return (
    <Flex direction="column" gap="1" style={{ opacity: story.read ? 0.55 : 1 }}>
      <Flex align="center" gap="2" style={{ minWidth: 0 }}>
        <Favicon url={story.url} />
        <Link
          href={story.url}
          target="_blank"
          rel="noreferrer"
          size="2"
          weight="medium"
          style={{ minWidth: 0, wordBreak: "break-word" }}
          onClick={() => onMarkRead(story)}
        >
          {story.title}
        </Link>
      </Flex>
      {story.blurb ? (
        <Text size="1" color="gray" style={{ wordBreak: "break-word" }}>
          {story.blurb}
        </Text>
      ) : null}
      <Flex align="center" gap="2" wrap="wrap">
        <Text size="1" color="gray">
          {story.source}
          {age ? ` · ${age}` : ""}
        </Text>
        <Button size="1" variant="soft" disabled={busy} onClick={() => onDeepDive(story)}>
          Deep-dive
        </Button>
        <IconButton
          size="1"
          variant="ghost"
          color="grass"
          title="More like this"
          aria-label="More like this"
          disabled={busy}
          onClick={() => onReact(story, "more")}
        >
          <ThickArrowUpIcon />
        </IconButton>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          title="Less like this"
          aria-label="Less like this"
          disabled={busy}
          onClick={() => onReact(story, "less")}
        >
          <ThickArrowDownIcon />
        </IconButton>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          title={`Mute ${story.source}`}
          aria-label={`Mute ${story.source}`}
          disabled={busy}
          onClick={() => onReact(story, "mute_source")}
        >
          <EyeNoneIcon />
        </IconButton>
        {!story.read ? (
          <Button size="1" variant="ghost" disabled={busy} onClick={() => onMarkRead(story)}>
            Mark read
          </Button>
        ) : null}
      </Flex>
    </Flex>
  );
}

/**
 * One briefing run: TLDR plus ranked tappable story rows. "Deep-dive" asks
 * the agent to append a durable news.deepdive.requested fact; the news panel forks
 * the channel into a per-story analysis chat.
 */
export default function NewsBriefing({
  state,
  expanded,
  chat,
}: {
  state: BriefingState;
  expanded: boolean;
  chat: NewsChat;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!expanded) return <Pill state={state} />;

  async function call(method: string, args: unknown) {
    setBusy(true);
    setError(null);
    try {
      await chat.callMethodByHandle("news", method, args);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const stories = state.stories ?? [];
  const sourcesNote =
    typeof state.sourcesRead === "number" && state.sourcesRead > 0
      ? ` · ${state.sourcesRead} source${state.sourcesRead > 1 ? "s" : ""} read`
      : "";
  return (
    <Flex direction="column" gap="3">
      <Flex align="center" gap="2" style={{ minWidth: 0 }}>
        <ReaderIcon />
        <Text size="2" weight="bold">
          News briefing
        </Text>
        {state.createdAt ? (
          <Text size="1" color="gray" title={new Date(state.createdAt).toLocaleString()}>
            {agoLabel(state.createdAt)}
            {sourcesNote}
          </Text>
        ) : null}
        {state.status === "summarizing" || state.status === "collecting" ? (
          <Flex align="center" gap="1">
            <Spinner size="1" />
            <Text size="1" color="gray">
              summarizing…
            </Text>
          </Flex>
        ) : null}
        {state.status === "error" ? (
          <Badge size="1" color="red">
            failed
          </Badge>
        ) : null}
      </Flex>
      {state.lastError ? (
        <Text size="1" color="red">
          {state.lastError}
        </Text>
      ) : null}
      {error ? (
        <Text size="1" color="red">
          {error}
        </Text>
      ) : null}
      {state.tldr ? <Markdown>{state.tldr}</Markdown> : null}
      <Flex direction="column" gap="3">
        {stories.map((story) => (
          <StoryRow
            key={story.articleId}
            story={story}
            busy={busy}
            onDeepDive={(item) => void call("requestDeepDive", { articleId: item.articleId })}
            onMarkRead={(item) => void call("markRead", { articleIds: [item.articleId] })}
            onReact={(item, reaction) =>
              void call("reactToStory", { articleId: item.articleId, reaction })
            }
          />
        ))}
      </Flex>
      {typeof state.articleCountScanned === "number" &&
      state.articleCountScanned > stories.length ? (
        <Text size="1" color="gray">
          {state.articleCountScanned - stories.length} more scanned and filtered out
        </Text>
      ) : null}
    </Flex>
  );
}
