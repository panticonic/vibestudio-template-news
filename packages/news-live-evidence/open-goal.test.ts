import { expect, it } from "vitest";
import type { NewsCadenceSnapshot, NewsReaderSelection } from "./live.js";
import { bindOpenGoalNews, type OpenNewsWorld } from "./open-goal.js";

const newReader: OpenNewsWorld = {
  id: "new-reader",
  goal: "Find out whether my empty reader is configured.",
  setup: [],
  grants: [],
  outcome: "reviewed",
  applied: [],
  actions: [],
  schedule: [],
  readers: [{ selection: { kind: "inbox" }, code: "preferences-needed" }],
};
const appointment = {
  kind: "daily",
  at: "06:40",
  timezone: "Europe/London",
} as const;
const poll = { kind: "poll", intervalMs: 55 * 60_000 } as const;
const cadenceChange: OpenNewsWorld = {
  id: "concurrent-cadence",
  goal: "Preserve the feed team's edit when moving the briefing.",
  setup: [{ method: "setBriefingPaused", args: { paused: true } }],
  grants: ["briefing"],
  outcome: "changed",
  applied: [appointment],
  actions: [appointment],
  readers: [],
  concurrent: {
    operation: {
      method: "setSchedule",
      args: { pollIntervalMs: poll.intervalMs },
    },
    change: poll,
  },
  schedule: [{ intent: appointment, code: "briefing-confirmed" }],
};

function fixture(world: OpenNewsWorld) {
  const { goal, id: caseId } = world;
  let counter = 0;
  const receipt = () => `receipt-${++counter}`;
  let configured = false;
  const cadence: NewsCadenceSnapshot = {
    owner: { id: "", mode: "curator", paused: false },
    poll: { id: "owned-poll", intervalMs: 1_800_000 },
    briefing: {
      id: "owned-briefing",
      kind: "interval",
      intervalMs: 7_200_000,
      at: null,
      timezone: null,
    },
  };
  const methods: string[] = [];
  const call = async (method: string, args: Record<string, unknown>) => {
    methods.push(method);
    if (method === "news_set_preferences") configured = true;
    if (method === "setBriefingPaused")
      cadence.owner.paused = args["paused"] === true;
    if (method === "setSchedule") {
      if (typeof args["pollIntervalMs"] === "number")
        cadence.poll!.intervalMs = args["pollIntervalMs"];
      if (typeof args["briefingIntervalMs"] === "number")
        cadence.briefing = {
          id: "owned-briefing",
          kind: "interval",
          intervalMs: args["briefingIntervalMs"],
          at: null,
          timezone: null,
        };
      if (
        typeof args["briefingAt"] === "string" &&
        typeof args["timezone"] === "string"
      )
        cadence.briefing = {
          id: "owned-briefing",
          kind: "daily",
          intervalMs: null,
          at: args["briefingAt"],
          timezone: args["timezone"],
        };
    }
    return {
      id: receipt(),
      channelId: "owned-channel",
      participantId: "owned-participant",
      value: {},
    };
  };
  const bound = bindOpenGoalNews(
    { caseId, contextId: "owned-context" },
    world,
    {
      async observeCadence() {
        const readback = structuredClone(cadence);
        readback.owner.id = receipt();
        return readback;
      },
      async readReader(_goal, selection: NewsReaderSelection) {
        return {
          kind: "reader",
          goal,
          view: selection.kind,
          activity: "idle",
          overview: {
            setup: configured ? "configured" : "needs-user-preferences",
            id: receipt(),
            articleCount: 0,
            untriagedCount: 0,
            enabledFeeds: 0,
            failedFeeds: 0,
          },
          pages: [
            {
              id: receipt(),
              requestedCursor: null,
              nextCursor: null,
              hasMore: false,
              articleIds: [],
            },
          ],
        };
      },
      call,
    },
  );
  return {
    ...bound,
    methods,
    async seed() {
      for (const operation of world.setup)
        await call(operation.method, operation.args);
      methods.length = 0;
    },
  };
}

it("qualifies competing owner updates and preserves the newer poll", async () => {
  const harness = fixture(cadenceChange);
  await harness.seed();
  const result = await harness.qualify();
  expect(result.passed, JSON.stringify(result.checks)).toBe(true);
  expect(harness.methods).toEqual(["setSchedule", "setSchedule"]);
  expect(result.attempts.map(({ status }) => status)).toEqual([
    "state-changed",
    "applied",
  ]);
  expect(result.latest.poll?.intervalMs).toBe(poll.intervalMs);
  expect(result.latest.owner.paused).toBe(true);
});

it("does not write with guessed receipt identity or outside the authorized lane", async () => {
  const harness = fixture(cadenceChange);
  await harness.seed();
  const live = await harness.services.newsGoal.observeCadence();
  expect(
    (await harness.services.newsGoal.apply("other-participant", appointment))
      .status,
  ).toBe("state-changed");
  expect(
    (await harness.services.newsGoal.apply(live.owner.id, { kind: "resume" }))
      .status,
  ).toBe("denied");
  expect(harness.methods).toEqual([]);
});

it("requires the current participant evidence for verified reader findings", async () => {
  const harness = fixture(newReader);
  await harness.seed();
  const { newsGoal } = harness.services;
  const cadence = await newsGoal.observeCadence();
  const selection = { kind: "inbox" } as const;
  const evidence = await newsGoal.readReader(selection);
  const report = (id: string) => ({
    status: "workspace-skill-reviewed",
    skill: "news",
    outcome: {
      status: "reviewed",
      cadence,
      schedule: [],
      readers: [
        {
          selection,
          review: {
            status: "waiting",
            findings: [{ code: "preferences-needed", evidenceIds: [id] }],
          },
        },
      ],
    },
  });
  expect((await harness.verify(report(evidence.overview.id))).passed).toBe(
    true,
  );
  expect(
    (await harness.verify(report("other-participant"))).checks
      .verifiedReaderViews,
  ).toBe(false);
});
