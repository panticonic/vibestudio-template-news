import { describe, expect, it } from "vitest";

describe("@workspace/ui root import", () => {
  // The root import pulls in a large module graph (shiki and the diff kit),
  // which is slow to load under full-suite parallel load, so allow a generous
  // timeout well above the default 5000ms.
  it(
    "does not require panel runtime globals",
    async () => {
      await expect(import("@workspace/ui")).resolves.toBeDefined();
    },
    30000,
  );
});
