// tests/e2e/wave3-ledgershell.spec.ts — wave 3, package ledgershell.
//
//   W3-LS-1  Settings is one route: hopping Prices (/settings/prices) → Alerts (/settings?section=alerts) → Prices
//            keeps the unsaved price and its dirty marker (P1-G07); every deep link still opens its section, and
//            Back / Forward walk the sections.
//   W3-LS-2  The tour's Ledger at 1440 and 1920, both themes: no name cell is cut short (no painted ellipsis, no
//            clipped line), a route named like its source is printed once, and 1920 uses the Ledger's wide frame.
//
// Run: npx playwright test tests/e2e/wave3-ledgershell.spec.ts --project=chromium --project=chromium-1920
// (the Settings deep link to /settings/demo runs only against a demo build: VITE_MR_BUILD=demo).

import { expect, test, type Locator, type Page } from '@playwright/test';
import { gotoApp, resetMock, setTheme, trackConsoleErrors } from './helpers/index.ts';

const SCREENS = 'tests/report/screens';
const ALLOW = [/Outdated Optimize Dep/, /Failed to load resource: the server responded with a status of 40[34]/];
const SIEM = 'mrd_siem_prod';

const card = (page: Page, section: string): Locator => page.locator(`section[data-section="${section}"]`);
const saveBar = (page: Page, section: string): Locator => card(page, section).locator('.mr-set-savebar');
const priceInput = (page: Page, id: string): Locator => page.getByTestId(`price-input-${id}`);
const path = (page: Page): string => {
  const u = new URL(page.url());
  return `${u.pathname}${u.search}`;
};

/** Opens a section from the rail (desktop) or the section picker (phones). */
async function openSection(page: Page, label: string, section: string): Promise<void> {
  const link = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: new RegExp(`^${label}`) });
  if (await link.isVisible()) await link.click();
  else {
    await page.getByRole('button', { name: /Section/ }).click();
    await page.getByRole('option', { name: new RegExp(`^${label}`) }).click();
  }
  await expect(card(page, section)).toBeVisible();
}

test.describe('W3-LS-1: Settings keeps unsaved prices across sections', () => {
  test('a typed $/GB survives Prices → Alerts → Prices through the rail, and Back / Forward', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings/prices');
    const input = priceInput(page, SIEM);
    await expect(input).toBeVisible({ timeout: 40_000 });
    await input.fill('2.75');
    await expect(saveBar(page, 'prices')).toContainText('1 unsaved change');
    await expect(saveBar(page, 'prices')).toHaveAttribute('data-dirty', 'true');
    // A marker the test can find again after the hop: the view (and its draft) must be the same one.
    await page.evaluate(() => document.querySelector('.mr-settings')?.setAttribute('data-w3-probe', 'kept'));

    await openSection(page, 'Alerts', 'alerts');
    expect(path(page)).toBe('/settings?section=alerts');
    // The dirty Prices section stays mounted (hidden) and the rail says so.
    await expect(page.getByTestId('nav-dirty-prices').first()).toBeAttached();

    await openSection(page, 'Prices', 'prices');
    expect(path(page)).toBe('/settings/prices');
    await expect(priceInput(page, SIEM)).toHaveValue('2.75');
    await expect(saveBar(page, 'prices')).toContainText('1 unsaved change');
    await expect(saveBar(page, 'prices')).toHaveAttribute('data-dirty', 'true');
    await expect(page.getByTestId('nav-dirty-prices').first()).toBeAttached();
    // The same Settings view all along (no remount on the hop).
    await expect(page.locator('.mr-settings')).toHaveAttribute('data-w3-probe', 'kept');

    // Back returns to the previous section, and the draft is still there when Forward brings Prices back.
    await page.goBack();
    await expect(card(page, 'alerts')).toBeVisible();
    expect(path(page)).toBe('/settings?section=alerts');
    await page.goBack();
    await expect(card(page, 'prices')).toBeVisible();
    expect(path(page)).toBe('/settings/prices');
    await expect(priceInput(page, SIEM)).toHaveValue('2.75');
    await page.goForward();
    await expect(card(page, 'alerts')).toBeVisible();
    await page.goForward();
    await expect(priceInput(page, SIEM)).toHaveValue('2.75');
    await expect(page.locator('.mr-settings')).toHaveAttribute('data-w3-probe', 'kept');
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      const width = page.viewportSize()?.width ?? 0;
      await page.screenshot({ path: `${SCREENS}/wave3-ledgershell-settings-kept-${theme}-${width}.png` });
    }
    expect(errors()).toEqual([]);
  });

  test('every deep link still opens its section; an unknown sub-path goes home', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings/prices');
    await expect(card(page, 'prices')).toBeVisible({ timeout: 40_000 });
    await expect(page.locator('.mr-settings')).toHaveAttribute('data-section', 'prices');

    await gotoApp(page, '/settings/notifications');
    await expect(card(page, 'notifications')).toBeVisible({ timeout: 40_000 });
    await expect(page.locator('.mr-settings')).toHaveAttribute('data-section', 'notifications');

    await gotoApp(page, '/settings?section=alerts');
    await expect(card(page, 'alerts')).toBeVisible({ timeout: 40_000 });

    await gotoApp(page, '/settings');
    await expect(card(page, 'prices')).toBeVisible({ timeout: 40_000 });

    // Anything else under /settings/ goes home, as it did when each section path had a route of its own.
    await page.goto('/settings/no-such-section', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => new URL(page.url()).pathname).not.toMatch(/^\/settings/);
    expect(errors()).toEqual([]);
  });

  test('demo build: /settings/demo opens the Demo section', async ({ page }) => {
    test.skip(process.env.VITE_MR_BUILD !== 'demo', 'the Demo section exists in the demo build only');
    await gotoApp(page, '/settings/demo');
    await expect(page.locator('.mr-settings')).toHaveAttribute('data-section', 'demo', { timeout: 40_000 });
  });
});

