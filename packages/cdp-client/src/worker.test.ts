import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserImpl, CdpConnection, CdpError } from "./worker";
import { webSocketAuthProtocol } from "@vibestudio/rpc/protocol/webSocketAuthProtocol";

/**
 * Fake CDP transport. Understands two kinds of Runtime.evaluate:
 *  - direct arrow-function evals (title/url/content/readyState), matched by substring;
 *  - op evals of the form `(async function(P){ <INPAGE> ... })(<JSON>)`, whose trailing
 *    JSON payload `{op, descriptor, arg, ...}` is decoded and simulated against a tiny
 *    fixed DOM.
 * Records every dispatched CDP method so pointer/key actions can be asserted.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  static dropMethods = new Set<string>();
  static emitNavigationEventBeforeResponse = false;

  private listeners = new Map<string, Set<(event: { data?: string }) => void>>();
  private nextTitle = "Example";
  private nextUrl = "https://example.com/current";
  private html = "<html><body>Hello</body></html>";
  private inputValue = "";
  private checked = false;
  private checking = false;
  closed = false;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[]
  ) {
    FakeWebSocket.instances.push(this);
    setTimeout(() => this.dispatch("open", {}), 0);
  }

  addEventListener(event: string, handler: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(handler);
    this.listeners.set(event, listeners);
  }
  removeEventListener(event: string, handler: (event: { data?: string }) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as {
      id?: number;
      type?: string;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (typeof message.id !== "number") return;
    if (message.method) FakeWebSocket.sent.push({ method: message.method, params: message.params });
    if (message.method && FakeWebSocket.dropMethods.has(message.method)) return;
    if (
      message.method === "Input.dispatchMouseEvent" &&
      message.params?.["type"] === "mouseReleased" &&
      this.checking
    ) {
      this.checked = !this.checked;
      this.checking = false;
    }
    if (message.method === "Runtime.enable") {
      setTimeout(
        () =>
          this.dispatch("message", {
            data: JSON.stringify({
              method: "Runtime.consoleAPICalled",
              params: { type: "log", args: [{ value: "ready" }, { value: 42 }] },
            }),
          }),
        0
      );
    }
    const result = this.resultFor(message.method, message.params);
    if (message.method === "Page.navigate" && FakeWebSocket.emitNavigationEventBeforeResponse) {
      this.dispatch("message", {
        data: JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 0 } }),
      });
    }
    setTimeout(
      () => this.dispatch("message", { data: JSON.stringify({ id: message.id, result }) }),
      0
    );
    if (message.method === "Page.navigate") {
      // Real Chrome fires the load lifecycle event AFTER the navigate response. Emit it after the
      // response (queued later) so the client's navigation-settled wait — which goto() only registers
      // once it has awaited the navigate response — actually catches it instead of hanging to timeout.
      if (!FakeWebSocket.emitNavigationEventBeforeResponse) {
        setTimeout(
          () =>
            this.dispatch("message", {
              data: JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 0 } }),
            }),
          0
        );
      }
    }
  }

  close(): void {
    this.closed = true;
    this.dispatch("close", {});
  }

  remoteClose(): void {
    this.closed = true;
    this.dispatch("close", {});
  }

  private resultFor(method?: string, params?: Record<string, unknown>): unknown {
    if (method === "Page.navigate") {
      this.nextUrl = (params?.["url"] as string) ?? this.nextUrl;
      return {};
    }
    if (method === "Page.getNavigationHistory") {
      return { currentIndex: 1, entries: [{ id: 0 }, { id: 1 }, { id: 2 }] };
    }
    if (method === "Page.captureScreenshot") return { data: "AAAA" };
    if (method !== "Runtime.evaluate") return {};

    const expression = (params?.["expression"] as string) ?? "";
    if (expression.includes("boom-marker")) {
      return {
        exceptionDetails: {
          text: "Uncaught",
          url: "https://example.com/panel.js",
          lineNumber: 11,
          columnNumber: 6,
          exception: {
            description:
              "ReferenceError: boom-marker is not defined\n    at save (https://example.com/panel.js:12:7)",
          },
        },
      };
    }
    // Op-protocol eval: decode the trailing JSON payload and simulate __nsRun.
    if (expression.includes("__nsRun")) {
      return { result: { value: this.runOp(expression) } };
    }
    // Direct arrow-function evals.
    if (expression.includes("location.href")) return { result: { value: this.nextUrl } };
    if (expression.includes("window.innerWidth")) {
      return { result: { value: { width: 1280, height: 720 } } };
    }
    if (expression.includes("document.title")) return { result: { value: this.nextTitle } };
    if (expression.includes("document.readyState")) return { result: { value: true } };
    if (expression.includes("document.documentElement")) return { result: { value: this.html } };
    return { result: { value: undefined } };
  }

  private runOp(expression: string): unknown {
    const marker = "})(";
    const start = expression.lastIndexOf(marker) + marker.length;
    const end = expression.lastIndexOf(")");
    const payload = JSON.parse(expression.slice(start, end)) as {
      op: string;
      arg: {
        name?: string;
        value?: string;
        values?: string[];
        checked?: boolean;
        retainToken?: string;
        token?: string;
      } | null;
      descriptor: { steps: Array<Record<string, unknown>> };
    };
    const targetsMissing = payload.descriptor.steps.some(
      (s) =>
        (s["by"] === "testid" && s["value"] === "missing") ||
        (s["by"] === "role" && (s["name"] === "Done" || s["name"] === "Completed"))
    );
    switch (payload.op) {
      case "probe":
        if (payload.arg?.retainToken) this.checking = true;
        return targetsMissing
          ? { ok: false, reason: "not found" }
          : { ok: true, x: 50, y: 10, box: { x: 0, y: 0, width: 100, height: 20 } };
      case "waitFor":
        return true;
      case "count":
        return 1;
      case "exists":
        return true;
      case "isVisible":
      case "isEnabled":
      case "isEditable":
        return true;
      case "checkedState":
        this.checking = true;
        return this.checked;
      case "retainedCheckedState":
        return this.checked;
      case "releaseRetainedElement":
        return true;
      case "isChecked":
        return this.checked;
      case "isDisabled":
        return false;
      case "textContent":
        return "Hello text";
      case "innerText":
        return "Hello";
      case "inputValue":
        return this.inputValue;
      case "getAttribute":
        return payload.arg?.name === "id" ? "main" : null;
      case "boundingBox":
        return { x: 0, y: 0, width: 100, height: 20 };
      case "allTextContents":
        return ["Hello text"];
      case "allInnerTexts":
        return ["Hello"];
      case "evaluateAll":
        return ["Hello"];
      case "evaluate":
        return "<strong>Hello</strong>";
      case "roleCandidates":
        if (payload.descriptor.steps.some((step) => step["name"] === "Completed")) {
          return [
            { role: "radio", accessibleName: "Completed" },
            { role: "tab", accessibleName: "Completed" },
          ];
        }
        return [
          { role: "button", accessibleName: "All 5" },
          { role: "button", accessibleName: "Open 2" },
          { role: "button", accessibleName: "Done 3" },
        ];
      case "inspect":
        return {
          found: true,
          tagName: "BODY",
          id: "",
          className: "ready",
          text: "Hello",
          role: "document",
          accessibleName: "Hello",
          visible: true,
          attributes: { class: "ready" },
          boundingBox: { x: 0, y: 0, width: 100, height: 20 },
          ancestors: [
            {
              tagName: "MAIN",
              role: "main",
              accessibleName: "Example panel",
              text: "Example panel Hello",
            },
          ],
        };
      case "fill":
        this.inputValue = payload.arg?.value ?? "";
        return true;
      case "clear":
        this.inputValue = "";
        return true;
      case "selectOption":
        return payload.arg?.values ?? [];
      case "focus":
      case "blur":
      case "scrollIntoView":
      case "selectText":
      case "dispatchEvent":
      case "focusForKey":
        return true;
      default:
        return undefined;
    }
  }

  private dispatch(event: string, payload: { data?: string }): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function installFakeWebSocket(): void {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
}

describe("worker CDP client", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const originalWebSocketPair = (globalThis as Record<string, unknown>)["WebSocketPair"];

  afterEach(() => {
    vi.useRealTimers();
    FakeWebSocket.instances = [];
    FakeWebSocket.sent = [];
    FakeWebSocket.dropMethods.clear();
    FakeWebSocket.emitNavigationEventBeforeResponse = false;
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    Object.defineProperty(globalThis, "WebSocketPair", {
      configurable: true,
      writable: true,
      value: originalWebSocketPair,
    });
  });

  it("uses the Workers fetch-upgrade transport when WebSocket is not global", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const socket = new FakeWebSocket("ws://cdp");
    const accept = vi.fn();
    Object.assign(socket, { accept });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        ({
          status: 101,
          webSocket: socket,
        }) as unknown as Response
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    const connection = await CdpConnection.connect("ws://cdp", "token");
    await expect(connection.send("Runtime.evaluate", {})).resolves.toEqual({
      result: { value: undefined },
    });

    const [upgradeUrl, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({ headers: { Upgrade: "websocket" } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const parsedUpgradeUrl = new URL(String(upgradeUrl));
    const encodedHeaders = parsedUpgradeUrl.searchParams.get("__vibestudio_ws_headers");
    expect(encodedHeaders).toBeTruthy();
    const normalized = encodedHeaders!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    expect(JSON.parse(atob(padded))).toEqual([["x-vibestudio-cdp-grant", "token"]]);
    parsedUpgradeUrl.searchParams.delete("__vibestudio_ws_headers");
    expect(parsedUpgradeUrl).toEqual(new URL("http://cdp/"));
    expect(accept).toHaveBeenCalledOnce();
  });

  it("uses fetch upgrades in workerd even when a global WebSocket exists", async () => {
    installFakeWebSocket();
    Object.defineProperty(globalThis, "WebSocketPair", {
      configurable: true,
      writable: true,
      value: class WebSocketPair {},
    });
    const socket = new FakeWebSocket("ws://cdp");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        ({
          status: 101,
          webSocket: socket,
        }) as unknown as Response
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    const connection = await CdpConnection.connect("ws://cdp", "token");
    await expect(connection.send("Runtime.evaluate", {})).resolves.toEqual({
      result: { value: undefined },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]).toBe(socket);
  });

  it("bounds a fetch upgrade that never resolves", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => {})
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });
    vi.useFakeTimers();

    const connection = CdpConnection.connect("ws://cdp", "token");
    const rejection = expect(connection).rejects.toThrow(
      "CDP WebSocket upgrade timed out after 15000ms"
    );
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("authenticates and exposes page navigation + console capture", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp", {
      transportOptions: { authToken: "token" },
    });
    expect(FakeWebSocket.instances[0]?.protocols).toEqual([
      webSocketAuthProtocol("inspection", "token"),
    ]);
    const page = browser.contexts()[0]!.pages()[0]!;

    await expect(page.title()).resolves.toBe("Example");
    expect(page.url()).toBe("https://example.com/current");
    await expect(page.content()).resolves.toBe("<html><body>Hello</body></html>");
    await page.goto("https://example.com/next");
    expect(page.url()).toBe("https://example.com/next");
    await expect(page.waitForLoadState("domcontentloaded")).resolves.toBeUndefined();
    await expect(page.waitForFunction(() => document.readyState === "complete")).resolves.toBe(
      true
    );

    expect(page.consoleEvents()).toEqual([{ type: "log", text: "ready 42", args: ["ready", 42] }]);
    page.clearConsoleEvents();
    expect(page.consoleEvents()).toEqual([]);
  });

  it("subscribes to navigation lifecycle before sending Page.navigate", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;
    FakeWebSocket.emitNavigationEventBeforeResponse = true;

    await expect(page.goto("https://example.com/fast")).resolves.toBeDefined();
    expect(page.url()).toBe("https://example.com/fast");
  });

  it("bounds a command that the relay never answers and closes the page connection", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp", { commandTimeoutMs: 10 });
    const page = browser.contexts()[0]!.pages()[0]!;
    const socket = FakeWebSocket.instances[0]!;
    FakeWebSocket.dropMethods.add("Runtime.evaluate");

    await expect(page.title()).rejects.toThrow(
      "CDP command timed out after 10ms: Runtime.evaluate"
    );
    expect(socket.closed).toBe(true);
  });

  it("compiles CSS, text selectors, and getBy locators into one descriptor model", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    await expect(page.locator("body").count()).resolves.toBe(1);
    await expect(page.locator("body").textContent()).resolves.toBe("Hello text");
    await expect(page.locator('text="Hello"').innerText()).resolves.toBe("Hello");
    expect(page.locator('text="Hello"')).toMatchObject({
      descriptor: { steps: [{ by: "text", value: "Hello", exact: true }] },
    });
    expect(page.locator("text=Hello")).toMatchObject({
      descriptor: { steps: [{ by: "text", value: "Hello", exact: false }] },
    });
    expect(() => page.locator('text="unterminated')).toThrow(
      "quoted text must be a valid JSON string"
    );
    await expect(page.getByText("Hello").innerText()).resolves.toBe("Hello");
    const textEvaluation = FakeWebSocket.sent
      .filter((entry) => entry.method === "Runtime.evaluate")
      .map((entry) => String(entry.params?.["expression"] ?? ""))
      .find((expression) => expression.includes('"op":"innerText"'));
    expect(textEvaluation).toContain("nsHasTextMatchingDescendant");
    expect(textEvaluation).toContain(
      'case "innerText": { var e=await nsWaitForState(d,"attached",t)'
    );
    expect(textEvaluation).not.toContain(
      'case "innerText": { var e=await nsWaitForState(d,"visible",t)'
    );
    await expect(page.getByRole("button", { name: "Sign in" }).isVisible()).resolves.toBe(true);
    await expect(page.getByTestId("widget").isEnabled()).resolves.toBe(true);
    await expect(page.getByLabel("Email").getAttribute("id")).resolves.toBe("main");
    await expect(page.locator("li").allInnerTexts()).resolves.toEqual(["Hello"]);
    await expect(
      page.locator("li").evaluateAll((elements) => elements.map((element) => element.textContent))
    ).resolves.toEqual(["Hello"]);
    await expect(page.locator("body").evaluate((element) => element.innerHTML)).resolves.toBe(
      "<strong>Hello</strong>"
    );
    await expect(page.locator("body").inspect()).resolves.toMatchObject({
      found: true,
      tagName: "BODY",
      className: "ready",
      role: "document",
      accessibleName: "Hello",
      ancestors: [
        {
          tagName: "MAIN",
          role: "main",
          accessibleName: "Example panel",
          text: "Example panel Hello",
        },
      ],
    });
    expect("innerText" in page).toBe(false);
    expect("isVisible" in page).toBe(false);
  });

  it("disconnects page automation without implying target ownership", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;
    const socket = FakeWebSocket.instances[0]!;

    await page.close();
    await page.close();

    expect(socket.closed).toBe(true);
    await expect(page.title()).rejects.toThrow(
      "Cannot send Runtime.evaluate: CDP connection closed by the client"
    );
  });

  it("preserves the runtime-replacement recovery reason after a remote target close", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;
    const socket = FakeWebSocket.instances[0]!;

    socket.remoteClose();

    await expect(page.title()).rejects.toThrow(
      "runtime may have been replaced by handle.navigate() or handle.rebuild()"
    );
    await expect(page.title()).rejects.toThrow(
      "obtain a fresh page with await handle.cdp.page(); do not reuse the cached page"
    );
  });

  it("sets and reports the CSS viewport through CDP emulation", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
    await page.setViewportSize({ width: 390, height: 844 });

    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
    expect(FakeWebSocket.sent).toContainEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: false,
      },
    });
    await expect(page.setViewportSize({ width: 0, height: 844 })).rejects.toThrow(
      "positive integer width and height"
    );
  });

  it("dispatches a real CDP mouse sequence for click (auto-waited)", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    await page.getByRole("button", { name: "Go" }).click();

    const probeEvaluation = FakeWebSocket.sent
      .filter((entry) => entry.method === "Runtime.evaluate")
      .map((entry) => String(entry.params?.["expression"] ?? ""))
      .find((expression) => expression.includes('"op":"probe"'));
    expect(probeEvaluation).toContain("document.elementFromPoint(x,y)");
    expect(probeEvaluation).toContain("hit===el || el.contains(hit)");
    const mouse = FakeWebSocket.sent.filter((s) => s.method === "Input.dispatchMouseEvent");
    expect(mouse.map((m) => m.params?.["type"])).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    expect(mouse[1]?.params).toMatchObject({ x: 50, y: 10, button: "left", clickCount: 1 });
    const releaseIndex = FakeWebSocket.sent.findIndex(
      (event) =>
        event.method === "Input.dispatchMouseEvent" && event.params?.["type"] === "mouseReleased"
    );
    expect(FakeWebSocket.sent.slice(releaseIndex + 1)).toContainEqual({
      method: "Runtime.evaluate",
      params: expect.objectContaining({
        expression: "new Promise((resolve) => setTimeout(resolve, 0))",
      }),
    });
  });

  it("fills and reads back input value, and toggles a checkbox", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    await page.getByPlaceholder("Name").fill("abc");
    await expect(page.locator("input").inputValue()).resolves.toBe("abc");
    const fillEvaluation = FakeWebSocket.sent
      .filter((entry) => entry.method === "Runtime.evaluate")
      .map((entry) => String(entry.params?.["expression"] ?? ""))
      .find((expression) => expression.includes('"op":"fill"'));
    expect(fillEvaluation).toContain("Object.getOwnPropertyDescriptor(proto,name)");
    expect(fillEvaluation).toContain("new InputEvent");
    expect(fillEvaluation).toContain("await nsAfterAction()");
    await page.locator("input").type("123");
    await expect(page.locator("input").inputValue()).resolves.toBe("abc123");

    await page.getByRole("checkbox").check();
    await expect(page.getByRole("checkbox").isChecked()).resolves.toBe(true);
    await page.getByRole("checkbox").uncheck();
    await expect(page.getByRole("checkbox").isChecked()).resolves.toBe(false);
    const checkboxOps = FakeWebSocket.sent
      .filter((entry) => entry.method === "Runtime.evaluate")
      .map((entry) => String(entry.params?.["expression"] ?? ""));
    expect(
      checkboxOps.some((expression) => expression.includes('"op":"retainedCheckedState"'))
    ).toBe(true);
    expect(
      checkboxOps.some((expression) => expression.includes('"op":"releaseRetainedElement"'))
    ).toBe(true);
    await expect(page.getByRole("combobox").selectOption("two")).resolves.toEqual(["two"]);
  });

  it("supports page keyboard chords and text insertion", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    await page.keyboard.press("Control+A");
    await page.keyboard.insertText("replacement");

    const keyEvents = FakeWebSocket.sent.filter(
      (event) => event.method === "Input.dispatchKeyEvent"
    );
    expect(
      keyEvents.some(
        (event) =>
          event.params?.["key"] === "A" &&
          event.params?.["type"] === "keyDown" &&
          event.params?.["modifiers"] === 2
      )
    ).toBe(true);
    expect(
      FakeWebSocket.sent.some(
        (event) => event.method === "Input.insertText" && event.params?.["text"] === "replacement"
      )
    ).toBe(true);
  });

  it("surfaces browser exception identity, message, and stack", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    await expect(
      page.evaluate(() => {
        throw new Error("boom-marker");
      })
    ).rejects.toThrow(
      "Browser evaluation failed: ReferenceError: boom-marker is not defined\n" +
        "    at save (https://example.com/panel.js:12:7)"
    );
  });

  it("captures a screenshot via Page.captureScreenshot and maps type to CDP format", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;
    const shot = await page.screenshot({ type: "jpeg", quality: 80 });
    expect(shot).toBeInstanceOf(Uint8Array);
    expect(shot.length).toBeGreaterThan(0);
    const capture = FakeWebSocket.sent
      .filter((entry) => entry.method === "Page.captureScreenshot")
      .pop();
    expect(capture).toEqual({
      method: "Page.captureScreenshot",
      params: { format: "jpeg", quality: 80 },
    });
  });

  it("supports full-page capture and rejects silently ignored screenshot options", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    await page.screenshot({ fullPage: true });
    expect(FakeWebSocket.sent).toContainEqual({
      method: "Page.captureScreenshot",
      params: { captureBeyondViewport: true },
    });
    await expect(
      page.screenshot({ path: ".tmp/panel.png" } as unknown as { type?: "png" })
    ).rejects.toThrow("store it explicitly with @workspace/runtime blobstore.putBytes");
  });

  it("exposes a raw CdpConnection for protocol-level work", async () => {
    installFakeWebSocket();
    const conn = await CdpConnection.connect("ws://cdp", "token");
    const events: unknown[] = [];
    conn.on("Custom.event", (p) => events.push(p));
    await expect(conn.send("Page.navigate", { url: "https://x" })).resolves.toBeDefined();
    conn.close();
  });

  it("renders Playwright-style locator descriptions via toString()", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    expect(page.getByRole("button", { name: "Go" }).toString()).toBe(
      'getByRole("button", { name: "Go" })'
    );
    expect(page.getByRole("button", { name: /delete item/i }).toString()).toBe(
      'getByRole("button", { name: /delete item/i })'
    );
    expect(page.getByRole("button", { name: /delete item/i })).toMatchObject({
      descriptor: {
        steps: [
          {
            by: "role",
            name: { regex: { source: "delete item", flags: "i" } },
          },
        ],
      },
    });
    expect(page.getByText("Hello").nth(2).toString()).toBe('getByText("Hello").nth(2)');
    expect(page.locator("div").first().toString()).toBe('locator("div").first()');
    expect(page.locator('text="Hello"').toString()).toBe('getByText("Hello", { exact: true })');
    expect(page.getByTestId("save").toString()).toBe('getByTestId("save")');
  });

  it("throws a CdpError that names the locator when an element is not actionable", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    const err = await page
      .getByTestId("missing")
      .click()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpError);
    expect((err as CdpError).message).toContain('getByTestId("missing")');
    expect((err as CdpError).locator).toBe('getByTestId("missing")');
  });

  it("reports available accessible names when a named role locator misses", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    const err = await page
      .getByRole("button", { name: "Done" })
      .click()
      .catch((error: unknown) => error);

    expect((err as Error).message).toContain('Available button names: "All 5", "Open 2", "Done 3"');
  });

  it("reports matching accessible targets when the requested role is wrong", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    const err = await page
      .getByRole("button", { name: "Completed" })
      .click()
      .catch((error: unknown) => error);

    expect((err as Error).message).toContain(
      'Available accessible targets: radio "Completed", tab "Completed"'
    );
  });

  it("honors setDefaultTimeout in actionability errors", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;
    page.setDefaultTimeout(1234);

    const err = await page
      .getByTestId("missing")
      .click()
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain("1234ms");
  });
});
