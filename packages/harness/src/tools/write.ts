/**
 * Write tool — GAD-native. Records a whole-file write as an UNCOMMITTED working
 * change through `vcs.edit` (creates or overwrites; parent dirs are implicit).
 * Disk is a projection of the working state, never written
 * directly. It does NOT commit — seal milestones with `vcs.commit` + `vcs.push`.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { VcsWorkingMutationResult } from "@vibestudio/service-schemas/vcs";
import {
  canonicalizeWorkspaceFilePath,
  splitRepoPath,
} from "@vibestudio/shared/runtime/entitySpec";
import { semanticVcsPathAdmission } from "@vibestudio/shared/vcs/pathAdmission";
import type { RuntimeFs } from "./runtime-fs.js";
import { resolveToolFile } from "../semantic-file-resolution.js";
import {
  resolveToolWorkingState,
  toVcsPath,
  toolCommandId,
  toolContextId,
  type ToolEditingVcs,
  type ToolMutationContext,
} from "./tool-vcs.js";

const writeSchema = Type.Object({
  path: Type.String({
    description:
      "Workspace-relative path. Use .tmp/<name> for temporary/context-local files. Managed source paths must be inside an existing repository, for example projects/default/<file> or packages/<name>/<file>.",
  }),
  content: Type.String({ description: "Content to write to the file" }),
  intent: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Optional purpose when it is not already clear from the request; preserved as stated provenance.",
    })
  ),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
  bytesWritten: number;
  path: string;
  storage: "vcs" | "scratch" | "none";
  /** A recoverable policy mismatch. No file was written. */
  diagnostic?: "semantic-path-inadmissible" | "repository-not-present";
  suggestedScratchPath?: string;
  /** The requested bytes already matched the working file, so no edit was recorded. */
  unchanged?: boolean;
  /** Exact canonical semantic result for a managed write. */
  vcsResult?: VcsWorkingMutationResult;
}

export function createWriteTool(
  cwd: string,
  vcs: ToolEditingVcs,
  context: ToolMutationContext,
  fs?: Pick<RuntimeFs, "writeFile">
): AgentTool<typeof writeSchema, WriteToolDetails> {
  return {
    name: "write",
    label: "write",
    description:
      "Write a text file. Use .tmp/<name> for temporary files. Managed source paths become uncommitted VCS edits and must be inside an existing repository (such as projects/default or packages/<name>).",
    parameters: writeSchema,
    execute: async (_toolCallId, input, signal) => {
      const { path, content } = input;
      if (typeof path !== "string" || typeof content !== "string") {
        throw new Error("write requires path and content");
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      const relPath = canonicalizeWorkspaceFilePath(toVcsPath(path, cwd));
      const pathAdmission = semanticVcsPathAdmission(relPath);
      if (!pathAdmission.admissible) {
        const basename = relPath.split("/").filter(Boolean).at(-1) ?? "output.txt";
        const suggestedScratchPath = `.tmp/${basename}`;
        return {
          content: [
            {
              type: "text",
              text:
                `No file written: ${pathAdmission.message}. ` +
                `For context-local temporary data, retry with ${suggestedScratchPath}.`,
            },
          ],
          details: {
            bytesWritten: 0,
            path: relPath,
            storage: "none",
            diagnostic: "semantic-path-inadmissible",
            suggestedScratchPath,
          },
        };
      }
      const repo = splitRepoPath(relPath);
      if (!repo && fs) {
        await fs.writeFile(relPath, content);
        if (signal?.aborted) throw new Error("Operation aborted");
        return {
          content: [
            { type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` },
          ],
          details: { bytesWritten: content.length, path: relPath, storage: "scratch" },
        };
      }
      // A whole-file write recorded as an uncommitted working edit on the
      // current working state (overwrite semantics). No commit, no build — disk reflects
      // the working content immediately, sealed later by vcs.commit. Tagged with
      // the authoring tool-call so file → edit → invocation → turn is traversable.
      // The exact causal invocation arrives through verified RPC context and is
      // intentionally absent from this public semantic payload.
      if (!repo?.repoRelPath) throw new Error(`${relPath} is not a file in a workspace repository`);
      const workingHead = await resolveToolWorkingState(vcs, context);
      const repository = await vcs.resolveRepository({
        state: workingHead,
        repoPath: repo.repoPath,
      });
      if (!repository) {
        const basename = relPath.split("/").filter(Boolean).at(-1) ?? "output.txt";
        const suggestedScratchPath = `.tmp/${basename}`;
        return {
          content: [
            {
              type: "text",
              text:
                `No file written: ${repo.repoPath} is not an existing workspace repository. ` +
                `Choose a path inside an existing repository, or retry temporary data at ${suggestedScratchPath}.`,
            },
          ],
          details: {
            bytesWritten: 0,
            path: relPath,
            storage: "none",
            diagnostic: "repository-not-present",
            suggestedScratchPath,
          },
        };
      }
      const existing = await resolveToolFile(vcs, workingHead, relPath);
      const existingText =
        existing?.content.kind === "text"
          ? existing.content.text
          : existing?.content.kind === "bytes"
            ? Buffer.from(existing.content.base64, "base64").toString("utf8")
            : undefined;
      if (existingText === content) {
        return {
          content: [
            {
              type: "text",
              text: `File ${relPath} already has the requested content; no change was needed.`,
            },
          ],
          details: {
            bytesWritten: content.length,
            path: relPath,
            storage: "vcs",
            unchanged: true,
          },
        };
      }
      const vcsResult = await vcs.edit({
        contextId: toolContextId(context),
        expectedWorkingHead: workingHead,
        commandId: toolCommandId(context),
        ...(input.intent?.trim() ? { intentSummary: input.intent.trim() } : {}),
        changes: [
          existing?.content.kind === "text"
            ? {
                kind: "text-edit",
                repositoryId: existing.repositoryId,
                fileId: existing.fileId,
                edits: [
                  {
                    start: 0,
                    end: existing.content.text.length,
                    text: content,
                  },
                ],
              }
            : existing
              ? {
                  kind: "binary-replace",
                  repositoryId: existing.repositoryId,
                  fileId: existing.fileId,
                  base64: Buffer.from(content, "utf8").toString("base64"),
                }
              : {
                  kind: "file-create",
                  repositoryId: repository.repositoryId,
                  path: repo.repoRelPath,
                  content: { kind: "text", text: content },
                  mode: 0o644,
                },
        ],
      });
      if (signal?.aborted) throw new Error("Operation aborted");

      const out: { content: (TextContent | ImageContent)[]; details: WriteToolDetails } = {
        content: [
          { type: "text", text: `Successfully wrote ${content.length} bytes to ${relPath}` },
        ],
        details: { bytesWritten: content.length, path: relPath, storage: "vcs", vcsResult },
      };
      return out;
    },
  };
}
