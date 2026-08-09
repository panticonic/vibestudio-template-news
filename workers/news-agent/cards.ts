import type { CardManager, CustomMessageHandle, MessageTypeSpec } from "@workspace/agentic-do";
import {
  NEWS_BRIEFING_STATE_SCHEMA,
  NEWS_SETUP_STATE_SCHEMA,
  type NewsBriefingCardState,
  type NewsSetupCardState,
} from "@workspace/feeds/card-types";

// Bump when NEWS_UI_IMPORTS or a renderer's import surface changes so channels
// re-register and rebuild their importmap (v2: react-markdown for the briefing).
export const NEWS_UI_INSTALL_VERSION = 2;

export const NEWS_UI_IMPORTS = {
  react: "latest",
  "react/jsx-runtime": "latest",
  "@radix-ui/themes": "npm:^3.2.1",
  "@radix-ui/react-icons": "npm:^1.3.2",
  // The briefing renderer renders its markdown TLDR with react-markdown; the
  // sandbox build service loads these on demand, same as @radix-ui above.
  "react-markdown": "npm:^9.0.1",
  "remark-gfm": "npm:^4.0.0",
} satisfies Record<string, string>;

export const NEWS_MESSAGE_TYPES: MessageTypeSpec[] = [
  {
    typeId: "news.setup",
    displayMode: "inline",
    path: "panels/news/renderers/news-setup.tsx",
    stateSchema: NEWS_SETUP_STATE_SCHEMA,
  },
  {
    typeId: "news.briefing",
    displayMode: "inline",
    path: "panels/news/renderers/news-briefing.tsx",
    stateSchema: NEWS_BRIEFING_STATE_SCHEMA,
  },
];

export const SETUP_CARD_KEY = "news:setup";
export const briefingCardKey = (briefingId: string): string => `news:briefing:${briefingId}`;

/**
 * News card publishing on the platform CardManager. The setup card is a
 * per-channel singleton (stable natural key); each briefing run mints its own
 * card so history scrolls with the conversation.
 */
export class NewsCards {
  constructor(private readonly cards: CardManager) {}

  async publishSetup(channelId: string, payload: NewsSetupCardState): Promise<void> {
    const existing = this.cards.find(channelId, SETUP_CARD_KEY);
    if (existing) {
      await existing.update(payload);
      return;
    }
    await this.cards.getOrCreate(channelId, "news.setup", SETUP_CARD_KEY, payload, {
      displayMode: "inline",
    });
  }

  async createBriefing(
    channelId: string,
    payload: NewsBriefingCardState
  ): Promise<CustomMessageHandle> {
    return this.cards.getOrCreate(
      channelId,
      "news.briefing",
      briefingCardKey(payload.briefingId),
      payload,
      { displayMode: "inline" }
    );
  }

  async updateBriefing(
    channelId: string,
    briefingId: string,
    payload: NewsBriefingCardState
  ): Promise<void> {
    const handle = this.cards.find(channelId, briefingCardKey(briefingId));
    if (handle) await handle.update(payload);
  }

  adoptRecoveredCard(channelId: string, key: string, typeId: string, messageId: string): void {
    this.cards.adoptRecovered(channelId, key, typeId, messageId);
  }
}
