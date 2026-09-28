// tests/e2e/wave3-flow.spec.ts — wave 3, the Flow map's plates and pipeline names (W3-FLOW-1…4).
//
// W3-FLOW-1: on stage (P2-W10) every "$ saved" plate touches its own saved wedge or a leader joins them; no plate sits
// on another route's incident mark (its dashed outline or its plate); every pipeline whose flow carries a plate keeps
// its name (a plate is dropped before a name, never the reverse). The rich mock (the Ledger fixture: an open incident)
// and the sample tour, at 1920, 1440 and 1280×720, both themes.
// W3-FLOW-2 (OQ-08): on a long-name workspace every pipeline label is one line, truncated in the middle, with its
// whole name in the <title>, and no pipeline label covers a plate; the tour labels at least as many pipelines as before.
// W3-FLOW-3: on the crowded desk map (the tour) a plate stays in its pipeline's row, or a leader joins it to its wedge.
// W3-FLOW-4: on stage with a path pinned, the first Escape releases the pin; the second leaves the stage.
//
// Evidence: tests/report/screens/wave3-flow-*.png (chromium project only).

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { defaultSettings } from '../../core/settings.ts';
import { DEMO_LABELS } from '../../core/humanize.ts';
import { RIG_PRICES, expectPath, gotoApp, mockControl, resetMock, seedPrices, setTheme, trackConsoleErrors, waitForHydration, waitForMock } from './helpers/index.ts';
import { injectLedgerDocs, loadDemoFixture } from './ledger-fixture.ts';

const TZ = 'America/Chicago';
const SIZE = {
  390: { width: 390, height: 844 },
  1280: { width: 1280, height: 720 },
  1440: { width: 1440, height: 900 },
  1920: { width: 1920, height: 1080 },
} as const;
type Width = keyof typeof SIZE;
const tag = (w: Width): string => (w === 1280 ? '1280x720' : String(w));
const shoots = (info: TestInfo): boolean => info.project.name === 'chromium';

/** The tour's desk map at 1440 labelled this many pipelines before wave 3 (11 of 11, measured on dev 0e1251f; W3-FLOW-2: no regression). */
const TOUR_PIPE_LABELS_1440 = 11;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Geometry {
  plates: { id: string; pipe: string; box: Box; onWedge: boolean; leader: boolean; leaderJoins: boolean; overIncident: string[]; inBand: string | null; text: string }[];
  pipes: { id: string; y0: number; y1: number; named: boolean }[];
  pipeLabels: { owner: string; box: Box; texts: number; title: string | null; lineBox: number }[];
  plateBoxes: { id: string; box: Box }[];
}

