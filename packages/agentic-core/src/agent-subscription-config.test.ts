/**
 * toSubscriptionConfig is the single sanctioned producer of a channel
 * subscription config: it strips the per-agent behavior settings while
 * preserving channel presentation + worker-specific extras. The matching
 * `ChannelSubscriptionConfig` type forbids settings at compile time.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_SETTING_KEYS,
  toSubscriptionConfig,
  type ChannelSubscriptionConfig,
} from "./agent-subscription-config.js";

describe("toSubscriptionConfig", () => {
  it("strips every behavior setting and keeps presentation + worker extras", () => {
    const out = toSubscriptionConfig({
      model: "openai:gpt-5.3",
      thinkingLevel: "high",
      approvalLevel: 2,
      respondPolicy: "all",
      respondFrom: ["@a"],
      // presentation + worker extras must survive:
      handle: "bot",
      name: "Bot",
      systemPrompt: "be terse",
      systemPromptMode: "append",
      deterministicResponse: true,
      code: "read('a')",
    });

    for (const key of AGENT_SETTING_KEYS) {
      expect(out).not.toHaveProperty(key);
    }
    expect(out).toEqual({
      handle: "bot",
      name: "Bot",
      systemPrompt: "be terse",
      systemPromptMode: "append",
      deterministicResponse: true,
      code: "read('a')",
    });
  });

  it("handles undefined / empty input", () => {
    expect(toSubscriptionConfig(undefined)).toEqual({});
    expect(toSubscriptionConfig({})).toEqual({});
  });

  it("the result type forbids assigning a behavior setting (compile-time guard)", () => {
    const out = toSubscriptionConfig({ handle: "bot" });
    // @ts-expect-error — `model` is a per-agent setting; the subscription type bans it.
    out.model = "openai:gpt-5.3";
    // presentation + extras remain assignable:
    out.systemPrompt = "ok";
    (out as ChannelSubscriptionConfig)["workerExtra"] = 1;
    expect(out.systemPrompt).toBe("ok");
  });
});
