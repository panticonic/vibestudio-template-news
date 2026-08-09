import { describe, expect, it } from "vitest";
import { isModelUsable, type ModelAvailability } from "./catalog";

describe("isModelUsable", () => {
  it.each<ModelAvailability>([
    { state: "ready" },
    { state: "startable", detail: "will-load-on-use" },
  ])("allows $state models to start an agent", (availability) => {
    expect(isModelUsable({ availability })).toBe(true);
  });

  it.each<ModelAvailability>([
    { state: "needs-setup", detail: "not-installed" },
    {
      state: "downloading",
      progress: 0.5,
      phase: "active",
      receivedBytes: 350_000_000,
      totalBytes: 700_000_000,
    },
    { state: "starting" },
    { state: "error", message: "installation failed" },
  ])("blocks $state models from starting an agent", (availability) => {
    expect(isModelUsable({ availability })).toBe(false);
  });

  it("treats a missing catalog entry as unavailable", () => {
    expect(isModelUsable(null)).toBe(false);
  });
});
