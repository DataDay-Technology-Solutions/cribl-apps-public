// r2 ui-6 (FINDINGS_EXTRA IC-3, major): "Clear sample data" (and any tour exit) closes every toast and dialog the tour
// raised, so nothing of the sample remains over the first-run card (CLEAN_INSTALL_TEST 3.6: "Back to the first-run card;
// nothing of the sample remains"; fail: "Sample numbers remain anywhere"). Before the fix the regression's toast
// ("Savings dropped: Payments API sampling · $1,250 a day …", View in Ledger) and the delivery's ("Handed to Cribl for
// FinOps alerts ✓", View message) stayed ~9 s over the empty workspace, and View message opened the sample's card.
// Evidence: ops/certification/offline/evidence/walkC, walkG, walkG2.
//
// The tour's toasts land at 25, 31, 70, 110 and 130 s; this clears at 27 s (the regression's toast up) and at 32.5 s
// (the delivery's toast up), and at 131 s (the weekly receipt's toast, a sample dollar figure).

import { expect, test, type Locator, type Page } from '@playwright/test';
import { gotoApp, resetMock, trackConsoleErrors } from './helpers/index.ts';

const toasts = (page: Page): Locator => page.locator('[data-mr-toast]');
const dialogs = (page: Page): Locator => page.getByRole('dialog');

async function startTour(page: Page): Promise<void> {
  await page.clock.install();
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await gotoApp(page, '/first-run');
  await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
  await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-mr-tour', 'running');
}

async function clearSample(page: Page): Promise<void> {
  await page.locator('[data-callout="sample-band"]').getByRole('button', { name: 'Clear sample data' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-mr-tour', /.+/);
  await expect(page.getByTestId('first-run')).toBeVisible();
}

/**
 * Nothing of the sample left on screen: no toast, no dialog, nothing that names a sample figure or flow. Checked within
 * 1.5 s of the clear (a toast's close animation is 200 ms): a toast lives 9–12 s of real time, so a longer wait would
 * pass on the toast timing out by itself.
 */
async function expectNothingOfTheSample(page: Page): Promise<void> {
  const quick = { timeout: 1_500 };
  await expect(toasts(page)).toHaveCount(0, quick);
  await expect(dialogs(page)).toHaveCount(0, quick);
  for (const text of ['Payments API', 'View in Ledger', 'View message', 'FinOps alerts']) await expect(page.getByText(text, { exact: false })).toHaveCount(0, quick);
  // Later beats never land (the tour stopped): a minute on, it stays clean.
  await page.clock.fastForward(60_000);
  await expect(toasts(page)).toHaveCount(0, quick);
  await expect(dialogs(page)).toHaveCount(0, quick);
  const body = await page.locator('body').innerText();
  expect(body, 'a sample figure after Clear sample data').not.toMatch(/Payments API|\$1,250|\$456,250/);
}

test.describe('ui-6: Clear sample data leaves nothing of the tour on screen', () => {
  test('at 27 s, with the regression\'s toast up', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = trackConsoleErrors(page);
    await startTour(page);
    await page.clock.fastForward(27_000);
    await expect(toasts(page).filter({ hasText: 'Payments API' })).toHaveCount(1);
    await clearSample(page);
    await expectNothingOfTheSample(page);
    expect(errors()).toEqual([]);
  });

  test('at 32.5 s, with the delivery\'s toast up', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = trackConsoleErrors(page);
    await startTour(page);
    await page.clock.fastForward(32_500);
    await expect(toasts(page).filter({ hasText: 'FinOps alerts' })).toHaveCount(1);
    await clearSample(page);
    await expectNothingOfTheSample(page);
    expect(errors()).toEqual([]);
  });

  test('at 131 s, with the weekly receipt\'s toast up (a sample dollar figure)', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = trackConsoleErrors(page);
    await startTour(page);
    await page.clock.fastForward(131_000);
    await expect(toasts(page).filter({ hasText: '$' })).not.toHaveCount(0);
    await clearSample(page);
    await expectNothingOfTheSample(page);
    await expect(toasts(page).filter({ hasText: '$' })).toHaveCount(0, { timeout: 1_500 });
    expect(errors()).toEqual([]);
  });
});
