/**
 * Read tool — workerd port of pi-coding-agent's `dist/core/tools/read.js`.
 *
 * Differences from upstream:
 * - File I/O goes through `RuntimeFs` (no `fs/promises`).
 * - Image handling is delegated to the image service extension; detection
 *   uses magic-byte sniffing rather than the filename-extension table that
 *   pi-coding-agent ships.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { Buffer } from "node:buffer";
import type { RuntimeFs } from "./runtime-fs.js";
import type { RpcCaller } from "@vibestudio/rpc";
import { createExtensionProxy } from "@vibestudio/extension";
import { resolveToCwd } from "./path-utils.js";
import { sha256Hex } from "@vibestudio/content-addressing";
import { splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import type { VcsReadMemoryResult } from "@vibestudio/service-schemas/vcs";
import { toVcsPath, toolContextId, type ToolVcs, type ToolWorkspaceContext } from "./tool-vcs.js";
import { renderReadMemoryBlock } from "./read-memory.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./truncate.js";
const readLocationSchema = Type.Union([
  Type.Object({
    path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  }),
  Type.Object({
    target: Type.String({
      description:
        "File resource reference to read, normally a file:<path> value returned by another tool.",
    }),
    kind: Type.Optional(Type.Literal("file")),
  }),
]);

const readOptionsSchema = Type.Object({
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)" })
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});
const readSchema = Type.Intersect([readLocationSchema, readOptionsSchema]);
export type ReadToolInput = Static<typeof readSchema>;
export interface ReadToolDetails {
  truncation?: TruncationResult;
  path?: string;
  mimeType?: string;
  size?: number;
  originalSize?: number;
  originalDimensions?: {
    width: number;
    height: number;
  };
  dimensions?: {
    width: number;
    height: number;
  };
  wasResized?: boolean;
  engine?: "runtime-fs";
  directory?: boolean;
  extensionFallback?: string;
  missing?: boolean;
  suggestions?: string[];
  displayedRange?: {
    coordinateKind: "utf16";
    start: number;
    end: number;
    startLine: number;
    endLine: number;
  };
  provenance?:
    | VcsReadMemoryResult
    | {
        status: "unavailable";
        path: string;
        reason: string;
      };
}
interface ImageResizeResult {
  /** Base64 payload: extension RPC return values are JSON, never typed-array objects. */
  data: string;
  mimeType: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  wasResized: boolean;
  dimensionNote?: string;
}
interface ReadResult {
  content: (TextContent | ImageContent)[];
  details: ReadToolDetails;
}
interface ImageServiceApi {
  detectMimeType(bytes: Uint8Array): Promise<string | null>;
  resize(
    bytes: Uint8Array,
    mimeType: string,
    opts: { maxWidth: number; maxHeight: number }
  ): Promise<ImageResizeResult>;
}
const IMAGE_SERVICE_EXTENSION = "@workspace-extensions/image-service";

