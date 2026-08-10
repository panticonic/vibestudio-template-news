import { describe, expect, it } from "vitest";
import { localToolExecutor } from "./index.js";

describe("localToolExecutor", () => {
  it("preserves a local tool termination request as durable turn control", async () => {
    const outcome = await localToolExecutor.execute({
      descriptor: {
        kind: "local_tool",
        effectId: "effect-1",
        channelId: "channel-1",
        invocationId: "invocation-1",
        tool: "complete",
        args: { report: "done" },
      } as never,
      state: {} as never,
      signal: new AbortController().signal,
      deps: {
        localTools: {
          alreadyApplied: () => false,
          run: async () => ({
            result: { protocolContent: [], details: { outcome: "success" } },
            isError: false,
            terminate: true,
          }),
        },
      } as never,
      onEphemeral: () => undefined,
    });

    expect(outcome).toMatchObject({
      kind: "tool",
      isError: false,
      turnControl: { kind: "terminate" },
    });
  });
});
