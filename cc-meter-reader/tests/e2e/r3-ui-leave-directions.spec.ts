// r3 ui-2 (FINDINGS_R3 #11, residue of R2 #12; contract C7): the popstate leave guard in every direction.
//   r2 ui-10 held a history move away from a dirty Settings draft by always stepping forward (go(1)) and replaying Leave
//   by always stepping back (go(-1)). That is right for one Back only. Forward, a two-step move (go(-2)) and a navigation
//   the platform forwards as pushState + popstate (AGENTS.md "Navigation"; navigateInApp) left the URL on another page
//   under a Settings view after Stay; Leave went back to Settings instead of the page asked for; and after that a later
//   Back dropped the still-dirty draft with no dialog (the guard stayed released).
//   The guard now stamps every entry with an index in history.state and uses the popstate's delta: Stay restores with
//   go(-delta), Leave replays go(delta); a forwarded pushState + popstate is a push (Stay undoes it, Leave lets it land).
// Probes: app-assurance r3/4 zz-r3f4-forward / -forward-leave / -forwarded / -stuck, r3/5 zz-r3f5-hist,
// skeptic2-r3-popdir zz-sk2-popdir.

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, kvGet, navigateInApp, resetMock, seedPrices, waitForHydration } from './helpers/index.ts';

const card = (page: Page) => page.locator('section[data-section="notifications"]');
const dialog = (page: Page) => page.getByRole('dialog').filter({ hasText: 'Leave Settings with unsaved changes?' });
const draft = (page: Page) => page.getByTestId('endpoint-0').getByLabel('Name');
const pathname = (page: Page) => new URL(page.url()).pathname.replace(/\/+$/, '') || '/';

async function start(page: Page): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await seedPrices(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
}

async function makeDirty(page: Page): Promise<void> {
  await expect(card(page)).toBeVisible();
  await card(page).getByRole('button', { name: 'Add endpoint' }).click();
  await draft(page).fill('Leadership Slack');
  await expect(card(page).locator('.mr-set-savebar')).toContainText('unsaved change');
  await page.locator('h1').first().click();
}

/** Stay: the dialog closes, the URL and the view are Settings, the draft is on screen, nothing was written. */
async function expectStayed(page: Page): Promise<void> {
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => pathname(page)).toBe('/settings/notifications');
  await expect(card(page)).toBeVisible();
  await expect(draft(page)).toHaveValue('Leadership Slack');
  await expect(card(page).locator('.mr-set-savebar')).toContainText('unsaved change');
  // The URL stays put (no late restore or replay moves it) and no second dialog opens by itself.
  await page.waitForTimeout(600);
  expect(pathname(page)).toBe('/settings/notifications');
  await expect(dialog(page)).toHaveCount(0);
  expect(JSON.parse((await kvGet(page, 'settings')) ?? '{}').notifications ?? []).toEqual([]);
}

/** Leave: the URL is the entry asked for, the view is not Settings, the draft is gone. */
async function expectLeftTo(page: Page, path: string): Promise<void> {
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => pathname(page)).toBe(path);
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId('endpoint-0')).toHaveCount(0);
  await page.waitForTimeout(600);
  expect(pathname(page)).toBe(path);
}

const choose = (page: Page, name: 'Stay' | 'Leave without saving') => dialog(page).getByRole('button', { name }).click();

/** '/', then Settings, then the Ledger, then Back: Settings with the Ledger as its forward entry. */
async function settingsWithForward(page: Page, forwards: string[] = ['/ledger']): Promise<void> {
  await start(page);
  await navigateInApp(page, '/settings/notifications');
  for (const to of forwards) await navigateInApp(page, to);
  for (let i = 0; i < forwards.length; i++) await page.goBack();
  await expect.poll(() => pathname(page)).toBe('/settings/notifications');
  await makeDirty(page);
}

test.describe('browser Forward from a dirty Settings', () => {
  test('Stay keeps the URL, the view and the draft; a later Back is still guarded', async ({ page }) => {
    await settingsWithForward(page);
    await page.goForward();
    await expect(dialog(page)).toBeVisible();
    await choose(page, 'Stay');
    await expectStayed(page);
    // A later Back (to the Receipt) asks again: it is neither swallowed nor let through.
    await page.goBack();
    await expect(dialog(page)).toBeVisible();
    await choose(page, 'Stay');
    await expectStayed(page);
  });

  test('with two forward entries, Stay keeps Settings', async ({ page }) => {
    await settingsWithForward(page, ['/ledger', '/flow']);
    await page.goForward();
    await expect(dialog(page)).toBeVisible();
    await choose(page, 'Stay');
    await expectStayed(page);
  });

  test('Leave goes to the forward entry and the draft is gone; Back then returns to a clean Settings', async ({ page }) => {
    await settingsWithForward(page);
    await page.goForward();
    await expect(dialog(page)).toBeVisible();
    await choose(page, 'Leave without saving');
    await expectLeftTo(page, '/ledger');
    // The draft-loss case (the r3 probe): a later Back never meets a still-dirty draft left behind unguarded.
    await page.goBack();
    await expect.poll(() => pathname(page)).toBe('/settings/notifications');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId('endpoint-0')).toHaveCount(0);
  });

  test('the guard re-arms after Leave: a new draft is guarded on the next Back', async ({ page }) => {
    await settingsWithForward(page);
    await page.goForward();
    await choose(page, 'Leave without saving');
    await expectLeftTo(page, '/ledger');
    await page.goBack();
    await expect.poll(() => pathname(page)).toBe('/settings/notifications');
    await makeDirty(page);
    await page.goBack();
    await expect(dialog(page)).toBeVisible();
    await choose(page, 'Stay');
    await expectStayed(page);
  });
});

