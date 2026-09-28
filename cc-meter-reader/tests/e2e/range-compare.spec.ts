// tests/e2e/range-compare.spec.ts — "Compare with…" on the Receipt hero (P2-W13) on the in-browser Cribl emulator,
// with the same seeded rollup history as range.spec.ts (testdata/rollups.ts) under a backend-runtime workspace. The
// hero publishes both windows it summed (data-range-from/to for the range, data-compare-from/to for the baseline),
// and every figure is checked against the SAME documents read back from the emulator's KV and summed in Node with
// core/range, then compared with core/range compareRanges.
//
// Screenshots (chromium only, both themes, 1440 and 390): tests/report/screens/wave2-r-<id>-<theme>-<width>.png.

import { expect, test, type Page } from '@playwright/test';
import { fmtDollars, fmtPct, footMoney } from '../../core/format.ts';
import { computeHeadline } from '../../core/pricing.ts';
import { compareRanges, sumRange, type RangeDoc, type RangeFigures, type RangeGranularity } from '../../core/range.ts';
import { comparisonLines } from '../../core/receipt.ts';
import { dayDocKey, hourDocKey, minuteDocKey } from '../../core/rollups.ts';
import { defaultSettings } from '../../core/settings.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, hourFloor, localDayKey, localDayStartMs, utcDayFloor } from '../../core/time.ts';
import type { Commit, Meta, RollHourDoc, Settings, Snapshot, TotalsDoc } from '../../core/types.ts';
import { RIG_PRICES, allowClipboard, gotoApp, kvGet, mockControl, readClipboard, resetMock, setTheme, trackConsoleErrors, waitForHydration } from './helpers/index.ts';

const TZ = 'America/Chicago';

