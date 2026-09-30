// tests/e2e/flow.spec.ts — the Flow view (PRD 8.2) and the What-if view (DESIGN_BRIEF 5.9) on the emulator.
//
// Seeds the rig's prices into the emulated KV, lets the tab's own meter (runtime 'ui') sweep once, then checks
// the map (ribbons, saved wedges, labels, the receipt card, keyboard, motion) and the What-if calculator on
// each basis (dry run, similar stream, documented range, none, custom). The sample tour's 55-flow, three-group workspace
// checks the real-data map (BEAUTY F9: fitted to the viewport, the long tail folded, a list on phones).
// The beauty grid is written to tests/report/beauty/{flow,whatif,flow-tour}-{light,dark}-{390,1440,1920}.png
// by the `chromium` project only (BEAUTY F28: the mobile project must never overwrite a -1440 file).
//
// The dry run: the emulator answers the preview API with the rig's own samples (tests/e2e/notifications.spec.ts
// covers that path). These tests pin exact bytes, and MSW's service worker answers every /mock-api request
// before page.route could see it, so they patch window.fetch (addInitScript) for the sample's content and
// POST /preview; the no-preview case turns the emulator's route off with a fault.

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { defaultSettings } from '../../core/settings.ts';
import { RIG_PRICES, expectPath, gotoApp, kvGet, mockControl, resetMock, seedPrices, setTheme, trackConsoleErrors, waitForHydration, waitForMock, warmWorkspace } from './helpers/index.ts';
import { injectLedgerDocs, loadDemoFixture } from './ledger-fixture.ts';

const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

/** The fixed-width beauty files belong to the desktop project; the mobile one (DPR 3) must not overwrite them. */
const shootsGrid = (info: TestInfo): boolean => info.project.name === 'chromium';

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1440) <= 640;

/** On a phone the map is a list; the diagram is one tap away ("Show map"). */
async function showMapOnPhone(page: Page): Promise<void> {
  if (!isPhone(page)) return;
  const toggle = page.getByTestId('flow-view-toggle').getByRole('button');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
}

/** Opens `path` on a priced emulator and waits for the map to draw the rig (the list on a phone, unless `map`). */
async function openPriced(page: Page, path: string, { map = true }: { map?: boolean } = {}): Promise<void> {
  await gotoApp(page, '/flow');
  await seedPrices(page);
  await gotoApp(page, path);
  if (isPhone(page) && !map) {
    await expect(page.locator('[data-list-ribbon]').first()).toBeVisible({ timeout: 30_000 });
    return;
  }
  await expect(page.getByTestId('flow-receipt')).toBeVisible({ timeout: 30_000 });
  await showMapOnPhone(page);
  await expect(page.locator('[data-testid="flow-diagram"] [data-ribbon]').first()).toBeVisible({ timeout: 30_000 });
  // let the first 200 ms re-scale settle
  await page.waitForTimeout(400);
}

interface RibbonFigure {
  id: string;
  /** would-have-paid, millicents per day */
  whp: number;
  /** drawn band width, px */
  w: number;
}

/** Every drawn ribbon's would-have-paid and band width (data-whp / data-band-w on the ribbon group). */
async function readRibbons(page: Page): Promise<RibbonFigure[]> {
  return page.locator('[data-testid="flow-diagram"] [data-ribbon]').evaluateAll((els) =>
    els.map((g) => ({ id: g.getAttribute('data-ribbon') ?? '', whp: Number(g.getAttribute('data-whp')), w: Number(g.getAttribute('data-band-w')) })),
  );
}

/** Band width is a strictly increasing function of would-have-paid (equal dollars, equal widths). */
function expectMonotonicInWhp(ribbons: readonly RibbonFigure[]): void {
  expect(ribbons.length).toBeGreaterThan(1);
  const byWhp = [...ribbons].sort((a, b) => a.whp - b.whp);
  for (let i = 1; i < byWhp.length; i++) {
    const [a, b] = [byWhp[i - 1], byWhp[i]];
    if (b.whp > a.whp) expect(b.w, `${b.id} ($${b.whp}) is wider than ${a.id} ($${a.whp})`).toBeGreaterThan(a.w);
    else expect(b.w).toBeCloseTo(a.w, 1);
  }
}

