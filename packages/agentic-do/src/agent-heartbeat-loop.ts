/**
 * AgentHeartbeatLoop — a reusable "wake, decide, act" primitive for agent DOs.
 *
 * An agent Durable Object often needs to run autonomously: wake on a cadence
 * and/or when new external data arrives, decide whether anything meaningful
 * changed, and — only if so — drive an agent turn. This module is the generic,
 * domain-agnostic engine for that pattern. Its first user is a training
 * supervisor, but nothing here is training-specific.
 *
 * Design (justified against the existing primitives it composes):
 *
 *  1. Persistence mirrors {@link SuspensionStore}: a plain class over
 *     `SqlStorage` with its own `createTables()`, called by the owner from its
 *     `createTables()`. State {status, cadenceMs, objective, lastWakeAt,
 *     lastObservedDigest} lives in one row and survives DO hibernation/restart.
 *
 *  2. Wake is HYBRID:
 *       (a) a cadence FLOOR registered via injected `scheduleWakeAt`, which
 *           the owner wires to its per-DO alarm multiplexer; and
 *       (b) an event-driven `signal()` the owner calls when new data lands.
 *     Both funnel into the same `tick()`.
 *
 *  3. A MATERIAL-CHANGE GATE bounds cost: before any turn, `tick()` calls the
 *     caller-provided `evaluate(ctx)` predicate. Only if it returns
 *     `action:"prompt" | "continue"` does the loop enqueue a turn. This is a cost gate, NOT an
 *     approval gate.
 *
 *  4. Autonomous turns go through the SAME turn-dispatcher queue as user
 *     messages, via an injected `enqueueTurn` (the owner wires
 *     `dispatcher.submit` / `submitContinue` — see turn-dispatcher.ts:113 and
 *     :184). This makes autonomous and user turns serialize naturally on the
 *     single-open-turn invariant; the loop never invents a parallel turn
 *     mechanism and never double-drives a turn.
 *
 *  5. pause/resume/stop map onto enqueuing, NOT onto the runner: a paused or
 *     stopped loop simply does not enqueue and does not re-arm its cadence
 *     alarm. It deliberately does NOT call agent-worker-base `pause()` /
 *     `interruptRunner()` — that would abort an in-flight user turn. Pausing the
 *     loop pauses autonomy; the agent's own turn lifecycle is untouched. (An
 *     owner that also wants to interrupt a running turn can call its own
 *     `pause()` separately.)
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { AgentTurnContextPolicy } from "@workspace/agent-loop";
import { assertExactSqlTableSchema } from "@workspace/runtime/worker";

export type HeartbeatStatus = "running" | "paused" | "stopped";

/** Persisted loop state. One row per loop (namespaced table). */
export interface HeartbeatState {
  name: string;
  status: HeartbeatStatus;
  cadenceMs: number;
  objective: string;
  nextRunAt: number | null;
  /** Epoch ms of the last time the loop actually drove a turn (0 if never). */
  lastWakeAt: number;
  /**
   * Opaque digest of the observations at the last wake. Lets `evaluate` (or a
   * default gate) cheaply detect "nothing changed since I last acted." Empty
   * string means "no prior observation."
   */
  lastObservedDigest: string;
  lastDecision: string;
  lastActionSummary: string;
  lastError: string;
  failCount: number;
  backoffUntil: number | null;
  configJson: string;
  specHash: string;
}

/** What woke the loop. */
export type HeartbeatTrigger =
  | { kind: "cadence"; scheduledAt?: number }
  | { kind: "signal"; event?: unknown }
  | { kind: "manual"; reason?: string };

/** Context handed to the caller's evaluator. */
export interface HeartbeatEvaluationContext {
  trigger: HeartbeatTrigger;
  state: Readonly<HeartbeatState>;
  now: number;
}

/** The evaluator's decision. */
export interface HeartbeatDecision {
  action: "skip" | "prompt" | "continue";
  /** Diagnostic reason (logged / available to the owner). */
  reason?: string;
  promptText?: string;
  digest?: string;
  silentOk?: boolean;
  delivery?: "none" | "channel" | "last-contact";
  ackToken?: string;
  contextPolicy?: AgentTurnContextPolicy;
  actionSummary?: string;
}

