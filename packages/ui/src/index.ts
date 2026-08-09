// --- App-wide design language ---
export { APP_THEME } from "./theme.config";
export type { AppTheme } from "./theme.config";
export { VibestudioLogo } from "./brand";
export type { VibestudioLogoProps } from "./brand";

// --- Shared UI kit: layout primitives ---
export { Stack, Surface, Toolbar, PanelChrome } from "./kit/layout";
export type {
  StackProps,
  SurfaceProps,
  SurfaceLevel,
  ElevationLevel,
  ToolbarProps,
  PanelChromeProps,
} from "./kit/layout";

// --- Shared UI kit: feedback primitives ---
export { StatusBadge, NarrationPill, EmptyState, Snackbar, useSnackbar } from "./kit/feedback";
export type {
  Intent,
  StatusBadgeProps,
  NarrationPillProps,
  EmptyStateProps,
  SnackbarProps,
} from "./kit/feedback";

// --- Shared UI kit: overlays (one stacking-context policy) ---
export { AppDialog, AppPopover, OVERLAY_Z } from "./kit/overlay";
export type { AppDialogProps, AppPopoverProps } from "./kit/overlay";

// --- Shared UI kit: unified command palette + shortcuts help ---
export { CommandPalette } from "./kit/CommandPalette";
export type { CommandPaletteProps, CommandItem, SelectModifiers } from "./kit/CommandPalette";
export { ShortcutsHelp } from "./kit/ShortcutsHelp";
export type { ShortcutsHelpProps, ShortcutGroup, ShortcutEntry } from "./kit/ShortcutsHelp";

// --- Shared UI kit: diff-review viewer (approval prompt + gad-browser) ---
export { DiffViewer } from "./kit/diff/DiffViewer";
export type { DiffViewerProps } from "./kit/diff/DiffViewer";
export type {
  DiffReviewEntry,
  DiffChangedFile,
  DiffFileKind,
  DiffStat,
  DiffContentFetcher,
} from "./kit/diff/types";
export { diffLines, splitLines, allAdded, allRemoved } from "./kit/diff/lineDiff";
export type { DiffRow, DiffRowType, LineDiffResult } from "./kit/diff/lineDiff";
export { languageForPath } from "./kit/diff/highlight";
