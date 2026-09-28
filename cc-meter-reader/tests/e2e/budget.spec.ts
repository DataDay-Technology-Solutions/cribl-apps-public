// tests/e2e/budget.spec.ts — the open tab's Leader call rate (P1-O02; P1-D05's acceptance is measured here too).
//
// The Leader allows an App about 50 API calls a minute (docs/PLATFORM_NOTES.md §4.2, N20), and every KV read or
// write is one of them. On a WARM workspace (helpers/warm.ts: 40 days of history, the inventory, meta and snapshot
// as the last sweep left them) each test opens a view and counts, from the emulator's own journal, every call the
// page makes in the first minute and in each minute after it. A regression that polls faster, sweeps twice or
// re-reads history every tick fails here instead of on stage:
//
//   first minute, any view                      ≤ 50  (hydration, the first sweep, the first polls)
//   '/' — the tab meters (no runner)            ≤ 35 a minute (a sweep ≈ 23, polls, the cheap check)
//   '/?range=30d', the presenter view           ≤ 40 a minute
//   '/' while a runner meters                   ≤ 15 a minute (the tab only reads: it yields to the runner)
//
// Two more pin the meter itself: polling forced to 3 s (the presenter's legal minimum) must BREAK the budget, and
// a 429 must back the tab off to one read a minute and then let it recover.
//
// Real time: the first minute, then the mean of the next three (a sweep runs once a minute, so a shorter window
// reads its phase, not its rate). The rate does not depend on the viewport, so it is measured in the `chromium` project only; the other
// projects skip. React StrictMode (the dev server) mounts effects twice, as in every Playwright run.

import { expect, test, type Page } from '@playwright/test';
import { callRate, familyOf, measureView, mockControl, resetCalls, trackConsoleErrors, warmWorkspace, type CallRate } from './helpers/index.ts';

/** Leader calls a minute (see the header). */
export const BUDGET = {
  firstMinute: 50,
  steady: 40,
  tabMeters: 35,
  freshRunner: 15,
} as const;

/** Minutes measured per view: the first, then three steady ones. */
const MINUTES = 4;

/** Calls of one family (`GET kv:snapshot`, see familyOf) in a measurement. */
const countOf = (rate: CallRate, family: string): number => rate.entries.filter((e) => familyOf(e) === family).length;

/** The call-rate tests measure in one project only (see the header). */
function measuresHere(): boolean {
  return test.info().project.name === 'chromium';
}

function report(name: string, rate: CallRate): void {
  const line = `${name}: first minute ${rate.firstMinute}, then ${rate.perMinute.slice(1).join(' / ')} (mean ${rate.steadyPerMinute}, peak ${rate.steadyPeak})`;
  console.log(`[budget] ${line}\n  steady, per minute: ${JSON.stringify(rate.steadyByFamily)}`);
  test.info().annotations.push({ type: 'calls', description: line });
}

/** A runner that keeps sweeping: meta says the runner swept moments ago, every 30 s (unjournaled). */
const keepRunnerFresh = (page: Page) => {
  let last = Number.NEGATIVE_INFINITY;
  return async (elapsedMs: number): Promise<void> => {
    if (elapsedMs - last < 30_000) return;
    last = elapsedMs;
    await mockControl(page, { action: 'runnerSweep' });
  };
};

