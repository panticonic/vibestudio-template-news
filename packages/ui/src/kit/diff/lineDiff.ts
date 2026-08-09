/**
 * The DOM diff viewer and native mobile review share one pure row model. Keep
 * this compatibility module so existing UI imports remain stable while the
 * algorithm and its safety bounds live in the platform-neutral shared layer.
 */
export {
  DiffTooLargeError,
  MAX_RENDERED_DIFF_CELLS,
  MAX_RENDERED_DIFF_LINES,
  allAdded,
  allRemoved,
  diffLines,
  splitLines,
} from "@vibestudio/shared/lineDiff";
export type { DiffRow, DiffRowType, LineDiffResult } from "@vibestudio/shared/lineDiff";
