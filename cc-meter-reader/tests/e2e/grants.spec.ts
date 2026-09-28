// tests/e2e/grants.spec.ts — every Leader call the release build makes is a grant in config/policies.yml
// (EPIC_AUDIT P0-03).
//
// A member an administrator shared the App with holds exactly the App's declared grants (AGENTS.md
// "policies.yml"): any other Leader path answers 403 for them. The emulator journals every call the page
// makes, so each test drives a real journey on the release build (the Playwright server's default) and
// checks the journal against config/policies.yml. The member test goes further and makes the emulator answer
// 403 to everything under the deprecated `/master/*` group API — what the Leader does to a member — and
// shows the Prices page of a fresh install still lists its destinations.
//
// Screenshots: tests/report/screens/wave1-e-member-prices-<theme>-<width>.png (both themes, every project).

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { gotoApp, mockCalls, mockControl, navigateInApp, resetCalls, seedPrices, setTheme, trackConsoleErrors, type Theme } from './helpers/index.ts';

interface Policy {
  object: string;
  actions: string[];
}

const ROOT = new URL('../../', import.meta.url);
/** The YAML parser @cribl/apps itself uses (as tests/compliance.test.ts resolves it). */
const nodeRequire = createRequire(import.meta.url);
const YAML = createRequire(nodeRequire.resolve('@cribl/apps/package'))('yaml') as { parse(src: string): unknown };

function releasePolicies(): Policy[] {
  const doc = YAML.parse(readFileSync(new URL('config/policies.yml', ROOT), 'utf8')) as { policies?: Policy[] } | null;
  const list = doc?.policies;
  if (!Array.isArray(list) || list.length === 0) throw new Error('config/policies.yml has no policies');
  return list.map((p) => ({ object: String(p.object), actions: p.actions.map(String) }));
}

/** App-scoped paths the platform grants itself (kvstore, proxy) and backend endpoints. */
const APP_SCOPED = /^\/(kvstore|proxy|endpoints)(\/|$)/;

function policyPattern(object: string): RegExp {
  const source = object
    .split('/')
    .map((s) => (s === '*' ? '.*' : s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`);
}

/** Journaled routes (`GET /m/:gid/pipelines`) no release grant covers. External hosts journal as `POST host`. */
function undeclared(routes: Iterable<string>, policies: readonly Policy[]): string[] {
  const out: string[] = [];
  for (const route of routes) {
    const [method, path = ''] = route.split(' ');
    if (!path.startsWith('/') || APP_SCOPED.test(path)) continue;
    if (!policies.some((p) => (p.actions.includes(method) || p.actions.includes('*')) && policyPattern(p.object).test(path))) out.push(route);
  }
  return out.sort();
}

/** The dev server re-optimizing a dependency mid-run is an environment artifact, not an app error. */
const ALLOW = [/Outdated Optimize Dep/];

async function shoot(page: Page, name: string, theme: Theme): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  // Transitions finished: a theme switch mid-transition would photograph a half-painted selected state.
  await page.screenshot({ path: `tests/report/screens/wave1-e-${name}-${theme}-${width}.png`, fullPage: false, animations: 'disabled' });
}

test.describe('grants: the release build calls only declared Leader routes', () => {
  test('Settings → Prices on a fresh install: the inventory read journals only declared routes, never /master/groups', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/settings/prices');
    await expect(page.getByTestId('price-row-mrd_siem_prod')).toBeVisible({ timeout: 40_000 });
    const calls = await mockCalls(page);
    expect(Object.keys(calls.byRoute)).toContain('GET /products/stream/groups');
    expect(calls.byRoute['GET /master/groups'] ?? 0).toBe(0);
    expect(undeclared(Object.keys(calls.byRoute), releasePolicies())).toEqual([]);
    expect(errors()).toEqual([]);
  });

  test('a member (403 on the undeclared /master/* group API) still sees the destinations to price on a fresh install', async ({ page }) => {
    await gotoApp(page, '/');
    // What the Leader answers a member for a path the App does not declare.
    await mockControl(page, { action: 'fault', pattern: '^/master/', status: 403, body: { status: 'error', message: 'Forbidden' }, times: -1 });
    await resetCalls(page);
    await gotoApp(page, '/settings/prices');
    for (const id of ['mrd_siem_prod', 'mrd_analytics', 'mrd_archive_s3', 'devnull']) {
      await expect(page.getByTestId(`price-row-${id}`)).toBeVisible({ timeout: 40_000 });
    }
    await expect(page.getByTestId('prices-counts')).toContainText('4 destinations');
    const calls = await mockCalls(page);
    expect(calls.recent.filter((c) => c.status === 403)).toEqual([]);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await shoot(page, 'member-prices', theme);
    }
  });

  test('a priced workspace across every view (meter, Receipt, Flow, Ledger, What-if, Settings) journals only declared routes', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await gotoApp(page, '/');
    await seedPrices(page);
    await gotoApp(page, '/');
    // The tab's first sweep writes the snapshot (the metrics query is its signature call).
    await expect.poll(async () => (await mockCalls(page)).byRoute['POST /system/metrics/query'] ?? 0, { timeout: 45_000 }).toBeGreaterThan(0);
    // The member moves between views inside the one metering tab (navigateInApp), as the App's own links do. A
    // `page.goto` per view reloaded the document mid-sweep about once a run: the page being left kept writing
    // after MSW had closed its client (KV PUT … HTTP 404 from the dev server; WebKit: "Load failed").
    for (const path of ['/flow', '/ledger', '/whatif', '/settings/prices', '/settings/notifications', '/settings', '/']) {
      await navigateInApp(page, path);
      await page.waitForTimeout(400);
    }
    const calls = await mockCalls(page);
    expect(calls.byRoute['GET /master/groups'] ?? 0).toBe(0);
    expect(undeclared(Object.keys(calls.byRoute), releasePolicies())).toEqual([]);
    expect(errors()).toEqual([]);
  });
});