/** WCAG contrast of two sRGB colours. */
function contrast(a: readonly number[], b: readonly number[]): number {
  const lum = (c: readonly number[]) => {
    const [r, g, bl] = c.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

interface PaintProbe {
  panel: number[];
  /** each named band's fill, composited over the panel at its fill-opacity */
  bands: { id: string; rgb: number[] }[];
  /** the folded "smaller flows" band */
  other: { id: string; rgb: number[] }[];
  /** the saved wedge's tint (the hatch background), composited over the panel */
  wedge: number[] | null;
}

/** Reads the map's computed paints: every band and the wedge tint, composited over the card panel. */
async function probePaints(page: Page): Promise<PaintProbe> {
  return page.evaluate(() => {
    const rgba = (c: string): number[] => {
      const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
      return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1];
    };
    const panel = rgba(getComputedStyle(document.querySelector('.mr-flowmap-diagram')!).backgroundColor);
    const over = (fill: string, opacity: number): number[] => {
      const f = rgba(fill);
      const a = opacity * f[3];
      return [0, 1, 2].map((i) => f[i] * a + panel[i] * (1 - a));
    };
    const read = (sel: string) =>
      [...document.querySelectorAll(sel)].map((g) => {
        const band = g.querySelector('.mr-flow-band')!;
        const cs = getComputedStyle(band);
        return { id: g.getAttribute('data-ribbon') ?? '', rgb: over(cs.fill, Number(cs.fillOpacity)) };
      });
    const bg = document.querySelector('.mr-flow-hatch-bg');
    const bcs = bg ? getComputedStyle(bg) : null;
    return {
      panel: panel.slice(0, 3),
      bands: read('[data-ribbon]:not(.is-other):not(.is-projected)'),
      other: read('[data-ribbon].is-other'),
      wedge: bcs ? over(bcs.fill, Number(bcs.fillOpacity)) : null,
    };
  });
}

async function shoot(page: Page, name: string, info: TestInfo): Promise<void> {
  if (!shootsGrid(info)) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    for (const size of WIDTHS) {
      await page.setViewportSize(size);
      await page.waitForTimeout(350);
      await page.screenshot({ path: `tests/report/beauty/${name}-${theme}-${size.width}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, 'light');
}

test.describe('Flow view', () => {
  test('draws the priced rig with saved wedges, plates and one receipt card', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/flow');
    await expect(page.getByTestId('flow-subtitle')).toHaveText('Cribl Insights shows this map in bytes. This is dollars.');
    await expect(page.getByRole('heading', { level: 1, name: 'Flow' })).toBeVisible();

    const diagram = page.getByTestId('flow-diagram');
    await expect(diagram.locator('[data-ribbon]')).toHaveCount(6);
    // the three reduced streams carry a hatched wedge; the three raw ones do not
    await expect(diagram.locator('[data-wedge]')).toHaveCount(3);
    await expect(diagram.locator('[data-wedge]').first()).toHaveAttribute('fill', /^url\(#mr-flow-hatch-/);
    // money on plates: every saving stream has a "$… saved" plate (on a phone's narrow map, only ribbons ≥ 12 px)
    if (!isPhone(page)) await expect(diagram.locator('[data-label^="saved:"]')).toHaveCount(3);
    await expect(diagram.locator('[data-label^="saved:"] text').first()).toHaveText(/^\$[\d,]+ saved$/);
    // node labels are humanized
    // (names may wrap onto two lines on a phone; data-full carries the whole label)
    await expect(diagram.locator('[data-label="label:in:default:mrd_windows_dc"]')).toHaveAttribute('data-full', /^Windows DC security events · [\d.]+ GB \/ day in$/);
    await expect(diagram.locator('[data-label="label:pipe:default:mrd_pay_sample"]')).toHaveAttribute('data-full', 'Payments API sampling');
    // SVG text never falls back to a default serif
    const family = await diagram.locator('text').first().evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toMatch(/Open Sans/);

    // the one receipt card starts on the whole group
    const card = page.getByTestId('flow-receipt');
    await expect(card).toHaveCount(1);
    await expect(card.getByRole('heading')).toHaveText('All flows in default');
    await expect(card.getByTestId('receipt-whp')).toContainText('$');
    // hovering a ribbon traces its path onto the same card
    await diagram.locator('[data-ribbon="default|mrd_payments_api|mrd_payments_api|mrd_siem_prod"] path').first().hover();
    await expect(card.getByRole('heading')).toHaveText('Payments API');
    await expect(card).toContainText('Payments API sampling');
    await expect(card.getByTestId('receipt-saved')).toContainText('$75');
    await expect(card.getByRole('link', { name: /Open pipeline in Cribl/ })).toHaveAttribute('href', '/stream/m/default/pipelines/mrd_pay_sample');
    await expect(card.getByRole('link', { name: /Open pipeline in Cribl/ })).toHaveAttribute('target', '_top');
    await expect(diagram.locator('[data-ribbon].is-dim')).toHaveCount(5);
    expect(errors()).toEqual([]);
  });

  test('nodes are keyboard navigable with a visible focus ring; Enter pins, Escape releases', async ({ page }) => {
    await openPriced(page, '/flow');
    const diagram = page.getByTestId('flow-diagram');
    const first = diagram.locator('[data-node^="in:"]').first();
    await first.focus();
    await expect(diagram.locator('.mr-flow-focus')).toHaveCount(1);
    const firstId = await first.getAttribute('data-node');
    await page.keyboard.press('ArrowDown');
    const second = await page.evaluate(() => document.activeElement?.getAttribute('data-node'));
    expect(second).toMatch(/^in:/);
    expect(second).not.toBe(firstId);
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-node'))).toMatch(/^pipe:/);
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-node^="pipe:"][aria-pressed="true"]')).toHaveCount(1);
    await expect(page.getByTestId('flow-receipt')).toContainText('Pinned');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-node][aria-pressed="true"]')).toHaveCount(0);
  });

  test('drift runs slowly inside the highlighted path only and stops under reduced motion (P1-I08)', async ({ page }) => {
    await openPriced(page, '/flow');
    // at rest nothing drifts: no dots to paint 120 times a second for an effect nobody watches
    await page.mouse.move(1, 1);
    await expect(page.locator('.mr-flow-drift')).toHaveCount(0);
    const ribbon = page.locator('[data-ribbon="default|mrd_windows_dc|mrd_windows_dc|mrd_siem_prod"]');
    await ribbon.locator('path').first().hover();
    const drift = ribbon.locator('.mr-flow-drift').first();
    await expect(drift).toHaveCount(1);
    // only the hovered path drifts
    await expect(page.locator('[data-ribbon]:not(.is-active) .mr-flow-drift')).toHaveCount(0);
    const anim = await drift.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { name: cs.animationName, duration: parseFloat(cs.animationDuration), state: cs.animationPlayState };
    });
    expect(anim.name).toBe('mr-flow-drift');
    expect(anim.duration).toBeGreaterThanOrEqual(8);
    expect(anim.state).toBe('running');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await drift.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });

  test('a live snapshot that halves a flow’s savings eases over at least a second, not a 200 ms snap (P1-I08)', async ({ page }) => {
    test.setTimeout(120_000);
    await openPriced(page, '/flow');
    const id = 'default|mrd_payments_api|mrd_payments_api|mrd_siem_prod';
    // record every frame that redraws the Payments ribbon's docked band, and the map's ease (data-tween)
    await page.evaluate((rid) => {
      const w = window as unknown as { __mrBand: { t: number; d: string }[]; __mrTween: { t: number; kind: string | null }[] };
      w.__mrBand = [];
      w.__mrTween = [];
      const svg = document.querySelector('[data-testid="flow-diagram"]')!;
      const band = svg.querySelector(`[data-ribbon="${rid}"]`)!.querySelectorAll('.mr-flow-band')[1];
      new MutationObserver(() => w.__mrBand.push({ t: performance.now(), d: band.getAttribute('d') ?? '' })).observe(band, { attributes: true, attributeFilter: ['d'] });
      new MutationObserver(() => w.__mrTween.push({ t: performance.now(), kind: svg.getAttribute('data-tween') })).observe(svg, { attributes: true, attributeFilter: ['data-tween'] });
    }, id);
    // inject the next snapshot as a sweep would write it: Payments keeps its bytes in, saves half as much
    const snapshot = JSON.parse((await kvGet(page, 'snapshot'))!) as { sweepAt: string; flows: { inputId: string; outputId: string; whpPerDayM: number; paidPerDayM: number; savedPerDayM: number; outBPerDay: number; inBPerDay: number; ratio: number }[] };
    const pay = snapshot.flows.find((f) => f.inputId === 'mrd_payments_api' && f.outputId === 'mrd_siem_prod')!;
    expect(pay.savedPerDayM / pay.whpPerDayM).toBeGreaterThan(0.5);
    pay.savedPerDayM = Math.round(pay.savedPerDayM / 2);
    pay.paidPerDayM = pay.whpPerDayM - pay.savedPerDayM;
    pay.outBPerDay = Math.round(pay.inBPerDay * (pay.paidPerDayM / pay.whpPerDayM));
    pay.ratio = pay.ratio / 2;
    snapshot.sweepAt = new Date(Date.parse(snapshot.sweepAt) + 1_000).toISOString();
    await page.evaluate(async (body) => {
      await fetch('/mock-api/v1/kvstore/snapshot', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body });
      // The tab re-reads the snapshot only when meta moved (P1-D05), as a sweep's own write would move it.
      const meta = (await (await fetch('/mock-api/v1/kvstore/meta')).json()) as Record<string, unknown>;
      await fetch('/mock-api/v1/kvstore/meta', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }) });
    }, JSON.stringify(snapshot));
    // the live poll (10 s) reads it; the band redraws in bursts, one per new snapshot: find the injected one
    type Frame = { t: number; d: string };
    const bursts = async (): Promise<Frame[][]> => {
      const frames = await page.evaluate(() => (window as unknown as { __mrBand: Frame[] }).__mrBand);
      const out: Frame[][] = [];
      for (const f of frames) {
        const last = out[out.length - 1];
        if (last && f.t - last[last.length - 1].t < 300) last.push(f);
        else out.push([f]);
      }
      return out;
    };
    const biggest = async (): Promise<Frame[]> => (await bursts()).sort((a, b) => new Set(b.map((f) => f.d)).size - new Set(a.map((f) => f.d)).size)[0] ?? [];
    await expect.poll(async () => new Set((await biggest()).map((f) => f.d)).size, { timeout: 45_000, intervals: [500] }).toBeGreaterThanOrEqual(20);
    await page.waitForTimeout(1_500);
    const burst = await biggest();
    const span = burst[burst.length - 1].t - burst[0].t;
    // the live ease that carried it: from data-tween="live" to its end
    const marks = await page.evaluate(() => (window as unknown as { __mrTween: { t: number; kind: string | null }[] }).__mrTween);
    const start = [...marks].reverse().find((m) => m.kind === 'live' && m.t <= burst[0].t + 50);
    const end = start ? marks.find((m) => m.t > start.t && m.kind !== 'live') : undefined;
    const ease = start && end ? end.t - start.t : 0;
    test.info().annotations.push({ type: 'measured', description: `live ease ${Math.round(ease)} ms; the band moved over ${Math.round(span)} ms in ${new Set(burst.map((f) => f.d)).size} distinct frames` });
    expect(ease, 'the band-height transition lasts at least a second').toBeGreaterThanOrEqual(1_000);
    expect(ease).toBeLessThan(1_600);
    // and it is visibly moving for most of it, not a snap followed by nothing
    expect(span).toBeGreaterThanOrEqual(800);
  });

  test('an idle Flow tab barely paints: fewer than 10 paints a second (P1-I08)', async ({ page, browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'paint tracing is Chromium-only');
    test.setTimeout(120_000);
    await openPriced(page, '/flow');
    await page.mouse.move(1, 1);
    // the map redraws only when a sweep lands (every 30 s here): trace a window with no redraw in it
    await page.evaluate(() => {
      const w = window as unknown as { __mrLastDraw: number };
      w.__mrLastDraw = performance.now();
      new MutationObserver(() => (w.__mrLastDraw = performance.now())).observe(document.querySelector('[data-testid="flow-diagram"]')!, { attributes: true, subtree: true, childList: true });
    });
    const quietFor = () => page.evaluate(() => performance.now() - (window as unknown as { __mrLastDraw: number }).__mrLastDraw);
    let perSecond = Infinity;
    for (let attempt = 0; attempt < 4 && !Number.isFinite(perSecond); attempt++) {
      await expect.poll(quietFor, { timeout: 40_000, intervals: [250] }).toBeGreaterThan(1_500);
      const start = await page.evaluate(() => performance.now());
      await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
      await page.waitForTimeout(3_000);
      const trace = JSON.parse((await browser.stopTracing()).toString()) as { traceEvents: { name: string; ph: string }[] };
      const redrew = await page.evaluate((t) => (window as unknown as { __mrLastDraw: number }).__mrLastDraw > t, start);
      if (redrew) continue; // a sweep landed inside the window: that is not idle, trace another
      perSecond = trace.traceEvents.filter((e) => e.name === 'Paint' && (e.ph === 'X' || e.ph === 'B' || e.ph === 'I')).length / 3;
    }
    test.info().annotations.push({ type: 'measured', description: `idle Flow tab: ${perSecond.toFixed(1)} paints / s` });
    expect(perSecond, 'paints per second on an idle Flow tab').toBeLessThan(10);
  });

  test('without prices the map says how to get dollars on it', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/flow');
    await expect(page.getByTestId('flow-empty-unpriced')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Set a price to see dollars on this map')).toBeVisible();
    await expect(page.getByTestId('flow-subtitle')).toBeVisible();
    if (shootsGrid(info)) {
      await setTheme(page, 'dark');
      await page.screenshot({ path: 'tests/report/beauty/flow-empty-dark-1440.png', fullPage: true });
      await setTheme(page, 'light');
      await page.screenshot({ path: 'tests/report/beauty/flow-empty-light-1440.png', fullPage: true });
    }
    await page.getByRole('button', { name: 'Set prices' }).click();
    await expect(page).toHaveURL(/\/settings\/prices/);
    expect(errors()).toEqual([]);
  });

  test('the What if toggle is one pressed button, a compact bar over the same map that keeps the live rows (P1-I06)', async ({ page }, info) => {
    await openPriced(page, '/flow');
    /** Node ids per column (Source, Pipeline, Destination), top to bottom. */
    const columns = () =>
      page.locator('[data-testid="flow-diagram"] [data-node]').evaluateAll((els) => {
        const rows = els.map((e) => ({ id: e.getAttribute('data-node') ?? '', y: e.querySelector('.mr-flow-node-bar')!.getBoundingClientRect().top }));
        return ['in:', 'pipe:', 'out:'].map((k) => rows.filter((r) => r.id.startsWith(k)).sort((a, b) => a.y - b.y).map((r) => r.id));
      });
    const live = await columns();
    const cardTop = async () => (await page.locator('.mr-flowmap-diagram').boundingBox())!.y;
    const topBefore = await cardTop();

    const toggle = page.getByTestId('flow-whatif-toggle').getByRole('button');
    await expect(toggle).toHaveText('What if…');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(page).toHaveURL(/whatif=1/);
    // the same button, now pressed: same name, same variant, state in aria-pressed and the accent
    await expect(toggle).toHaveText('What if…');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // slice 2: on /flow the What-if is one compact bar, not the calculator
    await expect(page.getByTestId('whatif-bar')).toBeVisible();
    await expect(page.getByTestId('whatif-panel')).toHaveCount(0);
    await expect(page.getByTestId('projection-chip')).toBeVisible();
    await expect(page.locator('[data-ribbon].is-projected')).toHaveCount(1);
    // at rest the projection's focus on its stream dims no label: every word keeps full contrast (P1-I03)
    await page.mouse.move(1, 1);
    await expect(page.locator('.mr-flow-label.is-dim')).toHaveCount(0);
    // the map stays where the member was looking: its card top moves by the bar only (≤ 200 px at 1440)
    const topWith = await cardTop();
    test.info().annotations.push({ type: 'measured', description: `map card top ${Math.round(topBefore)} → ${Math.round(topWith)} px with the What-if bar` });
    if (!isPhone(page)) {
      expect(topWith - topBefore, 'the map card moves ≤ 200 px').toBeLessThanOrEqual(200);
      expect((await page.getByTestId('whatif-bar').boundingBox())!.height, 'the bar is compact').toBeLessThanOrEqual(120);
    }
    // the bar reads the stream's saved per day before → after and its basis; the card carries the math line
    await expect(page.getByTestId('whatif-bar-figures')).toContainText('→');
    await expect(page.getByTestId('whatif-bar').getByTestId('whatif-basis')).toHaveText('Similar stream');
    await expect(page.getByTestId('flow-receipt')).toContainText(/Projection · Similar stream: \d+% fewer bytes/);
    // the calculator is one link away, on the same stream and treatment
    await expect(page.getByTestId('whatif-bar-open')).toHaveAttribute('href', /\/whatif/);
    await evidence(page, 'I06-bar', info, { list: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('whatif-bar')).toHaveCount(0);
    await expect(page.getByTestId('projection-chip')).toHaveCount(0);

    // "Go aggressive" on the workstations raises their saving enough that an unpinned map re-orders the Sources
    // (Payments above VPC Flow); pinned to the live rows, every column keeps its order
    const stream = encodeURIComponent('default|mrd_windows_workstations|mrd_windows_workstations|mrd_siem_prod');
    await page.goto(`/flow?whatif=1&stream=${stream}&treatment=aggressive-windows`);
    await expect(page.getByTestId('projection-chip')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('flow-whatif-toggle').getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(700); // the 400 ms morph
    const projected = await columns();
    for (let c = 0; c < 3; c++) {
      const both = (a: string[], b: string[]) => a.filter((id) => b.includes(id));
      expect(both(projected[c], live[c]), `column ${c} keeps the live order`).toEqual(both(live[c], projected[c]));
    }
  });

  test('the map fits the viewport and draws dollars (band width follows would-have-paid); a phone gets a ranked list', async ({ page }) => {
    await openPriced(page, '/flow', { map: false });
    if (isPhone(page)) {
      const rows = page.locator('[data-list-ribbon]');
      await expect(rows).toHaveCount(6);
      // largest would-have-paid first; the S3 archive's $2/day flow is last
      await expect(rows.first()).toContainText('Windows DC security events');
      await expect(rows.last()).toContainText('AWS VPC Flow Logs');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'horizontal page scroll').toBeLessThanOrEqual(0);
      // a row pins its flow on the receipt card
      await rows.nth(1).click();
      await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('flow-receipt').getByRole('heading')).toHaveText(/Windows workstation events/);
      // the Sankey is one tap away
      await showMapOnPhone(page);
      await expect(page.locator('[data-testid="flow-diagram"] [data-ribbon]')).toHaveCount(6);
      return;
    }
    const card = await page.locator('.mr-flowmap-diagram').boundingBox();
    const vh = page.viewportSize()!.height;
    expect(card!.y + card!.height, 'the map card ends above the fold').toBeLessThanOrEqual(vh);
    // P1-I01: "This is dollars" — the band is √(would-have-paid $/day), so the 60 GB/day archive at $0.03/GB
    // ($1.80/day) is the thinnest shape although it carries more bytes than the $100/day Payments stream
    await expect(page.getByTestId('flow-diagram')).toHaveAttribute('data-weight-by', 'dollars');
    const ribbons = await readRibbons(page);
    expectMonotonicInWhp(ribbons);
    const thinnest = [...ribbons].sort((a, b) => a.w - b.w)[0];
    expect(thinnest.id).toContain('mrd_vpc_flow');
    // nothing fades by price on the dollar map (a cheap flow is already thin): one band opacity for all
    const opacity = (id: string) => page.locator(`[data-ribbon^="default|${id}|"] .mr-flow-band`).first().evaluate((el) => Number(getComputedStyle(el).fillOpacity));
    expect(await opacity('mrd_vpc_flow')).toBeCloseTo(await opacity('mrd_windows_dc'), 3);
  });

  test('names the rig destinations in words and says why flows are not drawn, linking to prices only when one lacks a price (P1-I04)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/flow');
    const diagram = page.getByTestId('flow-diagram');
    // title-cased, as demo/rig/destinations.json labels them: never 'siem-prod' beside 'Windows DC security events'
    await expect(diagram.locator('[data-label="label:out:default:mrd_siem_prod"]')).toHaveAttribute('data-full', /^SIEM \(prod\) · \$[\d,]+ \/ day$/);
    await expect(diagram.locator('[data-label="label:out:default:mrd_analytics"]')).toHaveAttribute('data-full', /^Analytics · /);
    await expect(diagram.locator('[data-label="label:out:default:mrd_archive_s3"]')).toHaveAttribute('data-full', /^Archive \(S3\) · /);
    // every destination is priced (DevNull at $0): the idle inputs are counted as idle, with no Set prices link
    const note = page.getByTestId('flow-note');
    await expect(note).toContainText(/\d+ flows? had no traffic in the last hour\./);
    await expect(note).not.toContainText('without a price');
    await expect(note.getByRole('link', { name: 'Set prices' })).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('links the footer to prices when a destination with traffic has no price (P1-I04)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    // The rig's destinations are DevNull outputs, which count as priced at $0 once any price is set (REVIEW-3a
    // #11), so an unpriced destination needs the emulator's scale workspace (Splunk HEC, S3, Sentinel, Datadog…):
    // price two of them and the rest keep traffic without a price.
    await gotoApp(page, '/flow');
    await resetMock(page, { preset: 'scale', flows: 60 });
    await gotoApp(page, '/flow');
    await seedPrices(page, {
      ...RIG_PRICES,
      versions: [{ ...RIG_PRICES.versions[0], byOutputId: { out_splunk_hec_0: { milliCentsPerGb: 250_000, preset: 'splunk_cloud' }, out_s3_1: { milliCentsPerGb: 3_000, preset: 's3' } } }],
    });
    await gotoApp(page, '/flow');
    await expect(page.getByTestId('flow-receipt')).toBeVisible({ timeout: 60_000 });
    const unpriced = page.getByTestId('flow-note-unpriced');
    await expect(unpriced).toHaveText(/^\d+ flows? go(es)? to (a )?destinations? without a price\. Set prices$/, { timeout: 30_000 });
    await expect(unpriced.getByRole('link', { name: 'Set prices' })).toHaveAttribute('href', /\/settings\/prices/);
    // the $0 and idle buckets never link to prices
    await expect(page.getByTestId('flow-note').getByRole('link', { name: 'Set prices' })).toHaveCount(1);
    expect(errors()).toEqual([]);
  });

  test('colour: every band holds 3:1 on the light panel, the wedge tint shows on the dark one, hover recedes the rest (P1-I03)', async ({ page }) => {
    await openPriced(page, '/flow');
    await setTheme(page, 'light');
    await page.waitForTimeout(300);
    const light = await probePaints(page);
    expect(light.bands.length).toBe(6);
    for (const b of light.bands) expect(contrast(b.rgb, light.panel), `light band ${b.id}`).toBeGreaterThanOrEqual(3);
    expect(contrast(light.wedge!, light.panel), 'light wedge tint').toBeGreaterThanOrEqual(1.15);

    await setTheme(page, 'dark');
    await page.waitForTimeout(300);
    const dark = await probePaints(page);
    expect(contrast(dark.wedge!, dark.panel), 'dark wedge tint').toBeGreaterThanOrEqual(1.3);
    for (const b of dark.bands) expect(contrast(b.rgb, dark.panel), `dark band ${b.id}`).toBeGreaterThanOrEqual(2);
    await setTheme(page, 'light');

    // hover: the path's labels stay at full strength, everyone else's step back; the other bands recede, not vanish
    const diagram = page.getByTestId('flow-diagram');
    await diagram.locator('[data-ribbon="default|mrd_payments_api|mrd_payments_api|mrd_siem_prod"] path').first().hover();
    await expect(diagram.locator('[data-ribbon].is-dim')).toHaveCount(5);
    // (after the 100 ms opacity transition) every non-path label is below full strength
    const dimOpacities = () => diagram.locator('.mr-flow-label.is-dim').evaluateAll((els) => els.map((e) => Number(getComputedStyle(e).opacity)));
    expect((await dimOpacities()).length).toBeGreaterThan(0);
    await expect.poll(async () => Math.max(...(await dimOpacities()))).toBeLessThan(1);
    await expect(diagram.locator('[data-label="whp:default|mrd_payments_api|mrd_payments_api|mrd_siem_prod"]')).toHaveCSS('opacity', '1');
    const dimBand = await diagram.locator('[data-ribbon].is-dim .mr-flow-band').first().evaluate((el) => Number(getComputedStyle(el).fillOpacity));
    expect(dimBand).toBeGreaterThanOrEqual(0.2);
  });

  test('beauty grid: flow', async ({ page }, info) => {
    test.setTimeout(120_000);
    await openPriced(page, '/flow');
    await shoot(page, 'flow', info);
  });
});

test.describe('Flow view on the sample tour (40 sources, three worker groups)', () => {
  test('fits one picture, folds the long tail into "smaller flows", and lists on a phone', async ({ page }, info) => {
    test.setTimeout(120_000);
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/');
    await resetMock(page);
    await gotoApp(page, '/');
    await expectPath(page, '/first-run');
    await page.getByRole('button', { name: 'Tour with sample data' }).click();
    await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
    await page.getByRole('navigation').getByRole('link', { name: 'Flow', exact: true }).click();
    await expectPath(page, '/flow');
    await expect(page.getByTestId('flow-receipt')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('flow-note')).toContainText(/flows? under \d+% of would-have-paid (is|are) grouped/);

    if (isPhone(page)) {
      const rows = page.locator('[data-list-ribbon]');
      expect(await rows.count()).toBeGreaterThanOrEqual(8);
      await expect(page.locator('[data-list-ribbon*="~other"]').first()).toContainText(/\d+ smaller flows/);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'horizontal page scroll').toBeLessThanOrEqual(0);
    } else {
      const diagram = page.getByTestId('flow-diagram');
      await expect(diagram.locator('[data-ribbon]').first()).toBeVisible();
      await page.waitForTimeout(400);
      // the long tail is one quiet source node, named by count
      await expect(diagram.locator('[data-node^="in:"][data-node$=":~other"]')).toHaveCount(1);
      await expect(diagram.locator('[data-label^="label:in:"][data-label$=":~other"]')).toHaveAttribute('data-full', /^\d+ smaller flows/);
      // one picture: the whole map card is above the fold
      const card = await page.locator('.mr-flowmap-diagram').boundingBox();
      expect(card!.y + card!.height, 'the map card ends above the fold').toBeLessThanOrEqual(page.viewportSize()!.height);
      // every source and destination keeps its name
      const nodes = await diagram.locator('[data-node^="in:"], [data-node^="out:"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-node')));
      for (const id of nodes) await expect(diagram.locator(`[data-label="label:${id}"]`), `${id} has a label`).toHaveCount(1);
    }
    // sample data is not the live workspace: no dry run on the tour
    await page.getByRole('navigation').getByRole('link', { name: 'What if', exact: true }).click();
    await expect(page.getByTestId('whatif-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /dry run/i })).toHaveCount(0);
    await page.getByRole('navigation').getByRole('link', { name: 'Flow', exact: true }).click();
    await expect(page.getByTestId('flow-receipt')).toBeVisible();

    if (shootsGrid(info)) {
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        for (const size of WIDTHS) {
          await page.setViewportSize(size);
          await page.waitForTimeout(450);
          await page.screenshot({ path: `tests/report/beauty/flow-tour-${theme}-${size.width}.png`, fullPage: true });
        }
      }
    }
    expect(errors()).toEqual([]);
  });
});

/** Starts the sample tour from a fresh emulator and opens its Flow map (the diagram, also on a phone). */
async function openTourFlow(page: Page, { map = true }: { map?: boolean } = {}): Promise<void> {
  await gotoApp(page, '/');
  await resetMock(page);
  await gotoApp(page, '/');
  await expectPath(page, '/first-run');
  await page.getByRole('button', { name: 'Tour with sample data' }).click();
  await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Flow', exact: true }).click();
  await expectPath(page, '/flow');
  await expect(page.getByTestId('flow-receipt')).toBeVisible({ timeout: 30_000 });
  if (map) {
    await showMapOnPhone(page);
    await expect(page.locator('[data-testid="flow-diagram"] [data-ribbon]').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);
  }
}

test.describe('Flow view on the sample tour · dollars (P1-I01)', () => {
  test('band width is monotonic in would-have-paid and every ribbon worth ≥ 2 % of the map carries its $ plate', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openTourFlow(page);
    const diagram = page.getByTestId('flow-diagram');
    await expect(diagram).toHaveAttribute('data-weight-by', 'dollars');
    const total = Number(await diagram.getAttribute('data-total-whp'));
    expect(total).toBeGreaterThan(0);
    const ribbons = await readRibbons(page);
    expectMonotonicInWhp(ribbons);
    // plates by dollar rank, not by pixels: the $2–3k/day streams that were too thin for a plate at 1440 now carry one
    const plates = new Set(await diagram.locator('[data-label^="whp:"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-label'))));
    const worth = ribbons.filter((r) => r.whp >= 0.02 * total);
    expect(worth.length).toBeGreaterThanOrEqual(isPhone(page) ? 8 : 10);
    for (const r of worth) expect(plates.has(`whp:${r.id}`), `${r.id} ($${Math.round(r.whp / 100_000)}/day) has a $ plate`).toBe(true);
    // the plate reads the ribbon's own would-have-paid
    const biggest = [...ribbons].sort((a, b) => b.whp - a.whp)[0];
    await expect(diagram.locator(`[data-label="whp:${biggest.id}"] text`)).toHaveText(`$${Math.round(biggest.whp / 100_000).toLocaleString('en-US')} / day`);
    expect(errors()).toEqual([]);
  });
});

test.describe('Flow view on the sample tour · colour (P1-I03)', () => {
  test('every named band holds 3:1 on the light panel; the folded band is a quiet grey, and stays one when highlighted', async ({ page }) => {
    await openTourFlow(page);
    await setTheme(page, 'light');
    await page.waitForTimeout(300);
    const light = await probePaints(page);
    expect(light.bands.length).toBeGreaterThanOrEqual(isPhone(page) ? 8 : 10);
    for (const b of light.bands) expect(contrast(b.rgb, light.panel), `light band ${b.id}`).toBeGreaterThanOrEqual(3);
    if (isPhone(page)) return;
    // the fold is designed quieter than any named flow (it never outshouts one): a grey below 3:1, by intent
    expect(light.other.length).toBeGreaterThanOrEqual(1);
    for (const o of light.other) expect(contrast(o.rgb, light.panel)).toBeLessThan(3);
    const fold = page.locator('[data-ribbon].is-other').first();
    await fold.locator('path').first().hover({ force: true });
    await expect(fold).toHaveClass(/is-active/);
    // (after the 100 ms fill-opacity transition)
    await expect.poll(() => fold.locator('.mr-flow-band').first().evaluate((el) => Number(getComputedStyle(el).fillOpacity))).toBeCloseTo(0.45, 2);
  });
});

test.describe('Flow view on the sample tour · captions and the long tail (P1-I04)', () => {
  test('a destination reads the same money at every width, and a folded ribbon names its part of the smaller flows', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openTourFlow(page);
    const splunkCaption = () =>
      page.locator('[data-testid="flow-diagram"] [data-label^="label:out:"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-full') ?? '').find((t) => t.startsWith('Splunk Cloud')) ?? '');
    const first = await splunkCaption();
    expect(first).toMatch(/^Splunk Cloud · \$[\d,]+ \/ day$/);

    if (!isPhone(page)) {
      // the folded ribbon into Splunk Cloud is one destination's part of the shared "N smaller flows" node
      const otherLabel = await page.locator('[data-label^="label:in:"][data-label$=":~other"]').getAttribute('data-full');
      const total = Number(/^(\d+) smaller flows/.exec(otherLabel ?? '')?.[1]);
      expect(total).toBeGreaterThan(1);
      const folded = page.locator('[data-ribbon*="|~other|"]');
      expect(await folded.count()).toBeGreaterThanOrEqual(2);
      await folded.first().locator('path').first().hover({ force: true });
      const heading = await page.getByTestId('flow-receipt').getByRole('heading').textContent();
      const m = /^(\d+) of the (\d+) smaller flows$/.exec(heading ?? '');
      expect(m, `card heading "${heading}"`).not.toBeNull();
      expect(Number(m![2])).toBe(total);
      expect(Number(m![1])).toBeLessThan(total);
    }

    // the other width: a phone's compact map draws ten flows, a desktop the fitted map
    if (isPhone(page)) await page.setViewportSize({ width: 1440, height: 900 });
    else {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await showMapOnPhone(page);
    }
    await page.waitForTimeout(600);
    expect(await splunkCaption()).toBe(first);
    expect(errors()).toEqual([]);
  });
});

test.describe('What if view', () => {
  test('projects the Windows pack on the workstations from the similar stream', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/whatif');
    await expect(page.getByRole('heading', { level: 1, name: 'What if' })).toBeVisible();
    await expect(page.getByTestId('whatif-stream')).toContainText('Windows workstation events');
    await expect(page.getByTestId('whatif-treatment')).toContainText('Windows XML pack');
    const basis = page.getByTestId('whatif-basis');
    await expect(basis).toHaveAttribute('data-basis', 'similar');
    await expect(basis).toContainText('Windows DC security events');
    await expect(page.getByTestId('whatif-results')).toContainText('Saved / day');
    await expect(page.getByTestId('whatif-hero')).toContainText('Saved by Cribl would read');
    await expect(page.getByTestId('whatif-hero')).toContainText(/a year at current rates, \+\$[\d,]+/); // r2 ui-7 (IC-2): the hero names its basis
    await expect(page.getByTestId('projection-chip')).toBeVisible();
    // the stream is re-routed to the pack pipeline its similar stream runs, drawn dashed
    const projected = page.locator('[data-ribbon="default|mrd_windows_workstations|mrd_windows_workstations|mrd_siem_prod"]');
    await expect(projected).toHaveClass(/is-projected/);
    await expect(projected).toHaveAttribute('data-flow', /mrd_win_xml_pack/);
    await expect(projected.locator('[data-wedge]')).toHaveCount(1);
    // the receipt card follows the projected stream
    await expect(page.getByTestId('flow-receipt')).toContainText('Projection');
    // the dry run is offered (live data, a pack the stream does not run yet) and never runs by itself
    await expect(page.getByRole('button', { name: 'Dry run on sample events' })).toBeVisible();
    await expect(page.getByTestId('whatif-dryrun')).toHaveAttribute('data-status', 'idle');
    // the release build has no Apply for real
    await expect(page.getByRole('button', { name: 'Apply for real' })).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('names a documented range, refuses to guess without a basis, and takes a custom drop', async ({ page }, info) => {
    await openPriced(page, '/whatif');
    const url = new URL(page.url());
    // Palo Alto: nothing here runs the pack yet → the documented, stacked range
    await page.goto(`${url.pathname}?stream=${encodeURIComponent('default|mrd_pan_firewall|mrd_pan_firewall|mrd_siem_prod')}&treatment=pack-panos`);
    await expect(page.getByTestId('whatif-basis')).toHaveAttribute('data-basis', 'documented', { timeout: 30_000 });
    await expect(page.getByTestId('whatif-basis')).toContainText('32%–51%');
    await expect(page.getByTestId('whatif-results')).toContainText(/\$[\d,]+–\$[\d,]+/);
    // Show the math names every step, and why there is no dry run
    await page.getByRole('button', { name: 'Show the math' }).click();
    await expect(page.getByText('Would have paid').first()).toBeVisible();
    await expect(page.getByText(/preview API/)).toBeVisible();
    await page.waitForTimeout(300);
    if (shootsGrid(info)) await page.screenshot({ path: 'tests/report/beauty/whatif-documented-light-1440.png', fullPage: true });
    // VPC Flow: no number published and nothing measured → no estimate, no projection
    await page.goto(`${url.pathname}?stream=${encodeURIComponent('default|mrd_vpc_flow|mrd_vpc_flow|mrd_archive_s3')}&treatment=pack-vpc`);
    await expect(page.getByTestId('whatif-no-basis')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('projection-chip')).toHaveCount(0);
    if (shootsGrid(info)) await page.screenshot({ path: 'tests/report/beauty/whatif-nobasis-light-1440.png' });
    // custom: drop 30 % of what payments sends today
    await page.goto(`${url.pathname}?stream=${encodeURIComponent('default|mrd_payments_api|mrd_payments_api|mrd_siem_prod')}&treatment=custom&drop=30`);
    await expect(page.getByTestId('whatif-basis')).toHaveAttribute('data-basis', 'custom', { timeout: 30_000 });
    await expect(page.getByTestId('whatif-basis')).toContainText('30%');
    await page.getByTestId('whatif-drop').fill('50');
    await expect(page).toHaveURL(/drop=50/);
    await expect(page.getByTestId('whatif-basis')).toContainText('50%');
    // a custom drop has no dry run
    await expect(page.getByRole('button', { name: /dry run/i })).toHaveCount(0);
    await setTheme(page, 'dark');
    await page.waitForTimeout(300);
    if (shootsGrid(info)) await page.screenshot({ path: 'tests/report/beauty/whatif-custom-dark-1440.png' });
  });

  test('beauty grid: what if', async ({ page }, info) => {
    test.setTimeout(120_000);
    await openPriced(page, '/whatif');
    await expect(page.getByTestId('whatif-results')).toBeVisible();
    await shoot(page, 'whatif', info);
  });
});

/**
 * Stands in for the Leader's preview API: the sample's content (10 events of 1,000 bytes of `_raw`) and
 * POST /m/<gid>/preview, which keeps the first 66 % of each `_raw` (a 34 % byte reduction, the Windows XML
 * pack's live ratio) and adds Cribl's internal fields. `previewStatus` ≠ 200 answers with that status.
 * Records every preview request body on window.__mrPreviewBodies.
 */
async function stubPreviewApi(page: Page, previewStatus = 200): Promise<void> {
  await page.addInitScript((status: number) => {
    const w = window as unknown as { __mrPreviewBodies: string[] };
    w.__mrPreviewBodies = [];
    const real = window.fetch.bind(window);
    const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, location.href).pathname;
      if (/\/m\/[^/]+\/system\/samples\/[^/]+\/content$/.test(path)) {
        return json(200, Array.from({ length: 10 }, (_, i) => ({ _raw: `<Event>${'x'.repeat(985)}</Event>`, _time: 1_790_000_000 + i })));
      }
      if (/\/m\/[^/]+\/preview$/.test(path) && (init?.method ?? 'GET') === 'POST') {
        const body = String(init?.body ?? '');
        w.__mrPreviewBodies.push(body);
        if (status !== 200) return json(status, { status: 'error', message: 'Forbidden' });
        const req = JSON.parse(body) as { pipelineId: string; events: { _raw: string; _time: number }[] };
        return json(200, {
          count: req.events.length,
          items: req.events.map((e, i) => ({ __criblEventType: 'event', __id: i, _time: e._time, _raw: e._raw.slice(0, 660), cribl_pipe: req.pipelineId })),
        });
      }
      return real(input, init);
    };
  }, previewStatus);
}

test.describe('What if · dry run on sample events', () => {
  test('measures the pack on the Source’s own sample and makes it the basis', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    await stubPreviewApi(page);
    await openPriced(page, '/whatif');
    await expect(page.getByTestId('whatif-basis')).toHaveAttribute('data-basis', 'similar');
    await page.getByRole('button', { name: 'Dry run on sample events' }).click();
    const basis = page.getByTestId('whatif-basis');
    await expect(basis).toHaveAttribute('data-basis', 'dry-run', { timeout: 30_000 });
    await expect(basis).toContainText('Dry run');
    await expect(basis).toContainText('Measured by dry run on 10 sample events of this source: 10.0 KB in, 6.6 KB out through');
    await expect(page.getByTestId('whatif-dryrun')).toHaveAttribute('data-status', 'measured');
    await expect(page.getByTestId('whatif-results')).toContainText('34%');
    // the request stayed inside the bounds and named the pipeline the similar stream runs
    const bodies = await page.evaluate(() => (window as unknown as { __mrPreviewBodies: string[] }).__mrPreviewBodies);
    expect(bodies).toHaveLength(1);
    const req = JSON.parse(bodies[0]) as { mode: string; pipelineId: string; events: unknown[] };
    expect(req.mode).toBe('pipe');
    expect(req.pipelineId).toBe('mrd_win_xml_pack');
    expect(req.events.length).toBeLessThanOrEqual(200);
    expect(new TextEncoder().encode(bodies[0]).length).toBeLessThan(90_000);
    // the projected ribbon is re-routed through the measured pipeline
    const projected = page.locator('[data-ribbon="default|mrd_windows_workstations|mrd_windows_workstations|mrd_siem_prod"]');
    await expect(projected).toHaveAttribute('data-flow', /mrd_win_xml_pack/);
    // a new treatment starts un-measured again
    const url = new URL(page.url());
    await page.goto(`${url.pathname}?stream=${encodeURIComponent('default|mrd_windows_workstations|mrd_windows_workstations|mrd_siem_prod')}&treatment=aggressive-windows`);
    await expect(page.getByTestId('whatif-dryrun')).toHaveAttribute('data-status', 'idle', { timeout: 30_000 });
    if (shootsGrid(info)) {
      await page.goBack();
      await expect(page.getByTestId('whatif-dryrun')).toHaveAttribute('data-status', 'idle', { timeout: 30_000 });
      await page.getByRole('button', { name: 'Dry run on sample events' }).click();
      await expect(page.getByTestId('whatif-basis')).toHaveAttribute('data-basis', 'dry-run', { timeout: 30_000 });
      await page.waitForTimeout(500);
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `tests/report/beauty/whatif-dryrun-${theme}-1440.png`, fullPage: true });
      }
    }
    expect(errors()).toEqual([]);
  });

  test('without the preview grant it says why and keeps the similar stream', async ({ page }) => {
    const errors = trackConsoleErrors(page, [/Failed to load resource: .*\b403\b/]);
    await stubPreviewApi(page, 403);
    await openPriced(page, '/whatif');
    await page.getByRole('button', { name: 'Dry run on sample events' }).click();
    const control = page.getByTestId('whatif-dryrun');
    await expect(control).toHaveAttribute('data-status', 'forbidden', { timeout: 30_000 });
    await expect(control).toContainText('No dry run: this App is not allowed to use the preview API here (HTTP 403). The estimate stays on the similar stream.');
    await expect(page.getByTestId('whatif-basis')).toHaveAttribute('data-basis', 'similar');
    expect(errors()).toEqual([]);
  });

  test('on a Leader without the preview API it falls back instead of guessing', async ({ page }) => {
    const errors = trackConsoleErrors(page, [/Failed to load resource: .*\b404\b/]);
    await openPriced(page, '/whatif');
    // The emulator answers the preview API (P1-O01); this Leader does not.
    await mockControl(page, { action: 'fault', method: 'POST', pattern: '/preview$', status: 404, times: -1 });
    await page.getByRole('button', { name: 'Dry run on sample events' }).click();
    const control = page.getByTestId('whatif-dryrun');
    await expect(control).not.toHaveAttribute('data-status', /idle|running/, { timeout: 30_000 });
    await expect(control).toContainText('The estimate stays on the similar stream.');
    await expect(page.getByTestId('whatif-basis')).toHaveAttribute('data-basis', 'similar');
    expect(errors()).toEqual([]);
  });
});

// Demo build only (VITE_MR_BUILD=demo): skipped on the release dev server, which has no lever code at all.
// Point it at a demo-build server the way demo.spec.ts does: MR_DEMO_BASE_URL=http://localhost:5178.
test.describe('What if · Apply for real (demo build)', () => {
  if (process.env.MR_DEMO_BASE_URL) test.use({ baseURL: process.env.MR_DEMO_BASE_URL });
  test('applies the pack through the real lever, then shows projected vs measured', async ({ page }) => {
    test.setTimeout(240_000);
    await gotoApp(page, '/flow');
    test.skip(!(await page.locator('footer').innerText()).includes('demo'), 'release build: no Apply for real');
    const settings = defaultSettings(new Date().toISOString(), 'America/Chicago');
    settings.demo = { ...settings.demo, enabled: true, profile: true };
    await page.evaluate(async (body) => {
      await fetch('/mock-api/v1/kvstore/settings', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body });
    }, JSON.stringify(settings));
    await seedPrices(page);
    await gotoApp(page, '/whatif');
    // The priced flows are drawn: ribbons on a desktop map, the ranked list on a phone (F9).
    await expect(page.locator('[data-testid="flow-diagram"] [data-ribbon], [data-testid="flow-list"] li').first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Apply for real' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Apply the Windows XML pack to Windows workstation events?');
    await expect(dialog).toContainText('mrd_win_xml_pack');
    await page.waitForTimeout(500);
    if (test.info().project.name === 'chromium') await page.screenshot({ path: 'tests/report/beauty/whatif-apply-confirm-light-1440.png' });
    await dialog.getByRole('button', { name: 'Apply for real' }).click();
    await expect(page).toHaveURL(/applied=\d+/, { timeout: 60_000 });
    await expect(page.getByTestId('whatif-actual')).toBeVisible();
    // the next sweep that meters a whole minute after the deploy fills in the measured ratio
    await expect(page.getByTestId('whatif-actual')).toHaveText(/Projected 33%, measured \d+% after \d+\u00a0min/, { timeout: 180_000 });
    if (test.info().project.name === 'chromium') await page.screenshot({ path: 'tests/report/beauty/whatif-applied-light-1440.png', fullPage: true });
  });
});

// ─── Wave 2 (WP-I) ───────────────────────────────────────────────────────────

const VIEWPORT: Record<number, { width: number; height: number }> = {
  390: { width: 390, height: 844 },
  1280: { width: 1280, height: 720 },
  1440: { width: 1440, height: 900 },
  1920: { width: 1920, height: 1080 },
};

/**
 * Wave-2 evidence: tests/report/screens/wave2-i-<name>-<theme>-<width>.png in both themes (chromium project only),
 * the map (not the list) on a phone unless `list`. `before` runs after each resize (a hover, a pin).
 */
async function evidence(
  page: Page,
  name: string,
  info: TestInfo,
  { widths = [1440, 390], list = false, before, fullPage = true }: { widths?: number[]; list?: boolean; before?: (page: Page) => Promise<void>; fullPage?: boolean } = {},
): Promise<void> {
  if (!shootsGrid(info)) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    for (const width of widths) {
      await page.setViewportSize(VIEWPORT[width]);
      await page.waitForTimeout(450);
      if (width <= 640 && !list) await showMapOnPhone(page);
      await before?.(page);
      await page.waitForTimeout(250);
      // a desktop map is fitted to the viewport (a full-page capture grows the window and re-fits it): shoot the viewport
      await page.screenshot({ path: `tests/report/screens/wave2-i-${name}-${theme}-${width}.png`, fullPage: fullPage && width <= 640 });
    }
  }
  await page.setViewportSize(VIEWPORT[1440]);
  await setTheme(page, 'light');
}

interface I02Geometry {
  plates: { id: string; onBand: boolean; leader: boolean; inBandAttr: string | null }[];
  pipes: { id: string; y0: number; y1: number }[];
  labels: { owner: string; y: number; h: number }[];
}

/** Saved plates against their own ribbon's paths (isPointInFill over the plate), pipeline labels against the bars. */
function readI02(page: Page): Promise<I02Geometry> {
  return page.evaluate(() => {
    const svg = document.querySelector('[data-testid="flow-diagram"]') as SVGSVGElement;
    const num = (el: Element, a: string) => Number(el.getAttribute(a));
    const plates = [...svg.querySelectorAll('[data-label^="saved:"]')].map((g) => {
      const rect = g.querySelector('rect.mr-flow-plate')!;
      const box = { x: num(rect, 'x'), y: num(rect, 'y'), w: num(rect, 'width'), h: num(rect, 'height') };
      const id = g.getAttribute('data-label')!.slice('saved:'.length);
      const ribbon = [...svg.querySelectorAll('[data-ribbon]')].find((r) => r.getAttribute('data-ribbon') === id)!;
      const paths = [...ribbon.querySelectorAll('.mr-flow-band, .mr-flow-wedge')] as SVGPathElement[];
      let onBand = false;
      for (let i = 0; i <= 10 && !onBand; i++)
        for (let j = 0; j <= 4 && !onBand; j++) {
          const pt = new DOMPoint(box.x + (box.w * i) / 10, box.y + (box.h * j) / 4);
          onBand = paths.some((p) => p.isPointInFill(pt));
        }
      return { id, onBand, leader: g.querySelector('.mr-flow-leader') !== null, inBandAttr: g.getAttribute('data-in-band') };
    });
    const pipes = [...svg.querySelectorAll('[data-node^="pipe:"]')].map((n) => {
      const bar = n.querySelector('.mr-flow-node-bar')!;
      return { id: n.getAttribute('data-node')!, y0: num(bar, 'y'), y1: num(bar, 'y') + num(bar, 'height') };
    });
    const labels = [...svg.querySelectorAll('[data-label^="label:pipe:"]')].map((g) => {
      const bb = (g as SVGGElement).getBBox();
      return { owner: g.getAttribute('data-label')!.slice('label:'.length), y: bb.y, h: bb.height };
    });
    return { plates, pipes, labels };
  });
}

function expectI02(geo: I02Geometry): void {
  expect(geo.plates.length).toBeGreaterThan(0);
  for (const p of geo.plates) expect(p.onBand || p.leader, `${p.id}: the plate is on its own band or joined to it by a leader`).toBe(true);
  expect(geo.labels.length).toBeGreaterThan(0);
  const gap = (l: { y: number; h: number }, n: { y0: number; y1: number }) => Math.max(0, n.y0 - (l.y + l.h), l.y - n.y1);
  for (const l of geo.labels) {
    const own = geo.pipes.find((n) => n.id === l.owner)!;
    for (const other of geo.pipes) {
      if (other.id === own.id) continue;
      expect(gap(l, own), `${l.owner}: nearer its own bar than ${other.id}`).toBeLessThan(gap(l, other));
    }
  }
}

test.describe('Flow · labels and plates belong to their own node and ribbon (P1-I02)', () => {
  test('the rig: saved plates on their band or with a leader; pipeline names nearest their own bar', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    await openPriced(page, '/flow');
    await page.mouse.move(1, 1);
    const geo = await readI02(page);
    expectI02(geo);
    // on the rig every plate fits on its own band at the pipeline
    if (!isPhone(page)) expect(geo.plates.every((p) => p.inBandAttr === '1')).toBe(true);
    await evidence(page, 'I02-rig', info);
    expect(errors()).toEqual([]);
  });

  test('the sample tour: every plate on its band or with a leader; every pipeline name nearest its own bar', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    await openTourFlow(page);
    await page.mouse.move(1, 1);
    expectI02(await readI02(page));
    await evidence(page, 'I02-tour', info, { widths: [1440, 1920, 390] });
    expect(errors()).toEqual([]);
  });
});

/** Distinct text lines the legend renders (its text's line boxes, by top). */
function legendLines(page: Page): Promise<number> {
  return page.locator('.mr-flowmap-legend').evaluate((ul) => {
    const tops = new Set<number>();
    const walker = document.createTreeWalker(ul, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round(r.top / 4));
    }
    return tops.size;
  });
}

test.describe('Flow on a phone and from the keyboard (P1-I05)', () => {
  test('at 390 a tapped row brings its receipt into view; the legend takes at most three lines', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize(VIEWPORT[390]);
    await openTourFlow(page, { map: false });
    const rows = page.locator('[data-list-ribbon]');
    await expect(rows.nth(4)).toBeVisible();
    const card = page.getByTestId('flow-receipt');
    await expect(card).not.toBeInViewport();
    const name = (await rows.nth(4).locator('.mr-flowlist-name').textContent()) ?? '';
    await rows.nth(4).click();
    await expect(rows.nth(4)).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByRole('heading')).toHaveText(name);
    await expect(card).toBeInViewport({ ratio: 0.5 });
    await expect(page.locator('.mr-flowmap-card')).toHaveAttribute('data-flash', '1');
    // the answer fades back; nothing loops
    await expect(page.locator('.mr-flowmap-card')).not.toHaveAttribute('data-flash', '1', { timeout: 3_000 });
    expect(await legendLines(page), 'legend lines at 390').toBeLessThanOrEqual(3);
    await showMapOnPhone(page);
    expect(await legendLines(page), 'legend lines under the map at 390').toBeLessThanOrEqual(3);
    // on the phone's map a name that needs it takes three lines instead of an ellipsis touch cannot expand
    const labels = await page.locator('[data-testid="flow-diagram"] [data-label^="label:"]').evaluateAll((els) => els.map((e) => e.querySelectorAll('.mr-flow-text--name').length));
    expect(Math.max(...labels)).toBeLessThanOrEqual(3);
    expect(errors()).toEqual([]);
    if (shootsGrid(info)) {
      // back to the list (the tour lives in the tab: no reload), then a tap in each theme, shot as the card answers
      await page.getByTestId('flow-view-toggle').getByRole('button').click();
      for (const [i, theme] of (['light', 'dark'] as const).entries()) {
        await setTheme(page, theme);
        await rows.nth(3 + i).scrollIntoViewIfNeeded();
        await rows.nth(3 + i).click();
        await page.waitForTimeout(350);
        await page.screenshot({ path: `tests/report/screens/wave2-i-I05-list-tap-${theme}-390.png` });
      }
      await setTheme(page, 'light');
    }
  });

  test('Tab goes on from the nodes to each ribbon, and the receipt card follows it', async ({ page }, info) => {
    await openPriced(page, '/flow');
    const diagram = page.getByTestId('flow-diagram');
    const nodes = diagram.locator('[data-node]');
    await nodes.last().focus();
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() => document.activeElement?.getAttribute('data-ribbon-key') ?? null);
    expect(first, 'the first Tab after the last node lands on a ribbon').not.toBeNull();
    const card = page.getByTestId('flow-receipt');
    // the card follows: the ribbon's source is its heading (the rig's top ribbon is the Windows DC stream)
    await expect(card.getByRole('heading')).toHaveText(/Windows DC security events/);
    const aria = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
    expect(aria).toMatch(/^Flow from Windows DC security events through Windows XML pack to SIEM \(prod\)\. \$[\d,]+ would have paid, \$[\d,]+ saved per day\./);
    // a visible focus ring: the key's outline is stroked while focused
    const stroke = await page.evaluate(() => getComputedStyle(document.activeElement as Element).stroke);
    expect(stroke).not.toBe('none');
    await page.keyboard.press('Tab');
    const second = await page.evaluate(() => document.activeElement?.getAttribute('data-ribbon-key') ?? null);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    await expect(card.getByRole('heading')).not.toHaveText(/Windows DC security events/);
    // Enter pins it, Escape releases
    await page.keyboard.press('Enter');
    await expect(card).toContainText('Pinned');
    await page.keyboard.press('Escape');
    await expect(card).not.toContainText('Pinned');
    if (shootsGrid(info)) {
      await page.keyboard.press('Shift+Tab');
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.waitForTimeout(250);
        await page.screenshot({ path: `tests/report/screens/wave2-i-I05-ribbon-focus-${theme}-1440.png` });
      }
      await setTheme(page, 'light');
    }
  });
});

test.describe('Flow uses the stage, and every state keeps its frame (P1-I07)', () => {
  test('at 1920 the map card takes at least 70 % of the viewport height and still ends above the fold', async ({ page }, info) => {
    await page.setViewportSize(VIEWPORT[1920]);
    await openPriced(page, '/flow');
    const card = (await page.locator('.mr-flowmap-diagram').boundingBox())!;
    test.info().annotations.push({ type: 'measured', description: `map card ${Math.round(card.width)}×${Math.round(card.height)} at 1920×1080` });
    expect(card.height / 1080, 'map card share of the viewport height').toBeGreaterThanOrEqual(0.7);
    expect(card.y + card.height).toBeLessThanOrEqual(1080);
    // the page frame is 1600 wide on a projector, not 1280 beside 640 px of empty canvas
    expect((await page.locator('.mr-flowview').boundingBox())!.width).toBeGreaterThan(1500);
    await evidence(page, 'I07-stage', info, { widths: [1920, 1440] });
  });

  const expectFramed = async (page: Page, state: string) => {
    const frame = page.locator(`[data-state="${state}"].mr-flowview-state`);
    await expect(frame).toBeVisible({ timeout: 30_000 });
    // the two cards of the map, the grey Sankey in the first
    await expect(frame.locator('.mr-flowmap-diagram [data-ghost="flow-map"]')).toHaveCount(1);
    await expect(frame.locator('.mr-flowmap-card')).toHaveCount(1);
    const map = (await frame.locator('.mr-flowmap-diagram').boundingBox())!;
    expect(map.height).toBeGreaterThanOrEqual(400);
    return frame;
  };

  test('a 500 and a 429 sit over the map’s own frame, the 429 counting down to the next read', async ({ page }, info) => {
    const errors = trackConsoleErrors(page, [/Failed to load resource: .*\b(500|429)\b/, /sweep failed/]);
    await gotoApp(page, '/flow');
    await seedPrices(page);
    await mockControl(page, { action: 'fault', method: 'GET', path: '/kvstore/snapshot', status: 500, times: -1 });
    await page.goto('/flow', { waitUntil: 'domcontentloaded' });
    const frame = await expectFramed(page, 'error');
    await expect(frame.locator('[data-state="server-error"]')).toBeVisible();
    await evidence(page, 'I07-error500', info, { list: true });
    await mockControl(page, { action: 'clearFaults' });

    await mockControl(page, { action: 'fault', method: 'GET', path: '/kvstore/snapshot', status: 429, times: -1 });
    await page.goto('/flow', { waitUntil: 'domcontentloaded' });
    const limited = await expectFramed(page, 'error');
    await expect(limited.locator('[data-state="rate-limited"]')).toBeVisible();
    await expect(limited.locator('[data-state="rate-limited"]')).toContainText(/\d+:\d{2}/, { timeout: 20_000 });
    await evidence(page, 'I07-ratelimit429', info, { list: true });
    await mockControl(page, { action: 'clearFaults' });
    expect(errors()).toEqual([]);
  });

  test('nothing priced: the empty state sits over the map’s own frame, not a table ghost', async ({ page }, info) => {
    await gotoApp(page, '/flow');
    const frame = await expectFramed(page, 'unpriced');
    await expect(frame).toHaveAttribute('data-testid', 'flow-empty-unpriced');
    await expect(frame.locator('[data-empty="rows"]')).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'Set prices' })).toBeVisible();
    await evidence(page, 'I07-unpriced', info, { list: true });
  });
});

/** Band width strictly increasing in `field` ('whp' dollars or 'in' bytes), read once no ease is running. */
async function expectMonotonicIn(page: Page, field: 'whp' | 'in'): Promise<void> {
  await expect(page.getByTestId('flow-diagram')).not.toHaveAttribute('data-tween', /./);
  const ribbons = await page.locator('[data-testid="flow-diagram"] [data-ribbon]').evaluateAll(
    (els, f) => els.map((g) => ({ id: g.getAttribute('data-ribbon') ?? '', v: Number(g.getAttribute(`data-${f}`)), w: Number(g.getAttribute('data-band-w')) })),
    field,
  );
  expect(ribbons.length).toBeGreaterThan(1);
  const sorted = [...ribbons].sort((a, b) => a.v - b.v);
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = [sorted[i - 1], sorted[i]];
    // (data-band-w is rounded to 0.01 px: two streams within 2 % of each other may draw the same width)
    if (b.v > a.v * 1.02) expect(b.w, `${field}: ${b.id} is wider than ${a.id}`).toBeGreaterThan(a.w);
    else expect(b.w, `${field}: ${b.id} is at least as wide as ${a.id}`).toBeGreaterThanOrEqual(a.w - 0.01);
  }
}

/** Records the map's eases (data-tween on the SVG) from now on. */
async function recordTweens(page: Page): Promise<() => Promise<{ t: number; kind: string | null }[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __mrTweens: { t: number; kind: string | null }[] };
    w.__mrTweens = [];
    const svg = document.querySelector('[data-testid="flow-diagram"]')!;
    new MutationObserver(() => w.__mrTweens.push({ t: performance.now(), kind: svg.getAttribute('data-tween') })).observe(svg, { attributes: true, attributeFilter: ['data-tween'] });
  });
  return () => page.evaluate(() => (window as unknown as { __mrTweens: { t: number; kind: string | null }[] }).__mrTweens);
}

test.describe('Width: dollars | bytes (P2-W02)', () => {
  test('the toggle morphs the dollar map into the Insights byte map in one ~400 ms ease, and back', async ({ page, browserName }, info) => {
    const errors = trackConsoleErrors(page);
    // the tour on Chromium; the rig elsewhere (on the dev server, Firefox and WebKit lose the tour's lazy chunks to
    // the idle preloads its navigation aborts — the pre-existing tour tests fail there the same way)
    const tour = browserName === 'chromium';
    if (tour) await openTourFlow(page);
    else await openPriced(page, '/flow');
    const diagram = page.getByTestId('flow-diagram');
    const group = page.getByRole('radiogroup', { name: 'What band width measures' });
    await expect(group.getByRole('radio', { name: 'Dollars' })).toBeChecked();
    await expect(diagram).toHaveAttribute('data-weight-by', 'dollars');
    await expectMonotonicIn(page, 'whp');
    const before = await diagram.locator('[data-node^="in:"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-node')));
    const tweens = await recordTweens(page);

    await group.getByRole('radio', { name: 'Bytes' }).click();
    await expect(page).toHaveURL(/[?&]weight=bytes/);
    await expect(diagram).toHaveAttribute('data-weight-by', 'bytes');
    await expect(page.getByTestId('flow-subtitle')).toHaveText('Bytes, the way Cribl Insights draws it. Switch to dollars.');
    await page.waitForTimeout(800);
    await expectMonotonicIn(page, 'in');
    // one ease, the What-if's 400 ms morph: it starts, runs, ends — no live or re-fit ease rides on it
    const marks = await tweens();
    const kinds = marks.map((m) => m.kind);
    expect(kinds[0]).toBe('morph');
    const end = marks.find((m) => m.kind === null)!;
    const ms = end.t - marks[0].t;
    test.info().annotations.push({ type: 'measured', description: `bytes morph ${Math.round(ms)} ms` });
    expect(ms).toBeGreaterThanOrEqual(300);
    expect(ms).toBeLessThan(700);
    expect(kinds.filter((k) => k === 'live' || k === 'refit')).toHaveLength(0);
    // the rows stay put: the same sources in the same order, only widths move
    expect(await diagram.locator('[data-node^="in:"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-node')))).toEqual(before);
    // the plates speak bytes, and the long tail (small in dollars, not in bytes) is named for what it is
    await expect(diagram.locator('[data-label^="whp:"] text').first()).toHaveText(/^[\d.]+ [KMGTP]?B \/ day$/);
    if (tour && !isPhone(page)) await expect(diagram.locator('[data-label^="label:in:"][data-label$=":~other"]')).toHaveAttribute('data-full', /^\d+ low-cost flows/);
    await expect(page.locator('.mr-flowmap-legend')).toContainText(/Width is bytes a day/);
    // every source and destination keeps its name on the byte map too, though the long tail squeezes the column
    if (!isPhone(page)) {
      const ends = await diagram.locator('[data-node^="in:"], [data-node^="out:"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-node')));
      for (const id of ends) await expect(diagram.locator(`[data-label="label:${id}"]`), `${id} has a label`).toHaveCount(1);
    }
    await evidence(page, 'W02-bytes', info, { widths: [1440, 1920, 390] });

    await group.getByRole('radio', { name: 'Dollars' }).click();
    await expect(page).not.toHaveURL(/weight=/);
    await expect(diagram).toHaveAttribute('data-weight-by', 'dollars');
    await page.waitForTimeout(800);
    await expectMonotonicIn(page, 'whp');
    await evidence(page, 'W02-dollars', info, { widths: [1440, 390] });
    expect(errors()).toEqual([]);
  });

  test('?weight=bytes survives a reload; the What-if keeps dollars and hides the toggle', async ({ page }) => {
    await openPriced(page, '/flow?weight=bytes');
    const diagram = page.getByTestId('flow-diagram');
    await expect(diagram).toHaveAttribute('data-weight-by', 'bytes');
    await page.reload();
    await showMapOnPhone(page);
    await expect(page.getByTestId('flow-diagram')).toHaveAttribute('data-weight-by', 'bytes', { timeout: 30_000 });
    await expect(page.getByRole('radiogroup', { name: 'What band width measures' }).getByRole('radio', { name: 'Bytes' })).toBeChecked();
    // the byte map: the 60 GB/day S3 archive is as wide as its bytes, no longer the thinnest thread
    await expectMonotonicIn(page, 'in');
    await page.getByTestId('flow-whatif-toggle').getByRole('button').click();
    await expect(page.getByTestId('projection-chip')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('flow-diagram')).toHaveAttribute('data-weight-by', 'dollars');
    await expect(page.getByTestId('flow-weight-toggle')).toHaveCount(0);
  });
});

test.describe('Flow on stage (P2-W10)', () => {
  /** Opens the stage from the Flow view's Present button and waits for the map inside it. */
  async function openStage(page: Page): Promise<void> {
    await page.getByTestId('flow-stage-enter').getByRole('button').click();
    await expect(page).toHaveURL(/[?&]stage=1/);
    await expect(page.getByTestId('flow-stage').getByTestId('flow-diagram')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(700);
  }

  test('at 1920 the map fills the stage (≥ 70 % of the viewport), every label ≥ 24 px, no tabs or title; P returns to the Flow', async ({ page, browserName }, info) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize(VIEWPORT[1920]);
    // the tour on Chromium, the rig elsewhere (see the width test)
    if (browserName === 'chromium') await openTourFlow(page, { map: false });
    else await openPriced(page, '/flow');
    await openStage(page);
    const stage = page.getByTestId('flow-stage');
    const svg = stage.getByTestId('flow-diagram');
    const box = (await svg.boundingBox())!;
    const share = (box.width * box.height) / (1920 * 1080);
    test.info().annotations.push({ type: 'measured', description: `stage SVG ${Math.round(box.width)}×${Math.round(box.height)} = ${Math.round(share * 100)} % of 1920×1080` });
    expect(share, 'the SVG box share of the viewport').toBeGreaterThanOrEqual(0.7);
    // nothing within 40 px of an edge
    expect(box.x).toBeGreaterThanOrEqual(40);
    expect(box.y).toBeGreaterThanOrEqual(40);
    expect(box.y + box.height).toBeLessThanOrEqual(1080 - 40 + 0.5);
    // every label — names, captions and plates — reads from the back of the room
    const sizes = await svg.locator('.mr-flow-text').evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
    expect(sizes.length).toBeGreaterThan(10);
    expect(Math.min(...sizes), 'smallest label on stage').toBeGreaterThanOrEqual(24);
    // no tabs, no title: the app beneath is inert and covered
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
    await expect(page.locator('#root')).toHaveAttribute('inert', '');
    const covered = await page.evaluate(() => {
      const header = document.querySelector('.mr-shell-header')!.getBoundingClientRect();
      const hit = document.elementFromPoint(header.left + header.width / 2, header.top + Math.min(20, header.height / 2));
      return hit?.closest('[data-testid="flow-stage"]') !== null;
    });
    expect(covered, 'the tab bar is under the stage').toBe(true);
    // the receipt is a strip on the right, with the width toggle and the pitch line
    const strip = stage.getByTestId('flow-stage-strip');
    await expect(strip.getByTestId('flow-receipt')).toBeVisible();
    await expect(strip.getByTestId('flow-weight-toggle')).toBeVisible();
    await expect(strip.getByTestId('flow-subtitle')).toHaveText('Cribl Insights shows this map in bytes. This is dollars.');
    expect((await strip.boundingBox())!.x).toBeGreaterThan(box.x + box.width);
    // the cursor tip: the hovered flow's three numbers beside the pointer
    const ribbon = svg.locator('[data-ribbon]:not(.is-other)').first();
    await ribbon.locator('path').first().hover({ force: true });
    const tip = page.getByTestId('flow-stage-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Would have paid');
    await expect(tip).toContainText('Paid');
    await expect(tip).toContainText('Saved');
    await evidence(page, 'W10-stage-hover', info, { widths: [1920], fullPage: false });

    // P comes back to the Flow view (not the presenter's stage), focus on the button that opened it
    await page.mouse.move(1, 1);
    await page.keyboard.press('p');
    await expect(page).not.toHaveURL(/stage=1/);
    await expect(page).not.toHaveURL(/present=1/);
    await expect(page.getByRole('heading', { level: 1, name: 'Flow' })).toBeVisible();
    await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
    await expect(page.getByTestId('flow-stage-enter').getByRole('button')).toBeFocused();
    // F opens it again; Escape leaves
    await page.keyboard.press('f');
    await expect(page.getByTestId('flow-stage')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('flow-stage')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('a deep link ?stage=1 opens the stage; the width toggle morphs it there; 1280×720 scales the labels to 18 px', async ({ page }, info) => {
    await page.setViewportSize(VIEWPORT[1920]);
    await openPriced(page, '/flow?stage=1');
    const stage = page.getByTestId('flow-stage');
    await expect(stage.getByTestId('flow-diagram')).toBeVisible({ timeout: 30_000 });
    await expect(stage.getByTestId('flow-diagram')).toHaveAttribute('data-scale', '2');
    await stage.getByRole('radiogroup', { name: 'What band width measures' }).getByRole('radio', { name: 'Bytes' }).click();
    await expect(stage.getByTestId('flow-diagram')).toHaveAttribute('data-weight-by', 'bytes');
    await expect(page).toHaveURL(/stage=1/);
    await page.waitForTimeout(700);
    await evidence(page, 'W10-stage-bytes', info, { widths: [1920, 1280], fullPage: false });
    await stage.getByRole('radio', { name: 'Dollars' }).click();
    await page.setViewportSize(VIEWPORT[1280]);
    await page.waitForTimeout(700);
    await expect(stage.getByTestId('flow-diagram')).toHaveAttribute('data-scale', '1.25'.replace('1.25', '1.5'));
    const min = await stage.locator('.mr-flow-text').evaluateAll((els) => Math.min(...els.map((e) => parseFloat(getComputedStyle(e).fontSize))));
    expect(min).toBeGreaterThanOrEqual(18);
    await evidence(page, 'W10-stage', info, { widths: [1920, 1280, 1440], fullPage: false });
  });
});

test.describe('Savings as a place, incidents on the map, destinations that filter (P2-W16)', () => {
  test('the tour pools every saved wedge in a "Removed by Cribl" sink as tall as the wedges', async ({ page, browserName }, info) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize(VIEWPORT[1440]);
    if (browserName === 'chromium') await openTourFlow(page);
    else await openPriced(page, '/flow');
    const diagram = page.getByTestId('flow-diagram');
    const sink = diagram.locator('[data-node$=":~removed"]');
    await expect(sink).toHaveCount(1);
    // read one settled frame (no ease running), the bar and its wedges together
    await expect(diagram).not.toHaveAttribute('data-tween', /./);
    const { barH, wedges } = await diagram.evaluate((svg) => ({
      barH: Number(svg.querySelector('[data-node$=":~removed"] .mr-flow-node-bar')!.getAttribute('height')),
      wedges: [...svg.querySelectorAll('[data-ribbon][data-sink="1"]')].map((e) => Number(e.getAttribute('data-wedge-w'))),
    }));
    expect(wedges.length).toBeGreaterThan(1);
    const sum = wedges.reduce((a, b) => a + b, 0);
    test.info().annotations.push({ type: 'measured', description: `sink ${barH.toFixed(1)} px = Σ ${wedges.length} wedges ${sum.toFixed(1)} px` });
    expect(Math.abs(barH - sum), 'the sink is exactly the wedges it pools').toBeLessThanOrEqual(0.05 * wedges.length + 0.5);
    // it is labelled with what it holds, and hovering it lights every saving path
    await expect(diagram.locator('[data-label$=":~removed"]')).toHaveAttribute('data-full', /^Removed by Cribl · \$[\d,]+ \/ day$/);
    await sink.locator('.mr-flow-node-hit').hover({ force: true });
    await expect(page.getByTestId('flow-receipt').getByRole('heading')).toHaveText('Removed by Cribl');
    const lit = await diagram.locator('[data-ribbon].is-active').evaluateAll((els) => els.map((e) => e.getAttribute('data-sink')));
    expect(lit.length).toBe(wedges.length);
    expect(lit.every((x) => x === '1')).toBe(true);
    await page.mouse.move(1, 1);
    await evidence(page, 'W16-sink', info, { widths: [1440, 1920] });
    expect(errors()).toEqual([]);
  });

  test('an open alert outlines its ribbon, dashed, with a plate; ?object= opens its receipt card', async ({ page }, info) => {
    test.setTimeout(120_000);
    const fixture = loadDemoFixture();
    const open = fixture.snapshot.incidents.find((i) => !i.closedAt && i.type === 'regression');
    expect(open, 'the fixture has an open regression').toBeDefined();
    await gotoApp(page, '/flow');
    await injectLedgerDocs(page, fixture);
    await page.goto(`/flow?object=${encodeURIComponent(open!.objectKey)}`, { waitUntil: 'domcontentloaded' });
    await waitForMock(page);
    await waitForHydration(page);
    await showMapOnPhone(page);
    const diagram = page.getByTestId('flow-diagram');
    const marked = diagram.locator('[data-ribbon].is-incident');
    await expect(marked.first()).toBeVisible({ timeout: 30_000 });
    await expect(marked.first()).toHaveAttribute('data-incident', 'high');
    const dash = await marked.first().locator('.mr-flow-incident').first().evaluate((el) => getComputedStyle(el).strokeDasharray);
    expect(dash).not.toBe('none');
    const id = await marked.first().getAttribute('data-ribbon');
    const plate = diagram.locator(`[data-label="incident:${id}"]`);
    await expect(plate).toHaveCount(1);
    // what it costs and the commit that did it; since when too, where the plate has the room
    await expect(plate.locator('text')).toHaveText(new RegExp(`^−\\$[\\d,]+ / day( since .+)?( · ${open!.commit!.hash.slice(0, 7)})?$`));
    await expect(plate).toHaveAttribute('data-full', new RegExp(`^−\\$[\\d,]+ / day since .+ · ${open!.commit!.hash.slice(0, 7)}$`));
    // craft review, round 1: the flag keeps a visible gap from every node name, and a name over a band sits on a pill
    if (!isPhone(page)) {
      const gaps = await diagram.evaluate((svg, flagId) => {
        const box = (el: Element) => (el as SVGGraphicsElement).getBBox();
        const flag = box(svg.querySelector(`[data-label="incident:${flagId}"] rect.mr-flow-plate`)!);
        return [...svg.querySelectorAll('[data-label^="label:"]')].map((g) => {
          const b = box(g);
          return { id: g.getAttribute('data-label'), gap: Math.max(b.x - (flag.x + flag.width), flag.x - (b.x + b.width), b.y - (flag.y + flag.height), flag.y - (b.y + b.height)) };
        });
      }, id);
      for (const g of gaps) expect(g.gap, `the flag is clear of ${g.id}`).toBeGreaterThanOrEqual(6);
      const haloed = diagram.locator('.mr-flow-label.has-halo');
      await expect(diagram.locator('.mr-flow-label.has-halo .mr-flow-pill')).toHaveCount(await haloed.count());
    }
    // ?object= pinned the object the alert names: the card is on it
    await expect(page.getByTestId('flow-receipt')).toContainText('Pinned');
    // (a route's alert pins its flow: the card is headed by the flow's source, which the alert's label names)
    const heading = (await page.getByTestId('flow-receipt').getByRole('heading').textContent()) ?? '';
    expect(heading.length).toBeGreaterThan(0);
    expect(open!.label).toContain(heading);
    await evidence(page, 'W16-incident', info, { widths: [1440, 390] });
  });

  test('on a phone the list keeps the alert: the row is outlined in its tone and says what it costs since which commit (craft r2)', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = trackConsoleErrors(page);
    const fixture = loadDemoFixture();
    const open = fixture.snapshot.incidents.find((i) => !i.closedAt && i.type === 'regression');
    expect(open, 'the fixture has an open regression').toBeDefined();
    await page.setViewportSize(VIEWPORT[390]);
    await gotoApp(page, '/flow');
    await injectLedgerDocs(page, fixture);
    await page.goto('/flow', { waitUntil: 'domcontentloaded' });
    await waitForMock(page);
    await waitForHydration(page);
    const list = page.getByTestId('flow-list');
    await expect(list).toBeVisible({ timeout: 30_000 });
    const marked = list.locator('button.is-incident');
    await expect(marked.first()).toBeVisible();
    await expect(marked.first()).toHaveAttribute('data-incident', open!.severity === 'high' ? 'high' : 'medium');
    const style = await marked.first().evaluate((el) => getComputedStyle(el).borderTopStyle);
    expect(style).toBe('dashed');
    await expect(marked.first().getByTestId('flow-list-incident')).toHaveText(new RegExp(`^−\\$[\\d,]+ / day since .+ · ${open!.commit!.hash.slice(0, 7)}$`));
    expect(errors()).toEqual([]);
  });

  test('a destination chip isolates its paths: every other ribbon dims; a second press releases', async ({ page }, info) => {
    await openPriced(page, '/flow');
    if (isPhone(page)) return; // the phone's map is one tap away and keeps the short legend
    const chips = page.getByTestId('flow-dest-chips');
    const siem = chips.locator('[data-dest-chip="out:default:mrd_siem_prod"]');
    await expect(siem).toContainText(/^SIEM \(prod\)\$[\d,]+ \/ day · \$2\.50? \/ GB$/);
    // the rate as Prices prints it (mcToDollarInput: the seeded 3,000 mc is $0.03, a 2,300 mc preset reads $0.023)
    await expect(chips.locator('[data-dest-chip="out:default:mrd_archive_s3"]')).toContainText(/ · \$0\.03 \/ GB$/);
    await siem.click();
    await expect(siem).toHaveAttribute('aria-pressed', 'true');
    const diagram = page.getByTestId('flow-diagram');
    const all = await diagram.locator('[data-ribbon]').count();
    const into = await diagram.locator('[data-ribbon$="|mrd_siem_prod"]').count();
    await expect(diagram.locator('[data-ribbon].is-dim')).toHaveCount(all - into);
    await expect(diagram.locator('[data-ribbon$="|mrd_siem_prod"].is-dim')).toHaveCount(0);
    await expect(page.getByTestId('flow-receipt').getByRole('heading')).toHaveText('SIEM (prod)');
    await evidence(page, 'W16-chip', info, { widths: [1440] });
    await siem.click();
    await expect(siem).toHaveAttribute('aria-pressed', 'false');
    await expect(diagram.locator('[data-ribbon].is-dim')).toHaveCount(0);
  });
});

// OQ-09: a priced workspace whose snapshot holds no destinations yet (the runner's first sweep has not written
// one) has no traffic; it is not unpriced, so the map never asks for prices it already has.
test.describe('OQ-09: no destinations yet reads as no traffic, not as unpriced', () => {
  test('the warm workspace before its first sweep shows the no-traffic state on Flow and What if', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await warmWorkspace(page, { lastOwner: 'runner' });
    for (const path of ['/flow', '/whatif']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await waitForHydration(page);
      await expect(page.locator('[data-state="no-traffic"]')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('flow-empty-unpriced')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Set prices' })).toHaveCount(0);
    }
    expect(errors()).toEqual([]);
  });
});
