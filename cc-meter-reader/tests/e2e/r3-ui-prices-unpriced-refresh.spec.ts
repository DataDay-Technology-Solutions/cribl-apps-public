// r3 ui-3 (FINDINGS_R3 #8, the judge's first-run path): a never-priced Prices page said "New destinations appear within
// a few minutes · Sweep now to check" with no Sweep now anywhere on the page (the header's is off until prices exist),
// and its destination list never refreshed: the inventory read was keyed on the last sweep, and the tab does not sweep
// before the first prices are saved (REVIEW-3a #3). Eight destinations added under the open page stayed invisible for
// 15 minutes (5 rows; 13 after a reload).
// Now, while never priced, the caption carries no Sweep now ("New destinations appear here within a minute") and the
// Leader inventory is re-read about every 60 s and when the window gains focus. The priced caption (r2 IC-6) stays.
// Probe: app-assurance r3/0/probes/zz-r3f0-newdest.spec.ts (P5-firstrun-prices-*.txt), OUT/skeptic/r3-ic6-firstrun-caption.md.

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, mockControl, resetMock, seedPrices, waitForHydration } from './helpers/index.ts';

/** The price table's rows, its header row included (the probe's count: 5 before, 13 after). */
const rows = (page: Page) => page.locator('section[data-section="prices"] [role="row"]');
const caption = (page: Page) => page.getByTestId('prices-new-destinations');

async function firstRunPrices(page: Page): Promise<void> {
  await page.clock.install({ time: new Date('2026-09-28T23:10:00Z') });
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await expect(page.getByRole('button', { name: /^Use suggested prices/ })).toBeVisible({ timeout: 40_000 });
  await expect(rows(page)).toHaveCount(5);
}

/** The emulated org gains eight destinations under the open page (its KV kept: still never priced). */
async function growWorld(page: Page): Promise<void> {
  await mockControl(page, { action: 'reset', preset: 'scale', flows: 40, keepKv: true });
}

test.describe('a never-priced Prices page', () => {
  test('never mentions Sweep now while no Sweep now button is on the page', async ({ page }) => {
    await firstRunPrices(page);
    await expect(page.getByRole('button', { name: 'Sweep now' })).toHaveCount(0);
    await expect(caption(page)).toBeVisible();
    await expect(caption(page)).toHaveText('New destinations appear here within a minute');
    await expect(page.locator('main')).not.toContainText('Sweep now');
  });

  test('shows destinations added under the open page within the interval, without a reload', async ({ page }) => {
    test.setTimeout(120_000);
    await firstRunPrices(page);
    await growWorld(page);
    await page.clock.fastForward(61_000);
    await expect(rows(page)).toHaveCount(13, { timeout: 15_000 });
  });

  test('re-reads the destinations when the window gains focus', async ({ page }) => {
    test.setTimeout(120_000);
    await firstRunPrices(page);
    await growWorld(page);
    // Well inside the interval: only the focus can bring them.
    await page.clock.fastForward(5_000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(rows(page)).toHaveCount(13, { timeout: 15_000 });
  });
});

test('a priced Prices page keeps the IC-6 caption (Sweep now is in the header)', async ({ page }) => {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await seedPrices(page);
  await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await expect(caption(page)).toHaveText('New destinations appear within a few minutes · Sweep now to check', { timeout: 40_000 });
});
