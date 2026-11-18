import { fileURLToPath } from "node:url";
import { workspaceProgramFailures } from "@workspace/natlang/testing";
import { expect, it } from "vitest";

it("compiles News workflows and their caller-bound observations", async () => {
  const workspace = fileURLToPath(new URL("../..", import.meta.url));
  expect(await workspaceProgramFailures(workspace)).toEqual([]);
});
