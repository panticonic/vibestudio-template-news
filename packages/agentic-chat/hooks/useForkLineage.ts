/**
 * useForkLineage — fork/branch state for the ChatHeader switcher, the "Show
 * tree" overlay, the inline fork rows, and the per-message fork affordances.
 *
 * Data sources (all durable / log-derived, never in-memory queues):
 *  - `getProvenance()` on the channel DO (WS-6) — root/fork/task + parent chain.
 *  - the current channel's `ChannelViewState.forks` projection (WS-7), already
 *    surfaced as `contentType: "fork"` rows in `messages` (channel-chat-merge).
 *  - `subscribeLineage()` + the ephemeral `fork.head_changed` signal for live
 *    "has new messages" badges, reconciled from durable heads on open (§H).
 *
 * Fork creation rides the `forkConversation` client helper (channel-fork),
 * which drives the parent channel DO's journaled `fork` saga. Navigation
 * (switch in place / open in new panel / review overlay) is panel-supplied.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcCaller } from "@vibestudio/rpc";
import { forkConversation } from "@workspace/channel-fork";
import type { ChatMessage } from "@workspace/agentic-core";
import type {
  ForkProjection,
  MessageBlockInput,
  ParticipantRef,
} from "@workspace/agentic-protocol";
import type { PubSubClient } from "@workspace/pubsub";
import type {
  ChannelProvenance,
  ChatParticipantMetadata,
  ForkEntry,
  ForkNavHandlers,
  ForkTreeNode,
  ForkUiState,
} from "../types";
import { useChannelSignalMessages } from "./useChannelSignalMessages";

const CHANNEL_SERVICE_PROTOCOL = "vibestudio.channel.v1";

/** Ephemeral lineage-badge signal fanned by the fork-tree root (channel-do). */
const FORK_HEAD_CHANGED_SIGNAL = "fork.head_changed";

/** The narrow RPC surface the lineage hook needs (matches ConnectionConfig.rpc). */
interface ForkRpc {
  call<R = unknown>(targetId: string, method: string, args: unknown[]): Promise<R>;
  selfId: string;
}

interface ResolvedChannelService {
  source: string;
  className: string;
  objectKey: string;
  targetId?: string;
}

export interface UseForkLineageOptions {
  rpc: ForkRpc;
  channelId: string | null;
  contextId?: string;
  selfId: string | null;
  selfMetadata?: { name?: string; type?: string; handle?: string };
  /** Current transcript — the `contentType: "fork"` rows are this channel's
   *  direct-child forks (from `ChannelViewState.forks`). */
  messages: ChatMessage[];
  /** True once initial replay has settled, so `messages` reliably includes
   *  historical fork rows for the open-baseline. */
  replaySettled: boolean;
  /** Live PubSub client — the source of the ephemeral `fork.head_changed`
   *  lineage-badge signals (best-effort; badges degrade without it). */
  client?: PubSubClient<ChatParticipantMetadata> | null;
  /** Panel-supplied navigation + review overlay handlers. */
  nav?: ForkNavHandlers;
}

async function resolveChannelTarget(rpc: ForkRpc, channelId: string): Promise<string> {
  const svc = await rpc.call<ResolvedChannelService>("main", "workers.resolveService", [
    CHANNEL_SERVICE_PROTOCOL,
    channelId,
  ]);
  return svc.targetId ?? `do:${svc.source}:${svc.className}:${svc.objectKey}`;
}

async function readProvenance(rpc: ForkRpc, channelId: string): Promise<ChannelProvenance> {
  const target = await resolveChannelTarget(rpc, channelId);
  return rpc.call<ChannelProvenance>(target, "getProvenance", []);
}

/** Direct-child forks of the current channel, from its projected fork rows. */
function childForksFromMessages(messages: ChatMessage[]): ForkEntry[] {
  return messages
    .filter((m) => m.contentType === "fork" && m.fork)
    .map((m) => {
      const fork = m.fork!;
      return {
        forkId: fork.forkId,
        channelId: fork.forkedChannelId,
        contextId: fork.forkedContextId,
        label: fork.label || fork.reason || "Fork",
        reason: fork.reason,
        actorName: fork.actor.displayName ?? fork.actor.id,
        forkPointId: fork.forkPointId,
        createdAtSeq: fork.createdAtSeq,
        archived: fork.archived,
      };
    });
}

