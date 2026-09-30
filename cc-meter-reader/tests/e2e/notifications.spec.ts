// tests/e2e/notifications.spec.ts — the Cribl-native integrations against the in-browser emulator (P1-O01).
//
// The emulator now answers what Cribl.Cloud measured live (docs/NOTIFICATIONS.md §2): the notification bell
// (`/system/messages`: 200, 409 on a repeated id, PATCH 405), `/notification-targets` (the built-in bell target,
// a webhook target and a Slack target, each with its full configuration, URLs included), the Search relay
// (saved search + notification in `default_search`, `POST /search/notifications` routing only ids that start
// with `SEARCH_NOTIFICATION_<notificationId>_`), and the What-if dry run (`GET …/system/samples/<id>/content`
// with the rig's Datagen samples, `POST /m/<gid>/preview` in pipe mode). So these flows run end to end on the
// dev server and in every Playwright project, with no fetch patching:
//   • the bell's "Send a test alert" lands in the emulated bell;
//   • a notification target: Load targets → pick → Connect (a confirmation naming both objects) → test send,
//     which the emulated notification service hands to the target's URL;
//   • the dry-run basis on the What-if view, measured on the Source's own sample events;
//   • an incident on a Leader WITHOUT the bell API says why it went nowhere, on its card and in the rail.

import { expect, test, type Page } from '@playwright/test';
import {
  RIG_PRICES,
  bellMessages,
  clearSink,
  gotoApp,
  mockCalls,
  mockControl,
  resetCalls,
  seedPrices,
  setNotificationApis,
  setTheme,
  sinkDeliveries,
  trackConsoleErrors,
  type Theme,
} from './helpers/index.ts';

/** The emulated webhook target's URL (src/mock/fixtures.ts MOCK_WEBHOOK_TARGET_URL): never shown in the page. */
const TARGET_URL_PATH = 'meter-reader-mock-target';
const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1440) <= 640;
const width = (page: Page): number => page.viewportSize()?.width ?? 1440;

/** Screenshots of a visible change, light and dark, at this project's width (1440 desktop, 390 phone). */
async function shoot(page: Page, name: string, locate?: () => ReturnType<Page['locator']>): Promise<void> {
  // Chromium owns the files (desktop 1440, phone 390): Firefox and WebKit would overwrite the -1440 ones.
  if (![390, 1440].includes(width(page)) || !['chromium', 'mobile'].includes(test.info().project.name)) return;
  for (const theme of ['light', 'dark'] as Theme[]) {
    await setTheme(page, theme);
    await page.waitForTimeout(250);
    const path = `tests/report/screens/wave1-o-${name}-${theme}-${width(page)}.png`;
    if (locate) await locate().screenshot({ path });
    else {
      // A full-page shot keeps sticky chrome where the scroll left it: start from the top.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path, fullPage: true });
    }
  }
  await setTheme(page, 'light');
}

