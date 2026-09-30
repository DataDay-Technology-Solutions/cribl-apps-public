// r2 ui-10 (FINDINGS_R2 #12 + FINDINGS_EXTRA BO-17): Settings' other exits.
//   • #12: the in-app leave guard (r1 ui-5, M1) covered the top tabs and the palette only. Browser Back, P (the stage)
//     and "/" (the Ledger's search) left a dirty Settings draft without a word, and after "See your own number" Back
//     dropped the three filled prices. Each door now shows "Leave Settings with unsaved changes?"; Stay keeps the draft
//     (and the URL), Leave goes where the door pointed. Probe: app-assurance r2/4 zz-f4-navguard.spec.ts, sk2-popstate.
//   • BO-17: 0.6 s after Connect the "Target connected" toast covered two thirds of Save changes; the toast stack now
//     rises above the sticky save bar while it shows.

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, kvGet, navigateInApp, resetMock, seedPrices, waitForHydration } from './helpers/index.ts';

const card = (page: Page) => page.locator('section[data-section="notifications"]');
const dialog = (page: Page) => page.getByRole('dialog').filter({ hasText: 'Leave Settings with unsaved changes?' });

/** A dirty Notifications draft (an endpoint named, not saved), reached from the Receipt so Back has somewhere to go. */
async function dirtyDraft(page: Page): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await seedPrices(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  // In the App, as a member moves (a history entry of this document, so Back is the App's popstate, not a page load).
  await navigateInApp(page, '/settings/notifications');
  await expect(card(page)).toBeVisible();
  await card(page).getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByTestId('endpoint-0').getByLabel('Name').fill('Leadership Slack');
  await expect(card(page).locator('.mr-set-savebar')).toContainText('unsaved change');
  // Out of the field, so single-key shortcuts reach the shell.
  await page.locator('h1').first().click();
}

async function knock(page: Page, door: 'Back' | 'P' | '/'): Promise<void> {
  if (door === 'Back') await page.goBack();
  else await page.keyboard.press(door);
}

for (const door of ['Back', 'P', '/'] as const) {
  test.describe(`door ${door} with a dirty Settings draft`, () => {
    test('shows the leave dialog; Stay keeps the draft and the page', async ({ page }) => {
      await dirtyDraft(page);
      await knock(page, door);
      await expect(dialog(page)).toBeVisible();
      await dialog(page).getByRole('button', { name: 'Stay' }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page).toHaveURL(/\/settings\/notifications/);
      await expect(page.getByTestId('endpoint-0').getByLabel('Name')).toHaveValue('Leadership Slack');
      await expect(card(page).locator('.mr-set-savebar')).toContainText('unsaved change');
      // Nothing was written.
      expect(JSON.parse((await kvGet(page, 'settings')) ?? '{}').notifications ?? []).toEqual([]);
    });

    test('Leave goes where the door pointed', async ({ page }) => {
      await dirtyDraft(page);
      await knock(page, door);
      await expect(dialog(page)).toBeVisible();
      await dialog(page).getByRole('button', { name: 'Leave without saving' }).click();
      if (door === 'Back') await expect(page).toHaveURL(/\/(\?|$)/);
      else if (door === 'P') await expect(page).toHaveURL(/present=1/);
      else await expect(page).toHaveURL(/\/ledger/);
      await expect(page.getByTestId('endpoint-0')).toHaveCount(0);
    });
  });
}

test('a clean Settings page leaves by Back, P and "/" without a dialog', async ({ page }) => {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await seedPrices(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await navigateInApp(page, '/settings/notifications');
  await expect(card(page)).toBeVisible();
  await page.goBack();
  await expect(page).not.toHaveURL(/\/settings/);
  await expect(dialog(page)).toHaveCount(0);
});

test('after "See your own number", Back keeps the three filled prices behind the dialog', async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install();
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await gotoApp(page, '/first-run');
  await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
  const band = page.locator('[data-callout="sample-band"]');
  await expect(band).toBeVisible();
  await page.clock.fastForward(160_000);
  await expect(page.locator('html')).toHaveAttribute('data-mr-tour', 'finished', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Close', exact: true }).first().click({ timeout: 2_000 }).catch(() => undefined);
  await band.getByRole('button', { name: 'See your own number' }).click();
  await expect(page).toHaveURL(/\/settings\/prices$/);
  const prices = page.locator('section[data-section="prices"]');
  await expect(prices.locator('.mr-set-savebar')).toContainText(/\d+ unsaved changes?/, { timeout: 40_000 });
  const before = (await prices.locator('.mr-set-savebar').innerText()).match(/\d+ unsaved changes?/)?.[0];
  await page.goBack();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL(/\/settings\/prices$/);
  await expect(prices.locator('.mr-set-savebar')).toContainText(before!);
  expect(await kvGet(page, 'prices')).toBeNull();
});

test('BO-17: 0.5 s after Connect, Save changes is not under the toast', async ({ page }) => {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await seedPrices(page);
  await page.goto('/settings/notifications', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await expect(card(page)).toBeVisible();
  // One endpoint to connect, and another section of unsaved work, so the sticky save bar stays after Connect.
  await card(page).getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByTestId('endpoint-0-target').getByRole('textbox').fill('mrd_slack_finops');
  await card(page).getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByTestId('endpoint-1').getByLabel('Name').fill('Leadership Slack');
  const relay = page.getByTestId('endpoint-0-relay');
  await expect(relay).toHaveAttribute('data-relay', 'missing', { timeout: 10_000 });
  await relay.getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('[data-mr-toast]').first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  const save = card(page).getByRole('button', { name: 'Save changes' });
  await expect(save).toBeVisible();
  await save.scrollIntoViewIfNeeded();
  const box = (await save.boundingBox())!;
  const hit = await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { button: (el?.closest('button')?.textContent ?? '').trim(), toast: !!el?.closest('[role="status"], [role="alert"]') };
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(hit.toast, 'the toast is not over Save changes').toBe(false);
  expect(hit.button).toContain('Save changes');
});
