import type {
  VcsHistoryResult,
  VcsReadMemoryEpisode,
  VcsReadMemoryResult,
} from "@vibestudio/service-schemas/vcs";

type AttachedReadMemory = Extract<VcsReadMemoryResult, { status: "attached" }>;
type HistoryEntry = VcsHistoryResult["entries"][number];

/** Hard attention budget for the ubiquitous read attachment. */
export const READ_MEMORY_RENDER_BUDGET = 6_000;

const compact = (value: string, limit = 280): string => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
};
const quoted = (value: string): string => JSON.stringify(compact(value));
const root = (value: object): string => JSON.stringify(value);

function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < Math.min(offset, content.length); index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function renderedRanges(content: string, episode: VcsReadMemoryEpisode): string {
  return episode.ranges
    .map(({ start, end }) => {
      const first = lineAt(content, start);
      const last = lineAt(content, Math.max(start, end - 1));
      return first === last ? `${first}` : `${first}-${last}`;
    })
    .join(", ");
}

function salience(episode: VcsReadMemoryEpisode, readingContextId: string): number {
  if (episode.authorContextId === readingContextId) return 4;
  if (episode.arrival) return 0;
  if (episode.stop === "import-boundary" || episode.counteractsChangeIds.length > 0) return 1;
  return episode.intent.tier === "mechanical" ? 3 : 2;
}

interface RenderableEpisode {
  episode: VcsReadMemoryEpisode;
  base: string[];
  composedSecondIntent?: string;
  sourceHeadline?: string;
  rationale?: string;
  commitMessage?: string;
}

function prepareEpisode(
  content: string,
  episode: VcsReadMemoryEpisode,
  readingContextId: string
): RenderableEpisode {
  const range = `● lines ${renderedRanges(content, episode)}`;
  const work = `work unit ${root(episode.workUnit)}`;
  const change = `change ${root(episode.change)}`;
  const why = `${episode.intent.tier}: ${quoted(episode.intent.text)}`;
  if (episode.authorContextId === readingContextId) {
    return { episode, base: [range, "yours", why, work, change] };
  }
  const arrival = episode.arrival;
  const sourceParent = arrival?.parentIntents.find((parent) => parent.role === "source");
  const currentParent = arrival?.parentIntents.find((parent) => parent.role === "current");
  return {
    episode,
    base: [
      range,
      arrival
        ? arrival.mode === "arrived"
          ? `arrived via merge ${root(arrival.decision)}`
          : `accepted as merged truth by ${root(arrival.decision)}`
        : episode.stop === "import-boundary"
          ? "imported from outside workspace history"
          : "authored here",
      why,
      work,
      change,
      ...(episode.counteractsChangeIds.length > 0
        ? [`counteracts ${episode.counteractsChangeIds.join(", ")}`]
        : []),
    ],
    ...(currentParent
      ? {
          composedSecondIntent: `composed with yours ${currentParent.intent.tier}: ${quoted(currentParent.intent.text)}`,
        }
      : {}),
    ...(sourceParent
      ? {
          sourceHeadline: `source ${sourceParent.intent.tier}: ${quoted(sourceParent.intent.text)}`,
        }
      : {}),
    ...(arrival?.rationale ? { rationale: `rationale ${quoted(arrival.rationale)}` } : {}),
    ...(episode.commit?.message
      ? { commitMessage: `committed as ${quoted(episode.commit.message)}` }
      : {}),
  };
}

function episodeText(value: RenderableEpisode): string {
  return [
    ...value.base,
    value.composedSecondIntent,
    value.sourceHeadline,
    value.rationale,
    value.commitMessage,
  ]
    .filter((field): field is string => Boolean(field))
    .join(" · ");
}

function historyText(entry: HistoryEntry): string {
  const intent = entry.intent ? ` · ${entry.intent.tier}: ${quoted(entry.intent.text)}` : "";
  const decision = entry.viaDecisionId ? ` · via decision ${entry.viaDecisionId}` : "";
  return `- ${quoted(entry.summary)}${intent}${decision} · ${root(entry.node)}`;
}

export function renderReadMemoryBlock(input: {
  label: string;
  content: string;
  readingContextId: string;
  startLine: number;
  endLine: number;
  result: AttachedReadMemory;
}): string | null {
  if (input.result.episodes.length === 0 && input.result.history.length === 0) return null;
  const header =
    `workspace memory · why ${input.label} lines ${input.startLine}-${input.endLine} exist · ` +
    "verified against this exact content";
  const footer =
    `dig deeper · provenance({ target: … }) on any subject above · ` +
    `vcs.history with intents for how this file's purpose has drifted`;
  const episodes = input.result.episodes
    .map((episode) => prepareEpisode(input.content, episode, input.readingContextId))
    .sort(
      (left, right) =>
        salience(left.episode, input.readingContextId) -
          salience(right.episode, input.readingContextId) ||
        left.episode.ranges[0]!.start - right.episode.ranges[0]!.start
    );
  let dropped = input.result.truncated;
  const render = (): string =>
    [
      header,
      ...episodes.map(episodeText),
      ...(input.result.history.length > 0
        ? ["earlier file history", ...input.result.history.map(historyText)]
        : []),
      ...(dropped
        ? ["… attachment truncated; use the cursored continuations below for complete coverage"]
        : []),
      footer,
    ].join("\n");
  for (const field of [
    "composedSecondIntent",
    "sourceHeadline",
    "rationale",
    "commitMessage",
  ] as const) {
    for (
      let index = episodes.length - 1;
      render().length > READ_MEMORY_RENDER_BUDGET && index >= 0;
      index -= 1
    ) {
      if (episodes[index]![field]) {
        delete episodes[index]![field];
        dropped = true;
      }
    }
  }
  while (render().length > READ_MEMORY_RENDER_BUDGET && episodes.length > 1) {
    episodes.pop();
    dropped = true;
  }
  return render();
}
