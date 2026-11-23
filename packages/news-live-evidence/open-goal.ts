import { isDeepStrictEqual } from "node:util";
import {
  newsCadenceOperation,
  openNewsTransport,
  type NewsOwner,
  type NewsSeedOperation,
  type NewsCadenceSnapshot,
  type NewsGoalApply,
  type NewsGoalChange,
  type NewsReaderEvidence,
  type NewsReaderSelection,
  type NewsReview,
  type NewsScheduleIntent,
  type NewsUserGoalReport,
} from "./live.js";

type NewsInput = NewsOwner & { caseId: string };
export type OpenNewsWorld = {
  id: string;
  goal: string;
  setup: NewsSeedOperation[];
  grants: ("poll" | "briefing" | "pause")[];
  outcome: NewsUserGoalReport["status"];
  applied: NewsScheduleIntent[];
  actions: NewsScheduleIntent[];
  concurrent?: { operation: NewsSeedOperation; change: NewsScheduleIntent };
  schedule: { intent: NewsScheduleIntent; code: string }[];
  readers: { selection: NewsReaderSelection; code: string }[];
};

type Port = Pick<
  ReturnType<typeof openNewsTransport>,
  "observeCadence" | "readReader"
> & {
  call(method: string, args: Record<string, unknown>): Promise<{ id: string }>;
};
type Attempt = {
  observationId: string;
  change: NewsGoalChange;
  status: NewsGoalApply["status"];
  receipt: string | null;
};
type Read = { selection: NewsReaderSelection; evidence: NewsReaderEvidence };
type Outcome = NewsUserGoalReport;

const cadenceState = (snapshot: NewsCadenceSnapshot) => ({
  mode: snapshot.owner.mode,
  paused: snapshot.owner.paused,
  poll: snapshot.poll,
  briefing: snapshot.briefing,
});
const sameCadence = (left: NewsCadenceSnapshot, right: NewsCadenceSnapshot) =>
  isDeepStrictEqual(cadenceState(left), cadenceState(right));

function matchesSeed(cadence: NewsCadenceSnapshot, setup: NewsSeedOperation[]) {
  const expected: Record<string, unknown> = Object.assign(
    {},
    ...setup
      .filter(({ method }) => method !== "news_set_preferences")
      .map(({ args }) => args),
  );
  return (
    (expected["pollIntervalMs"] === undefined ||
      cadence.poll?.intervalMs === expected["pollIntervalMs"]) &&
    (expected["briefingIntervalMs"] === undefined ||
      cadence.briefing?.intervalMs === expected["briefingIntervalMs"]) &&
    (expected["briefingAt"] === undefined ||
      cadence.briefing?.at === expected["briefingAt"]) &&
    (expected["timezone"] === undefined ||
      cadence.briefing?.timezone === expected["timezone"]) &&
    (expected["paused"] === undefined ||
      cadence.owner.paused === expected["paused"])
  );
}

const grantFor = (change: NewsGoalChange) =>
  change.kind === "poll"
    ? "poll"
    : change.kind === "interval" || change.kind === "daily"
      ? "briefing"
      : "pause";

function permitsChange(change: NewsScheduleIntent): change is NewsGoalChange {
  switch (change?.kind) {
    case "poll":
      return (
        Number.isSafeInteger(change.intervalMs) && change.intervalMs >= 60_000
      );
    case "interval":
      return (
        Number.isSafeInteger(change.intervalMs) && change.intervalMs >= 600_000
      );
    case "daily":
      return (
        /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(change.at) &&
        typeof change.timezone === "string" &&
        change.timezone.trim() !== ""
      );
    case "pause":
    case "resume":
      return true;
    default:
      return false;
  }
}

function intendedCadence(
  snapshot: NewsCadenceSnapshot,
  change: NewsScheduleIntent,
) {
  const next = structuredClone(snapshot);
  switch (change.kind) {
    case "poll":
      if (next.poll) next.poll.intervalMs = change.intervalMs;
      break;
    case "interval":
      if (next.briefing)
        next.briefing = {
          id: next.briefing.id,
          kind: "interval",
          intervalMs: change.intervalMs,
          at: null,
          timezone: null,
        };
      break;
    case "daily":
      if (next.briefing)
        next.briefing = {
          id: next.briefing.id,
          kind: "daily",
          intervalMs: null,
          at: change.at,
          timezone: change.timezone,
        };
      break;
    case "pause":
    case "resume":
      next.owner.paused = change.kind === "pause";
      break;
  }
  return next;
}

const finding = (
  status: NewsReview["status"],
  code: string,
  id: string,
): NewsReview => ({ status, findings: [{ code, evidenceIds: [id] }] });

