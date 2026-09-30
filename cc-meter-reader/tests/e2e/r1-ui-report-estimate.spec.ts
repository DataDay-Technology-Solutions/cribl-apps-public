// r1 ui-11, FOUNDER_PLAN row 13: the Report card has no hole on first use. With no Cribl cost set, "Before you send it"
// offers "Use the list-price estimate": the same save as Settings → Cribl cost's "Use this estimate" (the list-price
// suggestion, flagged criblCostEstimate), after which the report shows its net and return and carries the estimate
// flag; a contract figure saved in Settings removes the flag.

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, kvGet, resetMock, seedPrices, trackConsoleErrors, waitForHydration } from './helpers/index.ts';

const TRACER_IN_SANDBOX = /^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed/;

async function settingsDoc(page: Page): Promise<{ criblCostCentsPerMonth?: number; criblCostEstimate?: boolean } | null> {
  const raw = await kvGet(page, 'settings');
  return raw === null ? null : JSON.parse(raw);
}

test('"Use the list-price estimate" saves the estimate, flagged; the report then shows its return', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackConsoleErrors(page, [TRACER_IN_SANDBOX, /Outdated Optimize Dep/]);
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await seedPrices(page);
  // A first sweep, so the ingest is measured and the list-price suggestion exists.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await expect.poll(async () => (await kvGet(page, 'snapshot')) !== null, { timeout: 60_000 }).toBe(true);
  await page.goto('/report?report=mtd', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);

  const checks = page.getByTestId('report-checks');
  await expect(checks).toContainText('No Cribl cost is set');
  const use = checks.getByRole('button', { name: 'Use the list-price estimate' });
  await expect(use).toBeVisible();
  // The preview says there is no return yet.
  await expect.poll(async () => (await page.getByTestId('report-preview').getAttribute('srcdoc')) ?? '').toContain('No Cribl cost was provided');

  await use.click();
  await expect.poll(async () => (await settingsDoc(page))?.criblCostCentsPerMonth ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  const saved = (await settingsDoc(page))!;
  expect(saved.criblCostEstimate).toBe(true);
  // Now the return shows, and the button has done its job.
  await expect(checks.getByRole('button', { name: 'Use the list-price estimate' })).toHaveCount(0);
  await expect.poll(async () => (await page.getByTestId('report-preview').getAttribute('srcdoc')) ?? '').not.toContain('No Cribl cost was provided');
  const dollars = `$${(saved.criblCostCentsPerMonth! / 100).toLocaleString('en-US')}`;
  await expect.poll(async () => (await page.getByTestId('report-preview').getAttribute('srcdoc')) ?? '').toContain(dollars);

  // A contract figure saved in Settings → Cribl cost clears the estimate flag.
  await page.goto('/settings?section=cost', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await page.getByTestId('cost-input').fill('9999');
  await page.locator('section[data-section="cost"]').getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(async () => (await settingsDoc(page))?.criblCostCentsPerMonth).toBe(999_900);
  expect((await settingsDoc(page))?.criblCostEstimate).toBeUndefined();
  expect(errors()).toEqual([]);
});

test('on the sample tour the report offers no save (nothing is written to the workspace)', async ({ page }) => {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await gotoApp(page, '/report?tour=1');
  await expect(page.getByTestId('report-view')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Use the list-price estimate' })).toHaveCount(0);
});
