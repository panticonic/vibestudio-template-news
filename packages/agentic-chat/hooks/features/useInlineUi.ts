/**
 * useInlineUi — Inline UI component compilation + cleanup.
 *
 * Compiles inline UI messages (TSX components) and cleans up
 * compiled components when messages are trimmed.
 */

import { useState, useEffect, useRef } from "react";
import { CONTENT_TYPE_INLINE_UI } from "@workspace/pubsub";
import type { LoadSourceFile, SandboxOptions } from "@workspace/eval";
import { parseInlineUiData } from "../../components/InlineUiMessage";
import type { ChatMessage, InlineUiComponentEntry } from "../../types";

interface UseInlineUiOptions {
  messages: ChatMessage[];
  loadSourceFile?: LoadSourceFile;
  loadImport?: SandboxOptions["loadImport"];
}

export interface InlineUiState {
  inlineUiComponents: Map<string, InlineUiComponentEntry>;
}

export function useInlineUi({
  messages,
  loadSourceFile,
  loadImport,
}: UseInlineUiOptions): InlineUiState {
  const [inlineUiComponents, setInlineUiComponents] = useState<Map<string, InlineUiComponentEntry>>(
    new Map()
  );

  // Compile inline UI messages
  useEffect(() => {
    const compileInlineUiMessages = async () => {
      for (const msg of messages) {
        if (msg.contentType !== CONTENT_TYPE_INLINE_UI) continue;
        const data = msg.inlineUi ?? parseInlineUiData(msg.content);
        if (!data) continue;
        if (inlineUiComponents.has(data.id)) continue;

        try {
          const sourceCode =
            data.source.type === "file"
              ? await loadSourceFile?.(data.source.path)
              : data.source.code;
          if (!sourceCode) throw new Error(`Unable to load inline UI source for ${data.id}`);
          const sourcePath = data.source.type === "file" ? data.source.path : undefined;
          const { compileComponent } = await import("@workspace/eval/sandbox");
          const result = await compileComponent<NonNullable<InlineUiComponentEntry["Component"]>>(
            sourceCode,
            {
              sourcePath,
              loadSourceFile,
              loadImport,
            }
          );
          if (result.success) {
            setInlineUiComponents((prev) => {
              const updated = new Map(prev);
              updated.set(data.id, { Component: result.Component!, cacheKey: result.cacheKey! });
              return updated;
            });
          } else {
            console.error(
              `[InlineUiMessage] Component "${data.id}" compilation failed` +
                (data.source.type === "file" ? ` (${data.source.path})` : ""),
              result.errorStack ?? result.error
            );
            setInlineUiComponents((prev) => {
              const updated = new Map(prev);
              updated.set(data.id, { cacheKey: sourceCode, error: result.error });
              return updated;
            });
          }
        } catch (err) {
          console.error(
            `[InlineUiMessage] Component "${data.id}" source loading failed` +
              (data.source.type === "file" ? ` (${data.source.path})` : ""),
            err
          );
          setInlineUiComponents((prev) => {
            const updated = new Map(prev);
            updated.set(data.id, {
              cacheKey: data.id,
              error: err instanceof Error ? err.message : String(err),
            });
            return updated;
          });
        }
      }
    };
    void compileInlineUiMessages();
  }, [messages, inlineUiComponents, loadSourceFile, loadImport]);

  // Cleanup when messages shrink (e.g. after trim in reducer)
  const prevMsgCountRef = useRef(0);
  useEffect(() => {
    if (messages.length >= prevMsgCountRef.current) {
      prevMsgCountRef.current = messages.length;
      return;
    }
    prevMsgCountRef.current = messages.length;

    const referencedUiIds = new Set<string>();
    for (const msg of messages) {
      if (msg.contentType === CONTENT_TYPE_INLINE_UI) {
        const data = msg.inlineUi ?? parseInlineUiData(msg.content);
        if (data) referencedUiIds.add(data.id);
      }
    }
    setInlineUiComponents((prevComponents) => {
      const next = new Map(prevComponents);
      let removedCount = 0;
      for (const [id, component] of prevComponents) {
        if (!referencedUiIds.has(id)) {
          next.delete(id);
          removedCount++;
        }
      }
      return removedCount > 0 ? next : prevComponents;
    });
  }, [messages]);

  return { inlineUiComponents };
}
