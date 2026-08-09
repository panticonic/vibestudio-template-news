import type { ChannelConfig } from "@workspace/pubsub";
import { Theme } from "@radix-ui/themes";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { ChatLayout } from "./ChatLayout";
import { ChatPaletteCommands } from "./ChatPaletteCommands";
import { ChatProvider } from "../context/ChatProvider";
import { useAgenticChat } from "../hooks/useAgenticChat";
import type {
  ChatParticipantMetadata,
  ConnectionConfig,
  AgenticChatActions,
  ToolProvider,
  SandboxConfig,
  ForkNavHandlers,
  ChatSandboxValue,
} from "../types";
import { scheduleChatCapabilityWarmup } from "../utils/chatCapabilityWarmup";

export interface AgenticChatHandle {
  /**
   * Publish through the chat component's existing channel participant. The
   * promise waits for that participant to be connected first.
   */
  send(content: string, options?: Parameters<ChatSandboxValue["send"]>[1]): Promise<unknown>;
}

export interface AgenticChatProps {
  /** Connection configuration (server URL, token, client ID) */
  config: ConnectionConfig;
  /** Channel name to connect to */
  channelName: string;
  /** Channel configuration */
  channelConfig?: ChannelConfig;
  /** Context ID for channel authorization */
  contextId?: string;
  /** Participant metadata */
  metadata?: ChatParticipantMetadata;
  /** Tool provider factory */
  tools?: ToolProvider;
  /** Platform-specific actions */
  actions?: AgenticChatActions;
  /** Theme */
  theme?: "light" | "dark";
  /** Whether this chat owns the viewport or fills an embedding container. */
  heightMode?: "viewport" | "container";
  /** Agents installed for this channel; shown as pending until they join the roster */
  installedAgents?: Array<{ agentId: string; handle: string }>;
  /** If set, automatically sent as the first user message once connected */
  initialPrompt?: string;
  /** Send initialPrompt even if the channel already has history (idempotent). */
  forceInitialPrompt?: boolean;
  /** Panel-supplied fork navigation + review overlay handlers (fork switcher,
   *  inline fork rows, subagent review). Omit to disable the fork UI. */
  forkNav?: ForkNavHandlers;
  /** Sandbox config — provides RPC and import loading */
  sandbox: SandboxConfig;
  /** Context-relative TSX file to load into the panel-local action bar on mount */
  initialActionBarFile?: string;
  /** Props for initialActionBarFile */
  initialActionBarProps?: Record<string, unknown>;
  /** Preferred max height for initialActionBarFile */
  initialActionBarMaxHeight?: number;
  /** Persist action-bar file changes into the hosting panel state, if supported */
  onActionBarFileChange?: (value: {
    path: string | null;
    props?: Record<string, unknown>;
    maxHeight?: number;
  }) => void | Promise<void>;
  /** Host approval changes can unblock the initial channel connection. */
  connectionRetrySignal?: number;
}

/**
 * High-level drop-in agentic chat component.
 *
 * Composes useAgenticChat() → ErrorBoundary → ChatProvider → ChatLayout.
 *
 * For custom layouts, use useAgenticChat() + ChatProvider + individual components directly.
 */
export const AgenticChat = forwardRef<AgenticChatHandle, AgenticChatProps>(function AgenticChat(
  {
    config,
    channelName,
    channelConfig,
    contextId,
    metadata,
    tools,
    actions,
    theme,
    heightMode = "viewport",
    installedAgents: installedAgentInfos,
    initialPrompt,
    forceInitialPrompt,
    forkNav,
    sandbox,
    initialActionBarFile,
    initialActionBarProps,
    initialActionBarMaxHeight,
    onActionBarFileChange,
    connectionRetrySignal,
  },
  ref
) {
  const { contextValue, inputContextValue } = useAgenticChat({
    config,
    channelName,
    channelConfig,
    contextId,
    metadata,
    tools,
    actions,
    theme,
    installedAgentInfos,
    initialPrompt,
    forceInitialPrompt,
    forkNav,
    sandbox,
    initialActionBarFile,
    initialActionBarProps,
    initialActionBarMaxHeight,
    onActionBarFileChange,
    connectionRetrySignal,
  });
  useEffect(() => scheduleChatCapabilityWarmup(), []);
  useImperativeHandle(
    ref,
    () => ({
      async send(content, options) {
        const client = contextValue.clientRef.current;
        if (!client) throw new Error("Agentic chat is not connected");
        await client.ready();
        return contextValue.chat.send(content, options);
      },
    }),
    [contextValue.chat, contextValue.clientRef]
  );

  return (
    <ErrorBoundary surfaceName="chat panel">
      {/* Theme is applied here (above ChatProvider) rather than in ChatLayout
          so that ChatLayout does NOT read from context. This prevents
          keystroke-driven context updates from re-rendering ChatLayout and
          causing layout shifts that break autoscroll.

          Appearance flows from the explicitly-passed `theme` prop OR, when
          absent, the system / centralized appearance (resolved in useChatCore
          via resolveSystemTheme) — NEVER a hardcoded "dark" literal. */}
      <Theme
        appearance={contextValue.theme}
        style={{
          minWidth: 0,
          width: "100%",
          height: heightMode === "container" ? "100%" : "100dvh",
        }}
      >
        <ChatProvider value={contextValue} inputValue={inputContextValue}>
          <ChatPaletteCommands />
          <ChatLayout />
        </ChatProvider>
      </Theme>
    </ErrorBoundary>
  );
});
