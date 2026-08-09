import { describe, expect, it } from "vitest";
import {
  LOCAL_FALLBACK_MODEL_REF,
  materializeModel,
  type LocalModelDescriptor,
} from "./model-spec.js";

describe("local model materialization", () => {
  it("uses the bundled model's real 32K window before catalog refresh", () => {
    expect(LOCAL_FALLBACK_MODEL_REF).toBe("local:lfm2.5-1.2b");
    expect(materializeModel("local", "lfm2.5-1.2b", null)?.spec).toMatchObject({
      contextWindow: 32_768,
      maxTokens: 32_768,
    });
  });

  it("uses imported model metadata without imposing a smaller default", () => {
    const entry: LocalModelDescriptor = {
      slug: "custom-model",
      displayName: "Custom model",
      baseUrl: "http://127.0.0.1:1234/v1",
      contextWindow: 131_072,
      maxTokens: 8192,
      toolsCapable: true,
    };

    expect(materializeModel("local", entry.slug, entry)?.spec).toMatchObject({
      contextWindow: 131_072,
      maxTokens: 8192,
    });
  });

  it("does not invent metadata for an unknown local model", () => {
    expect(materializeModel("local", "custom-model", null)).toBeNull();
  });
});
