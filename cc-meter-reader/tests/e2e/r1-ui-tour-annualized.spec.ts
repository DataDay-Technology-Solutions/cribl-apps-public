// r1 ui-2 (FINDINGS_EXTRA (a), tour half): the sample tour's Receipt opens on the annualized run rate — "about $8.1M a
// year, the built-in sample enterprise workspace" — from its first frame; the Report card keeps its own month-to-date
// default (a CFO document is a real period); the tour's beats and Story are unchanged.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { fmtDollars } from '../../core/format.ts';
import type { TourFixture } from '../../src/tour/types.ts';
import { planRebase, rebaseHeadline, rebaseValue } from '../../src/tour/rebase.ts';
import { expectPath, gotoApp, resetMock, trackConsoleErrors } from './helpers/index.ts';

const TOUR = JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/tour.json', import.meta.url)), 'utf8')) as TourFixture;

/** The sample's annualized run rate as the tour shows it today. */
function tourAnnualizedM(): number {
  const zone = TOUR.timezone || 'America/Chicago';
  const plan = planRebase(Date.parse(TOUR.anchor ?? TOUR.generatedAt), Date.now(), zone);
  if (plan.dayShift === 0) return TOUR.snapshot.headline.annualizedM;
  return rebaseHeadline(rebaseValue(TOUR.snapshot, plan), zone, TOUR.settings.criblCostCentsPerMonth).headline.annualizedM;
}

test('the tour opens its Receipt on the annualized run rate; the Report card opens on month to date', async ({ page }) => {
  // Playwright's trace recorder in the Report card's sandboxed preview frame (as report.spec.ts filters it).
  const errors = trackConsoleErrors(page, [/^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed/]);
  expect(TOUR.settings.headlinePeriodDefault).toBe('annualized');
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await gotoApp(page, '/first-run');
  const started = Date.now();
  await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
  await expectPath(page, '/');
  await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();

  // +0 s: the hero reads the sample's annualized run rate, about $8.1M a year, and says so.
  const view = page.locator('.mr-receipt-view');
  await expect(view).toHaveAttribute('data-period', 'annualized');
  await expect(page.getByRole('radio', { name: 'Annualized' })).toBeChecked();
  const figure = page.locator('[data-testid="receipt-hero"] [data-callout="saved"]');
  await expect.poll(async () => Number(await figure.getAttribute('data-value-m'))).toBe(tourAnnualizedM());
  expect(fmtDollars(tourAnnualizedM())).toMatch(/^\$8,1\d\d,\d{3}$/);
  await expect(page.getByTestId('hero-caption')).toContainText('annualized run rate');
  // Well before the first beat (the regression at 25 s): the opening frame is annualized.
  expect((Date.now() - started) / 1000).toBeLessThan(20);
  // The tour's workspace receives far more than 10 TB a day: no "At your scale" line (r1 ui-3).
  await expect(page.getByTestId('receipt-at-scale')).toHaveCount(0);

  // The Report card, opened from that Receipt, is a month-to-date document.
  await page.getByTestId('receipt-hero').getByRole('button', { name: 'Report card' }).click();
  await expectPath(page, '/report');
  await expect(page.getByTestId('report-view')).toHaveAttribute('data-period', 'mtd');
  await expect(page.getByRole('radio', { name: 'Month to date' })).toBeChecked();
  expect(errors()).toEqual([]);
});
