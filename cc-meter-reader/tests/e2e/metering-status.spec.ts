// tests/e2e/metering-status.spec.ts — the chrome tells the truth about metering (EPIC_AUDIT WP-D):
//
//   • P0-07  a refused (403), rate-limited (429) or failing sweep is visible within two sweeps: the status chip
//            leaves "Live", the Receipt says why in words (metricsForbidden, "Next sweep in 0:42"), Settings →
//            Runtime prints the same human copy, and recovery clears all three without a reload;
//   • P1-D01 hydration failures reach the chip: "Not metering yet" without prices, Offline when every KV read
//            answers 500, Signed out after a 401 on a good load;
//   • P1-D02 a cold load whose snapshot answers 500 says "Nothing to show yet", with no toast and no age;
//   • P1-D03 a runner that went quiet is named on the hero, with when;
//   • P1-D05 the Leader budget an open tab spends: ≤ 15 calls a minute beside a fresh runner, ≤ 35 metering
//            alone, ≤ 40 on the presenter view;
//   • P1-D06 saving four $0 prices puts `/` and `/first-run` on the same view with the $0 notice; the Ledger's
//            empty state offers Set prices.
//
// Time: the emulator runs in the page, so `page.clock` fakes the Leader's clock and the app's together, and the
// tab's own 30-second sweeps run as the fake clock moves (the same model as demo.spec.ts).
//
// Evidence: tests/report/screens/wave1-d-<state>-<theme>-<width>.png at 1440 and 390, both themes, written by the
// `chromium` project only (it sets both widths itself), so the 1920 and phone projects never overwrite them.

import { expect, test, type Page } from '@playwright/test';
import { defaultSettings } from '../../core/settings.ts';
import { injectLedgerDocs, loadDemoFixture } from './ledger-fixture.ts';
import { gotoApp, kvGet, mockCalls, mockControl, resetCalls, resetMock, setTheme, trackConsoleErrors, waitForHydration, waitForMock, type Theme } from './helpers/index.ts';

const MINUTE = 60_000;
const DAY = 86_400_000;
const THEMES: readonly Theme[] = ['light', 'dark'];
const RIG = ['mrd_siem_prod', 'mrd_analytics', 'mrd_archive_s3', 'devnull'] as const;

/** The dev server re-optimizing a dependency mid-run is an environment artifact; the emulator has no bell endpoint yet. */
const ALLOW = [/Outdated Optimize Dep/, /\/system\/messages/];
/**
 * Faults this spec injects on purpose: the browser logs every refused request as a console error, and the sweep
 * logs the failure it records (core/sweep.ts `logger.error('sweep failed', …)`).
 */
const FAULTS = [/Failed to load resource: the server responded with a status of (401|403|429|500)/, /\[meter-reader\] sweep(:| failed| stopped)/];

test.describe.configure({ mode: 'default' });

// ─── Seeding ─────────────────────────────────────────────────────────────────

