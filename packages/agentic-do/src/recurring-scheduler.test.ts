import { describe, expect, it, vi } from "vitest";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import type { SqlStorage } from "@workspace/runtime/worker";
import { RecurringScheduler } from "./recurring-scheduler.js";

const MIN = 60_000;

async function makeScheduler(opts?: { backoffBaseMs?: number; backoffMaxMs?: number }) {
  const sql = (await createInMemorySql()) as unknown as SqlStorage;
  RecurringScheduler.createTables(sql);
  const scheduler = new RecurringScheduler({
    sql,
    ...opts,
  });
  return { sql, scheduler };
}

describe("RecurringScheduler", () => {
  it("runs due jobs and reschedules them one interval out", async () => {
    const { scheduler } = await makeScheduler();
    scheduler.upsertJob({ jobId: "poll", channelId: "ch1", intervalMs: 30 * MIN, nextRunAt: 1000 });
    const runs: string[] = [];
    const nextWakeAt = await scheduler.onAlarm(1000, async (jobId) => {
      runs.push(jobId);
    });
    expect(runs).toEqual(["poll"]);
    expect(nextWakeAt).toBe(1000 + 30 * MIN);
    expect(scheduler.nextWakeAt()).toBe(1000 + 30 * MIN);
  });

  it("does not run jobs that are not yet due", async () => {
    const { scheduler } = await makeScheduler();
    scheduler.upsertJob({ jobId: "poll", channelId: "ch1", intervalMs: 30 * MIN, nextRunAt: 5000 });
    const runs: string[] = [];
    const nextWakeAt = await scheduler.onAlarm(1000, async (jobId) => {
      runs.push(jobId);
    });
    expect(runs).toEqual([]);
    expect(nextWakeAt).toBe(5000);
    expect(scheduler.nextWakeAt()).toBe(5000);
  });

  it("drains multiple due jobs independently and returns the earliest wake", async () => {
    const { scheduler } = await makeScheduler();
    scheduler.upsertJob({ jobId: "poll", channelId: "ch1", intervalMs: 30 * MIN, nextRunAt: 0 });
    scheduler.upsertJob({
      jobId: "briefing",
      channelId: "ch1",
      intervalMs: 24 * 60 * MIN,
      nextRunAt: 0,
    });
    const runs: string[] = [];
    const nextWakeAt = await scheduler.onAlarm(0, async (jobId) => {
      runs.push(jobId);
    });
    expect(runs.sort()).toEqual(["briefing", "poll"]);
    expect(nextWakeAt).toBe(30 * MIN);
    expect(scheduler.nextWakeAt()).toBe(30 * MIN);
  });

  it("applies exponential backoff to a failing job without disturbing others", async () => {
    const { scheduler } = await makeScheduler({ backoffBaseMs: MIN, backoffMaxMs: 60 * MIN });
    scheduler.upsertJob({ jobId: "bad", channelId: "ch1", intervalMs: 10 * MIN, nextRunAt: 0 });
    scheduler.upsertJob({ jobId: "good", channelId: "ch1", intervalMs: 10 * MIN, nextRunAt: 0 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runs: string[] = [];
    await scheduler.onAlarm(0, async (jobId) => {
      runs.push(jobId);
      if (jobId === "bad") throw new Error("boom");
    });
    expect(runs.sort()).toEqual(["bad", "good"]);
    // bad backs off 1 min (2^0 * base); good reschedules at its interval
    expect(scheduler.nextWakeAt()).toBe(MIN);

    // second failure doubles the backoff
    runs.length = 0;
    await scheduler.onAlarm(MIN, async (jobId) => {
      runs.push(jobId);
      if (jobId === "bad") throw new Error("boom");
    });
    expect(runs).toEqual(["bad"]);
    expect(scheduler.nextWakeAt()).toBe(MIN + 2 * MIN);

    // success resets fail_count and realigns to the interval
    runs.length = 0;
    await scheduler.onAlarm(3 * MIN, async (jobId) => {
      runs.push(jobId);
    });
    expect(runs).toEqual(["bad"]);
    // bad realigned to 3+10=13min; good (rescheduled to 10min after round 1) is earlier
    expect(scheduler.nextWakeAt()).toBe(10 * MIN);
    errSpy.mockRestore();
  });

  it("caps backoff at backoffMaxMs", async () => {
    const { scheduler } = await makeScheduler({ backoffBaseMs: MIN, backoffMaxMs: 4 * MIN });
    scheduler.upsertJob({ jobId: "bad", channelId: "ch1", intervalMs: MIN, nextRunAt: 0 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let now = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      await scheduler.onAlarm(now, async () => {
        throw new Error("boom");
      });
      now = scheduler.nextWakeAt()!;
    }
    // 7th failure would be 2^6=64min uncapped; cap holds at 4min past the last wake
    await scheduler.onAlarm(now, async () => {
      throw new Error("boom");
    });
    expect(scheduler.nextWakeAt()! - now).toBe(4 * MIN);
    errSpy.mockRestore();
  });

  it("returns the derived wake even when a run callback throws", async () => {
    const { scheduler } = await makeScheduler();
    scheduler.upsertJob({ jobId: "a", channelId: "ch1", intervalMs: MIN, nextRunAt: 0 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const nextWakeAt = await scheduler.onAlarm(0, async () => {
      throw new Error("boom");
    });
    expect(nextWakeAt).toBe(5 * MIN);
    errSpy.mockRestore();
  });

  it("realigns overdue jobs to now + interval instead of burst catch-up", async () => {
    const { scheduler } = await makeScheduler();
    scheduler.upsertJob({ jobId: "poll", channelId: "ch1", intervalMs: 10 * MIN, nextRunAt: 0 });
    // Wake 5 intervals late: runs once, next run is one interval from NOW.
    const runs: string[] = [];
    await scheduler.onAlarm(50 * MIN, async (jobId) => {
      runs.push(jobId);
    });
    expect(runs).toEqual(["poll"]);
    expect(scheduler.nextWakeAt()).toBe(60 * MIN);
  });

  it("adds bounded jitter to rescheduled runs", async () => {
    const { scheduler } = await makeScheduler();
    scheduler.upsertJob({
      jobId: "poll",
      channelId: "ch1",
      intervalMs: 10 * MIN,
      jitterMs: MIN,
      nextRunAt: 0,
    });
    await scheduler.onAlarm(0, async () => {});
    const next = scheduler.nextWakeAt()!;
    expect(next).toBeGreaterThanOrEqual(10 * MIN);
    expect(next).toBeLessThan(11 * MIN);
  });

  it("upsertJob preserves next_run_at on reconfigure unless explicitly given", async () => {
    const { scheduler } = await makeScheduler();
    scheduler.upsertJob({ jobId: "poll", channelId: "ch1", intervalMs: 10 * MIN, nextRunAt: 7777 });
    scheduler.upsertJob({ jobId: "poll", channelId: "ch1", intervalMs: 20 * MIN });
    expect(scheduler.nextWakeAt()).toBe(7777);
  });

  it("skips disabled jobs and honors removeJob/removeChannel/runNow", async () => {
    const { scheduler } = await makeScheduler();
    scheduler.upsertJob({ jobId: "a", channelId: "ch1", intervalMs: MIN, nextRunAt: 0 });
    scheduler.upsertJob({ jobId: "b", channelId: "ch2", intervalMs: MIN, nextRunAt: 0 });
    scheduler.setEnabled("a", false);
    const runs: string[] = [];
    await scheduler.onAlarm(0, async (jobId) => {
      runs.push(jobId);
    });
    expect(runs).toEqual(["b"]);

    scheduler.removeChannel("ch2");
    scheduler.setEnabled("a", true);
    scheduler.runNow("a", 500);
    runs.length = 0;
    await scheduler.onAlarm(500, async (jobId) => {
      runs.push(jobId);
    });
    expect(runs).toEqual(["a"]);

    scheduler.removeJob("a");
    expect(scheduler.nextWakeAt()).toBeUndefined();
  });
});
