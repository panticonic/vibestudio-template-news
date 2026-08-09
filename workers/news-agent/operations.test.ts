import { describe, expect, it } from "vitest";
import { NEWS_METHODS } from "@workspace/feeds";
import { advertisedMethods, NEWS_OPERATIONS } from "./operations.js";

describe("News method contract", () => {
  it("keeps operation names and advertisements sourced from one shared table", () => {
    const operationNames = NEWS_OPERATIONS.map((operation) => operation.name);
    expect(new Set(operationNames).size).toBe(operationNames.length);
    expect(operationNames).toEqual(Object.values(NEWS_METHODS));
    expect(advertisedMethods().map((method) => method.name)).toEqual(
      NEWS_OPERATIONS.filter((operation) => operation.exposure.includes("method")).map(
        (operation) => operation.name
      )
    );
  });
});
