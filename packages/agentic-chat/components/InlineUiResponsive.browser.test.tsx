import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Grid, Theme } from "@radix-ui/themes";
import SetupHub from "../../../skills/onboarding/SetupHub";
import type { SetupCapabilitySnapshot } from "../../../skills/onboarding/snapshot";
import "@radix-ui/themes/styles.css";
import "../styles.css";

afterEach(cleanup);

const observedAt = new Date().toISOString();
const snapshots: SetupCapabilitySnapshot[] = [
  {
    id: "connection.google-workspace",
    state: "not-configured",
    summary: "Google OAuth needs setup before an account can connect.",
    scope: "user-workspace",
    tier: "direct",
    attention: "none",
    nextAction: "setup",
    observedAt,
  },
  {
    id: "connection.github",
    state: "not-configured",
    summary: "No GitHub account is connected.",
    scope: "user-workspace",
    tier: "direct",
    attention: "none",
    nextAction: "setup",
    observedAt,
  },
  {
    id: "connection.device",
    state: "connected",
    summary: "This device is paired.",
    scope: "device",
    tier: "host-topology",
    attention: "none",
    nextAction: "change",
    observedAt,
  },
];

function NarrowInlineUi({ children }: { children: React.ReactNode }) {
  return (
    <Theme>
      <div className="agentic-chat-root" style={{ width: 320 }}>
        <div className="message-row message-row-agent message-row-inline-ui">
          <div className="inline-ui-frame">
            <div className="inline-ui-content" data-testid="inline-ui-content">
              {children}
            </div>
          </div>
        </div>
      </div>
    </Theme>
  );
}

describe("inline UI container responsiveness", () => {
  it("collapses viewport-responsive Radix grids to the panel width", () => {
    render(
      <NarrowInlineUi>
        <Grid columns={{ initial: "1", sm: "2" }} gap="2" data-testid="responsive-grid">
          <Button>First choice with a long label</Button>
          <Button>Second choice with a long label</Button>
        </Grid>
      </NarrowInlineUi>
    );

    const content = screen.getByTestId("inline-ui-content");
    const grid = screen.getByTestId("responsive-grid");
    const [first, second] = Array.from(grid.children).map((child) => child.getBoundingClientRect());

    expect(second?.top).toBeGreaterThan(first?.top ?? 0);
    expect(second?.left).toBe(first?.left);
    expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth + 1);
  });

  it("keeps the onboarding overview inside a phone-width card", () => {
    render(
      <NarrowInlineUi>
        <SetupHub props={{ snapshot: snapshots }} chat={{ send: vi.fn() }} />
      </NarrowInlineUi>
    );

    const content = screen.getByTestId("inline-ui-content");
    const bounds = content.getBoundingClientRect();
    const overflowers = [content, ...content.querySelectorAll<HTMLElement>("*")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => ({
        className: element.className,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));

    expect(overflowers).toEqual([]);
    for (const button of content.querySelectorAll("button")) {
      const buttonBounds = button.getBoundingClientRect();
      expect(buttonBounds.left).toBeGreaterThanOrEqual(bounds.left - 1);
      expect(buttonBounds.right).toBeLessThanOrEqual(bounds.right + 1);
    }
  });
});
