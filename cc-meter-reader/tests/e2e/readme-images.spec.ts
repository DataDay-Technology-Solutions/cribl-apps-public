// tests/e2e/readme-images.spec.ts — the README's 2×2 screenshot grid (docs/images/{receipt,flow,alert,report}.png).
//
// Opt-in: skipped unless MR_README_IMAGES=1, so the regular matrix never rewrites tracked images. One pass of the sample
// tour (?tour=1: the recorded enterprise workspace under its SAMPLE DATA band, nothing written to KV) at 1440×900 in the
// light theme with reduced motion (the Meter's digits update in place instead of rolling mid-shot):
//   receipt.png  the Receipt at the tour's start: Saved by Cribl month to date, would-have-paid against paid, net after Cribl
//   alert.png    the Ledger once the tour's regression has landed (beat 3, ~25 s in): the change timeline with the commit
//                marker and the Alerts rail card naming the commit, its author and where the alert went
//   flow.png     the Flow map in dollars with the open regression outlined on its ribbon
//   report.png   the Report card preview (the file a member downloads)
// Toasts are hidden for the shots (they sit over the cards they announce). Re-capture on the final build before packaging:
//   MR_README_IMAGES=1 npx playwright test tests/e2e/readme-images.spec.ts --project=chromium
// (MR_README_OUT=<dir> writes elsewhere; README.md and tests/compliance.test.ts expect the four files in docs/images/.)

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, setTheme } from './helpers/index.ts';

const OUT = process.env.MR_README_OUT ?? 'docs/images';

test.skip(!process.env.MR_README_IMAGES, 'set MR_README_IMAGES=1 to capture the README images');
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });

const HIDE_TOASTS = ":is([role='status'], [role='alert']):has([data-mr-toast]) { display: none !important; }";

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: HIDE_TOASTS });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(1500);
}

test('captures the README grid from one pass of the sample tour', async ({ page }) => {
  test.setTimeout(150_000);
  await gotoApp(page, '/?tour=1');
  await setTheme(page, 'light');
  await expect(page.getByText('Saved by Cribl').first()).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${OUT}/receipt.png` });

  // The tour's regression lands at 25 s (demo/sample/tour.json script[0].at); its toast offers View in Ledger.
  await page.getByRole('button', { name: 'View in Ledger' }).or(page.getByRole('link', { name: 'View in Ledger' })).first().waitFor({ timeout: 60_000 });

  await page.getByRole('link', { name: /^Ledger/ }).first().click();
  await expect(page).toHaveURL(/\/ledger\?.*tour=1/);
  const rail = page.getByRole('heading', { name: /^Alerts/ }).first();
  await rail.scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 300);
  await expect(page.getByText('Payments API sampling').last()).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${OUT}/alert.png` });

  await page.getByRole('link', { name: /^Flow/ }).first().click();
  await expect(page).toHaveURL(/\/flow\?.*tour=1/);
  await expect(page.getByText('Cribl Insights shows this map in bytes. This is dollars.')).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${OUT}/flow.png` });

  await gotoApp(page, '/report?tour=1');
  await setTheme(page, 'light');
  await expect(page.getByRole('heading', { name: 'Report card' })).toBeVisible();
  await settle(page);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/report.png` });
});
