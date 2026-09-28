// tests/e2e/keyboard.spec.ts — the one keyboard map (SPEC 13, PRD 8.7) after the epic audit (P0-05, P0-06, P1-A02).
//
//   • P / Y / ? work whatever has focus — including a nav tab after a mouse click (Capra's links stop the
//     keydown's propagation, so the shell listens in the capture phase);
//   • keys meant for an open select, menu or dialog stay there (a Status select's typeahead 'p' never opens
//     the stage), Tab moves focus inside Story instead of leaving it, ⌘⇧D is not Shift+D, Escape leaves
//     presenter mode and closes an open diagnostics panel first;
//   • P on any tab opens THE stage (the presenter view on '/'), never a chromeless copy of the tab, and the
//     second P returns to that tab with its params intact; a deep link `?present=1` on a tab does the same;
//   • after hydration P and Y open without a skeleton frame (the stage and Story chunks are preloaded).
//
// Screenshots (the chromium project only, both themes, each width set here): tests/report/screens/wave1-a-*.png.

import { expect, test, type Page } from '@playwright/test';
import type { Incident, Snapshot } from '../../core/types.ts';
import { gotoApp, mockControl, resetMock, seedPrices, setTheme, trackConsoleErrors, waitForHydration, type Theme } from './helpers/index.ts';

const THEMES: Theme[] = ['light', 'dark'];
const TABS = [
  { name: 'Receipt', path: '/' },
  { name: 'Flow', path: '/flow' },
  { name: 'What if', path: '/whatif' },
  { name: 'Ledger', path: '/ledger' },
  { name: 'Settings', path: '/settings' },
] as const;

/** Every width the stage is shown at: laptop, phone, projector, and a 720p projector. */
const STAGE_SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
] as const;

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

const url = (page: Page) => new URL(page.url());
const pathOf = (page: Page) => url(page).pathname.replace(/\/+$/, '') || '/';
const param = (page: Page, key: string) => url(page).searchParams.get(key);

/** The stage: the presenter view with its hero, savers and QR, and the exit hint — no tab bar. */
async function expectStage(page: Page): Promise<void> {
  const stage = page.locator('.mr-shell[data-mode="presenter"] .mr-pv');
  await expect(stage).toBeVisible();
  await expect(stage.locator('.mr-pv-hero')).toBeVisible();
  await expect(stage.locator('.mr-pv-savers')).toBeVisible();
  await expect(stage.locator('[data-callout="qr"]')).toBeVisible();
  await expect(stage.locator('.mr-pv-exit')).toHaveText('P leaves the presenter view · ? shows keys');
  await expect(page.locator('.mr-topnav')).toHaveCount(0);
  await expect.poll(() => pathOf(page)).toBe('/');
  expect(param(page, 'present')).toBe('1');
}

/**
 * The active nav tab has focus, as it does after a mouse click in Chromium. Firefox and Safari do not focus a
 * link on click, so the test focuses it: the state that used to swallow every shortcut, in every engine.
 */
async function focusActiveTab(page: Page, name: string): Promise<void> {
  const active = page.locator('.mr-topnav-tabs a[aria-current="page"]');
  await expect(active).toHaveText(name); // the tab's view is up (a tab switch is a transition)
  await active.focus();
  await expect(active).toBeFocused();
}

/** Records whether a loading placeholder (the view skeleton, the stage's empty fallback) ever enters the DOM. */
async function watchForSkeletons(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __mrSkeletons: string[]; __mrSkeletonObserver?: MutationObserver };
    w.__mrSkeletons = [];
    w.__mrSkeletonObserver?.disconnect();
    const seen = (node: Node) => {
      if (!(node instanceof Element)) return;
      for (const el of [node, ...node.querySelectorAll('*')]) {
        if (el.matches('.mr-view-skeleton, .mr-stage-fallback, [data-testid="view-loading"]')) w.__mrSkeletons.push(el.className || el.tagName);
      }
    };
    w.__mrSkeletonObserver = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach(seen)));
    w.__mrSkeletonObserver.observe(document.body, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => (window as unknown as { __mrSkeletons: string[] }).__mrSkeletons);
}

