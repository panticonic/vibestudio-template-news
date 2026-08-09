/**
 * Find tool — workerd-native rewrite of pi-coding-agent's
 * `dist/core/tools/find.js`.
 *
 * Upstream uses `fd` via `child_process.spawnSync`, plus the `glob` package
 * for nested .gitignore discovery. workerd has neither. Active agent runs use
 * the context-scoped host `fs.glob` service, which performs the traversal once
 * at the filesystem boundary. Embeddings without RPC retain a small in-memory
 * `RuntimeFs` walker.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { RpcCaller } from "@vibestudio/rpc";
import path from "node:path";
import type { RuntimeFs, Dirent } from "./runtime-fs.js";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, type TruncationResult } from "./truncate.js";
import { globToRegex } from "./grep.js";

const findSchema = Type.Object({
  pattern: Type.Optional(
    Type.String({
      description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    })
  ),
  path: Type.Optional(
    Type.String({ description: "Directory to search in (default: current directory)" })
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export type FindToolInput = Static<typeof findSchema>;

export interface FindToolDetails {
  type?: "console";
  content?: string;
  truncation?: TruncationResult;
  resultLimitReached?: number;
  engine?: "ripgrep" | "runtime-fs";
  missingSearchPath?: string;
  extensionFallback?: string;
}

export interface FindToolDeps {
  rpc?: RpcCaller;
}

const DEFAULT_LIMIT = 1000;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".svelte-kit",
  ".next",
  "dist",
  "build",
  ".cache",
  ".turbo",
]);

export function createFindTool(
  cwd: string,
  fs: RuntimeFs,
  deps?: FindToolDeps
): AgentTool<typeof findSchema, FindToolDetails | undefined> {
  return {
    name: "find",
    label: "find",
    executionMode: "parallel",
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: findSchema,
    execute: async (_toolCallId, input, signal, _onUpdate) => {
      const { pattern, path: searchDir, limit } = input;
      if (typeof pattern !== "string") {
        return {
          content: [
            {
              type: "text",
              text: "No find pattern supplied. Pass a glob such as `*`, `**/*.ts`, or `src/**`.",
            },
          ],
          details: undefined,
        };
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const searchPath = resolveToCwd(searchDir || ".", cwd);
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      if (deps?.rpc) {
        let found: string[];
        try {
          found = await deps.rpc.call<string[]>(
            "main",
            "fs.glob",
            [pattern, { path: searchPath }],
            signal ? { signal } : undefined
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT" && !/\bENOENT\b/u.test(message)) {
            throw error;
          }
          const displayPath = searchDir || ".";
          return {
            content: [
              {
                type: "text",
                text: `No files found matching pattern (search path does not exist: ${displayPath})`,
              },
            ],
            details: { engine: "runtime-fs", missingSearchPath: displayPath },
          };
        }
        const resultLimitReached = found.length > effectiveLimit;
        const matches = found
          .slice(0, effectiveLimit)
          .map((file) => path.relative(searchPath, file).replace(/\\/g, "/"));
        return renderMatches(matches, effectiveLimit, resultLimitReached);
      }

      // The in-memory fallback needs an explicit root probe; the host glob
      // service already combines this with its traversal in one RPC above.
      try {
        await fs.stat(searchPath);
      } catch {
        const displayPath = searchDir || ".";
        return {
          content: [
            {
              type: "text",
              text: `No files found matching pattern (search path does not exist: ${displayPath})`,
            },
          ],
          details: { engine: "runtime-fs", missingSearchPath: displayPath },
        };
      }

      const regex = globToRegex(pattern);
      // A slashless pattern matches by BASENAME anywhere in the tree (the
      // universal agent-glob convention — `system-testing*` should find
      // `skills/system-testing/`). Path-shaped patterns keep full-path
      // semantics.
      const basenameRegex = pattern.includes("/") ? null : regex;
      const matches: string[] = [];
      let resultLimitReached = false;

      const walk = async (dir: string): Promise<void> => {
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }
        if (resultLimitReached) return;
        let entries: Dirent[];
        try {
          entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[];
        } catch {
          return;
        }
        for (const entry of entries) {
          if (signal?.aborted) throw new Error("Operation aborted");
          if (resultLimitReached) return;
          const full = path.join(dir, entry.name);
          const rel = path.relative(searchPath, full).replace(/\\/g, "/");
          if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            // Test the directory itself against the glob too — it lets users find
            // directories like `**/__tests__`.
            if (
              regex.test(rel + "/") ||
              basenameRegex?.test(entry.name) ||
              basenameRegex?.test(entry.name + "/")
            ) {
              matches.push(rel + "/");
              if (matches.length >= effectiveLimit) {
                resultLimitReached = true;
                return;
              }
            }
            await walk(full);
          } else if (entry.isFile()) {
            if (regex.test(rel) || basenameRegex?.test(entry.name)) {
              matches.push(rel);
              if (matches.length >= effectiveLimit) {
                resultLimitReached = true;
                return;
              }
            }
          }
        }
      };

      await walk(searchPath);

      return renderMatches(matches, effectiveLimit, resultLimitReached);
    },
  };
}

function renderMatches(
  matches: string[],
  effectiveLimit: number,
  resultLimitReached: boolean
): {
  content: (TextContent | ImageContent)[];
  details: FindToolDetails | undefined;
} {
  if (matches.length === 0) {
    return {
      content: [{ type: "text", text: "No files found matching pattern" }],
      details: undefined,
    };
  }

  const rawOutput = matches.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  let resultOutput = truncation.content;
  const details: FindToolDetails = { engine: "runtime-fs" };
  const notices: string[] = [];

  if (resultLimitReached) {
    notices.push(
      `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`
    );
    details.resultLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (notices.length > 0) {
    resultOutput += `\n\n[${notices.join(". ")}]`;
  }

  return {
    content: [{ type: "text", text: resultOutput }],
    details,
  };
}