// ─── W3-LS-2: the tour's Ledger reads whole ──────────────────────────────────

const ROWS = '[data-testid="ledger-scroll"] [role="row"][data-row-id]';

/** Opens the sample tour on the Ledger, on a fresh emulator, and waits for its rows. */
async function openTourLedger(page: Page): Promise<void> {
  await gotoApp(page, '/');
  await resetMock(page);
  await gotoApp(page, '/ledger?tour=1');
  await page.locator('[data-callout="sample-band"]').waitFor({ timeout: 30_000 });
  await expect(page.locator(ROWS).first()).toBeVisible({ timeout: 30_000 });
}

interface NameCheck {
  /** names cut short: an ellipsis painted or typed, a clipped line, or a cell that overflows its box */
  clipped: string[];
  /** rows that print their Source again under Route */
  repeated: string[];
  /** rows whose Source spans the Route column (the route is named like its source) */
  folded: number;
  names: number;
}

/** Every rendered row's name cells (rows are virtualized: the caller scrolls and asks again). */
function checkNames(page: Page): Promise<NameCheck> {
  return page.locator(ROWS).evaluateAll((rows) => {
    const routeColumn = (document.querySelector('.mr-lt')?.getAttribute('data-columns') ?? '').split(',').includes('route');
    const out = { clipped: [] as string[], repeated: [] as string[], folded: 0, names: 0 };
    for (const row of rows) {
      const names = [...row.querySelectorAll<HTMLElement>('.mr-lt-td .mr-lt-name')];
      for (const el of names) {
        out.names += 1;
        const text = el.textContent ?? '';
        const box = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const laid = range.getBoundingClientRect();
        const cell = el.closest<HTMLElement>('.mr-lt-td');
        // A clamped third line: the text's laid-out height passes the box by a line (the glyphs' own ascent and
        // descent overhang the tight leading by about a pixel, so the height check allows half a line).
        const halfLine = parseFloat(getComputedStyle(el).lineHeight) / 2 || 9;
        const overflows =
          laid.width > box.width + 0.5 ||
          laid.height > box.height + halfLine ||
          el.scrollWidth > el.clientWidth ||
          el.scrollHeight > el.clientHeight + 1 ||
          (cell !== null && cell.scrollWidth > cell.clientWidth);
        if (overflows || text.endsWith('…')) out.clipped.push(text);
      }
      // With the Route column on, an unfolded row's first two names are its Source and its Route.
      if (row.querySelector('[data-folds="route"]')) out.folded += 1;
      else if (routeColumn) {
        const [source, route] = names.map((el) => el.textContent ?? '');
        if (source && source === route) out.repeated.push(source);
      }
    }
    return out;
  });
}

test.describe('W3-LS-2: the tour Ledger never truncates a name', () => {
  test('at 1440 and 1920, both themes: every name reads whole, a route named like its source prints once, 1920 uses the wide frame', async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    const width = page.viewportSize()?.width ?? 0;
    await openTourLedger(page);
    const table = page.locator('.mr-lt');
    if (isMobile) {
      // Phones keep their cards (the existing ledger.spec layout tests cover them): the evidence shots only.
      await expect(table).toHaveAttribute('data-layout', 'narrow');
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.locator('.mr-ledger-flows').screenshot({ path: `${SCREENS}/wave3-ledgershell-ledger-${theme}-${width}.png` });
      }
      return;
    }
    await expect(table).toHaveAttribute('data-layout', 'wide');
    // The tour's routes are named unlike their sources on some rows, so the Route column shows...
    await expect(table).toHaveAttribute('data-columns', /^source,route,pipeline,destination,/);
    const flowsCard = await page.locator('.mr-ledger-flows').boundingBox();
    if (!flowsCard) throw new Error('no flows card');
    if (width >= 1600) expect(flowsCard.width).toBeGreaterThanOrEqual(1400);

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.getByTestId('ledger-scroll').evaluate((el) => el.scrollTo({ top: 0 }));
      await page.waitForTimeout(150);
      const top = await checkNames(page);
      expect(top.names).toBeGreaterThan(10);
      expect(top.clipped, `${theme} ${width}: names cut short`).toEqual([]);
      // ...and a route named like its source is not printed twice: its Source cell spans the Route column.
      expect(top.repeated, `${theme} ${width}: a name printed twice`).toEqual([]);
      expect(top.folded).toBeGreaterThan(0);
      await page.locator('.mr-ledger-flows').screenshot({ path: `${SCREENS}/wave3-ledgershell-ledger-${theme}-${width}.png` });

      // The virtualized rows further down read whole too.
      const scroll = page.getByTestId('ledger-scroll');
      for (let step = 0; step < 12; step += 1) {
        const done = await scroll.evaluate((el) => {
          el.scrollBy({ top: el.clientHeight * 0.8 });
          return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
        });
        await page.waitForTimeout(100);
        const more = await checkNames(page);
        expect(more.clipped, `${theme} ${width}: names cut short after scrolling`).toEqual([]);
        expect(more.repeated).toEqual([]);
        if (done) break;
      }
      await scroll.evaluate((el) => el.scrollTo({ top: 0 }));
    }
    expect(errors()).toEqual([]);
  });
});
