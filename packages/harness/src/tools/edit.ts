/**
 * Edit tool. Reads the base from the caller's exact working state and records
 * the change as an UNCOMMITTED working edit through `vcs.edit` (edit-first; disk
 * is a projection of semantic state, never written directly). It does NOT commit, so
 * nothing builds or advances `main` until a deliberate `vcs.commit` + `vcs.push`.
 * The fuzzy / BOM / line-ending matching logic is the upstream pi-coding-agent
 * behaviour.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { VcsWorkingMutationResult } from "@vibestudio/service-schemas/vcs";
import {
  canonicalizeWorkspaceFilePath,
  splitRepoPath,
} from "@vibestudio/shared/runtime/entitySpec";
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
import {
  detectLineEnding,
  differingTextEdits,
  fuzzyFindText,
  generateDiffString,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff.js";

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
  newText: Type.String({ description: "New text to replace the old text with" }),
  intent: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Optional purpose when it is not already clear from the request; preserved as stated provenance.",
    })
  ),
});

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
  /** Unified diff of the changes made */
  diff: string;
  /** Line number of the first change in the new file (for editor navigation) */
  firstChangedLine?: number;
  storage?: "vcs" | "scratch";
  /** A recoverable precondition mismatch. No file was changed. */
  diagnostic?: "missing-file" | "not-found" | "ambiguous" | "binary-file";
  /** Number of matching replacement sites when `diagnostic` is `ambiguous`. */
  matchCount?: number;
  /** One-based candidate line numbers for an ambiguous replacement. */
  candidateLines?: number[];
  /** Exact canonical semantic result for a managed edit. */
  vcsResult?: VcsWorkingMutationResult;
}

export function createEditTool(
  cwd: string,
  vcs: ToolEditingVcs,
  context: ToolMutationContext,
  fs?: Pick<RuntimeFs, "readFile" | "writeFile">
): AgentTool<typeof editSchema, EditToolDetails> {
  return {
    name: "edit",
    label: "edit",
    description:
      'Replace exact text in a file. Every call must include path, oldText, and newText together; oldText must match exactly (including whitespace). Use write instead when replacing the whole file. To undo a managed semantic change, use vcs({ operation: "revert", changeIds: [...] }); editing the bytes back creates unrelated new intent.',
    parameters: editSchema,
    execute: async (_toolCallId, input, signal) => {
      const { path, oldText, newText } = input;
      if (typeof path !== "string" || typeof oldText !== "string" || typeof newText !== "string") {
        throw new Error("edit requires path, oldText, and newText");
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      const relPath = canonicalizeWorkspaceFilePath(toVcsPath(path, cwd));
      const repo = splitRepoPath(relPath);
      const useVcs = Boolean(repo || !fs);
      const scratch = !useVcs && fs ? await fs.readFile(relPath, "utf8") : null;
      const workingHead = useVcs ? await resolveToolWorkingState(vcs, context) : null;
      const exactFile =
        useVcs && workingHead ? await resolveToolFile(vcs, workingHead, relPath) : null;
      const base = exactFile;
      if (!base && scratch === null) {
        return {
          content: [
            {
              type: "text",
              text:
                `No changes made: ${path} does not exist. ` +
                "Create it with the write tool, or read/list the parent directory and retry with the current path.",
            },
          ],
          details: { diff: "", diagnostic: "missing-file" },
        };
      }
      if (base && base.content.kind !== "text") {
        return {
          content: [
            {
              type: "text",
              text:
                `No changes made: ${path} is binary and cannot be edited as text. ` +
                "Use the write tool with binary content if replacement is intended.",
            },
          ],
          details: { diff: "", diagnostic: "binary-file", storage: "vcs" },
        };
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      const sourceContent = base
        ? base.content.kind === "text"
          ? base.content.text
          : ""
        : typeof scratch === "string"
          ? scratch
          : (scratch?.toString("utf8") ?? "");
      const { bom, text: content } = stripBom(sourceContent);
      const originalEnding = detectLineEnding(content);
      const normalizedContent = normalizeToLF(content);
      const normalizedOldText = normalizeToLF(oldText);
      const normalizedNewText = normalizeToLF(newText);

      const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);
      if (!matchResult.found) {
        return {
          content: [
            {
              type: "text",
              text:
                `No changes made: the requested old text was not found in ${path}. ` +
                "Read the current file (or grep for a shorter anchor) and retry with current text including whitespace and newlines.",
            },
          ],
          details: {
            diff: "",
            diagnostic: "not-found",
            storage: base ? "vcs" : "scratch",
          },
        };
      }

      const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
      const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
      const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;
      if (occurrences > 1) {
        const candidateLines: number[] = [];
        for (let at = fuzzyContent.indexOf(fuzzyOldText); at >= 0; ) {
          candidateLines.push(fuzzyContent.slice(0, at).split("\n").length);
          at = fuzzyContent.indexOf(fuzzyOldText, at + Math.max(1, fuzzyOldText.length));
        }
        return {
          content: [
            {
              type: "text",
              text:
                `No changes made: found ${occurrences} matching occurrences in ${path}` +
                `${candidateLines.length ? ` on lines ${candidateLines.join(", ")}` : ""}. ` +
                "Include surrounding context in oldText so the replacement identifies one site.",
            },
          ],
          details: {
            diff: "",
            diagnostic: "ambiguous",
            matchCount: occurrences,
            candidateLines,
            storage: base ? "vcs" : "scratch",
          },
        };
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      const baseContent = matchResult.contentForReplacement;
      const start = matchResult.index;
      const end = matchResult.index + matchResult.matchLength;
      const newContent = baseContent.slice(0, start) + normalizedNewText + baseContent.slice(end);
      if (baseContent === newContent) {
        return {
          content: [
            {
              type: "text",
              text: `No changes made to ${path}. The replacement produced identical content.`,
            },
          ],
          details: { diff: "" },
        };
      }

      const storedNewContent = bom + restoreLineEndings(newContent, originalEnding);
      // oldText/newText may include unchanged context solely to identify one
      // match. Derive edits from the exact before/after bytes so those anchors
      // retain their existing provenance instead of becoming newly authored.
      const semanticEdits = differingTextEdits(sourceContent, storedNewContent);

      // Tie this edit to the authoring tool-call (the edge into the agentic
      // trajectory: file → edit → invocation → turn → session, queryable + kept
      // through commit). The exact causal invocation arrives through verified
      // RPC context, never through this tool payload.
      let vcsResult: VcsWorkingMutationResult | undefined;
      if (base && exactFile && workingHead) {
        vcsResult = await vcs.edit({
          contextId: toolContextId(context),
          expectedWorkingHead: workingHead,
          commandId: toolCommandId(context),
          ...(input.intent?.trim() ? { intentSummary: input.intent.trim() } : {}),
          changes: [
            {
              kind: "text-edit",
              repositoryId: exactFile.repositoryId,
              fileId: exactFile.fileId,
              edits: semanticEdits,
            },
          ],
        });
      } else if (fs) {
        await fs.writeFile(relPath, storedNewContent);
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      const diffResult = generateDiffString(baseContent, newContent);
      const content_: (TextContent | ImageContent)[] = [
        { type: "text", text: `Successfully replaced text in ${path}.` },
      ];
      return {
        content: content_,
        details: {
          diff: diffResult.diff,
          firstChangedLine: diffResult.firstChangedLine,
          storage: base ? "vcs" : "scratch",
          ...(vcsResult ? { vcsResult } : {}),
        },
      };
    },
  };
}
