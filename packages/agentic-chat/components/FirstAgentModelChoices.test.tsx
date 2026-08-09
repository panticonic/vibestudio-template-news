// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalog } from "@workspace/agentic-core";
import { FirstAgentModelChoices } from "./FirstAgentModelChoices";

const catalog = {
  providers: [
    {
      id: "openai-codex",
      label: "GPT Codex",
      recommendedModelRef: "openai-codex:gpt-5.6-sol",
    },
    {
      id: "local",
      label: "Local inference (experimental)",
      recommendedModelRef: "local:bonsai-8b",
    },
  ],
  models: [
    {
      ref: "openai-codex:gpt-5.6-sol",
      provider: "openai-codex",
      name: "GPT-5.6 Sol",
      availability: { state: "needs-setup", detail: "no-credential" },
    },
    {
      ref: "local:bonsai-8b",
      provider: "local",
      name: "Bonsai 8B",
      availability: { state: "ready", detail: "running" },
    },
  ],
} as ModelCatalog;

describe("FirstAgentModelChoices", () => {
  it("keeps local inference out of the recommended first-run choice", () => {
    render(
      <Theme>
        <FirstAgentModelChoices
          catalog={catalog}
          value="openai-codex:gpt-5.6-sol"
          onChange={vi.fn()}
        />
      </Theme>
    );

    expect(screen.getByText("GPT Codex")).toBeTruthy();
    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(screen.queryByText("Bonsai 8B")).toBeNull();
    expect(screen.queryByText(/local inference/i)).toBeNull();
  });
});
