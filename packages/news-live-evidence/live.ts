import { rpc } from "@workspace/runtime";
import { connectViaRpc } from "@workspace/pubsub";
import { unwrapChatMethodResult } from "@workspace/agentic-core";
import { createMissionsClient } from "@vibestudio/service-schemas/clients/missionsClient";
import {
  captureNewsReaderReadback,
  NEWS_METHODS,
  newsOverviewResultSchema,
} from "@workspace/feeds";

import type {
  NewsCadenceChange,
  NewsLiveCheck,
  NewsLiveRequest,
  NewsReview,
  NewsReaderEvidence,
  NewsScheduleEvidence,
} from "../../skills/news-workflows/types.js";

type Assignment = {
  contextId: string;
  channelId: string;
  channelTargetId: string;
  participantId: string;
  agentKey: string;
};
type Expected = { status: NewsReview["status"]; code: string };
type Operation = {
  method: "news_set_preferences" | "setSchedule" | "setBriefingPaused";
  args: Record<string, unknown>;
};
type World = {
  id: string;
  goal: string;
  checks: NewsLiveCheck[];
  expected: Expected[];
  setup: Operation[];
  repair?: { index: number; before: string; write: boolean };
};

const missions = () => createMissionsClient(rpc);
function newsOwners(assignment: Assignment) {
  const prefix = `news:${assignment.agentKey}:${assignment.channelId}:`;
  return Promise.all([
    missions().getDefault(prefix + "poll"),
    missions().getDefault(prefix + "briefing"),
  ]);
}

export async function retireNewsOwners(assignment: Assignment) {
  const owners = await newsOwners(assignment);
  const client = missions();
  const results = await Promise.allSettled(
    owners.flatMap((owner) => (owner ? [client.retire(owner.missionId)] : [])),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      "Could not retire the owned News schedules",
    );
  return (await newsOwners(assignment)).every(
    (owner) => owner === null || owner.state === "retired",
  );
}

