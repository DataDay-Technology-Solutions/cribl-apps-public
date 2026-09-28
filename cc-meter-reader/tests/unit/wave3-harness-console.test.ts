// tests/unit/wave3-harness-console.test.ts — the E2E console filter reads Firefox's object-logged errors in their own
// words, and ignores D40's lazy-import failure only from a page being left or re-optimized (W3-HARNESS-1).

import { describe, expect, it } from 'vitest';
import {
  HANDLE_PLACEHOLDER,
  LAZY_IMPORT_FAILED,
  isAbandonedLazyImport,
  isOutdatedOptimizeDep,
  resolveConsoleText,
  type ArgHandle,
} from '../e2e/helpers/console.ts';

/** A handle whose `evaluate` runs the page function on a value, as Playwright does in the page. */
const handle = (value: unknown): ArgHandle => ({ evaluate: async (fn) => fn(value) });
/** A handle whose page has gone (a navigation disposed it). */
const gone: ArgHandle = {
  evaluate: () => Promise.reject(new Error('Target page, context or browser has been closed')),
};

const FIREFOX_VIEW_CRASH = '[meter-reader] view crashed JSHandle@object \nLazy@unknown:0:0\nComponent@unknown:0:0';
const FIREFOX_IMPORT = new TypeError('error loading dynamically imported module: http://localhost:5595/src/views/Flow/index.tsx');

describe('resolveConsoleText', () => {
  it('leaves a message without a handle placeholder as it is, without asking the page', async () => {
    let asked = false;
    const text = await resolveConsoleText('[meter-reader] sweep failed KvHttpError: KV PUT meta failed: HTTP 500', () => {
      asked = true;
      return [];
    });
    expect(text).toBe('[meter-reader] sweep failed KvHttpError: KV PUT meta failed: HTTP 500');
    expect(asked).toBe(false);
  });

  it("reads Firefox's JSHandle@object as the error's name and message", async () => {
    const text = await resolveConsoleText(FIREFOX_VIEW_CRASH, () => [handle('[meter-reader] view crashed'), handle(FIREFOX_IMPORT), handle('\n    at Lazy')]);
    expect(text).toBe('[meter-reader] view crashed TypeError: error loading dynamically imported module: http://localhost:5595/src/views/Flow/index.tsx \n    at Lazy');
    expect(LAZY_IMPORT_FAILED.test(text)).toBe(true);
    expect(LAZY_IMPORT_FAILED.test(FIREFOX_VIEW_CRASH)).toBe(false); // why resolving matters
  });

  it('prints plain objects as JSON and values JSON cannot hold with String()', async () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(await resolveConsoleText('JSHandle@object', () => [handle({ status: 404, key: 'roll/hour' })])).toBe('{"status":404,"key":"roll/hour"}');
    expect(await resolveConsoleText('JSHandle@object', () => [handle(cyclic)])).toBe('[object Object]');
    expect(await resolveConsoleText('JSHandle@undefined', () => [handle(undefined)])).toBe('undefined');
  });

  it('keeps the original text when the page has gone or there is nothing to resolve (never drops an error)', async () => {
    expect(await resolveConsoleText(FIREFOX_VIEW_CRASH, () => [handle('x'), gone])).toBe(FIREFOX_VIEW_CRASH);
    expect(await resolveConsoleText(FIREFOX_VIEW_CRASH, () => [])).toBe(FIREFOX_VIEW_CRASH);
    expect(
      await resolveConsoleText(FIREFOX_VIEW_CRASH, () => {
        throw new Error('handles disposed');
      }),
    ).toBe(FIREFOX_VIEW_CRASH);
    expect(HANDLE_PLACEHOLDER.test('JSHandle@error')).toBe(true);
  });
});

describe('isAbandonedLazyImport (D40)', () => {
  const settled = { leaving: false, reoptimized: false };
  const texts = [
    'TypeError: Failed to fetch dynamically imported module: http://localhost:5174/src/views/Ledger/index.tsx', // Chromium
    '[meter-reader] view crashed TypeError: error loading dynamically imported module: http://localhost:5174/src/views/Flow/index.tsx', // Firefox
    '[meter-reader] view crashed TypeError: Importing a module script failed.', // WebKit
  ];

  it('ignores a lazy-import failure from a page the spec was leaving, in every engine', () => {
    for (const text of texts) expect(isAbandonedLazyImport(text, { leaving: true, reoptimized: false })).toBe(true);
  });

  it('ignores one after the dev server answered a pre-bundled dep "504 Outdated Optimize Dep"', () => {
    for (const text of texts) expect(isAbandonedLazyImport(text, { leaving: false, reoptimized: true })).toBe(true);
    expect(isOutdatedOptimizeDep('http://localhost:5174/node_modules/.vite/deps/d3-sankey.js?v=a44c2fcd', 504)).toBe(true);
    expect(isOutdatedOptimizeDep('http://localhost:5174/node_modules/.vite/deps/d3-sankey.js?v=a44c2fcd', 200)).toBe(false);
    expect(isOutdatedOptimizeDep('http://localhost:5174/mock-api/v1/kvstore/meta', 504)).toBe(false);
  });

  it('never ignores it on a settled page: there it is a crash', () => {
    for (const text of texts) expect(isAbandonedLazyImport(text, settled)).toBe(false);
  });

  it('never ignores any other error, even while leaving', () => {
    const leaving = { leaving: true, reoptimized: true };
    expect(isAbandonedLazyImport('[meter-reader] view crashed TypeError: Cannot read properties of undefined', leaving)).toBe(false);
    expect(isAbandonedLazyImport('[meter-reader] sweep failed KvHttpError: KV PUT roll/hour/2026-09-27 failed: HTTP 404', leaving)).toBe(false);
    expect(isAbandonedLazyImport('SyntaxError: Unexpected token', leaving)).toBe(false);
  });
});
