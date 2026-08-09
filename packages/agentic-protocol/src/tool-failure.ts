import { z } from "zod";

export const AGENT_TOOL_FAILURE_PROTOCOL = "agent-tool-failure.v1" as const;

export const AGENT_TOOL_FAILURE_KINDS = [
  "invalid-input",
  "not-found",
  "conflict",
  "authority",
  "external-effect",
  "integrity",
  "infrastructure",
  "cancelled",
  "unknown",
] as const;

export const AGENT_TOOL_RETRY_POLICIES = [
  "none",
  "correct-input",
  "reobserve",
  "retry-identical",
  "request-approval",
] as const;

const MAX_FAILURE_DATA_BYTES = 4 * 1024;

const causalIdsSchema = z
  .object({
    invocationId: z.string().min(1).optional(),
    commandId: z.string().min(1).optional(),
    effectId: z.string().min(1).optional(),
    contextId: z.string().min(1).optional(),
    receiptDigest: z.string().min(1).optional(),
  })
  .strict();

const failureCauseSchema = z
  .object({
    role: z.enum(["primary", "cleanup", "rollback", "transport"]),
    code: z.string().min(1),
    message: z.string().min(1),
    data: z.unknown().optional(),
  })
  .strict();

export const agentToolFailureSchema = z
  .object({
    protocol: z.literal(AGENT_TOOL_FAILURE_PROTOCOL),
    code: z.string().min(1),
    kind: z.enum(AGENT_TOOL_FAILURE_KINDS),
    message: z.string().min(1),
    operation: z.string().min(1),
    stage: z.string().min(1),
    retry: z
      .object({
        policy: z.enum(AGENT_TOOL_RETRY_POLICIES),
        commandIdPolicy: z
          .enum(["reuse-identical", "use-new-after-reobserve", "not-applicable"])
          .optional(),
        afterMs: z.number().int().nonnegative().optional(),
      })
      .strict(),
    causal: causalIdsSchema.optional(),
    causes: z.array(failureCauseSchema).min(1),
    data: z.unknown().optional(),
  })
  .strict();

export type AgentToolFailure = z.infer<typeof agentToolFailureSchema>;
export type AgentToolFailureKind = AgentToolFailure["kind"];
export type AgentToolRetryPolicy = AgentToolFailure["retry"]["policy"];

export class AgentToolFailureError extends Error {
  readonly failure: AgentToolFailure;
  readonly errorData: AgentToolFailure;
  readonly code: string;

  constructor(failure: AgentToolFailure, cause?: unknown) {
    super(failure.message, cause === undefined ? undefined : { cause });
    this.name = "AgentToolFailureError";
    this.failure = agentToolFailureSchema.parse(failure);
    this.errorData = this.failure;
    this.code = this.failure.code;
  }
}

const CODE_KIND: ReadonlyArray<[RegExp, AgentToolFailureKind]> = [
  [/cancel|abort|deadline|timeout/i, "cancelled"],
  [/integrity|corrupt|digest|mismatch/i, "integrity"],
  [/invalid|malformed|schema|argument|input/i, "invalid-input"],
  [/unauthor|access|acquire|approval|credential|permission|grant/i, "authority"],
  [/external.?effect|network|egress|fetch|clone|push/i, "external-effect"],
  [/revision|conflict|occupied|working.?changes|dependency.?blocked/i, "conflict"],
  [/not.?found|missing|invalid.?reference/i, "not-found"],
  [/infrastructure|runtime|dispatch|transport|unavailable|restarted/i, "infrastructure"],
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : (nonempty(record(error)?.["message"]) ?? String(error));
}

function errorCode(error: unknown, data: Record<string, unknown> | null): string {
  return (
    nonempty(data?.["code"]) ??
    nonempty(record(error)?.["code"]) ??
    nonempty(record(error)?.["failureCode"]) ??
    "unknown_tool_failure"
  );
}

function boundedFailureData(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json).byteLength;
    if (bytes <= MAX_FAILURE_DATA_BYTES) return value;
    return {
      protocol: "agent-tool-failure-data-summary.v1",
      truncated: true,
      originalBytes: bytes,
      preview: json.slice(0, 2 * 1024),
    };
  } catch {
    return {
      protocol: "agent-tool-failure-data-summary.v1",
      truncated: true,
      originalBytes: null,
      preview: String(value).slice(0, 2 * 1024),
    };
  }
}

function kindFor(code: string, message: string): AgentToolFailureKind {
  const candidate = `${code} ${message}`;
  return CODE_KIND.find(([pattern]) => pattern.test(candidate))?.[1] ?? "unknown";
}

