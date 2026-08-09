import { useEffect, useMemo, useState } from "react";
import { Badge, Box, Flex, IconButton, Popover, Text } from "@radix-ui/themes";
import { ChevronDownIcon, ExternalLinkIcon, InfoCircledIcon } from "@radix-ui/react-icons";
import type { ChatMessage } from "@workspace/agentic-core";
import { useOptionalChatMessageActions } from "../context/ChatContext";
import { MarkdownPreview } from "./MarkdownPreview";
import { MessageContent } from "./MessageContent";
import { SubagentTranscriptContent } from "./SubagentTranscript";
import { useChildTranscript } from "../hooks/useChildTranscript";
import { CopyIconButton } from "./shared/CopyButton";
import { executionStatusLabel, executionStatusTone, isLiveStatus } from "./shared/invocationStatus";

/**
 * SubagentRunCard — how a spawned child run appears in its parent's transcript.
 * Routed here from `MessageList.renderItem` for a durable subagent task card.
 *
 * The card's summary line comes from the durable task card itself (terminal
 * summary / status). Detailed activity is the child's canonical task
 * transcript, observed on its task channel and drawn by the same
 * `MessageList` as the parent chat — there is no relayed copy of child
 * activity in the parent's log.
 */

function compactId(value: string): string {
  if (value.length <= 36) return value;
  return `${value.slice(0, 18)}…${value.slice(-12)}`;
}

function IdentifiersPopover({ rows }: { rows: Array<[string, string]> }) {
  return (
    <Popover.Root>
      <Popover.Trigger>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          title="Run identifiers"
          aria-label="Run identifiers"
        >
          <InfoCircledIcon />
        </IconButton>
      </Popover.Trigger>
      <Popover.Content size="1" className="subagent-ids-popover">
        <Text size="1" weight="medium" className="subagent-ids-heading">
          Run identifiers
        </Text>
        <Box className="subagent-detail-grid">
          {rows.map(([name, value]) => (
            <div className="subagent-detail-row" key={name}>
              <Text size="1" className="subagent-detail-name">
                {name}
              </Text>
              <Flex align="center" gap="1" className="subagent-detail-value-wrap">
                <Text size="1" className="subagent-detail-value" title={value}>
                  {compactId(value)}
                </Text>
                <CopyIconButton
                  value={value}
                  label={`Copy ${name.toLowerCase()} id`}
                  className="subagent-copy-button"
                />
              </Flex>
            </div>
          ))}
        </Box>
      </Popover.Content>
    </Popover.Root>
  );
}