test.describe('Cribl notifications in the emulator', () => {
  test('the bell: a Settings test lands in the Cribl notification bell', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/settings/notifications');
    await resetCalls(page);
    const bell = page.getByTestId('endpoint-bell');
    await expect(bell).toBeVisible();
    await page.getByTestId('endpoint-bell-test').getByRole('button').click();
    await expect(page.getByTestId('endpoint-bell-result')).toHaveText(
      'Posted to the Cribl notification bell (200). Open the bell in the Cribl header to see it.',
    );
    const messages = await bellMessages(page);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ severity: 'info', title: expect.stringMatching(/^Test: /) }); // founder-build r1 core-11 (m2): tests post as info
    expect(messages[0].id).toMatch(/^meter-reader-test-/);
    expect((await mockCalls(page)).byRoute['POST /system/messages']).toBe(1);
    expect(errors()).toEqual([]);
  });

  test('the bell on a Leader without it: the test says so and nothing is posted', async ({ page }) => {
    const errors = trackConsoleErrors(page, [/Failed to load resource: .*\b404\b/]);
    await gotoApp(page, '/settings/notifications');
    await setNotificationApis(page, false);
    await page.getByTestId('endpoint-bell-test').getByRole('button').click();
    await expect(page.getByTestId('endpoint-bell-result')).toHaveText(
      'This workspace has no such Cribl API (404). Cribl notification channels need Cribl.Cloud.',
    );
    expect(await bellMessages(page)).toEqual([]);
    expect(errors()).toEqual([]);
  });

  test('a notification target: Load targets, Connect after a confirmation, then a test the target receives', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/settings/notifications');
    await page.getByRole('button', { name: 'Add endpoint' }).first().click();
    const ep = page.getByTestId('endpoint-0');
    await ep.getByLabel('Name').fill('FinOps webhook');
    // D57: every list endpoint is a Cribl notification target (no build stores a webhook URL).
    await expect(ep).toHaveAttribute('data-channel', 'cribl-target');

    // Listing is explicit: nothing asked Cribl for its targets until the member presses Load targets.
    expect((await mockCalls(page)).byRoute['GET /notification-targets'] ?? 0).toBe(0);
    await ep.getByRole('button', { name: 'Load targets' }).click();
    await expect(page.getByTestId('endpoint-0-targets')).toHaveAttribute('data-targets', 'ok');
    await expect(page.getByTestId('endpoint-0-targets')).toContainText('2 notification targets loaded. Pick one, or type an id.');
    // The Leader answered every target's full configuration; the page keeps only id, type and description.
    await expect(page.locator('main')).not.toContainText(TARGET_URL_PATH);
    await expect(page.locator('main')).not.toContainText('not-a-real-secret');

    await page.getByTestId('endpoint-0-target').getByRole('button').click();
    await page.getByRole('option', { name: /mrd_webhook_site/ }).click();
    const relay = page.getByTestId('endpoint-0-relay');
    await expect(relay).toHaveAttribute('data-relay', 'missing');
    await expect(relay).toContainText('Not connected yet.');
    // A test before the relay exists cannot be sent (P1-G09): the button waits, and says why beside it.
    await clearSink(page);
    await expect(page.getByTestId('endpoint-0-test').getByRole('button')).toBeDisabled();
    await expect(page.getByTestId('endpoint-0-connect-first')).toHaveText('Connect first');
    expect(await sinkDeliveries(page)).toEqual([]);

    // Connect: the confirmation names both objects before anything is written (AGENTS.md).
    await relay.getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Connect mrd_webhook_site to Meter Reader?');
    await expect(dialog).toContainText('meter_reader_alert_relay');
    await expect(dialog).toContainText('meter_reader_relay_mrd_webhook_site');
    expect((await mockCalls(page)).byRoute['POST /m/:gid/search/saved'] ?? 0).toBe(0);
    await dialog.getByRole('button', { name: 'Connect' }).click();
    await expect(relay).toHaveAttribute('data-relay', 'ready');
    await expect(relay).toHaveText('Connected. Alerts reach mrd_webhook_site through Cribl.');
    const state = await mockControl(page, { action: 'state' });
    expect(state.relay).toEqual([{ id: 'meter_reader_relay_mrd_webhook_site', savedQueryId: 'meter_reader_alert_relay', targets: ['mrd_webhook_site'] }]);

    // The test alert: handed to Cribl, which delivers it to the target's URL.
    await page.getByTestId('endpoint-0-test').getByRole('button').click();
    await expect(page.getByTestId('endpoint-0-result')).toHaveText(
      'Handed to Cribl for mrd_webhook_site (200). Cribl delivers it from its notification service.',
    );
    const [hit] = await sinkDeliveries(page);
    expect(hit).toMatchObject({ via: 'cribl-target', host: 'webhook.site' });
    expect(hit.url).toContain(TARGET_URL_PATH);
    const body = hit.json as { id: string; notificationId: string; message: string; meter_reader?: { event?: string } };
    expect(body.id).toMatch(/^SEARCH_NOTIFICATION_meter_reader_relay_mrd_webhook_site_/);
    expect(body.notificationId).toBe('meter_reader_relay_mrd_webhook_site');
    expect(body.message).toMatch(/^Test: /);
    await expect(page.getByText('What the target receives')).toBeVisible();

    // The shot waits for the "Target connected" toast to leave; phones get the whole page (the sticky header
    // would sit over an element taller than the viewport).
    await expect(page.getByText('Target connected')).toBeHidden({ timeout: 15_000 });
    await shoot(page, 'notify-target', isPhone(page) ? undefined : () => page.getByTestId('endpoint-0'));
    // Checking a relay that does not exist yet is a GET that answers 404 by design (docs/NOTIFICATIONS.md §2.3).
    expect(errors().filter((e) => !/status of 404 .*\/mock-api\/v1\/m\/default_search\/search\/saved\/meter_reader_alert_relay\)$/.test(e))).toEqual([]);
  });

  test('the What-if dry run measures the pack on sample events of the Source itself', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    // Onto the app origin through the lightest view, then price the rig and open What if.
    await gotoApp(page, '/first-run');
    await seedPrices(page);
    await gotoApp(page, '/whatif');
    await expect(page.getByTestId('whatif-basis')).toHaveAttribute('data-basis', 'similar', { timeout: 30_000 });
    await resetCalls(page);
    await page.getByRole('button', { name: 'Dry run on sample events' }).click();
    const basis = page.getByTestId('whatif-basis');
    await expect(basis).toHaveAttribute('data-basis', 'dry-run', { timeout: 30_000 });
    await expect(page.getByTestId('whatif-dryrun')).toHaveAttribute('data-status', 'measured');
    // 33 Windows Security events from the rig's own sample, through the pipeline the similar stream runs.
    await expect(basis).toContainText(/Measured by dry run on 33 sample events of this source: [\d.]+ KB in, [\d.]+ KB out through/);
    await expect(page.getByTestId('whatif-results')).toContainText('33%');
    const calls = await mockCalls(page);
    expect(calls.byRoute['GET /m/:gid/system/samples/:id/content']).toBe(1);
    expect(calls.byRoute['POST /m/:gid/preview']).toBe(1);
    await basis.scrollIntoViewIfNeeded();
    await shoot(page, 'whatif-dryrun', () => basis);
    expect(errors()).toEqual([]);
  });
});

