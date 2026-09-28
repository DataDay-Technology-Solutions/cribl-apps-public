// tests/e2e/flowcolor.spec.ts — every Source wears its own hue on the Flow map (DECISIONS D55).
//
// The owner (9/27): "three of the top sources sharing the same blue color. This is a terrible look." Ribbons took their
// destination's colour, so Windows DC, Windows workstations and Palo Alto (all into SIEM (prod)) read as one slab. Then,
// on the first cut: "a calmer set built around Cribl teal and blue with one warm accent: no two sources alike, no source
// sharing its destination's colour." Now: the rig's five largest sources are five hue families (its $2 hairline the
// neutral tail, named in the note), each source's bands, node and phone-list bar share one colour, destinations are ink
// (node and chip), the saved hatch stays the one green, hover still isolates one path, and the What-if's projection
// and the byte map colour every source as the live map does. On the sample tour the top five are hues and the rest one
// quiet neutral, never a repeated hue.
//
// Evidence: tests/report/screens/flowcolor-*.png (chromium project only): the rig, the tour, the rich mock's open
// incident and the Story's dollar-map beat (the video's map), light and dark, at 1440, 1920 and 390 (the phone's list
// and its map).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { StoryDoc } from '../../core/types.ts';
import { beatStarts } from '../../src/story/timeline.ts';
import { RIG_PRICES, expectPath, gotoApp, mockControl, resetMock, seedPrices, setTheme, trackConsoleErrors, waitForHydration, waitForMock } from './helpers/index.ts';
import { injectLedgerDocs, loadDemoFixture } from './ledger-fixture.ts';

const SIZE = {
  390: { width: 390, height: 844 },
  1440: { width: 1440, height: 900 },
  1920: { width: 1920, height: 1080 },
} as const;
const THEMES = ['light', 'dark'] as const;
const shoots = (info: TestInfo): boolean => info.project.name === 'chromium';
const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1440) <= 640;

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  if (!shoots(info)) return;
  await page.screenshot({ path: `tests/report/screens/flowcolor-${name}.png`, fullPage: true });
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(700);
}

/** On a phone the map is a list; the diagram is one tap away ("Show map"). */
async function showMap(page: Page, on: boolean): Promise<void> {
  if (!isPhone(page)) return;
  const toggle = page.getByTestId('flow-view-toggle').getByRole('button');
  if (((await toggle.getAttribute('aria-pressed')) === 'true') !== on) await toggle.click();
}

async function openRig(page: Page, path = '/flow'): Promise<void> {
  await gotoApp(page, '/flow');
  await seedPrices(page);
  await gotoApp(page, path);
  await expect(page.getByTestId('flow-receipt')).toBeVisible({ timeout: 30_000 });
  await showMap(page, true);
  await expect(page.locator('[data-testid="flow-diagram"] [data-ribbon]').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(400);
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

/** The Ledger fixture over 40 days of seeded rollups: an open regression on Payments API. */
async function openRich(page: Page, path: string): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  const at = await page.evaluate(() => Date.now());
  await mockControl(page, { action: 'seedRollups', at, tz: 'America/Chicago', prices: RIG_PRICES });
  await injectLedgerDocs(page, structuredClone(loadDemoFixture()));
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForMock(page);
  await waitForHydration(page);
}

interface Paints {
  /** each named (unfolded) ribbon: its source id, hue slot (null = the tail) and band fill as drawn over the panel */
  bands: { ribbon: string; source: string; hue: string | null; rgb: number[]; opacity: number }[];
  /** each source node: its hue and its bar's fill */
  sources: { node: string; hue: string | null; fill: string }[];
  /** each destination node's bar fill, by node id */
  dests: Record<string, string>;
  /** each destination chip's dot, by node id */
  chips: Record<string, string>;
  hatchLine: string;
  savedFill: string;
}

/** Reads the drawn map's colours. */
function readPaints(page: Page): Promise<Paints> {
  return page.evaluate(() => {
    const svg = document.querySelector('[data-testid="flow-diagram"]')!;
    const rgba = (c: string): number[] => {
      const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
      return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1];
    };
    const panel = rgba(getComputedStyle(document.querySelector('.mr-flowmap-diagram')!).backgroundColor);
    const over = (fill: string, opacity: number): number[] => {
      const f = rgba(fill);
      const a = opacity * f[3];
      return [0, 1, 2].map((i) => Math.round(f[i] * a + panel[i] * (1 - a)));
    };
    const bands = [...svg.querySelectorAll('[data-ribbon]:not(.is-other)')].map((g) => {
      const cs = getComputedStyle(g.querySelector('.mr-flow-band')!);
      return { ribbon: g.getAttribute('data-ribbon')!, source: g.getAttribute('data-ribbon')!.split('|')[1], hue: g.getAttribute('data-hue'), rgb: over(cs.fill, Number(cs.fillOpacity)), opacity: Number(cs.fillOpacity) };
    });
    const bar = (g: Element): string => getComputedStyle(g.querySelector('.mr-flow-node-bar')!).fill;
    const sources = [...svg.querySelectorAll('.mr-flow-node--in:not(.is-other)')].map((g) => ({ node: g.getAttribute('data-node')!, hue: g.getAttribute('data-hue'), fill: bar(g) }));
    const dests = Object.fromEntries([...svg.querySelectorAll('.mr-flow-node--out:not(.mr-flow-node--sink)')].map((g) => [g.getAttribute('data-node')!, bar(g)]));
    const chips = Object.fromEntries([...document.querySelectorAll('[data-dest-chip]')].map((b) => [b.getAttribute('data-dest-chip')!, getComputedStyle(b.querySelector('.mr-flowmap-chip-dot')!).backgroundColor]));
    const line = svg.querySelector('.mr-flow-hatch-line');
    // the saved green, resolved the way the hatch resolves it (a probe element reading the same custom property)
    const probe = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    probe.style.fill = 'var(--mr-fill-saved)';
    svg.appendChild(probe);
    const savedFill = getComputedStyle(probe).fill;
    probe.remove();
    return { bands, sources, dests, chips, hatchLine: line ? getComputedStyle(line).stroke : '', savedFill };
  });
}

