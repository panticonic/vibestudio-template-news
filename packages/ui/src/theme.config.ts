/**
 * The single app-wide signature identity (DECIDED). Sourced here and applied at
 * the shell root AND every panel `<Theme>` mount so the whole app reads in one
 * calm, focused language instead of each panel choosing its own accent/radius.
 *
 * Usage:
 *   import { APP_THEME } from "@workspace/ui";
 *   <Theme appearance={effectiveTheme} {...APP_THEME}>...</Theme>
 *
 * `appearance` (light/dark) is intentionally NOT part of this constant - it
 * flows from the centralized theme atom / system preference at each mount, never
 * a hardcoded literal.
 */
export const APP_THEME = {
  accentColor: "violet",
  grayColor: "mauve",
  radius: "medium",
  scaling: "100%",
  panelBackground: "translucent",
} as const;

export type AppTheme = typeof APP_THEME;
