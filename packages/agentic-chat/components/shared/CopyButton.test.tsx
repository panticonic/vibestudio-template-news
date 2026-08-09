// @vitest-environment jsdom

import React from "react";
import { Theme } from "@radix-ui/themes";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyButton } from "./CopyButton";

afterEach(() => {
  vi.useRealTimers();
});

describe("CopyButton", () => {
  it("cancels its copied-state timer when it unmounts", async () => {
    vi.useFakeTimers();
    const { getByRole, unmount } = render(
      <Theme>
        <CopyButton value="details" label="Copy details" />
      </Theme>
    );

    fireEvent.click(getByRole("button", { name: "Copy details" }));
    await act(async () => Promise.resolve());
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
