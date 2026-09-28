// tests/e2e/target-id-credential.spec.ts — hackathon rule 4.5 (D57): a member's input in the release UI cannot put
// a credential into plain App KV.
//
// A judge typed a Slack incoming-webhook URL into Settings → Where to send alerts → Add endpoint → Target id and
// pressed Save changes: no error, and the mock KV `settings` then held the URL in notifications[0].criblTargetId.
// core/settings.ts now refuses it (the editor words it under the Target id field) and strips it on every write and read. This spec
// repeats the judge's steps on the release flags (VITE_MR_MOCK=1, the 'ui' runtime) and asserts the error and an
// unchanged KV document.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { gotoApp, kvGet } from './helpers/index.ts';

// Fake, assembled at run time: shaped like a Slack incoming webhook, never a real one.
const SLACK_URL = ['https:/', 'hooks.slack.com', 'services', 'T0FAKE000', 'B0FAKE000', 'fakeTokenNotReal0000'].join('/');

// Rules round 2: token shapes a judge saved through these fields (all fake, assembled at run time).
const UUID = ['6f0b2a1c', '3d4e', '4f5a', '8b9c', '0d1e2f3a4b5c'].join('-');
const HEX32 = ['e93facc0', '4764012d', '7bfb0025', '00d5d1a6'].join('');
const SENDGRID = ['SG', 'abcDEF123fake', 'xyzXYZ456fake'].join('.');
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJmYWtlIn0', 'ZmFrZXNpZw'].join('.');
const PASSWORD = ['P@ss', 'w0rd!', '2026'].join('');
// core/settings.ts CREDENTIAL_NOT_STORED_MESSAGE (its opening words).
const CREDENTIAL_COPY = "Couldn't save: that looks like a token, key or password, and Meter Reader stores no credential.";

const card = (page: Page, section: string): Locator => page.locator(`section[data-section="${section}"]`);

async function saveCard(page: Page, section: string): Promise<void> {
  await card(page, section).getByRole('button', { name: /^(Save changes|Start the meter)$/ }).click();
}

