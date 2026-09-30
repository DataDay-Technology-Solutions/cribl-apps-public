// tests/e2e/settings-notify.spec.ts — Settings frame, Alerts, Where to send alerts, Runtime (EPIC_AUDIT WP-G2:
// P0-10, P1-G05, P1-G06, P1-G07, P1-G08, P1-G09).
//
// Runs against the in-browser Cribl emulator (VITE_MR_MOCK=1, release build flags: the 'ui' runtime, no
// proxies.yml), with its Cribl notification APIs on: the bell, the targets list and the Search relay a target needs
// (missing until Connect). D57: every list endpoint is a Cribl notification target. Each test gets a fresh browser
// context, so the emulated Leader and its KV start empty.
//
// The screenshot test (chromium only) writes tests/report/screens/wave1-g2-<name>-<theme>-<width>.png.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { clearSink, gotoApp, kvGet, mockControl, seedPrices, setTheme, trackConsoleErrors, waitForHydration, waitForMock, type Theme } from './helpers/index.ts';

/** The dev server re-optimizing a dependency mid-run is an environment artifact, not an app error. */
const ALLOW = [/Outdated Optimize Dep/, /Failed to load resource: the server responded with a status of 40[34]/];

interface StoredSettings {
  thresholds?: Record<string, number>;
  excludedObjectKeys?: string[];
  notifications?: { id: string; name: string; url: string; channel?: string; criblTargetId?: string; lastTest?: { status: number } }[];
}
async function settingsDoc(page: Page): Promise<StoredSettings | null> {
  const raw = await kvGet(page, 'settings');
  return raw === null ? null : (JSON.parse(raw) as StoredSettings);
}

const card = (page: Page, section: string): Locator => page.locator(`section[data-section="${section}"]`);
const saveBar = (page: Page, section: string): Locator => card(page, section).locator('.mr-set-savebar');

async function saveCard(page: Page, section: string): Promise<void> {
  // A never-priced workspace's first Prices save reads "Start the meter" (P2-W09).
  await card(page, section).getByRole('button', { name: /^(Save changes|Start the meter)$/ }).click();
}

async function addEndpoint(page: Page): Promise<void> {
  await card(page, 'notifications').getByRole('button', { name: 'Add endpoint' }).click();
}

/** Names a new endpoint's Cribl target and connects its relay (confirmed), so a test can be sent (D57: targets only). */
async function connectTarget(page: Page, index: number, name: string, targetId = 'mrd_slack_finops'): Promise<void> {
  await page.getByTestId(`endpoint-${index}`).getByLabel('Name').fill(name);
  await page.getByTestId(`endpoint-${index}-target`).getByRole('textbox').fill(targetId);
  await page.getByTestId(`endpoint-${index}-relay`).getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId(`endpoint-${index}-relay`)).toHaveAttribute('data-relay', 'ready');
  // M1 (founder-build r1 ui-5): a Connect that succeeded stores the endpoint at once; nothing is left to save.
  await expect.poll(async () => (await settingsDoc(page))?.notifications?.some((n) => n.criblTargetId === targetId && n.name === name)).toBe(true);
  await expect(saveBar(page, 'notifications')).toContainText('No unsaved changes');
}

/** Opens a section from the rail (desktop) or the section picker (phones). */
async function openSection(page: Page, label: string, section: string): Promise<void> {
  const link = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: new RegExp(`^${label}`) });
  if (await link.isVisible()) await link.click();
  else {
    await page.getByRole('button', { name: /Section/ }).click();
    await page.getByRole('option', { name: new RegExp(`^${label}`) }).click();
  }
  await expect(card(page, section)).toBeVisible();
}

