// tests/e2e/labels.spec.ts — every percentage names its basis, and the other labels from the owner's critique
// (STATE.md, 9/26 4:12 PM), on the in-browser Cribl emulator with the demo rig a week of sweeps produces
// (tests/e2e/ledger-fixture.ts: prices with presets, three destinations that carry money, savers, an open alert):
//   • Receipt: the hero keeps "30% saved" — its hover and Show the math say "of dollars, month to date";
//     "Where the money goes" rows say "priced as Splunk Cloud" in place of the output type; "What's saving the
//     most" counts what it shows ("Top 3 by savings per day, at current rates");
//   • Flow: the receipt card reads "… saved at current rates" and "Paying now $… / hour"; the legend says the
//     wedge is dollars at current rates;
//   • Ledger: the column is "Volume reduced" and every figure's hover says it is bytes, not dollars.
// Screenshots (the chromium project only, which sets both widths itself so the DPR-3 mobile project never
// overwrites a -390 file): tests/report/screens/labels-{receipt,receipt-math,flow,ledger}-{light,dark}-{1440,390}.png.

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, screenPath, setTheme, trackConsoleErrors, waitForHydration, waitForMock, type Theme } from './helpers/index.ts';
import { injectLedgerDocs, loadDemoFixture, type LedgerDocs } from './ledger-fixture.ts';

let fixture: LedgerDocs;

test.beforeAll(async () => {
  fixture = loadDemoFixture();
});

const THEMES: Theme[] = ['light', 'dark'];
const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

/** Boots the emulator, stores the fixture in its KV and opens `path` on it. */
async function openOnFixture(page: Page, path: string): Promise<void> {
  await gotoApp(page, path);
  await injectLedgerDocs(page, fixture);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForMock(page);
  await waitForHydration(page);
}

