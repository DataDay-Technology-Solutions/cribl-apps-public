// tests/e2e/shell.spec.ts — the Shell's chrome (BEAUTY-3a F6/F7; REVIEW-3a #10; DECISIONS D22).
//
//   • one page frame: the <Page> container starts at the same x on every width (80 at 1440, 320 at 1920,
//     16 at 390) with the title as its first line;
//   • the tab row on a phone: the active tab is always fully visible (never "Der…"), the edge that hides
//     tabs fades, the status dot stays put, and nothing scrolls the page sideways;
//   • the footer: the installed package version with the build, and who meters;
//   • the epic audit's shell items: the SAMPLE DATA band pinned under the tabs (P1-A06), a word beside the
//     status dot on phones whenever the data is not live (P1-A04), toasts clear of the tab row and the status
//     cluster, once per message, with an entrance (P1-A03), none on the stage (P0-09), and a cold-load
//     skeleton in the page frame (P1-A02);
//   • wave 2: the stage is dark on every account, every stage text pair ≥ 4.5:1 on a light account (P1-A07).
//
// Screenshots: tests/report/beauty/shell-nav-<theme>-390.png and shell-frame-<theme>-<width>.png, taken by the
// `chromium` project only (it sets each width itself), so the mobile project never overwrites them; the
// epic-audit shots are tests/report/screens/wave1-a-*.png.

import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  allowClipboard,
  gotoApp,
  readClipboard,
  mockControl,
  resetMock,
  seedPrices,
  setTheme,
  trackConsoleErrors,
  waitForHydration,
  type Theme,
} from './helpers/index.ts';

const ALLOW = [/Outdated Optimize Dep/];
const THEMES: Theme[] = ['light', 'dark'];

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
}

test.describe('shell', () => {
  test('one page frame: same left edge and title rule at every width', async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'the chromium project sets each width itself');
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings');
    await expect(page.locator('.mr-page-title')).toBeVisible();
    for (const [width, height, left] of [
      [1440, 900, 80],
      [1920, 1080, 320],
      [390, 844, 16],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(200);
      const frame = await box(page, '.mr-page');
      expect(Math.round(frame.x), `frame left at ${width}`).toBe(left);
      expect(frame.width).toBeLessThanOrEqual(1280);
      const title = await box(page, '.mr-page > .mr-page-head .mr-page-title');
      expect(Math.round(title.x)).toBe(left);
      expect(await page.locator('main h1').count()).toBe(1);
      const font = await page.locator('.mr-page-title').evaluate((el) => getComputedStyle(el).fontSize);
      expect(font).toBe('24px'); // typography.heading.lg
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await page.waitForTimeout(400); // Capra's colour transitions settle
        await page.screenshot({ path: `tests/report/beauty/shell-frame-${theme}-${width}.png` });
      }
      await setTheme(page, 'light');
    }
    expect(errors()).toEqual([]);
  });

  test('every screen renders in the one page frame (First run in its narrow width)', async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'the chromium project sets the width itself');
    const errors = trackConsoleErrors(page, ALLOW);
    await page.setViewportSize({ width: 1440, height: 900 });
    // The emulator starts unpriced, so '/' is First run here; the Receipt's frame is covered by receipt.spec.
    for (const [path, left, max] of [
      ['/first-run', 360, 720],
      ['/flow', 80, 1280],
      ['/whatif', 80, 1280],
      ['/ledger', 80, 1280],
      ['/settings', 80, 1280],
    ] as const) {
      await gotoApp(page, path);
      // The loading skeleton sits in the same frame (P1-A02); measure the view once it has replaced it.
      await expect(page.getByTestId('view-loading')).toHaveCount(0);
      const frame = page.locator('main .mr-page');
      await expect(frame, path).toHaveCount(1);
      await expect(frame).toBeVisible();
      await expect.poll(async () => Math.round((await box(page, 'main .mr-page')).x), `${path} frame left`).toBe(left);
      expect((await box(page, 'main .mr-page')).width, `${path} frame width`).toBeLessThanOrEqual(max);
      await expect(page.locator('main h1'), `${path} has one h1`).toHaveCount(1);
    }
    expect(errors()).toEqual([]);
  });

  test('phone tab row: the active tab is fully in view, hidden tabs fade, the status stays', async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'the chromium project sets the phone width itself');
    const errors = trackConsoleErrors(page, ALLOW);
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, '/settings');
    const tabs = page.locator('.mr-topnav-tabs');
    const active = tabs.locator('a[aria-current="page"]');
    await expect(active).toHaveText('Settings');
    await expect(page.locator('.mr-page-title')).toBeVisible(); // the lazy view has rendered

    const inView = async () => {
      const row = await box(page, '.mr-topnav-tabs');
      const tab = await box(page, '.mr-topnav-tabs a[aria-current="page"]');
      return tab.x >= row.x - 0.5 && tab.x + tab.width <= row.x + row.width + 0.5;
    };
    /** The fade attributes always match what the row actually hides. */
    const fadesMatch = () =>
      tabs.evaluate((el) => {
        const max = el.scrollWidth - el.clientWidth;
        const start = el.scrollLeft > 1;
        const end = max > 1 && el.scrollLeft < max - 1;
        return el.dataset.fadeStart === String(start) && el.dataset.fadeEnd === String(end);
      });
    const noPageScroll = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    // 390 px, release build (five tabs): everything fits, nothing fades, the status dot sits at the end.
    await expect.poll(inView).toBe(true);
    await expect.poll(fadesMatch).toBe(true);
    await expect(page.locator('.mr-topnav-status .mr-status-dot')).toBeVisible();
    await noPageScroll();
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `tests/report/beauty/shell-nav-${theme}-390.png`, clip: { x: 0, y: 0, width: 390, height: 140 } });
    }

    // 320 px (the narrowest phones): the row scrolls on its own; the active last tab is scrolled fully into
    // view and the start fades instead of cutting a label.
    await page.setViewportSize({ width: 320, height: 700 });
    await expect.poll(inView).toBe(true);
    await expect(tabs).toHaveAttribute('data-fade-start', 'true');
    await expect.poll(fadesMatch).toBe(true);
    await expect(page.locator('.mr-topnav-status .mr-status-dot')).toBeVisible();
    await noPageScroll();
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `tests/report/beauty/shell-nav-${theme}-320.png`, clip: { x: 0, y: 0, width: 320, height: 140 } });
    }
    await setTheme(page, 'light');

    // Back to an early tab (Receipt would redirect an unpriced workspace to First run): the row scrolls back
    // so it is fully in view, and the end fades now that later tabs are hidden.
    await tabs.getByRole('link', { name: 'Flow' }).click();
    await expect(active).toHaveText('Flow');
    await expect.poll(inView).toBe(true);
    await expect(tabs).toHaveAttribute('data-fade-end', 'true');
    await expect.poll(fadesMatch).toBe(true);
    expect(errors()).toEqual([]);
  });

  test('footer: installed version with the build, and who meters', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings');
    await expect(page.getByTestId('footer-build')).toHaveText(/^v\d+\.\d+\.\d+ · (release|demo build)$/);
    await expect(page.getByTestId('footer-build')).not.toContainText('-demo');
    await expect(page.getByTestId('footer-runtime')).toHaveText('Set prices to start the meter');
    expect(errors()).toEqual([]);
  });
});