export interface ReadToolDeps {
  /** RPC caller — needed for image resize. */
  rpc?: RpcCaller;
  /** Canonical GAD/VCS read-memory projection for managed source reads. */
  provenance?: {
    vcs: Pick<ToolVcs, "readMemory">;
    context: ToolWorkspaceContext;
  };
}
export function createReadTool(
  cwd: string,
  fs: RuntimeFs,
  deps?: ReadToolDeps
): AgentTool<typeof readSchema, ReadToolDetails> {
  const runtimeRpc = deps?.rpc ?? null;
  const provenanceDeps = deps?.provenance ?? null;
  const imageService = deps?.rpc
    ? createExtensionProxy<ImageServiceApi>(deps.rpc, IMAGE_SERVICE_EXTENSION, () => false)
    : null;

  const resolveWorkspaceSkillAlias = async (requestedPath: string): Promise<ReadResult | null> => {
    if (!runtimeRpc) return null;
    const normalized = requestedPath.replace(/^\/+/, "");
    const match = /^(?:skills\/)?([^/]+)\/SKILL\.md$/iu.exec(normalized);
    if (!match?.[1]) return null;
    try {
      const entries = await runtimeRpc.call<
        Array<{ name: string; dirPath: string; skillPath: string }>
      >("main", "workspace.listSkills", []);
      const matches = entries.filter((entry) => entry.name === match[1]);
      if (matches.length !== 1) return null;
      const entry = matches[0]!;
      const content = await runtimeRpc.call<string>("main", "workspace.readSkill", [entry.dirPath]);
      return {
        content: [{ type: "text", text: content }],
        details: {
          path: entry.skillPath,
          engine: "runtime-fs",
          extensionFallback: `workspace-skill-alias:${requestedPath}`,
        },
      };
    } catch {
      return null;
    }
  };

  const missingResult = async (
    requestedPath: string,
    absolutePath: string
  ): Promise<ReadResult> => {
    const skillAlias = await resolveWorkspaceSkillAlias(requestedPath);
    if (skillAlias) return skillAlias;
    const slash = absolutePath.lastIndexOf("/");
    const parent = slash <= 0 ? "/" : absolutePath.slice(0, slash);
    const wanted = absolutePath.slice(slash + 1).toLowerCase();
    let suggestions: string[] = [];
    try {
      suggestions = (await fs.readdir(parent))
        .map(String)
        .sort((a, b) => {
          const aScore = similarityScore(a.toLowerCase(), wanted);
          const bScore = similarityScore(b.toLowerCase(), wanted);
          return bScore - aScore || a.localeCompare(b);
        })
        .slice(0, 12);
    } catch {
      // A missing parent has no useful siblings; the diagnostic still remains
      // a successful discovery result rather than poisoning the turn.
    }
    const hint =
      suggestions.length > 0
        ? ` Nearby entries: ${suggestions.join(", ")}.`
        : " The parent directory is also unavailable or empty.";
    return {
      content: [
        {
          type: "text",
          text: `File not found: ${requestedPath}.${hint} Use ls/find before choosing another path.`,
        },
      ],
      details: { path: requestedPath, missing: true, suggestions },
    };
  };

  const attachReadMemory = async (
    result: ReadResult,
    text: string,
    requestedPath: string,
    signal?: AbortSignal
  ): Promise<ReadResult> => {
    const displayed = result.details.displayedRange;
    if (!provenanceDeps || !displayed) return result;
    let workspacePath: string;
    try {
      workspacePath = toVcsPath(requestedPath, cwd);
    } catch {
      return result;
    }
    const split = splitRepoPath(workspacePath);
    if (!split?.repoRelPath || split.repoPath.split("/")[0] === "skills") return result;
    if (signal?.aborted) throw new Error("Operation aborted");
    try {
      const provenance = await provenanceDeps.vcs.readMemory({
        contextId: toolContextId(provenanceDeps.context),
        path: workspacePath,
        expectedContentHash: sha256Hex(new TextEncoder().encode(text)),
        range: { start: displayed.start, end: displayed.end },
        episodeLimit: 4,
        historyLimit: 3,
      });
      if (signal?.aborted) throw new Error("Operation aborted");
      if (provenance.status !== "attached") {
        return {
          ...result,
          details: { ...result.details, provenance },
        };
      }
      const block = renderReadMemoryBlock({
        label: workspacePath,
        content: text,
        readingContextId: toolContextId(provenanceDeps.context),
        startLine: displayed.startLine,
        endLine: displayed.endLine,
        result: provenance,
      });
      return {
        ...result,
        content: block
          ? [...result.content, { type: "text" as const, text: block }]
          : result.content,
        details: { ...result.details, provenance },
      };
    } catch (error) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ...result,
        details: {
          ...result.details,
          provenance: { status: "unavailable", path: workspacePath, reason },
        },
      };
    }
  };

  return {
    name: "read",
    label: "read",
    executionMode: "parallel",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: readSchema,
    execute: async (_toolCallId, input, signal, _onUpdate) => {
      const path = normalizeReadLocation(input);
      if (!path) {
        return {
          content: [
            {
              type: "text",
              text: "No file reference was supplied. Call read with path, or with a file:<path> target returned by a discovery tool.",
            },
          ],
          details: { missing: true, suggestions: [] },
        };
      }
      const { offset, limit } = input;
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      const absolutePath = resolveToCwd(path, cwd);
      // --- Image/text read ---------------------------------------------------------------
      // Text with a recognizable filename remains a single compact UTF-8 RPC
      // response. Runtime artifacts such as screenshots intentionally use
      // opaque extensionless temp paths, so those paths must be read as bytes
      // and magic-sniffed instead of being irreversibly decoded as UTF-8.
      const shouldSniffMedia = isLikelyImagePath(path) || hasNoFileExtension(path);
      let raw: string | Buffer;
      try {
        raw = await retryTransientRuntimeFs(
          () => fs.readFile(absolutePath, shouldSniffMedia ? undefined : "utf8"),
          signal
        );
      } catch (err) {
        // The common file path is intentionally one filesystem round trip.
        // If it is a directory, recover with one typed listing instead of a
        // stat + readdir + one stat per child sequence.
        try {
          const entries = await retryTransientRuntimeFs(
            () => fs.readdir(absolutePath, { withFileTypes: true }),
            signal
          );
          const shown = entries
            .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
            .sort()
            .slice(0, 200);
          const omitted = entries.length - shown.length;
          return {
            content: [
              {
                type: "text",
                text:
                  shown.join("\n") +
                  (omitted > 0 ? `\n... ${omitted} more entries omitted` : ""),
              },
            ],
            details: { path, engine: "runtime-fs", directory: true },
          };
        } catch {
          // Preserve the original file-read failure below. The directory
          // probe is only a successful alternate interpretation.
        }
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return missingResult(path, absolutePath);
        }
        throw err;
      }
      if (
        raw instanceof Uint8Array &&
        imageService &&
        (isLikelyImagePath(path) || hasSupportedImageMagic(raw))
      ) {
        const mimeType = await imageService.detectMimeType(raw);
        if (mimeType?.startsWith("image/")) {
          const resized = await imageService.resize(raw, mimeType, {
            maxWidth: 2000,
            maxHeight: 2000,
          });
          const content: (TextContent | ImageContent)[] = [
            { type: "image", mimeType: resized.mimeType, data: resized.data },
          ];
          if (resized.dimensionNote) {
            content.unshift({ type: "text", text: resized.dimensionNote });
          }
          return {
            content,
            details: {
              path: absolutePath,
              mimeType: resized.mimeType,
              size: Buffer.byteLength(resized.data, "base64"),
              originalSize: raw.byteLength,
              originalDimensions: { width: resized.originalWidth, height: resized.originalHeight },
              dimensions: { width: resized.width, height: resized.height },
              wasResized: resized.wasResized,
            },
          };
        }
      }
      // --- Text branch -------------------------------------------------------------------
      const textContent = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
      return attachReadMemory(
        formatTextResult(textContent, path, offset, limit),
        textContent,
        path,
        signal
      );
    },
  };
}