/** Each source's hue slot, by source id (from the drawn ribbons). */
async function huesBySource(page: Page): Promise<Record<string, string | null>> {
  const { bands } = await readPaints(page);
  return Object.fromEntries(bands.map((b) => [b.source, b.hue]));
}

const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Every distinct source is its own hue, one colour per source, and no two sources' bands paint alike. */
function expectOneHuePerSource(p: Paints, where: string, { coloured }: { coloured: number }): void {
  const bySource = new Map<string, Paints['bands']>();
  for (const b of p.bands) bySource.set(b.source, [...(bySource.get(b.source) ?? []), b]);
  const hued = [...bySource.entries()].filter(([, bs]) => bs[0].hue !== null);
  expect(hued.length, `${where}: coloured sources`).toBe(coloured);
  // one hue per source, and all its bands the same paint
  for (const [source, bs] of bySource) {
    expect(new Set(bs.map((b) => b.hue)).size, `${where}: ${source} wears one hue`).toBe(1);
    for (const b of bs) expect(dist(b.rgb, bs[0].rgb), `${where}: ${b.ribbon} paints as its source`).toBeLessThan(2);
  }
  // distinct hues, and visibly distinct paints (sRGB distance well above a just-noticeable step)
  expect(new Set(hued.map(([, bs]) => bs[0].hue)).size, `${where}: distinct hue slots`).toBe(hued.length);
  for (let i = 0; i < hued.length; i++)
    for (let j = i + 1; j < hued.length; j++)
      expect(dist(hued[i][1][0].rgb, hued[j][1][0].rgb), `${where}: ${hued[i][0]} vs ${hued[j][0]}`).toBeGreaterThan(40);
  // a source's node bar is its bands' colour
  for (const s of p.sources) {
    const id = s.node.split(':').pop()!;
    const band = bySource.get(id)?.[0];
    if (band) expect(s.hue, `${where}: ${s.node} node wears its bands' hue`).toBe(band.hue);
  }
  // the saved hatch is still the one green
  expect(p.hatchLine, `${where}: the hatch is the saved green`).toBe(p.savedFill);
}

