import { describe, expect, it } from "vitest";
import {
  renderProvenanceBlock,
  type CanonicalProvenanceInspection,
  type CanonicalProvenanceResult,
} from "../provenance-format.js";

function render(inspection: CanonicalProvenanceInspection): string {
  const result: CanonicalProvenanceResult = {
    root: inspection.root,
    edges: [],
    nextCursor: null,
  };
  return renderProvenanceBlock({ label: "inspection", inspection, result }) ?? "";
}

describe("provenance formatting", () => {
  it("makes a sole event application directly inspectable", () => {
    const root = { kind: "event" as const, eventId: "event:import" };
    const rendered = render({
      root,
      node: {
        kind: "event",
        value: {
          eventId: root.eventId,
          workspaceId: "workspace:test",
          commandId: "command:import",
          parentEventIds: ["event:base"],
          applicationIds: ["application:import"],
          decisionIds: [],
          kind: "commit",
          message: "Import project",
          createdAt: "2026-07-15T10:00:00.000Z",
          semanticProtocol: "semantic:test",
          workspaceFactRootId: "workspace-facts:import",
        },
      },
      edges: [],
      hasMoreEdges: false,
    });

    expect(rendered).toContain(
      'inspect sole application → provenance({"target":{"kind":"application","applicationId":"application:import"}})'
    );
  });

  it("makes exact external evidence visible on its owning import work unit", () => {
    const root = { kind: "work-unit" as const, workUnitId: "work:import" };
    const rendered = render({
      root,
      node: {
        kind: "work-unit",
        value: {
          workUnitId: root.workUnitId,
          commandId: "command:import",
          kind: "import",
          authoredChangeCount: 243,
          authoredChangeIds: ["change:repo", "change:file"],
          incorporatedChangeCount: 0,
          incorporatedChangeIds: [],
          decisionCount: 0,
          decisionIds: [],
          intent: { text: "import external snapshot", tier: "mechanical" },
          intentSummary: null,
          authorContextId: "context:import",
          triggerEvidence: null,
          externalSnapshot: {
            sourceKind: "git",
            sourceUri: "https://example.test/owner/project.git",
            snapshotRevision: "0123456789abcdef",
            sourceSubdir: null,
            canonicalSnapshot: `v1-sha256:${"c".repeat(64)}`,
            snapshotDigest: "snapshot:derived",
            targetRepositoryIds: ["repository:one", "repository:two"],
          },
          contentClass: "external",
          externalKeys: ["repo:https://example.test/owner/project.git@0123456789abcdef"],
          normalizationProtocol: "normalization:test",
          createdAt: "2026-07-15T10:00:00.000Z",
        },
      },
      edges: [],
      hasMoreEdges: false,
    });

    expect(rendered).toContain("243 authored changes (2 in preview)");
    expect(rendered).toContain("2 target repositories");
    expect(rendered).toContain("https://example.test/owner/project.git");
    expect(rendered).toContain("0123456789abcdef");
    expect(rendered).toContain("snapshot:derived");
    expect(rendered).toContain("pre-import coordinate authorship unknown");
  });

  it("renders an imported file as an ordinary change without duplicating snapshot evidence", () => {
    const root = { kind: "change" as const, changeId: "change:imported-file" };
    const rendered = render({
      root,
      node: {
        kind: "change",
        value: {
          changeId: root.changeId,
          authoredByWorkUnitId: "work:import",
          operation: 0,
          kind: "content-replace",
          effects: [
            {
              kind: "content",
              fileId: "file:readme",
              beforeContentHash: "blob:before",
              afterContentHash: "blob:after",
            },
          ],
          counteractsChangeIds: [],
          effectDigest: "effect:imported-file",
          normalizationProtocol: "normalization:test",
        },
      },
      edges: [],
      hasMoreEdges: false,
    });

    expect(rendered).toContain("change · content-replace · work work:import");
    expect(rendered).not.toContain("external snapshot");
  });

  it("uses exact totals while naming the bounded application preview", () => {
    const root = { kind: "application" as const, applicationId: "application:import" };
    const rendered = render({
      root,
      node: {
        kind: "application",
        value: {
          applicationId: root.applicationId,
          workUnitId: "work:import",
          basis: { kind: "event", eventId: "event:base" },
          appliedChangeCount: 243,
          appliedChanges: [],
          resultWorkspaceFactRootId: "projection:result",
          semanticProtocol: "semantic:test",
        },
      },
      edges: [],
      hasMoreEdges: false,
    });

    expect(rendered).toContain("243 applied changes (0 in preview)");
    expect(rendered).toContain(
      'inspect owning work → provenance({"target":{"kind":"work-unit","workUnitId":"work:import"}})'
    );
  });

  it("renders an applied change as a reusable basis-specific graph node", () => {
    const root = {
      kind: "applied-change" as const,
      appliedChangeId: "applied-change:target",
    };
    const rendered = render({
      root,
      node: {
        kind: "applied-change",
        value: {
          appliedChangeId: root.appliedChangeId,
          applicationId: "application:target",
          changeId: "change:source",
          ordinal: 2,
          appliedEffects: [
            {
              kind: "mode",
              fileId: "file:readme",
              beforeMode: 0o644,
              afterMode: 0o755,
            },
          ],
          resultPredicate: null,
        },
      },
      edges: [],
      hasMoreEdges: false,
    });

    expect(rendered).toContain(
      "applied-change · application application:target · change change:source · ordinal 2 · 1 effect"
    );
  });
});