const ownsScreens = (): boolean => test.info().project.name === 'chromium';

async function shootStage(page: Page, id: string): Promise<void> {
  if (!ownsScreens()) return;
  for (const size of STAGE_SIZES) {
    await page.setViewportSize(size);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await page.waitForTimeout(400); // Capra's colour transitions settle
      await page.screenshot({ path: `tests/report/screens/wave1-a-${id}-${theme}-${size.width === 1280 ? '1280x720' : size.width}.png` });
    }
  }
  await setTheme(page, 'light');
  await page.setViewportSize(test.info().project.use.viewport ?? { width: 1440, height: 900 });
}

test.describe('keyboard map', () => {
  test.setTimeout(150_000);

  test('P and Y work while a nav tab has focus on every tab; P from a tab opens the stage and P again goes back (P0-05, P0-06)', async ({
    page,
  }) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/');
    await expect(page.getByTestId('receipt-hero')).toBeVisible();
    const nav = page.getByRole('navigation').first();
    for (const tab of TABS) {
      await nav.getByRole('link', { name: tab.name, exact: true }).click();
      await expect.poll(() => pathOf(page), `on ${tab.name}`).toBe(tab.path);
      await focusActiveTab(page, tab.name);
      await page.keyboard.press('p');
      await expectStage(page);
      // The second P returns to the tab the stage was opened from.
      await page.keyboard.press('p');
      await expect.poll(() => pathOf(page), `back on ${tab.name}`).toBe(tab.path);
      expect(param(page, 'present')).toBeNull();
      await expect(page.locator('.mr-shell[data-mode="normal"] .mr-topnav')).toBeVisible();

      await focusActiveTab(page, tab.name);
      await page.keyboard.press('y');
      await expect.poll(() => param(page, 'story'), `story from ${tab.name}`).toBe('1');
      await expect(page.locator('.mr-story')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.mr-story')).toHaveCount(0);
      await expect.poll(() => pathOf(page)).toBe(tab.path);

      // ? and / from the focused tab too.
      await focusActiveTab(page, tab.name);
      await page.keyboard.press('?');
      await expect(page.getByRole('dialog')).toContainText('Go to anything'); // the ⌘K palette (P2-W22)
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    expect(errors()).toEqual([]);
  });

  test('P from a tab keeps its params for the way back; a deep link ?present=1 on a tab opens the stage (P0-06)', async ({ page }) => {
    // The deep link is a page load: a sweep still in flight when it lands is aborted (Firefox and Safari log it).
    const errors = trackConsoleErrors(page, [/sweep: could not start/, /due to access control checks/]);
    await openPriced(page, '/ledger?period=30d&object=input:mrd_pay_sample');
    await expect(page.locator('main h1')).toHaveText('Ledger');
    await page.locator('main h1').click();
    await page.keyboard.press('P');
    await expectStage(page);
    // The sticky params ride along to the stage (?period= picks its headline); the tab's own do not.
    expect(param(page, 'period')).toBe('30d');
    expect(param(page, 'object')).toBeNull();
    await shootStage(page, 'p-from-ledger');
    await page.keyboard.press('p');
    await expect.poll(() => pathOf(page)).toBe('/ledger');
    expect(param(page, 'period')).toBe('30d');
    expect(param(page, 'object')).toBe('input:mrd_pay_sample');
    await expect(page.locator('main h1')).toHaveText('Ledger');

    // From the Flow tab, by the key.
    await page.goto('/flow?group=default', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.locator('main h1')).toHaveText('Flow');
    await page.locator('main h1').click();
    await page.keyboard.press('p');
    await expectStage(page);
    expect(param(page, 'group')).toBe('default');
    await page.keyboard.press('p');
    await expect.poll(() => pathOf(page)).toBe('/flow');
    await expect(page.locator('main h1')).toHaveText('Flow');

    // Straight to a tab with ?present=1: the stage, never a chromeless Flow with its title clipped.
    await page.goto('/flow?present=1&group=default', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expectStage(page);
    expect(param(page, 'group')).toBe('default');
    await expect(page.locator('main h1', { hasText: 'Flow' })).toHaveCount(0);
    await page.keyboard.press('p');
    await expect.poll(() => pathOf(page)).toBe('/flow');
    expect(param(page, 'group')).toBe('default');
    expect(param(page, 'present')).toBeNull();
    await expect(page.locator('main h1')).toHaveText('Flow');
    expect(errors()).toEqual([]);
  });

  test('Escape leaves the presenter view; ? opens the stage key list and Escape closes only the list (P0-05, P1-B03)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/flow');
    await expect(page.locator('main h1')).toHaveText('Flow');
    await page.locator('main h1').click();
    await page.keyboard.press('p');
    await expectStage(page);
    await page.keyboard.press('?');
    // On the stage "?" opens the stage's own key list (P1-B03), not the app's shortcut sheet.
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText('Presenter keys');
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expectStage(page); // the list's Escape was the list's
    await page.keyboard.press('Escape');
    await expect.poll(() => pathOf(page)).toBe('/flow');
    expect(param(page, 'present')).toBeNull();
    await expect(page.locator('main h1')).toHaveText('Flow');
    // Escape with nothing to leave does nothing at all.
    await page.keyboard.press('Escape');
    await expect.poll(() => pathOf(page)).toBe('/flow');
    expect(errors()).toEqual([]);
  });

  test('Escape closes an open diagnostics panel before it leaves the stage, whichever opened first (P0-05)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/ledger');
    await page.locator('main h1').click();
    const diag = page.getByTestId('diag-panel');
    await page.keyboard.press('Shift+D');
    await expect(diag).toBeVisible();
    await page.keyboard.press('p');
    await expectStage(page);
    await expect(diag).toBeVisible(); // mounted once beside every mode: P does not close it
    await page.keyboard.press('Escape');
    await expect(diag).toHaveCount(0);
    await expectStage(page);
    await page.keyboard.press('Escape');
    await expect.poll(() => pathOf(page)).toBe('/ledger');
    expect(errors()).toEqual([]);
  });

  test('an open Status select keeps its typeahead: p stays in the listbox (P0-05)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/ledger');
    await expect(page.locator('main h1')).toHaveText('Ledger');
    const before = page.url();
    const filter = page.locator('[data-filter="state"]');
    await filter.getByRole('button').first().click();
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();
    await page.keyboard.press('p');
    await page.waitForTimeout(300);
    await expect(listbox).toBeVisible();
    expect(page.url()).toBe(before);
    await expect(page.locator('.mr-shell[data-mode="normal"]')).toBeVisible();
    if (ownsScreens()) {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `tests/report/screens/wave1-a-select-typeahead-${theme}-1440.png` });
      }
    }
    await page.keyboard.press('Escape');
    await expect(listbox).toHaveCount(0);
    // The closed select's trigger has focus: its own typeahead, still not the stage.
    await filter.getByRole('button').first().focus();
    await page.keyboard.press('p');
    await page.waitForTimeout(300);
    expect(param(page, 'present')).toBeNull();
    // Focus anywhere else: P works again.
    await page.locator('main h1').click();
    await page.keyboard.press('p');
    await expectStage(page);
    expect(errors()).toEqual([]);
  });

  test('Story: Tab moves focus inside it and reaches Close; arrows do not leave it; ⌘⇧D is not Shift+D (P0-05)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/ledger');
    await expect(page.locator('main h1')).toHaveText('Ledger');
    await page.locator('main h1').click();
    await page.keyboard.press('y');
    const story = page.locator('.mr-story');
    await expect(story).toBeVisible();
    const close = story.getByRole('button', { name: 'Close' });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Tab');
    await expect(story).toBeVisible();
    for (let i = 0; i < 6 && !(await close.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await expect(story).toBeVisible();
    expect(param(page, 'story')).toBe('1');
    await page.keyboard.press('Enter');
    await expect(story).toHaveCount(0);
    await expect.poll(() => pathOf(page)).toBe('/ledger');

    // ⌘⇧D and Ctrl+Shift+D (browser / OS chords) never toggle the diagnostics panel; Shift+D does.
    await page.locator('main h1').click();
    await page.keyboard.press('Meta+Shift+D');
    await page.keyboard.press('Control+Shift+D');
    await expect(page.getByTestId('diag-panel')).toHaveCount(0);
    await page.keyboard.press('Shift+D');
    await expect(page.getByTestId('diag-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('diag-panel')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('after hydration P and Y open with no skeleton frame; a hovered tab opens without one either (P1-A02)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/ledger');
    await expect(page.locator('main h1')).toHaveText('Ledger');
    // The stage and Story chunks are fetched once the browser is idle after hydration.
    await page.waitForTimeout(2_500);
    await page.locator('main h1').click();
    let skeletons = await watchForSkeletons(page);
    await page.keyboard.press('p');
    await expectStage(page);
    expect(await skeletons(), 'skeleton frames entering the stage').toEqual([]);
    await page.keyboard.press('p');
    await expect(page.locator('main h1')).toHaveText('Ledger');

    skeletons = await watchForSkeletons(page);
    await page.keyboard.press('y');
    await expect(page.locator('.mr-story')).toBeVisible();
    expect(await skeletons(), 'skeleton frames entering Story').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('main h1')).toHaveText('Ledger');

    // Hover a tab (its chunk is fetched on intent), then click it: the Ledger stays up until Flow is ready.
    const flowTab = page.getByRole('navigation').first().getByRole('link', { name: 'Flow', exact: true });
    await flowTab.hover();
    await page.waitForTimeout(800);
    skeletons = await watchForSkeletons(page);
    await flowTab.click();
    await expect(page.locator('main h1')).toHaveText('Flow');
    expect(await skeletons(), 'skeleton frames switching tabs').toEqual([]);
    expect(errors()).toEqual([]);
  });
});