test.describe('Flow colours: every source its own hue (D55)', () => {
  test('the rig: five hues and a tail; destinations are ink; hover still isolates one path', async ({ page }, info) => {
    test.setTimeout(180_000);
    const errors = trackConsoleErrors(page);
    await page.setViewportSize(SIZE[1440]);
    await openRig(page);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await settle(page);
      const p = await readPaints(page);
      expectOneHuePerSource(p, `rig ${theme}`, { coloured: 5 });
      // the three the owner named, all into SIEM (prod), are three different colours now
      const hue = (id: string) => p.bands.find((b) => b.source === id)!.hue;
      expect(new Set([hue('mrd_windows_dc'), hue('mrd_windows_workstations'), hue('mrd_pan_firewall')]).size).toBe(3);
      // Payments API and Kubernetes are two families now (the first cut drew a purple beside a lavender)
      const band = (id: string) => p.bands.find((b) => b.source === id)!;
      expect(band('mrd_payments_api').hue).not.toBe(band('mrd_k8s_prod').hue);
      // the $2 hairline is the tail, and the note says what the grey means
      expect(band('mrd_vpc_flow').hue).toBeNull();
      await expect(page.getByTestId('flow-note-tail')).toHaveText('Sources past the 5 largest are grey.');
      // destinations are ink: a chip's bar is its node's fill, and no band is its destination's colour
      expect(Object.keys(p.chips).length).toBeGreaterThan(1);
      for (const [id, dot] of Object.entries(p.chips)) expect(dot, `${theme}: chip ${id}`).toBe(p.dests[id]);
      const ink = (css: string) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      for (const b of p.bands) {
        const dest = p.dests[`out:default:${b.ribbon.split('|').pop()}`];
        if (dest) expect(dist(b.rgb, ink(dest)), `${theme}: ${b.ribbon} vs its destination`).toBeGreaterThan(60);
      }
      for (const size of [1440, 1920] as const) {
        await page.setViewportSize(SIZE[size]);
        await settle(page);
        await shot(page, info, `rig-${theme}-${size}`);
      }
      await page.setViewportSize(SIZE[1440]);
    }
    await setTheme(page, 'light');

    // hover: the path lights, the rest recede (not vanish), in its own hue
    const diagram = page.getByTestId('flow-diagram');
    const ribbon = 'default|mrd_payments_api|mrd_payments_api|mrd_siem_prod';
    await diagram.locator(`[data-ribbon="${ribbon}"] path`).first().hover();
    const total = await diagram.locator('[data-ribbon]').count();
    await expect(diagram.locator('[data-ribbon].is-dim')).toHaveCount(total - 1);
    await page.waitForTimeout(300);
    const lit = await diagram.locator(`[data-ribbon="${ribbon}"] .mr-flow-band`).first().evaluate((el) => Number(getComputedStyle(el).fillOpacity));
    const dim = await diagram.locator('[data-ribbon].is-dim .mr-flow-band').first().evaluate((el) => Number(getComputedStyle(el).fillOpacity));
    expect(lit).toBeGreaterThan(dim);
    expect(dim).toBeGreaterThanOrEqual(0.2);
    await shot(page, info, 'rig-hover-light-1440');
    await page.mouse.move(1, 1);

    // the phone: the list's bars wear the same hues as the map's bands
    const hues = await huesBySource(page);
    await page.setViewportSize(SIZE[390]);
    await showMap(page, false);
    const rows = page.locator('[data-list-ribbon]');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    const listHues = await rows.evaluateAll((els) => els.map((e) => [e.getAttribute('data-list-ribbon')!.split('|')[1], e.getAttribute('data-hue')] as const));
    for (const [source, h] of listHues) if (source in hues) expect(h, `list row ${source}`).toBe(hues[source]);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await showMap(page, false);
      await settle(page);
      await shot(page, info, `rig-list-${theme}-390`);
      await showMap(page, true);
      await expect(page.locator('[data-testid="flow-diagram"] [data-ribbon]').first()).toBeVisible();
      await settle(page);
      await shot(page, info, `rig-map-${theme}-390`);
    }
    expect(errors()).toEqual([]);
  });

  test("the What-if's projection and the byte map colour every source as the live map does", async ({ page }) => {
    await page.setViewportSize(SIZE[1440]);
    await openRig(page);
    const live = await huesBySource(page);
    expect(Object.values(live).filter((h) => h !== null).length).toBe(5);

    await page.goto('/flow?weight=bytes', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('flow-diagram')).toHaveAttribute('data-weight-by', 'bytes', { timeout: 30_000 });
    await page.waitForTimeout(500);
    expect(await huesBySource(page)).toEqual(live);

    const stream = encodeURIComponent('default|mrd_windows_workstations|mrd_windows_workstations|mrd_siem_prod');
    await page.goto(`/flow?whatif=1&stream=${stream}&treatment=aggressive-windows`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('projection-chip')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(600);
    const projected = await huesBySource(page);
    for (const [source, h] of Object.entries(projected)) expect(h, `projected ${source}`).toBe(live[source]);
  });

  test('the tour: the top five sources are five hues, the rest one neutral', async ({ page }, info) => {
    test.setTimeout(180_000);
    const errors = trackConsoleErrors(page);
    await page.setViewportSize(SIZE[1440]);
    await openTour(page);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      for (const size of [1440, 1920] as const) {
        await page.setViewportSize(SIZE[size]);
        await settle(page);
        const p = await readPaints(page);
        expectOneHuePerSource(p, `tour ${theme} ${size}`, { coloured: 5 });
        // the tail is one neutral (grey, no hue) at the band's own opacity: the dollar map fades nothing by price
        const tail = p.bands.filter((b) => b.hue === null);
        const hued = p.bands.filter((b) => b.hue !== null);
        for (const b of tail) {
          expect(b.opacity, `tail ${b.ribbon}`).toBeCloseTo(hued[0].opacity, 3);
          expect(Math.max(...b.rgb) - Math.min(...b.rgb), `tail ${b.ribbon} is grey`).toBeLessThan(20);
        }
        // the note names the grey in one sentence (not a legend item: a third one wraps the footer and costs the map rows)
        if (tail.length > 0) await expect(page.getByTestId('flow-note-tail')).toHaveText('Sources past the 5 largest are grey.');
        await expect(page.locator('.mr-flowmap-legend > li')).toHaveCount(2);
        await shot(page, info, `tour-${theme}-${size}`);
      }
      await page.setViewportSize(SIZE[390]);
      await settle(page);
      await shot(page, info, `tour-list-${theme}-390`);
      await page.setViewportSize(SIZE[1440]);
    }
    expect(errors()).toEqual([]);
  });

  test("an open incident's red outline stays readable on its source's hue", async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize(SIZE[1440]);
    await openRich(page, '/flow');
    await expect(page.locator('[data-testid="flow-diagram"] [data-incident]').first()).toBeAttached({ timeout: 30_000 });
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await settle(page);
      const p = await readPaints(page);
      expect(new Set(p.bands.filter((b) => b.hue !== null).map((b) => b.source)).size).toBeGreaterThan(1);
      await shot(page, info, `incident-${theme}-1440`);
    }
  });

  test("the Story's dollar-map beat (the video's map) wears the same hues, with its own sources", async ({ page }, info) => {
    test.setTimeout(120_000);
    const errors = trackConsoleErrors(page);
    const doc = JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/story.json', import.meta.url)), 'utf8')) as StoryDoc;
    const i = doc.beats.findIndex((b) => b.id === 'flow');
    expect(i).toBeGreaterThanOrEqual(0);
    const at = beatStarts(doc)[i] + doc.beats[i].seconds - 0.3;
    for (const [w, h] of [
      [1920, 1080],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      await gotoApp(page, '/?story=1');
      await page.locator('.mr-story[data-ready="true"]').waitFor();
      await page.waitForFunction(() => '__MR_STORY__' in window);
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await page.evaluate((x) => {
          const api = (window as unknown as { __MR_STORY__: { pause(): void; seek(n: number): void } }).__MR_STORY__;
          api.pause();
          api.seek(x);
        }, at);
        await expect(page.locator('.mr-story')).toHaveAttribute('data-beat', 'flow');
        const map = page.locator('main .mr-st-scene:not([data-leaving]) [data-testid="flow-diagram"]');
        await expect(map.locator('[data-ribbon]').first()).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(800);
        // the owner's point on the video's map: the named sources are distinct hues, every one of a source's bands alike
        const hues = await map.locator('[data-ribbon]:not(.is-other)').evaluateAll((els) => els.map((e) => [e.getAttribute('data-ribbon')!.split('|')[1], e.getAttribute('data-hue')] as const));
        const bySource = new Map<string, Set<string | null>>();
        for (const [source, hue] of hues) bySource.set(source, new Set([...(bySource.get(source) ?? []), hue]));
        for (const [source, set] of bySource) expect(set.size, `${source} wears one hue`).toBe(1);
        const coloured = [...bySource.values()].map((set) => [...set][0]).filter((x) => x !== null);
        expect(coloured.length).toBeGreaterThanOrEqual(Math.min(5, bySource.size));
        expect(new Set(coloured).size).toBe(coloured.length);
        if (shoots(info)) await page.screenshot({ path: `tests/report/screens/flowcolor-story-${theme}-${w}.png` });
      }
    }
    expect(errors()).toEqual([]);
  });
});
