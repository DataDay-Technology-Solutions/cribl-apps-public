// tests/e2e/helpers/console.ts — what a console message said, and the one lazy-import failure a spec may ignore.
//
// Pure (no Playwright runtime import), so tests/unit/wave3-harness-console.test.ts runs it under vitest.
//
// Firefox prints a console.error's non-string arguments as handles: `console.error('[meter-reader] view crashed',
// error, stack)` reads "[meter-reader] view crashed JSHandle@object …" in `msg.text()`, where Chromium and WebKit
// print the error's message. `resolveConsoleText` asks the page for each argument's own text instead, so the same
// filters (and the failure report) read the same words in every engine.

/** The part of a Playwright JSHandle this module needs (a stand-in in the unit test). */
export interface ArgHandle {
  evaluate<R>(fn: (value: unknown) => R): Promise<R>;
}

/** Firefox's placeholder for an argument it did not print ("JSHandle@object", "JSHandle@error", …). */
export const HANDLE_PLACEHOLDER = /\bJSHandle@\w+/;

/**
 * The message's text with every argument resolved in the page (see the header). Text without a handle
 * placeholder is returned as it is, with no round trip. When the page has gone (a navigation disposed the
 * handles), the original text is kept: an unresolved message is still reported, never dropped.
 */
export async function resolveConsoleText(text: string, args: () => readonly ArgHandle[]): Promise<string> {
  if (!HANDLE_PLACEHOLDER.test(text)) return text;
  try {
    // The page evaluates the function, so it must be self-contained (no closures over this module).
    const parts = await Promise.all(
      args().map((arg) =>
        arg.evaluate((value) => {
          if (typeof value === 'string') return value;
          if (value instanceof Error) return `${value.name}: ${value.message}`;
          try {
            const json = JSON.stringify(value);
            return json === undefined ? String(value) : json;
          } catch {
            return String(value);
          }
        }),
      ),
    );
    return parts.length ? parts.join(' ') : text;
  } catch {
    return text;
  }
}

/**
 * A lazy view's module failing to load, in each engine's words (Chromium, Firefox, WebKit). On the Vite dev
 * server this happens when the spec's own navigation cancels the chunk's load, or when the dev server
 * re-optimizes its dependencies and answers the old URL "504 Outdated Optimize Dep" before reloading the page
 * (D40). It is only ever ignored in those two situations (`isAbandonedLazyImport`); anywhere else it is a crash.
 */
export const LAZY_IMPORT_FAILED = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/;

/** Where the page stood when a message arrived. */
export interface PageMoment {
  /** The spec (or the dev server's reload) had started a main-frame navigation that had not committed yet. */
  leaving: boolean;
  /** This document had been answered "504 Outdated Optimize Dep" for one of the dev server's pre-bundled deps. */
  reoptimized: boolean;
}

/** D40: a lazy-import failure from a page that was being left, or whose deps the dev server had just re-optimized. */
export const isAbandonedLazyImport = (text: string, at: PageMoment): boolean => (at.leaving || at.reoptimized) && LAZY_IMPORT_FAILED.test(text);

/** The dev server's answer for a pre-bundled dependency URL whose optimizer hash is stale. */
export const isOutdatedOptimizeDep = (url: string, status: number): boolean => status === 504 && /\/node_modules\/\.vite\/deps\//.test(url);
