// tests/e2e/money.spec.ts — WP-F (core money & detector), wave 1, on the in-browser Cribl emulator with the tab
// metering a freshly installed rig:
//   P0-23  the hero caption says how much of the month was metered; Copy receipt ends in its Basis block;
//   P1-F04 Copy receipt lists the top savers per day at current rates;
//   P1-F01 a counterfactual credited at a destination with no price is flagged, not a silent $0: the unpriced
//          notice counts it, Show the math says the credit is $0 until the target has a price, and the Prices
//          picker captions that target "(no price yet)";
//   P0-17  Settings → Budgets projects over the minutes actually metered, the same percentage as the snapshot.
//
// Screenshots: tests/report/screens/wave1-f-<shot>-<light|dark>-<width>.png from chromium (1440), chromium-1920 and
// mobile (390); firefox and webkit run the assertions only (they would overwrite the 1440 files).

import { expect, test, type Page } from '@playwright/test';
import { defaultSettings } from '../../core/settings.ts';
import { DAY_MS } from '../../core/time.ts';
import type { Snapshot } from '../../core/types.ts';
import { allowClipboard, gotoApp, kvGet, readClipboard, resetMock, screenPath, setTheme, trackConsoleErrors, waitForHydration } from './helpers/index.ts';

const TZ = 'America/Chicago';
const SIEM = 'mrd_siem_prod';
const ANALYTICS = 'mrd_analytics';
const ARCHIVE = 'mrd_archive_s3';
const BUDGET_CENTS = 1_200_000; // $12,000 a month on siem-prod

const shoots = (): boolean => ['chromium', 'chromium-1920', 'mobile'].includes(test.info().project.name);