// ─── The takeover lands on a late P (P1-A01) ─────────────────────────────────

interface ShellHook {
  store: { getState(): { snapshot: Snapshot | null }; setState(p: Record<string, unknown>): void };
  stop(): void;
}

/** The regression the presenter spec uses, opened a second before `now`: 75% → 50%, $25 a day. */
function regression(now: number): Incident {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    id: 'inc_late_p',
    type: 'regression',
    severity: 'high',
    objectKey: 'pipe:default:mrd_pay_sample',
    label: 'Payments API sampling',
    outputId: 'mrd_siem_prod',
    openedAt: iso(now - 1_000),
    cause: 'commit',
    commit: {
      hash: 'a1f3c9e5b2',
      message: 'demo: break the trim on mrd_pay_sample',
      author: 's.koelpin',
      committedAt: iso(now - 180_000),
      deployedAt: iso(now - 171_000),
      groupId: 'default',
      match: 'message',
    },
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    caughtInSec: 170,
    notes: ['demo-profile'],
    deliveries: [],
  };
}

/** Waits for the tab's own snapshot (the takeover's baseline), then pauses polling and the meter. */
async function holdSnapshot(page: Page): Promise<void> {
  await page.waitForFunction(() => '__MR_SHELL__' in window);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __MR_SHELL__: ShellHook }).__MR_SHELL__.store.getState().snapshot !== null), {
      timeout: 60_000,
    })
    .toBe(true);
  await page.evaluate(() => (window as unknown as { __MR_SHELL__: ShellHook }).__MR_SHELL__.stop());
}