function scheduleReview(
  cadence: NewsCadenceSnapshot,
  intent: NewsScheduleIntent,
): NewsReview {
  const { owner, poll, briefing } = cadence;
  switch (intent.kind) {
    case "poll":
      if (!permitsChange(intent))
        return finding("blocked", "poll-interval-too-short", owner.id);
      if (!poll) return finding("waiting", "poll-unobserved", owner.id);
      return poll.intervalMs === intent.intervalMs
        ? finding("ready", "poll-confirmed", poll.id)
        : finding("attention", "poll-mismatch", poll.id);
    case "interval":
    case "daily":
      if (intent.kind === "interval" && !permitsChange(intent))
        return finding("blocked", "briefing-interval-too-short", owner.id);
      if (!briefing) return finding("waiting", "briefing-unobserved", owner.id);
      return isDeepStrictEqual(
        intendedCadence(cadence, intent).briefing,
        briefing,
      )
        ? finding("ready", "briefing-confirmed", briefing.id)
        : finding("attention", "briefing-mismatch", briefing.id);
    case "pause":
    case "resume":
      return owner.paused === (intent.kind === "pause")
        ? finding(
            "ready",
            intent.kind === "pause" ? "pause-confirmed" : "resume-confirmed",
            owner.id,
          )
        : finding("attention", "pause-state-mismatch", owner.id);
    case "manual":
      return finding("ready", "manual-available", owner.id);
  }
}

function readerReview(evidence: NewsReaderEvidence): NewsReview | null {
  if (evidence.overview.setup === "needs-user-preferences")
    return finding("waiting", "preferences-needed", evidence.overview.id);
  const [page] = evidence.pages;
  if (
    evidence.pages.length !== 1 ||
    !page ||
    page.requestedCursor !== null ||
    page.hasMore ||
    page.articleIds.length ||
    page.briefingIds?.length
  )
    return null;
  return finding("ready", "empty-loaded-view", page.id);
}

