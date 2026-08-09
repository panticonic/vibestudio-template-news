// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatLayout } from "./ChatLayout";

vi.mock("./ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./ChatConnectionErrorBanner", () => ({ ChatConnectionErrorBanner: () => null }));
vi.mock("./ChatDirtyRepoWarnings", () => ({ ChatDirtyRepoWarnings: () => null }));
vi.mock("./LazyChatActionBar", () => ({ LazyChatActionBar: () => null }));
vi.mock("./ChatMessageArea", () => ({ ChatMessageArea: () => null }));
vi.mock("./LazyChatFeedbackArea", () => ({ LazyChatFeedbackArea: () => null }));
vi.mock("./Outbox", () => ({ Outbox: () => null }));
vi.mock("./PendingDeliveryQueue", () => ({ PendingDeliveryQueue: () => null }));
vi.mock("./ChatDebugConsole", () => ({ ChatDebugConsole: () => null }));
vi.mock("./ChatInput", () => ({ ChatInput: () => <div data-testid="composer" /> }));

describe("ChatLayout sizing", () => {
  it("fills its AgenticChat host so embedded composers remain visible", () => {
    const { container, getByTestId } = render(<ChatLayout />);
    const root = container.querySelector<HTMLElement>(".agentic-chat-root");
    expect(root?.style.height).toBe("100%");
    expect(getByTestId("composer")).toBeTruthy();
  });
});