/** Publishes an incident list on the tab's snapshot, as a sweep would. */
async function publishIncidents(page: Page, incidents: Incident[]): Promise<void> {
  await page.evaluate((incs) => {
    const h = (window as unknown as { __MR_SHELL__: ShellHook }).__MR_SHELL__;
    const snap = h.store.getState().snapshot;
    if (!snap) throw new Error('no snapshot yet');
    h.store.setState({ snapshot: { ...snap, incidents: incs, openIncidents: incs.filter((i) => !i.closedAt).length } });
  }, incidents);
}

test.describe('the takeover on a late P (P1-A01)', () => {
  test.setTimeout(150_000);

  test('an incident that opened while the laptop was on Flow lands on the stage when P is pressed', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/flow');
    await expect(page.locator('main h1')).toHaveText('Flow');
    await holdSnapshot(page);
    const now = await page.evaluate(() => Date.now());
    await publishIncidents(page, [regression(now)]);
    // Nothing covers Flow: the card is the stage's.
    await page.waitForTimeout(300);
    await expect(page.locator('.mr-takeover')).toHaveCount(0);

    await page.locator('main h1').click();
    await page.keyboard.press('p');
    await expectStage(page);
    const card = page.locator('.mr-takeover');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-incident-id', 'inc_late_p');
    await page.waitForTimeout(600); // the 450 ms slide-up
    if (ownsScreens()) {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `tests/report/screens/wave2-a-late-p-takeover-${theme}-1440.png` });
      }
      await setTheme(page, 'light');
    }
    // The key that clears it is consumed (D35); the next P leaves for Flow; a second visit to the stage
    // does not bring the dismissed card back.
    await page.keyboard.press('Space');
    await expect(card).toHaveCount(0);
    await page.keyboard.press('p');
    await expect.poll(() => pathOf(page)).toBe('/flow');
    await expect(page.locator('main h1')).toHaveText('Flow');
    await page.keyboard.press('p');
    await expectStage(page);
    await page.waitForTimeout(500);
    await expect(card).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('an incident the tab saw more than 45 s before P is old news', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.clock.install();
    await openPriced(page, '/ledger');
    await expect(page.locator('main h1')).toHaveText('Ledger');
    await holdSnapshot(page);
    const now = await page.evaluate(() => Date.now());
    await publishIncidents(page, [regression(now)]);
    await page.clock.fastForward(46_000);
    await page.locator('main h1').click();
    await page.keyboard.press('p');
    await expectStage(page);
    await page.waitForTimeout(500);
    await expect(page.locator('.mr-takeover')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('a fresh ?present=1 load treats the incidents already open as old news', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    // A real regression from the emulator: the payments trim broke 20 minutes ago; the tab's first sweep
    // backfills the hour, opens the incident and writes the snapshot to the App's KV.
    await gotoApp(page, '/first-run');
    await expect(page.getByTestId('first-run')).toBeVisible();
    await resetMock(page);
    await mockControl(page, { action: 'breakTrim', pipelineId: 'mrd_pay_sample', minutesAgo: 20 });
    await seedPrices(page);
    await page.goto('/ledger', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await page.waitForFunction(() => '__MR_SHELL__' in window);
    const openHigh = () =>
      page.evaluate(
        () =>
          (window as unknown as { __MR_SHELL__: ShellHook }).__MR_SHELL__.store
            .getState()
            .snapshot?.incidents.some((i) => !i.closedAt && i.severity === 'high') ?? false,
      );
    await expect.poll(openHigh, { timeout: 120_000 }).toBe(true);
    // The stage, fresh: its first snapshot (read from KV) already holds the open incident.
    await page.goto('/?present=1', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.locator('.mr-pv')).toBeVisible();
    await page.waitForFunction(() => '__MR_SHELL__' in window);
    await expect.poll(openHigh, { timeout: 30_000 }).toBe(true);
    await page.waitForTimeout(1_500);
    await expect(page.locator('.mr-takeover')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });
});

test.describe('overlays survive the stage (P1-A05)', () => {
  test('Shift+D, then P, then P: the diagnostics panel stays open throughout', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/flow');
    await expect(page.locator('main h1')).toHaveText('Flow');
    await page.locator('main h1').click();
    await page.keyboard.press('Shift+D');
    const diag = page.getByTestId('diag-panel');
    await expect(diag).toBeVisible();
    await page.keyboard.press('p');
    await expectStage(page);
    await expect(diag).toBeVisible();
    await page.keyboard.press('p');
    await expect.poll(() => pathOf(page)).toBe('/flow');
    await expect(diag).toBeVisible();
    // '/' never pulls the presenter off the stage.
    await page.keyboard.press('p');
    await expectStage(page);
    await page.keyboard.press('/');
    await page.waitForTimeout(300);
    await expectStage(page);
    expect(errors()).toEqual([]);
  });
});

