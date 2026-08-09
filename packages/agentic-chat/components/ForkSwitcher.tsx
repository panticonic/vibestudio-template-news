import { useState } from "react";
import { Badge, Button, DropdownMenu, Flex, Text } from "@radix-ui/themes";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import { useChatContext } from "../context/ChatContext";
import { ForkTreeView } from "./ForkTreeView";
import type { ForkEntry } from "../types";

/**
 * ForkSwitcher — the ChatHeader branch control (next to the roster). Shows the
 * current branch label, the parent breadcrumb (when this is a fork), the
 * current channel's direct-child forks and any siblings, plus "New fork" and
 * "Show tree". Each fork entry switches in place (primary), or opens in a new
 * panel. Reconciles on open (§H).
 */

function ForkItem({
  entry,
  onSwitch,
  onOpen,
}: {
  entry: ForkEntry;
  onSwitch: (e: ForkEntry) => void;
  onOpen: (e: ForkEntry) => void;
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger>
        <Flex align="center" gap="2" style={{ minWidth: 0 }}>
          <Text truncate style={{ minWidth: 0, opacity: entry.archived ? 0.5 : 1 }}>
            {entry.label}
          </Text>
          {entry.unread && (
            <Badge size="1" variant="soft" color="green">
              new
            </Badge>
          )}
        </Flex>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent>
        <DropdownMenu.Label>
          {entry.actorName} · from message {entry.forkPointId}
        </DropdownMenu.Label>
        <DropdownMenu.Item onSelect={() => onSwitch(entry)}>Switch to this fork</DropdownMenu.Item>
        <DropdownMenu.Item onSelect={() => onOpen(entry)}>Open in new panel</DropdownMenu.Item>
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
  );
}

export function ForkSwitcher({ variant = "button" }: { variant?: "button" | "submenu" }) {
  const { forkState } = useChatContext();
  const [treeOpen, setTreeOpen] = useState(false);
  if (!forkState) return null;

  const { provenance, currentLabel, children, siblings, parent, forking, refresh, actions } =
    forkState;
  const hasForks = children.length > 0 || siblings.length > 0;

  const handleSwitch = (e: ForkEntry) => actions.switchTo(e.channelId, e.contextId);
  const handleOpen = (e: ForkEntry) => actions.openInNewPanel(e.channelId, e.contextId);

  const content = (
    <>
      {parent && (
        <>
          <DropdownMenu.Item
            onSelect={() =>
              parent.contextId && actions.switchTo(parent.channelId, parent.contextId)
            }
          >
            ↑ Parent conversation
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
        </>
      )}
      {siblings.length > 0 && (
        <>
          <DropdownMenu.Label>Sibling forks</DropdownMenu.Label>
          {siblings.map((entry) => (
            <ForkItem
              key={entry.forkId}
              entry={entry}
              onSwitch={handleSwitch}
              onOpen={handleOpen}
            />
          ))}
          <DropdownMenu.Separator />
        </>
      )}
      {children.length > 0 && (
        <>
          <DropdownMenu.Label>Forks from here</DropdownMenu.Label>
          {children.map((entry) => (
            <ForkItem
              key={entry.forkId}
              entry={entry}
              onSwitch={handleSwitch}
              onOpen={handleOpen}
            />
          ))}
          <DropdownMenu.Separator />
        </>
      )}
      {!hasForks && provenance?.kind !== "fork" && (
        <DropdownMenu.Label>No forks yet</DropdownMenu.Label>
      )}
      <DropdownMenu.Item disabled={forking} onSelect={() => void actions.newFork()}>
        New fork from here
      </DropdownMenu.Item>
      <DropdownMenu.Item onSelect={() => setTreeOpen(true)}>Show tree…</DropdownMenu.Item>
    </>
  );

  return (
    <>
      {variant === "submenu" ? (
        <DropdownMenu.Sub onOpenChange={(open) => open && refresh()}>
          <DropdownMenu.SubTrigger disabled={forking}>
            Branch: {forking ? "Forking…" : currentLabel}
          </DropdownMenu.SubTrigger>
          <DropdownMenu.SubContent>{content}</DropdownMenu.SubContent>
        </DropdownMenu.Sub>
      ) : (
        <DropdownMenu.Root onOpenChange={(open) => open && refresh()}>
          <DropdownMenu.Trigger>
            <Button
              size="1"
              variant="soft"
              color="gray"
              disabled={forking}
              aria-label="Switch fork"
            >
              <Flex align="center" gap="1">
                <Text size="1" aria-hidden="true">
                  ⑂
                </Text>
                <Text size="1" truncate style={{ maxWidth: 140 }}>
                  {forking ? "Forking…" : currentLabel}
                </Text>
                <ChevronDownIcon />
              </Flex>
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start">{content}</DropdownMenu.Content>
        </DropdownMenu.Root>
      )}
      <ForkTreeView open={treeOpen} onClose={() => setTreeOpen(false)} />
    </>
  );
}
