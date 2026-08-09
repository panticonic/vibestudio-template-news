/**
 * InlineUiMessage - Renders compiled TSX inline in conversation flow.
 *
 * Collapsible card that stays in the chat history. Users can expand/collapse
 * at any time to interact with the component.
 */
import { Suspense, useCallback, useEffect, useMemo, useReducer, useState, type ComponentType } from "react";
import { Box, Button, Callout, Flex, Spinner, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, ComponentInstanceIcon } from "@radix-ui/react-icons";
import { EventErrorBoundary } from "@workspace/tool-ui/components/EventErrorBoundary";
import { SurfaceFrame } from "@workspace/tool-ui/components/SurfaceFrame";
import { wrapChatForErrorReporting, wrapScopesForErrorReporting } from "../utils/wrapSandboxApis";
import type { InlineUiData } from "@workspace/pubsub";
import type { ChatSandboxValue } from "@workspace/agentic-core";
import { useChatContext } from "../context/ChatContext";

// ---------------------------------------------------------------------------
// InlineUiErrorCallout — error display with "Report to Agent" button
// ---------------------------------------------------------------------------

export function InlineUiErrorCallout({
  error,
  componentId,
  source,
  chat,
}: {
  error: Error;
  componentId: string;
  source?: string;
  chat: ChatSandboxValue;
}) {
  const [reported, setReported] = useState(false);

  const handleReport = useCallback(() => {
    const message =
      `[Inline UI Error] Component "${componentId}" encountered an error ` +
      `during user interaction:\n\n\`\`\`\n${error.message}\n\`\`\`\n\n` +
      `${source ? `Source: \`${source}\`\n\n` : ""}` +
      `${error.stack ? `Stack trace:\n\`\`\`\n${error.stack}\n\`\`\`` : ""}`;
    chat.send(message).catch((err) => {
      console.error("[InlineUiMessage] Failed to report error to agent:", err);
    });
    setReported(true);
  }, [error, componentId, chat]);

  return (
    <Callout.Root color="red" size="1">
      <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
      <Text as="div" size="2" className="rt-CalloutText">
        <Flex direction="column" gap="2">
          <Text size="1">Component error: {error.message || "Unknown error"}</Text>
          <details>
            <summary style={{ cursor: "pointer", fontSize: "var(--font-size-1)" }}>
              Technical details
            </summary>
            <pre
              style={{
                fontSize: "var(--font-size-1)",
                margin: "var(--space-2) 0 0",
                overflowWrap: "anywhere",
                whiteSpace: "pre-wrap",
              }}
            >
              {[`Component: ${componentId}`, source ? `Source: ${source}` : null, error.stack]
                .filter(Boolean)
                .join("\n")}
            </pre>
          </details>
          <Box>
            <Button
              size="1"
              variant="soft"
              color="red"
              disabled={reported}
              onClick={handleReport}
            >
              {reported ? "Reported" : "Report to Agent"}
            </Button>
          </Box>
        </Flex>
      </Text>
    </Callout.Root>
  );
}

// ---------------------------------------------------------------------------
// InlineUiMessage
// ---------------------------------------------------------------------------

interface InlineUiMessageProps {
  data: InlineUiData;
  compiledComponent?: ComponentType<{
    props: Record<string, unknown>;
    chat: Record<string, unknown>;
    scope: Record<string, unknown>;
    scopes: Record<string, unknown>;
  }>;
  compilationError?: string;
}

function isModelCredentialCard(data: InlineUiData): boolean {
  return (
    data.source.type === "file" && data.source.path.endsWith("ModelCredentialRequiredCard.tsx")
  );
}

export function InlineUiMessage({ data, compiledComponent: CompiledComponent, compilationError }: InlineUiMessageProps) {
  const { browserHandoffCaller, chat, scope, scopes, scopeManager, selfId } = useChatContext();
  const componentProps = useMemo(() => {
    const props = data.props ?? {};
    if (!isModelCredentialCard(data)) return props;
    return {
      ...props,
      modelPersistenceParticipantId:
        typeof props["modelPersistenceParticipantId"] === "string"
          ? props["modelPersistenceParticipantId"]
          : (selfId ?? undefined),
      browserHandoffCallerId:
        typeof props["browserHandoffCallerId"] === "string"
          ? props["browserHandoffCallerId"]
          : browserHandoffCaller.id,
      browserHandoffCallerKind:
        typeof props["browserHandoffCallerKind"] === "string"
          ? props["browserHandoffCallerKind"]
          : browserHandoffCaller.kind,
    };
  }, [browserHandoffCaller.id, browserHandoffCaller.kind, data, selfId]);
  const [, forceUpdate] = useReducer((value: number) => value + 1, 0);
  const [asyncError, setAsyncError] = useState<Error | null>(null);

  // Wrap chat so unhandled async rejections surface visually
  const reportComponentError = useCallback(
    (err: Error) => {
      console.error(`[InlineUiMessage] Component "${data.id}" failed:`, err);
      setAsyncError(err);
    },
    [data.id],
  );
  const wrappedChat = useMemo(
    () => wrapChatForErrorReporting(chat, reportComponentError),
    [chat, reportComponentError],
  );
  const wrappedScopes = useMemo(
    () => wrapScopesForErrorReporting(scopes, reportComponentError),
    [scopes, reportComponentError],
  );

  const onInteraction = useCallback(() => {
    void scopeManager.persist().catch((err) => {
      console.warn("[InlineUiMessage] Scope persist after interaction failed:", err);
    });
  }, [scopeManager]);

  useEffect(() => scopeManager.onChange(forceUpdate), [scopeManager]);

  // Reset async error when props change (same trigger as EventErrorBoundary's resetKey)
  const resetKey = JSON.stringify(data.props);
  useEffect(() => { setAsyncError(null); }, [resetKey]);

  if (asyncError) {
    return (
      <InlineUiErrorCallout
        error={asyncError}
        componentId={data.id}
        source={data.source.type === "file" ? data.source.path : "inline code"}
        chat={chat}
      />
    );
  }

  if (compilationError) {
    return (
      <InlineUiErrorCallout
        error={new Error(compilationError)}
        componentId={data.id}
        source={data.source.type === "file" ? data.source.path : "inline code"}
        chat={chat}
      />
    );
  }

  if (!CompiledComponent) {
    return null;
  }

  return (
    <SurfaceFrame
      className="inline-ui-frame"
      title="Interactive UI"
      tone="blue"
      icon={<ComponentInstanceIcon />}
      collapsible
      defaultExpanded
    >
      <Box
        className="inline-ui-content"
        onClickCapture={onInteraction}
        onInputCapture={onInteraction}
        onChangeCapture={onInteraction}
      >
        <EventErrorBoundary
          resetKey={resetKey}
          onError={reportComponentError}
          renderFallback={(error) => (
            <InlineUiErrorCallout
              error={error}
              componentId={data.id}
              source={data.source.type === "file" ? data.source.path : "inline code"}
              chat={chat}
            />
          )}
        >
          <Suspense fallback={<Spinner size="1" />}>
            <CompiledComponent
              props={componentProps}
              chat={wrappedChat as unknown as Record<string, unknown>}
              scope={scope}
              scopes={wrappedScopes as unknown as Record<string, unknown>}
            />
          </Suspense>
        </EventErrorBoundary>
      </Box>
    </SurfaceFrame>
  );
}

/**
 * Parse inline UI data from message content.
 * Returns null if parsing fails.
 */
export function parseInlineUiData(content: string): InlineUiData | null {
  try {
    const value = JSON.parse(content) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (typeof record["id"] !== "string") return null;
    const props = typeof record["props"] === "object" && record["props"] !== null && !Array.isArray(record["props"])
      ? record["props"] as Record<string, unknown>
      : undefined;
    const source = record["source"];
    if (typeof source === "object" && source !== null) {
      const sourceRecord = source as Record<string, unknown>;
      if (sourceRecord["type"] === "code" && typeof sourceRecord["code"] === "string") {
        return { id: record["id"], source: { type: "code", code: sourceRecord["code"] }, props };
      }
      if (sourceRecord["type"] === "file" && typeof sourceRecord["path"] === "string") {
        return { id: record["id"], source: { type: "file", path: sourceRecord["path"] }, props };
      }
    }

    return null;
  } catch {
    return null;
  }
}
