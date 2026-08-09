/**
 * Model materialization (design docs/local-models-extension-design.md §6.2).
 *
 * The vessel — the impure edge — resolves an agent's "provider:modelId" ref
 * into a journaled `AgentModelSpec` + auth mode here. pi-ai's generated
 * registry is ONE INPUT to materialization (cloud refs); the local-models
 * extension's entries are the other (local refs). The executor never touches
 * a registry: the journaled spec is the only resolution path.
 *
 * Specs are journaled and ride catalog snapshots — they MUST stay secret-free
 * (the loopback api-key is injected executor-side at call time, §6.3).
 */

import {
  getBuiltinModel as getModel,
  getBuiltinModels as getModels,
  getBuiltinProviders as getProviders,
} from "@earendil-works/pi-ai/providers/all";
import type { AgentModelSpec, ModelAuthMode } from "@workspace/agent-loop";

export const LOCAL_PROVIDER_ID = "local";
export const LOCAL_MODELS_EXTENSION_ID = "@workspace-extensions/local-models";
export const LOCAL_FALLBACK_MODEL_REF = "local:lfm2.5-1.2b";

/** llama-server quirks profile (design §6.4). Locked against the pinned
 *  build by the e2e tool-round-trip test; revisit on every pin bump. */
export const LLAMA_SERVER_COMPAT: Record<string, unknown> = {
  supportsReasoningEffort: false,
};

export interface MaterializedModel {
  spec: AgentModelSpec;
  auth: ModelAuthMode;
  /** Gates tool schemas at config time (design §6.4) — the vessel omits
   *  toolSchemasHash for tool-incapable models. */
  toolsCapable: boolean;
}

/** Shape of the local-models extension's listModels() entries that the
 *  vessel caches (a serializable subset of the extension's LocalModelEntry). */
export interface LocalModelDescriptor {
  slug: string;
  displayName: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  toolsCapable: boolean;
}

interface PiModelLike {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  streamIdleTimeoutMs?: number;
  thinkingLevelMap?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

/** Serialize a pi-ai registry Model into the journal-safe literal. */
export function piModelToSpec(model: PiModelLike): AgentModelSpec {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.streamIdleTimeoutMs !== undefined
      ? { streamIdleTimeoutMs: model.streamIdleTimeoutMs }
      : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat ? { compat: { ...model.compat } } : {}),
  };
}

export function localEntryToSpec(entry: LocalModelDescriptor): AgentModelSpec {
  return {
    id: entry.slug,
    name: entry.displayName,
    api: "openai-completions",
    provider: LOCAL_PROVIDER_ID,
    baseUrl: entry.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    compat: { ...LLAMA_SERVER_COMPAT },
  };
}

export function materializeLocalModel(entry: LocalModelDescriptor): MaterializedModel {
  return { spec: localEntryToSpec(entry), auth: "loopback", toolsCapable: entry.toolsCapable };
}

/**
 * Static descriptor for the one bundled model. This keeps its first call
 * bootable while the local-models extension downloads/starts it. Imported
 * local models must materialize from their own extension metadata.
 */
export function bundledLocalFallbackModel(): MaterializedModel {
  return materializeLocalModel({
    slug: "lfm2.5-1.2b",
    displayName: "LFM2.5 1.2B Instruct",
    baseUrl: "http://127.0.0.1:0/v1",
    contextWindow: 32_768,
    maxTokens: 32_768,
    toolsCapable: true,
  });
}

export function materializeCloudModel(
  providerId: string,
  modelId: string
): MaterializedModel | null {
  const model = getModel(providerId as never, modelId as never) as PiModelLike | undefined;
  if (!model) return null;
  return { spec: piModelToSpec(model), auth: "url-bound", toolsCapable: true };
}

export function materializeModel(
  providerId: string,
  modelId: string,
  localEntry: LocalModelDescriptor | null
): MaterializedModel | null {
  if (providerId === LOCAL_PROVIDER_ID) {
    if (localEntry) return materializeLocalModel(localEntry);
    return modelId === "lfm2.5-1.2b" ? bundledLocalFallbackModel() : null;
  }
  return materializeCloudModel(providerId, modelId);
}

/** Enumerate the pi-ai registry as materialization inputs (catalog build). */
export function allCloudModels(): Array<{ providerId: string; model: PiModelLike }> {
  const out: Array<{ providerId: string; model: PiModelLike }> = [];
  for (const providerId of getProviders()) {
    for (const model of getModels(providerId as never) as unknown as PiModelLike[]) {
      out.push({ providerId, model });
    }
  }
  return out;
}
