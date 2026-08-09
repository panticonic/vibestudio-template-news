/**
 * Unified async tracking API for both panels and workers.
 *
 * If a runtime provides __vibestudioAsyncTracking__, this module uses it.
 * Otherwise it provides a no-op implementation that preserves the same API
 * shape. The no-op implementation cannot discover unawaited promises; callers
 * should await the work they start.
 */

/**
 * Async tracking context returned by start().
 */
export interface TrackingContext {
  id: number;
  promises: Set<Promise<unknown>>;
  pauseCount: number;
}

/**
 * The async tracking API interface.
 * This is accessed via globalThis.__vibestudioAsyncTracking__ when a runtime
 * provides one.
 */
export interface AsyncTrackingAPI {
  /** Create a new tracking context and set it as current */
  start: () => TrackingContext;
  /** Enter an existing tracking context (set as current) */
  enter: (ctx: TrackingContext) => void;
  /** Exit the current tracking context */
  exit: () => void;
  /** Stop and destroy a context, cleaning up all references */
  stop: (ctx?: TrackingContext) => void;
  /** Pause tracking in a context (nested pause supported) */
  pause: (ctx?: TrackingContext) => void;
  /** Resume tracking in a context */
  resume: (ctx?: TrackingContext) => void;
  /** Mark a promise as ignored (never tracked in any context) */
  ignore: <T>(promise: T) => T;
  /** Wait for all promises in a context to settle */
  waitAll: (ctx?: TrackingContext) => Promise<void>;
  /** Get pending promise count for a context */
  pending: (ctx?: TrackingContext) => number;
  /** Get all active context IDs (for debugging) */
  activeContexts: () => number[];
}

/**
 * Get the async tracking API from the global scope.
 * Returns undefined if not available (not running in Vibestudio panel/worker).
 */
export function getAsyncTracking(): AsyncTrackingAPI | undefined {
  return (globalThis as Record<string, unknown>)["__vibestudioAsyncTracking__"] as
    | AsyncTrackingAPI
    | undefined;
}

/**
 * Check if async tracking is available in the current environment.
 */
export function hasAsyncTracking(): boolean {
  return getAsyncTracking() !== undefined;
}

// Fallback context ID counter for environments without native tracking
let fallbackContextId = 0;

/**
 * Create a fallback tracking context for environments without native async tracking.
 * This doesn't actually track promises but provides API compatibility.
 */
function createFallbackContext(): TrackingContext {
  return {
    id: ++fallbackContextId,
    promises: new Set(),
    pauseCount: 0,
  };
}

/**
 * Create a fallback async tracking API for testing or non-Vibestudio environments.
 * This implementation maintains the same API but doesn't actually track async operations.
 * Promises must be awaited manually.
 */
export function createFallbackAsyncTracking(): AsyncTrackingAPI {
  let currentContext: TrackingContext | null = null;

  return {
    start(): TrackingContext {
      currentContext = createFallbackContext();
      return currentContext;
    },
    enter(ctx: TrackingContext): void {
      currentContext = ctx;
    },
    exit(): void {
      currentContext = null;
    },
    stop(ctx?: TrackingContext): void {
      const target = ctx ?? currentContext;
      if (target) {
        target.promises.clear();
      }
      if (ctx === currentContext || (!ctx && currentContext)) {
        currentContext = null;
      }
    },
    pause(ctx?: TrackingContext): void {
      const target = ctx ?? currentContext;
      if (target) {
        target.pauseCount++;
      }
    },
    resume(ctx?: TrackingContext): void {
      const target = ctx ?? currentContext;
      if (target) {
        target.pauseCount = Math.max(0, target.pauseCount - 1);
      }
    },
    ignore<T>(promise: T): T {
      // No-op in fallback - just return the promise
      return promise;
    },
    waitAll(ctx?: TrackingContext): Promise<void> {
      const target = ctx ?? currentContext;
      if (!target || target.promises.size === 0) {
        return Promise.resolve();
      }
      // In fallback mode, we can't track promises automatically,
      // so we just resolve immediately
      return Promise.resolve();
    },
    pending(ctx?: TrackingContext): number {
      const target = ctx ?? currentContext;
      return target?.promises.size ?? 0;
    },
    activeContexts(): number[] {
      return currentContext ? [currentContext.id] : [];
    },
  };
}

/**
 * Get the async tracking API, using the runtime implementation if available,
 * otherwise falling back to a no-op implementation.
 *
 * This allows code to use async tracking unconditionally without checking
 * for availability, but the caller should be aware that in fallback mode
 * async operations won't actually be tracked.
 */
export function getAsyncTrackingOrFallback(): AsyncTrackingAPI {
  return getAsyncTracking() ?? createFallbackAsyncTracking();
}