function sameForkEntries(a: ForkEntry[], b: ForkEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      entry.forkId === other.forkId &&
      entry.channelId === other.channelId &&
      entry.contextId === other.contextId &&
      entry.label === other.label &&
      entry.reason === other.reason &&
      entry.actorName === other.actorName &&
      entry.forkPointId === other.forkPointId &&
      entry.createdAtSeq === other.createdAtSeq &&
      entry.archived === other.archived
    );
  });
}

/** Map a durable `ForkProjection` (from `listForks`) onto a switcher entry —
 *  the sibling analogue of `childForksFromMessages`'s per-row mapping. */
function forkProjectionToEntry(fork: ForkProjection): ForkEntry {
  return {
    forkId: fork.forkId,
    channelId: fork.forkedChannelId,
    contextId: fork.forkedContextId,
    label: fork.label || fork.reason || "Fork",
    reason: fork.reason,
    actorName: fork.actor.displayName ?? fork.actor.id,
    forkPointId: fork.forkPointId,
    createdAtSeq: fork.createdAtSeq,
    archived: fork.archived,
  };
}

/** Sibling forks = the PARENT channel's other direct children. Reads the
 *  parent's durable `listForks()` projection and drops our own row. */
async function readSiblings(
  rpc: ForkRpc,
  parentChannelId: string,
  selfChannelId: string
): Promise<ForkEntry[]> {
  const target = await resolveChannelTarget(rpc, parentChannelId);
  const { forks } = await rpc.call<{ forks: ForkProjection[] }>(target, "listForks", []);
  return forks.filter((f) => f.forkedChannelId !== selfChannelId).map(forkProjectionToEntry);
}

function labelForProvenance(prov: ChannelProvenance | undefined): string {
  if (!prov) return "This conversation";
  if (prov.kind === "fork") return "Fork";
  if (prov.kind === "task") return "Subagent task";
  return "Main";
}

