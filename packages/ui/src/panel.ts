// Panel-runtime-only helpers. Keep the root `@workspace/ui` barrel free of
// runtime side effects so shell/app imports can use pure UI primitives safely.
export { useAppTheme } from "./useAppTheme";
export type { AppTheme } from "./theme.config";