// ─── Epic audit: the shell items (P0-09, P1-A02, P1-A03, P1-A04, P1-A06) ────────────────────────────────

/** A priced workspace, so '/' is the Receipt (a never-priced one lands on First run). */
async function openPriced(page: Page, path = '/'): Promise<void> {
  await gotoApp(page, '/first-run');
  // Let the view finish loading first: Firefox fails a module import that a navigation cancels, loudly.
  await expect(page.getByTestId('first-run')).toBeVisible();
  await resetMock(page);
  await seedPrices(page);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
}

interface StoreHandle {
  getState(): Record<string, unknown> & { status: { live: Record<string, unknown> }; snapshot: Record<string, unknown> | null };
  setState(patch: unknown): void;
}
type HookWindow = Window & { __MR_PRESENTER__?: { store: StoreHandle; stop: () => void }; __mrStore?: StoreHandle };

/** The kind of the live poll's last error, read from the store (the stage's test hook, mock builds only). */
function lastErrorKind(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const w = window as HookWindow;
    const store = w.__mrStore ?? w.__MR_PRESENTER__?.store;
    const error = store?.getState().status.live.lastError as { kind?: string } | undefined;
    return error?.kind ?? null;
  });
}

/** Every toast this app shows carries `data-mr-toast` on its body (Toasts.tsx); the box is Capra's toast. */
const toastBodies = (page: Page): Locator => page.locator('[data-mr-toast]');
const toastBox = (page: Page): Locator => page.locator(':is([role="status"], [role="alert"]):has([data-mr-toast])').first();

function intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function boxOf(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('no box');
  return b;
}

const shotsHere = (): boolean => test.info().project.name === 'chromium';

async function shoot(page: Page, id: string, width: number, height: number, opts: { fullPage?: boolean; prefix?: string } = {}): Promise<void> {
  if (!shotsHere()) return;
  const viewport = page.viewportSize();
  await page.setViewportSize({ width, height });
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `tests/report/screens/${opts.prefix ?? 'wave1-a'}-${id}-${theme}-${width}.png`, fullPage: opts.fullPage });
  }
  await setTheme(page, 'light');
  if (viewport) await page.setViewportSize(viewport);
}

