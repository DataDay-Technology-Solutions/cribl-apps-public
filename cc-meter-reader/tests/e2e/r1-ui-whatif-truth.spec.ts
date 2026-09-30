// r1 ui-4 (FOUNDER_PLAN rows 2 + 2b): What if on a stranger's workspace, served by the emulator through injected answers
// (the pattern of app-assurance's clean-install spec, AA/r1/resilience/zz-res-cleaninstall.spec.ts).
//   Row 2:  a generic Datagen stream (the clean-install recipe) → "Biggest unclaimed savings" says no stream here is one
//           the packs are written for (noneFit), never "Every stream here already runs the pack written for it."
//   Row 2b: a Palo Alto firewall route running Cribl's Palo Alto Networks pack attached alone (`pack:cribl-palo-alto-
//           networks`) → the Palo Alto + syslog packs tile says it runs that pack, never "this treatment".

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, kvGet, mockControl, resetMock, trackConsoleErrors, waitForHydration } from './helpers/index.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-09-28T15:00:05Z');

interface Workspace {
  input: { id: string; type: string; description?: string };
  output: { id: string; type: string };
  route: { id: string; name: string; pipeline: string };
  pipelines: { id: string; conf: { functions: unknown[] } }[];
  /** bytes a minute in and out */
  inB: number;
  outB: number;
}

function metricsRows(w: Workspace, fromMs: number, toMs: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let m = fromMs; m < toMs; m += MIN) {
    const s = m / 1000;
    const inE = Math.round(w.inB / 1000);
    const outE = Math.round(w.outB / 1000);
    rows.push({ starttime: s, endtime: s + 60, __worker_group: 'default', input: `${w.input.type}:${w.input.id}`, inB: w.inB, inE });
    rows.push({ starttime: s, endtime: s + 60, __worker_group: 'default', output: `${w.output.type}:${w.output.id}`, outB: w.outB, outE });
    rows.push({ starttime: s, endtime: s + 60, __worker_group: 'default', route: w.route.id, name: w.route.name, inB: w.inB, outB: w.outB, inE, outE });
  }
  return rows;
}

async function serveWorkspace(page: Page, w: Workspace): Promise<void> {
  const items = (x: unknown[]) => ({ count: x.length, items: x });
  const answers: [string, string, unknown][] = [
    ['GET', '/products/stream/groups', items([{ id: 'default', type: 'stream', name: 'default' }])],
    ['GET', '/master/groups', items([{ id: 'default', type: 'stream', name: 'default' }])],
    ['GET', '/m/default/system/inputs', items([{ ...w.input, disabled: false }])],
    ['GET', '/m/default/system/outputs', items([w.output, { id: 'default', type: 'default', defaultId: w.output.id }])],
    ['GET', '/m/default/pipelines', items([{ id: 'main', conf: { functions: [] } }, ...w.pipelines])],
    [
      'GET',
      '/m/default/routes',
      items([
        {
          id: 'default',
          routes: [
            { id: w.route.id, name: w.route.name, filter: `__inputId=='${w.input.type}:${w.input.id}'`, pipeline: w.route.pipeline, output: w.output.id, final: true },
            { id: 'default', name: 'default', filter: 'true', pipeline: 'main', output: 'default', final: true },
          ],
        },
      ]),
    ],
    ['POST', '/system/metrics/query', { results: metricsRows(w, T0 - 26 * 60 * MIN, T0 + 3 * 60 * MIN), info: { timeWindowSeconds: 60 } }],
  ];
  for (const [method, path, body] of answers) await mockControl(page, { action: 'fault', method, path, status: 200, body, times: -1 });
}

/** A fresh install on `w`: price its destination at $2.25/GB, Start the meter, wait for the first sweep. */
async function meterWorkspace(page: Page, w: Workspace): Promise<void> {
  await page.clock.install({ time: T0 });
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await serveWorkspace(page, w);
  await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  const input = page.getByTestId(`price-input-${w.output.id}`);
  await expect(input).toBeVisible({ timeout: 40_000 });
  await input.fill('2.25');
  await page.locator('section[data-section="prices"]').getByRole('button', { name: 'Start the meter' }).click();
  await expect(page.getByText('The meter is running.', { exact: false }).first()).toBeVisible();
  for (let i = 0; i < 40; i++) {
    const snap = JSON.parse((await kvGet(page, 'snapshot')) ?? '{}') as { flows?: unknown[] };
    if ((snap.flows ?? []).length > 0) return;
    await page.clock.fastForward(10_000);
    await page.waitForTimeout(800);
  }
  throw new Error('the first sweep metered no flow');
}

test.describe('What if tells the truth on any workspace (r1 ui-4)', () => {
  test('row 2: a generic Datagen stream → no stream is one the packs are written for (noneFit)', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = trackConsoleErrors(page, [/Outdated Optimize Dep/]);
    // Tagged for the demo so this branch meters it before core-1 (a plain Datagen is metered once C3 lands).
    await meterWorkspace(page, {
      input: { id: 'in_datagen_test', type: 'datagen', description: '[meter-reader-demo] clean-install test source' },
      output: { id: 'devnull', type: 'devnull' },
      route: { id: 'r_dg', name: 'datagen test', pipeline: 'drop_half' },
      pipelines: [{ id: 'drop_half', conf: { functions: [{ id: 'drop', filter: 'Math.random() < 0.5' }] } }],
      inB: 30_000_000,
      outB: 15_000_000,
    });
    await page.goto('/whatif', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const none = page.getByTestId('whatif-unclaimed-none');
    await expect(none).toBeVisible({ timeout: 30_000 });
    await expect(none).toHaveAttribute('data-reason', 'noneFit');
    await expect(none).toHaveText(
      'No stream here is one these packs are written for (Windows event logs, Palo Alto firewall syslog, VPC Flow Logs). A custom drop works on any stream.',
    );
    await expect(page.getByText('Every stream here already runs the pack written for it.')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test("row 2b: Cribl's Palo Alto Networks pack attached alone → the tile says it runs that pack, not the two-pack treatment", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = trackConsoleErrors(page, [/Outdated Optimize Dep/]);
    await meterWorkspace(page, {
      input: { id: 'pan_firewall', type: 'syslog' },
      output: { id: 'splunk_siem', type: 'splunk_hec' },
      route: { id: 'r_pan', name: 'Palo Alto firewall', pipeline: 'pack:cribl-palo-alto-networks' },
      pipelines: [],
      inB: 40_000_000,
      outB: 26_400_000,
    });
    const stream = 'default|pan_firewall|r_pan|splunk_siem';
    await page.goto(`/whatif?stream=${encodeURIComponent(stream)}&treatment=pack-panos`, { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const already = page.getByTestId('whatif-already');
    await expect(already).toBeVisible({ timeout: 30_000 });
    await expect(already).toHaveAttribute('data-runs', 'pack');
    await expect(already).toHaveText(/^This stream already runs the Palo Alto Networks pack\. Its measured ratio is \d+%\.$/);
    await expect(page.getByText(/already runs this treatment/)).toHaveCount(0);
    // Its only fitting stream runs the pack written for it: here "none" is the truth.
    await expect(page.getByTestId('whatif-unclaimed-none')).toHaveAttribute('data-reason', 'none');
    expect(errors()).toEqual([]);
  });
});