function retryFor(
  kind: AgentToolFailureKind,
  data: Record<string, unknown> | null
): AgentToolFailure["retry"] {
  const explicit = record(data?.["retry"]);
  const policy = explicit?.["commandIdPolicy"];
  if (policy === "reuse-identical-only-if-outcome-uncertain") {
    return { policy: "retry-identical", commandIdPolicy: "reuse-identical" };
  }
  if (policy === "reobserve-status-and-use-new-command") {
    return { policy: "reobserve", commandIdPolicy: "use-new-after-reobserve" };
  }
  switch (kind) {
    case "invalid-input":
    case "not-found":
      return { policy: "correct-input", commandIdPolicy: "not-applicable" };
    case "conflict":
      return { policy: "reobserve", commandIdPolicy: "use-new-after-reobserve" };
    case "authority":
      return { policy: "request-approval", commandIdPolicy: "not-applicable" };
    case "external-effect":
      return { policy: "retry-identical", commandIdPolicy: "reuse-identical" };
    default:
      return { policy: "none", commandIdPolicy: "not-applicable" };
  }
}

function secondaryCauses(data: Record<string, unknown> | null): AgentToolFailure["causes"] {
  if (!data) return [];
  const config = record(data["config"]);
  const candidates: Array<[unknown, AgentToolFailure["causes"][number]["role"]]> = [
    [data["cleanupFailure"], "cleanup"],
    [data["cleanupError"], "cleanup"],
    [data["rollbackFailure"], "rollback"],
    [config?.["rollbackFailure"], "rollback"],
    [data["transportFailure"], "transport"],
  ];
  return candidates.flatMap(([value, role]) => {
    if (value === undefined) return [];
    const detail = record(value);
    return [
      {
        role,
        code: nonempty(detail?.["code"]) ?? `${role}_failed`,
        message: nonempty(detail?.["message"]) ?? errorMessage(value),
        data: boundedFailureData(value),
      },
    ];
  });
}

export function isAgentToolFailure(value: unknown): value is AgentToolFailure {
  return agentToolFailureSchema.safeParse(value).success;
}

export function agentToolFailureFromUnknown(
  error: unknown,
  context: {
    operation: string;
    stage: string;
    causal?: AgentToolFailure["causal"];
    kind?: AgentToolFailureKind;
    retry?: AgentToolFailure["retry"];
  }
): AgentToolFailure {
  const existing =
    record(error)?.["failure"] ??
    (isAgentToolFailure(record(error)?.["errorData"]) ? record(error)?.["errorData"] : undefined);
  if (isAgentToolFailure(existing)) {
    return {
      ...existing,
      operation: context.operation,
      stage: context.stage,
      ...(context.causal ? { causal: { ...existing.causal, ...context.causal } } : {}),
    };
  }
  const dataValue = record(error)?.["errorData"];
  const data = record(dataValue);
  const primaryValue = data?.["primary"];
  const primary = record(primaryValue);
  const message = primary ? errorMessage(primaryValue) : errorMessage(error);
  const code = errorCode(primaryValue ?? error, primary ?? data);
  const kind = context.kind ?? kindFor(code, message);
  return agentToolFailureSchema.parse({
    protocol: AGENT_TOOL_FAILURE_PROTOCOL,
    code,
    kind,
    message,
    operation: context.operation,
    stage: context.stage,
    retry: context.retry ?? retryFor(kind, data),
    ...(context.causal && Object.keys(context.causal).length > 0 ? { causal: context.causal } : {}),
    causes: [
      {
        role: "primary",
        code,
        message,
        ...(primaryValue === undefined
          ? dataValue === undefined
            ? {}
            : { data: boundedFailureData(dataValue) }
          : { data: boundedFailureData(primaryValue) }),
      },
      ...secondaryCauses(data),
    ],
    ...(dataValue === undefined ? {} : { data: boundedFailureData(dataValue) }),
  });
}

export function renderAgentToolFailure(failure: AgentToolFailure): string {
  const recovery =
    failure.retry.policy === "none"
      ? "Do not retry automatically."
      : failure.retry.policy === "retry-identical"
        ? "Retry only the identical request with the same command identity."
        : failure.retry.policy === "reobserve"
          ? "Re-observe current state, then issue a new command identity."
          : failure.retry.policy === "request-approval"
            ? "Complete the declared approval or authority repair before retrying."
            : "Correct the request from current facts before retrying.";
  const secondary = failure.causes
    .filter((cause) => cause.role !== "primary")
    .map((cause) => `${cause.role}: ${cause.code}: ${cause.message}`);
  return [
    `[${failure.operation}:${failure.stage}] ${failure.code}: ${failure.message}`,
    recovery,
    ...secondary,
  ].join("\n");
}
