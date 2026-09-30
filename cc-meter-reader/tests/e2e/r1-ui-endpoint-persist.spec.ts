// r1 ui-5 (FINDINGS_R1 M1, #2/#10; seeded from AA/r1/skeptics/f10-s1/zz-skeptic10.spec.ts): Connect saves the endpoint,
// and leaving a dirty draft asks first.
//   1. A successful Connect stores the endpoint at once (an empty Name becomes the target's id): after Connect and Send
//      a test alert, the member can leave Settings and come back to it, and KV settings.notifications has criblTargetId.
//   2. While a draft is unsaved, the relay line never claims delivery ("Connected in Cribl · Save changes to send alerts
//      here"), and a tab click asks before the draft is thrown away (Stay keeps it; Leave discards it).

import { expect, test, type Locator, type Page } from '@playwright/test';
import { gotoApp, kvGet, resetMock, seedPrices, trackConsoleErrors, waitForHydration } from './helpers/index.ts';

const ALLOW = [/Outdated Optimize Dep/, /Failed to load resource: the server responded with a status of 40[34]/];

interface StoredEndpoint {
  id: string;
  name: string;
  channel?: string;
  criblTargetId?: string;
  lastTest?: { status: number };
}
async function storedEndpoints(page: Page): Promise<StoredEndpoint[]> {
  const raw = await kvGet(page, 'settings');
  return raw === null ? [] : ((JSON.parse(raw) as { notifications?: StoredEndpoint[] }).notifications ?? []).filter((e) => e.channel === 'cribl-target');
}

const card = (page: Page): Locator => page.locator('section[data-section="notifications"]');

/** A priced workspace (the judge's step 4), on Settings → Where to send alerts. */
async function openNotifications(page: Page): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await seedPrices(page);
  await page.goto('/settings/notifications', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await expect(card(page)).toBeVisible();
}

/** Opens Where to send alerts from the rail (desktop) or the section picker (phones). */
async function openNotificationsSection(page: Page): Promise<void> {
  await expect(page.locator('.mr-settings-layout')).toBeVisible();
  const link = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: /^Where to send alerts/ });
  if (await link.isVisible()) await link.click();
  else {
    await page.getByRole('button', { name: /Section/ }).click();
    await page.getByRole('option', { name: /^Where to send alerts/ }).click();
  }
  await expect(card(page)).toBeVisible();
}

/** Clicks a top tab (the in-app navigation a member uses to leave Settings). */
async function clickTab(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name, exact: true }).first().click();
}

test.describe('Connect saves the endpoint (r1 ui-5, M1)', () => {
  test('Connect + Send a test alert, leave and come back: the endpoint is stored with its target', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await openNotifications(page);
    await card(page).getByRole('button', { name: 'Add endpoint' }).click();
    // The judge's path, but with the Name left empty: Connect names it after the target.
    await page.getByTestId('endpoint-0-target').getByRole('textbox').fill('mrd_slack_finops');
    const relay = page.getByTestId('endpoint-0-relay');
    await expect(relay).toHaveAttribute('data-relay', 'missing', { timeout: 10_000 });
    await relay.getByRole('button', { name: 'Connect' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
    await expect(relay).toHaveAttribute('data-relay', 'ready');

    // Stored at once: KV holds the endpoint with its target id, and the save bar has nothing left to save.
    await expect.poll(async () => (await storedEndpoints(page)).map((e) => e.criblTargetId)).toEqual(['mrd_slack_finops']);
    expect((await storedEndpoints(page))[0].name).toBe('mrd_slack_finops');
    await expect(relay).toHaveText('Connected. Alerts reach mrd_slack_finops through Cribl.');
    await expect(card(page).locator('.mr-set-savebar')).toContainText('No unsaved changes');

    await page.getByTestId('endpoint-0-test').getByRole('button').click();
    await expect(page.getByTestId('endpoint-0-result')).toContainText('Handed to Cribl for mrd_slack_finops (200)');
    await expect.poll(async () => (await storedEndpoints(page))[0]?.lastTest?.status).toBe(200);

    // Away (a tab, in-app: nothing is dirty, so nothing asks) and back: the endpoint is still there.
    await clickTab(page, 'Receipt');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('receipt-hero').or(page.getByTestId('first-run'))).toBeVisible({ timeout: 30_000 });
    await clickTab(page, 'Settings');
    await openNotificationsSection(page);
    await expect(page.getByTestId('endpoint-0')).toBeVisible();
    await expect(page.getByTestId('endpoint-0').getByRole('heading', { level: 3 })).toHaveText('mrd_slack_finops');
    await expect(page.getByTestId('endpoints-empty')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('an unsaved draft: the relay line says to save, and a tab click asks before throwing the draft away', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await openNotifications(page);
    // A first endpoint connected (and so stored) on the target; a second, unsaved draft on the same target.
    await card(page).getByRole('button', { name: 'Add endpoint' }).click();
    await page.getByTestId('endpoint-0').getByLabel('Name').fill('FinOps Slack');
    await page.getByTestId('endpoint-0-target').getByRole('textbox').fill('mrd_slack_finops');
    await page.getByTestId('endpoint-0-relay').getByRole('button', { name: 'Connect' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
    await expect.poll(async () => (await storedEndpoints(page)).length).toBe(1);

    await card(page).getByRole('button', { name: 'Add endpoint' }).click();
    await page.getByTestId('endpoint-1').getByLabel('Name').fill('Leadership Slack');
    await page.getByTestId('endpoint-1-target').getByRole('textbox').fill('mrd_slack_finops');
    const relay = page.getByTestId('endpoint-1-relay');
    await expect(relay).toHaveAttribute('data-relay', 'ready', { timeout: 10_000 });
    // Connected in Cribl, but not stored: the line never claims alerts reach it.
    await expect(relay).toHaveText('Connected in Cribl · Save changes to send alerts here');
    await expect(relay).toHaveAttribute('data-saved', 'false');
    await expect(card(page).locator('.mr-set-savebar')).toContainText('1 unsaved change');

    // A tab click while the draft is dirty: the guard asks. Stay keeps the draft.
    await clickTab(page, 'Receipt');
    const guard = page.getByRole('dialog');
    await expect(guard).toBeVisible();
    await expect(guard).toContainText('Leave Settings with unsaved changes?');
    await expect(guard).toContainText('Where to send alerts');
    await guard.getByRole('button', { name: 'Stay' }).click();
    await expect(guard).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings\/notifications/);
    await expect(page.getByTestId('endpoint-1').getByLabel('Name')).toHaveValue('Leadership Slack');

    // Leave without saving: the tab opens, and the draft was never stored.
    await clickTab(page, 'Receipt');
    await page.getByRole('dialog').getByRole('button', { name: 'Leave without saving' }).click();
    await expect(page).not.toHaveURL(/\/settings/);
    expect((await storedEndpoints(page)).map((e) => e.name)).toEqual(['FinOps Slack']);

    // Saved drafts never ask: back, add nothing, leave.
    await clickTab(page, 'Settings');
    await expect(page.locator('.mr-settings')).toBeVisible();
    await clickTab(page, 'Flow');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/flow/);
    expect(errors()).toEqual([]);
  });
});