async function putKv(page: Page, docs: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (entries) => {
    for (const [key, value] of entries) {
      const r = await fetch(`/mock-api/v1/kvstore/${key}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(value) });
      if (r.status >= 300) throw new Error(`PUT ${key} → ${r.status}`);
    }
  }, Object.entries(docs));
}

/** Screenshots never carry a stray focus ring or hover from the previous step. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.mouse.move(0, 0);
}

/**
 * A fresh install: siem-prod priced (Splunk Cloud preset) with a budget; archive-s3 priced, its data credited at
 * analytics' price ("without Cribl it would go to analytics"), and analytics never priced. The tab meters the rig.
 */
async function freshInstall(page: Page): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  const now = await page.evaluate(() => Date.now());
  const settings = defaultSettings(new Date(now).toISOString(), TZ);
  settings.budgets = { [SIEM]: { centsPerMonth: BUDGET_CENTS } };
  await putKv(page, {
    settings,
    prices: {
      schemaVersion: 1,
      updatedAt: new Date(now - 3 * DAY_MS).toISOString(),
      versions: [
        {
          effectiveFrom: new Date(now - 3 * DAY_MS).toISOString(),
          byOutputId: {
            [SIEM]: { milliCentsPerGb: 225_000, preset: 'splunk_cloud' },
            [ARCHIVE]: { milliCentsPerGb: 2_300, preset: 's3', counterfactual: { kind: 'other', outputId: ANALYTICS } },
          },
        },
      ],
    },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await expect(page.getByTestId('receipt-hero')).toBeVisible({ timeout: 45_000 });
  await expect
    .poll(async () => Number(await page.locator('[data-testid="receipt-hero"] [data-callout="saved"]').getAttribute('data-value-m')), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await page.evaluate(() => document.fonts.ready);
}

async function snapshotDoc(page: Page): Promise<Snapshot> {
  const raw = await kvGet(page, 'snapshot');
  expect(raw, 'the tab wrote a snapshot').not.toBeNull();
  return JSON.parse(raw!) as Snapshot;
}

test.describe('WP-F · money truth on a fresh install', () => {
  test.describe.configure({ timeout: 150_000 });

  test('P0-23 · the hero says how much of the month was metered; Copy receipt carries savers, basis and coverage', async ({ page, context, browserName }) => {
    const errors = trackConsoleErrors(page);
    await allowClipboard(context, browserName);
    await freshInstall(page);
    // Metering for under a day, the Receipt opens on the annualized run rate (P1-H08); ask for month to date.
    await page.goto('/?period=mtd', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);

    const caption = page.getByTestId('hero-caption');
    // A day-26 install metered minutes, not the month: the caption says so, and never rounds a sliver to 0 % or 100 %.
    await expect(caption).toHaveText(/^month to date · collecting since .+ · [\d,]+ of [\d,]+ minutes metered \((under 1%|[1-9]\d?%)\)$/);
    const snap = await snapshotDoc(page);
    expect(snap.headline.minutesMtd).toBeGreaterThan(0);
    expect(snap.headline.expectedMinutesMtd).toBeGreaterThan(snap.headline.minutesMtd!);

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await blur(page);
      if (shoots()) {
        await page.getByTestId('receipt-hero').screenshot({ path: screenPath('wave1-f-hero-coverage', theme, page) });
        await page.screenshot({ path: screenPath('wave1-f-receipt', theme, page), fullPage: true });
      }
    }

    await page.getByRole('button', { name: 'Copy receipt' }).click();
    await expect(page.getByText('Receipt copied.')).toBeVisible();
    const text = await readClipboard(page);
    const lines = text.split('\n');
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(48);
    // P1-F04: the savers at their current rates, headed and suffixed so nobody sums them into the total.
    expect(text).toContain('Top savers, per day at current rates');
    expect(lines.some((l) => / \.{4,} +\$[\d,]+\/day$/.test(l))).toBe(true);
    expect(text).not.toMatch(/… \.\.(?!\.)/);
    // P0-23: the Basis block.
    const basis = lines.slice(lines.indexOf('Basis') + 1);
    expect(lines).toContain('Basis');
    expect(basis.join('\n')).toMatch(/SIEM \(prod\): \$2\.25\/GB,\s+Splunk Cloud\s+typical\s+list/i);
    expect(basis.join('\n')).toMatch(/credited \$0 until\s+analytics has a price/i);
    expect(basis.join('\n')).toMatch(/Metered [\d,]+ of [\d,]+ minutes \((under 1%|\d+%)\)/);

    expect(errors()).toEqual([]);
  });

  test('P1-F01 · a counterfactual to an unpriced destination is flagged, explained and captioned', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await freshInstall(page);

    // archive-s3 pays its own price but is credited at analytics' price, and analytics has none: the Receipt's
    // unpriced notice counts it (the emulator's rig outputs are all DevNull; analytics, a DevNull standing in for
    // a paid destination, has no price of its own either — P0-04).
    const snap = await snapshotDoc(page);
    const archive = snap.destinations.find((d) => d.outputId === ARCHIVE)!;
    expect(archive).toMatchObject({ unpriced: true, counterfactualUnpriced: true });
    expect(archive.milliCentsPerGb).toBe(2_300); // it still pays its own price
    expect(snap.unpricedOutputIds).toContain(ARCHIVE);
    await expect(page.getByTestId('unpriced-notice')).toContainText(`${snap.unpricedOutputIds.length} destination`);

    await page.locator('.mr-hero-actions').getByRole('button', { name: 'Show the math' }).click();
    const drawer = page.getByTestId('math-drawer');
    await expect(drawer).toContainText(/analytics has no price yet, so this data is credited \$0 until it has one\. What it pays here still counts\./i);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await blur(page);
      const item = drawer.locator('.mr-math-dest--unpriced').filter({ hasText: /has no price yet/ });
      await item.scrollIntoViewIfNeeded();
      if (shoots()) await page.screenshot({ path: screenPath('wave1-f-math-cf-unpriced', theme, page) });
    }
    await page.keyboard.press('Escape');

    await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const row = page.getByTestId(`price-row-${ARCHIVE}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    // The archive row is priced itself: it reads priced (its picker is where the missing price shows).
    await expect(row.locator('[data-chip="unpriced"], .mr-pt-unpriced')).toHaveCount(0);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await row.getByRole('button', { name: /Without Cribl this data would go to/ }).click();
      const option = page.getByRole('option', { name: /analytics \(no price yet\)/i });
      await expect(option).toBeVisible();
      await expect(page.getByRole('option', { name: /SIEM \(prod\)$/i })).toBeVisible();
      if (shoots()) await page.screenshot({ path: screenPath('wave1-f-prices-picker', theme, page) });
      await page.keyboard.press('Escape');
      await expect(option).toBeHidden();
    }
    expect(errors()).toEqual([]);
  });

  test('P0-17 · Settings → Budgets projects over the minutes metered, the same percentage as the snapshot', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await freshInstall(page);
    const snap = await snapshotDoc(page);
    const siem = snap.destinations.find((d) => d.outputId === SIEM)!;
    expect(siem.mtdMinutes).toBeGreaterThan(0);
    expect(siem.budget).toBeDefined();
    // The projection divides by the minutes metered, not the ~25 days since the 1st: paid ÷ minutes × month.
    const monthMin = siem.mtdMinutes! > 0 ? siem.budget!.projectedM / (siem.mtdPaidM / siem.mtdMinutes!) : 0;
    expect(monthMin).toBeGreaterThanOrEqual(28 * 1440 - 1);
    expect(monthMin).toBeLessThanOrEqual(31 * 1440 + 1);

    await page.goto('/settings?section=budgets', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const row = page.getByTestId(`budget-row-${SIEM}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    const meter = row.getByRole('meter');
    await expect(meter).toHaveAttribute('aria-valuenow', String(Math.round(siem.budget!.pct)));
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await blur(page);
      await row.scrollIntoViewIfNeeded();
      if (shoots()) await page.screenshot({ path: screenPath('wave1-f-budgets', theme, page) });
    }
    expect(errors()).toEqual([]);
  });
});
