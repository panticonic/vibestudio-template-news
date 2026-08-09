import { scheduleBackgroundStages } from "./scheduleBackgroundWork";

async function preloadStage(label: string, imports: Array<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(imports);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    console.debug(`[AgenticChat] ${label} warmup left ${failures.length} capability chunk(s) cold`);
  }
}

function preloadInteractiveSurfaces(): Promise<void> {
  return preloadStage("interactive surfaces", [
    import("../components/RichMessageContent"),
    import("../components/AgentDialog"),
    import("../components/ChatActionBar"),
    import("../components/ChatFeedbackArea"),
    import("../components/AgentDebugConsole"),
  ]);
}

function preloadHeavyToolchains(): Promise<void> {
  return preloadStage("heavy toolchains", [
    import("@mdx-js/mdx"),
    import("rehype-highlight"),
    import("mermaid"),
    import("@workspace/eval/sandbox"),
    import("highlight.js/lib/core"),
    import("highlight.js/lib/languages/typescript"),
    import("highlight.js/lib/languages/javascript"),
    import("highlight.js/lib/languages/json"),
    import("highlight.js/lib/languages/bash"),
  ]);
}

/**
 * Begin fetching deferred chat capabilities after the basic chat surface has
 * painted. Imports remain split out of the startup bundle, but ordinary chat
 * use should find them in the module cache instead of paying a first-use
 * network and parse pause.
 */
export function scheduleChatCapabilityWarmup(): () => void {
  return scheduleBackgroundStages(
    [preloadInteractiveSurfaces, preloadHeavyToolchains],
    (error, stage) => {
      console.debug(`[AgenticChat] Background warmup stage ${stage + 1} failed`, error);
    }
  );
}
