import type {
  VcsCommitInput,
  VcsEditChange,
  VcsEditInput,
  VcsStateNodeRef,
} from "@vibestudio/service-schemas/vcs";
import type { ToolEditingVcs } from "../tool-vcs.js";

export interface StubVcsInit {
  files?: Record<string, string>;
}

function normalize(path: string): string {
  return path.replace(/^\/+/, "");
}

export class StubVcs implements ToolEditingVcs {
  readonly files = new Map<string, string>();
  lastEditInput?: VcsEditInput;
  lastCommitInput?: VcsCommitInput;
  private version = 0;
  private committedEventId = "event:committed";

  constructor(init?: StubVcsInit) {
    for (const [path, text] of Object.entries(init?.files ?? {})) {
      this.files.set(normalize(path), text);
    }
  }

  private workingHead(): VcsStateNodeRef {
    return this.version === 0
      ? { kind: "event", eventId: this.committedEventId }
      : { kind: "application", applicationId: `application:${this.version}` };
  }

  private repoPaths(): string[] {
    const paths = new Set([
      "meta",
      "packages/demo",
      "projects/file-tools-smoke",
      "projects/tmp_dir_test_root",
      "projects/note",
    ]);
    for (const file of this.files.keys()) {
      const parts = file.split("/");
      paths.add(parts[0] === "meta" ? "meta" : `${parts[0]}/${parts[1]}`);
    }
    return [...paths];
  }

  read(path: string): string | undefined {
    return this.files.get(normalize(path));
  }

  async status(input: Parameters<ToolEditingVcs["status"]>[0]) {
    return {
      contextId: input.contextId,
      committed: { kind: "event" as const, eventId: this.committedEventId },
      workingHead: this.workingHead(),
      clean: this.version === 0,
      mainEventId: "event:main",
      mainRelation: "at" as const,
      workingCounts: { applications: this.version, workUnits: this.version, changes: this.version },
      integrating: [],
    };
  }

  async resolveRepository(input: Parameters<ToolEditingVcs["resolveRepository"]>[0]) {
    if (!this.repoPaths().includes(input.repoPath)) return null;
    return {
      state: input.state,
      repositoryId: `repository:${input.repoPath}`,
      repoPath: input.repoPath,
    };
  }

  async readFile(input: Parameters<ToolEditingVcs["readFile"]>[0]) {
    const repoPath = input.repositoryId.slice("repository:".length);
    let requestedPath: string | undefined;
    if (input.file.kind === "path") {
      requestedPath = input.file.path;
    } else {
      const fileId = input.file.fileId;
      requestedPath = [...this.files.keys()]
        .find((path) => `file:${path}` === fileId)
        ?.slice(repoPath.length + 1);
    }
    if (!requestedPath) return null;
    const fullPath = `${repoPath}/${requestedPath}`;
    const text = this.files.get(fullPath);
    if (text === undefined) return null;
    return {
      repositoryId: `repository:${repoPath}`,
      fileId: `file:${fullPath}`,
      repoPath,
      path: requestedPath,
      contentHash: `blob:${this.version}:${fullPath}`,
      authoredChangeId: `change:${this.version}:${fullPath}`,
      authoredByWorkUnitId: `work:${this.version}`,
      contentClass: "internal" as const,
      externalKeys: [],
      mode: 0o644,
      content: { kind: "text" as const, text },
    };
  }

  async edit(input: VcsEditInput) {
    this.lastEditInput = input;
    for (const change of input.changes) this.applyChange(change);
    this.version += 1;
    return {
      contextId: input.contextId,
      commandId: input.commandId,
      workUnitId: `work:${this.version}`,
      applicationId: `application:${this.version}`,
      changeCount: input.changes.length,
      changeIds: input.changes.map((_, index) => `change:${this.version}:${index}`),
      incorporatedChangeCount: 0,
      incorporatedChangeIds: [],
      decisionIds: [],
      workingHead: this.workingHead(),
    };
  }

  private applyChange(change: VcsEditChange): void {
    if (change.kind === "repository-create") {
      for (const file of change.files) {
        if (file.content.kind !== "text") throw new Error("stub only supports text");
        this.files.set(`${change.repoPath}/${file.path}`, file.content.text);
      }
      return;
    }
    const repoPath = change.repositoryId.slice("repository:".length);
    if (change.kind === "file-create") {
      if (change.content.kind !== "text") throw new Error("stub only supports text");
      this.files.set(`${repoPath}/${change.path}`, change.content.text);
      return;
    }
    const fullPath = [...this.files.keys()].find((path) => `file:${path}` === change.fileId);
    if (!fullPath) throw new Error(`file not found: ${change.fileId}`);
    if (change.kind === "file-delete") {
      this.files.delete(fullPath);
      return;
    }
    if (change.kind === "file-mode") return;
    if (change.kind === "binary-replace") {
      this.files.set(fullPath, Buffer.from(change.base64, "base64").toString("utf8"));
      return;
    }
    let next = this.files.get(fullPath)!;
    for (const edit of [...change.edits].sort((a, b) => b.start - a.start)) {
      next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    }
    this.files.set(fullPath, next);
  }

  async commit(input: VcsCommitInput) {
    this.lastCommitInput = input;
    const applications = this.version === 0 ? [] : [`application:${this.version}`];
    this.committedEventId = `event:${this.version + 1}`;
    this.version = 0;
    return {
      contextId: input.contextId,
      event: { kind: "event" as const, eventId: this.committedEventId },
      committedApplicationIds: applications,
      integrationSourceEventIds: [],
    };
  }
}
