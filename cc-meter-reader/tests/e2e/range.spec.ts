// tests/e2e/range.spec.ts — the Receipt hero's custom time range (core/range.ts, src/views/Receipt/RangePicker.tsx)
// on the in-browser Cribl emulator: the emulator seeds deterministic rollup history (testdata/rollups.ts), the
// workspace runs the `backend` runtime so no sweep in the tab rewrites it, and every figure the hero shows is
// checked against the SAME documents read back from the emulator's KV and summed with core/range in Node — the
// hero publishes the window it summed (`data-range-from/to/granularity`) so the check is exact.
//
// Runs in every project (chromium desktop / 1920 / phone, and firefox + webkit when asked for); the fixed-name
// screenshots under tests/report/screens/ are shot from the chromium project only, at 1440 and 390.

import { expect, test, type Page } from '@playwright/test';
import { fmtDollars, footMoney } from '../../core/format.ts';
import { formatInt } from '../../src/lib/format.ts';
import { computeHeadline } from '../../core/pricing.ts';
import { planRangeReads, resolveRange, sumRange, type RangeDoc, type RangeFigures, type RangeGranularity } from '../../core/range.ts';
import { dayDocKey, hourDocKey, minuteDocKey } from '../../core/rollups.ts';
import { defaultSettings } from '../../core/settings.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, formatLocalDateTimeInput, formatLocalTime, hourFloor, localDayKey, localDayStartMs, utcDayFloor } from '../../core/time.ts';
import type { Meta, Settings, Snapshot, TotalsDoc } from '../../core/types.ts';
import {
  RIG_PRICES,
  allowClipboard,
  gotoApp,
  kvGet,
  mockControl,
  readClipboard,
  resetMock,
  screenPath,
  setTheme,
  trackConsoleErrors,
  waitForHydration,
} from './helpers/index.ts';

const TZ = 'America/Chicago';