/** Every visible element in the Settings content painted in a green (hue 80–175°), outside money figures. */
async function greenElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const parse = (c: string): [number, number, number, number] | null => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const isGreen = (c: string): boolean => {
      const v = parse(c);
      if (!v || v[3] < 0.15) return false;
      const [r, g, b] = [v[0] / 255, v[1] / 255, v[2] / 255];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      if (d < 0.08) return false;
      const s = d / (1 - Math.abs(2 * l - 1));
      if (s < 0.25) return false;
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
      return h >= 80 && h <= 175;
    };
    const out: string[] = [];
    const root = document.querySelector('.mr-settings-content');
    if (!root) return ['no .mr-settings-content'];
    for (const el of root.querySelectorAll<HTMLElement | SVGElement>('*')) {
      if (el.closest('[data-tone="saved"]')) continue; // money figures keep the one green (DESIGN_BRIEF 2)
      // The Slack preview is a facsimile of Slack's own message (DESIGN_BRIEF 5.8): its primary button and
      // the recovery glyph are Slack's green, not a status colour of ours. Nothing else in it is exempt.
      if (el.closest('[data-testid="slack-preview"] :is(.mr-slack-button--primary, .mr-slack-glyph--green)')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
      const paints: [string, string][] = [['background', cs.backgroundColor]];
      if (hasText) paints.push(['color', cs.color]);
      if (parseFloat(cs.borderTopWidth) > 0) paints.push(['border', cs.borderTopColor]);
      if (el instanceof SVGElement) paints.push(['fill', cs.fill], ['stroke', cs.stroke]);
      for (const [what, value] of paints) {
        if (!isGreen(value)) continue;
        const host = el.closest('[class], [data-testid]');
        const where = host && host !== el ? ` in <${host.tagName.toLowerCase()} class="${host.getAttribute('class') ?? ''}" data-testid="${host.getAttribute('data-testid') ?? ''}">` : '';
        out.push(`${what} ${value} on <${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}">${where} "${(el.textContent ?? '').trim().slice(0, 40)}"`);
      }
    }
    return [...new Set(out)];
  });
}