export function prepareLiveNews(assignment: Assignment, world: World) {
  const { contextId, channelId, channelTargetId, participantId } = assignment;
  const client = connectViaRpc({
    rpc,
    contextId,
    channel: channelId,
    channelTargetId,
    name: "News workflow harness",
    type: "worker",
    replayMode: "collect",
    deliveryMode: "resident",
  });
  type Observation = NewsReaderEvidence | NewsScheduleEvidence;
  let started = false;
  let initial: Observation[] | undefined;
  let observed: Observation[] | undefined;
  let finished = false;
  let repairReceipt:
    | { change: NewsCadenceChange; id: string | null }
    | undefined;
  const repair = world.repair;
  const request: NewsLiveRequest = {
    kind: "live",
    goal: world.goal,
    checks: world.checks,
    ...(repair ? { changeIndex: repair.index } : {}),
  };
  async function call(method: string, args: Record<string, unknown>) {
    const timeout = AbortSignal.timeout(20_000);
    await client.ready(timeout);
    if (client.contextId !== contextId)
      throw new Error("News transport is bound to another context");
    const id = crypto.randomUUID();
    const value = unwrapChatMethodResult(
      await client.callMethod(participantId, method, args, {
        transportCallId: id,
        signal: timeout,
      }).result,
    );
    if (value && typeof value === "object" && "error" in value)
      throw new Error(String(value.error));
    return {
      channelId,
      participantId,
      id,
      value,
    };
  }

  async function readState() {
    const observations: Observation[] = [];
    for (const check of world.checks) {
      if (check.kind === "reader") {
        const view =
          check.view === "archive"
            ? { kind: check.view, query: check.query }
            : { kind: check.view, cursors: [null] };
        observations.push(
          await captureNewsReaderReadback(assignment, call, world.goal, view),
        );
        continue;
      }
      const [poll, briefing] = await newsOwners(assignment);
      const receipt = await call(NEWS_METHODS.getOverview, {});
      const { setup } = newsOverviewResultSchema.parse(receipt.value);
      const trigger = briefing?.charter.trigger;
      const daily =
        trigger?.kind === "cron"
          ? /^(\d+) (\d+) \* \* \*$/u.exec(trigger.expression)
          : null;
      const at = daily
        ? `${daily[2]!.padStart(2, "0")}:${daily[1]!.padStart(2, "0")}`
        : null;
      const minutes = daily
        ? Number(daily[2]) * 60 + Number(daily[1])
        : undefined;
      const pollTrigger = poll?.charter.trigger;
      const expectedPoll =
        pollTrigger?.kind === "schedule" ? pollTrigger.everyMs : undefined;
      const expectedInterval =
        trigger?.kind === "schedule" ? trigger.everyMs : undefined;
      if (
        setup.pollIntervalMs !== expectedPoll ||
        setup.briefingIntervalMs !== expectedInterval ||
        setup.briefingAtMinutes !== minutes ||
        setup.briefingPaused !== (!briefing || briefing.state !== "active") ||
        setup.timezone !==
          (trigger?.kind === "cron" ? trigger.timezone : undefined)
      )
        throw new Error("News overview and the exact Missions owners disagree");
      observations.push({
        kind: "schedule",
        goal: world.goal,
        intent: check.intent,
        owner: {
          id: receipt.id,
          paused: setup.briefingPaused,
          mode: "curator",
        },
        poll:
          poll && expectedPoll !== undefined
            ? { id: poll.missionId, intervalMs: expectedPoll }
            : null,
        briefing:
          briefing && trigger?.kind === "schedule"
            ? {
                id: briefing.missionId,
                kind: "interval",
                intervalMs: trigger.everyMs,
                at: null,
                timezone: null,
              }
            : briefing && trigger?.kind === "cron" && at
              ? {
                  id: briefing.missionId,
                  kind: "daily",
                  intervalMs: null,
                  at,
                  timezone: trigger.timezone,
                }
              : null,
      });
    }
    return observations;
  }

  async function observe() {
    if (started) throw new Error("Read the assigned News state once");
    started = true;
    initial = await readState();
    if (!repair) observed = initial;
    return structuredClone(initial);
  }

  function projection(change: NewsCadenceChange) {
    switch (change?.kind) {
      case "poll":
        return {
          method: NEWS_METHODS.setSchedule,
          args: { pollIntervalMs: change.intervalMs },
        };
      case "interval":
        return {
          method: NEWS_METHODS.setSchedule,
          args: { briefingIntervalMs: change.intervalMs },
        };
      case "daily":
        return {
          method: NEWS_METHODS.setSchedule,
          args: { briefingAt: change.at, timezone: change.timezone },
        };
      case "pause":
      case "resume":
        return {
          method: NEWS_METHODS.setBriefingPaused,
          args: { paused: change.kind === "pause" },
        };
      default:
        return null;
    }
  }

  function assignedChange(): NewsCadenceChange {
    if (!repair) return null;
    const check = world.checks[repair.index];
    if (check?.kind !== "schedule" || check.intent.kind === "manual")
      throw new Error("Cadence repair requires an authorized schedule intent");
    return check.intent;
  }

  async function finishCadence(change: NewsCadenceChange) {
    if (!repair || !initial || finished)
      throw new Error(
        "Cadence reconciliation requires a fresh assigned observation",
      );
    const operation = projection(change);
    if (
      change !== null &&
      (!operation ||
        JSON.stringify(operation) !==
          JSON.stringify(projection(assignedChange())))
    )
      throw new Error("Cadence choice exceeds the assigned change");
    finished = true;
    const receipt = operation
      ? await call(operation.method, operation.args)
      : null;
    observed = await readState();
    repairReceipt = {
      change: change === null ? null : assignedChange(),
      id: receipt?.id ?? null,
    };
    return structuredClone(observed);
  }

  function reference(): NewsReview {
    if (!observed || observed.length !== world.expected.length)
      throw new Error("Missing News observations");
    const findings = observed.map((evidence, index) => {
      const { code } = world.expected[index]!;
      const id =
        evidence.kind === "reader"
          ? code === "empty-loaded-view"
            ? evidence.pages[0]?.id
            : evidence.overview.id
          : code === "poll-confirmed" || code === "poll-mismatch"
            ? evidence.poll?.id
            : code === "briefing-confirmed" || code === "briefing-mismatch"
              ? evidence.briefing?.id
              : evidence.owner.id;
      if (!id) throw new Error(`News observation lacks evidence for ${code}`);
      return { code, evidenceIds: [id] };
    });
    const statuses = new Set(world.expected.map(({ status }) => status));
    const order = ["blocked", "attention", "waiting", "ready"] as const;
    return {
      status: order.find((status) => statuses.has(status)) ?? "ready",
      findings,
    };
  }
  function matchesState(evidence: Observation, code: string | undefined) {
    if (evidence.kind === "reader") {
      return (
        evidence.pages.length === 1 &&
        evidence.overview.articleCount === 0 &&
        evidence.pages[0]?.articleIds.length === 0 &&
        evidence.overview.setup ===
          (code === "preferences-needed"
            ? "needs-user-preferences"
            : "configured")
      );
    }
    const { intent, poll, briefing, owner } = evidence;
    switch (intent.kind) {
      case "manual":
        return code === "manual-available" && owner.paused;
      case "pause":
        return (
          code === (owner.paused ? "pause-confirmed" : "pause-state-mismatch")
        );
      case "resume":
        return (
          code === (owner.paused ? "pause-state-mismatch" : "resume-confirmed")
        );
      case "poll":
        return code === "poll-interval-too-short"
          ? intent.intervalMs < 60_000
          : poll !== null &&
              (poll.intervalMs === intent.intervalMs) ===
                (code === "poll-confirmed");
      case "interval":
        return code === "briefing-interval-too-short"
          ? intent.intervalMs < 600_000
          : briefing !== null &&
              (briefing.kind === "interval" &&
                briefing.intervalMs === intent.intervalMs) ===
                (code === "briefing-confirmed");
      case "daily":
        return (
          briefing !== null &&
          (briefing.kind === "daily" &&
            briefing.at === intent.at &&
            briefing.timezone === intent.timezone) ===
            (code === "briefing-confirmed")
        );
    }
  }

  function matchesRepair() {
    if (!repair) return true;
    const before = initial?.[repair.index];
    const after = observed?.[repair.index];
    if (
      before?.kind !== "schedule" ||
      after?.kind !== "schedule" ||
      !repairReceipt ||
      !matchesState(before, repair.before) ||
      before.owner.id === after.owner.id ||
      before.poll?.id !== after.poll?.id ||
      before.briefing?.id !== after.briefing?.id
    )
      return false;
    const change = repairReceipt.change;
    return (
      repair.write === Boolean(repairReceipt.id) &&
      (change?.kind === "poll" ||
        before.poll?.intervalMs === after.poll?.intervalMs) &&
      (change?.kind === "daily" ||
        change?.kind === "interval" ||
        JSON.stringify(before.briefing) === JSON.stringify(after.briefing)) &&
      (change?.kind === "pause" ||
        change?.kind === "resume" ||
        before.owner.paused === after.owner.paused)
    );
  }

  function verify(report: NewsReview | null) {
    const expected = observed ? reference() : null;
    const checks = {
      matchesReport: Boolean(
        expected &&
        report?.status === expected.status &&
        Array.isArray(report.findings) &&
        report.findings.length === expected.findings.length &&
        expected.findings.every(({ code, evidenceIds }, index) => {
          const actual = report.findings[index];
          return (
            actual?.code === code &&
            JSON.stringify(actual.evidenceIds) === JSON.stringify(evidenceIds)
          );
        }),
      ),
      matchesState:
        observed?.every((evidence, index) =>
          matchesState(evidence, world.expected[index]?.code),
        ) === true,
      ...(repair ? { matchesRepair: matchesRepair() } : {}),
    };
    return {
      caseId: world.id,
      assignment,
      observed,
      ...(repair
        ? {
            repair: { before: initial?.[repair.index], receipt: repairReceipt },
          }
        : {}),
      expected,
      checks,
      passed: Object.values(checks).every(Boolean),
    };
  }
  return {
    request,
    services: { newsRead: { observe, finishCadence } },
    async qualify() {
      await observe();
      if (repair) await finishCadence(repair.write ? assignedChange() : null);
      return reference();
    },
    reference,
    verify,
    async seed() {
      for (const operation of world.setup)
        await call(operation.method, operation.args);
    },
    close: () => client.close(),
  };
}