/**
 * A regression the tab's own sweep catches: the payments trim broke `minutesAgo` minutes ago, inside the hour
 * the first sweep backfills, so the detector opens the incident on catch-up and the sweep delivers it.
 */
async function openIncident(page: Page, path: string): Promise<void> {
  await gotoApp(page, '/first-run');
  await mockControl(page, { action: 'breakTrim', pipelineId: 'mrd_pay_sample', minutesAgo: 20 });
  await seedPrices(page, RIG_PRICES);
  await gotoApp(page, path);
}

test.describe('an alert the bell could not deliver', () => {
  test.setTimeout(120_000);

  test('says why on its card and in the rail; with the bell it reads sent', async ({ page }) => {
    const errors = trackConsoleErrors(page, [/Failed to load resource: .*\b404\b/]);
    await gotoApp(page, '/first-run');
    await setNotificationApis(page, false);
    await openIncident(page, '/');
    const card = page.getByTestId('receipt-alerts').locator('.mr-inc').first();
    await expect(card).toBeVisible({ timeout: 90_000 });
    const line = 'Not delivered: Cribl notification API unavailable (404).';
    await expect(card).toContainText(line, { timeout: 30_000 });
    await expect(card.locator('[data-tone="blocked"]')).toHaveText(line);
    await shoot(page, 'alert-not-delivered-card', () => page.getByTestId('receipt-alerts'));

    await page
      .getByRole('navigation')
      .getByRole('link', { name: /ledger/i })
      .first()
      .click();
    const rail = page.getByTestId('incidents-rail');
    await expect(rail).toContainText(line, { timeout: 30_000 });
    await shoot(page, 'alert-not-delivered-rail', () => rail);
    // The bell was tried once per sweep (the rest of the pass skipped it), and nothing reached the bell.
    expect(await bellMessages(page)).toEqual([]);
    expect(errors()).toEqual([]);
  });

  test('with the bell on, the same alert reads sent to Cribl notifications', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openIncident(page, '/ledger');
    const rail = page.getByTestId('incidents-rail');
    await expect(rail.locator('.mr-inc').first()).toBeVisible({ timeout: 90_000 });
    await expect(rail).toContainText(/Sent to Cribl notifications ✓/, { timeout: 30_000 });
    const messages = await bellMessages(page);
    expect(messages.length).toBeGreaterThan(0);
    // On a Monday after 12:00 UTC the tab's weekly receipt can reach the bell first (meter-reader-receipt-…): find the
    // alert's message among them rather than assuming it is the first.
    expect(messages.map((m) => m.id).find((id) => id.startsWith('meter-reader-inc_'))).toMatch(/^meter-reader-inc_.*-(high|medium)$/);
    expect(errors()).toEqual([]);
  });
});