test.describe('shell (epic audit)', () => {
  test.setTimeout(150_000);

  test('the SAMPLE DATA band stays pinned under the tabs while the tour Receipt scrolls (P1-A06)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/first-run');
    await expect(page.getByTestId('first-run')).toBeVisible(); // loaded before the next navigation (Firefox)
    await resetMock(page);
    await gotoApp(page, '/first-run');
    await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    const band = page.locator('.mr-shell-header [data-callout="sample-band"]');
    await expect(band).toBeVisible();
    await expect(page.getByTestId('receipt-hero')).toBeVisible();
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.scrollTo(0, 800));
      await expect.poll(() => page.evaluate(() => window.scrollY), `scrolled at ${width}`).toBeGreaterThanOrEqual(400);
      const b = await boxOf(band);
      expect(b.y, `band top at ${width}`).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height, `band bottom at ${width}`).toBeLessThanOrEqual(height);
      await expect(band).toBeVisible();
      await expect(band).toBeInViewport();
      // The tab bar is still there above it, and the band's short line and its button fit one row.
      const header = await boxOf(page.locator('.mr-shell-header'));
      expect(header.y).toBeCloseTo(0, 0);
      expect(b.y).toBeGreaterThan(header.y);
      if (width === 390) await expect(page.locator('.mr-status')).toContainText('Sample');
      await shoot(page, 'band-pinned-scrolled', width, height);
    }
    expect(errors()).toEqual([]);
  });

  test('pinned band: the Flow map and the Settings rail pin below it, never under it (P1-A06)', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'both pin only on desktop widths');
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/first-run');
    await expect(page.getByTestId('first-run')).toBeVisible(); // loaded before the next navigation (Firefox)
    await resetMock(page);
    await gotoApp(page, '/first-run');
    await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    const header = page.locator('.mr-shell-header');
    await expect(header.locator('[data-callout="sample-band"]')).toBeVisible();
    for (const [path, pinned] of [
      ['/flow', '.mr-flowmap-card'],
      ['/settings', '.mr-settings-rail'],
    ] as const) {
      await page.getByRole('navigation').first().getByRole('link', { name: path === '/flow' ? 'Flow' : 'Settings', exact: true }).click();
      await expect(page.locator(pinned).first()).toBeVisible();
      const top = await page.locator(pinned).first().evaluate((el) => parseFloat(getComputedStyle(el).top));
      const bottom = await header.evaluate((el) => el.getBoundingClientRect().bottom);
      expect(top, `${pinned} sticky top clears the header and its band`).toBeGreaterThanOrEqual(bottom);
    }
    expect(errors()).toEqual([]);
  });

  test('phones: every status but Live keeps its word beside the dot, and the full label is announced (P1-A04)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await page.setViewportSize({ width: 390, height: 844 });
    await openPriced(page, '/?present=1');
    await page.waitForFunction(() => '__MR_PRESENTER__' in window);
    // The first sweep has written a snapshot (the states below age or break it).
    await page.waitForFunction(() => (window as HookWindow).__MR_PRESENTER__?.store.getState().snapshot, undefined, { timeout: 30_000 });
    // Hold the store still (no polling, no sweeps), then leave the stage for the normal chrome.
    await page.evaluate(() => {
      const w = window as HookWindow;
      w.__mrStore = w.__MR_PRESENTER__!.store;
      w.__MR_PRESENTER__!.stop();
    });
    await page.keyboard.press('p');
    const status = page.locator('.mr-topnav-status .mr-status');
    await expect(status).toBeVisible();
    const short = status.locator('.mr-status-label--short');

    const set = (patch: Record<string, unknown>) =>
      page.evaluate((p) => {
        const store = (window as HookWindow).__mrStore!;
        const s = store.getState();
        const live = { ...s.status.live, lastError: undefined, backoffUntil: undefined, ...(p.live as object) };
        const snapshot = s.snapshot && p.sweepAgoMs !== undefined ? { ...s.snapshot, sweepAt: new Date(Date.now() - (p.sweepAgoMs as number)).toISOString() } : s.snapshot;
        store.setState({ source: p.source ?? 'live', snapshot, status: { ...s.status, live } });
      }, patch);

    const cases = [
      { state: 'stale', word: 'Stale', full: 'Stale', patch: { sweepAgoMs: 10 * 60_000, live: { lastOkAt: Date.now() - 10 * 60_000 } } },
      { state: 'rate-limited', word: 'Limited', full: 'Rate limited', patch: { live: { lastError: { kind: 'rate-limited', status: 429, at: Date.now() } } } },
      { state: 'offline', word: 'Offline', full: 'Offline', patch: { live: { lastError: { kind: 'server', status: 503, at: Date.now() } } } },
    ] as const;
    for (const c of cases) {
      await set(c.patch);
      await expect(status).toHaveAttribute('data-status', c.state);
      await expect(short, `${c.state}: the word is on screen`).toBeVisible();
      await expect(short).toHaveText(c.word);
      const b = await boxOf(short);
      expect(b.x + b.width, `${c.state}: the word fits the frame`).toBeLessThanOrEqual(390);
      expect(await status.ariaSnapshot(), `${c.state}: announced`).toContain(c.full);
      if (c.state === 'offline' || c.state === 'rate-limited') await shoot(page, `status-${c.state}`, 390, 844);
    }
    // Sample data: the dot alone too, for the pinned band says it in words, and the Settings tab stays in view (OQ-17).
    await set({ source: 'sample' });
    await expect(status).toHaveAttribute('data-status', 'sample');
    await expect(short).toBeHidden();
    expect(await status.ariaSnapshot(), 'sample: announced').toContain('Sample data');
    // All well: the green dot alone (the footer says when it last swept).
    await set({ sweepAgoMs: 5_000, live: { lastOkAt: Date.now() } });
    await expect(status).toHaveAttribute('data-status', 'live');
    await expect(short).toBeHidden();
    expect(await status.ariaSnapshot()).toContain('Live');
    // The tab row still shows the active tab whole; nothing scrolls the page sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    expect(errors()).toEqual([]);
  });

  test('toasts: bottom right, clear of the tab row and the status; one per message; they fade in (P1-A03)', async ({ page, context, browserName }) => {
    const errors = trackConsoleErrors(page, [...ALLOW, /\b503\b/]);
    await allowClipboard(context, browserName);
    await openPriced(page, '/');
    await expect(page.getByTestId('receipt-hero')).toBeVisible();

    // Two Copy receipt clicks in a row: one "Receipt copied." toast.
    const copy = page.getByRole('button', { name: 'Copy receipt' });
    await copy.click();
    await expect(page.getByText('Receipt copied.')).toBeVisible();
    // The entrance: a running opacity animation on the toast as it mounts (reduced motion: none, below).
    const animated = await toastBox(page).evaluate((el) =>
      el.getAnimations().some((a) => {
        const effect = a.effect as KeyframeEffect | null;
        return effect?.getKeyframes().some((k) => k.opacity !== undefined) ?? false;
      }),
    );
    expect(animated, 'the toast fades in').toBe(true);
    await copy.click();
    await page.waitForTimeout(300);
    await expect(page.getByText('Receipt copied.')).toHaveCount(1);

    // Clear of the tab row and the status cluster, at every width.
    const viewport = page.viewportSize()!;
    for (const [width, height] of [
      [viewport.width, viewport.height],
      [390, 844],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      const toast = await boxOf(toastBox(page));
      const nav = await boxOf(page.locator('.mr-topnav-tabs'));
      const status = await boxOf(page.locator('.mr-topnav-status'));
      expect(intersects(toast, nav), `toast over the tabs at ${width}`).toBe(false);
      expect(intersects(toast, status), `toast over the status at ${width}`).toBe(false);
      expect(toast.y + toast.height, `bottom edge at ${width}`).toBeGreaterThan(height / 2);
      expect(toast.x + toast.width, `right edge at ${width}`).toBeGreaterThan(width / 2);
      if (width === 1440 || width === 390) await shoot(page, 'toast-copied', width, height);
    }
    await page.setViewportSize(viewport);
    expect(errors()).toEqual([]);
  });

  test('toasts: no entrance animation under prefers-reduced-motion (P1-A03)', async ({ page, context, browserName }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await allowClipboard(context, browserName);
    await openPriced(page, '/');
    await page.getByRole('button', { name: 'Copy receipt' }).click();
    await expect(page.getByText('Receipt copied.')).toBeVisible();
    const running = await toastBox(page).evaluate((el) => el.getAnimations().length);
    expect(running).toBe(0);
  });

  test('no toast on the stage: a failing poll toasts only once the stage is left, and entering it clears the toast (P0-09)', async ({ page }) => {
    // Every KV read fails on purpose below: the 503s and this tab's failing sweeps are expected in the console.
    const errors = trackConsoleErrors(page, [...ALLOW, /\b503\b/, /\[meter-reader\] sweep/]);
    await openPriced(page, '/?present=1');
    await expect(page.locator('.mr-pv')).toBeVisible();
    // The first sweep's figures are on stage: a 5xx then keeps "the last good data" and toasts (P1-D02).
    await expect(page.locator('.mr-pv-figure:not(.mr-pv-figure--empty)')).toBeVisible({ timeout: 90_000 });
    await page.waitForFunction(() => '__MR_PRESENTER__' in window);
    await page.evaluate(() => {
      const w = window as HookWindow;
      w.__mrStore = w.__MR_PRESENTER__!.store;
    });
    // Figures on screen first: with no snapshot there is no "last good data" to keep, so no toast (P1-D02).
    await expect.poll(() => page.evaluate(() => (window as HookWindow).__mrStore!.getState().snapshot !== null), { timeout: 30_000 }).toBe(true);
    // Every KV read fails with a 503 from now on: the live poll (every 5 s on the stage) records it.
    await mockControl(page, { action: 'fault', method: 'GET', path: '/kvstore/', status: 503, times: -1 });
    await expect.poll(() => lastErrorKind(page), { timeout: 30_000 }).toBe('server');
    await page.waitForTimeout(1_000);
    await expect(toastBodies(page)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Notifications' })).toHaveCount(0);
    await shoot(page, 'stage-5xx-no-toast', 1440, 900);
    await shoot(page, 'stage-5xx-no-toast', 1920, 1080);

    // Leaving the stage brings the (still standing) error back as its one toast.
    await page.keyboard.press('p');
    await expect(page.locator('.mr-shell[data-mode="normal"]')).toBeVisible();
    const toast = page.locator('[data-mr-toast="error"]');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('503');
    // Entering it again clears the toast; the stage's own status line carries the message there.
    await page.keyboard.press('p');
    await expect(page.locator('.mr-pv')).toBeVisible();
    await expect(toastBodies(page)).toHaveCount(0);
    await mockControl(page, { action: 'clearFaults' });
    expect(errors()).toEqual([]);
  });

  test('no toast on the stage during the tour: the regression and its delivery show only as the takeover (P0-09)', async ({ page }, info) => {
    test.skip(info.project.name === 'chromium-1920', 'one desktop and one phone run cover it; the tour takes ~40 s');
    test.setTimeout(180_000);
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/first-run');
    await expect(page.getByTestId('first-run')).toBeVisible(); // loaded before the next navigation (Firefox)
    await resetMock(page);
    await gotoApp(page, '/first-run');
    await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-mr-tour', 'running');
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('p');
    await expect(page.locator('.mr-pv')).toBeVisible();
    // Count every toast body that ever enters the DOM while the tour plays on the stage.
    await page.evaluate(() => {
      const w = window as unknown as { __mrToasts: number };
      w.__mrToasts = 0;
      new MutationObserver((records) =>
        records.forEach((r) =>
          r.addedNodes.forEach((n) => {
            if (n instanceof Element && (n.matches('[data-mr-toast]') || n.querySelector('[data-mr-toast]'))) w.__mrToasts++;
          }),
        ),
      ).observe(document.body, { childList: true, subtree: true });
    });
    await expect(page.locator('.mr-takeover')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.mr-takeover')).toHaveAttribute('data-delivered', 'true', { timeout: 30_000 });
    expect(await page.evaluate(() => (window as unknown as { __mrToasts: number }).__mrToasts)).toBe(0);
    await expect(toastBodies(page)).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('a cold load shows the skeleton in the page frame: its left edge is the view’s (P1-A02)', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'holding the chunk needs a route on the emulator worker’s fetches, which only Chromium offers');
    const errors = trackConsoleErrors(page, ALLOW);
    // Hold the Ledger chunk back so the Suspense fallback is on screen long enough to measure. On the context,
    // not the page: the emulator's service worker fetches the module, and page routes never see it.
    const LEDGER_CHUNK = /\/src\/views\/Ledger\/index\.tsx/;
    let gate: Promise<void> | null = null;
    await context.route(LEDGER_CHUNK, async (route) => {
      if (gate) await gate;
      await route.continue().catch(() => {}); // the same module may be asked for by the page and the worker
    });
    for (const [width, height, left] of [
      [1440, 900, 80],
      [390, 844, 16],
    ] as const) {
      await page.setViewportSize({ width, height });
      let release: () => void = () => {};
      gate = new Promise<void>((r) => (release = r));
      await page.goto('/ledger', { waitUntil: 'domcontentloaded' });
      const skeleton = page.getByTestId('view-loading');
      await expect(skeleton).toBeVisible({ timeout: 20_000 });
      const frame = await boxOf(skeleton);
      expect(Math.round(frame.x), `skeleton frame left at ${width}`).toBe(left);
      expect(Math.round((await boxOf(skeleton.locator('.mr-view-skeleton'))).x)).toBe(left);
      await shoot(page, 'cold-skeleton', width, height);
      release();
      gate = null;
      await expect(page.locator('main h1')).toHaveText('Ledger');
      expect(Math.round((await boxOf(page.locator('main .mr-page'))).x), `view frame left at ${width}`).toBe(left);
    }
    await context.unroute(LEDGER_CHUNK);
    expect(errors()).toEqual([]);
  });
});

// ─── The dark stage (P1-A07) ─────────────────────────────────────────────────

/**
 * Every visible text node under `root` against its first opaque ancestor background, WCAG ratio; returns the
 * pairs under 4.5:1 (3:1 for large text). The presenter spec's check, repeated here for the account theme.
 */
async function contrastFailures(page: Page, root: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const parse = (c: string): [number, number, number, number] | null => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1]
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el: Element | null): number[] => {
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c[3] > 0.99) return c;
      }
      return parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1];
    };
    const out: string[] = [];
    const rootEl = document.querySelector(sel);
    if (!rootEl) return [`no ${sel}`];
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !(n.textContent ?? '').trim()) continue;
      seen.add(el);
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      if (el.closest('[aria-hidden="true"], .mr-visually-hidden, .mr-meter-strip')) continue;
      const fg = parse(style.color);
      if (!fg) continue;
      const bg = bgOf(el);
      const a = fg[3];
      const mixed = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
      const l1 = lum(mixed);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 600);
      if (ratio < (large ? 3 : 4.5)) out.push(`${(n.textContent ?? '').trim().slice(0, 40)} — ${ratio.toFixed(2)}:1`);
    }
    return out;
  }, root);
}

