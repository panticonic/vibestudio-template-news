/**
 * Blobstore client — the portable runtime binding for the per-workspace
 * content-addressable blob store, shared by panel · worker · eval.
 *
 * This is the curated client behind `services.blobstore` / `import { blobstore }
 * from "@workspace/runtime"`. Most methods are thin typed wrappers over the
 * `blobstore` RPC service (`@vibestudio/service-schemas/blobstore`). The
 * runtime adds byte conveniences (`putBytes`/`getBytes`) that losslessly bridge
 * the wire's base64 representation, and `materializeTree` composes read-only
 * CAS calls with the caller-scoped RuntimeFs. The raw host materializer remains
 * admin-only because it accepts an absolute host path; userland never receives
 * that authority.
 *
 * Read/write methods (`putText`/`putBase64`/`putBytes`/`getText`/`getRange`/`grep`/…) admit
 * `panel`/`worker`/`do` callers (BLOBSTORE_READ_POLICY), so persisting a
 * screenshot or large artifact from agent eval works. Admin methods
 * (`delete`/`list`) are shell/server-only and reject other caller kinds at the
 * service policy gate — same as any other namespaced service method.
 */

import { Buffer } from "buffer";
import type { RpcCaller } from "@vibestudio/rpc";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { blobstoreMethods } from "@vibestudio/service-schemas/blobstore";
export { BLOBSTORE_MEMBERS } from "@vibestudio/service-schemas/runtime/runtimeSurface.portable";
import type { RuntimeFs } from "../types.js";

type BlobstoreServiceClient = TypedServiceClient<typeof blobstoreMethods>;
type PutBlobResult = Awaited<ReturnType<BlobstoreServiceClient["putBase64"]>>;

export type BlobstoreBytes = Uint8Array | ArrayBuffer;

type ReadText = (digest: string) => Promise<string | null>;
type GetBytes = (digest: string) => Promise<Uint8Array | null>;

type MaterializeTree = (
  treeRef: string,
  outDir: string,
  opts?: { link?: boolean }
) => Promise<{ written: number; unchanged: number }>;

export type BlobstoreClient = Omit<BlobstoreServiceClient, "materializeTree"> & {
  /** Runtime-only byte convenience; the wire service remains base64-only. */
  putBytes(bytes: BlobstoreBytes): Promise<PutBlobResult>;
  /** Runtime-only byte convenience; decodes the wire service's base64 representation. */
  getBytes: GetBytes;
  /** Readable alias for `getText`, available uniformly in panel, worker, and eval. */
  readText: ReadText;
  /** Copy a CAS tree into this runtime's context-scoped filesystem. */
  materializeTree: MaterializeTree;
};

export function createBlobstoreClient(rpc: RpcCaller, fs?: RuntimeFs): BlobstoreClient {
  const serviceClient = createTypedServiceClient(
    "blobstore",
    blobstoreMethods,
    (svc, method, args) => rpc.call("main", `${svc}.${method}`, args)
  );

  const putBytes = async (...args: unknown[]): Promise<PutBlobResult> => {
    if (args.length !== 1) {
      throw new TypeError(
        `blobstore.putBytes accepts exactly one Uint8Array or ArrayBuffer argument; ` +
          `MIME metadata is not stored, so return it alongside the digest instead (received ${args.length} arguments).`
      );
    }

    const input = args[0];
    if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)) {
      throw new TypeError("blobstore.putBytes expects a Uint8Array or ArrayBuffer argument.");
    }

    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    return serviceClient.putBase64(Buffer.from(bytes).toString("base64"));
  };

  const readText: ReadText = (digest) => serviceClient.getText(digest);
  const getBytes: GetBytes = async (digest) => {
    const base64 = await serviceClient.getBase64(digest);
    return base64 === null ? null : new Uint8Array(Buffer.from(base64, "base64"));
  };

  const materializeTree: MaterializeTree = async (treeRef, outDir, opts) => {
    if (!fs) {
      throw new Error(
        "blobstore.materializeTree requires a hosted runtime filesystem; use getTree/listTree from a transport-only client."
      );
    }
    if (!outDir || outDir.includes("\0")) {
      throw new TypeError("blobstore.materializeTree requires a non-empty output directory.");
    }
    if (opts?.link) {
      throw new Error(
        "blobstore.materializeTree link mode is not supported by the context-scoped runtime filesystem; omit link to copy the tree safely."
      );
    }

    const cleanRoot = outDir.replace(/\/+$/u, "") || "/";
    await fs.mkdir(cleanRoot, { recursive: true });
    let written = 0;
    let unchanged = 0;

    let cursor: string | undefined;
    let expectedBasis:
      | { ref: string; rootTreeHash: string; prefix: string; order: string }
      | undefined;
    const seenCursors = new Set<string>();
    for (;;) {
      const page = await serviceClient.listTree(treeRef, {
        limit: 1_000,
        ...(cursor ? { cursor } : {}),
      });
      if (page === null) throw new Error(`Tree object missing: ${treeRef}`);
      if (!expectedBasis) {
        expectedBasis = page.basis;
        if (page.basis.ref !== treeRef || page.basis.prefix !== "") {
          throw new Error("blobstore.listTree returned a basis different from materializeTree's request");
        }
      } else if (
        page.basis.ref !== expectedBasis.ref ||
        page.basis.rootTreeHash !== expectedBasis.rootTreeHash ||
        page.basis.prefix !== expectedBasis.prefix ||
        page.basis.order !== expectedBasis.order
      ) {
        throw new Error("blobstore.listTree changed basis while materializing a tree");
      }

      for (const entry of page.entries) {
        const path = safeMaterializedPath(cleanRoot, entry.path);
        if (entry.kind === "dir") {
          await fs.mkdir(path, { recursive: true });
          continue;
        }

        const bytesBase64 = await serviceClient.getBase64(entry.contentHash);
        if (bytesBase64 === null) {
          throw new Error(`Tree blob missing: ${entry.contentHash} (${entry.path})`);
        }
        const bytes = Buffer.from(bytesBase64, "base64");
        await fs.mkdir(parentPath(path), { recursive: true });

        if (await fs.exists(path)) {
          const current = await fs.readFile(path);
          if (Buffer.from(current as Uint8Array).equals(bytes)) {
            // Content equality does not imply metadata equality. Re-apply the
            // tree's Git mode so repeated materialization repairs executable bits.
            await fs.chmod(path, entry.mode);
            unchanged += 1;
            continue;
          }
        }

        await fs.writeFile(path, bytes);
        await fs.chmod(path, entry.mode);
        written += 1;
      }

      if (page.completeness === "complete") break;
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("blobstore.listTree repeated a continuation cursor");
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    return { written, unchanged };
  };

  return Object.assign(serviceClient, {
    putBytes,
    getBytes,
    readText,
    materializeTree,
  }) as BlobstoreClient;
}

function safeMaterializedPath(root: string, relativePath: string): string {
  const segments = relativePath.split("/");
  if (
    relativePath.startsWith("/") ||
    relativePath.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe tree path: ${JSON.stringify(relativePath)}`);
  }
  return root === "/" ? `/${relativePath}` : `${root}/${relativePath}`;
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return ".";
  return slash === 0 ? "/" : path.slice(0, slash);
}
