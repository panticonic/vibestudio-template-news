import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "./connection.js";
import type { ChatParticipantMetadata, ConnectionConfig } from "./types.js";

const CHANNEL_TARGET = "do:workers/pubsub-channel:PubSubChannel:chat-1";

function createConfig(): ConnectionConfig {
  const call = vi.fn((target: string, method: string) => {
    if (target === "main" && method === "workers.resolveService") {
      return Promise.resolve({
        kind: "durable-object",
        targetId: CHANNEL_TARGET,
      });
    }
    return Promise.resolve(undefined);
  }) as NonNullable<ConnectionConfig["rpc"]>["call"];
  return {
    clientId: "panel:panel-1",
    rpc: {
      selfId: "panel:panel-1",
      call,
      stream: vi.fn((_target, _method, _args, options) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `${JSON.stringify({
                      kind: "subscribed",
                      result: { ok: true, participantId: "panel:panel-1" },
                    })}\n`
                  )
                );
                options?.signal?.addEventListener("abort", () => controller.close(), {
                  once: true,
                });
              },
            })
          )
        )
      ),
      on: vi.fn(() => vi.fn()),
    },
  };
}

const metadata: ChatParticipantMetadata = {
  name: "Panel",
  type: "panel",
};

describe("ConnectionManager", () => {
  it("closes a pubsub client when a pending connect is aborted", async () => {
    const config = createConfig();
    const manager = new ConnectionManager({ config, metadata, callbacks: {} });

    const connectPromise = manager.connect({ channelId: "chat-1", methods: {} });
    await vi.waitFor(() => {
      expect(config.rpc!.stream).toHaveBeenCalledWith(
        CHANNEL_TARGET,
        "subscribe",
        [
          "panel:panel-1",
          expect.objectContaining({
            replayMessageLimit: 50,
          }),
        ],
        { signal: expect.any(AbortSignal) }
      );
    });
    await manager.disconnect();

    await expect(connectPromise).rejects.toThrow("ready aborted");
    expect(config.rpc!.call).toHaveBeenCalledWith(
      CHANNEL_TARGET,
      "unsubscribe",
      ["panel:panel-1"]
    );
  });

  it("bounds an explicit replay message limit to the canonical page maximum", async () => {
    const config = { ...createConfig(), replayMessageLimit: 1234 };
    const manager = new ConnectionManager({ config, metadata, callbacks: {} });

    const connectPromise = manager.connect({ channelId: "chat-1", methods: {} });
    await vi.waitFor(() => {
      expect(config.rpc.stream).toHaveBeenCalledWith(
        CHANNEL_TARGET,
        "subscribe",
        [
          "panel:panel-1",
          expect.objectContaining({
            replayMessageLimit: 500,
          }),
        ],
        { signal: expect.any(AbortSignal) }
      );
    });
    await manager.disconnect();

    await expect(connectPromise).rejects.toThrow("ready aborted");
  });
});
