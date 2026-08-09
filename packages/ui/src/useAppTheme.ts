/**
 * Live app-wide theme identity for panel `<Theme>` mounts. Reads the theme
 * config the shell pushes over the runtime bridge (`runtime.panel`), so a
 * user-changed accent/radius propagates to every panel without a reload. Falls
 * back to the static `APP_THEME` for non-panel embedders (no runtime channel).
 *
 * Usage: `<Theme appearance={appearance} {...useAppTheme()}>`
 */
import { useEffect, useState } from "react";
import * as runtime from "@workspace/runtime";
import type { ThemeConfig } from "@workspace/runtime";
import { APP_THEME, type AppTheme } from "./theme.config";

function toAppTheme(cfg: ThemeConfig): AppTheme {
  // The runtime config carries arbitrary Radix accent strings; cast to the
  // APP_THEME literal types so the spread into <Theme> stays type-clean. The
  // runtime VALUES (e.g. "blue") are valid Radix accents and render correctly.
  return {
    accentColor: cfg.accentColor as AppTheme["accentColor"],
    grayColor: cfg.grayColor as AppTheme["grayColor"],
    radius: cfg.radius as AppTheme["radius"],
    scaling: cfg.scaling as AppTheme["scaling"],
    panelBackground: cfg.panelBackground as AppTheme["panelBackground"],
  };
}

export function useAppTheme(): AppTheme {
  const [theme, setTheme] = useState<AppTheme>(() => {
    try {
      return toAppTheme(runtime.panel.getThemeConfig());
    } catch {
      return APP_THEME;
    }
  });

  useEffect(() => {
    try {
      return runtime.panel.onThemeConfigChange((cfg) => setTheme(toAppTheme(cfg)));
    } catch {
      return undefined;
    }
  }, []);

  return theme;
}
