// tests/e2e/wave3-receipt.spec.ts — wave 3, the Receipt package:
//   • W3-RECEIPT-1: the Receipt bar's printed money adds up and agrees with the Report card (to the dollar);
//   • W3-RECEIPT-2: the 30-day trend names its biggest priced change at the change's diamond;
//   • W3-RECEIPT-3: no Receipt card stretches into an empty band beside a taller neighbour;
//   • W3-RECEIPT-5: the Receipt hero rolls up from $0 once per page, data-value-m the target from the first frame.
// Evidence: tests/report/screens/wave3-receipt-*.png (chromium, both themes, 1440 and 390).
//
// Run: MR_E2E_PORT=5502 npx playwright test tests/e2e/wave3-receipt.spec.ts --project=chromium

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { fmtDollars, footMoney } from '../../core/format.ts';
import type { Incident, Snapshot } from '../../core/types.ts';
import type { TourFixture } from '../../src/tour/types.ts';
import { planRebase, rebaseHeadline, rebaseValue } from '../../src/tour/rebase.ts';
import { expectPath, gotoApp, resetMock, setTheme, trackConsoleErrors, waitForHydration, type Theme } from './helpers/index.ts';

const TOUR = JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/tour.json', import.meta.url)), 'utf8')) as TourFixture;
const TZ = 'America/Chicago';

/**
 * Every month-to-date figure (would have paid, paid, saved) the tour can show today: its snapshot and each snapshot
 * step, moved onto today's date the way the tour engine moves them (as tests/e2e/report.spec.ts does).
 */
function sampleMtd(): { whpM: number; paidM: number; savedM: number }[] {
  const zone = TOUR.timezone || TZ;
  const plan = planRebase(Date.parse(TOUR.anchor ?? TOUR.generatedAt), Date.now(), zone);
  const snaps = [TOUR.snapshot, ...TOUR.script.filter((s) => s.action === 'snapshot').map((s) => s.payload as Snapshot)];
  const moved = (s: Snapshot) => (plan.dayShift === 0 ? s : rebaseHeadline(rebaseValue(s, plan), zone, TOUR.settings.criblCostCentsPerMonth));
  return snaps.map((s) => {
    const h = moved(s).headline;
    return { whpM: h.whpMtdM, paidM: h.paidMtdM, savedM: h.mtdM };
  });
}

/** Playwright's trace recorder in the Report card's sandboxed preview frame (as tests/e2e/report.spec.ts filters it). */
const TRACER_IN_SANDBOX = /^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.$/;

/** '$1,503,380' → 1503380. */
const dollars = (s: string): number => Number(s.replace(/[^0-9]/g, ''));

/** Evidence shots are written by the chromium project only (the mobile and 1920 projects would overwrite them). */
function shoots(): boolean {
  return test.info().project.name === 'chromium';
}

async function openSampleReceipt(page: Page): Promise<void> {
  await gotoApp(page, '/');
  await resetMock(page);
  await gotoApp(page, '/');
  await expectPath(page, '/first-run');
  await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
  await expectPath(page, '/');
  await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
  await page.getByTestId('receipt-hero').waitFor();
}

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.mouse.move(0, 0);
}

test.describe('W3-RECEIPT-1: the Receipt bar adds up and agrees with the Report card', () => {
  test('month to date on the tour: bar whp − bar paid = the saved figure, and bar paid = the Report card’s paid', async ({ page }) => {
    const errors = trackConsoleErrors(page, [TRACER_IN_SANDBOX]);
    await openSampleReceipt(page);
    const hero = page.getByTestId('receipt-hero');
    await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'mtd');
    const whp = dollars(await hero.locator('.mr-rbar-whp .mr-rbar-amount').innerText());
    const paid = dollars(await hero.locator('.mr-rbar-legend-paid .mr-rbar-amount').innerText());
    // The snapshot's month-to-date saved, in whole dollars, is the difference of the two printed figures: one of
    // the tour's month-to-date triples prints exactly these, footed (never the separately rounded paid).
    const triple = sampleMtd().find((m) => dollars(fmtDollars(m.whpM)) === whp && dollars(fmtDollars(m.savedM)) === whp - paid);
    expect(triple, `bar ${whp} − ${paid} matches no month-to-date saved of the tour`).toBeDefined();
    expect(dollars(fmtDollars(footMoney(triple!).paidM))).toBe(paid);
    // The bar's accessible label says the same three figures.
    const label = (await hero.locator('.mr-rbar-track').getAttribute('aria-label')) ?? '';
    expect(label).toContain(fmtDollars(footMoney(triple!).paidM));
    const saved = whp - paid;
    // The split under the bar sums to the saved figure too.
    const split = hero.getByTestId('receipt-split');
    if ((await split.count()) > 0) {
      const parts = (await split.locator('.mr-rbar-amount').allInnerTexts()).map(dollars);
      expect(parts).toHaveLength(2);
      expect(parts[0] + parts[1]).toBe(saved);
    }

    // The Report card prints the same paid.
    await hero.getByRole('button', { name: 'Report card' }).click();
    await expectPath(page, '/report');
    await expect(page.getByTestId('report-preview')).toBeVisible();
    await expect.poll(async () => (await page.getByTestId('report-preview').getAttribute('srcdoc')) ?? '').toContain('You paid');
    const html = (await page.getByTestId('report-preview').getAttribute('srcdoc')) ?? '';
    const reportPaid = /You paid (\$[\d,]+)/.exec(html)?.[1];
    expect(reportPaid).toBeDefined();
    expect(dollars(reportPaid!)).toBe(paid);
    expect(errors()).toEqual([]);
  });
});