interface ShellHook {
  store: { getState(): { snapshot: { incidents: unknown[] } | null }; setState(p: Record<string, unknown>): void };
  stop(): void;
}

const STAGE_SIZES = [
  [1920, 1080],
  [1440, 900],
  [1280, 720],
  [390, 844],
] as const;

test.describe('the dark stage (P1-A07)', () => {
  test.setTimeout(150_000);

  test('on a light account the stage is dark: the dark application surface, every text pair ≥ 4.5:1, the takeover too', async ({ page }, info) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/first-run');
    await expect(page.getByTestId('first-run')).toBeVisible();
    await resetMock(page);
    await seedPrices(page);
    await page.goto('/?present=1', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const stage = page.locator('.mr-shell[data-mode="presenter"] .mr-pv');
    await expect(stage.locator('.mr-pv-figure:not(.mr-pv-figure--empty)')).toBeVisible({ timeout: 90_000 });

    const stageBg = () => stage.evaluate((el) => getComputedStyle(el).backgroundColor);
    const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await setTheme(page, 'dark');
    const darkSurface = await bodyBg();
    expect(await stageBg()).toBe(darkSurface);
    await setTheme(page, 'light');
    const lightSurface = await bodyBg();
    expect(lightSurface).not.toBe(darkSurface);
    // The account is light (no .dark on <body>); the stage is not.
    expect(await page.evaluate(() => document.body.classList.contains('dark'))).toBe(false);
    expect(await stageBg()).toBe(darkSurface);
    expect(await stage.evaluate((el) => getComputedStyle(el).colorScheme)).toContain('dark');
    expect(await contrastFailures(page, '.mr-pv')).toEqual([]);

    // The incident card on a light account.
    await page.waitForFunction(() => '__MR_SHELL__' in window);
    await page.evaluate(() => (window as unknown as { __MR_SHELL__: ShellHook }).__MR_SHELL__.stop());
    await page.evaluate(() => {
      const h = (window as unknown as { __MR_SHELL__: ShellHook }).__MR_SHELL__;
      const snap = h.store.getState().snapshot;
      if (!snap) throw new Error('no snapshot');
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      const incident = {
        id: 'inc_dark_stage',
        type: 'regression',
        severity: 'high',
        objectKey: 'pipe:default:mrd_pay_sample',
        label: 'Payments API sampling',
        outputId: 'mrd_siem_prod',
        openedAt: iso(now - 1_000),
        cause: 'commit',
        commit: { hash: 'a1f3c9e5b2', message: 'demo: break the trim on mrd_pay_sample', author: 's.koelpin', committedAt: iso(now - 180_000), deployedAt: iso(now - 171_000), groupId: 'default', match: 'message' },
        before: 0.75,
        after: 0.5,
        impactPerDayM: 2_500_000,
        caughtInSec: 170,
        notes: ['demo-profile'],
        deliveries: [],
      };
      h.store.setState({ snapshot: { ...snap, incidents: [incident], openIncidents: 1 } });
    });
    await expect(page.locator('.mr-takeover')).toBeVisible();
    await page.waitForTimeout(700); // the 450 ms slide-up
    expect(await contrastFailures(page, '.mr-takeover')).toEqual([]);
    if (info.project.name === 'chromium') {
      for (const [width, height] of STAGE_SIZES) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(300);
        await page.screenshot({ path: `tests/report/screens/wave2-a-dark-stage-takeover-light-${width === 1280 ? '1280x720' : width}.png` });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.keyboard.press('Space');
    await expect(page.locator('.mr-takeover')).toHaveCount(0);

    if (info.project.name === 'chromium') {
      for (const [width, height] of STAGE_SIZES) {
        await page.setViewportSize({ width, height });
        for (const theme of ['light', 'dark'] as const) {
          await setTheme(page, theme);
          await page.waitForTimeout(400);
          await page.screenshot({ path: `tests/report/screens/wave2-a-dark-stage-${theme}-${width === 1280 ? '1280x720' : width}.png` });
          expect(await contrastFailures(page, '.mr-pv'), `${theme} ${width}`).toEqual([]);
        }
      }
    }
    // Leaving the stage: the tabs are the account's theme again.
    await setTheme(page, 'light');
    await page.keyboard.press('p');
    await expect(page.locator('.mr-shell[data-mode="normal"]')).toBeVisible();
    expect(await page.locator('.mr-shell[data-mode="normal"]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(lightSurface);
    expect(errors()).toEqual([]);
  });
});

// ─── Diagnostics (P1-A08) ────────────────────────────────────────────────────

test.describe('diagnostics panel (P1-A08)', () => {
  test.setTimeout(150_000);

  test('lists metered through, the last error, groups and calls; Copy puts plain text on the clipboard; Close drops ?diag', async ({
    page,
    context,
    browserName,
  }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await allowClipboard(context, browserName);
    await openPriced(page, '/ledger?diag=1');
    await expect(page.locator('main h1')).toHaveText('Ledger');
    const panel = page.getByTestId('diag-panel');
    await expect(panel).toBeVisible();
    // The first sweep lands: the meter's rows fill in.
    await expect(panel.locator('[data-key="metered through"] dd')).toHaveText(/^\d\d:\d\d:\d\dZ · \d+ min behind now/, { timeout: 90_000 });
    for (const key of ['last error', 'groups', 'calls', 'lock holder', 'delivery', 'runner seen', 'kv', 'sweeps', 'last sweep', 'this tab']) {
      await expect(panel.locator(`[data-key="${key}"]`), key).toHaveCount(1);
    }
    await expect(panel.locator('[data-key="groups"] dd')).toHaveText(/known \d+.* · metered \d+/);
    await expect(panel.locator('[data-key="calls"] dd')).toHaveText(/^this tab \d+ in the last minute · shared budget/);
    // No raw JSON anywhere.
    expect(await panel.textContent()).not.toMatch(/[{}]"/);
    // Focusable, so its own scroll works by keyboard.
    expect(await panel.getAttribute('tabindex')).toBe('0');

    await panel.getByTestId('diag-copy').click();
    await expect(panel.getByTestId('diag-copy')).toHaveText('Copied');
    const text = await readClipboard(page);
    expect(text).toMatch(/^Meter Reader diagnostics · \d{4}-\d\d-\d\dT/);
    expect(text).toMatch(/\nmetered through +\d\d:\d\d:\d\dZ/);
    expect(text).toMatch(/\ncalls +this tab \d+ in the last minute/);
    expect(text).not.toContain('<');

    const size = page.viewportSize() ?? { width: 1440, height: 900 };
    if (size.width >= 1000) {
      await shoot(page, 'diag', 1440, 900, { prefix: 'wave2-a' });
      await shoot(page, 'diag', 390, 844, { prefix: 'wave2-a' });
    }
    if (size.width < 640) {
      // Phones: a bottom sheet, full width, its own scroll.
      const box = await panel.boundingBox();
      expect(Math.round(box?.x ?? -1)).toBe(0);
      expect(Math.round(box?.width ?? 0)).toBe(size.width);
      expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(size.height);
      expect(await panel.evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto')).toBe(true);
    }

    // A tap on Close removes it and ?diag from the URL, and the tab stays where it was.
    await panel.getByRole('button', { name: 'Close diagnostics' }).click();
    await expect(panel).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('diag')).toBeNull();
    expect(new URL(page.url()).pathname).toBe('/ledger');
    // Shift+D brings it back; Shift+D again closes it.
    await page.locator('main h1').click();
    await page.keyboard.press('Shift+D');
    await expect(panel).toBeVisible();
    await page.keyboard.press('Shift+D');
    await expect(panel).toHaveCount(0);
    expect(errors()).toEqual([]);
  });
});

// ─── Shell polish (P1-A05) ───────────────────────────────────────────────────

test.describe('shell polish (P1-A05)', () => {
  test.setTimeout(150_000);

  test('the first tab starts where the hero card does, the status ends where it ends (1440, 1920)', async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'the chromium project sets each width itself');
    const errors = trackConsoleErrors(page, ALLOW);
    await openPriced(page, '/');
    const hero = page.getByTestId('receipt-hero');
    await expect(hero).toBeVisible();
    for (const [width, height] of [
      [1440, 900],
      [1920, 1080],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      const card = await boxOf(hero);
      const tab = await boxOf(page.locator('.mr-topnav-tabs a').first());
      expect(Math.round(tab.x), `first tab at ${width}`).toBe(Math.round(card.x));
      if (width > 640) {
        const status = await boxOf(page.locator('.mr-topnav-status'));
        expect(Math.round(status.x + status.width), `status right edge at ${width}`).toBe(Math.round(card.x + card.width));
        const build = await boxOf(page.getByTestId('footer-build'));
        expect(Math.round(build.x), `footer at ${width}`).toBe(Math.round(card.x));
      }
      await shoot(page, 'frame-aligned', width, height, { prefix: 'wave2-a' });
    }
    expect(errors()).toEqual([]);
  });

  test('Tab from the page start reaches Skip to content first; it lands focus on the view', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Safari tabs to links only with Option+Tab');
    const errors = trackConsoleErrors(page, ALLOW);
    await openPriced(page, '/ledger');
    await expect(page.locator('main h1')).toHaveText('Ledger');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    const box = await boxOf(skip);
    expect(box.y).toBeGreaterThanOrEqual(0); // on screen while focused
    if ((page.viewportSize()?.width ?? 0) >= 1000) await shoot(page, 'skip-link', 1440, 900, { prefix: 'wave2-a' });
    await page.keyboard.press('Enter');
    await expect(page.locator('main#main')).toBeFocused();
    expect(new URL(page.url()).hash).toBe('');
    // The next Tab goes into the view, not back to the tab row.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('main'))).toBe(true);
    expect(errors()).toEqual([]);
  });

  test("'/' on a view without search opens the Ledger with its search focused; the sheet gives focus back", async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await openPriced(page, '/settings?period=30d');
    await expect(page.locator('main h1')).toHaveText('Settings');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('/');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/ledger');
    expect(new URL(page.url()).searchParams.get('period')).toBe('30d');
    await expect(page.locator('[data-mr-search] input, input[data-mr-search]').first()).toBeFocused();

    // ? with nothing focused, then Escape: focus goes to the view, never to <body>.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName)).toBe('main');
    expect(errors()).toEqual([]);
  });

  test('the header casts a shadow once the page scrolls under it', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await openPriced(page, '/');
    await expect(page.getByTestId('receipt-hero')).toBeVisible();
    const header = page.locator('.mr-shell-header');
    await expect(header).not.toHaveAttribute('data-scrolled', 'true');
    expect(await header.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
    await page.mouse.wheel(0, 600);
    await expect(header).toHaveAttribute('data-scrolled', 'true');
    expect(await header.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
    if ((page.viewportSize()?.width ?? 0) >= 1000) {
      await shoot(page, 'header-scrolled', 1440, 900, { prefix: 'wave2-a' });
      await shoot(page, 'header-scrolled', 390, 844, { prefix: 'wave2-a' });
    }
    await page.mouse.wheel(0, -2000);
    await expect(header).not.toHaveAttribute('data-scrolled', 'true');
    expect(errors()).toEqual([]);
  });

  test('the rate-limited caption says what happens next without repeating its label', async ({ page }) => {
    const errors = trackConsoleErrors(page, [...ALLOW, /\b429\b/]);
    await openPriced(page, '/ledger');
    await expect(page.locator('main h1')).toHaveText('Ledger');
    await page.waitForFunction(() => '__MR_SHELL__' in window);
    await page.evaluate(() => {
      const h = (window as unknown as { __MR_SHELL__: { store: StoreHandle; stop(): void } }).__MR_SHELL__;
      h.stop();
      const st = h.store.getState() as unknown as { status: { live: Record<string, unknown> } };
      h.store.setState({
        status: { ...st.status, live: { ...st.status.live, lastError: { kind: 'rate-limited', status: 429, at: Date.now() }, backoffUntil: Date.now() + 5 * 60_000 } },
      });
    });
    const status = page.locator('.mr-status');
    await expect(status).toHaveAttribute('data-status', 'rate-limited');
    if ((page.viewportSize()?.width ?? 0) > 640) {
      await expect(status.locator('.mr-status-caption')).toHaveText(/^checking every 60\s+s until \d{1,2}:\d\d (AM|PM)$/);
      expect(((await status.innerText()) ?? '').match(/rate limited/gi)).toHaveLength(1);
      if ((page.viewportSize()?.width ?? 0) < 1600) await shoot(page, 'status-ratelimited', 1440, 900, { prefix: 'wave2-a' });
    }
    expect(errors()).toEqual([]);
  });
});

// ─── The live pulse (P2-W21) ─────────────────────────────────────────────────

const secondsOf = (text: string | null): number => {
  const m = /(\d+):(\d\d)/.exec(text ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
};

test.describe('the live pulse (P2-W21)', () => {
  test.setTimeout(150_000);

  test('a click on the status opens the pulse: a countdown that counts down, the hour of sweeps, Sweep now', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await openPriced(page, '/ledger');
    await expect(page.locator('main h1')).toHaveText('Ledger');
    // This tab meters (runtime 'ui'): the footer's stub counts down to its own next sweep, never past a minute.
    const footerNext = page.getByTestId('footer-next');
    await expect(footerNext).toHaveText(/^next \d:\d\d$/, { timeout: 90_000 });
    expect(secondsOf(await footerNext.textContent())).toBeLessThanOrEqual(60);

    await page.locator('.mr-status').click();
    const pulse = page.getByTestId('status-pulse');
    await expect(pulse).toBeVisible();
    const next = pulse.getByTestId('pulse-next');
    await expect(next).toHaveText(/^Next sweep in \d:\d\d$/);
    const first = secondsOf(await next.textContent());
    await page.waitForTimeout(2_200);
    const later = secondsOf(await next.textContent());
    // It counts down (or a sweep landed and it restarted from the cadence).
    expect(later < first || later >= 25).toBe(true); // a sweep landed and it restarted
    await expect(pulse.getByTestId('pulse-caption')).toHaveText(/\d+ sweeps? seen/);
    await expect(pulse.getByRole('img', { name: 'Leader calls per sweep over the last 60 minutes' })).toBeVisible();
    await expect(pulse.getByRole('button', { name: /Sweep now/ })).toBeVisible();
    const width = page.viewportSize()?.width ?? 1440;
    if (width < 1600) {
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `tests/report/screens/wave2-a-pulse-${theme}-${width}.png` });
      }
      await setTheme(page, 'light');
    }
    await page.keyboard.press('Escape');
    await expect(pulse).toHaveCount(0);
    if (width < 1600) {
      const footer = page.locator('.mr-footer');
      await footer.scrollIntoViewIfNeeded();
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.waitForTimeout(400);
        await footer.screenshot({ path: `tests/report/screens/wave2-a-footer-stub-${theme}-${width}.png` });
      }
      await setTheme(page, 'light');
    }
    // The chevron is the keyboard's way in.
    await page.getByRole('button', { name: 'Sweep details' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('status-pulse')).toBeVisible();
    await page.keyboard.press('Escape');
    expect(errors()).toEqual([]);
  });

  test('tab badges: the Ledger counts the snapshot’s open alerts, Settings dots unpriced destinations', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await openPriced(page, '/flow');
    await expect(page.locator('main h1')).toHaveText('Flow');
    await page.waitForFunction(() => '__MR_SHELL__' in window);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __MR_SHELL__: { store: StoreHandle } }).__MR_SHELL__.store.getState().snapshot !== null), {
        timeout: 90_000,
      })
      .toBe(true);
    const nav = page.getByRole('navigation').first();
    await expect(nav.getByTestId('tab-badge')).toHaveCount(0);
    await page.evaluate(() => {
      const h = (window as unknown as { __MR_SHELL__: { store: StoreHandle; stop(): void } }).__MR_SHELL__;
      h.stop();
      const snap = h.store.getState().snapshot as Record<string, unknown>;
      h.store.setState({ snapshot: { ...snap, openIncidents: 2, unpricedOutputIds: ['mrd_lake', 'mrd_cold'] } });
    });
    const ledger = nav.getByRole('link', { name: 'Ledger, 2 open alerts' });
    await expect(ledger).toBeVisible();
    await expect(ledger.getByTestId('tab-badge')).toHaveText('2');
    await expect(nav.getByRole('link', { name: 'Settings, 2 destinations unpriced' }).getByTestId('tab-dot')).toBeVisible();
    const width = page.viewportSize()?.width ?? 1440;
    if (width < 1600) {
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `tests/report/screens/wave2-a-tab-badges-${theme}-${width}.png`, clip: { x: 0, y: 0, width, height: 120 } });
      }
      await setTheme(page, 'light');
    }
    expect(errors()).toEqual([]);
  });
});
