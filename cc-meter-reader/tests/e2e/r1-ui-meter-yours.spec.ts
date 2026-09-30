// r1 ui-11, FOUNDER_PLAN row 12 (C11): "See your own number" at the tour's end, into pre-filled Prices.
//   • Once the tour has played to its end, the SAMPLE DATA band offers a primary "See your own number" (never before
//     the end); "Clear sample data" stays.
//   • Pressing it clears the sample and opens Prices without ?tour: the suggested prices filled with their toast and
//     "Archive-only data? Choose Nowhere.", nothing saved until Start the meter, and the tour never restarts.
//   • Prices opened any other way is untouched (the G5-prices frames): no fill, no hint.

import { expect, test } from '@playwright/test';
import { gotoApp, kvGet, resetMock, trackConsoleErrors, waitForHydration } from './helpers/index.ts';

test('the finished tour offers "See your own number": Prices filled, unsaved, and the tour never restarts', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackConsoleErrors(page);
  await page.clock.install();
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await gotoApp(page, '/first-run');
  await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
  const band = page.locator('[data-callout="sample-band"]');
  await expect(band).toBeVisible();
  // Not before the end.
  await expect(band.getByRole('button', { name: 'See your own number' })).toHaveCount(0);

  // Play the tour to its end (150 s of script).
  await page.clock.fastForward(160_000);
  await expect(page.locator('html')).toHaveAttribute('data-mr-tour', 'finished', { timeout: 15_000 });
  const see = band.getByRole('button', { name: 'See your own number' });
  await expect(see).toBeVisible();
  await expect(band.getByRole('button', { name: 'Clear sample data' })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).first().click({ timeout: 2_000 }).catch(() => undefined);

  await see.click();
  await expect(page).toHaveURL(/\/settings\/prices$/);
  await expect(band).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-mr-tour', /.*/);
  // Filled, with the toast and the hint; nothing written.
  await expect(page.getByText(/^Filled \d+ suggested prices?\. Review/).first()).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('prices-archive-hint')).toHaveText('Archive-only data? Choose Nowhere.');
  const prices = page.locator('section[data-section="prices"]');
  await expect(prices.locator('.mr-set-savebar')).toContainText(/\d+ unsaved changes?/);
  await expect(prices.getByRole('button', { name: 'Start the meter' })).toBeEnabled();
  expect(await kvGet(page, 'prices')).toBeNull();
  // The tour does not come back.
  await page.clock.fastForward(5_000);
  await expect(page.locator('html')).not.toHaveAttribute('data-mr-tour', /.*/);
  expect(new URL(page.url()).searchParams.get('tour')).toBeNull();
  expect(errors()).toEqual([]);
});

test('Prices on any other path is untouched: no fill, no hint', async ({ page }) => {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await expect(page.getByRole('button', { name: /^Use suggested prices/ })).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('prices-archive-hint')).toHaveCount(0);
  await expect(page.locator('section[data-section="prices"] .mr-set-savebar')).not.toContainText(/unsaved change/);
});