test.describe('two entries at once (history.go(-2)) from a dirty Settings', () => {
  async function twoBack(page: Page): Promise<void> {
    await start(page);
    await navigateInApp(page, '/ledger');
    await navigateInApp(page, '/settings/notifications');
    await makeDirty(page);
    await page.evaluate(() => window.history.go(-2));
    await expect(dialog(page)).toBeVisible();
  }

  test('Stay keeps Settings', async ({ page }) => {
    await twoBack(page);
    await choose(page, 'Stay');
    await expectStayed(page);
  });

  test('Leave goes two entries back (the Receipt)', async ({ page }) => {
    await twoBack(page);
    await choose(page, 'Leave without saving');
    await expectLeftTo(page, '/');
  });
});

test.describe('a navigation the platform forwards (pushState + popstate) from a dirty Settings', () => {
  async function forwarded(page: Page): Promise<void> {
    await start(page);
    await navigateInApp(page, '/settings/notifications');
    await makeDirty(page);
    await page.evaluate(() => {
      window.history.pushState(null, '', '/ledger');
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    await expect(dialog(page)).toBeVisible();
  }

  test('Stay keeps Settings; a later Back is guarded, not swallowed', async ({ page }) => {
    await forwarded(page);
    await choose(page, 'Stay');
    await expectStayed(page);
    await page.goBack();
    await expect(dialog(page)).toBeVisible();
    await choose(page, 'Leave without saving');
    await expectLeftTo(page, '/');
  });

  test('Leave lands on the forwarded page', async ({ page }) => {
    await forwarded(page);
    await choose(page, 'Leave without saving');
    await expectLeftTo(page, '/ledger');
    // The Ledger is the Ledger (the router heard the move), and Back returns to a clean Settings.
    await expect(page.locator('main h1').first()).toContainText('Ledger');
    await page.goBack();
    await expect.poll(() => pathname(page)).toBe('/settings/notifications');
    await expect(dialog(page)).toHaveCount(0);
  });
});

test.describe('Back from a dirty Settings (r2 ui-10, still)', () => {
  test('Back, Stay three times: every Back is guarded', async ({ page }) => {
    await start(page);
    await navigateInApp(page, '/settings/notifications');
    await makeDirty(page);
    for (let i = 0; i < 3; i++) {
      await page.goBack();
      await expect(dialog(page)).toBeVisible();
      await choose(page, 'Stay');
      await expectStayed(page);
    }
  });

  test('Back twice fast, Stay: Settings stays', async ({ page }) => {
    await start(page);
    await navigateInApp(page, '/ledger');
    await navigateInApp(page, '/settings/notifications');
    await makeDirty(page);
    await page.evaluate(() => {
      history.back();
      setTimeout(() => history.back(), 30);
    });
    await expect(dialog(page)).toBeVisible();
    await page.waitForTimeout(800);
    await choose(page, 'Stay');
    await expectStayed(page);
  });

  test('router moves (the top tabs): Leave by a tab, then Back and Forward pass freely on a clean page', async ({ page }) => {
    await start(page);
    await navigateInApp(page, '/settings/notifications');
    await makeDirty(page);
    const tabs = page.getByRole('navigation', { name: 'Meter Reader sections' });
    await tabs.getByRole('link', { name: 'Ledger', exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    await choose(page, 'Leave without saving');
    await expectLeftTo(page, '/ledger');
    // The router's own push is an entry like any other: Back to a clean Settings, Forward to the Ledger, no dialog.
    await page.goBack();
    await expect.poll(() => pathname(page)).toBe('/settings/notifications');
    await expect(card(page)).toBeVisible();
    await page.goForward();
    await expect.poll(() => pathname(page)).toBe('/ledger');
    await expect(dialog(page)).toHaveCount(0);
    // A dirty draft reached by Back over router entries is guarded in both directions.
    await page.goBack();
    await expect.poll(() => pathname(page)).toBe('/settings/notifications');
    await makeDirty(page);
    await page.goForward();
    await expect(dialog(page)).toBeVisible();
    await choose(page, 'Stay');
    await expectStayed(page);
    await page.goBack();
    await expect(dialog(page)).toBeVisible();
    await choose(page, 'Leave without saving');
    await expectLeftTo(page, '/');
  });
});
