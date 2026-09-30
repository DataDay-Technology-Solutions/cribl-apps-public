// Final 1.1.4, hunt r3 #0 (major). The synthesis dropped it because the second skeptic checked dev, which has no in-app
// leave guard; the first skeptic reproduced it on round1 5cab036, and the second confirmed the mechanism there by reading.
//
// Start the meter on a Leader with latency, then leave Settings at once. The save is still in flight, so the leave
// dialog opens. When the save lands, the dirty section clears and the guard unregisters, but the dialog stayed open over an
// empty list, saying "Leaving discards them; nothing has been written" while the prices were saved and the meter
// running. Now, once the save lands, the dialog closes and the navigation the member asked for goes ahead, as Leave
// would. Probe: ops/app-assurance r4/0 zz-r4f0c-stale.spec.ts (P11-tip-lat300/800-tab and -popfwd).

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, kvGet, mockControl, navigateInApp, resetMock } from './helpers/index.ts';

const dialog = (page: Page) => page.getByRole('dialog').filter({ hasText: 'Leave Settings with unsaved changes?' });

async function startTheMeterSlowly(page: Page): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await gotoApp(page, '/');
  // In the App, as a member moves, so a popstate is the App's own and not a page load.
  await navigateInApp(page, '/settings/prices');
  await page.getByRole('button', { name: /^Use suggested prices/ }).click({ timeout: 60_000 });
  await mockControl(page, { action: 'config', options: { latencyMs: 1_500 } });
  await page.locator('section[data-section="prices"]').getByRole('button', { name: 'Start the meter' }).click();
}

for (const door of ['Receipt tab', 'forwarded navigation'] as const) {
  test(`Start the meter, then leave by the ${door} while the save is in flight: the dialog closes when the save lands and the member arrives`, async ({ page }) => {
    test.setTimeout(120_000);
    await startTheMeterSlowly(page);
    if (door === 'Receipt tab') await page.getByRole('navigation', { name: 'Meter Reader sections' }).getByRole('link', { name: 'Receipt' }).click();
    else
      await page.evaluate(() => {
        history.pushState(null, '', '/');
        dispatchEvent(new PopStateEvent('popstate'));
      });
    // The save has not landed yet: the dialog asks (this is the state the finding starts from).
    await expect(dialog(page)).toBeVisible();
    // It lands: nothing is left to discard, so the dialog goes and the member arrives where they were going.
    await expect(dialog(page)).toHaveCount(0, { timeout: 15_000 });
    await expect(page).toHaveURL(/\/(\?|$)/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await kvGet(page, 'prices')).not.toBeNull();
    await mockControl(page, { action: 'config', options: { latencyMs: 0 } });
  });
}
