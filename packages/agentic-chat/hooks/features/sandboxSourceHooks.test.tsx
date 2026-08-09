// @vitest-environment jsdom

import React, { useEffect } from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactJsxDevRuntime from "react/jsx-dev-runtime";
import * as RadixThemes from "@radix-ui/themes";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONTENT_TYPE_INLINE_UI } from "@workspace/pubsub";
import { useActionBar } from "./useActionBar";
import { useInlineUi } from "./useInlineUi";
import type { ActionBarHookState } from "./useActionBar";
import type { InlineUiState } from "./useInlineUi";
import type { ChatMessage } from "../../types";

function makeMessage(content: unknown): ChatMessage {
  return {
    id: "msg-1",
    senderId: "agent-1",
    content: JSON.stringify(content),
    contentType: CONTENT_TYPE_INLINE_UI,
    kind: "message",
    complete: true,
  } as ChatMessage;
}

describe("sandbox source hooks", () => {
  let originalModuleMap: unknown;
  let originalRequire: unknown;
  let originalPreload: unknown;
  let originalRequestIdleCallback: typeof globalThis.requestIdleCallback | undefined;
  let originalCancelIdleCallback: typeof globalThis.cancelIdleCallback | undefined;

  beforeEach(() => {
    originalModuleMap = (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"];
    originalRequire = (globalThis as Record<string, unknown>)["__vibestudioRequire__"];
    originalPreload = (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"];
    originalRequestIdleCallback = globalThis.requestIdleCallback;
    originalCancelIdleCallback = globalThis.cancelIdleCallback;

    const moduleMap: Record<string, unknown> = {};
    (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"] = moduleMap;
    (globalThis as Record<string, unknown>)["__vibestudioRequire__"] = (id: string) => {
      if (id in moduleMap) return moduleMap[id];
      throw new Error(`Module not found: ${id}`);
    };
    (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"] = async (
      ids: string[]
    ) =>
      ids.map((id) => {
        if (id in moduleMap) return moduleMap[id];
        throw new Error(`Module not found: ${id}`);
      });
  });

  afterEach(() => {
    if (originalModuleMap === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"];
    else (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"] = originalModuleMap;
    if (originalRequire === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioRequire__"];
    else (globalThis as Record<string, unknown>)["__vibestudioRequire__"] = originalRequire;
    if (originalPreload === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"];
    else (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"] = originalPreload;
    if (originalRequestIdleCallback === undefined)
      delete (globalThis as Record<string, unknown>)["requestIdleCallback"];
    else globalThis.requestIdleCallback = originalRequestIdleCallback;
    if (originalCancelIdleCallback === undefined)
      delete (globalThis as Record<string, unknown>)["cancelIdleCallback"];
    else globalThis.cancelIdleCallback = originalCancelIdleCallback;
  });

  it("compiles inline_ui file sources with package.json inferred imports", async () => {
    const states: InlineUiState[] = [];
    const loadCalls: Array<{ specifier: string; ref: string | undefined }> = [];
    const loadSourceFile = async (path: string) => {
      if (path === "packages/app/ui.tsx")
        return `import { label } from "label-lib"; export default function App() { return label; }`;
      if (path === "packages/app/package.json")
        return JSON.stringify({ dependencies: { "label-lib": "2" } });
      throw new Error(`Missing ${path}`);
    };
    const loadImport = async (specifier: string, ref: string | undefined) => {
      loadCalls.push({ specifier, ref });
      return { bundle: `module.exports = { label: "ready" };`, format: "cjs" as const };
    };
    const messages = [
      makeMessage({ id: "ui-1", source: { type: "file", path: "packages/app/ui.tsx" } }),
    ];

    function Harness() {
      const state = useInlineUi({ messages, loadSourceFile, loadImport });
      useEffect(() => {
        states.push(state);
      }, [state]);
      return null;
    }

    render(<Harness />);

    await waitFor(
      () => {
        const entry = states[states.length - 1]?.inlineUiComponents.get("ui-1");
        expect(entry?.Component).toBeTruthy();
      },
      { timeout: 5_000 }
    );
    expect(loadCalls).toEqual([{ specifier: "label-lib", ref: "npm:2" }]);
  });

  it("compiles action bar file sources with package.json inferred imports", async () => {
    const states: ActionBarHookState[] = [];
    const loadCalls: Array<{ specifier: string; ref: string | undefined }> = [];
    const loadSourceFile = async (path: string) => {
      if (path === "packages/app/bar.tsx")
        return `import { label } from "label-lib"; export default function Bar() { return label; }`;
      if (path === "packages/app/package.json")
        return JSON.stringify({ dependencies: { "label-lib": "3" } });
      throw new Error(`Missing ${path}`);
    };
    const loadImport = async (specifier: string, ref: string | undefined) => {
      loadCalls.push({ specifier, ref });
      return { bundle: `module.exports = { label: "ready" };`, format: "cjs" as const };
    };
    const data = { id: "bar-1", source: { type: "file" as const, path: "packages/app/bar.tsx" } };

    function Harness() {
      const state = useActionBar({
        data,
        loadSourceFile,
        loadImport,
      });
      useEffect(() => {
        states.push(state);
      }, [state]);
      return null;
    }

    render(<Harness />);

    await waitFor(
      () => {
        const entry = states[states.length - 1]?.actionBar?.component;
        expect(entry?.error).toBeUndefined();
        expect(entry?.Component).toBeTruthy();
      },
      { timeout: 5_000 }
    );
    expect(loadCalls).toEqual([{ specifier: "label-lib", ref: "npm:3" }]);
  });

  it("starts action bar compilation as background work after primary panel effects", async () => {
    const events: string[] = [];
    const idleCallbacks = new Map<number, IdleRequestCallback>();
    let nextIdleHandle = 1;
    globalThis.requestIdleCallback = (callback) => {
      const handle = nextIdleHandle++;
      idleCallbacks.set(handle, callback);
      return handle;
    };
    globalThis.cancelIdleCallback = (handle) => {
      idleCallbacks.delete(handle);
    };

    function Harness() {
      const state = useActionBar({
        data: {
          id: "background-bar",
          source: { type: "file", path: "packages/app/bar.tsx" },
        },
        loadSourceFile: async () => {
          events.push("action-bar-source");
          return "export default function Bar() { return null; }";
        },
      });
      useEffect(() => {
        events.push("primary-panel-effect");
      }, []);
      return state.actionBar?.component?.Component ? <div>ready</div> : null;
    }

    const view = render(<Harness />);

    expect(events).toEqual(["primary-panel-effect"]);
    expect(view.queryByText("ready")).toBeNull();
    expect(idleCallbacks.size).toBe(1);

    const idleCallback = idleCallbacks.values().next().value;
    expect(idleCallback).toBeTypeOf("function");
    act(() => {
      idleCallback!({ didTimeout: false, timeRemaining: () => 50 });
    });

    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    expect(events).toEqual(["primary-panel-effect", "action-bar-source"]);
  });

  it("renders the compiled model credential card with the panel's exposed modules", async () => {
    const moduleMap = (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"] as Record<
      string,
      unknown
    >;
    moduleMap["react"] = React;
    moduleMap["react/jsx-runtime"] = ReactJsxRuntime;
    moduleMap["react/jsx-dev-runtime"] = ReactJsxDevRuntime;
    moduleMap["@radix-ui/themes"] = RadixThemes;

    const sourcePath = "packages/agentic-chat/components/ModelCredentialRequiredCard.tsx";
    const cwd = process.cwd();
    const checkoutRoot = path.basename(cwd) === "workspace" ? path.dirname(cwd) : cwd;
    const source = await readFile(path.join(checkoutRoot, "workspace", sourcePath), "utf8");
    const states: InlineUiState[] = [];
    const messages = [
      makeMessage({
        id: "model-credential-card",
        source: { type: "file", path: sourcePath },
        props: {
          providerId: "openai-codex",
          modelRef: "openai-codex:gpt-test",
          modelBaseUrl: "https://chatgpt.com/backend-api",
          flow: { type: "oauth-browser" },
        },
      }),
    ];

    function Harness() {
      const state = useInlineUi({
        messages,
        loadSourceFile: async (path) => {
          if (path === sourcePath) return source;
          throw new Error(`Missing ${path}`);
        },
      });
      useEffect(() => {
        states.push(state);
      }, [state]);
      const Component = state.inlineUiComponents.get("model-credential-card")?.Component;
      return Component ? (
        <Component
          props={JSON.parse(messages[0]!.content).props}
          chat={{ callMethod: async () => ({}) }}
          scope={{}}
          scopes={{}}
        />
      ) : null;
    }

    const view = render(<Harness />);

    await waitFor(() => {
      expect(
        states[states.length - 1]?.inlineUiComponents.get("model-credential-card")?.error
      ).toBeUndefined();
      expect(view.getByText(/Credential required for/)).toBeTruthy();
    });
  });
});
