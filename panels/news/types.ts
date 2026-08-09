export interface NewsStateArgs {
  /** Pubsub channel backing this panel; minted on first bootstrap. */
  channelName?: string;
  /** Stable DO key for the news agent so reloads reuse the same entity. */
  agentKey?: string;
  /** Extra subscription config layered onto the agent (model etc.). */
  agentConfig?: Record<string, unknown>;
  /** Epoch ms of the reader's last visit — drives the "new since last visit" marker. */
  lastVisitAt?: number;
}

export const NEWS_AGENT_SOURCE = "workers/news-agent";
export const NEWS_AGENT_CLASS = "NewsAgentWorker";
export const NEWS_AGENT_HANDLE = "news";