/** Reads the drawn map's plates, pipelines and pipeline labels (SVG user units). */
function readGeometry(page: Page, onStage: boolean): Promise<Geometry> {
  return page.evaluate((stage) => {
    const svg = document.querySelector(stage ? '[data-testid="flow-stage"] [data-testid="flow-diagram"]' : '[data-testid="flow-diagram"]') as SVGSVGElement;
    const num = (el: Element, a: string): number => Number(el.getAttribute(a));
    const rectBox = (r: Element): Box => ({ x: num(r, 'x'), y: num(r, 'y'), w: num(r, 'width'), h: num(r, 'height') });
    const inFill = (paths: SVGGeometryElement[], box: Box, nx = 24, ny = 10): boolean => {
      for (let i = 0; i <= nx; i++)
        for (let j = 0; j <= ny; j++) {
          const pt = new DOMPoint(box.x + (box.w * i) / nx, box.y + (box.h * j) / ny);
          if (paths.some((p) => p.isPointInFill(pt) || p.isPointInStroke(pt))) return true;
        }
      return false;
    };
    const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const ribbons = [...svg.querySelectorAll('[data-ribbon]')];
    const plateBoxes = [...svg.querySelectorAll('[data-label]')]
      .filter((g) => g.querySelector('rect.mr-flow-plate'))
      .map((g) => ({ id: g.getAttribute('data-label')!, box: rectBox(g.querySelector('rect.mr-flow-plate')!) }));
    const plates = [...svg.querySelectorAll('[data-label^="saved:"]')].map((g) => {
      const box = rectBox(g.querySelector('rect.mr-flow-plate')!);
      const id = g.getAttribute('data-label')!.slice('saved:'.length);
      const own = ribbons.find((r) => r.getAttribute('data-ribbon') === id)!;
      const wedge = [...own.querySelectorAll('.mr-flow-wedge')] as SVGGeometryElement[];
      const line = g.querySelector('.mr-flow-leader');
      let leaderJoins = false;
      if (line) {
        const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((a) => num(line, a));
        const end = new DOMPoint(x2, y2);
        const touchesWedge = wedge.some((p) => p.isPointInFill(end) || p.isPointInStroke(end));
        const touchesPlate = x1 >= box.x - 1 && x1 <= box.x + box.w + 1 && y1 >= box.y - 1 && y1 <= box.y + box.h + 1;
        leaderJoins = touchesWedge && touchesPlate;
      }
      const overIncident: string[] = [];
      for (const r of ribbons) {
        if (r === own || !r.getAttribute('data-incident')) continue;
        const marks = [...r.querySelectorAll('.mr-flow-incident')] as SVGGeometryElement[];
        if (inFill(marks, box)) overIncident.push(`outline of ${r.getAttribute('data-ribbon')}`);
      }
      for (const p of plateBoxes) if (p.id.startsWith('incident:') && p.id.slice('incident:'.length) !== id && overlap(p.box, box)) overIncident.push(p.id);
      return { id, pipe: own.getAttribute('data-pipe') ?? '', box, onWedge: inFill(wedge, box), leader: line !== null, leaderJoins, overIncident, inBand: g.getAttribute('data-in-band'), text: g.textContent ?? '' };
    });
    const pipes = [...svg.querySelectorAll('[data-node^="pipe:"]')].map((n) => {
      const bar = n.querySelector('.mr-flow-node-bar')!;
      const id = n.getAttribute('data-node')!;
      return { id, y0: num(bar, 'y'), y1: num(bar, 'y') + num(bar, 'height'), named: svg.querySelector(`[data-label="label:${CSS.escape(id)}"]`) !== null };
    });
    const pipeLabels = [...svg.querySelectorAll('[data-label^="label:pipe:"]')].map((g) => {
      const texts = [...g.querySelectorAll('text')];
      const bb = (g as SVGGElement).getBBox();
      const px = texts.length > 0 ? parseFloat(getComputedStyle(texts[0]).fontSize) : 14;
      return {
        owner: g.getAttribute('data-label')!.slice('label:'.length),
        box: { x: bb.x, y: bb.y, w: bb.width, h: bb.height },
        texts: texts.length,
        title: g.querySelector('title')?.textContent ?? null,
        // one line box at the label's own size (19 px at 14 px, scaled with it), in SVG units
        lineBox: (19 / 14) * px,
      };
    });
    return { plates, pipes, pipeLabels, plateBoxes };
  }, onStage);
}

/** W3-FLOW-1: every plate on its wedge or leader-joined; never on another route's incident; its pipeline named. */
function expectPlatesBelong(geo: Geometry, where: string): void {
  expect(geo.plates.length, `${where}: saved plates drawn`).toBeGreaterThan(0);
  for (const p of geo.plates) {
    expect(p.onWedge || (p.leader && p.leaderJoins), `${where} ${p.id} (${p.text}, in band ${p.inBand}, leader ${p.leader}, box ${JSON.stringify(p.box)}): on its own wedge, or a leader joins them`).toBe(true);
    expect(p.overIncident, `${where} ${p.id}: over another route's incident mark`).toEqual([]);
    const pipe = geo.pipes.find((n) => n.id === p.pipe);
    expect(pipe, `${where} ${p.id}: its pipeline node`).toBeDefined();
    expect(pipe!.named, `${where} ${p.id}: its pipeline ${p.pipe} keeps its name`).toBe(true);
  }
}

/** W3-FLOW-3: a plate's centre lies in its pipeline's row (±half a plate), or a leader joins it to its wedge. */
function expectPlatesInRow(geo: Geometry, where: string): void {
  for (const p of geo.plates) {
    if (p.leader && p.leaderJoins) continue;
    const pipe = geo.pipes.find((n) => n.id === p.pipe)!;
    const cy = p.box.y + p.box.h / 2;
    expect(cy, `${where} ${p.id} (${p.text}, in band ${p.inBand}, leader ${p.leader}): centre below its row ${pipe.id} ${pipe.y0}–${pipe.y1}`).toBeLessThanOrEqual(pipe.y1 + p.box.h / 2 + 0.5);
    expect(cy, `${where} ${p.id}: centre above its row ${pipe.id}`).toBeGreaterThanOrEqual(pipe.y0 - p.box.h / 2 - 0.5);
  }
}