test.describe('the open tab stays inside the Leader call budget', () => {
  test.describe.configure({ timeout: 7 * 60_000 });
  test.beforeEach(() => {
    test.skip(!measuresHere(), 'the call rate does not depend on the viewport: measured in the chromium project');
  });

  test("'/' with no runner: the tab meters within 35 calls a minute, 50 in the first", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await warmWorkspace(page);
    const rate = await measureView(page, '/', { minutes: MINUTES });
    report('receipt, the tab meters', rate);
    expect(rate.statuses['429'] ?? 0, 'no 429 on the way').toBe(0);
    expect(rate.firstMinute).toBeLessThanOrEqual(BUDGET.firstMinute);
    expect(rate.steadyPerMinute).toBeLessThanOrEqual(BUDGET.tabMeters);
    // It is metering: a sweep's metrics query lands every minute.
    expect(rate.steadyByFamily['POST /system/metrics/query'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(errors()).toEqual([]);
  });

  test("'/?range=30d': a custom range adds its reads once, not every tick — within 40 a minute", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await warmWorkspace(page);
    const rate = await measureView(page, '/?range=30d', { minutes: MINUTES });
    report('receipt ?range=30d', rate);
    await expect(page.getByTestId('receipt-hero')).toHaveAttribute('data-range-status', 'ready');
    expect(rate.firstMinute).toBeLessThanOrEqual(BUDGET.firstMinute);
    expect(rate.steadyPerMinute).toBeLessThanOrEqual(BUDGET.steady);
    expect(errors()).toEqual([]);
  });

  test('the presenter view at its default 5 s refresh: within 40 a minute', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await warmWorkspace(page);
    const rate = await measureView(page, '/?present=1', { minutes: MINUTES });
    report('presenter, default refresh', rate);
    expect(rate.firstMinute).toBeLessThanOrEqual(BUDGET.firstMinute);
    expect(rate.steadyPerMinute).toBeLessThanOrEqual(BUDGET.steady);
    expect(errors()).toEqual([]);
  });

  test('while a runner meters, the tab only reads: within 15 a minute', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await warmWorkspace(page, { lastOwner: 'runner' });
    const rate = await measureView(page, '/', { minutes: MINUTES, during: keepRunnerFresh(page) });
    report('receipt, a fresh runner meters', rate);
    expect(rate.firstMinute).toBeLessThanOrEqual(BUDGET.firstMinute);
    expect(rate.steadyPerMinute).toBeLessThanOrEqual(BUDGET.freshRunner);
    expect(errors()).toEqual([]);
  });

  test('the meter catches a fast poll: a 3 s refresh (presenter minimum) breaks the budget', async ({ page }) => {
    await warmWorkspace(page, { live: { presenterPollSeconds: 3 } });
    const rate = await measureView(page, '/?present=1', { minutes: 2 });
    report('presenter at 3 s', rate);
    // Snapshot and meta every 3 s alone are 40 a minute: the gate above must fail at this setting.
    expect(rate.steadyPerMinute).toBeGreaterThan(BUDGET.steady);
  });
});

test.describe('a 429 from the Leader', () => {
  test.describe.configure({ timeout: 4 * 60_000 });
  test.beforeEach(() => {
    test.skip(!measuresHere(), 'the call rate does not depend on the viewport: measured in the chromium project');
  });

  test('backs the live poll off to one read a minute, then the tab recovers', async ({ page }) => {
    const errors = trackConsoleErrors(page, [/Failed to load resource: .*\b429\b/]);
    // A fake clock that runs in real time, so the five-minute back-off window can be skipped, not waited out.
    await page.clock.install();
    await warmWorkspace(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html[data-mr-hydrated="true"]')).toBeAttached({ timeout: 30_000 });
    const status = page.locator('.mr-status');
    await expect(status).toHaveAttribute('data-status', 'live', { timeout: 30_000 });

    // One 429 on the next poll (every poll reads meta; the snapshot only once meta moved, P1-D05).
    await mockControl(page, { action: 'fault', method: 'GET', pattern: 'kvstore/meta$', status: 429, times: 1 });
    await expect(status).toHaveAttribute('data-status', 'rate-limited', { timeout: 20_000 });
    await resetCalls(page);
    const t0 = await page.evaluate(() => Date.now());
    await page.waitForTimeout(45_000);
    const backedOff = await callRate(page, t0, 1);
    console.log(`[budget] 45 s inside the back-off: ${backedOff.total} calls ${JSON.stringify(backedOff.entries.map((e) => familyOf(e)))}`);
    // The poll reads meta (and a moved snapshot) once a minute now, not every 10 s (the sweep keeps its own pace).
    expect(countOf(backedOff, 'GET kv:snapshot')).toBeLessThanOrEqual(1);
    expect(backedOff.statuses['429'] ?? 0).toBe(0);

    // Past the five-minute window the tab reads at its own pace again and says so.
    await page.clock.fastForward('05:10');
    await expect(status).toHaveAttribute('data-status', 'live', { timeout: 45_000 });
    await resetCalls(page);
    const t1 = await page.evaluate(() => Date.now());
    await page.waitForTimeout(25_000);
    const recovered = await callRate(page, t1, 1);
    console.log(`[budget] 25 s after the back-off: ${recovered.total} calls ${JSON.stringify(recovered.entries.map((e) => familyOf(e)))}`);
    // Each poll reads meta; the snapshot only once meta moved (P1-D05), so meta is what shows the pace is back.
    expect(countOf(recovered, 'GET kv:meta')).toBeGreaterThanOrEqual(2);
    expect(errors()).toEqual([]);
  });
});
