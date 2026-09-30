// r1 ui-9 (FINDINGS_R1 m14, #35; seeded from AA/r1/alerts/skeptic2-f35.spec.ts): a "Send a test alert" press is never
// silently dropped. While a typed target id's relay was still unknown the button was enabled, then disabled while the
// check ran (~550 ms), then enabled again (~1-2 s): a press in that window did nothing. Now the button waits, disabled,
// until the relay is known, and once enabled it stays enabled.

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, mockControl, resetMock, trackConsoleErrors, waitForHydration } from './helpers/index.ts';

const TARGET = 'mrd_webhook_site';
const card = (page: Page) => page.locator('section[data-section="notifications"]');

/** The test button's disabled state every 25 ms for `ms`, as the transitions it made. */
async function sampleButton(page: Page, idx: number, ms: number): Promise<{ ms: number; disabled: boolean }[]> {
  return page.evaluate(
    async ({ idx, ms }) => {
      const out: { ms: number; disabled: boolean }[] = [];
      const start = performance.now();
      while (performance.now() - start < ms) {
        const btn = document.querySelector(`[data-testid="endpoint-${idx}-test"] button`) as HTMLButtonElement | null;
        const disabled = !btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.hasAttribute('data-disabled');
        if (out.length === 0 || out[out.length - 1].disabled !== disabled) out.push({ ms: Math.round(performance.now() - start), disabled });
        await new Promise((r) => setTimeout(r, 25));
      }
      return out;
    },
    { idx, ms },
  );
}

test('a second endpoint typed onto a connected target: the test button never flips back to disabled, and its press sends', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = trackConsoleErrors(page, [/Outdated Optimize Dep/, /Failed to load resource: the server responded with a status of 40[34]/]);
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await page.goto('/settings/notifications', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  // Endpoint 0: connected (and, since r1 ui-5, stored by the Connect).
  await card(page).getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByTestId('endpoint-0').getByLabel('Name').fill('Ops');
  await page.getByTestId('endpoint-0-target').getByRole('textbox').fill(TARGET);
  await page.getByTestId('endpoint-0-relay').getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('endpoint-0-relay')).toHaveAttribute('data-relay', 'ready');

  // The finding's flow: back on the page (its relay states forgotten), a slow Leader, and a second endpoint typed at a
  // human pace onto the same target while the saved one's relay is still being checked.
  await expect.poll(async () => (await page.evaluate(async () => (await (await fetch('/mock-api/v1/kvstore/settings')).text()).includes('mrd_webhook_site')))).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await mockControl(page, { action: 'config', options: { latencyMs: 400 } });
  await card(page).getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByTestId('endpoint-1').getByLabel('Name').fill('Relay');
  const field = page.getByTestId('endpoint-1-target').getByRole('textbox');
  await field.click();
  const sampling = sampleButton(page, 1, 3_500);
  await field.pressSequentially(TARGET, { delay: 60 });
  const seen = await sampling;
  // Once enabled, it stays enabled: no enabled → disabled flip after the typing stopped.
  const firstEnabled = seen.findIndex((s) => !s.disabled);
  expect(firstEnabled, `transitions ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(0);
  expect(seen.slice(firstEnabled).every((s) => !s.disabled), `transitions ${JSON.stringify(seen)}`).toBe(true);
  // And the press it offers sends.
  await page.getByTestId('endpoint-1-test').getByRole('button').click();
  await expect(page.getByTestId('endpoint-1-result')).toContainText(`Handed to Cribl for ${TARGET} (200)`, { timeout: 15_000 });
  expect(errors()).toEqual([]);
});

test('while a typed id is still being checked the button waits, disabled (never an enabled press that does nothing)', async ({ page }) => {
  test.setTimeout(60_000);
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await page.goto('/settings/notifications', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await mockControl(page, { action: 'config', options: { latencyMs: 400 } });
  await card(page).getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByTestId('endpoint-0').getByLabel('Name').fill('Ops');
  await page.getByTestId('endpoint-0-target').getByRole('textbox').fill('ops-slack');
  // Straight after typing the relay is not known yet: the button must not offer a press.
  await expect(page.getByTestId('endpoint-0-test').getByRole('button')).toBeDisabled();
  await expect(page.getByTestId('endpoint-0-relay')).toHaveAttribute('data-relay', 'missing', { timeout: 10_000 });
  await expect(page.getByTestId('endpoint-0-test').getByRole('button')).toBeDisabled();
});
