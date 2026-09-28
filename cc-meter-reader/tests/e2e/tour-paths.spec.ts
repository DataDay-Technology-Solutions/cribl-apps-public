// tests/e2e/tour-paths.spec.ts — the paths a judge takes out of the sample tour and back (overnight QA OQ-01…OQ-03).
//
//   OQ-01  the tour's pipeline names never link out of the app (the sample's pipelines are not in this workspace)
//   OQ-02  Y plays Story over the tour, and leaving Story lands back on the tour where it was
//   OQ-03  the Report card keeps the tour's custom range
//   OQ-10  Back from a presenter opened on the Report card returns to the Report card
//   OQ-11  Enter on a control that navigates leaves focus in the new view, not on <body>
//
// Run: npx playwright test tests/e2e/tour-paths.spec.ts --project=chromium

import { expect, test, type Page } from '@playwright/test';
import { expectPath, gotoApp, resetMock, trackConsoleErrors } from './helpers/index.ts';

/** Playwright's trace recorder is refused by the sandboxed report preview (tests/e2e/report.spec.ts). */
const TRACER_IN_SANDBOX = /^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.$/;

async function startTour(page: Page): Promise<void> {
  await gotoApp(page, '/');
  await resetMock(page);
  await gotoApp(page, '/');
  await expectPath(page, '/first-run');
  await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
  await expectPath(page, '/');
  await expect(page.locator('html')).toHaveAttribute('data-mr-tour', 'running');
  await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
}

test.describe('the sample tour keeps the judge inside it', () => {
  test.setTimeout(120_000);

  test('no pipeline name links out of the app on sample data: Receipt, Ledger and Flow (OQ-01)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await startTour(page);
    const savers = page.getByTestId('receipt-top-savers');
    await expect(savers.locator('li').first()).toBeVisible();
    await expect(savers.locator('a[target="_top"]')).toHaveCount(0);
    await expect(page.locator('main a[target="_top"]')).toHaveCount(0);

    await page.getByRole('navigation', { name: 'Meter Reader sections' }).getByRole('link', { name: /^Ledger/ }).click();
    await expectPath(page, '/ledger');
    await expect(page.locator('[data-pipeline-link]')).toHaveCount(0);
    await expect(page.locator('.mr-lt-link--static').first()).toBeVisible();
    await expect(page.locator('main a[target="_top"]')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-mr-tour', /running|paused|finished/);
    expect(errors()).toEqual([]);
  });

  test('Y plays Story over the tour; leaving it returns to the tour on the same page, at the same beat (OQ-02)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await startTour(page);
    const band = page.locator('[data-callout="sample-band"]');
    // The regression lands at ~25 s: the tour is then past its first beat.
    await expect(band).toContainText(/beat [2-9] of \d+/, { timeout: 45_000 });
    const beatBefore = Number(/beat (\d+) of/.exec((await band.textContent()) ?? '')?.[1]);
    await page.getByRole('navigation', { name: 'Meter Reader sections' }).getByRole('link', { name: /^Ledger/ }).click();
    // Y straight after the tab click: it waits for the tab switch, so the Story closes onto the Ledger.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('y');
    await expect(page.locator('[data-mode="story"]')).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-mr-tour', /.*/);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-mode="story"]')).toHaveCount(0);
    await expectPath(page, '/ledger');
    await expect(page.locator('main h1')).toHaveText('Ledger');
    await expect(band).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-mr-tour', /running|paused|finished/);
    expect(new URL(page.url()).searchParams.get('tour')).toBe('1');
    const beatAfter = Number(/beat (\d+) of/.exec((await band.textContent()) ?? '')?.[1]);
    expect(beatAfter).toBeGreaterThanOrEqual(beatBefore);
    expect(errors()).toEqual([]);
  });

  test("the Report card keeps the tour's custom range (OQ-03)", async ({ page }) => {
    const errors = trackConsoleErrors(page, [TRACER_IN_SANDBOX]);
    await startTour(page);
    await gotoApp(page, '/?tour=1&range=7d');
    await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
    await page.getByRole('button', { name: 'Report card' }).first().click();
    await expectPath(page, '/report');
    const report = page.getByTestId('report-view');
    await expect(report).toBeVisible();
    await expect(page.locator('[data-period]').first()).toHaveAttribute('data-period', 'range');
    await expect(page.getByRole('radio', { name: /Custom range/ })).toBeChecked();
    expect(errors()).toEqual([]);
  });

  test('Back from a presenter opened on the Report card returns to the Report card (OQ-10)', async ({ page, browserName }) => {
    const errors = trackConsoleErrors(page, [TRACER_IN_SANDBOX]);
    await startTour(page);
    await page.getByRole('button', { name: 'Report card' }).first().click();
    await expectPath(page, '/report');
    await expect(page.getByTestId('report-view')).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('p');
    await expect(page.locator('[data-mode="presenter"]')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('present')).toBe('1');
    await page.goBack();
    await expectPath(page, '/report');
    await expect(page.getByTestId('report-view')).toBeVisible();
    await expect(page.locator('[data-mode="presenter"]')).toHaveCount(0);
    // P then P again: back on the Report card, and one Back from there leaves it (no duplicate entry).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('p');
    await expect(page.locator('[data-mode="presenter"]')).toBeVisible();
    await page.keyboard.press('p');
    await expectPath(page, '/report');
    await expect(page.locator('[data-mode="presenter"]')).toHaveCount(0);
    await expect(page.getByTestId('report-view')).toBeVisible();
    // Measured: opening the stage makes one pushState, yet WebKit's history grows by two, so there one Back from the
    // Report card lands on a second Report card entry; Chromium and Firefox leave it.
    if (browserName !== 'webkit') {
      await page.goBack();
      await expectPath(page, '/');
    }
    expect(errors()).toEqual([]);
  });

  test('Enter on Report card lands focus in the Report card view, not on the page body (OQ-11)', async ({ page }) => {
    const errors = trackConsoleErrors(page, [TRACER_IN_SANDBOX]);
    await startTour(page);
    await page.getByRole('button', { name: 'Report card' }).first().focus();
    await page.keyboard.press('Enter');
    await expectPath(page, '/report');
    await expect(page.getByTestId('report-view')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName)).toBe('main');
    // The next Tab continues inside the view.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#main'))).toBe(true);
    expect(errors()).toEqual([]);
  });
});
