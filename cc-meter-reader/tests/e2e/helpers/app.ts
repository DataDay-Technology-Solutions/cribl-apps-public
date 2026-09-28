// tests/e2e/helpers/app.ts — loading the app, the DOM contract the UI publishes, console hygiene.
//
// DOM CONTRACT (the UI builds to this; the smoke test holds it to it):
//   • <html data-mr-hydrated="true"> once the first KV hydration (meta, settings, snapshot) finished
//     — SPEC 13 `hasHydrated` — and before any write is allowed;
//   • one <nav> landmark with in-app links to '/', '/flow', '/ledger' and '/settings' (router links,
//     basename window.CRIBL_BASE_PATH, which is '/' outside Cribl);
//   • one <main> landmark holding the current view;
//   • the theme follows CRIBL_APP_LAYOUT: `document.body.classList` contains 'dark' in dark mode.

import { expect, type BrowserContext, type ConsoleMessage, type Frame, type Page, type Request, type Response } from '@playwright/test';
import { HANDLE_PLACEHOLDER, isAbandonedLazyImport, isOutdatedOptimizeDep, resolveConsoleText, type PageMoment } from './console.ts';

export { resolveConsoleText, isAbandonedLazyImport, LAZY_IMPORT_FAILED } from './console.ts';

/** The primary views and where the nav links point. */
export const PRIMARY_ROUTES = [
  { path: '/', name: /receipt/i },
  { path: '/flow', name: /flow/i },
  { path: '/ledger', name: /ledger/i },
  { path: '/settings', name: /settings/i },
] as const;

export const HYDRATED_SELECTOR = 'html[data-mr-hydrated="true"]';

export interface HydrationOptions {
  timeoutMs?: number;
}

/** Waits for the app's hydration flag (see the DOM contract above). */
export async function waitForHydration(page: Page, opts: HydrationOptions = {}): Promise<void> {
  await page.locator(HYDRATED_SELECTOR).waitFor({ state: 'attached', timeout: opts.timeoutMs ?? 20_000 });
}

/** Waits until the in-browser emulator has started in this page. */
export async function waitForMock(page: Page, timeoutMs = 20_000): Promise<void> {
  await page.waitForFunction(() => '__MR_MOCK__' in window && navigator.serviceWorker?.controller !== null, undefined, { timeout: timeoutMs });
}

/** Navigates to an app path and waits for the emulator and hydration. */
export async function gotoApp(page: Page, path = '/', opts: HydrationOptions = {}): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForMock(page, opts.timeoutMs);
  await waitForHydration(page, opts);
}

/**
 * A KV read of a key that does not exist yet answers 404 on the platform (measured: "Key not found"),
 * and SPEC 13 treats that as empty. Chromium logs every 4xx fetch as "Failed to load resource", so
 * these expected misses would otherwise read as console errors on a fresh install.
 */
export const isExpectedKvMiss = (msg: ConsoleMessage): boolean =>
  /Failed to load resource: .*\b404\b/.test(msg.text()) && /\/kvstore\//.test(msg.location().url ?? '');

/**
 * Firefox logs a load that a spec's own navigation cancelled as a console error. Two shapes, each matched
 * narrowly so a load that genuinely fails is still reported (and a module that fails to load also raises a
 * pageerror or console error of its own):
 *   • a request the emulator's service worker (public/mockServiceWorker.js — mock builds only, never inside
 *     Cribl) was still passing through for the page being left: "A ServiceWorker intercepted the request and
 *     encountered an unexpected error", from that worker (seen on a module load, at the second navigation);
 *   • a web font still downloading for the page being left: "downloadable font: download failed … status=
 *     2152398850", which is NS_BINDING_ABORTED — the request was cancelled; a missing or refused font file
 *     reports a different status.
 */
export const isCancelledLoad = (msg: ConsoleMessage): boolean => {
  const text = msg.text();
  if (/A ServiceWorker intercepted the request and encountered an unexpected error/.test(text)) {
    return /\/mockServiceWorker\.js/.test(msg.location().url ?? '');
  }
  return /downloadable font: download failed .*\bstatus=2152398850\b/.test(text);
};

/**
 * Collects console errors and uncaught page errors from the moment it is called. `allow` lists
 * patterns that are known and accepted (keep it empty unless a failure is understood and filed).
 * Expected KV misses are ignored unless `strictKv` is set; loads cancelled by the spec's own navigation
 * (`isCancelledLoad`) are always ignored, and so is D40's lazy-import failure, but only from a page that was
 * being left or whose deps the dev server had just re-optimized (`isAbandonedLazyImport`).
 *
 * Firefox logs an error argument as "JSHandle@object"; such a message is resolved in the page first
 * (`resolveConsoleText`), so the filters and the report read the error's own words. Until it resolves the
 * raw message counts: an error is never lost because its text was late.
 */