test.describe('W3-RECEIPT-2: the trend names its biggest priced change', () => {
  test('exactly one annotation at 1440 and 390 in both themes, and it is the Ledger’s Changes row to the dollar', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSampleReceipt(page);
    const seen: { hash: string; amount: string }[] = [];
    for (const width of [1440, 390] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const theme of ['light', 'dark'] as Theme[]) {
        await setTheme(page, theme);
        const notes = page.getByTestId('receipt-trend').getByTestId('trend-annotation');
        await expect(notes).toHaveCount(1);
        const hash = (await notes.getAttribute('data-hash')) ?? '';
        const amount = (await notes.getAttribute('data-amount')) ?? '';
        expect(hash).toMatch(/^[0-9a-f]{7}$/);
        expect(amount).toMatch(/^[+−]\$[\d,]+$/);
        await expect(notes.locator('text')).toHaveText(new RegExp(`^${amount.replace(/[$+]/g, '\\$&')} / day · ${hash}(, today)?$`));
        // Red for a loss, green for a gain.
        expect(await notes.getAttribute('data-tone')).toBe(amount.startsWith('−') ? 'down' : 'up');
        // Inside the plot: the plate never crosses the x axis, and stays within the chart's width.
        const svg = (await page.getByTestId('trend-chart').boundingBox())!;
        const plate = (await notes.locator('rect').boundingBox())!;
        expect(plate.x).toBeGreaterThanOrEqual(svg.x);
        expect(plate.x + plate.width).toBeLessThanOrEqual(svg.x + svg.width + 0.5);
        const axis = await page.getByTestId('trend-chart').locator('.mr-trend-grid').evaluateAll((ls) => Math.max(...ls.map((l) => l.getBoundingClientRect().bottom)));
        expect(plate.y + plate.height).toBeLessThanOrEqual(axis);
        seen.push({ hash, amount });
      }
    }
    // One change, the same at every size and theme.
    expect(new Set(seen.map((s) => `${s.hash} ${s.amount}`)).size).toBe(1);
    // The Ledger's "Changes" row for that hash prints the same dollars.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('navigation').getByRole('link', { name: 'Ledger' }).click();
    await expectPath(page, '/ledger');
    const row = page.getByTestId('changes-list').locator(`[data-changes-row][data-commit="${seen[0].hash}"]`);
    await expect(row).toHaveAttribute('data-status', 'priced');
    await expect(row.locator('.mr-changes-amount')).toHaveText(seen[0].amount);
    expect(errors()).toEqual([]);
  });
});

/** For every card of the Receipt's grid: the empty band between its last content and its inner bottom edge, in px. */
async function cardVoids(page: Page): Promise<{ id: string; band: number }[]> {
  return page.locator('.mr-receipt-grid > .mr-receipt-card').evaluateAll((cards) =>
    cards.map((card) => {
      const cs = getComputedStyle(card);
      const inner = card.getBoundingClientRect().bottom - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth);
      let last = card.getBoundingClientRect().top;
      for (const el of card.querySelectorAll('*')) {
        if (el.children.length > 0 && !(el instanceof SVGSVGElement)) continue; // leaves (and whole charts) only
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
        last = Math.max(last, r.bottom);
      }
      return { id: card.getAttribute('data-testid') ?? card.className, band: Math.round(inner - last) };
    }),
  );
}

