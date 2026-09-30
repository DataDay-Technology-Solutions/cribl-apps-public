// r2 ui-5 (FINDINGS_R2 #15): after "Use the list-price estimate" the Report card's "Before you send it" block unmounts
// with the button that had focus; focus must land on Download PDF, never fall to <body> (D39: the project treats a
// focus that drops to <body> as a bug). Promoted from skeptic-1's scratch spec
// (Media/…/ops/founder-build/skeptic1-report-estimate-focus/zz-sk1-estfocus.spec.ts; reproduced on chromium and mobile).
// The estimate's label on the card itself is core-7's.

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, kvGet, mockControl, resetMock, seedPrices, waitForHydration } from './helpers/index.ts';

const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return { tag: a?.tagName ?? 'null', text: (a?.textContent ?? '').trim().slice(0, 40), testid: a?.getAttribute('data-testid') ?? '' };
  });

async function openReport(page: Page): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await seedPrices(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await expect.poll(async () => (await kvGet(page, 'snapshot')) !== null, { timeout: 60_000 }).toBe(true);
  await page.goto('/report?report=mtd', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
}

test.describe('ui-5: focus after "Use the list-price estimate"', () => {
  test('by keyboard: Enter on the button → the block goes → focus is on Download PDF, and Tab moves on from there', async ({ page }) => {
    test.setTimeout(120_000);
    await openReport(page);
    const use = page.getByTestId('report-use-estimate');
    await expect(use).toBeVisible();
    // Reach it by keyboard: focus the Note field above it, then Tab until the button is focused.
    await page.getByTestId('report-note').locator('textarea').focus();
    for (let tabs = 0; tabs < 10 && !(await use.evaluate((el) => el === document.activeElement || el.contains(document.activeElement))); tabs++) {
      await page.keyboard.press('Tab');
    }
    expect((await focused(page)).testid).toBe('report-use-estimate');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Saved the list-price estimate', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(use).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('report-checks')).toHaveCount(0);
    // Never <body>: the Download PDF button holds focus.
    await expect.poll(async () => (await focused(page)).tag).toBe('BUTTON');
    await expect(page.getByRole('button', { name: 'Download PDF' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Download HTML' })).toBeFocused();
  });

  test('by pointer: a press also hands focus to Download PDF (the pressed button is gone)', async ({ page }) => {
    test.setTimeout(120_000);
    await openReport(page);
    const use = page.getByTestId('report-use-estimate');
    await expect(use).toBeVisible();
    await use.click();
    await expect(use).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await focused(page)).tag).not.toBe('BODY');
    await expect(page.getByRole('button', { name: 'Download PDF' })).toBeFocused();
  });

  test('focus the member moved elsewhere during the save is left where it is', async ({ page }) => {
    test.setTimeout(120_000);
    await openReport(page);
    // The Leader answers slowly (the emulator's latency): the member is back in the Note field before the save lands.
    await mockControl(page, { action: 'config', options: { latencyMs: 1_000 } });
    const use = page.getByTestId('report-use-estimate');
    await use.click();
    await page.getByTestId('report-note').locator('textarea').focus();
    await expect(use).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('report-note').locator('textarea')).toBeFocused();
  });
});
