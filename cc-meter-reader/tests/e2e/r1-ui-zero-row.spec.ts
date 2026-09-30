// r1 ui-11, FOUNDER_PLAN row 14: $0 on first run — the mixed case. A workspace whose only reducing pipeline ends at a
// destination priced $0 (the clean-install recipe: Datagen → a Drop → DevNull, DevNull left at its free $0) while
// another destination has a real price reads $0 saved. The all-$0 notice (zeroPricedTitle) does not apply: one price is
// above $0. Without a line that names the $0 row the Receipt read only "Nothing saved yet … Savings appear once a
// pipeline reduces what reaches a priced destination" — true, and no help. Now one line names the $0 destination and
// links to Prices.

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, kvGet, mockControl, resetMock, trackConsoleErrors, waitForHydration } from './helpers/index.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-09-28T15:00:05Z');

interface Route {
  input: { id: string; type: string; description?: string };
  output: { id: string; type: string };
  route: { id: string; name: string; pipeline: string };
  inB: number;
  outB: number;
}

const ROUTES: Route[] = [
  // Reduces by half, but into DevNull (free: $0 once any price is saved).
  {
    input: { id: 'in_datagen_test', type: 'datagen', description: '[meter-reader-demo] clean-install test source' },
    output: { id: 'devnull', type: 'devnull' },
    route: { id: 'r_dg', name: 'datagen test', pipeline: 'drop_half' },
    inB: 30_000_000,
    outB: 15_000_000,
  },
  // A real, priced destination, passthrough: it costs, it saves nothing.
  {
    input: { id: 'in_syslog_fw', type: 'syslog' },
    output: { id: 'splunk_siem', type: 'splunk_hec' },
    route: { id: 'r_fw', name: 'firewall to Splunk', pipeline: 'main' },
    inB: 20_000_000,
    outB: 20_000_000,
  },
];

async function serveWorkspace(page: Page): Promise<void> {
  const items = (x: unknown[]) => ({ count: x.length, items: x });
  const rows: Record<string, unknown>[] = [];
  for (let m = T0 - 26 * 60 * MIN; m < T0 + 3 * 60 * MIN; m += MIN) {
    const s = m / 1000;
    for (const r of ROUTES) {
      const inE = Math.round(r.inB / 1000);
      const outE = Math.round(r.outB / 1000);
      rows.push({ starttime: s, endtime: s + 60, __worker_group: 'default', input: `${r.input.type}:${r.input.id}`, inB: r.inB, inE });
      rows.push({ starttime: s, endtime: s + 60, __worker_group: 'default', output: `${r.output.type}:${r.output.id}`, outB: r.outB, outE });
      rows.push({ starttime: s, endtime: s + 60, __worker_group: 'default', route: r.route.id, name: r.route.name, inB: r.inB, outB: r.outB, inE, outE });
    }
  }
  const answers: [string, string, unknown][] = [
    ['GET', '/products/stream/groups', items([{ id: 'default', type: 'stream', name: 'default' }])],
    ['GET', '/master/groups', items([{ id: 'default', type: 'stream', name: 'default' }])],
    ['GET', '/m/default/system/inputs', items(ROUTES.map((r) => ({ ...r.input, disabled: false })))],
    ['GET', '/m/default/system/outputs', items([...ROUTES.map((r) => r.output), { id: 'default', type: 'default', defaultId: 'devnull' }])],
    ['GET', '/m/default/pipelines', items([{ id: 'main', conf: { functions: [] } }, { id: 'drop_half', conf: { functions: [{ id: 'drop', filter: 'Math.random() < 0.5' }] } }])],
    [
      'GET',
      '/m/default/routes',
      items([
        {
          id: 'default',
          routes: [
            ...ROUTES.map((r) => ({ id: r.route.id, name: r.route.name, filter: `__inputId=='${r.input.type}:${r.input.id}'`, pipeline: r.route.pipeline, output: r.output.id, final: true })),
            { id: 'default', name: 'default', filter: 'true', pipeline: 'main', output: 'default', final: true },
          ],
        },
      ]),
    ],
    ['POST', '/system/metrics/query', { results: rows, info: { timeWindowSeconds: 60 } }],
  ];
  for (const [method, path, body] of answers) await mockControl(page, { action: 'fault', method, path, status: 200, body, times: -1 });
}

test('the mixed $0 case: a reducing pipeline into a $0 destination is named, with the way to Prices (row 14)', async ({ page }) => {
  test.setTimeout(180_000);
  // This synthetic workspace (a Monday, 15:00 UTC) runs the weekly-receipt job mid-spec. r2 core-11 (a): a transient
  // Leader failure there (a KV read timing out under this spec's fast-forwarded clock) is a warning and a retry, not an
  // error, so no allow-list is needed.
  const errors = trackConsoleErrors(page, [/Outdated Optimize Dep/]);
  await page.clock.install({ time: T0 });
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await serveWorkspace(page);
  await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  // Price the real destination only; DevNull stays at its free $0 (D33).
  const siem = page.getByTestId('price-input-splunk_siem');
  await expect(siem).toBeVisible({ timeout: 40_000 });
  await siem.fill('2.25');
  await page.locator('section[data-section="prices"]').getByRole('button', { name: 'Start the meter' }).click();
  await expect(page.getByText('The meter is running.', { exact: false }).first()).toBeVisible();
  for (let i = 0; i < 40; i++) {
    const snap = JSON.parse((await kvGet(page, 'snapshot')) ?? '{}') as { flows?: unknown[] };
    if ((snap.flows ?? []).length >= 2) break;
    await page.clock.fastForward(10_000);
    await page.waitForTimeout(800);
  }
  await page.goto('/?period=mtd', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await expect(page.getByTestId('receipt-hero')).toBeVisible({ timeout: 30_000 });
  // Not every price is $0, so the all-$0 notice stays away; the row notice names DevNull and links to Prices.
  await expect(page.getByTestId('zero-priced-notice')).toHaveCount(0);
  const notice = page.getByTestId('zero-row-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('DevNull');
  await expect(notice).toContainText('$0');
  await notice.getByRole('button', { name: 'Set prices' }).click();
  await expect(page).toHaveURL(/\/settings\/prices/);
  expect(errors()).toEqual([]);
});
