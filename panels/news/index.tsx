/**
 * News — a reader-first personal briefing app.
 *
 * The durable news agent owns ingestion, curation, briefings, and preferences.
 * This panel is intentionally a projection of that state: it never coordinates
 * background work with local-only flags and never substitutes an empty state
 * for a request that is still loading or has failed.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Dialog,
  Flex,
  Heading,
  IconButton,
  ScrollArea,
  SegmentedControl,
  Select,
  Separator,
  Spinner,
  Text,
  TextField,
  Theme,
} from "@radix-ui/themes";
import {
  ChatBubbleIcon,
  Cross2Icon,
  ExclamationTriangleIcon,
  GearIcon,
  LightningBoltIcon,
  MagnifyingGlassIcon,
  ReloadIcon,
  SpeakerLoudIcon,
} from "@radix-ui/react-icons";
import {
  contextId as runtimeContextId,
  createDurableObjectServiceClient,
  openPanel,
  panel,
  rpc,
  type DurableObjectServiceClient,
} from "@workspace/runtime";
import { recoveryCoordinator } from "@workspace/runtime/internal/diagnostics";
import { usePaletteCommands, usePanelTheme, useStateArgs } from "@workspace/react";
import { useAppTheme } from "@workspace/ui/panel";
import { AgenticChat, ErrorBoundary } from "@workspace/agentic-chat";
import type { ConnectionConfig } from "@workspace/agentic-chat";
import {
  createPanelSandboxConfig,
  launchAgentIntoChannel,
  parseSignalEvent,
  unwrapChatMethodResult,
} from "@workspace/agentic-core";
import { connectViaRpc, type PubSubClient } from "@workspace/pubsub";
import { forkConversation } from "@workspace/channel-fork";
import {
  DEFAULT_AGENT_MODEL_REF,
  MODEL_SETTINGS_SERVICE_PROTOCOL,
  type ModelCatalog,
  type ModelSettingsSnapshot,
} from "@workspace/model-catalog/catalog";
import { toPanelConnectRequest } from "@workspace/model-catalog/providerConnect";
import { findMatchingUrlAudience } from "@vibestudio/credential-client/urlAudience";
import type { UrlAudience } from "@vibestudio/credential-client/urlAudience";
import {
  NEWS_DEEPDIVE_SIGNAL,
  type NewsDeepDiveRequested,
  type NewsSetupCardState,
} from "@workspace/feeds/card-types";
import { NEWS_METHODS } from "@workspace/feeds";
import {
  isNewsReaderDataEvent,
  newsAgentKey,
  newsChannelName,
  requireNewsContextId,
} from "./bootstrap.js";
import {
  NEWS_AGENT_CLASS,
  NEWS_AGENT_HANDLE,
  NEWS_AGENT_SOURCE,
  type NewsStateArgs,
} from "./types.js";
import {
  ArticleCard,
  BriefingHero,
  Markdown,
  Onboarding,
  SettingsContent,
  clusterArticles,
  type ArticleRow,
  type BriefingRow,
} from "./components.js";
import "@workspace/ui/tokens.css";
import "./style.css";

type ReaderTab = "inbox" | "saved" | "briefings";
type InboxView = "all" | "unread";
type RequestStatus = "idle" | "loading" | "ready" | "error";

interface Overview {
  setup: NewsSetupCardState;
  articleCount: number;
  unbriefedCount: number;
  untriagedCount: number;
  lastBriefingId?: string;
}

interface ArticlePage {
  status: RequestStatus;
  articles: ArticleRow[];
  cursor?: string;
  hasMore: boolean;
  error?: string;
}

interface SearchState {
  status: RequestStatus;
  query: string;
  articles: ArticleRow[];
  briefings: BriefingRow[];
  error?: string;
}

interface Notice {
  tone: "red" | "green" | "blue";
  text: string;
}

interface DeepDiveStory {
  articleId: string;
  url: string;
  title: string;
  source?: string;
}

const EMPTY_PAGE: ArticlePage = { status: "idle", articles: [], hasMore: false };
const EMPTY_SEARCH: SearchState = {
  status: "idle",
  query: "",
  articles: [],
  briefings: [],
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertOperationResult(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "string" && error) throw new Error(error);
  }
  return value;
}

function settle(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

function modelHasMatchingCredential(
  baseUrl: string | undefined,
  audiences: UrlAudience[]
): boolean {
  if (!baseUrl?.trim() || /\{[^}]+\}/.test(baseUrl)) return false;
  try {
    return findMatchingUrlAudience(baseUrl, audiences) !== null;
  } catch {
    return false;
  }
}

async function detectMissingModelCredential(
  catalog: ModelCatalog,
  modelRef: string
): Promise<{ providerId: string; baseUrl: string } | null> {
  const entry = catalog.models.find((model) => model.ref === modelRef);
  if (!entry?.connectable) return null;
  try {
    const credentials = await rpc.call<Array<{ audience: UrlAudience[] }>>(
      "main",
      "credentials.listStoredCredentials",
      []
    );
    const audiences = credentials.flatMap((credential) => credential.audience ?? []);
    return modelHasMatchingCredential(entry.baseUrl, audiences)
      ? null
      : { providerId: entry.provider, baseUrl: entry.baseUrl };
  } catch {
    return null;
  }
}

async function ensureAgentSubscribed(input: {
  agentKey: string;
  channelId: string;
  contextId: string;
  config?: Record<string, unknown>;
}): Promise<string> {
  const { subscription } = await launchAgentIntoChannel(rpc, {
    source: NEWS_AGENT_SOURCE,
    className: NEWS_AGENT_CLASS,
    key: input.agentKey,
    channelId: input.channelId,
    contextId: input.contextId,
    config: { handle: NEWS_AGENT_HANDLE, ...(input.config ?? {}) },
    replay: true,
  });
  if (!subscription.participantId) throw new Error("News agent did not join the reader");
  return subscription.participantId;
}

async function callParticipant(
  client: PubSubClient,
  participantId: string,
  method: string,
  args: Record<string, unknown>
): Promise<unknown> {
  await client.ready();
  const result = await client.callMethod(participantId, method, args).result;
  return assertOperationResult(unwrapChatMethodResult(result));
}

function statusCopy(overview: Overview | null, loading: boolean): string {
  if (loading) return "Connecting your reader…";
  if (!overview) return "Reader unavailable";
  if (overview.untriagedCount > 0) {
    return `Organizing ${overview.untriagedCount} new ${overview.untriagedCount === 1 ? "story" : "stories"}`;
  }
  if (overview.setup.lastRunAt) {
    return `Up to date · ${overview.setup.scheduleSummary}`;
  }
  return overview.setup.scheduleSummary;
}

export default function NewsPanel() {
  const theme = usePanelTheme();
  const appTheme = useAppTheme();
  const stateArgs = useStateArgs<NewsStateArgs>();
  const contextId = requireNewsContextId(runtimeContextId);

  const [bootstrapChannel, setBootstrapChannel] = useState<string | null>(null);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [bootstrapStatus, setBootstrapStatus] = useState<RequestStatus>("loading");
  const [bootstrapNonce, setBootstrapNonce] = useState(0);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [briefings, setBriefings] = useState<BriefingRow[]>([]);
  const [inbox, setInbox] = useState<ArticlePage>(EMPTY_PAGE);
  const [saved, setSaved] = useState<ArticlePage>(EMPTY_PAGE);
  const [search, setSearch] = useState<SearchState>(EMPTY_SEARCH);
  const [tab, setTab] = useState<ReaderTab>("inbox");
  const [inboxView, setInboxView] = useState<InboxView>("all");
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [triageError, setTriageError] = useState<string | null>(null);
  const [modelConnect, setModelConnect] = useState<{ providerId: string; baseUrl: string } | null>(
    null
  );
  const [connectingModel, setConnectingModel] = useState(false);

  const channelName = stateArgs.channelName ?? bootstrapChannel;
  const clientRef = useRef<PubSubClient | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const deepDiveRef = useRef<(story: DeepDiveStory) => Promise<void>>(async () => undefined);
  const lastPubsubId = useRef(0);
  const bootstrapAttempted = useRef(false);
  const triageRequested = useRef(false);
  const previousVisit = useRef(
    typeof stateArgs.lastVisitAt === "number" ? stateArgs.lastVisitAt : 0
  );
  const modelService = useRef<DurableObjectServiceClient | null>(null);
  const modelProbe = useRef<{ catalog: ModelCatalog; modelRef: string } | null>(null);

  useEffect(() => {
    void panel.stateArgs.set({ lastVisitAt: Date.now() });
  }, []);

  useEffect(() => {
    if (bootstrapAttempted.current) return;
    bootstrapAttempted.current = true;
    setBootstrapStatus("loading");
    setNotice(null);
    void (async () => {
      try {
        const channel = stateArgs.channelName ?? newsChannelName(contextId);
        const agentKey = stateArgs.agentKey ?? newsAgentKey(contextId);
        if (!stateArgs.channelName || !stateArgs.agentKey) {
          void panel.stateArgs.set({ channelName: channel, agentKey });
        }
        if (!stateArgs.channelName) setBootstrapChannel(channel);

        modelService.current ??= createDurableObjectServiceClient(MODEL_SETTINGS_SERVICE_PROTOCOL);
        let settings: ModelSettingsSnapshot | null = null;
        try {
          settings = await modelService.current.call<ModelSettingsSnapshot>("getSettings");
        } catch (error) {
          console.warn("[News] Could not read model settings", error);
        }
        const model =
          (stateArgs.agentConfig?.["model"] as string | undefined) ??
          settings?.defaultModel ??
          DEFAULT_AGENT_MODEL_REF;
        const nextParticipant = await ensureAgentSubscribed({
          agentKey,
          channelId: channel,
          contextId,
          config: { model, ...(stateArgs.agentConfig ?? {}) },
        });
        setParticipantId(nextParticipant);
        setBootstrapStatus("ready");
        if (settings?.catalog) {
          modelProbe.current = { catalog: settings.catalog, modelRef: model };
          setModelConnect(await detectMissingModelCredential(settings.catalog, model));
        }
      } catch (error) {
        setBootstrapStatus("error");
        setNotice({ tone: "red", text: `News could not start: ${errorMessage(error)}` });
      }
    })();
  }, [bootstrapNonce, contextId, stateArgs.agentConfig, stateArgs.agentKey, stateArgs.channelName]);

  const retryBootstrap = useCallback(() => {
    bootstrapAttempted.current = false;
    setParticipantId(null);
    setBootstrapNonce((value) => value + 1);
  }, []);

  const callAgent = useCallback(
    async (method: string, args: Record<string, unknown>) => {
      const client = clientRef.current;
      if (!client || !participantId) throw new Error("News is still connecting");
      return callParticipant(client, participantId, method, args);
    },
    [participantId]
  );

  const refresh = useCallback(async () => {
    if (!participantId || !channelName) return;
    setInbox((current) =>
      current.status === "idle" ? { ...current, status: "loading" } : current
    );
    try {
      const [nextOverview, articleResult, historyResult] = await Promise.all([
        callAgent(NEWS_METHODS.getOverview, {}) as Promise<Overview>,
        callAgent(NEWS_METHODS.listArticles, { limit: 40, triagedOnly: true }) as Promise<{
          articles: ArticleRow[];
          hasMore?: boolean;
          nextCursor?: string;
        }>,
        callAgent(NEWS_METHODS.getBriefingHistory, { limit: 20 }) as Promise<{
          briefings: BriefingRow[];
        }>,
      ]);
      setOverview(nextOverview);
      setInbox({
        status: "ready",
        articles: articleResult.articles,
        hasMore: Boolean(articleResult.hasMore),
        cursor: articleResult.nextCursor,
      });
      setBriefings(historyResult.briefings);
    } catch (error) {
      const message = errorMessage(error);
      setInbox((current) => ({ ...current, status: "error", error: message }));
      setNotice({ tone: "red", text: `Could not update the reader: ${message}` });
    }

    const probe = modelProbe.current;
    if (probe) {
      try {
        setModelConnect(await detectMissingModelCredential(probe.catalog, probe.modelRef));
      } catch {
        /* keep the last known state */
      }
    }
  }, [callAgent, channelName, participantId]);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!participantId) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [participantId, refresh]);

  useEffect(() => {
    if (!channelName) return;
    const client = connectViaRpc({
      rpc,
      channel: channelName,
      contextId,
      clientId: `${rpc.selfId}:news-reader`,
      name: "News reader",
      type: "panel",
      handle: "news-reader",
      replayMode: "collect",
      replayMessageLimit: 1,
    });
    clientRef.current = client;
    let cancelled = false;
    let refreshTimer: number | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshRef.current();
      }, 500);
    };
    void (async () => {
      try {
        await client.ready();
        for await (const event of client.events({ includeReplay: true, includeSignals: true })) {
          if (cancelled) break;
          if (typeof event.pubsubId === "number") {
            lastPubsubId.current = Math.max(lastPubsubId.current, event.pubsubId);
          }
          if (event.type === "signal") {
            const payload = parseSignalEvent<NewsDeepDiveRequested>(
              event as { content: string; contentType?: string },
              NEWS_DEEPDIVE_SIGNAL
            );
            if (payload) {
              void deepDiveRef.current(payload);
              continue;
            }
          }
          if (isNewsReaderDataEvent(event)) scheduleRefresh();
        }
      } catch (error) {
        if (!cancelled)
          setNotice({ tone: "red", text: `Live updates paused: ${errorMessage(error)}` });
      }
    })();
    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (clientRef.current === client) clientRef.current = null;
      void client.close();
    };
  }, [channelName, contextId]);

  const perform = useCallback(
    async (method: string, args: Record<string, unknown>) => {
      setActiveAction(method);
      setNotice(null);
      try {
        const result = await callAgent(method, args);
        await refresh();
        return result;
      } catch (error) {
        const message = errorMessage(error);
        setNotice({ tone: "red", text: message });
        throw error;
      } finally {
        setActiveAction(null);
      }
    },
    [callAgent, refresh]
  );

  useEffect(() => {
    const pending = overview?.untriagedCount ?? 0;
    if (pending === 0) {
      triageRequested.current = false;
      setTriageError(null);
      return;
    }
    if (triageRequested.current || !participantId) return;
    triageRequested.current = true;
    void callAgent(NEWS_METHODS.triageNow, {}).catch((error) => {
      triageRequested.current = false;
      setTriageError(errorMessage(error));
    });
  }, [callAgent, overview?.untriagedCount, participantId]);

  useEffect(() => {
    if (tab !== "saved" || !participantId) return;
    let cancelled = false;
    setSaved({ ...EMPTY_PAGE, status: "loading" });
    void (
      callAgent(NEWS_METHODS.listArticles, { savedOnly: true, limit: 40 }) as Promise<{
        articles: ArticleRow[];
        hasMore?: boolean;
        nextCursor?: string;
      }>
    ).then(
      (result) => {
        if (!cancelled)
          setSaved({
            status: "ready",
            articles: result.articles,
            hasMore: Boolean(result.hasMore),
            cursor: result.nextCursor,
          });
      },
      (error) => {
        if (!cancelled)
          setSaved({ status: "error", articles: [], hasMore: false, error: errorMessage(error) });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [callAgent, participantId, tab]);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized || !participantId) {
      setSearch(EMPTY_SEARCH);
      return;
    }
    let cancelled = false;
    setSearch({ status: "loading", query: normalized, articles: [], briefings: [] });
    const timer = window.setTimeout(() => {
      void (
        callAgent(NEWS_METHODS.searchArchive, { query: normalized, limit: 60 }) as Promise<{
          query: string;
          articles: ArticleRow[];
          briefings: BriefingRow[];
        }>
      ).then(
        (result) => {
          if (!cancelled && result.query === normalized) {
            setSearch({
              status: "ready",
              query: normalized,
              articles: result.articles,
              briefings: result.briefings,
            });
          }
        },
        (error) => {
          if (!cancelled)
            setSearch({
              status: "error",
              query: normalized,
              articles: [],
              briefings: [],
              error: errorMessage(error),
            });
        }
      );
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [callAgent, participantId, query]);

  const patchArticle = useCallback((articleId: string, patch: Partial<ArticleRow>) => {
    const apply = (articles: ArticleRow[]) =>
      articles.map((item) => (item.articleId === articleId ? { ...item, ...patch } : item));
    setInbox((current) => ({ ...current, articles: apply(current.articles) }));
    setSaved((current) => ({ ...current, articles: apply(current.articles) }));
    setSearch((current) => ({ ...current, articles: apply(current.articles) }));
  }, []);

  const markRead = useCallback(
    (article: ArticleRow) => {
      if (article.read) return;
      patchArticle(article.articleId, { read: true });
      void callAgent(NEWS_METHODS.markRead, { articleIds: [article.articleId] }).catch((error) => {
        patchArticle(article.articleId, { read: false });
        setNotice({ tone: "red", text: `Could not mark this story read: ${errorMessage(error)}` });
      });
    },
    [callAgent, patchArticle]
  );

  const setSavedState = useCallback(
    (article: ArticleRow, nextSaved: boolean) => {
      patchArticle(article.articleId, { saved: nextSaved });
      if (!nextSaved)
        setSaved((current) => ({
          ...current,
          articles: current.articles.filter((item) => item.articleId !== article.articleId),
        }));
      void callAgent(NEWS_METHODS.setSaved, {
        articleId: article.articleId,
        saved: nextSaved,
      }).catch((error) => {
        patchArticle(article.articleId, { saved: !nextSaved });
        void refresh();
        setNotice({ tone: "red", text: `Could not update Saved: ${errorMessage(error)}` });
      });
    },
    [callAgent, patchArticle, refresh]
  );

  const react = useCallback(
    (article: ArticleRow, reaction: "more" | "less" | "mute_source") => {
      if (reaction !== "more") patchArticle(article.articleId, { read: true });
      void callAgent(NEWS_METHODS.reactToStory, { articleId: article.articleId, reaction }).then(
        (result) => {
          const muted =
            result && typeof result === "object"
              ? (result as { muted?: string; feedDisabled?: boolean })
              : null;
          setNotice({
            tone: "blue",
            text:
              reaction === "more"
                ? "Got it — your future briefings will lean this way."
                : reaction === "less"
                  ? "Got it — you’ll see fewer stories like this."
                  : muted?.feedDisabled
                    ? `${muted.muted ?? article.source} is paused. You can restore it in Sources.`
                    : `You’ll see less from ${article.source}.`,
          });
          void refresh();
        },
        (error) => {
          if (reaction !== "more") patchArticle(article.articleId, { read: article.read });
          setNotice({ tone: "red", text: errorMessage(error) });
        }
      );
    },
    [callAgent, patchArticle, refresh]
  );

  const deepDive = useCallback(
    async (story: DeepDiveStory) => {
      if (!channelName) return;
      setActiveAction("deep-dive");
      setNotice({ tone: "blue", text: "Preparing a focused research thread…" });
      try {
        const fork = await forkConversation(rpc, {
          channelId: channelName,
          forkPointPubsubId: lastPubsubId.current,
          reason: "deep-dive",
        });
        const agent = fork.clonedAgents.find(
          (candidate) => candidate.className === NEWS_AGENT_CLASS
        );
        if (!agent) throw new Error("The News analyst was not present in the fork");
        const forkClient = connectViaRpc({
          rpc,
          channel: fork.forkedChannelId,
          contextId: fork.forkedContextId,
          clientId: `${rpc.selfId}:news-deep-dive:${fork.forkId}`,
          name: "News reader",
          type: "panel",
          handle: "news-reader",
          replayMode: "skip",
        });
        try {
          const started = (await callParticipant(
            forkClient,
            agent.participantId,
            NEWS_METHODS.startDeepDive,
            {
              articleId: story.articleId,
              url: story.url,
              title: story.title,
              source: story.source,
              briefingTldr: briefings.find((item) => item.status === "ready" && item.tldr)?.tldr,
            }
          )) as { ok?: boolean; error?: string };
          if (!started.ok) throw new Error(started.error ?? "The analyst could not start");
        } finally {
          await forkClient.close();
        }
        await openPanel("panels/chat", {
          title: `Explore: ${story.title.slice(0, 48)}`,
          focus: true,
          contextId: fork.forkedContextId,
          stateArgs: {
            channelName: fork.forkedChannelId,
            installedAgents: [
              {
                agentId: agent.className,
                handle: NEWS_AGENT_HANDLE,
                key: agent.objectKey,
                source: agent.source,
                className: agent.className,
              },
            ],
          },
        });
        const article = [...inbox.articles, ...saved.articles, ...search.articles].find(
          (item) => item.articleId === story.articleId
        );
        if (article) markRead(article);
        setNotice(null);
      } catch (error) {
        setNotice({
          tone: "red",
          text: `Could not open the research thread: ${errorMessage(error)}`,
        });
      } finally {
        setActiveAction(null);
      }
    },
    [briefings, channelName, inbox.articles, markRead, saved.articles, search.articles]
  );
  deepDiveRef.current = deepDive;

  const handleConnectModel = useCallback(async () => {
    if (!modelConnect) return;
    setConnectingModel(true);
    try {
      const request = toPanelConnectRequest(modelConnect.providerId);
      if (!request)
        throw new Error(`No connection flow is available for ${modelConnect.providerId}`);
      await rpc.call("main", "credentials.connect", [request]);
      setModelConnect(null);
      setNotice({ tone: "green", text: `${modelConnect.providerId} is connected.` });
    } catch (error) {
      setNotice({ tone: "red", text: `Could not connect the model: ${errorMessage(error)}` });
    } finally {
      setConnectingModel(false);
    }
  }, [modelConnect]);

  const loadMore = useCallback(async () => {
    const target = tab === "saved" ? saved : inbox;
    if (!target.cursor || !target.hasMore || activeAction) return;
    setActiveAction("load-more");
    try {
      const result = (await callAgent(NEWS_METHODS.listArticles, {
        limit: 40,
        cursor: target.cursor,
        ...(tab === "saved" ? { savedOnly: true } : { triagedOnly: true }),
      })) as { articles: ArticleRow[]; hasMore?: boolean; nextCursor?: string };
      const update = (current: ArticlePage): ArticlePage => ({
        status: "ready",
        articles: [...current.articles, ...result.articles],
        hasMore: Boolean(result.hasMore),
        cursor: result.nextCursor,
      });
      if (tab === "saved") setSaved(update);
      else setInbox(update);
    } catch (error) {
      setNotice({ tone: "red", text: `Could not load older stories: ${errorMessage(error)}` });
    } finally {
      setActiveAction(null);
    }
  }, [activeAction, callAgent, inbox, saved, tab]);

  const searching = query.trim().length > 0;
  const activePage = tab === "saved" ? saved : inbox;
  const baseArticles = searching
    ? search.status === "ready" && search.query === query.trim()
      ? search.articles
      : []
    : tab === "saved"
      ? saved.articles
      : inbox.articles.filter((article) => inboxView === "all" || !article.read);
  const visibleArticles = source
    ? baseArticles.filter((article) => article.source === source)
    : baseArticles;
  const sources = [
    ...new Set([...inbox.articles, ...saved.articles].map((article) => article.source)),
  ].sort();
  const clusters = useMemo(() => clusterArticles(visibleArticles), [visibleArticles]);
  const grouped = useMemo(() => {
    const result: Array<{
      cluster: ReturnType<typeof clusterArticles>[number];
      category: string;
      starts: boolean;
    }> = [];
    const groups = new Map<string, ReturnType<typeof clusterArticles>>();
    for (const cluster of clusters) {
      const category = cluster.primary.category?.trim() || "Latest";
      const items = groups.get(category) ?? [];
      items.push(cluster);
      groups.set(category, items);
    }
    for (const [category, items] of groups)
      items.forEach((cluster, index) => result.push({ cluster, category, starts: index === 0 }));
    return result;
  }, [clusters]);

  useEffect(() => setSelectedIndex(0), [inboxView, query, source, tab]);
  useEffect(
    () => setSelectedIndex((index) => Math.min(index, Math.max(0, grouped.length - 1))),
    [grouped.length]
  );

  const handleReaderKeyDown = (event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    if (
      target.closest(
        "input, textarea, select, button, a, [role='dialog'], [contenteditable='true']"
      )
    )
      return;
    const current = grouped[selectedIndex]?.cluster.primary;
    if (!current) return;
    if (event.key === "j") setSelectedIndex((value) => Math.min(value + 1, grouped.length - 1));
    else if (event.key === "k") setSelectedIndex((value) => Math.max(value - 1, 0));
    else if (event.key === "o") {
      window.open(current.url, "_blank", "noopener");
      markRead(current);
    } else if (event.key === "s") setSavedState(current, !current.saved);
    else if (event.key === "m") markRead(current);
    else if (event.key === "d") void deepDive(current);
    else return;
    event.preventDefault();
  };

  const latestReady = briefings.find((item) => item.status === "ready" && item.tldr);
  const currentBriefing = briefings[0];
  const latestPending =
    currentBriefing?.status === "collecting" || currentBriefing?.status === "summarizing"
      ? currentBriefing
      : undefined;
  const heroBriefing =
    currentBriefing?.status === "ready" || currentBriefing?.status === "error"
      ? currentBriefing
      : latestReady;
  const hasSources = Boolean(
    overview && (overview.setup.feeds.length > 0 || overview.setup.followedTopics.length > 0)
  );
  const modelProven = Boolean(latestReady || overview?.lastBriefingId);
  const showModelConnect = Boolean(modelConnect) && !modelProven;

  const config: ConnectionConfig = useMemo(
    () => ({ clientId: rpc.selfId, rpc, recoveryCoordinator }),
    []
  );
  const sandbox = useMemo(() => createPanelSandboxConfig(rpc), []);
  const installedAgents = useMemo(
    () => [{ agentId: NEWS_AGENT_CLASS, handle: NEWS_AGENT_HANDLE }],
    []
  );

  const paletteCommands = useMemo(
    () => [
      { id: "news-update", label: "Update sources", section: "News" },
      { id: "news-brief", label: "Create briefing", section: "News" },
      { id: "news-saved", label: "Open Saved", section: "News" },
      { id: "news-assistant", label: "Open News assistant", section: "News" },
    ],
    []
  );
  usePaletteCommands(paletteCommands, (id) => {
    if (id === "news-update") settle(perform(NEWS_METHODS.refreshNow, {}));
    else if (id === "news-brief") settle(perform(NEWS_METHODS.refreshNow, { briefing: true }));
    else if (id === "news-saved") setTab("saved");
    else if (id === "news-assistant") setAssistantOpen(true);
  });

  if (!channelName) {
    return (
      <ErrorBoundary>
        <Theme appearance={theme} {...appTheme}>
          <Flex align="center" justify="center" gap="2" style={{ height: "100dvh" }}>
            <Spinner />
            <Text size="2" color="gray">
              Opening your reader…
            </Text>
          </Flex>
        </Theme>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <Theme appearance={theme} {...appTheme}>
        <Box className="news-app">
          <Flex className="news-shell">
            <Flex
              className="news-reader"
              direction="column"
              onKeyDown={handleReaderKeyDown}
              tabIndex={-1}
            >
              <header className="news-header">
                <Flex className="news-header-inner news-toolbar" align="center" gap="3" wrap="wrap">
                  <Box className="news-brand-mark">
                    <SpeakerLoudIcon width="19" height="19" />
                  </Box>
                  <Box style={{ minWidth: 0 }}>
                    <Heading size="4">News</Heading>
                    <Flex align="center" gap="1">
                      {(overview?.untriagedCount ?? 0) > 0 ? <Spinner size="1" /> : null}
                      <Text size="1" color="gray" truncate>
                        {statusCopy(overview, bootstrapStatus === "loading")}
                      </Text>
                    </Flex>
                  </Box>
                  <Box flexGrow="1" />
                  <TextField.Root
                    className="news-search"
                    size="2"
                    placeholder="Search your news"
                    aria-label="Search your news"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  >
                    <TextField.Slot>
                      <MagnifyingGlassIcon />
                    </TextField.Slot>
                    {query ? (
                      <TextField.Slot side="right">
                        <IconButton
                          size="1"
                          variant="ghost"
                          aria-label="Clear search"
                          onClick={() => setQuery("")}
                        >
                          <Cross2Icon />
                        </IconButton>
                      </TextField.Slot>
                    ) : null}
                  </TextField.Root>
                  <Flex className="news-header-actions" gap="2">
                    <Button
                      size="2"
                      variant="soft"
                      disabled={Boolean(activeAction) || !participantId}
                      onClick={() => settle(perform(NEWS_METHODS.refreshNow, {}))}
                    >
                      {activeAction === NEWS_METHODS.refreshNow ? <Spinner /> : <ReloadIcon />}
                      <span className="news-action-label">Update</span>
                    </Button>
                    <Button
                      size="2"
                      disabled={Boolean(activeAction) || !participantId}
                      onClick={() => settle(perform(NEWS_METHODS.refreshNow, { briefing: true }))}
                    >
                      <LightningBoltIcon />
                      <span className="news-action-label">Brief me</span>
                    </Button>
                    <IconButton
                      size="2"
                      variant="soft"
                      aria-label="Sources and preferences"
                      disabled={!overview}
                      onClick={() => setSettingsOpen(true)}
                    >
                      <GearIcon />
                    </IconButton>
                    <IconButton
                      size="2"
                      variant={assistantOpen ? "solid" : "soft"}
                      aria-label={assistantOpen ? "Close News assistant" : "Open News assistant"}
                      onClick={() => setAssistantOpen((value) => !value)}
                    >
                      <ChatBubbleIcon />
                    </IconButton>
                  </Flex>
                </Flex>
              </header>

              <ScrollArea style={{ flex: 1 }}>
                <main className="news-content">
                  <Flex direction="column" gap="4">
                    {notice ? (
                      <Callout.Root
                        size="1"
                        color={notice.tone}
                        role={notice.tone === "red" ? "alert" : "status"}
                      >
                        <Callout.Text>
                          <Flex align="center" gap="2">
                            <Text size="2">{notice.text}</Text>
                            <Box flexGrow="1" />
                            <IconButton
                              size="1"
                              variant="ghost"
                              aria-label="Dismiss message"
                              onClick={() => setNotice(null)}
                            >
                              <Cross2Icon />
                            </IconButton>
                          </Flex>
                        </Callout.Text>
                      </Callout.Root>
                    ) : null}
                    {bootstrapStatus === "error" ? (
                      <Button size="1" variant="soft" color="red" onClick={retryBootstrap}>
                        Retry startup
                      </Button>
                    ) : null}
                    {showModelConnect && modelConnect ? (
                      <Callout.Root color="amber" size="1">
                        <Callout.Icon>
                          <ExclamationTriangleIcon />
                        </Callout.Icon>
                        <Callout.Text>
                          <Flex align="center" gap="3" wrap="wrap">
                            <Text size="2">
                              Connect {modelConnect.providerId} to create briefings and explore
                              stories.
                            </Text>
                            <Button
                              size="1"
                              disabled={connectingModel}
                              onClick={() => void handleConnectModel()}
                            >
                              {connectingModel ? <Spinner /> : null} Connect
                            </Button>
                          </Flex>
                        </Callout.Text>
                      </Callout.Root>
                    ) : null}
                    {triageError ? (
                      <Callout.Root color="red" size="1">
                        <Callout.Text>
                          <Flex align="center" gap="2" wrap="wrap">
                            <Text size="2">Organizing paused: {triageError}</Text>
                            <Button
                              size="1"
                              variant="soft"
                              onClick={() => {
                                triageRequested.current = true;
                                setTriageError(null);
                                void callAgent(NEWS_METHODS.triageNow, {}).catch((error) => {
                                  triageRequested.current = false;
                                  setTriageError(errorMessage(error));
                                });
                              }}
                            >
                              Retry
                            </Button>
                          </Flex>
                        </Callout.Text>
                      </Callout.Root>
                    ) : null}

                    {overview && hasSources ? (
                      <BriefingHero
                        briefing={heroBriefing}
                        pending={latestPending}
                        busy={Boolean(activeAction)}
                        onCreate={() =>
                          settle(perform(NEWS_METHODS.refreshNow, { briefing: true }))
                        }
                      />
                    ) : null}

                    {overview && !hasSources ? (
                      <Onboarding action={perform} activeAction={activeAction} />
                    ) : null}

                    <Flex className="news-tabs" align="center" gap="2" wrap="wrap">
                      <SegmentedControl.Root
                        value={tab}
                        onValueChange={(value) => setTab(value as ReaderTab)}
                      >
                        <SegmentedControl.Item value="inbox">Inbox</SegmentedControl.Item>
                        <SegmentedControl.Item value="saved">Saved</SegmentedControl.Item>
                        <SegmentedControl.Item value="briefings">Briefings</SegmentedControl.Item>
                      </SegmentedControl.Root>
                      {tab === "inbox" ? (
                        <SegmentedControl.Root
                          size="1"
                          value={inboxView}
                          onValueChange={(value) => setInboxView(value as InboxView)}
                        >
                          <SegmentedControl.Item value="all">All</SegmentedControl.Item>
                          <SegmentedControl.Item value="unread">Unread</SegmentedControl.Item>
                        </SegmentedControl.Root>
                      ) : null}
                      <Box flexGrow="1" />
                      {tab !== "briefings" && sources.length > 1 ? (
                        <Select.Root
                          value={source || "__all"}
                          onValueChange={(value) => setSource(value === "__all" ? "" : value)}
                        >
                          <Select.Trigger variant="soft" aria-label="Filter by source" />
                          <Select.Content>
                            <Select.Item value="__all">All sources</Select.Item>
                            {sources.map((item) => (
                              <Select.Item key={item} value={item}>
                                {item}
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Root>
                      ) : null}
                      {tab === "inbox" && inbox.articles.some((article) => !article.read) ? (
                        <Button
                          size="1"
                          variant="ghost"
                          disabled={Boolean(activeAction)}
                          onClick={() => settle(perform(NEWS_METHODS.markAllRead, {}))}
                        >
                          Mark all read
                        </Button>
                      ) : null}
                    </Flex>

                    {tab === "briefings" ? (
                      <Flex direction="column" gap="4">
                        {briefings.length === 0 ? (
                          <EmptyState
                            title="No briefings yet"
                            detail="Create one when you want a concise view across all your sources."
                          />
                        ) : null}
                        {briefings.map((briefing) => (
                          <Box key={briefing.briefingId}>
                            <Flex align="center" gap="2" mb="2" wrap="wrap">
                              <Badge
                                color={
                                  briefing.status === "ready"
                                    ? "blue"
                                    : briefing.status === "error"
                                      ? "red"
                                      : "gray"
                                }
                              >
                                {briefing.status}
                              </Badge>
                              <Text size="1" color="gray">
                                {new Date(briefing.createdAt).toLocaleString()}
                              </Text>
                              {briefing.sourcesRead ? (
                                <Text size="1" color="gray">
                                  · {briefing.sourcesRead} sources read
                                </Text>
                              ) : null}
                            </Flex>
                            {briefing.tldr ? (
                              <Markdown>{briefing.tldr}</Markdown>
                            ) : (
                              <Text size="2" color={briefing.status === "error" ? "red" : "gray"}>
                                {briefing.lastError ?? "This briefing is still being prepared."}
                              </Text>
                            )}
                            <Separator size="4" mt="4" />
                          </Box>
                        ))}
                      </Flex>
                    ) : searching ? (
                      search.status === "loading" ? (
                        <LoadingState label={`Searching for “${query.trim()}”…`} />
                      ) : search.status === "error" ? (
                        <EmptyState title="Search failed" detail={search.error ?? "Try again."} />
                      ) : search.status === "ready" &&
                        search.articles.length === 0 &&
                        search.briefings.length === 0 ? (
                        <EmptyState
                          title="No matches"
                          detail="Try a broader term or another source name."
                        />
                      ) : (
                        <>
                          {search.briefings.length > 0 ? (
                            <Flex direction="column" gap="3">
                              <Text
                                className="news-section-label"
                                size="1"
                                weight="bold"
                                color="gray"
                              >
                                Briefings
                              </Text>
                              {search.briefings.map((briefing) => (
                                <Box key={briefing.briefingId}>
                                  {briefing.tldr ? <Markdown>{briefing.tldr}</Markdown> : null}
                                </Box>
                              ))}
                              <Separator size="4" />
                            </Flex>
                          ) : null}
                          <ArticleList
                            rows={grouped}
                            selectedIndex={selectedIndex}
                            busy={Boolean(activeAction)}
                            previousVisit={previousVisit.current}
                            onOpen={markRead}
                            onSave={setSavedState}
                            onDeepDive={deepDive}
                            onRead={markRead}
                            onReact={react}
                          />
                        </>
                      )
                    ) : activePage.status === "loading" ? (
                      <LoadingState
                        label={tab === "saved" ? "Loading Saved…" : "Loading your reader…"}
                      />
                    ) : activePage.status === "error" ? (
                      <EmptyState
                        title={
                          tab === "saved" ? "Saved could not load" : "The reader could not load"
                        }
                        detail={activePage.error ?? "Try updating again."}
                      />
                    ) : grouped.length === 0 ? (
                      <EmptyState
                        title={
                          tab === "saved"
                            ? "Nothing saved yet"
                            : inboxView === "unread"
                              ? "You’re all caught up"
                              : source
                                ? `No stories from ${source}`
                                : hasSources
                                  ? "Nothing new yet"
                                  : "Your inbox is ready"
                        }
                        detail={
                          tab === "saved"
                            ? "Save a story from Inbox and it will stay here."
                            : inboxView === "unread"
                              ? "New stories will appear here as they arrive."
                              : hasSources
                                ? "Update sources now or come back after the next check."
                                : "Add a source above to begin."
                        }
                      />
                    ) : (
                      <ArticleList
                        rows={grouped}
                        selectedIndex={selectedIndex}
                        busy={Boolean(activeAction)}
                        previousVisit={previousVisit.current}
                        onOpen={markRead}
                        onSave={setSavedState}
                        onDeepDive={deepDive}
                        onRead={markRead}
                        onReact={react}
                      />
                    )}

                    {!searching && tab !== "briefings" && activePage.hasMore ? (
                      <Button
                        size="2"
                        variant="soft"
                        disabled={Boolean(activeAction)}
                        onClick={() => void loadMore()}
                        style={{ alignSelf: "center" }}
                      >
                        {activeAction === "load-more" ? <Spinner /> : null} Load older stories
                      </Button>
                    ) : null}
                  </Flex>
                </main>
              </ScrollArea>
            </Flex>

            {assistantOpen ? (
              <Flex className="news-assistant" direction="column">
                <Flex align="center" gap="2" p="2">
                  <ChatBubbleIcon />
                  <Text size="2" weight="medium">
                    News assistant
                  </Text>
                  <Box flexGrow="1" />
                  <IconButton
                    size="1"
                    variant="ghost"
                    aria-label="Close News assistant"
                    onClick={() => setAssistantOpen(false)}
                  >
                    <Cross2Icon />
                  </IconButton>
                </Flex>
                <Separator size="4" />
                <Box style={{ flex: 1, minHeight: 0 }}>
                  <AgenticChat
                    config={config}
                    channelName={channelName}
                    contextId={contextId}
                    theme={theme}
                    heightMode="container"
                    installedAgents={installedAgents}
                    sandbox={sandbox}
                  />
                </Box>
              </Flex>
            ) : null}
          </Flex>

          <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
            <Dialog.Content maxWidth="940px" style={{ maxHeight: "88dvh", overflow: "auto" }}>
              <Dialog.Title>Sources & preferences</Dialog.Title>
              <Dialog.Description size="2" color="gray" mb="5">
                Shape what News gathers and how it briefs you.
              </Dialog.Description>
              {overview ? (
                <SettingsContent
                  setup={overview.setup}
                  action={perform}
                  activeAction={activeAction}
                />
              ) : (
                <LoadingState label="Loading settings…" />
              )}
              <Flex justify="end" mt="5">
                <Dialog.Close>
                  <Button variant="soft">Done</Button>
                </Dialog.Close>
              </Flex>
            </Dialog.Content>
          </Dialog.Root>
        </Box>
      </Theme>
    </ErrorBoundary>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <Flex className="news-empty" direction="column" gap="2">
      <Spinner />
      <Text size="2" color="gray">
        {label}
      </Text>
    </Flex>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <Box className="news-empty">
      <Flex direction="column" gap="2" align="center" style={{ maxWidth: 420 }}>
        <Heading size="4">{title}</Heading>
        <Text size="2" color="gray">
          {detail}
        </Text>
      </Flex>
    </Box>
  );
}

function ArticleList({
  rows,
  selectedIndex,
  busy,
  previousVisit,
  onOpen,
  onSave,
  onDeepDive,
  onRead,
  onReact,
}: {
  rows: Array<{
    cluster: ReturnType<typeof clusterArticles>[number];
    category: string;
    starts: boolean;
  }>;
  selectedIndex: number;
  busy: boolean;
  previousVisit: number;
  onOpen: (article: ArticleRow) => void;
  onSave: (article: ArticleRow, saved: boolean) => void;
  onDeepDive: (article: ArticleRow) => Promise<void>;
  onRead: (article: ArticleRow) => void;
  onReact: (article: ArticleRow, reaction: "more" | "less" | "mute_source") => void;
}) {
  return (
    <Flex direction="column">
      {rows.map(({ cluster, category, starts }, index) => {
        const article = cluster.primary;
        const fresh =
          previousVisit > 0 &&
          typeof article.fetchedAt === "number" &&
          article.fetchedAt > previousVisit;
        return (
          <Fragment key={article.articleId}>
            {starts ? (
              <Text
                className="news-section-label"
                size="1"
                weight="bold"
                color="gray"
                mt={index > 0 ? "5" : "2"}
                mb="1"
              >
                {category}
              </Text>
            ) : null}
            <ArticleCard
              article={article}
              others={cluster.others}
              selected={index === selectedIndex}
              fresh={fresh}
              disabled={busy}
              onOpen={() => onOpen(article)}
              onSave={(saved) => onSave(article, saved)}
              onDeepDive={() => void onDeepDive(article)}
              onRead={() => onRead(article)}
              onReact={(reaction) => onReact(article, reaction)}
            />
          </Fragment>
        );
      })}
    </Flex>
  );
}