// ─── The off switch and the a11y nits (P1-A09) ───────────────────────────────

/** ARIA the audit's axe pass flagged: aria-label on a generic span/div/kbd, heading jumps, landmarks inside a region. */
async function ariaProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0 && !el.closest('[aria-hidden="true"]');
    for (const el of document.querySelectorAll('span[aria-label], div[aria-label], kbd[aria-label], p[aria-label]')) {
      if (!el.getAttribute('role') && visible(el)) out.push(`aria-prohibited-attr: <${el.tagName.toLowerCase()} class="${el.className}">`);
    }
    let last = 0;
    for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if (!visible(h) || h.closest('[role="dialog"]')) continue;
      const level = Number(h.tagName[1]);
      if (last && level > last + 1) out.push(`heading-order: h${last} → h${level} "${(h.textContent ?? '').trim().slice(0, 40)}"`);
      last = level;
    }
    for (const el of document.querySelectorAll('[role="region"] main, [role="region"] header:not(main header, section header, article header, aside header, nav header)')) {
      out.push(`landmark in a region: <${el.tagName.toLowerCase()} class="${el.className}">`);
    }
    return out;
  });
}

test.describe('the single-key off switch and a11y nits (P1-A09)', () => {
  test.setTimeout(150_000);

  test('with Single-key shortcuts off, P, Y, ? and / do nothing; Escape still works; the setting persists', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/ledger');
    await expect(page.locator('main h1')).toHaveText('Ledger');
    await page.locator('main h1').click();
    await page.keyboard.press('?');
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    const toggle = sheet.getByTestId('single-key-switch');
    await expect(toggle).toHaveAttribute('data-enabled', 'true');
    if (ownsScreens()) {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `tests/report/screens/wave2-a-single-key-on-${theme}-1440.png` });
      }
      await setTheme(page, 'light');
    }
    await toggle.getByRole('switch').click();
    await expect(toggle).toHaveAttribute('data-enabled', 'false');
    await expect(toggle).toContainText('Esc still closes');
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    for (const key of ['p', 'y', '?', '/', 'Shift+D']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(250);
      expect(pathOf(page), `after ${key}`).toBe('/ledger');
      expect(param(page, 'present')).toBeNull();
      expect(param(page, 'story')).toBeNull();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByTestId('diag-panel')).toHaveCount(0);
    }
    // Saved in the workspace's settings: a reload keeps it off.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.locator('main h1')).toHaveText('Ledger');
    await page.locator('main h1').click();
    await page.keyboard.press('p');
    await page.waitForTimeout(300);
    expect(param(page, 'present')).toBeNull();
    // ⌘K / Ctrl+K is a chord, so it still opens the palette, and its switch turns the keys back on.
    await page.keyboard.press('ControlOrMeta+K');
    const palette = page.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    await palette.getByTestId('single-key-switch').getByRole('switch').click();
    await expect(palette.getByTestId('single-key-switch')).toHaveAttribute('data-enabled', 'true');
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await page.keyboard.press('p');
    await expectStage(page);
    expect(errors()).toEqual([]);
  });

  test('document.title follows the view outside Cribl; no aria-label on generic elements, no heading jumps, no landmark in a region', async ({
    page,
  }) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/');
    await expect(page.getByTestId('receipt-hero')).toBeVisible();
    const cases = [
      { path: '/', title: 'Receipt – Meter Reader', ready: () => expect(page.getByTestId('receipt-hero')).toBeVisible() },
      { path: '/flow', title: 'Flow – Meter Reader', ready: () => expect(page.locator('main h1')).toHaveText('Flow') },
      { path: '/whatif', title: 'What if – Meter Reader', ready: () => expect(page.locator('main h1')).toHaveText(/What if/) },
      { path: '/ledger', title: 'Ledger – Meter Reader', ready: () => expect(page.locator('main h1')).toHaveText('Ledger') },
      { path: '/settings', title: 'Settings – Meter Reader', ready: () => expect(page.locator('main h1')).toHaveText('Settings') },
      { path: '/?present=1', title: 'Presenter view – Meter Reader', ready: () => expect(page.locator('.mr-pv')).toBeVisible() },
      { path: '/?story=1', title: 'Story mode – Meter Reader', ready: () => expect(page.locator('.mr-story')).toBeVisible() },
    ];
    for (const c of cases) {
      await page.goto(c.path, { waitUntil: 'domcontentloaded' });
      await waitForHydration(page);
      await c.ready();
      await page.waitForTimeout(400);
      await expect.poll(() => page.title(), c.path).toBe(c.title);
      expect(await ariaProblems(page), c.path).toEqual([]);
    }
    // The Ledger's alerts rail: the count reads "2 open", never a bare aria-label.
    // The presenter root is a named region, and its hero is read out politely.
    await page.goto('/?present=1', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.getByRole('region', { name: 'Presenter view' })).toBeVisible();
    await expect(page.getByTestId('stage-announcer')).toHaveText(/^Saved by Cribl: \$[\d,]+, /, { timeout: 90_000 });
    // The footer's build line reads with a space: "v1.0.0 release", never "v1.0.0release".
    await page.goto('/ledger', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const build = page.getByTestId('footer-build');
    expect(await build.evaluate((el) => (el as HTMLElement).innerText)).toMatch(/^v\S+ · (release|demo build)$/);
    expect(await build.evaluate((el) => [...el.childNodes].filter((n) => !(n instanceof Element && n.getAttribute('aria-hidden') === 'true')).map((n) => n.textContent).join(''))).toMatch(/^v\S+ \S/);
    expect(errors()).toEqual([]);
  });
});

