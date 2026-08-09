/** Canonical runtime client for the deliberately small semantic VCS API. */

import {
  vcsMethods,
  vcsOperationRegistry,
  type VcsStatusInput,
  type VcsStatusResult,
} from "@vibestudio/service-schemas/vcs";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";

export type * from "@vibestudio/service-schemas/vcs";

/**
 * Runtime code uses the service contract directly. There are no alternate
 * merge verbs, selective-commit compilers, provenance facades, or routing
 * overlays to keep synchronized with it.
 */
type SchemaVcsClient = TypedServiceClient<typeof vcsMethods>;
type ContextBoundMethodName = {
  [Method in keyof typeof vcsMethods]: Extract<
    (typeof vcsMethods)[Method]["references"][number],
    { kind: "context"; path: readonly ["contextId"] }
  > extends never
    ? never
    : Method;
}[keyof typeof vcsMethods];
type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown
  ? Omit<Value, Key>
  : never;
type ContextOptionalMethod<Method> = Method extends (input: infer Input) => Promise<infer Result>
  ? (input: DistributiveOmit<Input, "contextId"> & { contextId?: string }) => Promise<Result>
  : Method;
type ContextBoundStatusInput = Omit<VcsStatusInput, "contextId"> & { contextId?: string };

type ContextBoundVcsClient = {
  [Method in keyof SchemaVcsClient]: Method extends ContextBoundMethodName
    ? ContextOptionalMethod<SchemaVcsClient[Method]>
    : SchemaVcsClient[Method];
};

export type VcsClient = Omit<ContextBoundVcsClient, "status"> & {
  status(input?: ContextBoundStatusInput): Promise<VcsStatusResult>;
};

export function createVcsClient(
  callMain: <T>(method: string, ...args: unknown[]) => Promise<T>,
  boundContextId: string
): VcsClient {
  const schemaClient = createTypedServiceClient("vcs", vcsMethods, (_service, method, args) =>
    callMain(`vcs.${method}`, ...args)
  );
  return Object.fromEntries(
    Object.entries(schemaClient).map(([method, invoke]) => [
      method,
      vcsOperationRegistry[method as keyof typeof vcsOperationRegistry].references.some(
        (reference) =>
          reference.kind === "context" &&
          reference.path.length === 1 &&
          reference.path[0] === "contextId"
      )
        ? (input?: unknown) => {
            const boundInput =
              input === undefined
                ? { contextId: boundContextId }
                : input !== null && typeof input === "object" && !Array.isArray(input)
                  ? { contextId: boundContextId, ...input }
                  : input;
            return (invoke as (value: unknown) => Promise<unknown>)(boundInput);
          }
        : invoke,
    ])
  ) as VcsClient;
}
