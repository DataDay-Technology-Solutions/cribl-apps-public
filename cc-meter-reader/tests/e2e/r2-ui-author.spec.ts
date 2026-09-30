// r2 ui-15 (r1 carries H2 + core-4's e2e; FOUNDER_PLAN row 10, contract C5): a commit made through the API carries its
// OAuth client id as the author ("<client id>@clients"). Every surface prints it as "API client ··<last four>" — never
// the id — or as the name a member gave that client (settings.humanize "client:<last four>"). The emulator can now make
// such a commit (breakTrim's `author`, src/mock/emulator.ts).

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, kvGet, mockControl, seedPrices, RIG_PRICES } from './helpers/index.ts';

const CLIENT = { name: '7f3a9c2e4b1d1r2s@clients', email: '' };
const FALLBACK = 'API client ··1r2s';

async function apiClientIncident(page: Page): Promise<void> {
  await gotoApp(page, '/first-run');
  await mockControl(page, { action: 'breakTrim', pipelineId: 'mrd_pay_sample', minutesAgo: 20, author: CLIENT });
  await seedPrices(page, RIG_PRICES);
  await gotoApp(page, '/');
  await expect(page.getByTestId('receipt-alerts').locator('.mr-inc').first()).toBeVisible({ timeout: 90_000 });
}

async function noClientId(page: Page, where: string): Promise<void> {
  const text = await page.locator('body').innerText();
  expect(text, `${where}: the client id is never printed`).not.toMatch(/@clients/);
}

test.describe('ui-15: an API client\'s commit reads as the client, never its id', () => {
  test.setTimeout(180_000);

  test('the Receipt card, the Ledger rail, Changes, the timeline card and the presenter', async ({ page }) => {
    await apiClientIncident(page);
    const card = page.getByTestId('receipt-alerts').locator('.mr-inc').first();
    await expect(card).toContainText(FALLBACK);
    await noClientId(page, 'Receipt');

    await gotoApp(page, '/ledger');
    await expect(page.getByTestId('incidents-rail')).toContainText(FALLBACK, { timeout: 30_000 });
    const changes = page.getByTestId('changes-list');
    await expect(changes).toContainText(FALLBACK);
    await changes.locator('[data-changes-row]').filter({ hasText: FALLBACK }).first().click();
    await expect(page.getByTestId('commit-card')).toContainText(FALLBACK);
    await noClientId(page, 'Ledger');

    await gotoApp(page, '/?present=1');
    await page.waitForTimeout(1_500);
    await noClientId(page, 'presenter');
  });

  test('a client a member named reads by its name', async ({ page }) => {
    await apiClientIncident(page);
    const settings = JSON.parse((await kvGet(page, 'settings')) ?? '{}') as { humanize?: Record<string, string> };
    const named = { ...settings, humanize: { ...(settings.humanize ?? {}), 'client:1r2s': 'CI pipeline' } };
    await page.evaluate(async (doc) => {
      const r = await fetch('/mock-api/v1/kvstore/settings', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(doc) });
      if (r.status >= 300) throw new Error(`PUT settings → ${r.status}`);
    }, named);
    await gotoApp(page, '/');
    const card = page.getByTestId('receipt-alerts').locator('.mr-inc').first();
    await expect(card).toContainText('CI pipeline', { timeout: 30_000 });
    await expect(card).not.toContainText(FALLBACK);
    await gotoApp(page, '/ledger');
    await expect(page.getByTestId('changes-list')).toContainText('CI pipeline');
    await noClientId(page, 'Ledger');
  });
});
