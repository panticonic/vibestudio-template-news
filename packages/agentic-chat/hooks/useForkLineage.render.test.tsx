// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@workspace/agentic-core";
import { useForkLineage, type UseForkLineageOptions } from "./useForkLineage";

function message(content: string): ChatMessage {
  return {
    id: "assistant-1",
    senderId: "agent-1",
    content,
    kind: "message",
    complete: false,
    seq: 1,
  };
}

describe("useForkLineage render stability", () => {
  it("keeps its action projection stable when a non-fork message streams", () => {
    const rpc: UseForkLineageOptions["rpc"] = {
      selfId: "panel-1",
      call: async <Result,>() => undefined as Result,
    };
    const base = {
      rpc,
      channelId: null,
      selfId: "panel-1",
      replaySettled: false,
    } satisfies Omit<UseForkLineageOptions, "messages">;
    const { result, rerender } = renderHook(
      ({ messages }: { messages: ChatMessage[] }) =>
        useForkLineage({
          ...base,
          messages,
          selfMetadata: { type: "panel", name: "Panel", handle: "alice" },
        }),
      { initialProps: { messages: [message("a")] } }
    );
    const initial = result.current;

    rerender({ messages: [message("ab")] });

    expect(result.current).toBe(initial);
  });
});
