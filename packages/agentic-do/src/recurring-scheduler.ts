/**
 * RecurringScheduler — durable multi-job recurring schedules on top of the
 * single-alarm-per-DO primitive.
 *
 * DOs get exactly one pending alarm (server-driven, durable across restarts),
 * so any agent with more than one cadence — poll every 30m, briefing daily —
 * ends up hand-rolling the same loop: drain due jobs, back off failures,
 * recompute the earliest next wake, and return it to the alarm boundary. This
 * extracts that loop without performing nested scheduling effects.
 *
 * Usage inside a DurableObjectBase subclass:
 *
 *   private scheduler = new RecurringScheduler({ sql: this.sql });
 *
 *   // in createTables(): RecurringScheduler.createTables(this.sql)
 *   // on subscribe:      this.scheduler.upsertJob({ jobId: `poll:${ch}`, channelId: ch, intervalMs: 30*60_000 })
 *   // in alarm():        return this.scheduler.onAlarm(Date.now(), (jobId, channelId) => this.runJob(jobId, channelId))
 */

import type { SqlStorage } from "@workspace/runtime/worker";

export interface RecurringJob {
  jobId: string;
  channelId: string;
  intervalMs: number;
  /** Random 0..jitterMs added to each scheduled run to avoid host hammering. */
  jitterMs?: number;
  /** Explicit first run time (epoch ms); defaults to now-ish (immediate). */
  nextRunAt?: number;
  enabled?: boolean;
}

export interface RecurringSchedulerDeps {
  sql: SqlStorage;
  /** Failure backoff base/cap; defaults 5min base, 4h cap. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

const DEFAULT_BACKOFF_BASE_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MAX_MS = 4 * 3_600_000;

export class RecurringScheduler {
  private readonly sql: SqlStorage;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;

  constructor(deps: RecurringSchedulerDeps) {
    this.sql = deps.sql;
    this.backoffBaseMs = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = deps.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  }

  static createTables(sql: SqlStorage): void {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS recurring_jobs (
        job_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        jitter_ms INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL,
        fail_count INTEGER NOT NULL DEFAULT 0,
        backoff_until INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1
      )
    `);
  }

  /** Create or reconfigure a job. Preserves the existing next_run_at unless one is given. */
  upsertJob(job: RecurringJob): void {
    const existing = this.sql
      .exec(`SELECT next_run_at FROM recurring_jobs WHERE job_id = ?`, job.jobId)
      .toArray();
    const nextRunAt =
      job.nextRunAt ?? (existing.length > 0 ? Number(existing[0]!["next_run_at"]) : Date.now());
    this.sql.exec(
      `INSERT INTO recurring_jobs (job_id, channel_id, interval_ms, jitter_ms, next_run_at, enabled)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         interval_ms = excluded.interval_ms,
         jitter_ms = excluded.jitter_ms,
         next_run_at = excluded.next_run_at,
         enabled = excluded.enabled`,
      job.jobId,
      job.channelId,
      job.intervalMs,
      job.jitterMs ?? 0,
      nextRunAt,
      job.enabled === false ? 0 : 1
    );
  }

  removeJob(jobId: string): void {
    this.sql.exec(`DELETE FROM recurring_jobs WHERE job_id = ?`, jobId);
  }

  removeChannel(channelId: string): void {
    this.sql.exec(`DELETE FROM recurring_jobs WHERE channel_id = ?`, channelId);
  }

  setEnabled(jobId: string, enabled: boolean): void {
    this.sql.exec(`UPDATE recurring_jobs SET enabled = ? WHERE job_id = ?`, enabled ? 1 : 0, jobId);
  }

  /** Pull a job's next run forward (e.g. user pressed "refresh now"). */
  runNow(jobId: string, now: number): void {
    this.sql.exec(
      `UPDATE recurring_jobs SET next_run_at = ?, backoff_until = NULL WHERE job_id = ?`,
      now,
      jobId
    );
  }

  /** Next pending wake across all enabled jobs, or undefined when idle. */
  nextWakeAt(): number | undefined {
    const rows = this.sql
      .exec(
        `SELECT MIN(MAX(next_run_at, COALESCE(backoff_until, 0))) AS wake
         FROM recurring_jobs WHERE enabled = 1`
      )
      .toArray();
    const wake = rows[0]?.["wake"];
    return wake === null || wake === undefined ? undefined : Number(wake);
  }

  /**
   * Drain all due jobs, then return the earliest pending run.
   * Each job runs in its own try/catch: a failing job gets exponential
   * backoff (`min(cap, 2^failCount * base)`) without disturbing the others,
   * and the caller returns the derived wake to AlarmDriver. Jobs overdue by
   * more than one interval run once and realign
   * to `now + interval` — no catch-up bursts after long sleeps.
   */
  async onAlarm(
    now: number,
    run: (jobId: string, channelId: string) => Promise<void>
  ): Promise<number | undefined> {
    const due = this.sql
      .exec(
        `SELECT job_id, channel_id, interval_ms, jitter_ms, fail_count FROM recurring_jobs
           WHERE enabled = 1 AND next_run_at <= ? AND COALESCE(backoff_until, 0) <= ?
           ORDER BY next_run_at ASC`,
        now,
        now
      )
      .toArray();
    for (const row of due) {
      const jobId = String(row["job_id"]);
      const channelId = String(row["channel_id"]);
      const intervalMs = Number(row["interval_ms"]);
      const jitterMs = Number(row["jitter_ms"] ?? 0);
      try {
        await run(jobId, channelId);
        const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
        this.sql.exec(
          `UPDATE recurring_jobs
             SET next_run_at = ?, fail_count = 0, backoff_until = NULL
             WHERE job_id = ?`,
          now + intervalMs + jitter,
          jobId
        );
      } catch (err) {
        const failCount = Number(row["fail_count"] ?? 0) + 1;
        const backoff = Math.min(
          this.backoffMaxMs,
          Math.pow(2, failCount - 1) * this.backoffBaseMs
        );
        console.error(`[RecurringScheduler] job ${jobId} failed (attempt ${failCount}):`, err);
        this.sql.exec(
          `UPDATE recurring_jobs
             SET fail_count = ?, backoff_until = ?, next_run_at = ?
             WHERE job_id = ?`,
          failCount,
          now + backoff,
          now + backoff,
          jobId
        );
      }
    }
    return this.nextWakeAt();
  }
}
