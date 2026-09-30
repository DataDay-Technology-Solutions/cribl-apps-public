// r2 ui-12 (FINDINGS_EXTRA BO-12): the tour's Net after Cribl read at three wall-clock instants (+0, +3, +20 min) on month
// to date is one figure, as its savings are (it was $392,889 → $392,872 → $392,775). Promoted from app-assurance's
// skeptic1-tour-net scratch spec; the tour opens on Annualized since r1 (D71), so month to date is chosen in the URL.

import { expect, test } from '@playwright/test';
import { gotoApp, resetMock } from './helpers/index.ts';

const BASE = Date.parse('2026-09-28T14:00:00Z');

async function tourNetAt(page: import('@playwright/test').Page, offMin: number): Promise<{ saved: string; net: string }> {
  await page.clock.install({ time: BASE + offMin * 60_000 });
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await gotoApp(page, '/first-run');
  await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mr-tour', 'running');
  await page.getByRole('radio', { name: 'MTD' }).click();
  await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'mtd');
  const net = page.getByTestId('receipt-net');
  await expect(net).toBeVisible();
  return {
    saved: (await page.locator('[data-testid="receipt-hero"] [data-callout="saved"]').getAttribute('data-value-m')) ?? '',
    net: (await net.locator('.mr-rbar-net-main').innerText()).replace(/\s+/g, ' ').trim(),
  };
}

test('the tour\'s month-to-date Net after Cribl is one figure at +0, +3 and +20 minutes', async ({ browser }) => {
  test.setTimeout(180_000);
  const reads: { saved: string; net: string }[] = [];
  for (const off of [0, 3, 20]) {
    const context = await browser.newContext({ timezoneId: 'America/Chicago', locale: 'en-US', serviceWorkers: 'allow', viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      reads.push(await tourNetAt(page, off));
    } finally {
      await context.close();
    }
  }
  expect(reads[0].net).toMatch(/^Net after Cribl \$[\d,]+$/);
  expect(new Set(reads.map((r) => r.net)).size, JSON.stringify(reads)).toBe(1);
});
