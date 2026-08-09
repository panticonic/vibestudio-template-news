import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getAsyncTracking,
  hasAsyncTracking,
  getAsyncTrackingOrFallback,
  createFallbackAsyncTracking,
  type AsyncTrackingAPI,
} from "./asyncTracking";

describe("getAsyncTracking", () => {
  const originalTracking = (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];

  afterEach(() => {
    // Restore original state
    if (originalTracking !== undefined) {
      (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"] = originalTracking;
    } else {
      delete (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];
    }
  });

  it("returns undefined when __vibestudioAsyncTracking__ is not set", () => {
    delete (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];
    expect(getAsyncTracking()).toBeUndefined();
  });

  it("returns the tracking API when set", () => {
    const mockAPI = { start: () => ({ id: 1, promises: new Set(), pauseCount: 0 }) };
    (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"] = mockAPI;
    expect(getAsyncTracking()).toBe(mockAPI);
  });
});

describe("hasAsyncTracking", () => {
  const originalTracking = (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];

  afterEach(() => {
    if (originalTracking !== undefined) {
      (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"] = originalTracking;
    } else {
      delete (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];
    }
  });

  it("returns false when not available", () => {
    delete (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];
    expect(hasAsyncTracking()).toBe(false);
  });

  it("returns true when available", () => {
    (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"] = {};
    expect(hasAsyncTracking()).toBe(true);
  });
});

describe("createFallbackAsyncTracking", () => {
  let tracking: AsyncTrackingAPI;

  beforeEach(() => {
    tracking = createFallbackAsyncTracking();
  });

  describe("start", () => {
    it("creates a new context with unique ID", () => {
      const ctx1 = tracking.start();
      const ctx2 = tracking.start();

      expect(ctx1.id).toBeDefined();
      expect(ctx2.id).toBeDefined();
      expect(ctx1.id).not.toBe(ctx2.id);
    });

    it("creates context with empty promises set", () => {
      const ctx = tracking.start();
      expect(ctx.promises).toBeInstanceOf(Set);
      expect(ctx.promises.size).toBe(0);
    });

    it("creates context with pauseCount of 0", () => {
      const ctx = tracking.start();
      expect(ctx.pauseCount).toBe(0);
    });
  });

  describe("enter/exit", () => {
    it("enter sets the context as current", () => {
      const ctx = tracking.start();
      tracking.exit();
      tracking.enter(ctx);
      // Can't directly test current context, but pending should work
      expect(tracking.pending()).toBe(0);
    });

    it("exit clears the current context", () => {
      tracking.start();
      tracking.exit();
      expect(tracking.pending()).toBe(0);
    });
  });

  describe("pause/resume", () => {
    it("pause increments pauseCount", () => {
      const ctx = tracking.start();
      expect(ctx.pauseCount).toBe(0);
      tracking.pause();
      expect(ctx.pauseCount).toBe(1);
      tracking.pause();
      expect(ctx.pauseCount).toBe(2);
    });

    it("resume decrements pauseCount", () => {
      const ctx = tracking.start();
      tracking.pause();
      tracking.pause();
      expect(ctx.pauseCount).toBe(2);
      tracking.resume();
      expect(ctx.pauseCount).toBe(1);
      tracking.resume();
      expect(ctx.pauseCount).toBe(0);
    });

    it("resume does not go below 0", () => {
      const ctx = tracking.start();
      tracking.resume();
      tracking.resume();
      expect(ctx.pauseCount).toBe(0);
    });

    it("works with explicit context", () => {
      const ctx = tracking.start();
      tracking.exit();
      tracking.pause(ctx);
      expect(ctx.pauseCount).toBe(1);
      tracking.resume(ctx);
      expect(ctx.pauseCount).toBe(0);
    });
  });

  describe("stop", () => {
    it("clears promises in context", () => {
      const ctx = tracking.start();
      // In fallback, we can manually add to promises for testing
      ctx.promises.add(Promise.resolve());
      expect(ctx.promises.size).toBe(1);
      tracking.stop();
      expect(ctx.promises.size).toBe(0);
    });

    it("stops specific context when passed", () => {
      const ctx1 = tracking.start();
      const ctx2 = tracking.start();
      ctx1.promises.add(Promise.resolve());
      ctx2.promises.add(Promise.resolve());
      tracking.stop(ctx1);
      expect(ctx1.promises.size).toBe(0);
      expect(ctx2.promises.size).toBe(1);
    });
  });

  describe("ignore", () => {
    it("returns the same value passed to it", () => {
      const promise = Promise.resolve(42);
      expect(tracking.ignore(promise)).toBe(promise);
    });

    it("works with non-promise values", () => {
      const value = { foo: "bar" };
      expect(tracking.ignore(value)).toBe(value);
    });
  });

  describe("waitAll", () => {
    it("resolves immediately with no context", async () => {
      tracking.exit(); // Ensure no current context
      await expect(tracking.waitAll()).resolves.toBeUndefined();
    });

    it("resolves immediately in fallback mode (no actual tracking)", async () => {
      tracking.start();
      await expect(tracking.waitAll()).resolves.toBeUndefined();
    });
  });

  describe("pending", () => {
    it("returns 0 with no context", () => {
      expect(tracking.pending()).toBe(0);
    });

    it("returns promise count from context", () => {
      const ctx = tracking.start();
      expect(tracking.pending()).toBe(0);
      ctx.promises.add(Promise.resolve());
      expect(tracking.pending()).toBe(1);
      ctx.promises.add(Promise.resolve());
      expect(tracking.pending()).toBe(2);
    });
  });

  describe("activeContexts", () => {
    it("returns empty array with no context", () => {
      tracking.exit();
      expect(tracking.activeContexts()).toEqual([]);
    });

    it("returns current context ID", () => {
      const ctx = tracking.start();
      expect(tracking.activeContexts()).toContain(ctx.id);
    });
  });
});

describe("getAsyncTrackingOrFallback", () => {
  const originalTracking = (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];

  afterEach(() => {
    if (originalTracking !== undefined) {
      (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"] = originalTracking;
    } else {
      delete (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];
    }
  });

  it("returns native tracking when available", () => {
    const mockAPI = {
      start: () => ({ id: 999, promises: new Set(), pauseCount: 0 }),
      enter: () => {},
      exit: () => {},
      stop: () => {},
      pause: () => {},
      resume: () => {},
      ignore: <T>(p: T) => p,
      waitAll: () => Promise.resolve(),
      pending: () => 0,
      activeContexts: () => [],
    };
    (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"] = mockAPI;

    const tracking = getAsyncTrackingOrFallback();
    const ctx = tracking.start();
    expect(ctx.id).toBe(999); // Should use our mock
  });

  it("returns fallback when native not available", () => {
    delete (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];

    const tracking = getAsyncTrackingOrFallback();
    expect(tracking).toBeDefined();
    expect(typeof tracking.start).toBe("function");
    expect(typeof tracking.waitAll).toBe("function");
  });

  it("fallback provides complete API", () => {
    delete (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"];

    const tracking = getAsyncTrackingOrFallback();
    expect(typeof tracking.start).toBe("function");
    expect(typeof tracking.enter).toBe("function");
    expect(typeof tracking.exit).toBe("function");
    expect(typeof tracking.stop).toBe("function");
    expect(typeof tracking.pause).toBe("function");
    expect(typeof tracking.resume).toBe("function");
    expect(typeof tracking.ignore).toBe("function");
    expect(typeof tracking.waitAll).toBe("function");
    expect(typeof tracking.pending).toBe("function");
    expect(typeof tracking.activeContexts).toBe("function");
  });
});

describe("integration: using tracking API", () => {
  it("full workflow with fallback tracking", async () => {
    const tracking = createFallbackAsyncTracking();

    // Start tracking
    const ctx = tracking.start();
    expect(ctx.id).toBeGreaterThan(0);

    // Pause/resume around ignored operations
    tracking.pause();
    const ignoredPromise = tracking.ignore(Promise.resolve("ignored"));
    tracking.resume();

    // Should still be able to await ignored promise
    await expect(ignoredPromise).resolves.toBe("ignored");

    // Wait for tracked promises (instant in fallback)
    await tracking.waitAll();

    // Stop tracking
    tracking.stop();

    // After stop, context should be cleared
    expect(ctx.promises.size).toBe(0);
  });

  it("multiple contexts can be managed independently", () => {
    const tracking = createFallbackAsyncTracking();

    const ctx1 = tracking.start();
    tracking.pause(ctx1);
    tracking.exit();

    const ctx2 = tracking.start();
    tracking.pause(ctx2);

    // Both contexts should have pauseCount incremented
    expect(ctx1.pauseCount).toBe(1);
    expect(ctx2.pauseCount).toBe(1);

    // Resume only ctx1
    tracking.resume(ctx1);
    expect(ctx1.pauseCount).toBe(0);
    expect(ctx2.pauseCount).toBe(1);
  });
});