/** W3-FLOW-2: one line, the whole name in the <title>, never over a plate. */
function expectPipeLabelsClean(geo: Geometry, where: string, names?: Map<string, string>): void {
  const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const l of geo.pipeLabels) {
    expect(l.texts, `${where} ${l.owner}: one line`).toBe(1);
    // The box now includes the name's pill (d1d29cd), drawn at the label's laid-out height: Firefox reports that rect a
    // few millionths of a pixel over (20.0000019 against 20), so the bound allows float noise, not a second line.
    expect(l.box.h, `${where} ${l.owner}: one line box tall`).toBeLessThanOrEqual(l.lineBox + 1 + 0.01);
    expect(l.title, `${where} ${l.owner}: its whole name in the <title>`).toBeTruthy();
    const full = names?.get(l.owner.split(':').pop()!);
    if (full) expect(l.title).toBe(full);
    for (const p of geo.plateBoxes) expect(overlap(l.box, p.box), `${where} ${l.owner} over ${p.id}`).toBe(false);
  }
}

async function shot(page: Page, info: TestInfo, name: string, theme: string, w: Width, fullPage = false): Promise<void> {
  if (!shoots(info)) return;
  await page.screenshot({ path: `tests/report/screens/wave3-flow-${name}-${theme}-${tag(w)}.png`, fullPage });
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(700);
}

/** The Ledger fixture over 40 days of seeded rollups (an open regression on Payments API): the design review's "rich" mock. */
async function openRich(page: Page, path: string): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  const at = await page.evaluate(() => Date.now());
  await mockControl(page, { action: 'seedRollups', at, tz: TZ, prices: RIG_PRICES });
  await injectLedgerDocs(page, structuredClone(loadDemoFixture()));
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForMock(page);
  await waitForHydration(page);
}

async function openTour(page: Page): Promise<void> {
  await gotoApp(page, '/');
  await resetMock(page);
  await gotoApp(page, '/');
  await expectPath(page, '/first-run');
  await page.getByRole('button', { name: 'Tour with sample data' }).click();
  await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Flow', exact: true }).click();
  await expectPath(page, '/flow');
  await expect(page.getByTestId('flow-receipt')).toBeVisible({ timeout: 30_000 });
}

async function enterStage(page: Page): Promise<void> {
  await page.getByTestId('flow-stage-enter').getByRole('button').click();
  await expect(page.getByTestId('flow-stage').getByTestId('flow-diagram')).toBeVisible({ timeout: 30_000 });
}

test.describe('W3-FLOW-1: plates stay on their wedges on stage, and pipeline names survive', () => {
  test('the rich mock (an open incident) at 1920, 1440 and 1280×720, both themes', async ({ page }, info) => {
    test.setTimeout(180_000);
    const errors = trackConsoleErrors(page);
    await page.setViewportSize(SIZE[1920]);
    await openRich(page, '/flow?stage=1');
    await expect(page.getByTestId('flow-stage').getByTestId('flow-diagram')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="flow-stage"] [data-incident]').first()).toBeAttached({ timeout: 30_000 });
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      for (const w of [1920, 1440, 1280] as const) {
        await page.setViewportSize(SIZE[w]);
        await settle(page);
        const geo = await readGeometry(page, true);
        test.info().annotations.push({ type: 'rich', description: `${theme} ${tag(w)}: ${geo.plates.length} plates, ${geo.pipeLabels.length}/${geo.pipes.length} pipelines named` });
        expectPlatesBelong(geo, `rich ${theme} ${tag(w)}`);
        await shot(page, info, 'stage-rich', theme, w);
      }
    }
    expect(errors()).toEqual([]);
  });

  test('the sample tour at 1920, 1440 and 1280×720, both themes', async ({ page }, info) => {
    test.setTimeout(180_000);
    const errors = trackConsoleErrors(page);
    await page.setViewportSize(SIZE[1440]);
    await openTour(page);
    await enterStage(page);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      for (const w of [1920, 1440, 1280] as const) {
        await page.setViewportSize(SIZE[w]);
        await settle(page);
        const geo = await readGeometry(page, true);
        test.info().annotations.push({ type: 'tour', description: `${theme} ${tag(w)}: ${geo.plates.length} plates, ${geo.pipeLabels.length}/${geo.pipes.length} pipelines named` });
        expectPlatesBelong(geo, `tour stage ${theme} ${tag(w)}`);
        await shot(page, info, 'stage-tour', theme, w);
      }
    }
    expect(errors()).toEqual([]);
  });
});