test.describe('rule 4.5: no credential through the Target id field', () => {
  test('a webhook URL typed as the target id is refused under the field, and KV settings is unchanged', async ({ page }) => {
    await gotoApp(page, '/settings/notifications');
    // A stored settings document first (the bell switched off, saved), so "unchanged" compares a real document.
    await page.getByTestId('endpoint-bell').getByRole('switch').click();
    await saveCard(page, 'notifications');
    await expect.poll(async () => (await kvGet(page, 'settings')) !== null).toBe(true);
    const before = await kvGet(page, 'settings');

    // The judge's steps: Add endpoint, a name, the webhook URL as the Target id, Save changes.
    await card(page, 'notifications').getByRole('button', { name: 'Add endpoint' }).click();
    const ep = page.getByTestId('endpoint-0');
    await ep.getByLabel('Name').fill('Ops');
    await page.getByTestId('endpoint-0-target').getByRole('textbox').fill(SLACK_URL);
    await saveCard(page, 'notifications');

    // The refusal shows under the Target id field, and the save bar asks for the fix. The editor's own shape check
    // (src/components/EndpointEditor/model.ts applyEndpoints, settings.notify.channels.target.idShape) runs after
    // core's validation and owns the field's words; core refuses the same value underneath.
    await expect(page.getByTestId('endpoint-0-target')).toContainText("Couldn't save: a target id is letters, digits, _ and - only. Meter Reader stores no URL here");
    await expect(page.getByTestId('endpoint-0-target').locator('[aria-invalid="true"]')).toHaveCount(1);
    await expect(card(page, 'notifications').locator('.mr-set-savebar')).toContainText('Fix 1 field to save.');

    // Nothing was written: the stored document is byte for byte what it was, and holds no URL.
    const after = await kvGet(page, 'settings');
    expect(after).toBe(before);
    expect(after ?? '').not.toContain('hooks.slack.com');

    // A real target id then saves, and the stored document still holds no URL.
    await page.getByTestId('endpoint-0-target').getByRole('textbox').fill('ops_slack');
    await saveCard(page, 'notifications');
    await expect.poll(async () => (await kvGet(page, 'settings')) ?? '').toContain('"criblTargetId":"ops_slack"');
    expect((await kvGet(page, 'settings')) ?? '').not.toContain('hooks.slack.com');
  });

  test('a document an older build stored with a URL as the target id loads without it, and the next save drops it', async ({ page }) => {
    await gotoApp(page, '/settings/notifications');
    await page.getByTestId('endpoint-bell').getByRole('switch').click();
    await saveCard(page, 'notifications');
    await expect.poll(async () => (await kvGet(page, 'settings')) !== null).toBe(true);
    // Write the pre-fix document straight into the emulated KV, as a build before the rule 4.5 fix could have.
    await page.evaluate(async (url) => {
      const ep = (id: string, name: string, criblTargetId: string) => ({ id, name, url: '', host: '', format: 'generic', minSeverity: 'medium', weeklyReceipt: true, enabled: true, channel: 'cribl-target', criblTargetId });
      const base = (await (await fetch('/mock-api/v1/kvstore/settings')).json()) as Record<string, unknown>;
      await fetch('/mock-api/v1/kvstore/settings', {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ ...base, notifications: [ep('a', 'Leaked', url), ep('b', 'Kept', 'ops_slack')] }),
      });
    }, SLACK_URL);
    await page.reload({ waitUntil: 'domcontentloaded' });
    // Only the id-shaped target is listed; the URL never reaches the screen.
    await expect(page.getByTestId('endpoint-0')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('endpoint-1')).toHaveCount(0);
    await expect(card(page, 'notifications')).not.toContainText('hooks.slack.com');
    // Any save rewrites the document through storableSettings: the URL leaves KV.
    await page.getByTestId('endpoint-bell').getByRole('switch').click();
    await saveCard(page, 'notifications');
    await expect.poll(async () => (await kvGet(page, 'settings')) ?? '', { timeout: 15_000 }).not.toContain('hooks.slack.com');
  });

  test('a UUID or a hex key typed as the target id, and a SendGrid key, a JWT or a password typed as the name, are refused and never stored', async ({ page }) => {
    await gotoApp(page, '/settings/notifications');
    await page.getByTestId('endpoint-bell').getByRole('switch').click();
    await saveCard(page, 'notifications');
    await expect.poll(async () => (await kvGet(page, 'settings')) !== null).toBe(true);
    const before = await kvGet(page, 'settings');

    await card(page, 'notifications').getByRole('button', { name: 'Add endpoint' }).click();
    const ep = page.getByTestId('endpoint-0');
    const targetBox = page.getByTestId('endpoint-0-target').getByRole('textbox');
    const cases: { name: string; targetId: string; field: 'target' | 'name' }[] = [
      { name: 'PagerDuty', targetId: UUID, field: 'target' },
      { name: 'PagerDuty', targetId: HEX32, field: 'target' },
      { name: SENDGRID, targetId: 'ops_mail', field: 'name' },
      { name: JWT, targetId: 'ops_mail', field: 'name' },
      { name: PASSWORD, targetId: 'ops_mail', field: 'name' },
    ];
    for (const c of cases) {
      await ep.getByLabel('Name').fill(c.name);
      await targetBox.fill(c.targetId);
      await saveCard(page, 'notifications');
      const where = c.field === 'target' ? page.getByTestId('endpoint-0-target') : ep;
      await expect(where, c.field).toContainText(CREDENTIAL_COPY);
      await expect(card(page, 'notifications').locator('.mr-set-savebar')).toContainText('Fix 1 field to save.');
      // Nothing was written: the stored document is byte for byte what it was.
      const after = await kvGet(page, 'settings');
      expect(after).toBe(before);
      for (const secret of [UUID, HEX32, SENDGRID, JWT, PASSWORD]) expect(after ?? '').not.toContain(secret);
    }

    // Words and a Cribl id then save.
    await ep.getByLabel('Name').fill('Ops mail');
    await targetBox.fill('ops_mail');
    await saveCard(page, 'notifications');
    await expect.poll(async () => (await kvGet(page, 'settings')) ?? '').toContain('"criblTargetId":"ops_mail"');
  });
});