async function putKv(page: Page, docs: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (entries) => {
    for (const [key, value] of entries) {
      const r = await fetch(`/mock-api/v1/kvstore/${key}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(value) });
      if (r.status >= 300) throw new Error(`PUT ${key} → ${r.status}`);
    }
  }, Object.entries(docs));
}

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
  commit: Commit;
}

/**
 * A fresh emulated org with 40 days of seeded rollup history under a backend-runtime workspace, and one commit in
 * the change timeline deployed ~30 hours ago (20 min 30 s past an hour, so its hour is left out of both sides).
 */
async function openWithHistory(page: Page, path = '/'): Promise<Workspace> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  const at = await page.evaluate(() => Date.now());
  const since = localDayStartMs(localDayKey(at - 40 * DAY_MS, TZ), TZ) + (21 * 60 + 41) * MINUTE_MS;
  const seeded = await mockControl(page, { action: 'seedRollups', at, since, tz: TZ, prices: RIG_PRICES });
  expect(seeded.keys as number).toBeGreaterThan(60);
  const totals = JSON.parse((await kvGet(page, 'totals')) ?? '{}') as TotalsDoc;
  const headline = computeHeadline(totals, at, TZ, since);
  const iso = (ms: number) => new Date(ms).toISOString();
  const deployedAt = hourFloor(at - 30 * HOUR_MS) + 20 * MINUTE_MS + 30_000;
  const commit: Commit = {
    hash: '805b12c0d9e1f2a3b4c5d6e7f8091a2b3c4d5e6f',
    message: 'demo: break the trim on mrd_pay_sample',
    author: 's.koelpin',
    committedAt: iso(deployedAt - 90_000),
    deployedAt: iso(deployedAt),
    groupId: 'default',
    files: ['pipelines/mrd_pay_sample/conf.yml'],
    source: 'demo',
  };
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
    timeline: [commit],
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
    meteredThrough: iso(Math.floor(at / MINUTE_MS) * MINUTE_MS),
  };
  await putKv(page, { settings, prices: RIG_PRICES, meta, snapshot });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await page.getByTestId('receipt-hero').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { at, since, commit };
}

const hero = (page: Page) => page.getByTestId('receipt-hero');
const customToggle = (page: Page) => page.getByRole('radiogroup', { name: 'Headline period' }).getByRole('radio', { name: 'Custom' });
const picker = (page: Page) => page.getByRole('dialog', { name: 'Custom range' });

type Window = { fromMs: number; toMs: number; granularity: RangeGranularity };

/** Waits for the comparison to settle and returns both windows the hero says it summed. */
async function shownWindows(page: Page): Promise<{ current: Window; baseline: Window }> {
  await expect(hero(page)).toHaveAttribute('data-compare-status', 'ready', { timeout: 20_000 });
  const a = async (name: string) => {
    const v = await hero(page).getAttribute(name);
    if (!v) throw new Error(`the hero did not publish ${name}`);
    return v;
  };
  return {
    current: { fromMs: Date.parse(await a('data-range-from')), toMs: Date.parse(await a('data-range-to')), granularity: (await a('data-range-granularity')) as RangeGranularity },
    baseline: { fromMs: Date.parse(await a('data-compare-from')), toMs: Date.parse(await a('data-compare-to')), granularity: (await a('data-compare-granularity')) as RangeGranularity },
  };
}

function keysFor(w: Window): string[] {
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

/** The same documents the app read for a window, summed in Node with core/range. */
async function expectedFigures(page: Page, w: Window): Promise<RangeFigures> {
  const keys = keysFor(w);
  const raw = await kvGetMany(page, keys);
  const docs: Record<string, RangeDoc | null> = {};
  for (const key of keys) docs[key] = raw[key] === null ? null : (JSON.parse(raw[key] as string) as RangeDoc);
  return sumRange(docs, w.granularity, w.fromMs, w.toMs);
}

/** How many receipt lines moved by at least a dollar (rounded) between the two windows. */
function comparisonLinesMoved(a: RangeFigures, b: RangeFigures): number {
  return comparisonLines(compareRanges(a, b), undefined, 99).filter((l) => Math.abs(l.deltaM) >= 50_000).length;
}

const signed = (mc: number) => (Math.abs(mc) < 50_000 ? '$0' : mc > 0 ? `+${fmtDollars(mc)}` : fmtDollars(mc));
const signedPct = (r: number) => (fmtPct(r) === '0%' ? '0%' : r > 0 ? `+${fmtPct(r)}` : fmtPct(r));

function shoots(): boolean {
  return test.info().project.name === 'chromium';
}

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.mouse.move(0, 0);
}

/** Shoots `target` in both themes at 1440 and 390 (chromium only), then puts the viewport and theme back. */
async function shootBothSizes(page: Page, id: string, target: () => ReturnType<Page['locator']> = () => hero(page), before?: () => Promise<void>): Promise<void> {
  if (!shoots()) return;
  const size = page.viewportSize();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width > 640 ? 900 : 844 });
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await blur(page);
      if (before) await before();
      await target().screenshot({ path: `tests/report/screens/wave2-r-${id}-${theme}-${width}.png` });
    }
  }
  if (size) await page.setViewportSize(size);
  await setTheme(page, 'light');
}

/** Shoots the open picker in both themes at 1440 and 390 (chromium only; it follows the resize), then puts both back. */
async function shootPicker(page: Page, id: string): Promise<void> {
  if (!shoots()) return;
  const size = page.viewportSize();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width > 640 ? 900 : 844 });
    await expect(picker(page)).toHaveAttribute('data-layout', width > 640 ? 'toggle-end' : 'card');
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.mouse.move(0, 0);
      await picker(page).screenshot({ path: `tests/report/screens/wave2-r-${id}-${theme}-${width}.png` });
    }
  }
  if (size) await page.setViewportSize(size);
  await setTheme(page, 'light');
  await expect(picker(page)).toHaveAttribute('data-layout', 'toggle-end');
}

/**
 * Rewrites the seeded hour rows from `fromMs` on: the flows of the pipeline that saves the most lose `share` of
 * their savings to the paid side (would-have-paid unchanged) — a trim that stopped trimming.
 */
async function degradeAfter(page: Page, fromMs: number, share: number): Promise<void> {
  const keys: string[] = [];
  for (let d = utcDayFloor(fromMs); d <= utcDayFloor(Date.now()); d += DAY_MS) keys.push(hourDocKey(d));
  const raw = await kvGetMany(page, keys);
  const docs = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null).map(([k, v]) => [k, JSON.parse(v as string) as RollHourDoc]));
  const byPipeline = new Map<string, number>();
  for (const doc of Object.values(docs)) for (const [key, rows] of Object.entries(doc.flows)) for (const r of rows) byPipeline.set(key.split('|')[3], (byPipeline.get(key.split('|')[3]) ?? 0) + r.savedM);
  const top = [...byPipeline.entries()].sort((x, y) => y[1] - x[1])[0][0];
  for (const doc of Object.values(docs)) {
    for (const [key, rows] of Object.entries(doc.flows)) {
      if (key.split('|')[3] !== top) continue;
      for (const r of rows) {
        if (Date.parse(r.t) < fromMs) continue;
        const moved = Math.round(r.savedM * share);
        r.savedM -= moved;
        r.paidM += moved;
      }
    }
  }
  await putKv(page, docs);
}

/** Picks an option of the picker's "Compare with" select. */
async function compareWith(page: Page, option: string | RegExp): Promise<void> {
  await picker(page).getByRole('button', { name: /Compare with/ }).click();
  await page.getByRole('option', { name: option }).click();
}

test.describe('Compare with… on the Receipt hero', () => {
  test('?range=7d&vs=prev renders the two-figure hero: both sums from their own rows, the signed change and its basis', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openWithHistory(page, '/?range=7d&vs=prev');
    const { current, baseline } = await shownWindows(page);
    // Seven whole hours-aligned days, the seven before them, back to back.
    expect(current.toMs - current.fromMs).toBe(7 * DAY_MS);
    expect(baseline.toMs - baseline.fromMs).toBe(7 * DAY_MS);
    expect(baseline.toMs).toBe(current.fromMs);
    const a = await expectedFigures(page, current);
    const b = await expectedFigures(page, baseline);
    expect(a.rows).toBeGreaterThan(0);
    expect(b.rows).toBeGreaterThan(0);
    const cmp = compareRanges(a, b);
    expect(cmp.basis).toBe('sum');
    await expect(hero(page)).toHaveAttribute('data-compare-basis', 'sum');

    const figure = page.locator('[data-testid="receipt-hero"] [data-callout="saved"]');
    await expect(figure).toHaveText(fmtDollars(a.savedM));
    await expect(page.getByTestId('hero-compare')).toContainText('Compared with the previous 7 days');
    await expect(page.getByTestId('hero-compare-fromto')).toHaveText(`${fmtDollars(b.savedM)} → ${fmtDollars(a.savedM)}`);
    const delta = page.getByTestId('hero-compare-delta');
    await expect(delta).toContainText(cmp.direction === 'flat' ? 'No change' : `${signed(cmp.deltaM)} (${signedPct(cmp.pct ?? 0)})`);
    await expect(delta).toHaveAttribute('data-direction', cmp.direction);
    // Every percentage names its basis.
    await expect(delta).toHaveAttribute('title', 'of what the previous 7 days saved');
    await expect(page.getByTestId('hero-compare-share')).toContainText(`Share of dollars saved ${fmtPct(b.ratio)} → ${fmtPct(a.ratio)}`);
    // The receipt bar is two stacked bars on one scale.
    const bars = page.getByTestId('hero-compare-bars');
    await expect(bars.locator('.mr-cmp-row')).toHaveCount(2);
    await expect(bars).toContainText('This range');
    await expect(bars).toContainText('The previous 7 days');
    // Each bar's line foots (W3-RECEIPT-1): paid prints as would have paid − saved as printed.
    for (const w of [a, b]) {
      const f = footMoney({ whpM: w.whpM, paidM: w.paidM, savedM: w.savedM });
      await expect(bars).toContainText(`Would have paid ${fmtDollars(f.whpM)} · paid ${fmtDollars(f.paidM)}`);
    }
    const widths = await bars.locator('.mr-cmp-track').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    const lane = await bars.locator('.mr-cmp-lane').first().evaluate((e) => e.getBoundingClientRect().width);
    expect(Math.abs(widths[0] / lane - a.whpM / Math.max(a.whpM, b.whpM))).toBeLessThan(0.01);
    expect(Math.abs(widths[1] / lane - b.whpM / Math.max(a.whpM, b.whpM))).toBeLessThan(0.01);
    // What moved lists only the lines that changed: none, when the week repeated itself to the dollar.
    const moved = comparisonLinesMoved(a, b);
    await expect(page.getByTestId('hero-compare-movers').locator('li')).toHaveCount(Math.min(3, moved));
    // The callouts stay on the range's own bar.
    await expect(hero(page).locator('[data-callout="whp"]')).toHaveCount(1);
    // The comparison takes the right column: the other periods' list steps aside, and the actions stay in the
    // title row above the figure (review W2: the aside fell under "How this number is made" and the actions floated).
    if ((page.viewportSize()?.width ?? 0) >= 1024) {
      await expect(page.getByTestId('hero-aside')).toBeHidden();
      const actions = (await hero(page).locator('.mr-hero-actions').boundingBox())!;
      const number = (await figure.boundingBox())!;
      expect(actions.y + actions.height).toBeLessThanOrEqual(number.y);
    }
    expect(errors()).toEqual([]);
    await shootBothSizes(page, 'compare-prev');
  });

  test('Copy receipt carries both windows, both totals and the change', async ({ page, context, browserName }) => {
    await allowClipboard(context, browserName);
    await openWithHistory(page, '/?range=7d&vs=prev');
    const { current, baseline } = await shownWindows(page);
    const a = await expectedFigures(page, current);
    const b = await expectedFigures(page, baseline);
    const cmp = compareRanges(a, b);
    await page.getByRole('button', { name: 'Copy receipt' }).click();
    await expect(page.getByText('Receipt copied.')).toBeVisible();
    const text = await readClipboard(page);
    expect(text).toContain('Meter Reader — receipt comparison');
    // Both windows, named, with their words (one line each, or the name then the words indented).
    const lines = text.split('\n');
    const words = (name: string) => {
      const i = lines.findIndex((l) => l.startsWith(name));
      return lines[i].length > name.length ? lines[i].slice(name.length).trim() : lines[i + 1].trim();
    };
    // A window of whole days reads "Sep 20–26" (rangeSpanLabel); one with hours "Sep 19, 2:00 PM–Sep 26, 2:00 PM".
    expect(words('This range')).toMatch(/^[A-Z][a-z]{2} \d+(, |–)/);
    expect(words('The previous 7 days')).toMatch(/^[A-Z][a-z]{2} \d+(, |–)/);
    expect(words('This range')).not.toBe(words('The previous 7 days'));
    expect(text).toMatch(new RegExp(`Saved by Cribl, this range +\\${fmtDollars(a.savedM)}`));
    expect(text).toMatch(new RegExp(`Saved by Cribl, the previous 7 days +\\${fmtDollars(b.savedM)}`));
    expect(text).toContain(`This range: would have paid ${fmtDollars(a.whpM)}`);
    expect(text).toContain(`The previous 7 days: would have paid ${fmtDollars(b.whpM)}`);
    if (cmp.pct !== undefined) expect(text).toContain(`(${signedPct(cmp.pct)})`);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(48);
  });

  test('the picker: Compare with the previous period previews both windows and applies ?vs=prev', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openWithHistory(page);
    await customToggle(page).click();
    await picker(page).waitFor();
    await picker(page).getByRole('radio', { name: '24 h' }).click();
    await compareWith(page, 'The previous period');
    await expect(picker(page)).toBeVisible(); // the select's list closed; the picker stayed open
    await expect(page.getByTestId('range-preview')).toContainText('Summed in whole hours as');
    await expect(page.getByTestId('range-compare-preview')).toHaveText(/^Compared with .* \(1 day\)\.$/);
    await expect(page.getByTestId('range-reads')).toHaveText(/^Reads \d+ history documents? for both windows\.$/);
    await shootPicker(page, 'picker-compare');
    await picker(page).getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('vs')).toBe('prev');
    expect(new URL(page.url()).searchParams.get('range')).toBe('24h');
    const { current, baseline } = await shownWindows(page);
    // The older day is summed in whole hours, so the range is too: 24 whole hours each, back to back.
    expect(current.toMs - current.fromMs).toBe(24 * HOUR_MS);
    expect(baseline.toMs).toBe(current.fromMs);
    await expect(page.getByTestId('hero-compare-notes')).toContainText('whole hours, to compare like with like');
    await expect(page.getByTestId('hero-compare')).toContainText('Compared with the previous 24 h');
    // Re-opening the picker shows the comparison it applied.
    await customToggle(page).click();
    await expect(picker(page).getByRole('button', { name: /Compare with/ })).toContainText('The previous period');
    await picker(page).getByRole('button', { name: 'Cancel' }).click();
    // A period clears the range and what it was compared with.
    await page.getByRole('radiogroup', { name: 'Headline period' }).getByRole('radio', { name: 'MTD' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('vs')).toBeNull();
    expect(new URL(page.url()).searchParams.get('range')).toBeNull();
    await expect(page.getByTestId('hero-compare')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('a commit: 24 h after its deploy against the 24 h before, the deploy hour left out of both', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const ws = await openWithHistory(page);
    // The commit broke a trim: from the hour after its deploy, the biggest saver's hour rows save 45% less (what
    // it no longer removes is paid instead). Only the hour documents the after-window reads are rewritten.
    const d = Date.parse(ws.commit.deployedAt as string);
    await degradeAfter(page, hourFloor(d) + HOUR_MS, 0.45);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await hero(page).waitFor();
    await customToggle(page).click();
    await picker(page).waitFor();
    await compareWith(page, /^805b12c · demo: break the trim/);
    // The window is filled with the 24 h after the deploy.
    await expect(page.getByTestId('range-compare-preview')).toBeVisible();
    await shootPicker(page, 'picker-commit');
    await picker(page).getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('vs')).toBe('805b12c0d9e1f2a3b4c5d6e7f8091a2b3c4d5e6f');
    const { current, baseline } = await shownWindows(page);
    expect(current.fromMs).toBe(hourFloor(d) + HOUR_MS);
    expect(baseline.toMs).toBe(hourFloor(d));
    expect(current.toMs - current.fromMs).toBe(baseline.toMs - baseline.fromMs);
    await expect(page.getByTestId('hero-compare')).toContainText('Compared with the time before 805b12c');
    await expect(page.getByTestId('hero-compare-notes')).toContainText('the hour of the deploy');
    const bars = page.getByTestId('hero-compare-bars');
    await expect(bars).toContainText('After 805b12c');
    await expect(bars).toContainText('Before 805b12c');
    const a = await expectedFigures(page, current);
    const b = await expectedFigures(page, baseline);
    await expect(page.getByTestId('hero-compare-fromto')).toHaveText(`${fmtDollars(b.savedM)} → ${fmtDollars(a.savedM)}`);
    // Saved less after the commit: the change is the incident red, signed, a share of what the time before saved.
    const cmp = compareRanges(a, b);
    expect(cmp.basis).toBe('sum');
    expect(cmp.direction).toBe('down');
    const delta = page.getByTestId('hero-compare-delta');
    await expect(delta).toHaveAttribute('data-direction', 'down');
    await expect(delta).toContainText(`${fmtDollars(cmp.deltaM)} (${signedPct(cmp.pct ?? 0)})`);
    await expect(delta).toHaveAttribute('title', 'of what the time before 805b12c saved');
    // What moved: the broken saver first, its change in red.
    const first = page.getByTestId('hero-compare-movers').locator('li').first();
    await expect(first).toHaveAttribute('data-direction', 'down');
    expect(errors()).toEqual([]);
    await shootBothSizes(page, 'compare-commit');

    // Show the math makes the change auditable: both windows, the change, its share of the baseline.
    const openMath = async () => {
      await page.locator('.mr-hero-actions').getByRole('button', { name: 'Show the math' }).click();
      await expect(page.getByTestId('math-drawer')).toContainText('Compared with the time before 805b12c');
    };
    await openMath();
    const drawer = page.getByTestId('math-drawer');
    await expect(drawer).toContainText('Change = saved in this range − saved in the time before 805b12c');
    await expect(drawer).toContainText(`${fmtDollars(a.savedM)} − ${fmtDollars(b.savedM)} = ${fmtDollars(cmp.deltaM)}`);
    await expect(drawer).toContainText(`${fmtDollars(cmp.deltaM)} ÷ ${fmtDollars(b.savedM)} = ${signedPct(cmp.pct ?? 0)}`);
    await expect(page.getByTestId('math-compare-plan')).toContainText('Read for the comparison:');
    if (shoots()) {
      for (const width of [1440, 390]) {
        await page.keyboard.press('Escape');
        await drawer.waitFor({ state: 'detached' });
        await page.setViewportSize({ width, height: width > 640 ? 900 : 844 });
        await openMath();
        const section = page.locator('.mr-math-section', { hasText: 'Compared with the time before 805b12c' });
        for (const theme of ['light', 'dark'] as const) {
          await setTheme(page, theme);
          await section.scrollIntoViewIfNeeded();
          await section.screenshot({ path: `tests/report/screens/wave2-r-math-compare-${theme}-${width}.png` });
        }
        await setTheme(page, 'light');
      }
    }
  });

  test('30 days against the 30 before, when collecting began 40 days ago: compared per day, and it says so', async ({ page }) => {
    await openWithHistory(page, '/?range=30d&vs=prev');
    const { current, baseline } = await shownWindows(page);
    await expect(hero(page)).toHaveAttribute('data-compare-basis', 'rate');
    const a = await expectedFigures(page, current);
    const b = await expectedFigures(page, baseline);
    const cmp = compareRanges(a, b);
    expect(cmp.basis).toBe('rate');
    await expect(page.getByTestId('hero-compare-fromto')).toHaveText(`${fmtDollars(cmp.baselineM)} → ${fmtDollars(cmp.currentM)}/ day`);
    await expect(page.getByTestId('hero-compare-notes')).toContainText("compared per day at each window's rate: the earlier window starts before collecting began");
    await expect(page.getByTestId('hero-compare-delta')).toHaveAttribute('title', 'of what the previous 30 days saved a day');
    // Nothing in the comparison is wider than its box (the per-day bar lines wrap on a phone).
    const clipped = await hero(page).locator('.mr-cmp, .mr-cmp-bars').evaluateAll((els) =>
      els.flatMap((el) => [...el.querySelectorAll('p')].filter((p) => p.scrollWidth > p.clientWidth + 1).map((p) => p.textContent)),
    );
    expect(clipped).toEqual([]);
    await shootBothSizes(page, 'compare-perday');
  });

  test('on the sample tour: 24 h before and after one of its commits, from the tour history synthesized in memory', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/first-run');
    await resetMock(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Tour with sample data' }).click();
    await expect(hero(page)).toBeVisible({ timeout: 15_000 });
    await customToggle(page).click();
    await picker(page).waitFor();
    await compareWith(page, /Drop Kubernetes debug/);
    await expect(page.getByTestId('range-compare-preview')).toBeVisible();
    await picker(page).getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('vs')).toMatch(/^[0-9a-f]{7,40}$/);
    await expect(hero(page)).toHaveAttribute('data-compare-status', 'ready', { timeout: 20_000 });
    await expect(page.getByTestId('hero-compare')).toContainText(/Compared with the time before [0-9a-f]{7}/);
    await expect(page.getByTestId('hero-compare-fromto')).toHaveText(/^\$[\d,]+ → \$[\d,]+/);
    await expect(page.getByTestId('hero-compare-bars').locator('.mr-cmp-row')).toHaveCount(2);
    // Dollars and share can move apart (less traffic, a better pipeline): the share line says which way it went.
    await expect(page.getByTestId('hero-compare-share')).toHaveText(/^Share of dollars saved \d+% → \d+% \((?:[+−]\d+ points?|0 points)\)$/);
    await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
    expect(errors()).toEqual([]);
    if (shoots()) {
      const size = page.viewportSize();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 640 ? 900 : 844 });
        for (const theme of ['light', 'dark'] as const) {
          await setTheme(page, theme);
          await blur(page);
          await page.evaluate(() => window.scrollTo(0, 0));
          // The viewport, so the sample band shows above the comparison.
          await page.screenshot({ path: `tests/report/screens/wave2-r-tour-compare-${theme}-${width}.png` });
        }
      }
      if (size) await page.setViewportSize(size);
      await setTheme(page, 'light');
    }
  });

  test('a comparison that cannot be made says why; the range still shows', async ({ page }) => {
    await openWithHistory(page, '/?range=30d&vs=week');
    await expect(hero(page)).toHaveAttribute('data-compare-status', 'refused', { timeout: 20_000 });
    await expect(page.getByTestId('hero-compare-refused')).toHaveText('A week earlier compares windows of 7 days or less.');
    await expect(hero(page)).toHaveAttribute('data-range-status', 'ready');
    await expect(page.locator('.mr-rbar')).toHaveCount(1); // the single receipt bar
    await shootBothSizes(page, 'compare-refused');
    // The previous period of a range that starts where collecting began was never metered: refused, named by
    // the range's own length (never "the previous 0 min"), and the notice says since when there is history.
    const stamp = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
    const since = Date.parse(JSON.parse((await kvGet(page, 'meta')) as string).collectingSince as string);
    await page.goto(`/?range=${stamp(since - DAY_MS)}..${stamp(since + 5 * DAY_MS)}&vs=prev`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('hero-compare-refused')).toHaveText(/^Nothing was metered before [A-Z][a-z]{2} \d+, so there is nothing to compare with\.$/, { timeout: 20_000 });
    await expect(page.getByTestId('hero-compare')).toContainText(/Compared with the previous \d+(?:\.\d)? days/);
    await expect(page.getByTestId('hero-compare')).not.toContainText('0 min');
    // An unknown commit is refused the same way.
    await page.goto('/?range=24h&vs=deadbee', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('hero-compare-refused')).toHaveText('Commit deadbee is not in the recent change timeline.', { timeout: 20_000 });
  });
});
