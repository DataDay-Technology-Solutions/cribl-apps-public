// r2 ui-11 (FINDINGS_R2 #13 + #14, FINDINGS_EXTRA BO-16 + IC-14 residue), end to end:
//   • Settings' "What the target receives" after a test is the delivered text in the display zone (no "UTC", no ISO
//     time), and at 390 px it wraps inside its box (it was `white-space: pre`, cut on the right);
//   • the tour's takeover and incident card read "Caught in 2:51" at every moment from 24 to 34 s (they climbed to 2:57
//     while the delivery was owed, then snapped back at ~31 s: app-assurance r2/1/walk/caught-clock.txt);
//   • the tour's View message is the plain text handed to Cribl, in the toast's zone.

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, kvGet, resetMock, seedPrices, waitForHydration } from './helpers/index.ts';

test.use({ timezoneId: 'America/Chicago' });

async function connectAndTest(page: Page): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await seedPrices(page);
  await page.goto('/settings/notifications', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  const card = page.locator('section[data-section="notifications"]');
  await card.getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByTestId('endpoint-0').getByLabel('Name').fill('Ops Slack');
  await page.getByTestId('endpoint-0-target').getByRole('textbox').fill('mrd_slack_finops');
  await page.getByTestId('endpoint-0-relay').getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('endpoint-0-relay')).toHaveAttribute('data-relay', 'ready');
  await expect.poll(async () => JSON.parse((await kvGet(page, 'settings')) ?? '{}').notifications?.length ?? 0).toBe(1);
  await page.getByTestId('endpoint-0-test').getByRole('button').click();
  await expect(page.getByTestId('endpoint-0-result')).toContainText('Handed to Cribl for mrd_slack_finops (200)');
}

for (const width of [1440, 390] as const) {
  test(`${width} px: the target preview is the delivered text in the display zone, and it wraps inside its box`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await connectAndTest(page);
    const pre = page.getByTestId('endpoint-0').locator('.mr-ep-preview pre');
    await expect(pre).toBeVisible();
    const text = await pre.innerText();
    expect(text).toMatch(/Opened \d{1,2}:\d{2} (AM|PM)/);
    expect(text, 'a Chicago display prints no UTC time').not.toMatch(/\bUTC\b|\d{4}-\d{2}-\d{2}T/);
    const box = await pre.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(box.sw, 'no horizontal cut').toBeLessThanOrEqual(box.cw);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('the tour: "Caught in 2:51" at every moment from 24 to 34 s (none before the catch at 25 s), on the takeover and the incident card', async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install();
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await gotoApp(page, '/first-run');
  await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mr-tour', 'running');
  // Nothing is caught before the regression lands at 25 s; the takeover is its own lazy chunk, so wait (real time) for it.
  await page.clock.fastForward(24_000);
  await expect(page.locator('.mr-tk-caught-text, .mr-inc-caught')).toHaveCount(0);
  await page.clock.fastForward(1_200);
  await expect(page.locator('.mr-tk-caught-text').first()).toBeVisible({ timeout: 15_000 });
  const seen: string[] = [];
  for (let t = 25_200; t <= 34_000; t += 400) {
    await page.waitForTimeout(40); // let the frame commit
    const texts = await page.locator('.mr-tk-caught-text, .mr-inc-caught').allInnerTexts();
    for (const x of texts) seen.push(`${(t / 1000).toFixed(1)} ${x.trim()}`);
    await page.clock.fastForward(400);
  }
  expect(seen.length, 'the clock was on screen').toBeGreaterThan(10);
  expect(seen.filter((s) => !s.endsWith('Caught in 2:51'))).toEqual([]);
});

test('the tour\'s View message: the plain text handed to Cribl, in the toast\'s zone', async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install();
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await gotoApp(page, '/first-run');
  await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mr-tour', 'running');
  // The toast's own root (Capra's role), holding our marked body (as r1-ui-tour-takeover finds a tour toast). The delivery
  // beat lands at 31 s; step the fake clock until its toast is up (a loaded host can start the script a beat late).
  const toast = page.locator(':is([role="status"], [role="alert"])').filter({ has: page.locator('[data-mr-toast]', { hasText: 'Handed to Cribl for' }) });
  await page.clock.fastForward(30_500);
  for (let i = 0; i < 12 && (await toast.count()) === 0; i++) {
    await page.clock.fastForward(500);
    await page.waitForTimeout(100);
  }
  await expect(toast).toHaveCount(1);
  const time = /✓ (\d{1,2}):(\d{2}) (AM|PM)/.exec(await toast.innerText());
  expect(time).toBeTruthy();
  await toast.getByRole('button', { name: 'View message' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Handed to Cribl for');
  await expect(dialog.locator('[data-tour-dialog="slack"]')).toHaveCount(0);
  const message = await dialog.locator('[data-callout="target-message"]').innerText();
  expect(message).not.toMatch(/\bUTC\b/);
  // "Opened h:mm" is the toast's clock (the delivery lands seconds after the open): the same zone, a minute apart at most.
  const opened = /Opened (\d{1,2}):(\d{2}) (AM|PM)/.exec(message);
  expect(opened, message).toBeTruthy();
  const minutes = (m: RegExpExecArray) => ((Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + Number(m[2]);
  expect(Math.abs(minutes(time!) - minutes(opened!))).toBeLessThanOrEqual(1);
});
