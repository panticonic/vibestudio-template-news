// =============================================================================
// @workspace/harness — In-process Pi runtime for the agent worker DO
// =============================================================================

// The in-process Pi runtime (PiRunner / AgentHarness) was replaced by the
// event-sourced @workspace/agent-loop + the AgentLoopDriver in
// @workspace/agentic-do (unified-log Stage B cut). The harness package keeps
// the local tools, prompt composition, and shared types.
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export {
  driveMerge,
  renderCompareReview,
  renderMergeReview,
  MergeDriverError,
} from "./merge-driver.js";
export type { DriveMergeInput, DriveMergeResult, MergeReview } from "./merge-driver.js";
export { resolveToolFile, resolveToolRepository } from "./semantic-file-resolution.js";
export type { PresentToolRepository, ToolFileResolution } from "./semantic-file-resolution.js";

// Stable runner-level error codes (Phase 7).
export { AgentWorkerError } from "./errors.js";
export type { AgentWorkerErrorCode } from "./errors.js";

export { VIBESTUDIO_BASE_SYSTEM_PROMPT, composeSystemPrompt } from "./system-prompt.js";
export type { ComposeSystemPromptOptions, SystemPromptMode } from "./system-prompt.js";
export { loadVibestudioResources, formatSkillIndex } from "./resource-loader.js";
export type { VibestudioResources, ResourceLoaderDeps, SkillEntry } from "./resource-loader.js";

// The Pi extension layer (approval gate, channel tools, ask-user, web tools,
// extension runtime/UI bridge) was replaced by pure step policies in
// @workspace/agent-loop (unified-log Stage B). Tools remain below.
export type { AgentTool } from "@workspace/pi-core";

// Channel boundary types (still used by agentic-do)
export type {
  Attachment,
  ChannelEvent,
  SendMessageOptions,
  TurnInput,
  TurnUsage,
  ParticipantDescriptor,
  UnsubscribeResult,
} from "./types.js";

// File tools (workerd-clean port of pi-coding-agent's six file tools)
export {
  createReadTool,
  createProvenanceTool,
  createEditTool,
  createWriteTool,
  createMoveFileTool,
  createCopyFileTool,
  createWorkspaceVcsTool,
  createToolVcs,
  renderProvenanceBlock,
  createGrepTool,
  createFindTool,
  createLsTool,
  createSuspendTurnTool,
  createEvalTool,
  evalToolParameters,
  formatEvalResult,
  normalizeEvalToolSource,
  type EvalRunResult,
  type NormalizedEvalToolSource,
  createDocsSearchTool,
  createDocsOpenTool,
  createWorkspaceServiceTool,
  resolveToCwd,
  expandPath,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateTail,
  truncateLine,
  formatSize,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  normalizeForFuzzyMatch,
  fuzzyFindText,
  stripBom,
  generateDiffString,
} from "./tools/index.js";

// Web research tools (web_search / web_fetch / web_read).
export { createWebTools } from "./web/index.js";
export type { WebToolsDeps } from "./web/index.js";
export type {
  ReadToolInput,
  ReadToolDetails,
  ReadToolDeps,
  ProvenanceToolInput,
  ProvenanceToolDetails,
  ProvenanceToolDeps,
  ProvenanceBlockInput,
  EditToolInput,
  EditToolDetails,
  WriteToolInput,
  WriteToolDetails,
  FileTransferToolInput,
  FileTransferToolDetails,
  WorkspaceVcsToolInput,
  WorkspaceVcsToolDetails,
  ToolWorkflowVcs,
  ToolVcs,
  ToolFileTransferVcs,
  GrepToolInput,
  GrepToolDetails,
  FindToolInput,
  FindToolDetails,
  LsToolInput,
  LsToolDetails,
  DocsSearchInput,
  DocsOpenInput,
  CatalogHit,
  CatalogEntry,
  WorkspaceServiceToolInput,
  WorkspaceServiceToolDetails,
  WorkspaceServiceToolDeps,
  TruncationResult,
  TruncationOptions,
  LineEnding,
  FuzzyMatchResult,
  DiffResult,
} from "./tools/index.js";