export function SubagentRunCard({ msg }: { msg: ChatMessage }) {
  const actions = useOptionalChatMessageActions();
  const forkState = actions?.forkState;
  const childTranscript = actions?.childTranscript;
  const [open, setOpen] = useState(false);
  const [observedTerminal, setObservedTerminal] = useState<ChatMessage["task"] | null>(null);

  const task = msg.task;
  const subagent = task?.subagent;
  const recordedStatus = task?.execution.status ?? "pending";
  const recordedIsLive = isLiveStatus(recordedStatus);
  const runId = subagent?.runId ?? "";
  const canObserve = Boolean(childTranscript && subagent?.taskChannelId);
  const observed = useChildTranscript({
    connection: childTranscript ?? null,
    channelId: subagent?.taskChannelId ?? null,
    contextId: subagent?.contextId ?? null,
    // Live cards observe until they see the canonical terminal fact. Historical
    // terminal cards therefore own no stream; expanding a card observes only
    // for as long as the user is reading its transcript.
    enabled: canObserve && (open || (recordedIsLive && !observedTerminal)),
  });
  const terminalTask = useMemo(
    () =>
      observed.messages
        .map((message) => message.task)
        .find(
          (candidate) => candidate?.id === runId && !isLiveStatus(candidate.execution.status)
        ) ?? null,
    [observed.messages, runId]
  );
  useEffect(() => {
    setObservedTerminal(null);
  }, [runId]);
  useEffect(() => {
    if (terminalTask) setObservedTerminal(terminalTask);
  }, [terminalTask]);

  if (!task || !subagent) return null;

  const effectiveTask = observedTerminal ?? task;
  const status = effectiveTask.execution.status;
  const isLive = isLiveStatus(status);
  const description = effectiveTask.execution.description.trim();
  const label = subagent.label || task.title || "Subagent";
  const canOpenPanel = Boolean(forkState && subagent.taskChannelId && subagent.contextId);
  const preview = description
    ? { content: description }
    : { content: isLive ? "Working — open the card to watch the transcript" : "No summary yet" };

  const detailRows = (
    [
      ["Run", subagent.runId],
      ["Task", subagent.taskChannelId],
      ["Context", subagent.contextId],
      ["Parent", subagent.parentContextId ?? undefined],
      ["Child", subagent.childEntityId],
    ] as Array<[string, string | undefined]>
  ).filter((row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0);

  const handleOpenPanel = () => {
    if (subagent.taskChannelId && subagent.contextId) {
      forkState?.actions.openInNewPanel(subagent.taskChannelId, subagent.contextId);
    }
  };

  return (
    <Box className="message-row message-row-agent">
      <Box
        className={`message-card-subagent subagent-status-${status}${open ? " subagent-card-open" : ""}`}
        data-testid="subagent-run-card"
      >
        <div className="subagent-summary">
          <Flex align="center" gap="2" className="subagent-card-header">
            <button
              type="button"
              className="subagent-summary-toggle"
              aria-expanded={open}
              aria-label={open ? "Collapse run details" : "Expand run details"}
              onClick={() => setOpen((value) => !value)}
            >
              <span
                className={`subagent-status-dot subagent-status-dot-${status}`}
                aria-hidden="true"
              />
              <span
                className={`subagent-expand-chevron${open ? " subagent-expand-chevron-open" : ""}`}
                aria-hidden="true"
              >
                <ChevronDownIcon />
              </span>
              <Text className="subagent-title" size="2" weight="medium" truncate>
                {label}
              </Text>
              {subagent.mode && (
                <Badge className="subagent-mode-badge" size="1" variant="surface" color="gray">
                  {subagent.mode}
                </Badge>
              )}
              {subagent.agentKind === "claude-code" && (
                <Badge
                  className="subagent-kind-badge"
                  size="1"
                  variant="soft"
                  color="amber"
                  title="Claude Code subagent"
                >
                  Claude Code
                </Badge>
              )}
            </button>
            <Flex align="center" gap="2" className="subagent-card-actions">
              <Badge
                className="subagent-status-badge"
                size="1"
                variant="soft"
                color={executionStatusTone(status)}
              >
                {executionStatusLabel(status)}
              </Badge>
              {detailRows.length > 0 && <IdentifiersPopover rows={detailRows} />}
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                disabled={!canOpenPanel}
                onClick={handleOpenPanel}
                title="Open subagent chat in a new panel"
                aria-label="Open subagent chat in a new panel"
              >
                <ExternalLinkIcon />
              </IconButton>
            </Flex>
          </Flex>
          {!open && preview.content && (
            <button
              type="button"
              className="subagent-update-preview"
              aria-label="Expand run details from summary"
              onClick={() => setOpen(true)}
            >
              <span className="subagent-activity-text">
                <MarkdownPreview content={preview.content} />
              </span>
            </button>
          )}
        </div>

        {open && (
          <Box className="subagent-details">
            {description && (
              <div className="subagent-description">
                <MessageContent content={description} isStreaming={false} />
              </div>
            )}

            {canObserve && childTranscript && subagent.taskChannelId ? (
              <SubagentTranscriptContent transcript={observed} />
            ) : (
              <Text size="1" color="gray" className="subagent-empty-feed">
                The child's transcript is not observable from this view.
              </Text>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
