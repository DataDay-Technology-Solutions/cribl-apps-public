// src/lib/preload.ts — lazy views whose chunks can be fetched ahead of time (epic audit P1-A02).
//
// `React.lazy` suspends on a component's first render even when its module has already been fetched: its
// own payload is still unread, so a Suspense fallback flashes for a frame (a skeleton on P, Y or a tab
// click). `preloadable` renders the module directly once `preload()` has settled, and falls back to
// `React.lazy` only before that, so a preloaded view never suspends at all.

import { createElement, lazy, type ComponentType } from 'react';

export interface PreloadableView {
  /** Renders the view: straight from the module once it has loaded, through `React.lazy` before that. */
  Component: ComponentType;
  /** Fetches the view's chunk (once). Resolves when a render will no longer suspend; never rejects. */
  preload: () => Promise<void>;
  /** True once the module has loaded (a render is synchronous). */
  isLoaded: () => boolean;
}

/** How long a render waits before fetching a failed chunk again. */
const RENDER_RETRY_MS = 500;
/** Views whose render gave up on their chunk: each renews its lazy when the boundary tries again. */
const FAILED = new Set<() => void>();

/** For an error boundary's Try again: every view that failed to load fetches its chunk anew on its next render. */
export function retryFailedViews(): void {
  for (const renew of [...FAILED]) renew();
  FAILED.clear();
}

/** A lazy view (a module whose default export takes no props) that can be fetched before it is shown. */
export function preloadable(factory: () => Promise<{ default: ComponentType }>): PreloadableView {
  let loaded: ComponentType | undefined;
  let pending: Promise<{ default: ComponentType }> | undefined;
  const load = (): Promise<{ default: ComponentType }> =>
    (pending ??= factory().then(
      (module) => {
        loaded = module.default;
        return module;
      },
      (error: unknown) => {
        pending = undefined; // a failed fetch (say, a deploy swapped the chunks) is retried on the next ask
        throw error;
      },
    ));
  // React.lazy keeps the first rejection for good, so a render after a failed fetch would fail again whatever the
  // network does next (OQ-12). The render's fetch retries once after a moment; if that fails too the error reaches
  // the view's boundary, and its Try again (retryFailedViews) swaps in a fresh lazy that fetches the chunk anew,
  // instead of a page reload (which ends a tour).
  const loadForRender = (): Promise<{ default: ComponentType }> =>
    load().catch(
      () =>
        new Promise<{ default: ComponentType }>((resolve, reject) => {
          window.setTimeout(() => {
            load().then(resolve, (error: unknown) => {
              FAILED.add(renew);
              reject(error instanceof Error ? error : new Error(String(error)));
            });
          }, RENDER_RETRY_MS);
        }),
    );
  let Lazy = lazy(loadForRender);
  const renew = (): void => {
    Lazy = lazy(loadForRender);
  };
  function Component() {
    return loaded ? createElement(loaded) : createElement(Lazy);
  }
  return {
    Component,
    // Best effort: a failed preload stays quiet; the render reports the real failure to its error boundary.
    preload: () =>
      load().then(
        () => undefined,
        () => undefined,
      ),
    isLoaded: () => loaded !== undefined,
  };
}

/** Runs `task` once the browser is idle (a short timeout where requestIdleCallback is missing: Safari). Returns a cancel. */
export function whenIdle(task: () => void, timeoutMs = 2_000): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(task, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(task, 200);
  return () => window.clearTimeout(id);
}
