import { useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionManager,
  type ChatParticipantMetadata,
  type ClientParticipantMetadata,
  type ConnectionConfig,
} from "@workspace/agentic-core";
import type { Participant, PubSubClient } from "@workspace/pubsub";
import { useChannelMessages } from "./useChannelMessages.js";

/**
 * Lazily observe a subagent's own task channel so the parent can render the
 * child's REAL transcript — the same messages, tool pills, and argument/result
 * inspection the child's own panel would show — instead of a bounded summary.
 *
 * Deliberately bounded: a card observes while the user has its transcript open,
 * or while a live run is waiting for its canonical terminal fact. The caller
 * disables observation as soon as that terminal is folded, so retained history
 * owns no long-lived transport and no copied progress feed is needed.
 */

export interface ChildTranscriptConnection {
  /** RPC/protocol config reused from the parent panel's own connection. */
  config: ConnectionConfig;
  metadata: ClientParticipantMetadata;
}

export interface ChildTranscriptResult {
  messages: ReturnType<typeof useChannelMessages>["messages"];
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  selfId: string | null;
  /** True until the child's history has replayed. */
  loading: boolean;
  error: string | null;
}

export function useChildTranscript(options: {
  connection: ChildTranscriptConnection | null;
  channelId: string | null;
  contextId: string | null;
  enabled: boolean;
}): ChildTranscriptResult {
  const { connection, channelId, contextId, enabled } = options;
  const [client, setClient] = useState<PubSubClient<ChatParticipantMetadata> | null>(null);
  const [participants, setParticipants] = useState<
    Record<string, Participant<ChatParticipantMetadata>>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const managerRef = useRef<ConnectionManager | null>(null);

  const active = enabled && Boolean(connection && channelId);

  useEffect(() => {
    if (!active || !connection || !channelId) {
      setClient(null);
      setParticipants({});
      setError(null);
      return;
    }
    let cancelled = false;
    setConnecting(true);
    setError(null);

    // A distinct clientId keeps this observer subscription from colliding with
    // the parent panel's own connection in the transport's client registry.
    const manager = new ConnectionManager({
      config: {
        ...connection.config,
        clientId: `${connection.config.clientId}:observe:${channelId}`,
      },
      metadata: { ...connection.metadata, type: "panel" },
      callbacks: {
        onRoster: (update) => {
          if (!cancelled) setParticipants({ ...update.participants });
        },
        onError: (err) => {
          if (!cancelled) setError(err.message);
        },
      },
    });
    managerRef.current = manager;

    void manager
      .connect({ channelId, methods: {}, ...(contextId ? { contextId } : {}) })
      .then((connected) => {
        if (cancelled) return;
        setClient(connected);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setConnecting(false);
      });

    return () => {
      cancelled = true;
      setClient(null);
      void manager.disconnect().catch(() => {
        /* tearing down an observer connection is best-effort */
      });
      if (managerRef.current === manager) managerRef.current = null;
    };
  }, [active, connection, channelId, contextId]);

  const transcript = useChannelMessages(active ? client : null);

  return useMemo(
    () => ({
      messages: transcript.messages,
      participants,
      selfId: client?.clientId ?? null,
      loading: active && (connecting || !transcript.replaySettled),
      error,
    }),
    [transcript.messages, transcript.replaySettled, participants, client, active, connecting, error]
  );
}
