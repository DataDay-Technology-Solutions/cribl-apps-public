// tests/e2e/smoke.spec.ts — @smoke: the app boots on the emulator, stays quiet in the console,
// navigates between its primary views, and renders in both Cribl themes.
//
// Runs on every project (desktop 1440, 1920, mobile 390). `npm run test:smoke` selects it by tag.

import { expect, test } from '@playwright/test';
import {
  PRIMARY_ROUTES,
  expectPath,
  gotoApp,
  mockState,
  screenPath,
  seedPrices,
  setTheme,
  themeColors,
  trackConsoleErrors,
  waitForHydration,
} from './helpers/index.ts';

test.describe('smoke @smoke', () => {
  test('loads on the emulator with no console errors', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/');
    await expect(page.locator('#root')).not.toBeEmpty();
    await expect(page.getByRole('main')).toBeVisible();
    const state = await mockState(page);
    expect(state).toMatchObject({ preset: 'demo' });
    // The app read the emulated Leader: at least the hydration reads went through the API.
    expect(await page.evaluate(() => (window as unknown as { CRIBL_API_URL?: string }).CRIBL_API_URL)).toBe('/mock-api/v1');
    expect(errors()).toEqual([]);
  });

  test('navigation reaches every primary view', async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page);
    // A fresh emulator is a never-priced workspace, where `/` is the first-run card by design (PRD 8.5): the
    // redirect lands a few hundred ms after hydration, so this test used to reach the Receipt only when its
    // first click beat it. Price the rig first, so `/` is the Receipt on every engine and every machine.
    await gotoApp(page, '/first-run');
    await expect(page.getByTestId('first-run')).toBeVisible(); // settled: its modules and fonts are in
    await page.evaluate(() => document.fonts.ready);
    await seedPrices(page);
    await gotoApp(page, '/');
    await expectPath(page, '/');
    // The Receipt: its hero once the first sweep lands, its layout-matched ghost until then.
    await expect(page.getByRole('main').locator('.mr-receipt-view')).toBeVisible();
    await expect(page.getByTestId('first-run')).toHaveCount(0);
    const nav = page.getByRole('navigation').first();
    for (const route of PRIMARY_ROUTES) {
      const link = nav.locator(route.path === '/' ? 'a[href="/"]' : `a[href="${route.path}"], a[href$="${route.path}"]`).first();
      if (isMobile && !(await link.isVisible())) {
        // A collapsed mobile nav must open from a visible control labelled as navigation/menu.
        await page.getByRole('button', { name: /menu|navigation/i }).first().click();
      }
      await link.click();
      await expectPath(page, route.path);
      await waitForHydration(page);
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('main')).not.toBeEmpty();
    }
    // Deep links load directly, too (the router's basename is '/' outside Cribl).
    await gotoApp(page, '/ledger');
    await expect(page.getByRole('main')).not.toBeEmpty();
    expect(errors()).toEqual([]);
  });

  test('renders in both themes', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/');
    await setTheme(page, 'dark');
    await expect(page.locator('body')).toHaveClass(/(^|\s)dark(\s|$)/);
    const dark = await themeColors(page);
    await page.screenshot({ path: screenPath('smoke', 'dark', page), fullPage: true });
    await setTheme(page, 'light');
    await expect(page.locator('body')).not.toHaveClass(/(^|\s)dark(\s|$)/);
    const light = await themeColors(page);
    await page.screenshot({ path: screenPath('smoke', 'light', page), fullPage: true });
    // The theme must actually change what is painted, not just a class name.
    expect(`${dark.color}|${dark.background}`).not.toBe(`${light.color}|${light.background}`);
    expect(errors()).toEqual([]);
  });
});
