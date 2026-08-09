/**
 * Workerd-clean port of pi-coding-agent's six file tools.
 *
 * Each tool is exposed as a `createXxxTool(cwd, fs[, deps])` factory that
 * returns an `AgentTool` ready to be added to an `AgentSession`'s tool list.
 * Pure logic helpers (`path-utils`, `truncate`, `edit-diff`) are re-exported
 * for tests and for the chat-UI preview path.
 */

export { createReadTool } from "./read.js";
export type { ReadToolInput, ReadToolDetails, ReadToolDeps } from "./read.js";

export { createProvenanceTool } from "./provenance.js";
export type {
  ProvenanceToolInput,
  ProvenanceToolDetails,
  ProvenanceToolDeps,
} from "./provenance.js";

export { renderProvenanceBlock } from "./provenance-format.js";
export type { ProvenanceBlockInput } from "./provenance-format.js";

export { createEditTool } from "./edit.js";
export type { EditToolInput, EditToolDetails } from "./edit.js";

export { createWriteTool } from "./write.js";
export type { WriteToolInput, WriteToolDetails } from "./write.js";

export { createMoveFileTool, createCopyFileTool } from "./file-transfer.js";
export type { FileTransferToolInput, FileTransferToolDetails } from "./file-transfer.js";

export { createWorkspaceVcsTool } from "./workspace-vcs.js";
export type {
  WorkspaceVcsToolInput,
  WorkspaceVcsToolDetails,
  ToolWorkflowVcs,
} from "./workspace-vcs.js";

export { createToolVcs, toolCommandId } from "./tool-vcs.js";
export type {
  ToolVcs,
  ToolFileTransferVcs,
  ToolWorkspaceContext,
  ToolMutationContext,
} from "./tool-vcs.js";

export { createGrepTool } from "./grep.js";
export type { GrepToolInput, GrepToolDetails } from "./grep.js";

export { createFindTool } from "./find.js";
export type { FindToolInput, FindToolDetails } from "./find.js";

export { createLsTool } from "./ls.js";
export type { LsToolInput, LsToolDetails } from "./ls.js";

export { createSuspendTurnTool } from "./suspend-turn.js";
export type { SuspendTurnInput, SuspendTurnDetails } from "./suspend-turn.js";

export {
  createEvalTool,
  evalToolParameters,
  formatEvalResult,
  normalizeEvalToolSource,
  type EvalRunResult,
  type NormalizedEvalToolSource,
} from "./eval.js";
export type { EvalToolInput } from "./eval.js";

export { createDocsSearchTool, createDocsOpenTool } from "./docs.js";
export type { DocsSearchInput, DocsOpenInput, CatalogHit, CatalogEntry } from "./docs.js";

export { createWorkspaceServiceTool } from "./workspace-service.js";
export type {
  WorkspaceServiceToolInput,
  WorkspaceServiceToolDetails,
  WorkspaceServiceToolDeps,
} from "./workspace-service.js";

// Pure helpers
export { resolveToCwd, expandPath } from "./path-utils.js";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  GREP_MAX_LINE_LENGTH,
  formatSize,
  truncateHead,
  truncateTail,
  truncateLine,
} from "./truncate.js";
export type { TruncationResult, TruncationOptions } from "./truncate.js";
export {
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  normalizeForFuzzyMatch,
  fuzzyFindText,
  stripBom,
  generateDiffString,
} from "./edit-diff.js";
export type { LineEnding, FuzzyMatchResult, DiffResult } from "./edit-diff.js";
