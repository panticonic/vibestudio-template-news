/**
 * Base runtime factory — transport-agnostic core shared by panels and workers.
 *
 * Provides: rpc, fs, callMain, workspace tree/branches/commits,
 * connection error handling, method exposure, theme, focus.
 *
 * Does NOT include: stateArgs, panel handles, panel-specific features.
 */
import { createRpcClient, type EnvelopeRpcTransport } from "@vibestudio/rpc";
import { createWorkerdClient } from "../shared/workerd.js";
import type { GatewayConfig } from "../shared/globals.js";
import { createMainCaller } from "../shared/mainRpc.js";
import type { PaletteCommand, RuntimeFs, ThemeAppearance, ThemeConfig } from "../types.js";
import { DEFAULT_THEME_CONFIG } from "../types.js";

export interface BaseRuntimeDeps {
  selfId: string;
  /** Primary envelope transport (single WS for panels, WS for workers) */
  createTransport: () => EnvelopeRpcTransport;
  id: string;
  contextId: string;
  initialTheme: ThemeAppearance;
  fs: RuntimeFs;
  setupGlobals?: () => void;
  gatewayConfig?: GatewayConfig | null;
}

export function createBaseRuntime(deps: BaseRuntimeDeps) {
  deps.setupGlobals?.();
  const primaryTransport = deps.createTransport();
  const rpc = createRpcClient({
    selfId: deps.selfId,
    transport: primaryTransport,
    authorityAcquisition: "wait",
  });
  const fs = deps.fs;
  const callMain = createMainCaller(rpc);
  const workers = createWorkerdClient(rpc);

  let currentTheme: ThemeAppearance = deps.initialTheme;
  const themeListeners = new Set<(theme: ThemeAppearance) => void>();

  // App-wide theme identity (accent/radius/...), pushed by the shell on the
  // same `runtime:theme` event as appearance.
  let currentThemeConfig: ThemeConfig = DEFAULT_THEME_CONFIG;
  const themeConfigListeners = new Set<(config: ThemeConfig) => void>();

  const parseThemeAppearance = (payload: unknown): ThemeAppearance | null => {
    const appearance =
      typeof payload === "string"
        ? payload
        : typeof (
              payload as {
                theme?: unknown;
              } | null
            )?.theme === "string"
          ? (
              payload as {
                theme: ThemeAppearance;
              }
            ).theme
          : null;
    if (appearance === "light" || appearance === "dark") return appearance;
    return null;
  };

  const parseThemeConfig = (payload: unknown): ThemeConfig | null => {
    const config = (payload as { config?: unknown } | null)?.config;
    if (!config || typeof config !== "object") return null;
    const c = config as Record<string, unknown>;
    if (typeof c["accentColor"] !== "string" || typeof c["grayColor"] !== "string") return null;
    return {
      accentColor: c["accentColor"],
      grayColor: c["grayColor"],
      radius: (c["radius"] as ThemeConfig["radius"]) ?? DEFAULT_THEME_CONFIG.radius,
      scaling: (c["scaling"] as ThemeConfig["scaling"]) ?? DEFAULT_THEME_CONFIG.scaling,
      panelBackground:
        (c["panelBackground"] as ThemeConfig["panelBackground"]) ??
        DEFAULT_THEME_CONFIG.panelBackground,
    };
  };

  const applyThemeConfig = (config: ThemeConfig) => {
    currentThemeConfig = config;
    for (const listener of themeConfigListeners) listener(currentThemeConfig);
  };

  const onThemeEvent = (payload: unknown) => {
    const config = parseThemeConfig(payload);
    if (config) applyThemeConfig(config);

    const theme = parseThemeAppearance(payload);
    if (!theme) return;
    currentTheme = theme;
    for (const listener of themeListeners) listener(currentTheme);
  };

  // Theme events come from:
  // - Electron: via __vibestudioShell.addEventListener
  // - Server WS: via rpc.on (for both Electron and standalone)
  const themeUnsubscribers = [rpc.on("runtime:theme", (event) => onThemeEvent(event.payload))];

  // Best-effort boot fetch: a late-loaded panel converges to a user-changed
  // accent without waiting for the next theme push. Non-panel/worker contexts
  // (no such main method) simply reject, so swallow it.
  void rpc
    .call("main", "view.getThemeConfig", [])
    .then((cfg) => {
      const parsed = parseThemeConfig({ config: cfg });
      if (parsed) applyThemeConfig(parsed);
    })
    .catch(() => {});

  // Focus listeners — maintained as a direct set so Electron IPC events
  // can trigger them without going through the RPC bridge.
  const focusCallbacks = new Set<() => void>();
  const focusUnsubscribers: Array<() => void> = [];

  // Also listen for focus via RPC (standalone mode, server-sent events)
  const rpcFocusUnsub = rpc.on("runtime:focus", () => {
    for (const cb of focusCallbacks) cb();
  });
  focusUnsubscribers.push(rpcFocusUnsub);

  const onFocus = (callback: () => void) => {
    focusCallbacks.add(callback);
    const unsub = () => {
      focusCallbacks.delete(callback);
    };
    focusUnsubscribers.push(unsub);
    return () => {
      unsub();
      const idx = focusUnsubscribers.indexOf(unsub);
      if (idx !== -1) focusUnsubscribers.splice(idx, 1);
    };
  };

  // Command-palette dispatch is panel ↔ shell messaging. Contributions are
  // chrome-local UI state; they never transit a host service.
  const paletteRunCallbacks = new Set<(commandId: string) => void>();
  const onPaletteRunEvent = (payload: unknown) => {
    const commandId = (payload as { commandId?: unknown } | null)?.commandId;
    if (typeof commandId !== "string") return;
    for (const cb of paletteRunCallbacks) cb(commandId);
  };
  const paletteUnsubscribers = [
    rpc.on("runtime:palette-run", (event) => onPaletteRunEvent(event.payload)),
  ];

  // Wire __vibestudioShell events if available (Electron mode)
  const electron = (globalThis as any).__vibestudioShell;
  let electronListenerId: number | undefined;
  if (electron?.addEventListener) {
    electronListenerId = electron.addEventListener((event: string, payload: unknown) => {
      if (event === "runtime:theme") {
        onThemeEvent(payload);
      } else if (event === "runtime:focus") {
        // Directly invoke focus callbacks; no RPC bridge roundtrip needed.
        for (const cb of focusCallbacks) cb();
      } else if (event === "runtime:palette-run") {
        onPaletteRunEvent(payload);
      }
    });
  }

  const destroy = () => {
    for (const unsub of themeUnsubscribers) unsub();
    for (const unsub of focusUnsubscribers) unsub();
    for (const unsub of paletteUnsubscribers) unsub();
    void rpc.emit("shell", "runtime:palette-contribution", { commands: [] }).catch(() => {});
    focusUnsubscribers.length = 0;
    themeListeners.clear();
    themeConfigListeners.clear();
    paletteRunCallbacks.clear();
    if (electronListenerId !== undefined && electron?.removeEventListener) {
      electron.removeEventListener(electronListenerId);
    }
  };

  const onConnectionError = (
    callback: (error: { code: number; reason: string; source?: "electron" | "server" }) => void
  ): (() => void) => {
    return rpc.on("runtime:connection-error", (event) => {
      if (event.caller.callerId !== "main") return;
      const payload = event.payload;
      const data = payload as {
        code?: unknown;
        reason?: unknown;
        source?: unknown;
      } | null;
      if (!data || typeof data.code !== "number" || typeof data.reason !== "string") return;
      callback({
        code: data.code,
        reason: data.reason,
        source: data.source === "electron" || data.source === "server" ? data.source : undefined,
      });
    });
  };

  return {
    id: deps.id,
    rpc,
    fs,
    workers,
    callMain,
    onConnectionError,
    getTheme: () => currentTheme,
    onThemeChange: (callback: (theme: ThemeAppearance) => void) => {
      callback(currentTheme);
      themeListeners.add(callback);
      return () => {
        themeListeners.delete(callback);
      };
    },
    getThemeConfig: () => currentThemeConfig,
    onThemeConfigChange: (callback: (config: ThemeConfig) => void) => {
      callback(currentThemeConfig);
      themeConfigListeners.add(callback);
      return () => {
        themeConfigListeners.delete(callback);
      };
    },
    onFocus,
    registerPaletteCommands: (commands: PaletteCommand[]) => {
      void rpc.emit("shell", "runtime:palette-contribution", { commands }).catch(() => {});
    },
    unregisterPaletteCommands: () => {
      void rpc.emit("shell", "runtime:palette-contribution", { commands: [] }).catch(() => {});
    },
    onPaletteRun: (callback: (commandId: string) => void) => {
      paletteRunCallbacks.add(callback);
      return () => {
        paletteRunCallbacks.delete(callback);
      };
    },
    expose: (method: string, handler: (...args: any[]) => unknown | Promise<unknown>) => {
      rpc.expose(method, (request) => handler(...request.args));
    },
    gatewayConfig: deps.gatewayConfig ?? null,
    contextId: deps.contextId,
    destroy,
  };
}

export type BaseRuntime = ReturnType<typeof createBaseRuntime>;
