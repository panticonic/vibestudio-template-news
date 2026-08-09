/**
 * Canonical external Git client for panel, worker, and eval runtimes.
 *
 * The public `git` namespace is the typed `gitInterop` service contract
 * without aliases, adapters, provider names, or target-specific behavior.
 * Provider selection comes from the workspace manifest and invocation goes
 * directly through the generic extension-provider transport. Git policy and
 * configuration preparation live in the selected userland bridge; the host
 * sees only its independently authorized primitive calls.
 */

import type { RpcCaller } from "@vibestudio/rpc";
import { gitInteropMethods, type GitInteropClient } from "@vibestudio/service-schemas/gitInterop";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";

export type GitClient = GitInteropClient;
export type {
  GitImportedWorkspaceRepo,
  GitImportResult,
  GitImportProjectRequest,
  GitOverwritePreview,
  GitPublishRepoInput,
  GitPublishRepoResult,
  GitPullUpstreamOptions,
  GitPullUpstreamResult,
  GitPushUpstreamOptions,
  GitPushUpstreamResult,
  GitRemote,
  GitSharedRemotes,
  GitSemanticCandidate,
  GitUpstreamConfig,
  GitUpstreams,
  GitUpstreamState,
  GitUpstreamStatusOptions,
  GitUpstreamStatusRow,
} from "@vibestudio/service-schemas/gitInterop";

export function createGitClient(rpc: RpcCaller): GitClient {
  return createTypedServiceClient("gitInterop", gitInteropMethods, (_service, method, args) =>
    rpc.call("main", "extensions.invokeProvider", ["gitInterop", method, args])
  );
}