function normalizeReadLocation(input: { path?: unknown; target?: unknown }): string | null {
  const raw = typeof input.path === "string" ? input.path : input.target;
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Discovery and provenance tools return stable `file:<path>` references.
  // Accept them directly so the agent does not have to manually translate a
  // resource descriptor back into the read tool's path spelling.
  return raw.replace(/^file:(?:\/\/)?/iu, "");
}

function similarityScore(candidate: string, wanted: string): number {
  if (candidate === wanted) return 100;
  let score = 0;
  if (candidate.split(".").pop() === wanted.split(".").pop()) score += 10;
  const max = Math.min(candidate.length, wanted.length);
  for (let i = 0; i < max && candidate[i] === wanted[i]; i += 1) score += 2;
  for (const token of wanted.split(/[^a-z0-9]+/u)) {
    if (token && candidate.includes(token)) score += token.length;
  }
  return score;
}

function isLikelyImagePath(filePath: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)$/iu.test(filePath);
}

function hasNoFileExtension(filePath: string): boolean {
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
  return !basename.includes(".");
}

function hasSupportedImageMagic(bytes: Uint8Array): boolean {
  const png =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const gif =
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61;
  const webp =
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;
  return png || jpeg || gif || webp;
}
function formatTextResult(
  textContent: string,
  displayPath: string,
  offset: number | undefined,
  limit: number | undefined,
  extensionFallback?: string
): {
  content: (TextContent | ImageContent)[];
  details: ReadToolDetails;
} {
  const allLines = textContent.split("\n");
  const totalFileLines = allLines.length;
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;
  if (startLine >= allLines.length) {
    return {
      content: [
        {
          type: "text",
          text:
            `[Offset ${offset} is beyond end of file (${allLines.length} lines total). ` +
            `The last valid offset is ${allLines.length}.]`,
        },
      ],
      details: { path: displayPath, engine: "runtime-fs", extensionFallback },
    };
  }
  let selectedContent: string;
  let userLimitedLines: number | undefined;
  if (limit !== undefined) {
    const endLine = Math.min(startLine + limit, allLines.length);
    selectedContent = allLines.slice(startLine, endLine).join("\n");
    userLimitedLines = endLine - startLine;
  } else {
    selectedContent = allLines.slice(startLine).join("\n");
  }
  const truncation = truncateHead(selectedContent);
  const displayedStart = allLines
    .slice(0, startLine)
    .reduce((total, line) => total + line.length + 1, 0);
  const displayedEnd = displayedStart + truncation.content.length;
  const displayedEndLine = startLineDisplay + Math.max(0, truncation.outputLines - 1);
  let outputText: string;
  let details: ReadToolDetails = {};
  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"));
    outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use offset=${startLineDisplay + 1} to skip past it.]`;
    details = { truncation };
  } else if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    outputText = truncation.content;
    if (truncation.truncatedBy === "lines") {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
    } else {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    }
    details = { truncation };
  } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    outputText = truncation.content;
    outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  } else {
    outputText = truncation.content;
  }
  return {
    content: [{ type: "text", text: outputText }],
    details: {
      ...details,
      path: displayPath,
      engine: "runtime-fs",
      extensionFallback,
      ...(!truncation.firstLineExceedsLimit
        ? {
            displayedRange: {
              coordinateKind: "utf16" as const,
              start: displayedStart,
              end: displayedEnd,
              startLine: startLineDisplay,
              endLine: displayedEndLine,
            },
          }
        : {}),
    },
  };
}
const TRANSIENT_RUNTIME_FS_FAILURE =
  /(?:DO dispatch fetch|fetch failed|other side closed|socket hang up|UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|ETIMEDOUT|\btransport\b)/iu;
const TRANSIENT_RUNTIME_FS_ATTEMPTS = 4;

async function retryTransientRuntimeFs<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_RUNTIME_FS_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error("Operation aborted");
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt === TRANSIENT_RUNTIME_FS_ATTEMPTS ||
        !TRANSIENT_RUNTIME_FS_FAILURE.test(message)
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
  throw lastError;
}