export function useForkLineage(options: UseForkLineageOptions): ForkUiState {
  const { rpc, channelId, contextId, selfId, selfMetadata, messages, replaySettled, client, nav } =
    options;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const [provenance, setProvenance] = useState<ChannelProvenance | undefined>(undefined);
  const [siblings, setSiblings] = useState<ForkEntry[]>([]);
  const [forking, setForking] = useState(false);

  // ── Live badge reconcile (§H) ─────────────────────────────────────────────
  // The ephemeral `fork.head_changed` signals fanned to our lineage roster (see
  // `subscribeLineage`) carry `{ channelId, headSeq }` for any descendant whose
  // durable head advanced. We fold them into per-channel live heads; a fork with
  // a live head OR a `createdAtSeq` past our open-baseline badges as "new".
  // (A durable per-fork HEAD read does not exist — `listForks` carries only
  //  `createdAtSeq` — so cross-session reconcile is bounded to this: creation +
  //  in-session live signals. See the WS-8 report.)
  const forkHeadSignals = useChannelSignalMessages(client ?? null, FORK_HEAD_CHANGED_SIGNAL);
  const liveHeads = useMemo(() => {
    const map: Record<string, number> = {};
    for (const sig of forkHeadSignals) {
      try {
        const parsed = JSON.parse(sig.content) as { channelId?: unknown; headSeq?: unknown };
        if (typeof parsed.channelId === "string" && typeof parsed.headSeq === "number") {
          map[parsed.channelId] = Math.max(map[parsed.channelId] ?? 0, parsed.headSeq);
        }
      } catch {
        /* ignore malformed signal */
      }
    }
    return map;
  }, [forkHeadSignals]);
  // Mirror for the imperative `loadTree` walk (reads .current, not reactive).
  const liveHeadsRef = useRef<Record<string, number>>({});
  useEffect(() => {
    liveHeadsRef.current = liveHeads;
  }, [liveHeads]);
  // Open-baseline: the highest fork `createdAtSeq` seen at mount. Forks created
  // afterward (createdAtSeq > baseline) count as unread. Initialize to 0 even
  // when there are no forks yet, so the first fork created after open badges.
  const baselineSeqRef = useRef<number | null>(null);
  const baselineChannelRef = useRef<string | null>(null);
  const isUnread = useCallback(
    (entry: { channelId: string; createdAtSeq: number }): boolean => {
      if (liveHeads[entry.channelId] !== undefined) return true;
      const base = baselineSeqRef.current;
      return base !== null && entry.createdAtSeq > base;
    },
    [liveHeads]
  );

  const baseChildrenCacheRef = useRef<ForkEntry[]>([]);
  const baseChildren = useMemo(() => {
    const next = childForksFromMessages(messages);
    if (sameForkEntries(baseChildrenCacheRef.current, next)) {
      return baseChildrenCacheRef.current;
    }
    baseChildrenCacheRef.current = next;
    return next;
  }, [messages]);
  useEffect(() => {
    if (baselineChannelRef.current !== channelId) {
      baselineChannelRef.current = channelId;
      baselineSeqRef.current = null;
    }
    if (!replaySettled) return;
    if (baselineSeqRef.current === null) {
      baselineSeqRef.current = baseChildren.reduce((max, c) => Math.max(max, c.createdAtSeq), 0);
    }
  }, [baseChildren, channelId, replaySettled]);
  const children = useMemo(
    () => baseChildren.map((c) => ({ ...c, unread: isUnread(c) })),
    [baseChildren, isUnread]
  );
  const decoratedSiblings = useMemo(
    () => siblings.map((s) => ({ ...s, unread: isUnread(s) })),
    [siblings, isUnread]
  );

  // Shell toast for forks the local user didn't initiate, while unfocused (§A5).
  // Seed the seen-set on first run so historical forks never toast on load.
  const seenForkIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const forkRows = messages.filter((m) => m.contentType === "fork" && m.fork);
    if (seenForkIdsRef.current === null) {
      seenForkIdsRef.current = new Set(forkRows.map((m) => m.fork!.forkId));
      return;
    }
    const seen = seenForkIdsRef.current;
    const unfocused = typeof document !== "undefined" && document.visibilityState !== "visible";
    for (const row of forkRows) {
      const fork = row.fork!;
      if (seen.has(fork.forkId)) continue;
      seen.add(fork.forkId);
      const isSelf = selfId !== null && fork.actor.id === selfId;
      if (!isSelf && unfocused) {
        nav?.onExternalFork?.({
          forkedChannelId: fork.forkedChannelId,
          forkedContextId: fork.forkedContextId,
          actorName: fork.actor.displayName ?? fork.actor.id,
          forkPointId: fork.forkPointId,
        });
      }
    }
  }, [messages, selfId, nav]);

  // Enumerate SIBLING forks off the parent channel's `listForks()` projection
  // (only meaningful when we are ourselves a fork). Best-effort: any failure or
  // a non-fork provenance clears siblings, preserving the parent-breadcrumb
  // fallback.
  const loadSiblings = useCallback(
    async (prov: ChannelProvenance | undefined, selfChannelId: string): Promise<void> => {
      if (!prov || prov.kind !== "fork") {
        setSiblings([]);
        return;
      }
      try {
        setSiblings(await readSiblings(rpc, prov.forkedFrom, selfChannelId));
      } catch (err) {
        console.debug("[useForkLineage] listForks(siblings) skipped:", err);
        setSiblings([]);
      }
    },
    [rpc]
  );

  // Learn provenance (root/fork/task + parent) whenever the channel changes.
  useEffect(() => {
    if (!channelId) {
      setProvenance(undefined);
      setSiblings([]);
      return;
    }
    // Channel resolution belongs to the PubSub connection. During workspace
    // adoption that connection can legitimately be waiting on the open review;
    // probing provenance in parallel only repeats the same gated lookup and
    // reports a recoverable readiness state as an unrelated lineage failure.
    // Once the client exists, the service is resolved and provenance can use
    // the normal exact target without racing startup.
    if (!client) return;
    let cancelled = false;
    void (async () => {
      try {
        const prov = await readProvenance(rpc, channelId);
        if (cancelled) return;
        setProvenance(prov);
        await loadSiblings(prov, channelId);
      } catch (err) {
        if (!cancelled) console.warn("[useForkLineage] getProvenance failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, channelId, client, loadSiblings]);

  const lineageSubscriptionChannelId = useMemo(() => {
    if (!channelId || !provenance) return null;
    return provenance.kind === "fork" ? provenance.rootChannelId : channelId;
  }, [channelId, provenance]);

  // Signal-only lineage subscription for live badges. Registers this participant
  // on the lineage root's roster; the root fans `fork.head_changed` down.
  useEffect(() => {
    if (!lineageSubscriptionChannelId || !selfId) return;
    let cancelled = false;
    void (async () => {
      try {
        const target = await resolveChannelTarget(rpc, lineageSubscriptionChannelId);
        if (cancelled) return;
        await rpc.call(target, "subscribeLineage", [selfId, {}]);
      } catch (err) {
        // Best-effort: badges degrade to reconcile-on-open when this fails.
        if (!cancelled) console.debug("[useForkLineage] subscribeLineage skipped:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, lineageSubscriptionChannelId, selfId]);

  const parent = useMemo(() => {
    if (provenance?.kind === "fork") {
      return { channelId: provenance.forkedFrom, contextId: provenance.parentContextId };
    }
    if (provenance?.kind === "task") {
      return { channelId: provenance.parentChannelId, contextId: provenance.parentContextId };
    }
    return undefined;
  }, [provenance]);

  // Reconcile-on-open (switcher/tree open): re-read provenance (cheap, durable)
  // and re-enumerate siblings off the parent's `listForks()` projection so the
  // sibling list + badges reflect the latest durable state.
  const refresh = useCallback(() => {
    if (!channelId) return;
    void (async () => {
      try {
        const prov = await readProvenance(rpc, channelId);
        setProvenance(prov);
        await loadSiblings(prov, channelId);
      } catch {
        /* keep prior state */
      }
    })();
  }, [rpc, channelId, loadSiblings]);

  // Walk provenance up to the root, then attach the current channel's children,
  // for the "Show tree" overlay. Ancestor nodes' own children need a per-node
  // fold (deferred) so the tree shows the lineage spine + live children.
  const loadTree = useCallback(async (): Promise<ForkTreeNode[]> => {
    if (!channelId) return [];
    const chain: Array<{ channelId: string; contextId?: string; prov: ChannelProvenance }> = [];
    let cursor: string | null = channelId;
    let cursorContext: string | undefined = contextId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      let prov: ChannelProvenance;
      try {
        prov = await readProvenance(rpc, cursor);
      } catch {
        prov = { kind: "root" };
      }
      chain.push({ channelId: cursor, contextId: cursorContext, prov });
      if (prov.kind === "fork") {
        cursor = prov.forkedFrom;
        cursorContext = prov.parentContextId;
      } else if (prov.kind === "task") {
        cursor = prov.parentChannelId;
        cursorContext = prov.parentContextId;
      } else {
        cursor = null;
      }
    }
    // Build the spine root→leaf; hang the current channel's live children off it.
    let node: ForkTreeNode | null = null;
    for (const link of chain) {
      const isCurrent = link.channelId === channelId;
      const next: ForkTreeNode = {
        channelId: link.channelId,
        contextId: link.contextId,
        label: labelForProvenance(link.prov),
        provenanceKind: link.prov.kind,
        isCurrent,
        children: isCurrent
          ? children.map((c) => ({
              channelId: c.channelId,
              contextId: c.contextId,
              label: c.label,
              provenanceKind: "fork" as const,
              isCurrent: false,
              children: [],
              unread: liveHeadsRef.current[c.channelId] !== undefined,
            }))
          : [],
      };
      if (node) next.children = [...next.children, node];
      node = next;
    }
    return node ? [node] : [];
  }, [rpc, channelId, contextId, children]);

  // Build the self ParticipantRef for an authored (edit-fork) seed.
  const selfRef = useCallback((): ParticipantRef => {
    const kind = selfMetadata?.type === "agent" ? "agent" : "panel";
    return {
      kind,
      id: selfId ?? rpc.selfId,
      ...(selfMetadata?.name ? { displayName: selfMetadata.name } : {}),
      ...(selfId ? { participantId: selfId } : {}),
    };
  }, [rpc, selfId, selfMetadata?.type, selfMetadata?.name, selfMetadata?.handle]);

  const runFork = useCallback(
    async (opts: {
      forkPointPubsubId: number;
      reason: string;
      label?: string;
      seedText?: string;
      replaces?: { messageId: string; seq: number };
    }): Promise<void> => {
      if (!channelId) return;
      setForking(true);
      try {
        const seed = opts.seedText
          ? {
              author: selfRef(),
              blocks: [
                {
                  blockId: `fork-seed:${channelId}:${opts.forkPointPubsubId}` as never,
                  type: "text" as const,
                  content: opts.seedText,
                },
              ] as MessageBlockInput[],
              ...(opts.replaces ? { replaces: opts.replaces } : {}),
            }
          : undefined;
        const result = await forkConversation(rpc as unknown as RpcCaller, {
          channelId,
          forkPointPubsubId: opts.forkPointPubsubId,
          reason: opts.reason,
          ...(opts.label ? { label: opts.label } : {}),
          ...(seed ? { seed } : {}),
        });
        nav?.switchTo(result.forkedChannelId, result.forkedContextId);
      } catch (err) {
        console.error("[useForkLineage] fork failed:", err);
        throw err;
      } finally {
        setForking(false);
      }
    },
    [rpc, channelId, selfRef, nav]
  );

  const forkFromMessage = useCallback(
    async (msg: ChatMessage): Promise<void> => {
      if (msg.seq === undefined) {
        console.warn("[useForkLineage] cannot fork: message has no seq");
        return;
      }
      await runFork({ forkPointPubsubId: msg.seq, reason: "fork" });
    },
    [runFork]
  );

  const editAndForkMessage = useCallback(
    async (msg: ChatMessage, newText: string): Promise<void> => {
      if (msg.seq === undefined) {
        console.warn("[useForkLineage] cannot edit-fork: message has no seq");
        return;
      }
      // seed the edited turn; `replaces` keeps authorship truthful on agent msgs.
      await runFork({
        forkPointPubsubId: msg.seq - 1,
        reason: "edit",
        seedText: newText,
        replaces: { messageId: msg.id, seq: msg.seq },
      });
    },
    [runFork]
  );

  const newFork = useCallback(async (): Promise<void> => {
    // Fork at the current head: the highest seq we have projected.
    const headSeq = messagesRef.current.reduce(
      (max, m) => (m.seq !== undefined && m.seq > max ? m.seq : max),
      0
    );
    await runFork({ forkPointPubsubId: headSeq, reason: "fork" });
  }, [runFork]);

  const currentLabel = useMemo(() => labelForProvenance(provenance), [provenance]);

  return useMemo<ForkUiState>(
    () => ({
      provenance,
      currentLabel,
      children,
      siblings: decoratedSiblings,
      parent,
      forking,
      refresh,
      loadTree,
      actions: {
        forkFromMessage,
        editAndForkMessage,
        newFork,
        switchTo: nav?.switchTo ?? (() => {}),
        openInNewPanel: nav?.openInNewPanel ?? (() => {}),
      },
    }),
    [
      provenance,
      currentLabel,
      children,
      decoratedSiblings,
      parent,
      forking,
      refresh,
      loadTree,
      forkFromMessage,
      editAndForkMessage,
      newFork,
      nav,
    ]
  );
}