async function putKv(page: Page, docs: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (entries) => {
    for (const [key, value] of entries) {
      const r = await fetch(`/mock-api/v1/kvstore/${key}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(value) });
      if (r.status >= 300) throw new Error(`PUT ${key} → ${r.status}`);
    }
  }, Object.entries(docs));
}

/** Several KV values in one round trip (null where absent). */
async function kvGetMany(page: Page, keys: string[]): Promise<Record<string, string | null>> {
  return page.evaluate(async (list) => {
    const out: Record<string, string | null> = {};
    await Promise.all(
      list.map(async (k) => {
        const r = await fetch(`/mock-api/v1/kvstore/${k.split('/').map(encodeURIComponent).join('/')}`);
        out[k] = r.status === 404 ? null : await r.text();
      }),
    );
    return out;
  }, keys);
}

interface Workspace {
  at: number;
  since: number;
  headline: Snapshot['headline'];
}

/**
 * A fresh emulated org with 40 days of seeded rollup history, priced at the rig's prices, under a
 * backend-runtime workspace whose snapshot headline comes from the seed's own totals. Opens `path`.
 */
async function openWithHistory(page: Page, path = '/'): Promise<Workspace> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  const at = await page.evaluate(() => Date.now());
  const since = localDayStartMs(localDayKey(at - 40 * DAY_MS, TZ), TZ) + (21 * 60 + 41) * MINUTE_MS; // 9:41 PM, 40 days ago
  const seeded = await mockControl(page, { action: 'seedRollups', at, since, tz: TZ, prices: RIG_PRICES });
  expect(seeded.keys as number).toBeGreaterThan(60);
  const totals = JSON.parse((await kvGet(page, 'totals')) ?? '{}') as TotalsDoc;
  const headline = computeHeadline(totals, at, TZ, since);
  const iso = (ms: number) => new Date(ms).toISOString();
  const settings: Settings = { ...defaultSettings(iso(at), TZ), runtime: 'backend' };
  const snapshot: Snapshot = {
    schemaVersion: 1,
    sweepAt: iso(at),
    windowStart: iso(Math.floor(at / MINUTE_MS) * MINUTE_MS - MINUTE_MS),
    windowEnd: iso(Math.floor(at / MINUTE_MS) * MINUTE_MS),
    mode: 'scheduled',
    headline,
    ratePerSecM: Math.round(headline.todayM / Math.max(1, (at - localDayStartMs(localDayKey(at, TZ), TZ)) / 1000)),
    flows: [],
    destinations: [],
    topSavers: [],
    unpricedOutputIds: [],
    openIncidents: 0,
    incidents: [],
    trend: [],
    ratioSeries: [],
    timeline: [],
    deliveries: [],
    calls: 23,
    collectingSince: iso(since),
    metricsSource: 'metrics-query',
    attributionSummary: 'reconciled',
  };
  const meta: Meta = {
    schemaVersion: 1,
    installedAt: iso(since),
    collectingSince: iso(since),
    appVersion: '1.1.0',
    build: 'release',
    metricsSource: 'metrics-query',
    lastSweepAt: iso(at),
    lastSweepMs: 800,
    lastSweepCalls: 23,
    lastSweepMode: 'scheduled',
    sweepErrors: 0,
    consecutiveRateLimited: 0,
    sweepCount: 57_600,
    // The sweep's cursor: the seed's newest row is the minute before it, and every hour and UTC day that ended
    // by it is folded (testdata/rollups.ts) — the reader's hybrid plan relies on exactly this (api-budget F2).
    meteredThrough: iso(Math.floor(at / MINUTE_MS) * MINUTE_MS),
  };
  await putKv(page, { settings, prices: RIG_PRICES, meta, snapshot });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await page.getByTestId(path.startsWith('/ledger') ? 'change-timeline' : 'receipt-hero').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { at, since, headline };
}

const hero = (page: Page) => page.getByTestId('receipt-hero');
const customToggle = (page: Page) => page.getByRole('radiogroup', { name: 'Headline period' }).getByRole('radio', { name: 'Custom' });
const picker = (page: Page) => page.getByRole('dialog', { name: 'Custom range' });

/** Opens the picker: Custom opens it, and re-opens it while it is the selected item. */
async function openPicker(page: Page): Promise<void> {
  await customToggle(page).click();
  await picker(page).waitFor();
}

/** Waits for the hero to show a summed range and returns the window it says it summed. */
async function shownWindow(page: Page): Promise<{ fromMs: number; toMs: number; granularity: RangeGranularity }> {
  await expect(hero(page)).toHaveAttribute('data-range-status', 'ready', { timeout: 20_000 });
  const from = await hero(page).getAttribute('data-range-from');
  const to = await hero(page).getAttribute('data-range-to');
  const granularity = await hero(page).getAttribute('data-range-granularity');
  if (!from || !to || !granularity) throw new Error('the hero did not publish its window');
  return { fromMs: Date.parse(from), toMs: Date.parse(to), granularity: granularity as RangeGranularity };
}

/**
 * The documents holding the window the hero says it summed, enumerated from that window and granularity (not
 * re-planned against the test's later clock, which could sit past a minute boundary the UI was before).
 */
function keysFor(w: { fromMs: number; toMs: number; granularity: RangeGranularity }): string[] {
  const last = Math.max(w.fromMs, w.toMs - 1);
  const keys: string[] = [];
  if (w.granularity === 'minute') for (let h = hourFloor(w.fromMs); h <= hourFloor(last); h += HOUR_MS) keys.push(minuteDocKey(h));
  else if (w.granularity === 'hour') for (let d = utcDayFloor(w.fromMs); d <= utcDayFloor(last); d += DAY_MS) keys.push(hourDocKey(d));
  else {
    const first = new Date(w.fromMs);
    for (let m = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1); m <= last; m = new Date(m).setUTCMonth(new Date(m).getUTCMonth() + 1)) keys.push(dayDocKey(m));
  }
  return keys;
}

/** The same documents the app read, summed in Node with core/range. */
async function expectedFigures(page: Page, w: { fromMs: number; toMs: number; granularity: RangeGranularity }): Promise<RangeFigures> {
  const keys = keysFor(w);
  const raw = await kvGetMany(page, keys);
  const docs: Record<string, RangeDoc | null> = {};
  for (const key of keys) docs[key] = raw[key] === null ? null : (JSON.parse(raw[key] as string) as RangeDoc);
  return sumRange(docs, w.granularity, w.fromMs, w.toMs);
}

async function meterValue(page: Page): Promise<number> {
  return Number(await page.locator('[data-testid="receipt-hero"] [data-callout="saved"]').getAttribute('data-value-m'));
}

function shoots(): boolean {
  return test.info().project.name === 'chromium';
}

/** Firefox and WebKit paint native date fields their own way, so the picker is also shot there, suffixed by engine. */
function pickerShot(theme: 'light' | 'dark', page: Page): string | undefined {
  const name = test.info().project.name;
  if (name === 'chromium') return screenPath('range-picker', theme, page);
  if (name === 'firefox' || name === 'webkit') return screenPath('range-picker', theme, page).replace(/\.png$/, `-${name}.png`);
  return undefined;
}

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.mouse.move(0, 0);
}

/** Screenshots of this package's changes (wave 1, WP-R), from the chromium project only. */
function wave1Shot(id: string, theme: 'light' | 'dark', page: Page): string | undefined {
  if (!shoots()) return undefined;
  return `tests/report/screens/wave1-r-${id}-${theme}-${page.viewportSize()?.width ?? 0}.png`;
}

/** Shoots the hero in both themes at 1440 and 390 (chromium only), then puts the viewport and theme back. */
async function shootBothSizes(page: Page, id: string): Promise<void> {
  if (!shoots()) return;
  const size = page.viewportSize();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width > 640 ? 900 : 844 });
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await blur(page);
      const shot = wave1Shot(id, theme, page);
      if (shot) await hero(page).screenshot({ path: shot });
    }
  }
  if (size) await page.setViewportSize(size);
  await setTheme(page, 'light');
}

type Box = { x: number; y: number; width: number; height: number };
const intersects = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Counts the app's GETs of rollup documents (in the page: the emulator is a service worker page.route cannot see). */
async function countRollupReads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    const w = window as unknown as { __mrRollReads?: string[] };
    w.__mrRollReads = [];
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const m = /kvstore\/(roll(?:\/|%2F).*)$/.exec(url);
      if (m && method === 'GET') w.__mrRollReads!.push(decodeURIComponent(m[1]));
      return real(input, init);
    };
  });
}
const rollupReads = (page: Page): Promise<string[]> => page.evaluate(() => [...((window as unknown as { __mrRollReads?: string[] }).__mrRollReads ?? [])]);
const resetRollupReads = (page: Page): Promise<void> => page.evaluate(() => void ((window as unknown as { __mrRollReads?: string[] }).__mrRollReads = []));

test.describe('Custom time range on the Receipt', () => {
  test('the 6 h quick pick sums the last six hours minute-exact, and the hero says so', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openWithHistory(page);
    await expect(customToggle(page)).toHaveAttribute('aria-checked', 'false');
    await openPicker(page);
    await picker(page).getByRole('radio', { name: '6 h' }).click();
    await picker(page).getByRole('button', { name: 'Apply' }).click();
    await expect(picker(page)).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get('range')).toBe('6h');
    await expect(customToggle(page)).toHaveAttribute('aria-checked', 'true');

    const w = await shownWindow(page);
    expect(w.granularity).toBe('minute');
    expect(w.toMs - w.fromMs).toBe(6 * HOUR_MS);
    const now = await page.evaluate(() => Date.now());
    expect(w.toMs).toBeLessThanOrEqual(now);
    expect(w.toMs).toBeGreaterThan(now - 3 * MINUTE_MS);
    expect(w.toMs % MINUTE_MS).toBe(0);

    const expected = await expectedFigures(page, w);
    expect(expected.rows).toBeGreaterThan(0);
    expect(await meterValue(page)).toBe(expected.savedM);
    const figure = page.locator('[data-testid="receipt-hero"] [data-callout="saved"]');
    await expect(figure).toHaveAttribute('data-ticking', 'false');
    await expect(figure).toHaveText(fmtDollars(expected.savedM));
    await expect(page.getByTestId('hero-range-words')).toContainText('(6 h)');
    await expect(page.getByTestId('hero-caption')).toContainText('minute-exact');
    await expect(page.getByTestId('hero-rate')).toContainText(`≈ ${fmtDollars(expected.ratePerDayM ?? 0)} a day at this rate`);
    // The bar's legends foot to the saved figure (W3-RECEIPT-1): paid prints as would have paid − saved as printed.
    const footed = footMoney({ whpM: expected.whpM, paidM: expected.paidM, savedM: expected.savedM });
    await expect(hero(page)).toContainText(`You would have paid ${fmtDollars(footed.whpM)}`);
    await expect(hero(page)).toContainText(`You paid ${fmtDollars(footed.paidM)}`);
    await expect(page.getByTestId('receipt-net')).toHaveCount(0); // a range is never netted or annualized
    expect(errors()).toEqual([]);
  });

  test('an exact window three days back sums whole hours and counts the minutes metered', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const ws = await openWithHistory(page);
    const day = localDayKey(ws.at - 3 * DAY_MS, TZ);
    const fromMs = localDayStartMs(day, TZ) + 10 * HOUR_MS;
    const toMs = fromMs + 4 * HOUR_MS;
    await openPicker(page);
    await picker(page).getByLabel('From').fill(formatLocalDateTimeInput(fromMs, TZ));
    await picker(page).getByLabel('To').fill(formatLocalDateTimeInput(toMs, TZ));
    await expect(picker(page)).toContainText(`Times are in ${TZ}`);
    await picker(page).getByRole('button', { name: 'Apply' }).click();
    const stamp = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
    await expect.poll(() => new URL(page.url()).searchParams.get('range')).toBe(`${stamp(fromMs)}..${stamp(toMs)}`);

    const w = await shownWindow(page);
    expect(w).toEqual({ fromMs, toMs, granularity: 'hour' });
    const expected = await expectedFigures(page, w);
    expect(expected.rows).toBeGreaterThan(0);
    expect(await meterValue(page)).toBe(expected.savedM);
    await expect(page.getByTestId('hero-range-words')).toContainText('(4 h)');
    // On the hour at both ends: whole hours, nothing widened.
    await expect(page.getByTestId('hero-caption')).toContainText(`whole hours · ${expected.minutesMetered} of 240 minutes metered`);
    await expect(page.getByTestId('hero-caption')).not.toContainText('widened');

    // Show the math explains the read, in whole words.
    await page.locator('.mr-hero-actions').getByRole('button', { name: 'Show the math' }).click();
    const drawer = page.getByTestId('math-drawer');
    await expect(drawer).toContainText('Custom range');
    await expect(drawer).toContainText('Σ saved over every row in the window');
    expect(expected.docsRead).toBe(1);
    await expect(page.getByTestId('math-range-plan')).toContainText('hour rows · 1 document read, none missing');
    await expect(drawer).toContainText('Hour rows widen the window to whole hours and stop at the last whole hour');
    await expect(drawer).toContainText('A custom range is a closed window');
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });

    // Custom, pressed again, re-opens the picker pre-filled with the exact window.
    await openPicker(page);
    await expect(picker(page).getByLabel('From')).toHaveValue(formatLocalDateTimeInput(fromMs, TZ));
    await expect(picker(page).getByLabel('To')).toHaveValue(formatLocalDateTimeInput(toMs, TZ));
    await picker(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(picker(page)).toHaveCount(0);
    await expect(customToggle(page)).toHaveAttribute('aria-checked', 'true');
    expect(errors()).toEqual([]);
  });

  test('an exact window off the hour is widened, and the hero says so before and after Apply', async ({ page }) => {
    const ws = await openWithHistory(page);
    const day = localDayKey(ws.at - 3 * DAY_MS, TZ);
    const fromMs = localDayStartMs(day, TZ) + 10 * HOUR_MS + 30 * MINUTE_MS;
    const toMs = fromMs + 2 * HOUR_MS + 40 * MINUTE_MS; // 10:30 → 13:10 local: whole hours 10:00 → 14:00
    await openPicker(page);
    await picker(page).getByLabel('From').fill(formatLocalDateTimeInput(fromMs, TZ));
    await picker(page).getByLabel('To').fill(formatLocalDateTimeInput(toMs, TZ));
    await expect(page.getByTestId('range-preview')).toHaveText(/^Summed in whole hours as .* \(4 h\)\.$/);
    await picker(page).getByRole('button', { name: 'Apply' }).click();
    const w = await shownWindow(page);
    expect(w).toEqual({ fromMs: hourFloor(fromMs), toMs: hourFloor(toMs) + HOUR_MS, granularity: 'hour' });
    const expected = await expectedFigures(page, w);
    expect(await meterValue(page)).toBe(expected.savedM);
    await expect(page.getByTestId('hero-range-words')).toContainText('(4 h)');
    await expect(page.getByTestId('hero-caption')).toContainText(`widened to whole hours · ${expected.minutesMetered} of 240 minutes metered`);
  });

  test('?range= survives a reload and follows the tabs; a period press clears it', async ({ page }) => {
    const ws = await openWithHistory(page, '/?range=7d');
    let w = await shownWindow(page);
    expect(w.granularity).toBe('hour');
    // Exactly seven days of whole hours, ending at the last whole hour (the hour in progress has no row yet).
    expect(w.toMs - w.fromMs).toBe(7 * DAY_MS);
    expect(w.fromMs % HOUR_MS).toBe(0);
    expect(w.toMs).toBe(hourFloor(await page.evaluate(() => Date.now())));
    await expect(customToggle(page)).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('hero-range-words')).toContainText('(7 days)');
    await expect(page.getByTestId('hero-caption')).toContainText('whole hours');
    // "through the last whole hour" says the hour in progress was cut off — unless the read landed on the hour
    // itself (minute :00), when nothing was: then the window ends within the last few minutes.
    const cut = ((await page.getByTestId('hero-caption').textContent()) ?? '').includes('through the last whole hour');
    if (!cut) expect((await page.evaluate(() => Date.now())) - w.toMs).toBeLessThan(3 * MINUTE_MS);
    await expect(page.getByTestId('hero-caption')).not.toContainText('widened');
    await expect(page.getByRole('navigation').first().getByRole('link', { name: /ledger/i })).toHaveAttribute('href', /range=7d/);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await hero(page).waitFor();
    expect(new URL(page.url()).searchParams.get('range')).toBe('7d');
    w = await shownWindow(page);
    expect(await meterValue(page)).toBe((await expectedFigures(page, w)).savedM);

    await page.getByRole('radiogroup', { name: 'Headline period' }).getByRole('radio', { name: 'MTD' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('range')).toBeNull();
    await expect(page.getByTestId('hero-caption')).toHaveText('month to date');
    await expect(hero(page)).not.toHaveAttribute('data-range-status', /.+/);
    expect(await meterValue(page)).toBeGreaterThanOrEqual(ws.headline.mtdM);
    await expect(customToggle(page)).toHaveAttribute('aria-checked', 'false');
  });

  test('sample data (P2-W05): Custom works on the tour, summing the sample history under the band; nothing is read from KV', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/first-run');
    await resetMock(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Tour with sample data' }).click();
    await expect(hero(page)).toBeVisible({ timeout: 15_000 });
    const band = page.locator('[data-callout="sample-band"]');
    await expect(band).toBeVisible();
    await expect(customToggle(page)).toBeEnabled();
    await expect(page.getByTestId('range-hint')).toHaveCount(0);
    const calls = (): Promise<Record<string, number>> => page.evaluate(async () => ((await (await fetch('/mock-api/_calls')).json()) as { byRoute: Record<string, number> }).byRoute);
    const rollupReads = async (): Promise<number> => Object.entries(await calls()).reduce((n, [route, count]) => (/kvstore\/roll/.test(route) ? n + count : n), 0);
    const before = await rollupReads();

    await openPicker(page);
    await picker(page).getByRole('radio', { name: '7 days' }).click();
    await picker(page).getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('range')).toBe('7d');
    await expect(customToggle(page)).toHaveAttribute('aria-checked', 'true');
    const w = await shownWindow(page);
    expect(w.granularity).toBe('hour');
    expect(w.toMs - w.fromMs).toBe(7 * DAY_MS);
    await expect(page.getByTestId('hero-range-words')).toContainText('(7 days)');
    await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'custom');
    // The fixture's last seven trend days (today partial) bracket a week of whole hours ending now.
    const { readFileSync } = await import('node:fs');
    const trend = (JSON.parse(readFileSync(new URL('../../demo/sample/tour.json', import.meta.url), 'utf8')) as { snapshot: Snapshot }).snapshot.trend;
    const savedOf = (points: typeof trend): number => points.reduce((n, p) => n + p.savedM, 0);
    const saved = await meterValue(page);
    expect(saved).toBeGreaterThan(savedOf(trend.slice(-7, -1)));
    expect(saved).toBeLessThan(savedOf(trend.slice(-8)));
    await expect(page.locator('[data-testid="receipt-hero"] [data-callout="saved"]')).toHaveText(fmtDollars(saved));
    await expect(band).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-mr-tour', 'running');
    // Synthesized in memory from the snapshot on screen: no KV read, no write, nothing touched in the workspace.
    expect(await rollupReads()).toBe(before);
    expect(await kvGet(page, 'prices')).toBeNull();

    if (['chromium', 'mobile'].includes(test.info().project.name)) {
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await blur(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        // The viewport, so the sample band shows above the range figure.
        await page.screenshot({ path: `tests/report/screens/wave1-o-tour-range-${theme}-${page.viewportSize()?.width ?? 0}.png` });
      }
      await setTheme(page, 'light');
    }
    expect(errors()).toEqual([]);
  });

  test('the picker keeps the shell’s shortcuts quiet, and Escape hands focus back to the toggle', async ({ page }) => {
    await openWithHistory(page);
    await customToggle(page).focus();
    await page.keyboard.press('Enter');
    await picker(page).waitFor();
    // The picker moves focus to its first quick pick once it has positioned itself; wait for that before
    // moving on, or the autofocus could land after the field was focused and the keystroke would hit a button.
    await expect(picker(page).getByRole('radio', { name: '1 h' })).toBeFocused();
    const from = picker(page).getByLabel('From');
    await from.focus();
    await expect(from).toBeFocused();
    await page.keyboard.type('p');
    await page.waitForTimeout(150);
    expect(new URL(page.url()).searchParams.get('present')).toBeNull(); // P did not enter presenter mode
    await page.keyboard.press('Escape');
    await expect(picker(page)).toHaveCount(0);
    await expect(customToggle(page)).toBeFocused();
    expect(new URL(page.url()).searchParams.get('range')).toBeNull();
    await expect(customToggle(page)).toHaveAttribute('aria-checked', 'false');
  });

  test('Copy receipt copies the range receipt', async ({ page, context, browserName }) => {
    await allowClipboard(context, browserName);
    await openWithHistory(page, '/?range=24h');
    const w = await shownWindow(page);
    const expected = await expectedFigures(page, w);
    await page.getByRole('button', { name: 'Copy receipt' }).click();
    await expect(page.getByText('Receipt copied.')).toBeVisible();
    const text = await readClipboard(page);
    expect(text).toContain('Meter Reader — receipt');
    expect(text).toContain(`Would have paid ${fmtDollars(expected.whpM)}`);
    expect(text).toContain(`≈ ${fmtDollars(expected.ratePerDayM ?? 0)} a day at this rate`);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(48);
  });

  test('the Ledger’s change timeline keeps its own key: ?range= never moves it, and it never changes the hero', async ({ page }) => {
    await openWithHistory(page, '/ledger?range=6h');
    const timeline = page.locator('[data-testid="change-timeline"]');
    await expect(timeline.getByRole('radio', { name: '7 d' }).or(timeline.getByRole('button', { name: '7 d' })).first()).toBeVisible();
    await expect(timeline.locator('.mr-ct-caption')).not.toContainText('last 7 days');
    await timeline.getByRole('radio', { name: '7 d' }).or(timeline.getByRole('button', { name: '7 d' })).first().click();
    await expect.poll(() => new URL(page.url()).searchParams.get('timeline')).toBe('7d');
    expect(new URL(page.url()).searchParams.get('range')).toBe('6h');
    // Back on the Receipt the range is the 6 h one, and the timeline's choice stayed on the Ledger.
    await page.getByRole('navigation').first().getByRole('link', { name: /receipt/i }).click();
    await hero(page).waitFor();
    await expect(hero(page)).toHaveAttribute('data-range', '6h');
    expect(new URL(page.url()).searchParams.get('timeline')).toBeNull();
    const w = await shownWindow(page);
    expect(w.granularity).toBe('minute');
    expect(w.toMs - w.fromMs).toBe(6 * HOUR_MS);
  });

  test('while the rows are read the card keeps its finished shape: no layout shift when the figures land', async ({ page }) => {
    // Hold the rollup reads (in the page: the emulator is a service worker, which page.route cannot see) so the
    // loading state can be measured, then release them.
    await page.addInitScript(() => {
      const real = window.fetch.bind(window);
      const w = window as unknown as { __mrHoldRollups?: boolean };
      w.__mrHoldRollups = true;
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/kvstore\/roll/.test(url)) while (w.__mrHoldRollups) await new Promise((r) => setTimeout(r, 50));
        return real(input, init);
      };
    });
    const release = () => page.evaluate(() => ((window as unknown as { __mrHoldRollups?: boolean }).__mrHoldRollups = false));
    await openWithHistory(page, '/?range=6h');
    await page.getByTestId('range-loading').waitFor();
    await expect(page.getByTestId('hero-range-words')).toContainText('(6 h)'); // the words are known before the read
    const loading = await hero(page).boundingBox();
    // The ghost blocks are visible in both themes (a skeleton nobody can see is no skeleton).
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      const visible = await page.evaluate(() => {
        const skel = document.querySelector<HTMLElement>('[data-testid="range-loading"]')!;
        const card = skel.closest('.mr-hero') as HTMLElement;
        const rgb = (s: string) => s.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
        const a = rgb(getComputedStyle(skel).backgroundColor);
        const b = rgb(getComputedStyle(card.querySelector('.mr-hero-number')!).backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.body).backgroundColor : getComputedStyle(card).backgroundColor);
        return { skel: a, card: b, opacity: Number(getComputedStyle(skel).opacity), delta: Math.max(...a.map((v, i) => Math.abs(v - b[i]))) };
      });
      expect(visible.delta * visible.opacity, `${theme}: skeleton against the card ${JSON.stringify(visible)}`).toBeGreaterThanOrEqual(6);
    }
    await setTheme(page, 'light');
    await release();
    const w = await shownWindow(page);
    const applied = await hero(page).boundingBox();
    if (!loading || !applied) throw new Error('no hero box');
    expect(Math.abs(applied.height - loading.height), `hero ${loading.height} → ${applied.height}`).toBeLessThanOrEqual(2);
    expect(await meterValue(page)).toBe((await expectedFigures(page, w)).savedM);
  });

  test('reduced motion: the range figure is static whole dollars', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openWithHistory(page, '/?range=1h');
    const w = await shownWindow(page);
    expect(w.granularity).toBe('minute');
    const expected = await expectedFigures(page, w);
    const figure = page.locator('[data-testid="receipt-hero"] [data-callout="saved"]');
    await expect(figure).toHaveAttribute('data-ticking', 'false');
    await expect(figure).toHaveText(fmtDollars(expected.savedM));
    await expect(page.locator('.mr-meter-cents')).toHaveCount(0);
  });

  test('both themes, desktop and phone: the picker open and a range applied, without horizontal overflow', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openWithHistory(page, '/?range=6h');
    await shownWindow(page);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      for (const size of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        await blur(page);
        await page.waitForTimeout(250);
        let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `overflow with a range applied at ${size.width}`).toBeLessThanOrEqual(0);
        if (shoots()) await page.screenshot({ path: screenPath('range-applied', theme, page), fullPage: false });
        await openPicker(page);
        await page.waitForTimeout(250);
        overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `overflow with the picker open at ${size.width}`).toBeLessThanOrEqual(0);
        const box = await picker(page).boundingBox();
        if (!box) throw new Error('no picker box');
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(size.width + 0.5);
        const shot = pickerShot(theme, page);
        if (shot) await page.screenshot({ path: shot, fullPage: false });
        await page.keyboard.press('Escape');
        await expect(picker(page)).toHaveCount(0);
      }
    }
    expect(errors()).toEqual([]);
  });
  test('the read budget: 30 days and 24 h each read at most four history documents, and sum what every per-family document holds', async ({ page }) => {
    await countRollupReads(page);
    const ws = await openWithHistory(page, '/?range=30d');
    let w = await shownWindow(page);
    expect(w.granularity).toBe('hour');
    let reads = await rollupReads(page);
    // "This week so far" reads its own week (and the same days a week before) once the hero's read is done, when it
    // is in view (review W2: one data path whatever the hero shows), so the range's reads are the first ones: as many
    // as its own plan (the reader's hybrid plan from the sweep's cursor) holds.
    const cursor30 = Date.parse((JSON.parse((await kvGet(page, 'meta')) as string) as Meta).meteredThrough ?? '');
    const at30 = await page.evaluate(() => Date.now());
    const plan30 = planRangeReads(resolveRange({ kind: 'relative', hours: 30 * 24 }, at30, ws.since).fromMs, resolveRange({ kind: 'relative', hours: 30 * 24 }, at30, ws.since).toMs, at30, cursor30);
    reads = reads.slice(0, plan30.keys.length);
    expect(new Set(reads)).toEqual(new Set(plan30.keys));
    // Hour rows at the two ragged edges, day rows between — not the 31 hour documents the whole window spans.
    expect(new Set(reads).size, reads.join(' ')).toBeLessThanOrEqual(4);
    expect(reads.length, `${reads.join(' ')} (StrictMode must not double the reads)`).toBe(new Set(reads).size);
    expect(reads.some((k) => k.startsWith('roll/day/'))).toBe(true);
    let expected = await expectedFigures(page, w); // summed in Node from every hour document the window spans
    expect(keysFor(w).length).toBeGreaterThanOrEqual(30); // 31, or 30 when the window starts at midnight UTC
    expect(await meterValue(page)).toBe(expected.savedM);
    await expect(page.getByTestId('hero-caption')).toContainText(`whole hours · ${formatInt(expected.minutesMetered ?? 0)} of ${formatInt(expected.expectedMinutes)} minutes metered`);
    await expect(hero(page)).toContainText(`You would have paid ${fmtDollars(expected.whpM)}`);
    await page.locator('.mr-hero-actions').getByRole('button', { name: 'Show the math' }).click();
    // Hour rows at the ragged edges and day rows between — or, when the window starts at midnight UTC, day rows alone.
    const families = [...new Set(reads.map((k) => k.split('/')[1]))];
    const planWords = families.length > 1 ? 'hour rows at the edges, day rows between' : `${families[0]} rows`;
    expect(families).toContain('day');
    await expect(page.getByTestId('math-range-plan')).toContainText(`Read plan: ${planWords} · ${new Set(reads).size} documents read, none missing`);
    await expect(page.getByTestId('math-drawer')).toContainText('Whole UTC days are read from day rows, the exact sums of their hour rows; a day with a row counts as 1,440 minutes metered.');
    if (shoots()) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 640 ? 900 : 844 });
        for (const theme of ['light', 'dark'] as const) {
          await setTheme(page, theme);
          await page.getByTestId('math-range-plan').scrollIntoViewIfNeeded();
          const shot = wave1Shot('math-plan', theme, page);
          if (shot) await page.screenshot({ path: shot });
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await setTheme(page, 'light');
    }
    await page.keyboard.press('Escape');
    await page.getByTestId('math-drawer').waitFor({ state: 'detached' });

    // The picker says what a pick will cost before Apply: the reader's own hybrid plan (the sweep's cursor from meta).
    await openPicker(page);
    await picker(page).getByRole('radio', { name: '24 h' }).click();
    const cursor = Date.parse((JSON.parse((await kvGet(page, 'meta')) as string) as Meta).meteredThrough ?? '');
    const plannedAt = await page.evaluate(() => Date.now());
    const resolved = resolveRange({ kind: 'relative', hours: 24 }, plannedAt, ws.since);
    const planned = planRangeReads(resolved.fromMs, resolved.toMs, plannedAt, cursor).keys.length;
    expect(planned).toBeLessThanOrEqual(4);
    await expect(page.getByTestId('range-reads')).toHaveText(`Reads ${planned} history documents.`);
    await resetRollupReads(page);
    await picker(page).getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('range')).toBe('24h');
    await expect(hero(page)).toHaveAttribute('data-range', '24h'); // the hero has left the 30-day figures
    w = await shownWindow(page);
    expect(w.granularity).toBe('minute');
    reads = await rollupReads(page);
    // No more than the picker said (documents the 30-day read already holds are served from the tab's cache).
    expect(new Set(reads).size, reads.join(' ')).toBeLessThanOrEqual(planned);
    expected = await expectedFigures(page, w); // every minute document the window spans
    expect(keysFor(w).length).toBeGreaterThanOrEqual(24); // 25, or 24 when the window starts on the hour
    expect(await meterValue(page)).toBe(expected.savedM);
    await expect(page.getByTestId('hero-rate')).toContainText(`≈ ${fmtDollars(expected.ratePerDayM ?? 0)} a day at this rate`);
  });

  test('rate limited: a 429 keeps the figures on screen; with none yet the hero says when it reads again, with no Retry into the limit', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openWithHistory(page, '/?range=6h');
    const w = await shownWindow(page);
    const before = await meterValue(page);
    expect(before).toBe((await expectedFigures(page, w)).savedM);

    // Every rollup read answers 429 from now on. A new sweep lands: the refresh is refused, the figures stay.
    await mockControl(page, { action: 'fault', method: 'GET', path: 'kvstore/roll', status: 429, times: -1 });
    const snapshot = JSON.parse((await kvGet(page, 'snapshot')) as string) as Snapshot;
    const bumped = new Date(Date.parse(snapshot.sweepAt) + 1000).toISOString();
    // The next live poll (≤ 10 s) sees it: the tab re-reads the snapshot once meta moved (P1-D05), as a sweep moves it.
    const meta = JSON.parse((await kvGet(page, 'meta')) as string) as Record<string, unknown>;
    await putKv(page, { snapshot: { ...snapshot, sweepAt: bumped }, meta: { ...meta, updatedAt: bumped } });
    await expect(hero(page)).toHaveAttribute('data-range-retry-at', /\d+/, { timeout: 20_000 });
    await expect(hero(page)).toHaveAttribute('data-range-status', 'ready');
    expect(await meterValue(page)).toBe(before);
    await expect(page.getByTestId('range-error')).toHaveCount(0);
    // The caption says the figures are held, and when they update.
    const heldAt = Number(await hero(page).getAttribute('data-range-retry-at'));
    await expect(page.getByTestId('range-held')).toHaveText(`· rate limited by Cribl, updates at ${formatLocalTime(heldAt, TZ)}`);
    await shootBothSizes(page, 'rate-limited-held');

    // A different range with nothing on screen yet: the notice says when, and offers no Retry.
    await openPicker(page);
    await picker(page).getByRole('radio', { name: '7 days' }).click();
    await picker(page).getByRole('button', { name: 'Apply' }).click();
    const notice = page.getByTestId('range-rate-limited');
    await expect(notice).toBeVisible({ timeout: 20_000 });
    const retryAt = Number(await hero(page).getAttribute('data-range-retry-at'));
    await expect(notice).toHaveText(`Cribl is rate limiting Meter Reader. This range reads again at ${formatLocalTime(retryAt, TZ)}.`);
    await expect(notice.getByRole('button')).toHaveCount(0);
    await expect(hero(page).locator('[data-callout="saved"]')).toHaveCount(0);
    await shootBothSizes(page, 'rate-limited');
    await mockControl(page, { action: 'clearFaults' });
    expect(errors().filter((e) => !/429|Too many requests/i.test(e))).toEqual([]);
  });

  test('the picker opens in the empty half beside the figure, never over it; on a phone it spans the card under the toggle', async ({ page }) => {
    await openWithHistory(page, '/?range=30d');
    await shownWindow(page);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      for (const size of [
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
        { width: 1280, height: 720 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        await blur(page);
        await openPicker(page);
        await page.waitForTimeout(300);
        const pop = await picker(page).boundingBox();
        const figure = await hero(page).locator('[data-callout="saved"]').boundingBox();
        const group = await page.getByRole('radiogroup', { name: 'Headline period' }).boundingBox();
        const card = await hero(page).boundingBox();
        if (!pop || !figure || !group || !card) throw new Error('no boxes');
        const at = `${theme} ${size.width}: picker ${JSON.stringify(pop)} figure ${JSON.stringify(figure)} toggle ${JSON.stringify(group)}`;
        expect(pop.y, at).toBeGreaterThanOrEqual(group.y + group.height - 1); // under the toggle
        expect(pop.x, at).toBeGreaterThanOrEqual(0);
        expect(pop.x + pop.width, at).toBeLessThanOrEqual(size.width + 0.5);
        if (size.width > 640) {
          expect(intersects(pop, figure), at).toBe(false);
          // It drops from the toggle's right end (P1-H09), into the card's empty half.
          expect(Math.abs(pop.x - (group.x + group.width)), at).toBeLessThanOrEqual(1.5);
          expect(pop.x + pop.width, at).toBeLessThanOrEqual(card.x + card.width + 0.5);
        } else {
          // A phone: the card's full width, under the toggle.
          expect(Math.abs(pop.x - card.x), at).toBeLessThanOrEqual(1);
          expect(Math.abs(pop.x + pop.width - (card.x + card.width)), at).toBeLessThanOrEqual(1);
        }
        const shot = wave1Shot('picker', theme, page);
        if (shot) await page.screenshot({ path: shot, fullPage: false });
        await page.keyboard.press('Escape');
        await expect(picker(page)).toHaveCount(0);
      }
    }
  });

  test('a resize while the picker is open places it again: to a phone it spans the card, and back it drops from the toggle into the free space', async ({ page }) => {
    await openWithHistory(page, '/?range=6h');
    await shownWindow(page);
    // A desktop window narrowed to a phone's width; on the phone project, a rotation from landscape to portrait.
    const wide = test.info().project.use.isMobile ? { width: 844, height: 390 } : { width: 1440, height: 900 };
    await page.setViewportSize(wide);
    await openPicker(page);
    const boxes = async () => ({
      pop: await picker(page).boundingBox(),
      card: await hero(page).boundingBox(),
      toggle: await page.getByRole('radiogroup', { name: 'Headline period' }).boundingBox(),
      figure: await hero(page).locator('[data-callout="saved"]').boundingBox(),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(picker(page)).toHaveAttribute('data-layout', 'card');
    await expect
      .poll(async () => {
        const { pop, card } = await boxes();
        return pop && card ? Math.round(Math.abs(pop.x - card.x) + Math.abs(pop.x + pop.width - (card.x + card.width))) : -1;
      })
      .toBeLessThanOrEqual(2);
    await page.setViewportSize(wide);
    await expect(picker(page)).toHaveAttribute('data-layout', 'toggle-end');
    await expect
      .poll(async () => {
        const { pop, toggle, figure } = await boxes();
        if (!pop || !toggle || !figure) return 'no boxes';
        if (pop.x < 0 || pop.x + pop.width > wide.width + 0.5) return `outside the viewport ${JSON.stringify(pop)}`;
        if (pop.y < toggle.y + toggle.height - 1) return `over the toggle ${JSON.stringify(pop)}`;
        if (intersects(pop, figure)) return `over the figure ${JSON.stringify(pop)} ${JSON.stringify(figure)}`;
        return 'ok';
      })
      .toBe('ok');
    await page.keyboard.press('Escape');
    await expect(picker(page)).toHaveCount(0);
  });

  test('at 320 px (a small phone, or 1280 px at 400 % zoom) the period toggle wraps inside the card: no horizontal scroll, every item whole', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openWithHistory(page, '/?range=6h');
    await shownWindow(page);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.setViewportSize({ width: 320, height: 640 });
      await blur(page);
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${theme}: horizontal overflow at 320`).toBeLessThanOrEqual(0);
      const card = await hero(page).boundingBox();
      if (!card) throw new Error('no hero box');
      const items = page.getByRole('radiogroup', { name: 'Headline period' }).getByRole('radio');
      await expect(items).toHaveCount(5);
      for (const item of await items.all()) {
        const b = await item.boundingBox();
        if (!b) throw new Error('no item box');
        const name = await item.textContent();
        // Inside the card's padding (16 px on a phone), not merely inside its edge.
        expect(b.x, `${theme}: ${name}`).toBeGreaterThanOrEqual(card.x + 15);
        expect(b.x + b.width, `${theme}: ${name} ${JSON.stringify(b)} card ${JSON.stringify(card)}`).toBeLessThanOrEqual(card.x + card.width - 15);
        expect(b.height, `${theme}: ${name}`).toBeGreaterThanOrEqual(24); // still a whole button, still a target
      }
      // Two rows: MTD · Today · 30 days, then Annualized · Custom.
      const tops = await Promise.all((await items.all()).map(async (item) => Math.round((await item.boundingBox())?.y ?? 0)));
      expect(new Set(tops.slice(0, 3)).size, `${theme}: ${tops}`).toBe(1);
      expect(new Set(tops.slice(3)).size, `${theme}: ${tops}`).toBe(1);
      expect(tops[3] - tops[0], `${theme}: ${tops}`).toBeGreaterThanOrEqual(22);
      await expect(customToggle(page)).toHaveAttribute('aria-checked', 'true');
      const shot = wave1Shot('toggle', theme, page);
      if (shot) await page.screenshot({ path: shot, fullPage: false });
      await openPicker(page);
      await page.waitForTimeout(300);
      const pop = await picker(page).boundingBox();
      const group = await page.getByRole('radiogroup', { name: 'Headline period' }).boundingBox();
      if (!pop || !group) throw new Error('no picker box');
      expect(pop.x).toBeGreaterThanOrEqual(0);
      expect(pop.x + pop.width).toBeLessThanOrEqual(320.5);
      // Under both rows of the toggle, spanning the card.
      expect(pop.y, `${theme}: picker ${JSON.stringify(pop)} toggle ${JSON.stringify(group)}`).toBeGreaterThanOrEqual(group.y + group.height - 1);
      expect(Math.abs(pop.x - card.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(pop.x + pop.width - (card.x + card.width))).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const pickerShot320 = wave1Shot('toggle-picker', theme, page);
      if (pickerShot320) await page.screenshot({ path: pickerShot320, fullPage: false });
      await page.keyboard.press('Escape');
      await expect(picker(page)).toHaveCount(0);
    }
    expect(errors()).toEqual([]);
  });
});