export function bindOpenGoalNews(
  input: Pick<NewsInput, "contextId" | "caseId">,
  world: OpenNewsWorld,
  port: Port,
) {
  const { caseId, contextId } = input;
  const { goal } = world;
  const observations: NewsCadenceSnapshot[] = [];
  const reads: Read[] = [];
  const attempts: Attempt[] = [];
  let concurrentReceipt: string | null = null;
  let busy = false;
  let reading: Promise<NewsCadenceSnapshot> | undefined;
  async function captureCadence() {
    const snapshot = await port.observeCadence();
    observations.push(structuredClone(snapshot));
    return snapshot;
  }
  const services = {
    newsGoal: {
      observeCadence: () => {
        reading ??= captureCadence().finally(()=>{reading=undefined});
        return reading.then(snapshot=>structuredClone(snapshot));
      },
      async readReader(selection: NewsReaderSelection) {
        if (
          !selection ||
          !["inbox", "saved", "backlog", "archive"].includes(selection.kind) ||
          (selection.kind === "archive" &&
            (typeof selection.query !== "string" ||
              !selection.query.trim() ||
              selection.query.length > 400))
        )
          throw new Error(
            "Select an installed News reader view and supply an archive query when needed",
          );
        const evidence = await port.readReader(goal, selection);
        reads.push(structuredClone({ selection, evidence }));
        return evidence;
      },
      async apply(
        observationId: string,
        change: NewsGoalChange,
      ): Promise<NewsGoalApply> {
        if (busy)
          throw new Error(
            "Await the active News cadence change before applying a second change",
          );
        busy = true;
        try {
          const previous = observations.find(row=>row.owner.id===observationId);
          const authorized =
            permitsChange(change) && world.grants.includes(grantFor(change));
          if (
            authorized &&
            previous?.owner.id === observationId &&
            world.concurrent &&
            !concurrentReceipt
          ) {
            const { operation } = world.concurrent;
            concurrentReceipt = (
              await port.call(operation.method, operation.args)
            ).id;
          }
          const cadence = await captureCadence();
          const attempt: Attempt = {
            observationId,
            change: structuredClone(change),
            status: "denied",
            receipt: null,
          };
          attempts.push(attempt);
          if (!authorized) return { status: attempt.status, cadence };
          if (
            !previous ||
            previous.owner.id !== observationId ||
            !sameCadence(previous, cadence)
          ) {
            attempt.status = "state-changed";
            return { status: attempt.status, cadence };
          }
          if (sameCadence(cadence, intendedCadence(cadence, change))) {
            attempt.status = "unchanged";
            return { status: attempt.status, cadence };
          }
          const operation = newsCadenceOperation(change);
          if (!operation) return { status: attempt.status, cadence };
          const reply = await port.call(operation.method, operation.args);
          const after = await captureCadence();
          attempt.status = "applied";
          attempt.receipt = reply.id;
          return { status: attempt.status, cadence: after };
        } finally {
          busy = false;
        }
      },
    },
  };

  async function verify(value: unknown) {
    const envelope = value as Outcome | null;
    const report =
      envelope;
    const latest = await port.observeCadence();
    const [initial] = observations;
    const expectedChanges = world.concurrent
      ? [world.concurrent.change, ...world.applied]
      : world.applied;
    const expectedState = expectedChanges.reduce<
      NewsCadenceSnapshot | undefined
    >(
      (cadence, change) => cadence && intendedCadence(cadence, change),
      initial,
    );
    const scheduled = Array.isArray(report?.schedule) ? report.schedule : [];
    const readers = Array.isArray(report?.readers) ? report.readers : [];
    const applied = attempts.filter((entry) => entry.status === "applied");
    const checks = {
      readCurrentNews: Boolean(
        initial &&
        report?.cadence &&
        observations.some((value) =>
          isDeepStrictEqual(value, report.cadence),
        ) &&
        sameCadence(report.cadence, latest),
      ),
      verifiedCadence: Boolean(
        initial &&
        matchesSeed(initial, world.setup) &&
        expectedState &&
        sameCadence(expectedState, latest),
      ),
      verifiedReaderViews:
        readers.length === world.readers.length &&
        world.readers.every(({ selection, code }) =>
          readers.some(
            (entry) =>
              isDeepStrictEqual(entry?.selection, selection) &&
              reads.some((read) => {
                const actual = readerReview(read.evidence);
                return (
                  isDeepStrictEqual(read.selection, selection) &&
                  actual?.findings[0]?.code === code &&
                  isDeepStrictEqual(entry.review, actual)
                );
              }),
          ),
        ),
      groundedScheduleFindings:
        scheduled.every((entry) => {
          if (!entry?.intent) return false;
          const current = scheduleReview(latest, entry.intent);
          return (
            current &&
            entry.review?.status === current.status &&
            entry.review?.findings?.[0]?.code === current.findings[0]?.code &&
            observations.some((value) =>
              isDeepStrictEqual(
                entry.review,
                scheduleReview(value, entry.intent),
              ),
            )
          );
        }) &&
        world.schedule.every(({ intent, code }) =>
          scheduled.some(
            (entry) =>
              isDeepStrictEqual(entry?.intent, intent) &&
              entry.review?.findings?.[0]?.code === code,
          ),
        ),
      verifiedAuthorizedChanges:
        applied.every((entry) => Boolean(entry.receipt) && permitsChange(entry.change) &&
          world.grants.includes(grantFor(entry.change))) &&
        (!world.concurrent || Boolean(concurrentReceipt)),
      reportedDisposition: report?.status === world.outcome,
    };
    return {
      goal,
      caseId,
      contextId,
      initial,
      latest,
      observations,
      reads,
      attempts,
      concurrentReceipt,
      checks,
      passed: Object.values(checks).every(Boolean),
    };
  }

  async function qualify() {
    let cadence = await services.newsGoal.observeCadence();
    const readers: NewsUserGoalReport["readers"] = [];
    const schedule: NewsUserGoalReport["schedule"] = [];
    const starting = cadence;
    for (const action of world.actions) {
      if (
        permitsChange(action) &&
        !sameCadence(cadence, intendedCadence(cadence, action))
      ) {
        let result = await services.newsGoal.apply(cadence.owner.id, action);
        if (result.status === "state-changed")
          result = await services.newsGoal.apply(
            result.cadence.owner.id,
            action,
          );
        if (result.status !== "applied")
          throw new Error(`Cannot apply News reference: ${result.status}`);
        cadence = result.cadence;
      }
    }
    for (const { selection } of world.readers) {
      const evidence = await services.newsGoal.readReader(selection);
      const review = readerReview(evidence);
      if (!review)
        throw new Error(
          "Reference News reader state does not match any supported finding",
        );
      readers.push({ selection, review });
    }
    for (const { intent } of world.schedule)
      schedule.push({ intent, review: scheduleReview(cadence, intent) });
    const status = world.actions.some((action) => !permitsChange(action))
      ? "blocked"
      : sameCadence(starting, cadence)
        ? "reviewed"
        : "changed";
    return verify({
        status,
        cadence,
        readers,
        schedule,
      } satisfies Outcome);
  }

  return { goal, services, verify, qualify };
}

export async function prepareOpenGoalNews(
  input: NewsInput,
  world: OpenNewsWorld,
) {
  if (world.id !== input.caseId)
    throw new Error("Open News goal belongs to another case");
  const transport = openNewsTransport(input);
  try {
    for (const operation of world.setup)
      await transport.call(operation.method, operation.args);
    return {
      ...bindOpenGoalNews(input, world, transport),
      close: transport.close,
    };
  } catch (error) {
    await transport.close();
    throw error;
  }
}