/** The tour's snapshot with `n` open alerts (copies of its closed one, opened in the last hour), on the emulator's KV. */
async function openWithOpenAlerts(page: Page, n: number): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  const now = await page.evaluate(() => Date.now());
  const base = TOUR.snapshot.incidents?.[0] as Incident;
  const labels = ['Palo Alto firewall east', 'Kubernetes prod', 'Payments API sampling', 'Windows events'];
  const incidents: Incident[] = Array.from({ length: n }, (_, i) => {
    const { closedAt: _closed, recoveredTo: _recovered, ...open } = base;
    return { ...open, id: `inc_w3_${i}`, label: labels[i % labels.length], objectKey: `${base.objectKey}_${i}`, openedAt: new Date(now - (i + 1) * 600_000).toISOString() };
  });
  const snapshot: Snapshot = { ...TOUR.snapshot, incidents };
  await page.evaluate(
    async (docs) => {
      for (const [key, value] of Object.entries(docs)) {
        const r = await fetch(`/mock-api/v1/kvstore/${key}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(value) });
        if (r.status >= 300) throw new Error(`PUT ${key} → ${r.status}`);
      }
    },
    { settings: TOUR.settings, prices: TOUR.prices, meta: TOUR.meta, snapshot },
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await page.getByTestId('receipt-hero').waitFor();
  await expect(page.getByTestId('receipt-alerts').locator('.mr-inc--compact')).toHaveCount(Math.min(n, 3));
}

test.describe('W3-RECEIPT-3: no Receipt card stretches into a void', () => {
  for (const width of [1440, 1920] as const) {
    test(`the tour, calm alerts (${width}): every card ends within 40 px of its content`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width, height: 1000 });
      await openSampleReceipt(page);
      await expect(page.getByTestId('receipt-alerts').getByText('No open alerts')).toBeVisible();
      const voids = await cardVoids(page);
      expect(voids.length).toBeGreaterThanOrEqual(4);
      for (const v of voids) expect(v.band, `${v.id}: empty band under its content`).toBeLessThanOrEqual(40);
      expect(errors()).toEqual([]);
    });
  }

  test('two open alerts beside the destinations (1440): neither card holds a void', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openWithOpenAlerts(page, 2);
    const voids = await cardVoids(page);
    for (const v of voids) expect(v.band, `${v.id}: empty band under its content`).toBeLessThanOrEqual(40);
    if (shoots()) {
      for (const theme of ['light', 'dark'] as Theme[]) {
        await setTheme(page, theme);
        await blur(page);
        await page.locator('.mr-receipt-grid').screenshot({ path: `tests/report/screens/wave3-receipt-grid-alerts-${theme}-1440.png` });
      }
    }
  });
});

interface RollFrame {
  t: number;
  v: number;
  /** each wheel strip's translate, in % of the strip (0 = the wheel shows 0) */
  wheels: number[];
}

/** Records every frame of the Receipt hero figure from the page's start: its value attribute and its wheels. */
async function recordHero(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: { t: number; v: number; wheels: number[] }[] = [];
    (window as unknown as { __mrRoll: typeof seen }).__mrRoll = seen;
    const tick = () => {
      const el = document.querySelector('[data-testid="receipt-hero"] [data-callout="saved"][data-value-m]');
      if (el) {
        const wheels = [...el.querySelectorAll<HTMLElement>('.mr-meter-strip')].map((w) => Math.abs(parseFloat(/,\s*(-?[\d.]+)%/.exec(w.style.transform)?.[1] ?? '0')));
        seen.push({ t: performance.now(), v: Number(el.getAttribute('data-value-m')), wheels });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const frames = (page: Page): Promise<RollFrame[]> => page.evaluate(() => (window as unknown as { __mrRoll: RollFrame[] }).__mrRoll.slice());
const clearFrames = (page: Page): Promise<void> => page.evaluate(() => void ((window as unknown as { __mrRoll: RollFrame[] }).__mrRoll.length = 0));
/** The leading wheel shows 0 (a strip holds at least ten cells, so one cell is under 10 %). */
const leadingZero = (f: RollFrame): boolean => f.wheels.length > 0 && f.wheels[0] < 9;

test.describe('W3-RECEIPT-5: the Receipt hero rolls up from $0 on first paint, once', () => {
  test('the wheels turn up from $0 for over a second while data-value-m says the figure from the first frame', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await recordHero(page);
    await openSampleReceipt(page);
    await page.waitForTimeout(1_600);
    const seen = await frames(page);
    expect(seen.length).toBeGreaterThan(10);
    const first = seen[0];
    const final = seen[seen.length - 1];
    // The figure from frame one: the snapshot's (it only grows with the accrual after that).
    expect(first.v).toBeGreaterThan(0);
    expect(first.v).toBeLessThanOrEqual(final.v);
    expect(first.v).toBeGreaterThanOrEqual(final.v * 0.999);
    // The wheels start at $0 (the leading wheel at 0 while the figure's leads with 1–9; the low wheels are already
    // turning by the first frame the page can see) and are still turning a second later (1.2 s, eased out).
    expect(leadingZero(first), `first frame wheels ${first.wheels.join(',')}`).toBe(true);
    expect(leadingZero(final), `final wheels ${final.wheels.join(',')}`).toBe(false);
    let lastMove = 0;
    for (let i = 1; i < seen.length && seen[i].t - first.t <= 1_400; i++) if (seen[i].wheels.join() !== seen[i - 1].wheels.join()) lastMove = i;
    expect(seen[lastMove].t - first.t, 'the digits roll for at least a second').toBeGreaterThanOrEqual(1_000);

    // A period switch eases from where the wheels are, down to today's figure: never back up from $0.
    await clearFrames(page);
    await page.getByRole('radio', { name: 'Today' }).click();
    await page.waitForTimeout(1_400);
    const switched = await frames(page);
    const today = switched[switched.length - 1].v;
    expect(switched.filter((f) => f.v < today * 0.999).map((f) => f.v), 'a roll-up from $0 after a period switch').toEqual([]);
    await page.getByRole('radio', { name: 'MTD' }).click();
    await page.waitForTimeout(600);

    // A second visit in the same page load shows the figure at once.
    await page.getByRole('navigation').getByRole('link', { name: 'Ledger' }).click();
    await expectPath(page, '/ledger');
    await clearFrames(page);
    await page.getByRole('navigation').getByRole('link', { name: 'Receipt' }).click();
    await expectPath(page, '/');
    await page.getByTestId('receipt-hero').locator('[data-value-m]').waitFor();
    await page.waitForTimeout(400);
    const again = await frames(page);
    expect(again.length).toBeGreaterThan(0);
    const lead = again[again.length - 1].wheels[0];
    expect(lead).toBeGreaterThanOrEqual(9);
    expect(again.filter((f) => f.wheels[0] !== lead).length, 'no roll-up on a second visit').toBe(0);
    // (A tour beat may land a new snapshot meanwhile: the figure then eases to it, it never rolls up from $0.)
    expect(again[0].v).toBeGreaterThanOrEqual(again[again.length - 1].v * 0.5);
    expect(errors()).toEqual([]);
  });

  test('no roll-up under reduced motion: the figure is there from the first frame', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await recordHero(page);
    await openSampleReceipt(page);
    await page.waitForTimeout(800);
    const seen = await frames(page);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].v).toBeGreaterThan(0);
    expect(seen[0].v).toBe(seen[seen.length - 1].v);
    const text = await page.getByTestId('receipt-hero').locator('.mr-meter-text').first().innerText();
    expect(Number(text.replace(/[^0-9]/g, ''))).toBe(Math.round(seen[0].v / 100_000));
  });
});

// Evidence in both themes at 1440 and 390: the hero's bar (it adds up), the trend (its annotation) and the card grid.
test.describe('wave 3 Receipt evidence', () => {
  for (const width of [1440, 390] as const) {
    test(`hero, trend and grid in both themes (${width})`, async ({ page }) => {
      test.skip(!shoots(), 'evidence is written by the chromium project');
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openSampleReceipt(page);
      for (const theme of ['light', 'dark'] as Theme[]) {
        await setTheme(page, theme);
        await blur(page);
        await page.getByTestId('receipt-hero').screenshot({ path: `tests/report/screens/wave3-receipt-hero-${theme}-${width}.png` });
        const trend = page.locator('.mr-trend').first();
        await trend.scrollIntoViewIfNeeded();
        await trend.screenshot({ path: `tests/report/screens/wave3-receipt-trend-${theme}-${width}.png` });
        await page.locator('.mr-receipt-grid').screenshot({ path: `tests/report/screens/wave3-receipt-grid-${theme}-${width}.png` });
      }
      expect(errors()).toEqual([]);
    });
  }
});
