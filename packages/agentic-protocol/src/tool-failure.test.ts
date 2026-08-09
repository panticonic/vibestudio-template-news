import { describe, expect, it } from "vitest";
import {
  agentToolFailureFromUnknown,
  agentToolFailureSchema,
  renderAgentToolFailure,
} from "./tool-failure.js";

describe("agent tool failure contract", () => {
  it("preserves primary and cleanup errors with exact causal identities", () => {
    const failure = agentToolFailureFromUnknown(
      Object.assign(new Error("push failed"), {
        errorData: {
          code: "ExternalEffectFailed",
          effectId: "effect:1",
          cleanupFailure: { code: "EACCES", message: "cleanup denied" },
          retry: { commandIdPolicy: "reuse-identical-only-if-outcome-uncertain" },
        },
      }),
      {
        operation: "vcs.push",
        stage: "publish",
        causal: { invocationId: "inv:1", commandId: "cmd:1" },
      }
    );

    expect(agentToolFailureSchema.parse(failure)).toEqual(failure);
    expect(failure).toMatchObject({
      code: "ExternalEffectFailed",
      kind: "external-effect",
      retry: { policy: "retry-identical", commandIdPolicy: "reuse-identical" },
      causal: { invocationId: "inv:1", commandId: "cmd:1" },
      causes: [
        { role: "primary", code: "ExternalEffectFailed" },
        { role: "cleanup", code: "EACCES" },
      ],
    });
    expect(renderAgentToolFailure(failure)).toContain("cleanup denied");
  });

  it("rebinds an existing envelope to the current operation without losing details", () => {
    const original = agentToolFailureFromUnknown(
      Object.assign(new Error("bad input"), { code: "InvalidReference" }),
      { operation: "vcs.read", stage: "resolve" }
    );
    const rebound = agentToolFailureFromUnknown(
      { failure: original },
      {
        operation: "tool.read",
        stage: "execute",
        causal: { invocationId: "inv:2" },
      }
    );
    expect(rebound).toMatchObject({
      code: original.code,
      operation: "tool.read",
      stage: "execute",
      causal: { invocationId: "inv:2" },
      causes: original.causes,
    });
  });

  it("keeps a nested operation failure primary and configuration rollback secondary", () => {
    const failure = agentToolFailureFromUnknown(
      Object.assign(new Error("import wrapper"), {
        errorData: {
          operation: "git.importProject",
          stage: "clone",
          primary: { code: "ENETDOWN", message: "network unavailable" },
          config: {
            rollbackFailure: { code: "EACCES", message: "rollback cleanup failed" },
          },
        },
      }),
      { operation: "git.importProject", stage: "clone" }
    );

    expect(failure).toMatchObject({
      code: "ENETDOWN",
      message: "network unavailable",
      causes: [
        { role: "primary", code: "ENETDOWN", message: "network unavailable" },
        { role: "rollback", code: "EACCES", message: "rollback cleanup failed" },
      ],
    });
  });

  it("bounds durable failure data without discarding typed control fields", () => {
    const failure = agentToolFailureFromUnknown(
      Object.assign(new Error("too much detail"), {
        errorData: {
          code: "ExternalEffectFailed",
          effectId: "effect:large",
          body: "x".repeat(40_000),
        },
      }),
      { operation: "network.fetch", stage: "response" }
    );

    expect(failure).toMatchObject({
      code: "ExternalEffectFailed",
      kind: "external-effect",
      data: {
        protocol: "agent-tool-failure-data-summary.v1",
        truncated: true,
        originalBytes: expect.any(Number),
      },
    });
    expect(JSON.stringify(failure).length).toBeLessThan(20_000);
  });

  it("classifies invalid read paths as correctable input, not missing authority", () => {
    const failure = agentToolFailureFromUnknown(
      new Error('[fs.access] Invalid workspace repo path: "packages/maybe?"'),
      { operation: "tool.read", stage: "execute" }
    );
    expect(failure).toMatchObject({
      kind: "invalid-input",
      retry: { policy: "correct-input" },
    });
    expect(renderAgentToolFailure(failure)).toContain("Correct the request");
  });
});