test.describe('settings — where to send alerts (WP-G2)', () => {
  test('P0-10 / D57: a new endpoint is a Cribl notification target; nothing offers a direct webhook or a URL field', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings/notifications');
    const empty = page.getByTestId('endpoints-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('notification target');
    await expect(card(page, 'notifications')).not.toContainText('Slack incoming webhook');

    await addEndpoint(page);
    const ep = page.getByTestId('endpoint-0');
    await expect(ep).toHaveAttribute('data-channel', 'cribl-target');
    await expect(ep.getByRole('radio')).toHaveCount(0);
    await expect(page.getByTestId('endpoint-0-url')).toHaveCount(0);
    await expect(ep.getByTestId('storage-sentence')).toHaveCount(0);
    await expect(card(page, 'notifications')).not.toContainText('Direct webhook ·');
    // Where direct webhooks live instead: the runner's .env (hackathon rule 4.5: no credential in plain KV).
    await expect(page.getByTestId('runner-webhooks')).toContainText('Meter Reader stores no webhook URL');
    expect(errors()).toEqual([]);
  });

  test('P1-G05: Add endpoint is not red before a keystroke; blur and Save reveal errors', async ({ page }) => {
    await gotoApp(page, '/settings/notifications');
    await addEndpoint(page);
    const ep = page.getByTestId('endpoint-0');
    await expect(ep).toBeVisible();
    await expect(ep.locator('[aria-invalid="true"]')).toHaveCount(0);
    await expect(ep).not.toContainText("Couldn't save");
    await expect(saveBar(page, 'notifications')).toContainText('1 unsaved change');
    await expect(saveBar(page, 'notifications')).not.toContainText('Fix');

    // Blurring the empty name shows exactly that one error.
    await ep.getByLabel('Name').focus();
    await ep.getByLabel('Name').blur();
    await expect(ep.locator('[aria-invalid="true"]')).toHaveCount(1);
    await expect(ep).toContainText("Couldn't save: give this endpoint a name.");
    await expect(saveBar(page, 'notifications')).toContainText('Fix 1 field to save.');

    // Save shows the rest (the target id) and writes nothing.
    await saveCard(page, 'notifications');
    await expect(ep.locator('[aria-invalid="true"]')).toHaveCount(2);
    await expect(saveBar(page, 'notifications')).toContainText('Fix 2 fields to save.');
    expect(await kvGet(page, 'settings')).toBeNull();

    // Ten fresh endpoints read as ten unsaved changes, never "Fix 16 fields".
    await saveBar(page, 'notifications').getByRole('button', { name: 'Discard' }).click();
    for (let i = 0; i < 10; i++) await addEndpoint(page);
    await expect(saveBar(page, 'notifications')).toContainText('10 unsaved changes');
    await expect(card(page, 'notifications').locator('[aria-invalid="true"]')).toHaveCount(0);
  });

  test('rule 4.5 / D57: a webhook URL typed into Target id or Name is refused on Save and never reaches KV', async ({ page }) => {
    // Shaped like a Slack incoming webhook (the mock's own fake one): its token would be its path.
    const url = 'https://hooks.slack.com/services/mock-team/mock-hook/not-a-real-secret';
    await gotoApp(page, '/settings/notifications');
    await addEndpoint(page);
    const ep = page.getByTestId('endpoint-0');
    await ep.getByLabel('Name').fill('Ops Slack');
    await ep.getByLabel('Target id').fill(url);
    await saveCard(page, 'notifications');
    await expect(ep).toContainText("Couldn't save: a target id is letters, digits, _ and - only.");
    await expect(ep.getByLabel('Target id')).toHaveAttribute('aria-invalid', 'true');
    // Nothing is connected or tested with it either: no relay line, and the test waits for a target.
    await expect(page.getByTestId('endpoint-0-relay')).toHaveCount(0);
    await expect(ep.getByRole('button', { name: 'Send a test alert' })).toBeDisabled();
    expect(await kvGet(page, 'settings')).toBeNull();

    // The same URL as the name is refused too; a real id then saves, and KV holds no URL anywhere.
    await ep.getByLabel('Target id').fill('mrd_slack_finops');
    await ep.getByLabel('Name').fill(url);
    await saveCard(page, 'notifications');
    await expect(ep).toContainText("Couldn't save: a name can't be a web address.");
    expect(await kvGet(page, 'settings')).toBeNull();
    await ep.getByLabel('Name').fill('Ops Slack');
    await saveCard(page, 'notifications');
    await expect.poll(async () => (await settingsDoc(page))?.notifications?.[0]?.criblTargetId).toBe('mrd_slack_finops');
    // (the QR link is a URL by design; the endpoints hold none)
    expect(JSON.stringify((await settingsDoc(page))?.notifications)).not.toContain('://');
  });

  test('P1-G06: never "No endpoints yet" while settings load; one primary button; one line on direct webhooks', async ({ page }) => {
    await gotoApp(page, '/settings/notifications');
    // A valid settings document first (switch the bell off and save), then three saved Cribl targets in it.
    await page.getByTestId('endpoint-bell').getByRole('switch').click();
    await saveCard(page, 'notifications');
    await expect.poll(async () => (await settingsDoc(page)) !== null).toBe(true);
    await page.evaluate(async () => {
      const ep = (id: string, name: string) => ({ id, name, url: '', host: '', format: 'generic', minSeverity: 'medium', weeklyReceipt: true, enabled: true, channel: 'cribl-target', criblTargetId: 'mrd_slack_finops' });
      const base = (await (await fetch('/mock-api/v1/kvstore/settings')).json()) as Record<string, unknown>;
      await fetch('/mock-api/v1/kvstore/settings', {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ ...base, notifications: [ep('a', 'One'), ep('b', 'Two'), ep('c', 'Three')] }),
      });
    });
    // Then a slow Leader: the section waits for the saved list instead of calling it empty.
    await mockControl(page, { action: 'config', options: { latencyMs: 2500 } });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMock(page);
    await expect(page.getByTestId('notifications-loading')).toBeVisible();
    await expect(page.getByTestId('endpoints-empty')).toHaveCount(0);
    await waitForHydration(page);
    await expect(page.getByTestId('endpoint-2')).toBeVisible();
    await expect(page.getByTestId('endpoints-empty')).toHaveCount(0);
    await expect(page.getByTestId('notifications-loading')).toHaveCount(0);
    await mockControl(page, { action: 'config', options: { latencyMs: 0 } });

    // Exactly one primary button on the page: Save changes.
    await expect(page.locator('main button[data-variant="primary"]')).toHaveCount(1);
    await expect(page.locator('main button[data-variant="primary"]')).toHaveText('Save changes');
    // One description line above the first control; no storage sentence (D57: nothing stores a URL), and one note
    // saying where direct webhooks live instead.
    await expect(page.getByTestId('storage-sentence')).toHaveCount(0);
    await expect(page.getByTestId('runner-webhooks')).toHaveCount(1);
    await expect(card(page, 'notifications').locator('.mr-set-card-body > p')).toHaveCount(0);
  });

  test('P1-G06: the empty list is one compact line under the bell, with one Add endpoint', async ({ page }) => {
    await gotoApp(page, '/settings/notifications');
    const empty = page.getByTestId('endpoints-empty');
    await expect(empty).toContainText('No endpoints yet. Alerts still reach the Cribl bell.');
    await expect(page.locator('main').getByRole('button', { name: 'Add endpoint' })).toHaveCount(1);
    await expect(page.locator('main button[data-variant="primary"]')).toHaveCount(1);
    // A compact block: its words and padding, no ghost rows (the old empty state was a four-row table ghost).
    await expect(empty.locator('.mr-ghost, [class*="skeleton" i]')).toHaveCount(0);
    const box = (await empty.boundingBox())!;
    const words = (await empty.locator('.mr-nt-empty-copy').boundingBox())!;
    expect(box.height - words.height, 'padding only around the words').toBeLessThanOrEqual(40);
    if ((page.viewportSize()?.width ?? 0) >= 1024) expect(box.height, 'two lines of words at desktop widths').toBeLessThan(140);
  });

  test('P1-G08: no success green outside money figures on any Settings section; Remove is neutral', async ({ page }) => {
    await gotoApp(page, '/settings/prices');
    await seedPrices(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMock(page);
    await waitForHydration(page);
    await expect(page.getByTestId('price-row-mrd_siem_prod')).toBeVisible({ timeout: 40_000 });
    expect(await greenElements(page), 'prices').toEqual([]);

    for (const [label, section] of [
      ['Budgets', 'budgets'],
      ['Cribl cost', 'cost'],
      ['Alerts', 'alerts'],
      ['Runtime', 'runtime'],
    ] as const) {
      await openSection(page, label, section);
      await page.waitForTimeout(300);
      expect(await greenElements(page), section).toEqual([]);
    }

    await openSection(page, 'Where to send alerts', 'notifications');
    await addEndpoint(page);
    await connectTarget(page, 0, 'Ops Slack');
    const ep = page.getByTestId('endpoint-0');
    await page.getByTestId('endpoint-0-test').getByRole('button').click();
    await expect(page.getByTestId('endpoint-0-result')).toContainText('Handed to Cribl for mrd_slack_finops (200)');
    await page.getByTestId('endpoint-bell-test').getByRole('button').click();
    await expect(page.getByTestId('endpoint-bell-result')).toBeVisible();
    await page.getByTestId('weekly-receipt').getByRole('button', { name: 'Send the last 7 days now' }).click();
    await expect(page.getByTestId('weekly-result')).toBeVisible();
    expect(await greenElements(page), 'notifications').toEqual([]);

    // Remove reads as a neutral action (grey text, no hue); the danger waits for the confirmation dialog.
    const removeColor = await ep.getByRole('button', { name: 'Remove' }).evaluate((b) => getComputedStyle(b).color);
    const [r, g, b] = (removeColor.match(/\d+/g) ?? []).map(Number);
    expect(Math.max(r, g, b) - Math.min(r, g, b), `Remove is ${removeColor}`).toBeLessThan(24);
  });

  test('P1-G08: what the target receives fits the page at 390 px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, '/settings/notifications');
    await addEndpoint(page);
    await connectTarget(page, 0, 'Ops Slack');
    await clearSink(page);
    await page.getByTestId('endpoint-0-test').getByRole('button').click();
    await expect(page.getByTestId('endpoint-0-result')).toContainText('Handed to Cribl for mrd_slack_finops (200)');
    const preview = page.getByTestId('endpoint-0').locator('.mr-ep-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('What the target receives');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('P1-G09: an unconnected target cannot send a test; the last test reads as sent or failed; the weekly hint fits the tab', async ({ page }) => {
    await gotoApp(page, '/settings/notifications');
    await addEndpoint(page);
    const ep = page.getByTestId('endpoint-0');
    await ep.getByLabel('Name').fill('Pager');
    await page.getByTestId('endpoint-0-target').getByRole('textbox').fill('ops-slack');
    await expect(page.getByTestId('endpoint-0-relay')).toHaveAttribute('data-relay', 'missing', { timeout: 10_000 });
    await expect(page.getByTestId('endpoint-0-test').getByRole('button')).toBeDisabled();
    await expect(ep.locator('.mr-ep-test')).toContainText('Connect first');
    await expect(ep).not.toContainText('Connect this target first, then send a test.');

    // The target's weekly-receipt caption says what the open tab does, not a schedule it keeps.
    await expect(ep).toContainText('After Monday 12:00 UTC, any day that week');
    await expect(ep).not.toContainText('24 hours after Monday');
    await expect(ep).not.toContainText('Mondays, 12:00 UTC');
    await page.getByTestId('endpoint-0').getByRole('button', { name: 'Remove' }).click();
    await addEndpoint(page);
    await connectTarget(page, 0, 'Ops Slack');
    await page.getByTestId('endpoint-0-test').getByRole('button').click();
    await expect(page.getByTestId('endpoint-0-result')).toContainText('Handed to Cribl for mrd_slack_finops (200)');
    await expect.poll(async () => (await settingsDoc(page))?.notifications?.[0]?.lastTest?.status).toBe(200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMock(page);
    await waitForHydration(page);
    await expect(page.getByTestId('endpoint-0').locator('.mr-ep-test')).toContainText(/Last test sent \(200\) · /);
  });

  test("P1-G09: sending the weekly receipt with only the bell reports the bell's line", async ({ page }) => {
    await gotoApp(page, '/settings/notifications');
    await page.getByTestId('weekly-receipt').getByRole('button', { name: 'Send the last 7 days now' }).click();
    const result = page.getByTestId('weekly-result');
    await expect(result).toBeVisible();
    await expect(result).not.toContainText('0 endpoints');
    await expect(result).toContainText('Cribl notifications:');
    // Every line wraps inside the card, at 390 px too.
    for (const line of await result.locator('li').all()) {
      expect(await line.evaluate((el) => el.scrollWidth - el.clientWidth), await line.innerText()).toBeLessThanOrEqual(0);
    }
    const resultBox = (await result.boundingBox())!;
    const cardBox = (await card(page, 'notifications').boundingBox())!;
    expect(resultBox.x + resultBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
  });
});

test.describe('settings — alerts, save bar and section rail (WP-G2)', () => {
  test('P1-G09: Alerts shows the regression floor, recovery, warm-up and excluded objects, wired to settings', async ({ page }) => {
    await gotoApp(page, '/settings?section=alerts');
    await seedPrices(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMock(page);
    await waitForHydration(page);
    const alerts = card(page, 'alerts');
    await expect(page.getByTestId('alerts-regressionFloorPerDay')).toHaveValue('5');
    await expect(page.getByTestId('alerts-recoveryMinutes')).toHaveValue('5');
    await expect(page.getByTestId('alerts-warmupSamples')).toHaveValue('10');
    await page.getByTestId('alerts-regressionFloorPerDay').fill('12.50');
    await page.getByTestId('alerts-recoveryMinutes').fill('7');
    await page.getByTestId('alerts-warmupSamples').fill('20');

    // Exclude one object from the snapshot's flows (the picker lists them once the first sweep lands).
    const picker = page.getByTestId('alerts-exclude-picker');
    await expect(picker.getByRole('button')).toBeEnabled({ timeout: 40_000 });
    await picker.getByRole('button').click();
    await page.getByRole('option', { name: /Pipeline · / }).first().click();
    await expect(page.getByTestId('alerts-excluded').locator('[data-object-key]')).toHaveCount(1);
    await saveCard(page, 'alerts');
    await expect
      .poll(async () => {
        const s = await settingsDoc(page);
        return [s?.thresholds?.regressionMinCentsPerDay, s?.thresholds?.recoveryMinutes, s?.thresholds?.warmupSamples, s?.excludedObjectKeys?.length];
      })
      .toEqual([1250, 7, 20, 1]);
    expect((await settingsDoc(page))?.excludedObjectKeys?.[0]).toMatch(/^pipe:/);

    // Good news takes one column (beside Budget pace) rather than spanning both columns for one switch.
    if ((page.viewportSize()?.width ?? 0) >= 1440) {
      const grid = (await alerts.locator('.mr-al-grid').boundingBox())!;
      const budget = (await alerts.locator('[data-group="budget"]').boundingBox())!;
      const good = (await alerts.locator('[data-group="goodnews"]').boundingBox())!;
      expect(Math.abs(budget.y - good.y)).toBeLessThan(2);
      expect(good.width).toBeLessThan(grid.width * 0.6);
    }
    // Every group is one column wide at 1440+, so none spans the grid.
    for (const group of await alerts.locator('.mr-al-group').all()) {
      if ((page.viewportSize()?.width ?? 0) < 1440) break;
      const box = (await group.boundingBox())!;
      const grid = (await alerts.locator('.mr-al-grid').boundingBox())!;
      expect(box.width).toBeLessThan(grid.width * 0.6);
    }
  });

  test('P1-G07: at 390 px the dirty save bar stays in view; a failed save keeps its line after the toast is gone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, '/settings?section=alerts');
    await page.getByTestId('alerts-regressionPoints').fill('20');
    const bar = saveBar(page, 'alerts');
    await expect(bar).toContainText('1 unsaved change');
    const box = (await bar.boundingBox())!;
    expect(box.y, 'save bar top in view').toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, 'save bar bottom in view').toBeLessThanOrEqual(844);
    // The changed field carries the dirty marker; the rail/picker says the section has unsaved changes.
    await expect(page.locator('.mr-al-field[data-dirty="true"]')).toHaveCount(1);

    await mockControl(page, { action: 'fault', method: 'PUT', pattern: 'kvstore/settings', status: 403, times: 1 });
    await saveCard(page, 'alerts');
    const toast = page.getByText("Couldn't save changes (403). Nothing was changed.");
    await expect(toast).toBeVisible();
    await expect(bar).toContainText("Couldn't save (403). Try again.");
    // Error toasts stay until closed (Toasts.tsx); close it, and the bar still says what happened.
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(toast).toHaveCount(0);
    await expect(bar).toContainText("Couldn't save (403). Try again.");
    // The next attempt clears it.
    await saveCard(page, 'alerts');
    await expect(bar).not.toContainText("Couldn't save");
  });

  test('P1-G07: a 403 on saving Prices leaves the failure line in the Prices bar after the toast is gone', async ({ page }) => {
    // Prices saves through actions.savePrices + reportWrite (no useSaveSettings): the frame files the failure
    // under the bar whose Save was pressed.
    await gotoApp(page, '/settings/prices');
    const first = page.getByTestId('price-input-mrd_siem_prod');
    await expect(first).toBeVisible({ timeout: 40_000 });
    await first.fill('2.25');
    const bar = saveBar(page, 'prices');
    await expect(bar).toContainText('unsaved change');
    await mockControl(page, { action: 'fault', method: 'PUT', pattern: 'kvstore/prices', status: 403, times: 1 });
    await saveCard(page, 'prices');
    const toast = page.getByText("Couldn't save changes (403). Nothing was changed.");
    await expect(toast).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(toast).toHaveCount(0);
    await expect(bar).toContainText("Couldn't save (403). Try again.");
    expect(await kvGet(page, 'prices')).toBeNull();
    // The next attempt clears it, and this one goes through.
    await saveCard(page, 'prices');
    await expect(bar).not.toContainText("Couldn't save");
    await expect.poll(async () => (await kvGet(page, 'prices')) !== null).toBe(true);
  });

  test('P1-G07: a failed save stays with the section that pressed Save, even after the member moved on', async ({ page }) => {
    await gotoApp(page, '/settings?section=alerts');
    await page.getByTestId('alerts-regressionPoints').fill('20');
    // The write answers late (and refused): the member opens Cribl cost before it lands.
    await mockControl(page, { action: 'fault', method: 'PUT', pattern: 'kvstore/settings', status: 403, times: 1 });
    await mockControl(page, { action: 'config', options: { latencyMs: 1500 } });
    await saveCard(page, 'alerts');
    await openSection(page, 'Cribl cost', 'cost');
    await expect(page.getByText("Couldn't save changes (403). Nothing was changed.")).toBeVisible();
    await mockControl(page, { action: 'config', options: { latencyMs: 0 } });
    await expect(saveBar(page, 'cost')).not.toContainText("Couldn't save");
    // The unsaved Alerts section stayed mounted (hidden) and its bar kept the failure.
    await openSection(page, 'Alerts', 'alerts');
    await expect(page.getByTestId('alerts-regressionPoints')).toHaveValue('20');
    await expect(saveBar(page, 'alerts')).toContainText("Couldn't save (403). Try again.");
  });

  test('P1-G07: at 390 px editing the first price keeps the save bar in view', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, '/settings/prices');
    const first = page.getByTestId('price-input-mrd_siem_prod');
    await expect(first).toBeVisible({ timeout: 40_000 });
    await first.scrollIntoViewIfNeeded();
    await first.fill('2.25');
    const bar = saveBar(page, 'prices');
    await expect(bar).toContainText('unsaved change');
    const box = (await bar.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    expect(box.y).toBeGreaterThanOrEqual(0);
  });

  test('P1-G07: every changed card on Where to send alerts carries the dirty marker, the bell included', async ({ page }) => {
    await gotoApp(page, '/settings/notifications');
    const bell = page.getByTestId('endpoint-bell');
    await expect(bell).not.toHaveAttribute('data-dirty', 'true');
    await bell.getByRole('switch').click();
    await expect(bell).toHaveAttribute('data-dirty', 'true');
    // With the bell off the empty line no longer promises the bell.
    await expect(page.getByTestId('endpoints-empty')).toContainText('No endpoints yet, and the Cribl bell is off: alerts show only in Meter Reader.');
    await expect(page.getByTestId('endpoints-empty')).not.toContainText('Alerts still reach the Cribl bell');
    await addEndpoint(page);
    await expect(page.getByTestId('endpoint-0')).toHaveAttribute('data-dirty', 'true');
    await expect(saveBar(page, 'notifications')).toContainText('2 unsaved changes');
    await saveBar(page, 'notifications').getByRole('button', { name: 'Discard' }).click();
    await expect(bell).not.toHaveAttribute('data-dirty', 'true');
    await expect(page.getByTestId('endpoints-empty')).toBeVisible();
  });

  test('P1-G07: unsaved edits survive a section switch and the rail marks the section', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoApp(page, '/settings?section=alerts');
    await page.getByTestId('alerts-regressionPoints').fill('25');
    const rail = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(rail.getByTestId('nav-dirty-alerts')).toBeVisible();
    await openSection(page, 'Runtime', 'runtime');
    await expect(rail.getByTestId('nav-dirty-alerts')).toBeVisible();
    await openSection(page, 'Alerts', 'alerts');
    await expect(page.getByTestId('alerts-regressionPoints')).toHaveValue('25');
    await saveBar(page, 'alerts').getByRole('button', { name: 'Discard' }).click();
    await expect(rail.getByTestId('nav-dirty-alerts')).toHaveCount(0);
  });
});