/** Screenshots never carry a stray focus ring or a hover from the previous step. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.mouse.move(0, 0);
}

async function shoot(page: Page, id: string, theme: Theme): Promise<void> {
  await blur(page);
  await page.waitForTimeout(350);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontal overflow on ${id} at ${page.viewportSize()?.width}`).toBeLessThanOrEqual(0);
  await page.screenshot({ path: screenPath(id, theme, page), fullPage: true });
}

// The fixture's prices came from presets, so the priced destinations that carry money read "priced as …".
const PRESET_ROWS: Record<string, string> = { mrd_siem_prod: 'Splunk Cloud', mrd_analytics: 'Datadog Logs', mrd_archive_s3: 'Amazon S3' };

test.describe('Labels: every percentage names its basis', () => {
  test('Receipt: the hero says "of dollars, month to date" on hover and in Show the math; rows say "priced as"; the caption counts', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openOnFixture(page, '/');
    const hero = page.getByTestId('receipt-hero');
    await expect(hero).toBeVisible();
    await expect(page.getByTestId('hero-caption')).toContainText('month to date');

    // The visible figure is unchanged; the basis is the hover and a visually hidden suffix.
    const pct = hero.getByTestId('receipt-saved-pct');
    await expect(pct).toHaveAttribute('title', 'of dollars, month to date');
    await expect(pct.locator('.mr-rbar-amount')).toHaveText(/^\d+% saved$/);
    await expect(pct).toHaveText(/^\d+% saved of dollars, month to date$/);
    const shown = (await pct.locator('.mr-rbar-amount').textContent())?.match(/^(\d+%) saved$/)?.[1];
    expect(shown).toBeTruthy();

    // What's saving the most: "Top N" is the number of lines listed (only flows with savings, up to five).
    const savers = page.getByTestId('receipt-top-savers');
    const lines = savers.getByRole('list', { name: 'Top savers' }).getByRole('listitem');
    const n = await lines.count();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(5);
    await expect(savers.locator('.mr-receipt-card-caption')).toHaveText(`Top ${n} by savings per day, at current rates`);
    await expect(savers).not.toContainText('Top five');
    // Both Windows routes run the XML pack: each line says which ("Windows DC security events · Windows XML pack"),
    // never the same words twice with nothing to tell the two apart.
    const saverLabels = await lines.locator('.mr-rlist-label').allTextContents();
    expect(new Set(saverLabels).size).toBe(saverLabels.length);
    expect(saverLabels.filter((l) => l.endsWith('· Windows XML pack')).length).toBe(2);
    // Each line's tooltip is its saved share in dollars, never "reduced".
    const titles = await savers.getByRole('list', { name: 'Top savers' }).locator('[title]').evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''));
    expect(titles).toHaveLength(n);
    for (const title of titles) expect(title).toMatch(/ · \d+% saved at current rates$/);

    // Where the money goes: a preset-priced destination says so instead of its output type.
    const money = page.getByTestId('receipt-destinations');
    for (const [outputId, preset] of Object.entries(PRESET_ROWS)) {
      const row = money.locator(`.mr-wmg-row:has(.mr-wmg-name[title="${outputId}"])`);
      await expect(row.locator('.mr-wmg-type')).toHaveText(`priced as ${preset}`);
      await expect(row.locator('.mr-wmg-type')).toHaveAttribute('data-basis', 'preset');
      await expect(row).toContainText('/ GB');
    }
    // An unpriced destination (no entry, so no preset) keeps its output type.
    const unpriced = money.locator('.mr-wmg-row[data-unpriced="true"]');
    for (const row of await unpriced.all()) await expect(row.locator('.mr-wmg-type')).toHaveAttribute('data-basis', 'type');
    await expect(money).not.toContainText('devnull ·');

    // Show the math: the same basis, in the same words, and why the Ledger's and the Flow map's figures differ.
    await page.locator('.mr-hero-actions').getByRole('button', { name: 'Show the math' }).click();
    const math = page.getByTestId('math-drawer');
    await math.waitFor();
    await expect(math.getByTestId('math-ratio-basis')).toHaveText(
      `${shown} is a share of dollars, month to date. The Ledger's volume reduced is a share of bytes, and the Flow map prices one day at current rates.`,
    );
    // The math's own ratio line agrees with the hero's figure.
    await expect(math).toContainText(`= ${shown}`);
    await page.keyboard.press('Escape');
    await math.waitFor({ state: 'detached' });
    expect(errors()).toEqual([]);
  });

  test('Receipt: the basis follows the period (today, 30 days, annualized)', async ({ page }) => {
    await openOnFixture(page, '/?period=today');
    await expect(page.getByTestId('receipt-hero').getByTestId('receipt-saved-pct')).toHaveAttribute('title', 'of dollars, today');
    await page.goto('/?period=30d', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.getByTestId('receipt-hero').getByTestId('receipt-saved-pct')).toHaveAttribute('title', 'of dollars, last 30 days');
    await page.goto('/?period=annualized', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const pct = page.getByTestId('receipt-hero').getByTestId('receipt-saved-pct');
    await expect(pct).toHaveAttribute('title', /^of dollars, annualized run rate/);
    // The hover and Show the math name the identical period.
    const basis = (await pct.getAttribute('title'))?.replace(/^of dollars, /, '');
    await page.locator('.mr-hero-actions').getByRole('button', { name: 'Show the math' }).click();
    await expect(page.getByTestId('math-ratio-basis')).toContainText(`is a share of dollars, ${basis}.`);
  });

  test('Flow: the receipt card reads "saved at current rates" and "Paying now"; the legend names the basis', async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page);
    await openOnFixture(page, '/flow');
    const card = page.getByTestId('flow-receipt');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('.mr-receipt-foot')).toContainText(/^\d+% saved at current rates/);
    await expect(card.locator('.mr-receipt-foot')).not.toContainText('of would-have-paid');
    await expect(card.getByTestId('receipt-now').locator('dt')).toHaveText('Paying now');
    await expect(card.getByTestId('receipt-now')).toContainText('/ hour');
    // The accessible summary carries the verb too ("Paying now $… / hour, 1.0× baseline"), never a bare "Now $".
    const summary = (await card.getAttribute('aria-label')) ?? '';
    expect(summary).toMatch(/Paying now \$[\d,]+ \/ hour, [\d.]+× baseline/);
    expect(summary).not.toMatch(/\bNow \$/);
    // The legend under the map (and under the phone's list) names the basis, and its lines balance rather than
    // leaving "GB)" alone on a line at 390.
    const legend = page.locator('.mr-flowmap-legend');
    // A phone's legend is the two shapes in a line each (P1-I05); the receipt card above it names the basis.
    await expect(legend).toContainText(isMobile ? 'Hatched is saved' : 'Removed by the pipeline, saved at current rates');
    for (const item of await legend.locator('li').all()) {
      expect(await item.evaluate((el) => getComputedStyle(el).textWrap)).toBe('balance');
      const lines = await item.evaluate((el) => {
        // The words alone (the swatch beside them sits at another height and is not a line).
        const words = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
        if (!words) return [];
        const range = document.createRange();
        range.selectNode(words);
        const rows = new Set<number>();
        for (const r of range.getClientRects()) if (r.width > 0) rows.add(Math.round(r.top));
        return [...rows].sort((a, b) => a - b).map((top) => {
          const parts = [...range.getClientRects()].filter((r) => r.width > 0 && Math.round(r.top) === top);
          return Math.max(...parts.map((r) => r.right)) - Math.min(...parts.map((r) => r.left));
        });
      });
      // No orphan: on a wrapped item the last line is at least a third as long as the longest.
      if (lines.length > 1) expect(lines[lines.length - 1]).toBeGreaterThan(Math.max(...lines) / 3);
    }
    expect(errors()).toEqual([]);
  });

  test('Ledger: the column is "Volume reduced" and every figure says it is bytes, not dollars', async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page);
    await openOnFixture(page, '/ledger');
    const table = page.getByTestId('ledger-scroll');
    await expect(table.locator('[role="row"][data-row-id]').first()).toBeVisible();
    if (isMobile) {
      // Cards: "Volume reduced 29%", the figure with the hint.
      const card = table.locator('.mr-lt-card-reduction').first();
      await expect(card.locator('.mr-lt-card-caption')).toHaveText('Volume reduced');
      await expect(card.locator('.mr-figure')).toHaveAttribute('title', /^\d+% less volume: bytes out against bytes in, not dollars$/);
    } else {
      const headers = page.locator('[role="columnheader"]');
      await expect(headers.filter({ hasText: 'Volume reduced' })).toHaveCount(1);
      await expect(headers.filter({ hasText: /^Reduction$/ })).toHaveCount(0);
      // The totals row and every listed flow that received bytes carry the hint, with the row's own figure in it.
      const totals = page.locator('.mr-lt-totals .mr-figure[title]');
      await expect(totals).toHaveCount(1);
      const totalsHint = (await totals.getAttribute('title')) ?? '';
      const totalsPct = (await totals.textContent())?.trim();
      expect(totalsHint).toBe(`${totalsPct} less volume: bytes out against bytes in, not dollars`);
      const rowHints = await table.locator('[role="row"][data-row-id] .mr-figure[title]').evaluateAll((els) => els.map((el) => [el.getAttribute('title') ?? '', el.textContent?.trim() ?? '']));
      expect(rowHints.length).toBeGreaterThanOrEqual(2);
      for (const [hint, pct] of rowHints) expect(hint).toBe(`${pct} less volume: bytes out against bytes in, not dollars`);
    }
    expect(errors()).toEqual([]);
  });
});

test.describe('Labels: screenshots', () => {
  for (const theme of THEMES) {
    test(`Receipt, Flow and Ledger in ${theme} at 1440 and 390`, async ({ page }, info) => {
      test.skip(info.project.name !== 'chromium', 'the fixed-name files are shot once, from the chromium project (it sets every width itself)');
      test.setTimeout(180_000);
      const errors = trackConsoleErrors(page);

      await openOnFixture(page, '/');
      await setTheme(page, theme);
      await expect(page.getByTestId('receipt-hero').getByTestId('receipt-saved-pct')).toHaveAttribute('title', 'of dollars, month to date');
      for (const size of WIDTHS) {
        await page.setViewportSize(size);
        await shoot(page, 'labels-receipt', theme);
      }
      // Show the math at 1440, scrolled to the basis line under the ratio.
      await page.setViewportSize(WIDTHS[0]);
      await page.locator('.mr-hero-actions').getByRole('button', { name: 'Show the math' }).click();
      const math = page.getByTestId('math-drawer');
      await math.waitFor();
      await math.getByTestId('math-ratio-basis').scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.screenshot({ path: screenPath('labels-receipt-math', theme, page) });
      await page.keyboard.press('Escape');
      await math.waitFor({ state: 'detached' });

      await page.goto('/flow', { waitUntil: 'domcontentloaded' });
      await waitForHydration(page);
      await setTheme(page, theme);
      await expect(page.getByTestId('flow-receipt')).toBeVisible({ timeout: 30_000 });
      for (const size of WIDTHS) {
        await page.setViewportSize(size);
        await shoot(page, 'labels-flow', theme);
      }

      await page.goto('/ledger', { waitUntil: 'domcontentloaded' });
      await waitForHydration(page);
      await setTheme(page, theme);
      await expect(page.getByTestId('ledger-scroll').locator('[role="row"][data-row-id]').first()).toBeVisible();
      for (const size of WIDTHS) {
        await page.setViewportSize(size);
        await page.evaluate(() => window.scrollTo(0, 0));
        await shoot(page, 'labels-ledger', theme);
      }
      expect(errors()).toEqual([]);
    });
  }
});
