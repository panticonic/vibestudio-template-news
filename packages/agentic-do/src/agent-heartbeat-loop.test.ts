import { describe, expect, it, vi } from "vitest";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import type { SqlStorage } from "@workspace/runtime/worker";
import {
  AgentHeartbeatLoop,
  type AgentHeartbeatLoopDeps,
  type HeartbeatDecision,
  type HeartbeatTurnRequest,
} from "./agent-heartbeat-loop.js";

async function harness(
  initialDecision: HeartbeatDecision = { action: "skip", reason: "quiet" },
  overrides: Partial<AgentHeartbeatLoopDeps> = {}
) {
  const sql = (await createInMemorySql()) as unknown as SqlStorage;
  const enqueued: HeartbeatTurnRequest[] = [];
  const wakes: Array<{ sourceId: string; timeMs: number }> = [];
  const clears: string[] = [];
  let decision = initialDecision;
  let now = 10_000;
  const loop = new AgentHeartbeatLoop({
    sql,
    namespace: "test",
    now: () => now,
    evaluate: () => decision,
    enqueueTurn: (turn) => {
      enqueued.push(turn);
    },
    scheduleWakeAt: (sourceId, timeMs) => {
      wakes.push({ sourceId, timeMs });
    },
    clearWake: (sourceId) => {
      clears.push(sourceId);
    },
    log: { warn: vi.fn(), info: vi.fn() },
    ...overrides,
  });
  loop.createTables();
  return {
    loop,
    enqueued,
    wakes,
    clears,
    setDecision(next: HeartbeatDecision) {
      decision = next;
    },
    setNow(next: number) {
      now = next;
    },
  };
}

describe("AgentHeartbeatLoop", () => {
  it("rejects an obsolete heartbeat table instead of adding missing columns", async () => {
    const sql = (await createInMemorySql()) as unknown as SqlStorage;
    sql.exec(`
      CREATE TABLE heartbeat_loop_test (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL,
        cadence_ms INTEGER NOT NULL,
        objective TEXT NOT NULL,
        last_wake_at INTEGER NOT NULL,
        last_observed_digest TEXT NOT NULL
      )
    `);
    const loop = new AgentHeartbeatLoop({
      sql,
      namespace: "test",
      evaluate: () => ({ action: "skip" }),
      enqueueTurn: () => {},
      scheduleWakeAt: () => {},
    });

    expect(() => loop.createTables()).toThrow(
      "Unsupported heartbeat_loop_test schema; delete this pre-release state"
    );
  });

  it("starts, persists state, and schedules through the named source", async () => {
    const h = await harness();
    await h.loop.start({ cadenceMs: 5_000, objective: "watch" });

    expect(h.loop.getState()).toMatchObject({
      name: "test",
      status: "running",
      cadenceMs: 5_000,
      objective: "watch",
      nextRunAt: 15_000,
    });
    expect(h.wakes).toEqual([{ sourceId: "heartbeat:test", timeMs: 15_000 }]);
  });

  it("skips without enqueueing and advances the digest", async () => {
    const h = await harness({ action: "skip", reason: "same", digest: "abc" });
    await h.loop.start();

    const result = await h.loop.runNow("operator");

    expect(result).toMatchObject({
      action: "skip",
      enqueued: false,
      skippedReason: "decision_skip",
    });
    expect(h.enqueued).toHaveLength(0);
    expect(h.loop.getState().lastObservedDigest).toBe("abc");
  });

  it("enqueues prompt decisions and records wake metadata", async () => {
    const h = await harness({
      action: "prompt",
      reason: "changed",
      digest: "def",
      promptText: "review state",
    });
    await h.loop.start();

    const result = await h.loop.runNow();

    expect(result).toMatchObject({ action: "prompt", enqueued: true });
    expect(h.enqueued[0]).toMatchObject({ kind: "prompt", promptText: "review state" });
    expect(h.loop.getState()).toMatchObject({
      lastWakeAt: 10_000,
      lastObservedDigest: "def",
      lastDecision: "changed",
      failCount: 0,
    });
  });

  it("records enqueue failures and applies exponential backoff", async () => {
    const h = await harness(
      { action: "prompt", promptText: "review" },
      {
        enqueueTurn: () => {
          throw new Error("queue down");
        },
        failureBackoff: { baseMs: 1_000, maxMs: 10_000 },
      }
    );
    await h.loop.start();

    const result = await h.loop.runNow();

    expect(result).toMatchObject({
      action: "prompt",
      enqueued: false,
      skippedReason: "enqueue_failed",
      error: "queue down",
    });
    expect(h.loop.getState()).toMatchObject({
      failCount: 1,
      lastError: "queue down",
      backoffUntil: 11_000,
    });
    expect(h.wakes[h.wakes.length - 1]).toEqual({ sourceId: "heartbeat:test", timeMs: 11_000 });
  });

  it("pause and stop clear the registered wake source", async () => {
    const h = await harness();
    await h.loop.start();
    await h.loop.pause();
    await h.loop.stop();

    expect(h.clears).toEqual(["heartbeat:test", "heartbeat:test"]);
    expect(h.loop.nextWakeAt()).toBeNull();
  });
});
