import { describe, expect, it, vi } from "vitest";
import { createCdpAutomation } from "./cdpAutomation.js";

describe("createCdpAutomation screenshot", () => {
  it("treats the hosted module loader as authoritative without trying runtime fallbacks", async () => {
    const hostedFailure = new Error("cell execution session is no longer active");
    const loadModule = vi.fn(async () => {
      throw hostedFailure;
    });
    const fallback = vi.fn(() => ({ BrowserImpl: { connect: vi.fn() } }));
    (globalThis as Record<string, unknown>)["__vibestudioRequire__"] = fallback;
    const cdp = createCdpAutomation({ call: vi.fn() } as never, "panel:tree/retained", {
      loadModule,
    });

    try {
      await expect(cdp.page()).rejects.toMatchObject({
        message: expect.stringContaining("cell execution session is no longer active"),
        cause: hostedFailure,
      });
      expect(loadModule).toHaveBeenCalledWith("@workspace/cdp-client");
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as Record<string, unknown>)["__vibestudioRequire__"];
    }
  });

  it("uses the one-RPC host capture path and returns its typed metadata", async () => {
    const shot = {
      data: "iVBORw0KGgo=",
      mimeType: "image/png" as const,
      width: 1280,
      height: 720,
    };
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "panelCdp.screenshot") return shot;
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const cdp = createCdpAutomation({ call } as never, "panel:child");

    await expect(cdp.screenshot({ format: "png", quality: 90 })).resolves.toEqual(shot);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("main", "panelCdp.screenshot", [
      "panel:child",
      { format: "png", quality: 90 },
    ]);
    expect(call.mock.calls.some(([, method]) => method === "panelCdp.getCdpEndpoint")).toBe(false);
  });

  it("uses the composed panel runtime callbacks instead of host navigation methods", async () => {
    const call = vi.fn(async (_target: string, _method: string, _args: unknown[]) => undefined);
    const navigate = vi.fn(async () => undefined);
    const navigateHistory = vi.fn(async () => undefined);
    const reload = vi.fn(async () => undefined);
    const cdp = createCdpAutomation({ call } as never, "panel:child", {
      navigate,
      navigateHistory,
      reload,
    });

    await cdp.navigate("https://example.com");
    await cdp.goBack();
    await cdp.goForward();
    await cdp.reload();

    expect(navigate).toHaveBeenCalledWith("https://example.com");
    expect(navigateHistory.mock.calls).toEqual([[-1], [1]]);
    expect(reload).toHaveBeenCalledOnce();
    expect(call).not.toHaveBeenCalled();
  });
});