/** Result of a single `tick()`, returned for observability/testing. */
export interface HeartbeatTickResult {
  action: HeartbeatDecision["action"] | "none";
  enqueued: boolean;
  skippedReason?:
    | "paused"
    | "stopped"
    | "backoff"
    | "outside_active_hours"
    | "evaluate_failed"
    | "decision_skip"
    | "in_flight"
    | "no_prompt_text"
    | "enqueue_failed";
  nextRunAt?: number | null;
  decision?: HeartbeatDecision;
  error?: string;
}

export interface AgentHeartbeatLoopDeps {
  sql: SqlStorage;
  namespace?: string;
  scheduleWakeAt: (sourceId: string, timeMs: number) => void | Promise<void>;
  clearWake?: (sourceId: string) => void | Promise<void>;
  evaluate: (ctx: HeartbeatEvaluationContext) => HeartbeatDecision | Promise<HeartbeatDecision>;
  enqueueTurn: (turn: HeartbeatTurnRequest) => void | Promise<void>;
  /**
   * Optional check for an in-flight turn. When it returns true, the loop skips
   * enqueuing (the dispatcher would steer/serialize anyway, but skipping avoids
   * piling up redundant autonomous prompts behind a long turn). The owner wires
   * this to e.g. `dispatcher.getDebugState().busy` or its run-controller phase.
   */
  isTurnInFlight?: () => boolean;
  /** Fallback prompt text when a `prompt` decision omits `promptText`. */
  defaultPromptText?: string;
  failureBackoff?: { baseMs?: number; maxMs?: number };
  now?: () => number;
  log?: Pick<Console, "warn"> & Partial<Pick<Console, "info">>;
}

/** The turn the loop asks the owner to enqueue. */
export type HeartbeatTurnRequest =
  | {
      kind: "prompt";
      promptText: string;
      trigger: HeartbeatTrigger;
      decision: HeartbeatDecision;
    }
  | { kind: "continue"; trigger: HeartbeatTrigger; decision: HeartbeatDecision };

/** Defaults applied when the loop is first started without explicit values. */
export interface HeartbeatStartOptions {
  cadenceMs?: number;
  config?: unknown;
  objective?: string;
  specHash?: string;
}

const DEFAULT_STATE: HeartbeatState = {
  name: "default",
  status: "stopped",
  cadenceMs: 60_000,
  objective: "",
  nextRunAt: null,
  lastWakeAt: 0,
  lastObservedDigest: "",
  lastDecision: "",
  lastActionSummary: "",
  lastError: "",
  failCount: 0,
  backoffUntil: null,
  configJson: "",
  specHash: "",
};

/** Cadence is clamped to a sane floor to avoid hot-looping the alarm driver. */
const MIN_CADENCE_MS = 1_000;
const DEFAULT_BACKOFF_BASE_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MAX_MS = 4 * 60 * 60_000;

export class AgentHeartbeatLoop {
  private readonly table: string;
  private readonly sourceId: string;
  private cache: HeartbeatState | null = null;