async function putKv(page: Page, docs: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (entries) => {
    for (const [key, value] of entries) {
      const r = await fetch(`/mock-api/v1/kvstore/${key}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(value) });
      if (r.status >= 300) throw new Error(`PUT ${key} → ${r.status}`);
    }
  }, Object.entries(docs));
}

async function kvJson<T>(page: Page, key: string): Promise<T | null> {
  const raw = await kvGet(page, key);
  return raw === null ? null : (JSON.parse(raw) as T);
}

/** The rig's four destinations at typical list prices (or every one at `flat` dollars), effective 3 days ago. */
function pricesDoc(nowMs: number, flat?: number): Record<string, unknown> {
  const at = new Date(nowMs - 3 * DAY).toISOString();
  const mc = (dollars: number) => Math.round((flat ?? dollars) * 100_000);
  return {
    schemaVersion: 1,
    updatedAt: at,
    versions: [
      {
        effectiveFrom: at,
        byOutputId: {
          mrd_siem_prod: { milliCentsPerGb: mc(2.25), preset: 'splunk_cloud' },
          mrd_analytics: { milliCentsPerGb: mc(1.8), preset: 'datadog' },
          mrd_archive_s3: { milliCentsPerGb: mc(0.023), preset: 's3' },
        },
      },
    ],
  };
}

/**
 * A fresh emulated org with the first-run card on screen. The card is waited for before anything navigates: a
 * reload while the lazy view chunk is still loading cancels its import, and Firefox then logs a view crash.
 */
async function openFresh(page: Page): Promise<void> {
  await gotoApp(page, '/first-run');
  await expect(page.getByTestId('first-run')).toBeVisible();
  await resetMock(page);
}

// ─── Reading the chrome ──────────────────────────────────────────────────────

const chip = (page: Page) => page.locator('.mr-status').first();
const chipStatus = (page: Page) => chip(page).getAttribute('data-status');

/** Advances fake time in steps until `until()` holds; each step leaves real time for sweeps and polls to land. */
async function advanceUntil(page: Page, until: () => Promise<boolean>, maxFakeMs: number, label: string, stepMs = 10_000): Promise<number> {
  let elapsed = 0;
  while (!(await until())) {
    if (elapsed >= maxFakeMs) throw new Error(`${label}: not within ${maxFakeMs / 1000} s of fake time (chip ${await chipStatus(page)})`);
    await page.clock.fastForward(stepMs);
    elapsed += stepMs;
    await page.waitForTimeout(600);
  }
  return elapsed;
}

/** A fresh emulated org with prices, the Receipt open and this tab's first sweep landed (chip "Live"). */
async function openMetering(page: Page, path = '/'): Promise<number> {
  await page.clock.install();
  await openFresh(page);
  const now = await page.evaluate(() => Date.now());
  await putKv(page, { prices: pricesDoc(now) });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await advanceUntil(page, async () => (await chipStatus(page)) === 'live', 5 * MINUTE, 'first sweep', 5_000);
  return now;
}

/** In-app navigation (the store, and this tab's failure streak, survive it; a reload would not). */
async function openRuntime(page: Page): Promise<void> {
  await page.getByRole('navigation').first().getByRole('link', { name: /settings/i }).first().click();
  await expect(page.locator('.mr-settings')).toBeVisible();
  const item = page.locator('.mr-settings-rail [data-section="runtime"]').first();
  if (await item.isVisible()) await item.click();
  else {
    await page.getByRole('button', { name: /Section/ }).click();
    await page.getByRole('option', { name: 'Runtime', exact: true }).click();
  }
  await expect(page.locator('section[data-section="runtime"]')).toBeVisible();
}

async function openReceipt(page: Page): Promise<void> {
  await page.getByRole('navigation').first().getByRole('link', { name: /receipt/i }).first().click();
  await expect(page.getByTestId('receipt-hero')).toBeVisible();
}

/** Both themes at 1440 and 390 (chromium project only), then back to light at 1440. */
async function shoot(page: Page, id: string, opts: { focus?: string } = {}): Promise<void> {
  if (test.info().project.name !== 'chromium') return;
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.mouse.move(0, 0);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    for (const size of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(250);
      if (opts.focus) await page.locator(opts.focus).first().scrollIntoViewIfNeeded().catch(() => undefined);
      await page.screenshot({ path: `tests/report/screens/wave1-d-${id}-${theme}-${size.width}.png`, fullPage: size.width === 390 });
    }
  }
  await setTheme(page, 'light');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.scrollTo(0, 0));
}

// ─── P0-07: a refused, rate-limited or failing sweep is visible ─────────────

test.describe('P0-07 sweep failures reach the chip, the Receipt and Settings → Runtime', () => {
  test('metrics 403 for 100 s: non-Live within two sweeps, metricsForbidden on the Receipt and in Runtime, recovery without reload', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = trackConsoleErrors(page, [...ALLOW, ...FAULTS]);
    await openMetering(page);
    const sweepsBefore = (await kvJson<{ sweepErrors: number }>(page, 'meta'))?.sweepErrors ?? 0;

    await mockControl(page, { action: 'fault', method: 'POST', path: '/system/metrics/query', status: 403, times: -1 });
    const faultedFor = await advanceUntil(page, async () => (await chipStatus(page)) === 'failing', 2 * MINUTE, 'chip leaves Live');
    // Within two sweeps: a 403 no retry fixes shows on the first failed one.
    expect((await kvJson<{ sweepErrors: number }>(page, 'meta'))?.sweepErrors ?? 0).toBeLessThanOrEqual(sweepsBefore + 2);
    await expect(chip(page)).toContainText('Not metering');
    await expect(chip(page)).toContainText(/since \d{1,2}:\d{2}/);

    const notice = page.getByTestId('metering-notice');
    await expect(notice).toHaveAttribute('data-kind', 'metrics-forbidden');
    await expect(notice).toContainText(/Not metering since \d{1,2}:\d{2}/);
    await expect(notice).toContainText("Couldn't read metrics for default: your role can't view them. Ask an administrator for Monitoring access.");
    await expect(notice).not.toContainText('HTTP');
    await expect(page.getByTestId('footer-sweep')).toHaveAttribute('data-state', 'failing');
    await expect(page.getByTestId('footer-sweep')).toContainText(/^No sweep has succeeded since \d{1,2}:\d{2}/);
    await shoot(page, 'metrics-403-receipt', { focus: '[data-testid="metering-notice"]' });

    await openRuntime(page);
    const runtime = page.locator('section[data-section="runtime"]');
    await expect(runtime.getByTestId('metering-notice')).toContainText("Couldn't read metrics for default");
    await expect(runtime).not.toContainText(/HTTP 403|query failed|\{"/);
    await shoot(page, 'metrics-403-runtime', { focus: 'section[data-section="runtime"]' });

    // Keep the fault for 100 s in all, then let the next sweep through.
    if (faultedFor < 100_000) await page.clock.fastForward(100_000 - faultedFor);
    await mockControl(page, { action: 'clearFaults' });
    await advanceUntil(page, async () => (await chipStatus(page)) === 'live', 2 * MINUTE, 'recovery');
    await expect(runtime.getByTestId('metering-notice')).toHaveCount(0);
    await openReceipt(page);
    await expect(page.getByTestId('metering-notice')).toHaveCount(0);
    await expect(page.getByTestId('footer-sweep')).toContainText(/^Last sweep/);
    expect(errors()).toEqual([]);
  });

  test('metrics 403 before the first sweep: the empty hero says why, never "Waiting for the first sweep" (craft review, round 1)', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = trackConsoleErrors(page, [...ALLOW, ...FAULTS]);
    await page.clock.install();
    await openFresh(page);
    const now = await page.evaluate(() => Date.now());
    await mockControl(page, { action: 'fault', method: 'POST', path: '/system/metrics/query', status: 403, times: -1 });
    await putKv(page, { prices: pricesDoc(now) });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await advanceUntil(page, async () => (await chipStatus(page)) === 'failing', 2 * MINUTE, 'chip reads Not metering');
    await expect(page.getByTestId('metering-notice')).toHaveAttribute('data-kind', 'metrics-forbidden');
    await expect(page.getByTestId('hero-caption')).toHaveText('Not metering: metrics access refused. Figures appear after the first sweep that succeeds.');
    // Nothing will load until a sweep succeeds: no loading outlines under the notice (craft review, round 2).
    await expect(page.locator('[data-state="waiting"][data-stopped="failing"]')).toBeVisible();
    await expect(page.locator('[data-state="waiting"] .mr-ghost')).toHaveCount(0);
    await expect(page.locator('.mr-hero-aside--ghost')).toHaveCount(0);
    await expect(page.getByTestId('ghost-card-stopped')).toHaveCount(4);
    await expect(page.getByTestId('ghost-card-stopped').first()).toHaveText('Nothing to show until a sweep succeeds.');
    await mockControl(page, { action: 'clearFaults' });
    expect(errors()).toEqual([]);
  });

  test('metrics 429: Rate limited, and while the sweeps back off the chip and the notice name when metering resumes, then recovery', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = trackConsoleErrors(page, [...ALLOW, ...FAULTS]);
    await openMetering(page);
    await mockControl(page, { action: 'fault', method: 'POST', path: '/system/metrics/query', status: 429, times: -1 });
    await advanceUntil(page, async () => (await chipStatus(page)) === 'rate-limited', 3 * MINUTE, 'chip reads Rate limited');
    // P1-E01's back-off: no sweep calls Cribl before meta.rateLimitedUntil, so the chip names that time instead of
    // counting down to a tick that skips (review W2), and the notice says what happened in the past tense.
    const meta = await kvJson<{ rateLimitedUntil?: string; rateLimitedSince?: string }>(page, 'meta');
    expect(meta?.rateLimitedUntil).toBeDefined();
    // The display zone: the browser's (playwright.config timezoneId), as a fresh workspace's settings take it.
    const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    const until = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone }).format(Date.parse(meta!.rateLimitedUntil!));
    await expect(chip(page)).toContainText(`metering resumes at ${until}`.replace(/\s/g, ' '));
    await expect(chip(page)).not.toContainText(/next sweep in/);
    const notice = page.getByTestId('metering-notice');
    await expect(notice).toHaveAttribute('data-kind', 'rate-limited');
    await expect(notice).toContainText(/Cribl rate-limited Meter Reader at \d{1,2}:\d\d\s[AP]M\. Metering resumes at \d{1,2}:\d\d\s[AP]M\./);
    await expect(notice).toContainText(until.replace(/\s/g, ' '));
    await expect(notice).not.toContainText('rate_limited');
    await shoot(page, 'metrics-429-receipt', { focus: '[data-testid="metering-notice"]' });

    await openRuntime(page);
    await expect(page.locator('section[data-section="runtime"]').getByTestId('metering-notice')).toContainText(/Cribl rate-limited Meter Reader at .+\. Metering resumes at .+\./);
    await expect(page.locator('section[data-section="runtime"]')).not.toContainText('rate_limited');

    await mockControl(page, { action: 'clearFaults' });
    // A limited sweep backs off 2, then 4 minutes before it calls again (P1-E01), so the recovery waits that out.
    await advanceUntil(page, async () => (await chipStatus(page)) === 'live', 6 * MINUTE, 'recovery');
    await expect(page.locator('section[data-section="runtime"]').getByTestId('metering-notice')).toHaveCount(0);
    await openReceipt(page);
    await expect(page.getByTestId('metering-notice')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });
});

// ─── P1-D01: hydration failures reach the chip ──────────────────────────────

test.describe('P1-D01 the chip after hydration', () => {
  test('first run without prices reads "Not metering yet", never "Waiting for the first sweep"', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await openFresh(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(chip(page)).toHaveAttribute('data-status', 'not-metering');
    await expect(chip(page)).toContainText('Not metering yet');
    await expect(chip(page)).not.toContainText(/waiting/i);
    await expect(page.getByTestId('footer-runtime')).toHaveText('Set prices to start the meter');
    await shoot(page, 'first-run-not-metering');
    expect(errors()).toEqual([]);
  });

  test('every KV read answering 500 reads Offline as soon as hydration ends', async ({ page }) => {
    const errors = trackConsoleErrors(page, [...ALLOW, ...FAULTS]);
    await openFresh(page);
    await mockControl(page, { action: 'fault', method: 'GET', pattern: '/kvstore/', status: 500, times: -1 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMock(page);
    // The moment hydration ends — before the first poll, 10 s later — the chip already says Offline.
    await expect.poll(() => chipStatus(page), { timeout: 8_000, intervals: [50] }).not.toBe('connecting');
    expect(await chipStatus(page)).toBe('offline');
    await expect(chip(page)).toContainText('Offline');
    await expect(chip(page)).not.toContainText(/updated|waiting/i);
    // The footer agrees: this tab can't read its settings, so it isn't metering ("Meters every 30 seconds" was a lie).
    await expect(page.getByTestId('footer-runtime')).toHaveText('Metering starts once Meter Reader can read its settings');
    await shoot(page, 'kv-500-offline');
    await mockControl(page, { action: 'clearFaults' });
    expect(errors()).toEqual([]);
  });

  test('a 401 after a good load reads Signed out with Reload; the next good poll reads Live again', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = trackConsoleErrors(page, [...ALLOW, ...FAULTS]);
    await openMetering(page);
    await mockControl(page, { action: 'fault', method: 'GET', pattern: '/kvstore/(snapshot|meta)$', status: 401, times: -1 });
    await advanceUntil(page, async () => (await chipStatus(page)) === 'signed-out', MINUTE, 'Signed out', 5_000);
    await expect(chip(page)).toContainText('Signed out');
    // The chip carries Reload where it has room; a phone's chip is only a dot, and the page says so instead.
    if ((page.viewportSize()?.width ?? 0) > 640) await expect(chip(page).getByRole('button', { name: 'Reload' })).toBeVisible();
    const notice = page.getByTestId('metering-notice');
    await expect(notice).toHaveAttribute('data-state', 'signed-out');
    await expect(notice).toContainText('Reload the page to sign in to Cribl again.');
    await expect(notice.getByRole('button', { name: 'Reload' })).toBeVisible();
    await shoot(page, 'signed-out', { focus: '[data-testid="metering-notice"]' });
    await mockControl(page, { action: 'clearFaults' });
    await advanceUntil(page, async () => (await chipStatus(page)) === 'live', MINUTE, 'Live again', 5_000);
    await expect(page.getByTestId('metering-notice')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });
});

// ─── P1-D02: no "last good data" without data ────────────────────────────────

test.describe('P1-D02 a cold load whose snapshot answers 500', () => {
  test('says "Nothing to show yet", raises no toast and quotes no age', async ({ page }) => {
    const errors = trackConsoleErrors(page, [...ALLOW, ...FAULTS]);
    await openFresh(page);
    const now = await page.evaluate(() => Date.now());
    // Backend runtime: this tab never sweeps, so the snapshot stays unreadable and nothing else moves.
    await putKv(page, {
      settings: { ...defaultSettings(new Date(now).toISOString(), 'UTC', 'backend'), updatedAt: new Date(now).toISOString() },
      prices: pricesDoc(now),
      meta: {
        schemaVersion: 1,
        installedAt: new Date(now - DAY).toISOString(),
        collectingSince: new Date(now - DAY).toISOString(),
        appVersion: '1.0.0',
        build: 'release',
        metricsSource: 'metrics-query',
        lastSweepAt: new Date(now - 30_000).toISOString(),
        lastSweepOwner: 'backend:meter',
        sweepErrors: 0,
        consecutiveRateLimited: 0,
        sweepCount: 12,
      },
    });
    await mockControl(page, { action: 'fault', method: 'GET', path: '/kvstore/snapshot', status: 500, times: -1 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForMock(page);
    const alert = page.locator('[data-state="server-error"]');
    await expect(alert).toBeVisible({ timeout: 15_000 });
    await expect(alert).toContainText('Nothing to show yet. Meter Reader will keep trying.');
    await expect(alert).not.toContainText('Showing the last good data');
    await page.waitForTimeout(1_500);
    await expect(page.getByText(/Showing the last good data/)).toHaveCount(0); // no toast
    await expect(chip(page)).not.toContainText(/updated/);
    await shoot(page, 'snapshot-500-cold');
    await mockControl(page, { action: 'clearFaults' });
    expect(errors()).toEqual([]);
  });
});

// ─── P1-D03: a meter that went quiet is named, with when ─────────────────────

test.describe('P1-D03 stale figures explain themselves', () => {
  test('a runner silent for 20 min: Stale chip, the hero caveat and the footer say who stopped and when', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = trackConsoleErrors(page, ALLOW);
    // The demo fixture ends 20 minutes ago; its settings use the backend runtime, so this tab never re-meters it.
    const docs = loadDemoFixture(Date.now() - 20 * MINUTE);
    docs.meta = { ...docs.meta, lastSweepOwner: 'runner:workhorse:4242' };
    await openFresh(page);
    await injectLedgerDocs(page, docs);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.getByTestId('receipt-hero')).toBeVisible();
    await expect(chip(page)).toHaveAttribute('data-status', 'stale');
    const notice = page.getByTestId('metering-notice');
    await expect(notice).toHaveAttribute('data-state', 'stale');
    // The fixture takes a few seconds to build, so "20 min" may read 21 or 22 by the time the page shows it.
    await expect(notice).toContainText(/^Not updated since \d{1,2}:\d{2} [AP]M\. The runner on workhorse stopped sweeping 2\d min ago\.$/);
    await expect(page.getByTestId('footer-runtime')).toHaveText(/^The runner on workhorse stopped sweeping 2\d min ago$/);
    await expect(chip(page)).toContainText(/Stale.*updated 2\d min ago/);
    await shoot(page, 'stale-runner', { focus: '[data-testid="metering-notice"]' });
    expect(errors()).toEqual([]);
  });
});

// ─── P1-D05: the Leader budget of an open tab ────────────────────────────────

/**
 * Waits until this tab has metered the last settled minute (meta.meteredThrough is current) and no sweep is in
 * flight, so a one-minute window that starts now holds exactly one settle point, hence at most one sweep.
 */
async function steadyState(page: Page): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const meta = await kvJson<{ meteredThrough?: string }>(page, 'meta');
    const now = await page.evaluate(() => Date.now());
    const through = meta?.meteredThrough ? Date.parse(meta.meteredThrough) : Number.NaN;
    if (Number.isFinite(through) && through >= Math.floor((now - 20_000) / MINUTE) * MINUTE) {
      await page.waitForTimeout(1_000); // the sweep's last writes (meta, then the lock release)
      return;
    }
    await page.clock.fastForward(5_000);
    await page.waitForTimeout(800);
  }
  throw new Error('the tab never caught up with the last settled minute');
}

/** Leader calls (the emulator's journal) over one minute of fake time, polled and swept as the app does. */
async function callsOverOneMinute(page: Page): Promise<{ total: number; byRoute: Record<string, number> }> {
  await resetCalls(page);
  for (let i = 0; i < 60; i++) {
    await page.clock.fastForward(1_000);
    await page.waitForTimeout(80);
  }
  const calls = await mockCalls(page);
  return { total: calls.total, byRoute: calls.byRoute };
}

test.describe('P1-D05 an open tab spends the Leader budget carefully', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1000, 'the budget does not depend on the width');

  test('beside a fresh runner a tab only reads: ≤ 15 calls a minute and no sweep', async ({ page }) => {
    test.setTimeout(120_000);
    await page.clock.install();
    await openFresh(page);
    const now = await page.evaluate(() => Date.now());
    await putKv(page, {
      prices: pricesDoc(now),
      meta: {
        schemaVersion: 1,
        installedAt: new Date(now - DAY).toISOString(),
        collectingSince: new Date(now - DAY).toISOString(),
        appVersion: 'runner',
        build: 'release',
        metricsSource: 'metrics-query',
        lastSweepAt: new Date(now).toISOString(),
        lastSweepOwner: 'runner:workhorse:4242',
        meteredThrough: new Date(Math.floor((now - 20_000) / MINUTE) * MINUTE).toISOString(),
        sweepErrors: 0,
        consecutiveRateLimited: 0,
        sweepCount: 500,
      },
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const { total, byRoute } = await callsOverOneMinute(page);
    console.log(`[P1-D05] calls/min beside a fresh runner: ${total} ${JSON.stringify(byRoute)}`);
    expect(total).toBeLessThanOrEqual(15);
    expect(byRoute['POST /system/metrics/query'] ?? 0).toBe(0);
    await expect(page.getByTestId('footer-runtime')).toHaveText('Metered every minute by the runner on workhorse');
  });

  test('metering alone: ≤ 35 calls a minute, sweep included', async ({ page }) => {
    test.setTimeout(240_000);
    await openMetering(page);
    // Past the first sweep's hour of backfill: one steady minute first, then measure from a caught-up meter.
    await page.clock.fastForward(MINUTE);
    await steadyState(page);
    const { total, byRoute } = await callsOverOneMinute(page);
    console.log(`[P1-D05] calls/min metering alone: ${total} ${JSON.stringify(byRoute)}`);
    expect(byRoute['POST /system/metrics/query'] ?? 0).toBeGreaterThan(0); // it did meter
    expect(total).toBeLessThanOrEqual(35);
  });

  test('presenter view: ≤ 40 calls a minute, sweep included', async ({ page }) => {
    test.setTimeout(240_000);
    await openMetering(page);
    await page.keyboard.press('p'); // the presenter view (P), polling every 5 s
    await expect(page.getByLabel('Presenter view')).toBeVisible();
    await page.clock.fastForward(MINUTE);
    await steadyState(page);
    const { total, byRoute } = await callsOverOneMinute(page);
    console.log(`[P1-D05] calls/min presenter: ${total} ${JSON.stringify(byRoute)}`);
    expect(total).toBeLessThanOrEqual(40);
  });
});

// ─── P1-D06: one first-run gate, and a $0 workspace says so ──────────────────

test.describe('P1-D06 all-$0 prices', () => {
  test('the empty Ledger offers Set prices', async ({ page }) => {
    const errors = trackConsoleErrors(page, ALLOW);
    await openFresh(page);
    await page.goto('/ledger', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const set = page.getByTestId('ledger-set-prices');
    await expect(set).toBeVisible();
    await expect(set).toHaveText('Set prices');
    await shoot(page, 'ledger-empty-set-prices');
    await set.click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/settings/prices');
    expect(errors()).toEqual([]);
  });

  test("saving four $0 prices: '/' and '/first-run' show the same Receipt with the $0 notice", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = trackConsoleErrors(page, ALLOW);
    await openFresh(page);
    await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    for (const id of RIG) await expect(page.getByTestId(`price-row-${id}`)).toBeVisible({ timeout: 40_000 });
    for (const id of RIG) await page.getByTestId(`price-input-${id}`).fill('0');
    // A never-priced workspace's first save reads "Start the meter" and says the meter is running (P2-W09).
    await page.locator('section[data-section="prices"]').getByRole('button', { name: 'Start the meter' }).click();
    await expect(page.getByText('The meter is running.', { exact: false }).first()).toBeVisible();
    // The first sweep runs the moment prices are saved; let it land before leaving the page (a navigation
    // mid-sweep leaves the KV lock held for its 90 s TTL).
    await expect(page.getByTestId('footer-sweep')).toContainText(/^Last sweep/, { timeout: 60_000 });
    const stored = await kvJson<{ versions: { byOutputId: Record<string, { milliCentsPerGb: number }> }[] }>(page, 'prices');
    const newest = stored?.versions.at(-1)?.byOutputId ?? {};
    expect(RIG.map((id) => (newest[`default:${id}`] ?? newest[id])?.milliCentsPerGb)).toEqual([0, 0, 0, 0]);

    for (const path of ['/', '/first-run']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await waitForHydration(page);
      await expect.poll(() => new URL(page.url()).pathname).toBe('/');
      await expect(page.getByTestId('first-run')).toHaveCount(0);
      const zero = page.getByTestId('zero-priced-notice');
      await expect(zero).toBeVisible({ timeout: 45_000 });
      await expect(zero).toContainText('Every destination is priced at $0. Nothing can count as saved until a destination has a price above $0.');
    }
    // After the sweep: the Receipt, and "Where the money goes" says what the sweep read.
    await expect(page.getByTestId('receipt-hero')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('receipt-destinations')).toContainText('No money flows yet');
    await expect(page.getByTestId('receipt-destinations')).toContainText(/The sweep read \d+ destinations?, (all )?priced at \$0 or with no traffic\./);
    await shoot(page, 'zero-priced-receipt', { focus: '[data-testid="zero-priced-notice"]' });
    await page.getByTestId('zero-priced-notice').getByRole('button', { name: 'Set prices' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/settings/prices');
    expect(errors()).toEqual([]);
  });
});