// ─── The palette and the lights going down (P2-W22) ──────────────────────────

test.describe('the command palette and the lights going down (P2-W22)', () => {
  test.setTimeout(150_000);

  test("⌘K opens the palette; 'wind' lists the Windows flows; Enter opens the Ledger row", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/flow?period=30d');
    await expect(page.locator('main h1')).toHaveText('Flow');
    await page.waitForFunction(() => '__MR_SHELL__' in window);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __MR_SHELL__: ShellHook }).__MR_SHELL__.store.getState().snapshot !== null), { timeout: 90_000 })
      .toBe(true);
    await page.keyboard.press('ControlOrMeta+K');
    const palette = page.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    const input = palette.getByRole('combobox', { name: 'Search pages, flows and actions' });
    await expect(input).toBeFocused();
    // Empty: the keyboard map, with its key caps.
    await expect(palette.getByRole('option', { name: /Presenter view/ })).toContainText('P');
    const width = page.viewportSize()?.width ?? 1440;
    const shoot = async (id: string) => {
      if (width >= 1600) return;
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await page.waitForTimeout(350);
        await page.screenshot({ path: `tests/report/screens/wave2-a-palette-${id}-${theme}-${width}.png` });
      }
      await setTheme(page, 'light');
    };
    await shoot('empty');
    // Single letters type inside the palette: 'p' is not the presenter view here.
    await input.pressSequentially('wind');
    expect(param(page, 'present')).toBeNull();
    const options = palette.getByRole('option');
    await expect(options.first()).toContainText('Windows');
    const labels = await options.allTextContents();
    expect(labels.slice(0, 2).every((l) => /Windows/.test(l))).toBe(true);
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await shoot('wind');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect.poll(() => pathOf(page)).toBe('/ledger');
    expect(param(page, 'object')).toMatch(/^(in|pipe):default:/);
    expect(param(page, 'period')).toBe('30d');
    expect(errors()).toEqual([]);
  });

  test('P runs a view transition into the stage; under reduced motion it is a cut', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'document.startViewTransition: Chromium');
    const errors = trackConsoleErrors(page);
    await page.addInitScript(() => {
      const w = window as unknown as { __mrVT: number };
      w.__mrVT = 0;
      const d = document as Document & { startViewTransition?: (cb: () => unknown) => unknown };
      const original = d.startViewTransition?.bind(document);
      if (original) {
        d.startViewTransition = (cb: () => unknown) => {
          w.__mrVT += 1;
          return original(cb);
        };
      }
    });
    await openPriced(page, '/');
    await expect(page.getByTestId('receipt-hero')).toBeVisible();
    await page.locator('main h1, [data-testid="receipt-hero"]').first().click();
    await page.keyboard.press('p');
    await expectStage(page);
    expect(await page.evaluate(() => (window as unknown as { __mrVT: number }).__mrVT)).toBe(1);
    await page.keyboard.press('p');
    await expect(page.getByTestId('receipt-hero')).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.keyboard.press('p');
    await expectStage(page);
    expect(await page.evaluate(() => (window as unknown as { __mrVT: number }).__mrVT)).toBe(1);
    expect(errors()).toEqual([]);
  });

  test('?story=1&stage=1: dark on a light account, full screen on the first click, the cursor hidden after 2 s', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.addInitScript(() => {
      const w = window as unknown as { __mrFs: number };
      w.__mrFs = 0;
      Element.prototype.requestFullscreen = function () {
        w.__mrFs += 1;
        return Promise.resolve();
      };
    });
    await openPriced(page, '/?story=1&stage=1');
    const booth = page.locator('.mr-shell[data-mode="story"]');
    await expect(booth).toHaveAttribute('data-booth', 'true');
    await expect(page.locator('.mr-story')).toBeVisible();
    expect(await page.evaluate(() => document.body.classList.contains('dark'))).toBe(false);
    expect(await booth.evaluate((el) => el.classList.contains('dark'))).toBe(true);
    await page.mouse.click(10, (page.viewportSize()?.height ?? 800) / 2);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __mrFs: number }).__mrFs)).toBe(1);
    await page.mouse.click(12, (page.viewportSize()?.height ?? 800) / 2);
    expect(await page.evaluate(() => (window as unknown as { __mrFs: number }).__mrFs)).toBe(1); // asked once
    await expect(page.locator('.mr-story')).toBeVisible(); // a click never ends the loop
    await expect(booth).toHaveAttribute('data-cursor', 'hidden', { timeout: 5_000 });
    await page.mouse.move(40, 40);
    await expect(booth).not.toHaveAttribute('data-cursor', 'hidden');
    const width = page.viewportSize()?.width ?? 1440;
    if (ownsScreens()) {
      for (const size of STAGE_SIZES) {
        await page.setViewportSize(size);
        await page.waitForTimeout(500);
        await page.screenshot({ path: `tests/report/screens/wave2-a-booth-light-account-${size.width === 1280 ? '1280x720' : size.width}.png` });
      }
      await page.setViewportSize({ width, height: 900 });
    }
    expect(errors()).toEqual([]);
  });
});
