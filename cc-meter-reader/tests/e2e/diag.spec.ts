// The ?diag=1 support overlay: read-only, explains a blank or stuck screen in one screenshot.
import { expect, test } from '@playwright/test';
import { waitForHydration } from './helpers/index.ts';

test('?diag=1 shows hydration, source and errors, and Shift+D toggles it', async ({ page }) => {
  await page.goto('/?diag=1');
  await waitForHydration(page);
  const panel = page.getByTestId('diag-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('hydrated');
  await expect(panel).toContainText('true');
  await expect(panel).toContainText('errors');
  await page.keyboard.press('Shift+D');
  await expect(panel).toBeHidden();
  await page.keyboard.press('Shift+D');
  await expect(panel).toBeVisible();
});