export function trackConsoleErrors(page: Page, allow: RegExp[] = [], opts: { strictKv?: boolean } = {}): () => string[] {
  const entries: { text: string; dropped: boolean }[] = [];
  // Where the page stands: a main-frame navigation requested but not committed means the current document is
  // being left; a 504 for a pre-bundled dep means the dev server re-optimized under this document.
  const moment: PageMoment = { leaving: false, reoptimized: false };
  const main = (frame: Frame): boolean => frame === page.mainFrame();
  const onRequest = (req: Request): void => {
    if (req.isNavigationRequest() && main(req.frame())) moment.leaving = true;
  };
  const onNavigated = (frame: Frame): void => {
    if (!main(frame)) return;
    moment.leaving = false;
    moment.reoptimized = false;
  };
  const onResponse = (res: Response): void => {
    if (isOutdatedOptimizeDep(res.url(), res.status())) moment.reoptimized = true;
  };
  const record = (prefix: string, text: string, where: string, at: PageMoment): { text: string; dropped: boolean } | null => {
    if (allow.some((re) => re.test(text)) || isAbandonedLazyImport(text, at)) return null;
    return { text: `${prefix}${text}${where}`, dropped: false };
  };
  const onConsole = (msg: ConsoleMessage): void => {
    if (msg.type() !== 'error') return;
    if (!opts.strictKv && isExpectedKvMiss(msg)) return;
    if (isCancelledLoad(msg)) return;
    const raw = msg.text();
    const where = msg.location().url ? ` (${msg.location().url})` : '';
    const at = { ...moment };
    const entry = record('console.error: ', raw, where, at);
    if (!entry) return;
    entries.push(entry);
    if (!HANDLE_PLACEHOLDER.test(raw)) return;
    void resolveConsoleText(raw, () => msg.args()).then((text) => {
      if (text === raw) return;
      const resolved = record('console.error: ', text, where, at);
      if (resolved) entry.text = resolved.text;
      else entry.dropped = true;
    });
  };
  const onPageError = (err: Error): void => {
    const entry = record('pageerror: ', err.message, '', { ...moment });
    if (entry) entries.push(entry);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('request', onRequest);
  page.on('framenavigated', onNavigated);
  page.on('response', onResponse);
  return () => entries.filter((e) => !e.dropped).map((e) => e.text);
}

/**
 * Moves the open app to `path` the way its own links do: a history push the router follows (popstate), with no
 * document reload. A spec that tours the views while the tab meters uses this instead of `page.goto`: a reload
 * tears the document down mid-sweep, and a page being left keeps writing after MSW has stopped answering for it
 * (the emulator's client closes at `beforeunload`, so its KV PUTs fell through to the dev server's 404; WebKit
 * cancels them instead, "Load failed"), none of which a member moving between views ever does.
 */
export async function navigateInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  }, path);
  await expectPath(page, path.split('?')[0]);
  await page.locator('main').waitFor();
}

/** Asserts the current path (ignoring query and hash). */
export async function expectPath(page: Page, path: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname.replace(/\/+$/, '') || '/').toBe(path.replace(/\/+$/, '') || '/');
}

/** Screenshot path convention for the evidence report (SPEC 16): tests/report/screens/<id>-<theme>-<width>.png */
export function screenPath(id: string, theme: 'light' | 'dark', page: Page): string {
  const width = page.viewportSize()?.width ?? 0;
  return `tests/report/screens/${id}-${theme}-${width}.png`;
}

/**
 * Lets `navigator.clipboard.readText()` read back what the app copied, per engine: Playwright grants
 * 'clipboard-read' + 'clipboard-write' in Chromium only; WebKit knows 'clipboard-read' (writing needs only the
 * click) and rejects 'clipboard-write'; Firefox has no clipboard permissions to grant and lets an automated
 * page read its clipboard as it is.
 */
export async function allowClipboard(context: BrowserContext, browserName: string): Promise<void> {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  else if (browserName === 'webkit') await context.grantPermissions(['clipboard-read']);
}

/** The system clipboard's text, read through the real Clipboard API even when a spec has hidden it from the app. */
export function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as { __mrRealClipboard?: Clipboard };
    return (w.__mrRealClipboard ?? navigator.clipboard).readText();
  });
}

/** How the page's async Clipboard API behaves in a spec: as shipped, absent, or refusing every write. */
export type ClipboardApi = 'present' | 'missing' | 'rejects';

/**
 * Before any page script runs, stashes the real Clipboard (for `readClipboard`) and then hides it from the
 * app ('missing') or makes `writeText` reject as a frame without the clipboard-write permission does
 * ('rejects'). With `execCommandFails`, `document.execCommand('copy')` also reports failure, so no path works.
 */
export async function stubClipboardApi(context: BrowserContext, api: ClipboardApi, opts: { execCommandFails?: boolean } = {}): Promise<void> {
  await context.addInitScript(
    ({ api, execCommandFails }) => {
      const w = window as unknown as { __mrRealClipboard?: Clipboard };
      const real = navigator.clipboard;
      w.__mrRealClipboard = real;
      if (api === 'missing') Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => undefined });
      if (api === 'rejects' && real) {
        Object.defineProperty(real, 'writeText', {
          configurable: true,
          value: () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError')),
        });
      }
      if (execCommandFails) Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
    },
    { api, execCommandFails: opts.execCommandFails ?? false },
  );
}