  constructor(private readonly deps: AgentHeartbeatLoopDeps) {
    const ns = (deps.namespace ?? "default").replace(/[^a-zA-Z0-9_]/gu, "_");
    this.table = `heartbeat_loop_${ns}`;
    this.sourceId = `heartbeat:${ns}`;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private get log(): Pick<Console, "warn"> & Partial<Pick<Console, "info">> {
    return this.deps.log ?? console;
  }

  /** Create the backing table. Call from the owning DO's `createTables()`. */
  createTables(): void {
    this.sql().exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        cadence_ms INTEGER NOT NULL,
        next_run_at INTEGER,
        objective TEXT NOT NULL,
        last_wake_at INTEGER NOT NULL,
        last_observed_digest TEXT NOT NULL,
        last_decision TEXT NOT NULL,
        last_action_summary TEXT NOT NULL,
        last_error TEXT NOT NULL,
        fail_count INTEGER NOT NULL,
        backoff_until INTEGER,
        config_json TEXT NOT NULL,
        spec_hash TEXT NOT NULL
      )
    `);
    assertExactSqlTableSchema(this.sql(), {
      table: this.table,
      columns: [
        ["id", "INTEGER", false],
        ["name", "TEXT", true],
        ["status", "TEXT", true],
        ["cadence_ms", "INTEGER", true],
        ["next_run_at", "INTEGER", false],
        ["objective", "TEXT", true],
        ["last_wake_at", "INTEGER", true],
        ["last_observed_digest", "TEXT", true],
        ["last_decision", "TEXT", true],
        ["last_action_summary", "TEXT", true],
        ["last_error", "TEXT", true],
        ["fail_count", "INTEGER", true],
        ["backoff_until", "INTEGER", false],
        ["config_json", "TEXT", true],
        ["spec_hash", "TEXT", true],
      ],
      primaryKey: ["id"],
    });
  }

  private sql(): SqlStorage {
    return this.deps.sql;
  }

  // ── Persisted state ───────────────────────────────────────────────────────

  /** Load state from SQL (cached in-memory; reload after external writes). */
  getState(): HeartbeatState {
    if (this.cache) return this.cache;
    const rows = this.sql().exec(`SELECT * FROM ${this.table} WHERE id = 1`).toArray();
    if (rows.length === 0) {
      this.cache = { ...DEFAULT_STATE, name: this.deps.namespace ?? "default" };
      return this.cache;
    }
    const row = rows[0]!;
    this.cache = {
      name: String(row["name"] ?? this.deps.namespace ?? "default"),
      status: row["status"] as HeartbeatStatus,
      cadenceMs: Number(row["cadence_ms"]),
      nextRunAt: nullableNumber(row["next_run_at"]),
      objective: row["objective"] as string,
      lastWakeAt: Number(row["last_wake_at"]),
      lastObservedDigest: row["last_observed_digest"] as string,
      lastDecision: String(row["last_decision"] ?? ""),
      lastActionSummary: String(row["last_action_summary"] ?? ""),
      lastError: String(row["last_error"] ?? ""),
      failCount: Number(row["fail_count"] ?? 0),
      backoffUntil: nullableNumber(row["backoff_until"]),
      configJson: String(row["config_json"] ?? ""),
      specHash: String(row["spec_hash"] ?? ""),
    };
    return this.cache;
  }

  private writeState(state: HeartbeatState): void {
    this.sql().exec(
      `INSERT INTO ${this.table}
         (id, name, status, cadence_ms, next_run_at, objective, last_wake_at,
          last_observed_digest, last_decision, last_action_summary, last_error,
          fail_count, backoff_until, config_json, spec_hash)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         status = excluded.status,
         cadence_ms = excluded.cadence_ms,
         next_run_at = excluded.next_run_at,
         objective = excluded.objective,
         last_wake_at = excluded.last_wake_at,
         last_observed_digest = excluded.last_observed_digest,
         last_decision = excluded.last_decision,
         last_action_summary = excluded.last_action_summary,
         last_error = excluded.last_error,
         fail_count = excluded.fail_count,
         backoff_until = excluded.backoff_until,
         config_json = excluded.config_json,
         spec_hash = excluded.spec_hash`,
      state.name,
      state.status,
      state.cadenceMs,
      state.nextRunAt,
      state.objective,
      state.lastWakeAt,
      state.lastObservedDigest,
      state.lastDecision,
      state.lastActionSummary,
      state.lastError,
      state.failCount,
      state.backoffUntil,
      state.configJson,
      state.specHash
    );
    this.cache = state;
  }

  private patchState(patch: Partial<HeartbeatState>): HeartbeatState {
    const next = { ...this.getState(), ...patch };
    this.writeState(next);
    return next;
  }

  // ── Controls ────────────────────────────────────────────────────────────

  /**
   * Begin (or re-begin) the loop. Sets status=running, applies optional
   * cadence/objective, and arms the first cadence alarm. Idempotent: calling
   * start on an already-running loop just re-arms.
   */
  async start(opts: HeartbeatStartOptions = {}): Promise<void> {
    const current = this.getState();
    const cadenceMs = clampCadence(opts.cadenceMs ?? current.cadenceMs);
    const nextRunAt = this.nextCadenceRunAt(this.now(), cadenceMs, opts.config);
    this.patchState({
      name: this.deps.namespace ?? current.name,
      status: "running",
      cadenceMs,
      nextRunAt,
      objective: opts.objective ?? current.objective,
      ...(opts.config !== undefined ? { configJson: stableJson(opts.config) } : {}),
      ...(opts.specHash !== undefined ? { specHash: opts.specHash } : {}),
    });
    await this.scheduleWake(nextRunAt);
  }

  /** Pause autonomy: no enqueues, cadence alarm cancelled. State preserved. */
  async pause(): Promise<void> {
    if (this.getState().status === "stopped") return;
    this.patchState({ status: "paused", nextRunAt: null });
    await this.clearWake();
  }

  /** Resume from pause: status=running and the cadence alarm is re-armed. */
  async resume(): Promise<void> {
    if (this.getState().status !== "paused") return;
    const nextRunAt = this.nextCadenceRunAt(this.now());
    this.patchState({ status: "running", nextRunAt });
    await this.scheduleWake(nextRunAt);
  }

  /**
   * Stop the loop entirely: cadence alarm cancelled, no enqueues. Unlike pause,
   * `resume()` will not restart a stopped loop — call `start()` again.
   */
  async stop(): Promise<void> {
    this.patchState({ status: "stopped", nextRunAt: null });
    await this.clearWake();
  }

  /** Change the cadence floor and re-arm if running. */
  async setCadence(cadenceMs: number): Promise<void> {
    const nextCadence = clampCadence(cadenceMs);
    const nextRunAt =
      this.getState().status === "running" ? this.nextCadenceRunAt(this.now(), nextCadence) : null;
    this.patchState({ cadenceMs: nextCadence, nextRunAt });
    if (nextRunAt !== null) await this.scheduleWake(nextRunAt);
  }

  /** Change the standing objective (free text the gate/prompt can reference). */
  setObjective(objective: string): void {
    this.patchState({ objective });
  }

  // ── Wake paths ────────────────────────────────────────────────────────────

  /**
   * Cadence wake. The owner calls this from its `alarm()` handler. Re-arms the
   * next cadence alarm (when still running) regardless of the gate outcome, so
   * the heartbeat is self-sustaining.
   */
  async onAlarm(now = this.now()): Promise<HeartbeatTickResult> {
    const scheduledAt = this.getState().nextRunAt ?? undefined;
    const result = await this.tick({ kind: "cadence", scheduledAt }, now);
    if (this.getState().status === "running") await this.armNext(now);
    return result;
  }

  /**
   * Event-driven wake. The owner calls this when new external data arrives.
   * Does NOT re-arm the cadence alarm (the cadence floor is independent of
   * event traffic; the standing alarm still fires on schedule).
   */
  async signal(event?: unknown): Promise<HeartbeatTickResult> {
    return this.tick({ kind: "signal", event }, this.now());
  }

  /** Force a single evaluation now (e.g. an operator "check now" command). */
  async runNow(reason?: string): Promise<HeartbeatTickResult> {
    return this.tick({ kind: "manual", reason }, this.now());
  }

  /**
   * The core gate→enqueue step. Pure of scheduling: callers above decide
   * whether to re-arm. Respects status (no enqueues while paused/stopped).
   */
  private async tick(trigger: HeartbeatTrigger, now: number): Promise<HeartbeatTickResult> {
    const state = this.getState();
    if (state.status === "paused") return this.result("none", false, "paused");
    if (state.status === "stopped") return this.result("none", false, "stopped");

    if (state.backoffUntil !== null && state.backoffUntil > now) {
      await this.scheduleWake(state.backoffUntil);
      return this.result("none", false, "backoff");
    }

    if (!this.isInsideActiveHours(now)) {
      const nextRunAt = this.nextActiveHoursRunAt(now);
      this.patchState({ nextRunAt });
      await this.scheduleWake(nextRunAt);
      return this.result("none", false, "outside_active_hours");
    }

    if (this.skipWhenBusy() && this.deps.isTurnInFlight?.()) {
      return this.result("none", false, "in_flight");
    }

    let decision: HeartbeatDecision;
    try {
      decision = await this.deps.evaluate({ trigger, state, now });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn("[AgentHeartbeatLoop] evaluate threw; treating as no-op:", err);
      this.patchState({
        lastDecision: "evaluate_failed",
        lastError: message,
      });
      return this.result("none", false, "evaluate_failed", undefined, message);
    }

    if (decision.action === "skip") {
      this.patchState({
        ...(decision.digest !== undefined ? { lastObservedDigest: decision.digest } : {}),
        lastDecision: decision.reason ?? "skip",
        lastError: "",
      });
      return this.result("skip", false, "decision_skip", decision);
    }

    let turn: HeartbeatTurnRequest;
    if (decision.action === "continue") {
      turn = { kind: "continue", trigger, decision };
    } else {
      const promptText = decision.promptText ?? this.deps.defaultPromptText;
      if (!promptText) {
        this.log.warn(
          "[AgentHeartbeatLoop] evaluator requested prompt but no promptText/defaultPromptText was available"
        );
        return this.result("prompt", false, "no_prompt_text", decision);
      }
      turn = { kind: "prompt", promptText, trigger, decision };
    }

    this.patchState({
      lastWakeAt: now,
      ...(decision.digest !== undefined ? { lastObservedDigest: decision.digest } : {}),
      lastDecision: decision.reason ?? decision.action,
      lastActionSummary: decision.actionSummary ?? "",
      lastError: "",
    });

    try {
      await this.deps.enqueueTurn(turn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn("[AgentHeartbeatLoop] enqueueTurn failed:", err);
      const backoffUntil = this.nextBackoff(now, state.failCount + 1);
      this.patchState({
        lastError: message,
        failCount: state.failCount + 1,
        backoffUntil,
      });
      await this.scheduleWake(backoffUntil);
      return this.result(decision.action, false, "enqueue_failed", decision, message);
    }
    this.patchState({ failCount: 0, backoffUntil: null });
    return this.result(decision.action, true, undefined, decision);
  }

  // ── Alarm helpers ──────────────────────────────────────────────────────────

  /** Arm the next cadence alarm at now + cadenceMs. */
  private async armNext(now = this.now()): Promise<void> {
    const at = this.nextCadenceRunAt(now);
    this.patchState({ nextRunAt: at });
    await this.scheduleWake(at);
  }

  private async scheduleWake(at: number): Promise<void> {
    await this.deps.scheduleWakeAt(this.sourceId, at);
  }

  private async clearWake(): Promise<void> {
    if (this.deps.clearWake) await this.deps.clearWake(this.sourceId);
  }

  // ── Restart support ─────────────────────────────────────────────────────────

  /**
   * Re-arm after a DO restart. State is already durable; this only re-establishes
   * the in-memory alarm timer association (the alarm row itself is durable in
   * WorkspaceDO, so this is belt-and-suspenders for the running case). Safe to
   * call on every activation.
   */
  async rehydrate(): Promise<void> {
    this.cache = null;
    const state = this.getState();
    if (state.status === "running") {
      const at = state.nextRunAt ?? this.now() + state.cadenceMs;
      this.patchState({ nextRunAt: at });
      await this.scheduleWake(at);
    }
  }

  getDebugState(): HeartbeatState & { table: string; sourceId: string } {
    return { ...this.getState(), table: this.table, sourceId: this.sourceId };
  }

  private nextBackoff(now: number, failCount: number): number {
    const config = this.configObject(this.getState().configJson);
    const configured = heartbeatFailureBackoff(config);
    const base = configured.baseMs ?? this.deps.failureBackoff?.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const max = configured.maxMs ?? this.deps.failureBackoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS;
    const delay = Math.min(max, base * 2 ** Math.max(0, failCount - 1));
    return now + delay;
  }

  recordTurnCompleted(summary?: string): void {
    this.patchState({
      lastActionSummary: summary ?? this.getState().lastActionSummary,
      lastError: "",
      failCount: 0,
      backoffUntil: null,
    });
  }

  async recordTurnFailed(error: string, now = this.now()): Promise<void> {
    const state = this.getState();
    const failCount = state.failCount + 1;
    const backoffUntil = this.nextBackoff(now, failCount);
    this.patchState({
      lastError: error,
      failCount,
      backoffUntil,
    });
    await this.scheduleWake(backoffUntil);
  }

  private result(
    action: HeartbeatTickResult["action"],
    enqueued: boolean,
    skippedReason?: HeartbeatTickResult["skippedReason"],
    decision?: HeartbeatDecision,
    error?: string
  ): HeartbeatTickResult {
    return {
      action,
      enqueued,
      ...(skippedReason ? { skippedReason } : {}),
      nextRunAt: this.getState().nextRunAt,
      ...(decision ? { decision } : {}),
      ...(error ? { error } : {}),
    };
  }

  nextWakeAt(): number | null {
    const state = this.getState();
    if (state.status !== "running") return null;
    const candidates = [state.nextRunAt, state.backoffUntil].filter(
      (value): value is number => typeof value === "number"
    );
    return candidates.length ? Math.min(...candidates) : null;
  }

  private configObject(configJson = this.getState().configJson): Record<string, unknown> | null {
    if (!configJson) return null;
    try {
      const parsed = JSON.parse(configJson) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private nextCadenceRunAt(
    now: number,
    cadenceMs = this.getState().cadenceMs,
    config?: unknown
  ): number {
    const obj =
      config && typeof config === "object"
        ? (config as Record<string, unknown>)
        : this.configObject();
    const atMinutes = parseClock(recordValue(recordValue(obj, "schedule"), "at"));
    let at =
      atMinutes === null
        ? now + clampCadence(cadenceMs)
        : nextAnchoredRunAt(now, clampCadence(cadenceMs), atMinutes);
    const jitterMs = parseDurationMaybe(recordValue(recordValue(obj, "schedule"), "jitter"));
    if (jitterMs !== null && jitterMs > 0) {
      at += Math.floor(Math.random() * (jitterMs + 1));
    }
    return this.adjustForActiveHours(at);
  }

  private isInsideActiveHours(now: number): boolean {
    const window = activeHours(this.configObject());
    if (!window) return true;
    return clockMinutesInside(tzClockMinutes(now, window.timezone), window.start, window.end);
  }

  private nextActiveHoursRunAt(now: number): number {
    return this.adjustForActiveHours(now + 60_000);
  }

  private skipWhenBusy(): boolean {
    return recordValue(recordValue(this.configObject(), "behavior"), "skipWhenBusy") !== false;
  }

  private adjustForActiveHours(at: number): number {
    const window = activeHours(this.configObject());
    if (!window) return at;
    if (clockMinutesInside(tzClockMinutes(at, window.timezone), window.start, window.end)) {
      return at;
    }
    for (let cursor = at + 60_000; cursor <= at + 36 * 60 * 60_000; cursor += 60_000) {
      if (clockMinutesInside(tzClockMinutes(cursor, window.timezone), window.start, window.end)) {
        return cursor;
      }
    }
    return at + 24 * 60 * 60_000;
  }
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function clampCadence(cadenceMs: number): number {
  if (!Number.isFinite(cadenceMs) || cadenceMs < MIN_CADENCE_MS) return MIN_CADENCE_MS;
  return Math.round(cadenceMs);
}

function recordValue(input: unknown, key: string): unknown {
  return input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}

function parseDurationMaybe(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  const scale =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 60 * 60_000
            : 24 * 60 * 60_000;
  return Math.round(amount * scale);
}

function heartbeatFailureBackoff(config: Record<string, unknown> | null): {
  baseMs?: number;
  maxMs?: number;
} {
  const failureBackoff = recordValue(recordValue(config, "behavior"), "failureBackoff");
  const baseMs = parseDurationMaybe(recordValue(failureBackoff, "base"));
  const maxMs = parseDurationMaybe(recordValue(failureBackoff, "max"));
  return {
    ...(baseMs !== null ? { baseMs } : {}),
    ...(maxMs !== null ? { maxMs } : {}),
  };
}

function activeHours(
  config: Record<string, unknown> | null
): { start: number; end: number; timezone: string } | null {
  const raw = recordValue(recordValue(config, "schedule"), "activeHours");
  const start = parseClock(recordValue(raw, "start"));
  const end = parseClock(recordValue(raw, "end"));
  if (start === null || end === null) return null;
  const timezoneRaw = recordValue(raw, "timezone");
  return {
    start,
    end,
    timezone: typeof timezoneRaw === "string" && timezoneRaw ? timezoneRaw : "local",
  };
}

function parseClock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function clockMinutesInside(minutes: number, start: number, end: number): boolean {
  if (start === end) return true;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function tzClockMinutes(epochMs: number, timezone: string): number {
  const date = new Date(epochMs);
  if (timezone === "local") return date.getHours() * 60 + date.getMinutes();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
    return (hour % 24) * 60 + minute;
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

function nextAnchoredRunAt(now: number, cadenceMs: number, atMinutes: number): number {
  const date = new Date(now);
  const anchored = new Date(date);
  anchored.setHours(Math.floor(atMinutes / 60), atMinutes % 60, 0, 0);
  let at = anchored.getTime();
  while (at <= now) at += cadenceMs;
  return at;
}