test.describe('W3-FLOW-3: on the crowded desk map a plate stays near its pipeline row', () => {
  test('the tour at 1440 and 1920: in the row, or leader-joined to the wedge', async ({ page }, info) => {
    test.setTimeout(120_000);
    const errors = trackConsoleErrors(page);
    await page.setViewportSize(SIZE[1440]);
    await openTour(page);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      for (const w of [1440, 1920] as const) {
        await page.setViewportSize(SIZE[w]);
        await settle(page);
        const geo = await readGeometry(page, false);
        test.info().annotations.push({ type: 'desk', description: `${theme} ${w}: ${geo.plates.length} plates, ${geo.pipeLabels.length}/${geo.pipes.length} pipelines named` });
        expectPlatesBelong(geo, `tour desk ${theme} ${w}`);
        expectPlatesInRow(geo, `tour desk ${theme} ${w}`);
        expectPipeLabelsClean(geo, `tour desk ${theme} ${w}`);
        if (w === 1440) expect(geo.pipeLabels.length, 'pipelines labelled on the tour at 1440').toBeGreaterThanOrEqual(TOUR_PIPE_LABELS_1440);
        await shot(page, info, 'desk-tour', theme, w);
      }
    }
    expect(errors()).toEqual([]);
  });
});

test.describe('W3-FLOW-2: long pipeline names are one line, truncated in the middle, never over a plate (OQ-08)', () => {
  const ids = [...new Set([...Object.keys(DEMO_LABELS), 'devnull', 'default', 'mrd_api_access', 'mrd_k8s_container', 'mrd_pan_traffic', 'mrd_syslog_pre', 'mrd_vpc_flow_v2', 'mrd_windows_security_xml', 'mrd_siem_apps'])];
  const long = (i: number): string => `Extremely long destination or pipeline name number ${String(i).padStart(2, '0')} xyzw`.slice(0, 60);
  const humanize = Object.fromEntries(ids.map((id, i) => [id, long(i)]));

  test('the rig with 60-character names at 1440 and 390, both themes', async ({ page }, info) => {
    test.setTimeout(150_000);
    const errors = trackConsoleErrors(page);
    await page.setViewportSize(SIZE[1440]);
    await gotoApp(page, '/flow');
    await seedPrices(page);
    const settings = { ...defaultSettings(new Date().toISOString(), TZ), humanize };
    await page.evaluate(async (body) => {
      await fetch('/mock-api/v1/kvstore/settings', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body });
    }, JSON.stringify(settings));
    await gotoApp(page, '/flow');
    await expect(page.locator('[data-testid="flow-diagram"] [data-ribbon]').first()).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('[data-testid="flow-diagram"] [data-label^="label:pipe:"]').first()).toBeAttached();
    const names = new Map(Object.entries(humanize));
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      for (const w of [1440, 390] as const) {
        await page.setViewportSize(SIZE[w]);
        await page.waitForTimeout(450);
        if (w === 390) {
          const toggle = page.getByTestId('flow-view-toggle').getByRole('button');
          if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
          await expect(page.locator('[data-testid="flow-diagram"] [data-ribbon]').first()).toBeVisible();
        }
        await settle(page);
        const geo = await readGeometry(page, false);
        test.info().annotations.push({ type: 'long', description: `${theme} ${w}: ${geo.pipeLabels.length}/${geo.pipes.length} pipelines named` });
        expect(geo.pipeLabels.length, `${theme} ${w}: pipelines named`).toBeGreaterThan(0);
        expectPipeLabelsClean(geo, `long ${theme} ${w}`, names);
        await shot(page, info, 'longnames', theme, w, w === 390);
      }
    }
    expect(errors()).toEqual([]);
  });
});

test.describe('W3-FLOW-4: Escape on stage releases a pinned path first', () => {
  test('the first Escape unpins and the stage stays; the second leaves', async ({ page }) => {
    await page.setViewportSize(SIZE[1440]);
    await gotoApp(page, '/flow');
    await seedPrices(page);
    await gotoApp(page, '/flow?stage=1');
    const stage = page.getByTestId('flow-stage');
    await expect(stage.getByTestId('flow-diagram')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);
    const ribbon = stage.locator('[data-ribbon]').first();
    await ribbon.locator('path.mr-flow-band').first().click({ force: true });
    await page.mouse.move(1, 1);
    await expect(stage.locator('.mr-receipt-pinned')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(stage.locator('.mr-receipt-pinned')).toHaveCount(0);
    await expect(page.getByTestId('flow-stage')).toBeVisible();
    await expect(page).toHaveURL(/stage=1/);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('flow-stage')).toHaveCount(0);
    await expect(page).not.toHaveURL(/stage=1/);
  });
});
