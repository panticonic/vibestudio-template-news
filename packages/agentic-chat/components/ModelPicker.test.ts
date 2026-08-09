import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "@workspace/agentic-core";
import { partitionModelPickerModels } from "./ModelPicker";

function model(ref: string, provider: string, name: string): ModelCatalogEntry {
  return {
    ref,
    provider,
    name,
    availability: { state: "ready", detail: "running" },
  } as ModelCatalogEntry;
}

describe("partitionModelPickerModels", () => {
  const cloud = model("openai-codex:gpt-5.6-sol", "openai-codex", "GPT-5.6 Sol");
  const local = model("local:bonsai-8b", "local", "Bonsai 8B");

  it("keeps a ready local model out of the standard availability groups", () => {
    expect(partitionModelPickerModels([local, cloud], "")).toEqual({
      standard: [cloud],
      experimentalLocal: [local],
    });
  });

  it("keeps matching local search results in the experimental tier", () => {
    expect(partitionModelPickerModels([cloud, local], "bonsai")).toEqual({
      standard: [],
      experimentalLocal: [local],
    });
  });
});
