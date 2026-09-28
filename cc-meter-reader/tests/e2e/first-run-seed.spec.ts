// tests/e2e/first-run-seed.spec.ts — the documented first run meters up to a day, not an hour (D63; rules round 2).
//
// A judge followed README "Try it in 5 minutes" on the release build over the mock: empty KV, then Settings →
// Prices → Use suggested prices → Start the meter. The first sweep seeded 60 minutes (collectingSince =
// meteredThrough − 1 h on the 7-route demo preset), because a fresh install has no stored inventory and
// core/sweep.ts sized the first run from it before the configuration walk. The sweep now sizes a cold first run
// from its own walk. This spec repeats the judge's steps from an empty KV and reads meta.
//
// Run: MR_E2E_PORT=5766 npx playwright test tests/e2e/first-run-seed.spec.ts --project=chromium

import { expect, test } from '@playwright/test';
import { gotoApp, kvGet, resetMock, waitForHydration } from './helpers/index.ts';

const HOUR = 3_600_000;

test.describe('D63 · the first run from an empty KV reaches back a day on a small estate', () => {
  test.setTimeout(180_000);

  test('empty KV → Use suggested prices → Start the meter: collectingSince is a day before meteredThrough', async ({ page }) => {
    await gotoApp(page, '/first-run');
    await expect(page.getByTestId('first-run')).toBeVisible();
    await resetMock(page);
    expect(await kvGet(page, 'meta')).toBeNull();

    await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await page.getByRole('button', { name: /^Use suggested prices/ }).click({ timeout: 40_000 });
    await page.locator('section[data-section="prices"]').getByRole('button', { name: 'Start the meter' }).click();
    await expect(page.getByText('The meter is running.', { exact: false }).first()).toBeVisible();

    // The first priced sweep writes meta with a cursor; the seed is the day before it (the demo preset is 7 routes).
    await expect
      .poll(async () => JSON.parse((await kvGet(page, 'meta')) ?? '{}').meteredThrough ?? null, { timeout: 120_000, intervals: [1_000] })
      .not.toBeNull();
    const meta = JSON.parse((await kvGet(page, 'meta')) ?? '{}') as { collectingSince: string; meteredThrough: string };
    const reach = Date.parse(meta.meteredThrough) - Date.parse(meta.collectingSince);
    expect(reach).toBeGreaterThanOrEqual(24 * HOUR - 60_000);
    expect(reach).toBeLessThanOrEqual(24 * HOUR + 60_000);
    // Let the sweep release its lock before the page closes (a navigation mid-sweep holds it for its TTL).
    await expect(page.getByTestId('footer-sweep')).toContainText(/^Last sweep/, { timeout: 60_000 });
  });
});
