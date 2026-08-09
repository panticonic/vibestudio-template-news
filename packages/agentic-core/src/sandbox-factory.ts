/**
 * SandboxConfig factory for panel contexts.
 *
 * Worker and Node.js factories live in @workspace/agentic-session.
 */
import {
  createBuildServiceClient,
  createEvalImportLoader,
} from "@vibestudio/service-schemas/clients/evalImportLoader";
import type { SandboxConfig } from "./types.js";
interface RpcLike {
  call(target: string, method: string, args: unknown[]): Promise<unknown>;
}
/**
 * Create a SandboxConfig for panel contexts.
 *
 * Extracts the inline wiring that was previously in chat/index.tsx:248-263
 * into a reusable function. Both workspace and npm imports go through RPC
 * to the build service on the main process.
 */
export function createPanelSandboxConfig(rpc: RpcLike): SandboxConfig {
  const build = createBuildServiceClient((svc, method, args) =>
    rpc.call("main", `${svc}.${method}`, args)
  );
  return {
    rpc: { call: (t: string, m: string, args: unknown[]) => rpc.call(t, m, args) },
    loadImport: createEvalImportLoader(build, "panel"),
  };
}
