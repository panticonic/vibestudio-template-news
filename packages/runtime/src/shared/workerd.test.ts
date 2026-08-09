/**
 * Tests for the typed workerd client.
 *
 * Worker lifecycle delegates to the canonical runtime entity service while
 * discovery and workspace service resolution use the workers service.
 */

import { createWorkerdClient, type WorkerdClient } from "./workerd.js";

function createMockRpc() {
  const calls: Array<{ target: string; method: string; args: unknown[] }> = [];

  return {
    rpc: {
      call: vi.fn(async (target: string, method: string, args: unknown[]) => {
        calls.push({ target, method, args });
        return undefined;
      }),
    } as any,
    calls,
  };
}

describe("createWorkerdClient", () => {
  let client: WorkerdClient;
  let mock: ReturnType<typeof createMockRpc>;

  beforeEach(() => {
    mock = createMockRpc();
    client = createWorkerdClient(mock.rpc);
  });

  it("exposes ergonomic worker lifecycle and exact-target DO recovery primitives", () => {
    // Raw cloneDO/destroyDO remain closed; only the journaled exact-target
    // reset/backup/restore recovery surface is public.
    expect(Object.keys(client).sort()).toEqual(
      [
        "create",
        "destroy",
        "durableObjectService",
        "list",
        "listServices",
        "listSources",
        "listStorageBackups",
        "resetStorage",
        "resolveDurableObject",
        "resolveService",
        "restoreStorageBackup",
      ].sort()
    );
  });

  it("creates, lists, and destroys workers through runtime entity methods", async () => {
    await client.create("workers/example", {
      key: "probe",
      contextId: "ctx-1",
      env: { NON_SECRET_PROBE: "configured" },
    });
    await client.list();
    await client.destroy({ id: "worker:workers/example:probe" });
    await client.destroy("worker:workers/example:probe-2");
    await client.destroy({ targetId: "do:workers/example:ExampleDO:probe" });

    expect(mock.rpc.call).toHaveBeenCalledWith("main", "runtime.createEntity", [
      {
        kind: "worker",
        execution: { surface: "code", source: "workers/example" },
        key: "probe",
        contextId: "ctx-1",
        env: { NON_SECRET_PROBE: "configured" },
      },
    ]);
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "runtime.listEntities", [
      { kind: "worker" },
    ]);
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "runtime.retireEntity", [
      { id: "worker:workers/example:probe" },
    ]);
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "runtime.retireEntity", [
      { id: "worker:workers/example:probe-2" },
    ]);
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "runtime.retireEntity", [
      { id: "do:workers/example:ExampleDO:probe" },
    ]);
  });

  it("listSources calls workers.listSources", async () => {
    await client.listSources();
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workers.listSources", []);
  });

  it("listServices calls workers.listServices", async () => {
    await client.listServices();
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workers.listServices", []);
  });

  it("resolveService calls workers.resolveService", async () => {
    await client.resolveService("vibestudio.channel.v1", "chat-1");
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workers.resolveService", [
      "vibestudio.channel.v1",
      "chat-1",
    ]);
  });

  it("durableObjectService resolves then calls the service target through unified RPC", async () => {
    mock.rpc.call.mockImplementation(async (target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService") {
        return {
          kind: "durable-object",
          targetId: "do:workers/example:ExampleDO:key-1",
        };
      }
      return "ok";
    });

    await expect(
      client.durableObjectService("example.service.v1", "key-1").call("ping")
    ).resolves.toBe("ok");
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workers.resolveService", [
      "example.service.v1",
      "key-1",
    ]);
    expect(mock.rpc.call).toHaveBeenCalledWith("do:workers/example:ExampleDO:key-1", "ping", []);
  });

  it("resolveDurableObject calls workers.resolveDurableObject", async () => {
    await client.resolveDurableObject("workers/example", "ExampleDO", "key-1");
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workers.resolveDurableObject", [
      "workers/example",
      "ExampleDO",
      "key-1",
    ]);
  });
});
