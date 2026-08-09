import { Badge, Button, Flex, Switch, Text, TextField } from "@radix-ui/themes";
import { Cross2Icon, GearIcon, PlusIcon, ReloadIcon } from "@radix-ui/react-icons";
import { useState } from "react";
import type { NewsSetupCardState } from "@workspace/feeds/card-types";

type SetupState = Partial<NewsSetupCardState>;

interface NewsChat {
  callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown>;
}

export function Pill({ state }: { state: SetupState }) {
  const feeds = state.feeds?.length ?? 0;
  const topics = state.followedTopics?.length ?? 0;
  return (
    <Flex align="center" gap="1">
      <GearIcon />
      <Text size="1" weight="medium" truncate style={{ minWidth: 0 }}>
        News sources
      </Text>
      <Badge size="1" color={state.status === "configured" ? "green" : "amber"}>
        {feeds} feeds · {topics} topics
      </Badge>
    </Flex>
  );
}

/**
 * Singleton per-channel configuration card: feeds, followed topics, schedule,
 * and standing preferences. Every control round-trips through agent methods,
 * so conversational edits and card edits stay in one place.
 */
export default function NewsSetup({
  state,
  expanded,
  chat,
}: {
  state: SetupState;
  expanded: boolean;
  chat: NewsChat;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFeedUrl, setNewFeedUrl] = useState("");
  const [newTopic, setNewTopic] = useState("");
  const [prefsDraft, setPrefsDraft] = useState<string | null>(null);

  if (!expanded) return <Pill state={state} />;

  async function call(method: string, args: unknown) {
    setBusy(true);
    setError(null);
    try {
      const result = (await chat.callMethodByHandle("news", method, args)) as
        | { error?: string }
        | undefined;
      if (result && typeof result === "object" && typeof result.error === "string") {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const feeds = state.feeds ?? [];
  const topics = state.followedTopics ?? [];
  return (
    <Flex direction="column" gap="3">
      <Flex align="center" gap="2">
        <GearIcon />
        <Text size="2" weight="bold">
          News sources
        </Text>
        <Badge size="1" color={state.status === "configured" ? "green" : "amber"}>
          {state.status === "configured" ? "configured" : "setup needed"}
        </Badge>
        <Button size="1" variant="soft" disabled={busy} onClick={() => void call("refreshNow", {})}>
          <ReloadIcon /> Refresh now
        </Button>
        <Button
          size="1"
          variant="soft"
          disabled={busy}
          onClick={() => void call("refreshNow", { briefing: true })}
        >
          Brief me now
        </Button>
      </Flex>
      {state.scheduleSummary ? (
        <Text size="1" color="gray">
          {state.scheduleSummary}
        </Text>
      ) : null}
      {state.lastError ? (
        <Text size="1" color="red">
          last run: {state.lastError}
        </Text>
      ) : null}
      {error ? (
        <Text size="1" color="red">
          {error}
        </Text>
      ) : null}

      <Flex direction="column" gap="2">
        <Text size="1" weight="bold">
          Feeds
        </Text>
        {feeds.map((feed) => (
          <Flex key={feed.feedId} align="center" gap="2" style={{ minWidth: 0 }}>
            <Switch
              size="1"
              checked={feed.enabled}
              disabled={busy}
              onCheckedChange={(enabled) =>
                void call("setFeedEnabled", { feedId: feed.feedId, enabled })
              }
            />
            <Text size="1" truncate style={{ minWidth: 0, flex: 1 }}>
              {feed.title ?? feed.url}
            </Text>
            {feed.failCount > 0 ? (
              <Badge size="1" color="red" title={feed.lastStatus}>
                {feed.failCount} fails
              </Badge>
            ) : null}
            <Button
              size="1"
              variant="ghost"
              color="red"
              disabled={busy}
              onClick={() => void call("news_remove_feed", { feedId: feed.feedId })}
            >
              <Cross2Icon />
            </Button>
          </Flex>
        ))}
        <Flex align="center" gap="2">
          <TextField.Root
            size="1"
            placeholder="https://example.com/feed.xml"
            value={newFeedUrl}
            onChange={(event) => setNewFeedUrl(event.target.value)}
            style={{ flex: 1 }}
          />
          <Button
            size="1"
            disabled={busy || newFeedUrl.trim().length === 0}
            onClick={() => {
              void call("news_add_feed", { url: newFeedUrl.trim() }).then(() => setNewFeedUrl(""));
            }}
          >
            <PlusIcon /> Add feed
          </Button>
        </Flex>
      </Flex>

      <Flex direction="column" gap="2">
        <Text size="1" weight="bold">
          Followed topics
        </Text>
        <Flex align="center" gap="2" wrap="wrap">
          {topics.map((topic) => (
            <Badge key={topic.topic} size="2" color={topic.enabled ? "blue" : "gray"}>
              {topic.topic}
              <Button
                size="1"
                variant="ghost"
                color="red"
                disabled={busy}
                onClick={() => void call("news_unfollow_topic", { topic: topic.topic })}
              >
                <Cross2Icon />
              </Button>
            </Badge>
          ))}
        </Flex>
        <Flex align="center" gap="2">
          <TextField.Root
            size="1"
            placeholder="e.g. AI agents"
            value={newTopic}
            onChange={(event) => setNewTopic(event.target.value)}
            style={{ flex: 1 }}
          />
          <Button
            size="1"
            disabled={busy || newTopic.trim().length === 0}
            onClick={() => {
              void call("news_follow_topic", { topic: newTopic.trim() }).then(() =>
                setNewTopic("")
              );
            }}
          >
            <PlusIcon /> Follow
          </Button>
        </Flex>
      </Flex>

      <Flex direction="column" gap="1">
        <Text size="1" weight="bold">
          Preferences
        </Text>
        <TextField.Root
          size="1"
          placeholder="e.g. more open source, less crypto, terse blurbs"
          value={prefsDraft ?? state.preferencesText ?? ""}
          onChange={(event) => setPrefsDraft(event.target.value)}
        />
        {prefsDraft !== null && prefsDraft !== (state.preferencesText ?? "") ? (
          <Button
            size="1"
            disabled={busy}
            onClick={() => {
              void call("news_set_preferences", { text: prefsDraft }).then(() =>
                setPrefsDraft(null)
              );
            }}
          >
            Save preferences
          </Button>
        ) : null}
      </Flex>
    </Flex>
  );
}
