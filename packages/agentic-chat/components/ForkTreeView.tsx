import { useEffect, useState } from "react";
import { Badge, Box, Button, Dialog, Flex, Text } from "@radix-ui/themes";
import { useChatContext } from "../context/ChatContext";
import type { ForkTreeNode } from "../types";

/**
 * ForkTreeView — the "Show tree" overlay. Lazily walks provenance up to the
 * lineage root and hangs each channel's live child forks off the spine (see
 * `useForkLineage.loadTree`). Each node is switchable (in place) or openable in
 * a new panel; the current node is highlighted.
 */

function TreeRow({
  node,
  depth,
  onSwitch,
  onOpen,
}: {
  node: ForkTreeNode;
  depth: number;
  onSwitch: (channelId: string, contextId?: string) => void;
  onOpen: (channelId: string, contextId?: string) => void;
}) {
  return (
    <>
      <Flex align="center" justify="between" gap="2" style={{ paddingLeft: depth * 16 }}>
        <Flex align="center" gap="2" style={{ minWidth: 0 }}>
          <Text size="1" aria-hidden="true">
            {node.provenanceKind === "root" ? "●" : "⑂"}
          </Text>
          <Text size="2" weight={node.isCurrent ? "bold" : "regular"} truncate>
            {node.label}
          </Text>
          {node.isCurrent && (
            <Badge size="1" variant="soft" color="blue">
              current
            </Badge>
          )}
          {node.unread && !node.isCurrent && (
            <Badge size="1" variant="soft" color="green">
              new
            </Badge>
          )}
        </Flex>
        {!node.isCurrent && (
          <Flex gap="1" style={{ flexShrink: 0 }}>
            <Button size="1" variant="ghost" onClick={() => onSwitch(node.channelId, node.contextId)}>
              Switch
            </Button>
            <Button size="1" variant="ghost" color="gray" onClick={() => onOpen(node.channelId, node.contextId)}>
              Open
            </Button>
          </Flex>
        )}
      </Flex>
      {node.children.map((child) => (
        <TreeRow key={child.channelId} node={child} depth={depth + 1} onSwitch={onSwitch} onOpen={onOpen} />
      ))}
    </>
  );
}

export function ForkTreeView({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { forkState } = useChatContext();
  const [tree, setTree] = useState<ForkTreeNode[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !forkState) return;
    let cancelled = false;
    setLoading(true);
    void forkState
      .loadTree()
      .then((nodes) => {
        if (!cancelled) setTree(nodes);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, forkState]);

  const handleSwitch = (channelId: string, contextId?: string) => {
    if (contextId) forkState?.actions.switchTo(channelId, contextId);
    onClose();
  };
  const handleOpen = (channelId: string, contextId?: string) => {
    if (contextId) forkState?.actions.openInNewPanel(channelId, contextId);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Content maxWidth="560px">
        <Dialog.Title>Conversation tree</Dialog.Title>
        <Dialog.Description size="1" color="gray">
          The lineage of this conversation — forks branch off, subagents nest under their task.
        </Dialog.Description>
        <Box mt="3">
          {loading && (
            <Text size="2" color="gray">
              Loading…
            </Text>
          )}
          {!loading && tree.length === 0 && (
            <Text size="2" color="gray">
              No lineage yet — this is a root conversation.
            </Text>
          )}
          <Flex direction="column" gap="1">
            {tree.map((node) => (
              <TreeRow key={node.channelId} node={node} depth={0} onSwitch={handleSwitch} onOpen={handleOpen} />
            ))}
          </Flex>
        </Box>
        <Flex justify="end" mt="3">
          <Dialog.Close>
            <Button variant="soft" color="gray">
              Close
            </Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
