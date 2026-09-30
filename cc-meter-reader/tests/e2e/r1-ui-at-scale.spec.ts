// r1 ui-3 (FINDINGS_EXTRA (b)): "At your scale" on the Receipt — the annualized run rate only, this workspace's measured
// rate projected to 1, 5 and 10 TB a day with the hero's price qualifier; never on the sample tour (it receives far more
// than 10 TB a day), never on another period; wraps at 390 px without scrolling sideways; Show the math has its arithmetic.

import { expect, test, type Page } from '@playwright/test';
import type { Snapshot } from '../../core/types.ts';
import { atScaleFromSnapshot } from '../../src/views/Receipt/atScale.ts';
import { gotoApp, kvGet, navigateInApp, resetMock, trackConsoleErrors, waitForHydration } from './helpers/index.ts';

const ALLOW = [/Outdated Optimize Dep/];

/** The emulator's demo rig, priced at the suggested (typical list) prices and metered once: a rig-sized workspace. */
async function meteredRig(page: Page): Promise<Snapshot> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await page.getByRole('button', { name: /^Use suggested prices/ }).click({ timeout: 40_000 });
  await page.locator('section[data-section="prices"]').getByRole('button', { name: 'Start the meter' }).click();
  await expect.poll(async () => (await kvGet(page, 'snapshot')) !== null, { timeout: 120_000, intervals: [1_000] }).toBe(true);
  return JSON.parse((await kvGet(page, 'snapshot'))!) as Snapshot;
}

async function noHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test.describe('At your scale (r1 ui-3)', () => {
  test('a rig-sized workspace shows it on the annualized run rate only, with its arithmetic in Show the math', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = trackConsoleErrors(page, ALLOW);
    const snapshot = await meteredRig(page);
    const expected = atScaleFromSnapshot(snapshot);
    expect(expected, 'the rig (about 450 GB a day, every Source on one flow) qualifies').toBeDefined();
    expect(expected!.rungs.map((r) => r.gbPerDay)).toEqual([1_000, 5_000, 10_000]);

    await navigateInApp(page, '/?period=annualized');
    const line = page.getByTestId('receipt-at-scale');
    await expect(line).toBeVisible();
    const text = (await line.innerText()).replace(/ /g, ' ');
    expect(text).toMatch(/^At your scale, at this workspace's measured rate \(its mix of flows and priced destinations\): /);
    for (const r of expected!.rungs) expect(text).toContain(`${r.tb} TB a day ≈ ${r.amount}`);
    expect(text).toMatch(/ a year, projected at typical list prices\.$/);
    expect(text).not.toMatch(/283|For demonstration purposes/);
    // Two significant figures, compact ($280K, $1.4M); tests/unit/r1-ui-at-scale.test.ts pins the rounding.
    for (const r of expected!.rungs) expect(r.amount).toMatch(/^\$\d+(\.\d)?[KM]?$/);

    // Show the math: the rate and every rung's product, labelled a projection.
    await page.getByRole('button', { name: 'Show the math' }).click();
    const drawer = page.getByTestId('math-drawer');
    await expect(drawer.getByRole('heading', { name: 'At your scale (projected)' })).toBeVisible();
    await expect(drawer.getByTestId('math-at-scale-rate')).toContainText('saved per GB received');
    for (const r of expected!.rungs) await expect(drawer.getByTestId(`math-at-scale-${r.tb}tb`)).toContainText(`shown as ${r.amount}`);
    await expect(drawer).toContainText('A projection, not a measurement');
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);

    // Every other period: not shown (and not in its Show the math).
    for (const period of ['mtd', 'today', '30d']) {
      await navigateInApp(page, `/?period=${period}`);
      await expect(page.getByTestId('receipt-hero')).toBeVisible();
      await expect(page.getByTestId('receipt-at-scale')).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Show the math' }).click();
    await expect(page.getByTestId('math-drawer')).toBeVisible();
    await expect(page.getByTestId('math-drawer').getByRole('heading', { name: 'At your scale (projected)' })).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('390 px: the line wraps inside the page, nothing scrolls sideways', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await meteredRig(page);
    await navigateInApp(page, '/?period=annualized');
    const line = page.getByTestId('receipt-at-scale');
    await expect(line).toBeVisible();
    const box = (await line.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThan(20); // it wraps onto several lines
    await noHorizontalScroll(page);
  });

  test('the sample tour never shows it (its workspace receives far more than 10 TB a day)', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/first-run');
    await resetMock(page);
    await gotoApp(page, '/?tour=1');
    await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
    await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'annualized');
    await expect(page.getByTestId('receipt-hero')).toBeVisible();
    await expect(page.getByTestId('receipt-at-scale')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });
});