test.describe('settings — WP-G2 screenshots', () => {
  test('screens', async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'one project owns the screenshots');
    test.setTimeout(300_000);
    const THEMES: Theme[] = ['light', 'dark'];
    const baseHeight = (width: number) => (width === 390 ? 844 : 900);
    /**
     * The whole page at `width`, captured in a viewport as tall as the document rather than with `fullPage`:
     * a full-page capture keeps sticky elements where the scrolled viewport had them (the sticky top nav and
     * rail mid-page, a dirty save bar over the section's middle), which is not what any member sees.
     */
    const shot = async (name: string, widths: readonly number[] = [1440, 390]) => {
      await page.mouse.move(0, 0);
      for (const theme of THEMES) {
        await setTheme(page, theme);
        for (const width of widths) {
          await page.setViewportSize({ width, height: baseHeight(width) });
          await page.evaluate(() => window.scrollTo(0, 0));
          for (let i = 0; i < 3; i++) {
            await page.waitForTimeout(250);
            const height = await page.evaluate(() => document.documentElement.scrollHeight);
            const current = page.viewportSize()?.height ?? 0;
            if (Math.abs(height - current) <= 1) break;
            await page.setViewportSize({ width, height: Math.max(baseHeight(width), height) });
          }
          await page.screenshot({ path: `tests/report/screens/wave1-g2-${name}-${theme}-${width}.png` });
        }
      }
      await setTheme(page, 'light');
      await page.setViewportSize({ width: 1440, height: 900 });
    };
    /** What the member sees with `target` in view: the sticky save bar at the bottom of a real viewport. */
    const inView = async (name: string, target: () => Locator, widths: readonly number[] = [1440, 390]) => {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        for (const width of widths) {
          await page.setViewportSize({ width, height: baseHeight(width) });
          await target().scrollIntoViewIfNeeded();
          await page.waitForTimeout(250);
          await page.screenshot({ path: `tests/report/screens/wave1-g2-${name}-${theme}-${width}.png` });
        }
      }
      await setTheme(page, 'light');
      await page.setViewportSize({ width: 1440, height: 900 });
    };

    await gotoApp(page, '/settings/notifications');
    await shot('notify-empty');
    await page.getByTestId('weekly-receipt').getByRole('button', { name: 'Send the last 7 days now' }).click();
    await expect(page.getByTestId('weekly-result')).toContainText('Cribl notifications:');
    await inView('weekly-bell-only', () => page.getByTestId('weekly-result'));
    await page.getByTestId('endpoint-bell').getByRole('switch').click();
    await inView('notify-bell-dirty', () => page.getByTestId('endpoint-bell'));
    await saveBar(page, 'notifications').getByRole('button', { name: 'Discard' }).click();
    await addEndpoint(page);
    await shot('notify-new-target');
    await inView('notify-new-target-inview', () => page.getByTestId('endpoint-0').getByLabel('Name'));
    await page.getByTestId('endpoint-0').getByLabel('Name').focus();
    await page.getByTestId('endpoint-0').getByLabel('Name').blur();
    await page.getByTestId('endpoint-0-target').getByRole('textbox').fill('ops-slack');
    await expect(page.getByTestId('endpoint-0-relay')).toHaveAttribute('data-relay', 'missing', { timeout: 10_000 });
    await shot('notify-target-unconnected');
    await saveBar(page, 'notifications').getByRole('button', { name: 'Discard' }).click();
    await addEndpoint(page);
    await connectTarget(page, 0, 'Ops Slack');
    await page.getByTestId('endpoint-0-test').getByRole('button').click();
    await expect(page.getByTestId('endpoint-0-result')).toContainText('Handed to Cribl for mrd_slack_finops (200)');
    await page.getByText('Target connected').first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
    await page.getByTestId('weekly-receipt').getByRole('button', { name: 'Send the last 7 days now' }).click();
    await expect(page.getByTestId('weekly-result')).toBeVisible();
    await page.getByText('Changes saved').first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
    await shot('notify-tested');

    await seedPrices(page);
    await page.goto('/settings?section=alerts');
    await waitForMock(page);
    await waitForHydration(page);
    await expect(page.getByTestId('alerts-exclude-picker').getByRole('button')).toBeEnabled({ timeout: 40_000 });
    await page.getByTestId('alerts-exclude-picker').getByRole('button').click();
    await page.getByRole('option', { name: /Pipeline · / }).first().click();
    await page.getByTestId('alerts-regressionPoints').fill('20');
    await shot('alerts-dirty', [1440, 390, 1920]);
    await inView('savebar-sticky', () => page.getByTestId('alerts-regressionPoints'));
    // A refused save: the bar keeps its line after the toast is closed.
    await mockControl(page, { action: 'fault', method: 'PUT', pattern: 'kvstore/settings', status: 403, times: 1 });
    await saveCard(page, 'alerts');
    await expect(saveBar(page, 'alerts')).toContainText("Couldn't save (403). Try again.");
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await inView('savebar-failed', () => page.getByTestId('alerts-regressionPoints'));
    await openSection(page, 'Runtime', 'runtime');
    await shot('runtime');
    await openSection(page, 'Prices', 'prices');
    await expect(page.getByTestId('price-row-mrd_siem_prod')).toBeVisible({ timeout: 40_000 });
    await shot('prices-priced');
  });
});
