// tests/e2e/story.spec.ts — Story mode (PRD 8.9, SPEC 13 / 15; DESIGN_BRIEF §8) on the in-browser emulator.
//
//   ?story=1 plays the loop: every beat's view, its caption line (the story.json text, at its second) and its
//   callouts (a label + leader line onto the element with that data-callout id, never covering it); it
//   loops; any key exits and hands the screen back to live data. Y enters from anywhere. Reduced motion
//   switches states without animating.
//
// The Story view's test hook (src/views/Story/testHook.ts, mock builds only) seeks and pauses the engine,
// so each beat is checked — and photographed — at a deterministic second.
//
// Beauty evidence: tests/report/beauty/story-<beat>-<theme>-<width>.png at 390 and 1920, both themes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { Incident, StoryDoc, TourDoc } from '../../core/types.ts';
import { storyFacts, storyMoments } from '../../src/story/beats.ts';
import { beatStarts, positionAt, storySeconds } from '../../src/story/timeline.ts';
import { t } from '../../src/copy/en.ts';
import { gotoApp, setTheme, trackConsoleErrors, type Theme } from './helpers/index.ts';

const DOC = JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/story.json', import.meta.url)), 'utf8')) as StoryDoc;
/** The tour fixture the release story plays: every number the screen must show is read from it, never typed. */
const TOUR = JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/tour.json', import.meta.url)), 'utf8')) as TourDoc;
const FACTS = storyFacts(storyMoments(TOUR));
const TOTAL = storySeconds(DOC);
const STARTS = beatStarts(DOC);
const STORY = '.mr-story[data-ready="true"]';
/** The scene on stage (a scene that just left fades out over it for 260 ms; queries never mean that one). */
const LIVE = 'main .mr-st-scene:not([data-leaving])';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** The presenter view's test hook (src/views/Presenter/testHook.ts), as far as this spec drives it. */
interface PresenterHook {
  store: { getState(): { settings: { presenter?: Record<string, unknown> } & Record<string, unknown> }; setState(patch: Record<string, unknown>): void };
  stop(): void;
}

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function openStory(page: Page, path = '/?story=1'): Promise<void> {
  await gotoApp(page, path);
  await page.locator(STORY).waitFor();
  await page.waitForFunction(() => '__MR_STORY__' in window);
  // Measurements compare boxes across seconds: the display face must have landed before the first one.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Jumps the paused story to a second of the pass and waits for the frame to show it. */
async function showAt(page: Page, sec: number): Promise<void> {
  const expected = positionAt(DOC, sec);
  await page.evaluate((s) => {
    const api = (window as unknown as { __MR_STORY__: { pause(): void; seek(n: number): void } }).__MR_STORY__;
    api.pause();
    api.seek(s);
  }, sec);
  await expect(page.locator('.mr-story')).toHaveAttribute('data-beat', expected.beat.id);
  await expect(page.locator('.mr-story')).toHaveAttribute('data-line', String(expected.lineIndex));
}

/**
 * The second of each beat that shows the most of it: the moment with the most callouts up (the latest
 * such moment), else the end of the beat — where the strip is lit, the line drawn and the summary full.
 */
function showcaseSecond(i: number): number {
  const b = DOC.beats[i];
  let best = STARTS[i] + b.seconds - 0.3;
  let most = positionAt(DOC, best).callouts.length;
  for (let t = STARTS[i] + 0.1; t < STARTS[i] + b.seconds - 0.05; t += 0.1) {
    const n = positionAt(DOC, t).callouts.length;
    if (n > most) most = n;
  }
  if (most > 0) {
    // Latest second at which that many are up, plus a little time for the last one to settle.
    for (let t = STARTS[i] + b.seconds - 0.3; t > STARTS[i]; t -= 0.1) {
      const p = positionAt(DOC, t);
      if (p.callouts.length === most) {
        best = t;
        break;
      }
    }
  }
  return best;
}

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), undefined, {
    timeout: 5_000,
  });
  // The scene that left has faded out and been dropped (index.tsx, 260 ms).
  await page.waitForFunction(() => document.querySelector('.mr-st-scene[data-leaving]') === null, undefined, { timeout: 5_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // The callout layer measures on animation frames; give it one more beat to place.
  await page.waitForFunction(() => [...document.querySelectorAll('.mr-st-callout')].every((el) => el.getAttribute('data-placed') === 'true'), undefined, {
    timeout: 5_000,
  });
}

/** Every callout that is up: its label is placed, legal, and never covers any of the beat's targets. */
async function checkCallouts(page: Page, sec: number): Promise<void> {
  const pos = positionAt(DOC, sec);
  const labels = page.locator('.mr-st-callout');
  await expect(labels).toHaveCount(pos.callouts.length);
  const viewport = page.viewportSize()!;
  const targets: Box[] = [];
  for (const c of pos.beat.callouts) {
    const target = page.locator(`${LIVE} [data-callout="${c.target}"]`).first();
    if (pos.callouts.includes(c)) await expect(target, `${pos.beat.id}: target ${c.target}`).toBeVisible();
    if ((await target.count()) === 0) continue;
    // What the element shows (a block paragraph's words, not its whole column) — as the layer measures it.
    targets.push(
      await target.evaluate((el) => {
        const box = el.getBoundingClientRect();
        let r: DOMRect = box;
        if (el instanceof HTMLElement && el.childNodes.length > 0) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const ink = range.getBoundingClientRect();
          if (ink.width > 0.5 && ink.height > 0.5) r = ink;
        }
        const x = Math.max(box.left, r.left);
        const y = Math.max(box.top, r.top);
        return { x, y, width: Math.min(box.right, r.right) - x, height: Math.min(box.bottom, r.bottom) - y };
      }),
    );
  }
  for (const c of pos.callouts) {
    const label = page.locator(`.mr-st-callout[data-target="${c.target}"]`);
    await expect(label).toHaveText(c.label);
    await expect(label).toHaveAttribute('data-placed', 'true');
    await expect(label, `${pos.beat.id}: ${c.target} found a legal spot`).toHaveAttribute('data-ok', 'true');
    const box = (await label.boundingBox())!;
    for (const t of targets) expect(overlaps(box, t), `${pos.beat.id}: label "${c.label}" covers a target`).toBe(false);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await expect(page.locator(`.mr-st-leader[data-target="${c.target}"] circle`)).toHaveCount(1);
  }
}

interface Geometry {
  /** a leader (its line or its dot) that runs through words other than its own target's */
  crossings: string[];
  /** a label that hides words (their ink: the line box less its leading) */
  hides: string[];
  /** a label that sits half on a card (or the takeover's header band) and half off it */
  straddles: string[];
}

/**
 * P1-C03's probe: every placed leader and label against the page as a viewer reads it. Words are measured per
 * rendered line (a Range over each text node), so "$1,250 a day" is its own box and a line that ends early
 * leaves its room free; an odometer counts as its one visible box; visually hidden text does not count.
 */
async function calloutGeometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    type R = { x: number; y: number; w: number; h: number };
    const live = document.querySelector('main .mr-st-scene:not([data-leaving])');
    if (!live) return { crossings: ['no live scene'], hides: [], straddles: [] };
    const box = (el: Element): R => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    };
    const hit = (a: R, b: R) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const inside = (o: R, i: R) => i.x >= o.x - 0.5 && i.y >= o.y - 0.5 && i.x + i.w <= o.x + o.w + 0.5 && i.y + i.h <= o.y + o.h + 0.5;
    const shrink = (r: R, by: number): R => ({ x: r.x + by, y: r.y + by, w: r.w - 2 * by, h: r.h - 2 * by });
    // Liang–Barsky, as src/story/layout.ts.
    const segHits = (ax: number, ay: number, bx: number, by: number, r: R): boolean => {
      let t0 = 0;
      let t1 = 1;
      const dx = bx - ax;
      const dy = by - ay;
      const clip = (p: number, q: number) => {
        if (p === 0) return q >= 0;
        const t = q / p;
        if (p < 0) {
          if (t > t1) return false;
          if (t > t0) t0 = t;
        } else {
          if (t < t0) return false;
          if (t < t1) t1 = t;
        }
        return true;
      };
      return clip(-dx, ax - r.x) && clip(dx, r.x + r.w - ax) && clip(-dy, ay - r.y) && clip(dy, r.y + r.h - ay) && t0 < t1;
    };
    const words: { r: R; el: Element; text: string }[] = [];
    for (const meter of live.querySelectorAll('[data-testid="meter"]')) words.push({ r: box(meter), el: meter, text: meter.textContent ?? '' });
    const walker = document.createTreeWalker(live, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      const el = n.parentElement;
      if (!el || !n.textContent?.trim()) continue;
      if (el.closest('[data-testid="meter"], .mr-visually-hidden')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 0.5 && r.height > 0.5) words.push({ r: { x: r.left, y: r.top, w: r.width, h: r.height }, el, text: n.textContent.trim().slice(0, 40) });
    }
    const crossings: string[] = [];
    const hides: string[] = [];
    const straddles: string[] = [];
    const cards = [...live.querySelectorAll('.mr-takeover, .mr-tk-head, .mr-st-panel, .mr-slack, .mr-slack-pre, .mr-qr-plate')].map((el) => ({ el, r: box(el) }));
    for (const g of document.querySelectorAll('.mr-st-leader')) {
      const id = g.getAttribute('data-target')!;
      const target = [...live.querySelectorAll(`[data-callout="${CSS.escape(id)}"]`)].find((el) => box(el).w > 0.5);
      const dot = g.querySelector('circle')!;
      const cx = Number(dot.getAttribute('cx'));
      const cy = Number(dot.getAttribute('cy'));
      // A straight leader is a <line>; an elbow (routed along a gutter) a two-segment <polyline>.
      const line = g.querySelector('line');
      const poly = g.querySelector('polyline');
      const pts: number[][] = line
        ? [
            [Number(line.getAttribute('x1')), Number(line.getAttribute('y1'))],
            [Number(line.getAttribute('x2')), Number(line.getAttribute('y2'))],
          ]
        : poly
          ? poly
              .getAttribute('points')!
              .trim()
              .split(/\s+/)
              .map((p) => p.split(',').map(Number))
          : [];
      const dotBox: R = { x: cx - 4.5, y: cy - 4.5, w: 9, h: 9 };
      for (const w of words) {
        if (target && (target === w.el || target.contains(w.el))) continue;
        const r = shrink(w.r, 1);
        const through = pts.slice(1).some((b, k) => segHits(pts[k][0], pts[k][1], b[0], b[1], r));
        if (through || hit(dotBox, r)) crossings.push(`${id} → "${w.text}"`);
      }
      const label = document.querySelector(`.mr-st-callout[data-target="${CSS.escape(id)}"]`);
      if (!label) continue;
      const lr = box(label);
      for (const w of words) if (hit(lr, { x: w.r.x, y: w.r.y + w.r.h * 0.15, w: w.r.w, h: w.r.h * 0.7 })) hides.push(`${id} over "${w.text}"`);
      for (const c of cards) if (hit(lr, c.r) && !inside(c.r, lr)) straddles.push(`${id} × ${c.el.className.toString().split(' ')[0]}`);
    }
    return { crossings, hides, straddles };
  });
}

/** Seconds at which each callout of a beat has just come up (its own moment, a little settled). */
function calloutSeconds(): number[] {
  const out = new Set<number>();
  DOC.beats.forEach((b, i) => {
    for (const c of b.callouts) out.add(Math.round((STARTS[i] + Math.min(b.seconds - 0.2, (c.at ?? 0) + 0.6)) * 10) / 10);
    if (b.callouts.length > 0) out.add(Math.round(showcaseSecond(i) * 10) / 10);
  });
  return [...out].sort((a, b) => a - b);
}

test.describe('Story mode', () => {
  test.setTimeout(180_000);

  test('?story=1 plays every beat with its caption and callouts, then loops; any key exits @smoke', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openStory(page);
    // The release plays the tour fixture, and says so the presenter's way: a quiet chip, no band.
    await expect(page.locator('.mr-st-top .mr-st-chip[data-source="sample"]')).toContainText('Sample data');

    for (let i = 0; i < DOC.beats.length; i++) {
      const sec = showcaseSecond(i);
      const pos = positionAt(DOC, sec);
      await showAt(page, sec);
      await expect(page.locator('.mr-story')).toHaveAttribute('data-view', pos.beat.view);
      if (pos.line) await expect(page.locator('.mr-st-caption')).toHaveText(pos.line);
      else await expect(page.locator('.mr-st-caption')).toHaveCount(0);
      await settle(page);
      await checkCallouts(page, sec);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${pos.beat.id}: horizontal scroll`).toBeLessThanOrEqual(0);
    }

    // What the captions say is what the screen shows.
    await showAt(page, STARTS[DOC.beats.findIndex((b) => b.id === 'alert')] + 9);
    await settle(page);
    const card = page.locator(`${LIVE} .mr-takeover`);
    await expect(card).toContainText('75%');
    await expect(card.locator('[data-callout="per-day"]')).toHaveText(`${FACTS.perDay} a day · ${FACTS.perYear} a year if left`);
    await expect(card.locator('[data-callout="commit"]')).toHaveText(FACTS.hash);
    await expect(card.locator('[data-callout="author"]')).toHaveText(FACTS.user);
    await expect(card).toContainText(`Caught in ${FACTS.caughtIn}`);
    await showAt(page, STARTS[DOC.beats.findIndex((b) => b.id === 'restore')] + 5);
    await expect(page.locator(`${LIVE} .mr-takeover[data-mode="recovery"]`)).toContainText('Recovered');

    // It loops: past the ask, the title again, one pass on.
    await page.evaluate((s) => {
      const api = (window as unknown as { __MR_STORY__: { seek(n: number): void; resume(): void } }).__MR_STORY__;
      api.seek(s);
      api.resume();
    }, TOTAL - 0.6);
    await expect(page.locator('.mr-story')).toHaveAttribute('data-iteration', '1', { timeout: 5_000 });
    await expect(page.locator('.mr-story')).toHaveAttribute('data-beat', 'title');

    // Any key exits and the live screen comes back (no sample band).
    await page.keyboard.press('q');
    await expect(page.locator('.mr-story')).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get('story')).toBeNull();
    await expect(page.locator('[data-callout="sample-band"]')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('the frame never scrolls: every beat fits the viewport, nothing spills past the stage, the caption rail never moves', async ({ page }) => {
    await openStory(page);
    const rails: number[] = [];
    for (let i = 0; i < DOC.beats.length; i++) {
      // The beat's opening second and its busiest one (the card up, the line drawn, every callout placed).
      for (const sec of [STARTS[i] + 0.05, showcaseSecond(i)]) {
        await showAt(page, sec);
        await settle(page);
        const m = await page.evaluate(() => {
          const stage = document.querySelector('main.mr-st-stage')!.getBoundingClientRect();
          const blocks = [...document.querySelectorAll('main .mr-st-scene > *, main .mr-takeover, main .mr-st-panel')].map((el) => el.getBoundingClientRect());
          return {
            scroll: document.documentElement.scrollHeight,
            inner: window.innerHeight,
            rail: document.querySelector('.mr-st-rail')!.getBoundingClientRect().top,
            spill: Math.max(0, ...blocks.filter((b) => b.height > 0).map((b) => b.bottom - stage.bottom)),
          };
        });
        const id = `${DOC.beats[i].id} @${sec.toFixed(1)}s`;
        expect(m.scroll, `${id}: the page scrolls`).toBe(m.inner);
        expect(m.spill, `${id}: the scene spills past the stage`).toBeLessThanOrEqual(0.5);
        rails.push(Math.round(m.rail * 10) / 10);
      }
    }
    expect(new Set(rails), 'the caption rail moved between beats').toEqual(new Set([rails[0]]));
  });

  test('callout geometry: no leader runs through words it does not point at; no label hides words or straddles a card edge or the takeover band (P1-C03)', async ({ page }, info) => {
    await openStory(page);
    const found: string[] = [];
    // The project's own frame, and on the desk project the projector's other common one too.
    const frames = info.project.name === 'chromium' ? [page.viewportSize()!, { width: 1280, height: 720 }] : [page.viewportSize()!];
    for (const frame of frames) {
      await page.setViewportSize(frame);
      for (const sec of calloutSeconds()) {
        await showAt(page, sec);
        await settle(page);
        // One re-measure after everything settled (Callouts.tsx measures every 250 ms): the placement the frame keeps.
        await page.waitForTimeout(300);
        const g = await calloutGeometry(page);
        const id = `${frame.width}: ${positionAt(DOC, sec).beat.id} @${sec.toFixed(1)}s`;
        for (const c of g.crossings) found.push(`${id}: leader ${c}`);
        for (const h of g.hides) found.push(`${id}: label ${h}`);
        for (const s of g.straddles) found.push(`${id}: label ${s}`);
      }
    }
    expect(found, 'callout geometry').toEqual([]);
  });

  test('the dollar map: the strip for 3 s, then the Flow map of the largest group, its plates and saved wedges in the frame (P2-W11)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openStory(page);
    const how = DOC.beats.findIndex((b) => b.id === 'how');
    const flow = DOC.beats.findIndex((b) => b.view === 'flow');
    expect(DOC.beats[how].seconds, 'the icon strip is on screen for at most 3 s').toBeLessThanOrEqual(3);
    expect(flow, 'the map follows the strip').toBe(how + 1);
    await showAt(page, STARTS[flow] + 5);
    await settle(page);
    const map = page.locator(`${LIVE} .mr-st-flow`);
    await expect(map).toHaveAttribute('data-group', 'datacenter');
    const svg = map.locator('.mr-flow-svg');
    await expect(svg).toBeVisible();
    const ribbons = await svg.locator('.mr-flow-ribbon').count();
    if (page.viewportSize()!.width === 1920) expect(ribbons, 'ribbons at 1920').toBeGreaterThanOrEqual(10);
    else expect(ribbons).toBeGreaterThanOrEqual(5);
    expect(await svg.locator('.mr-flow-wedge').count(), 'hatched saved wedges').toBeGreaterThan(0);
    // The header says what the caption says: the group's saved $ a day.
    await expect(map.locator('.mr-st-flow-total-figure')).toHaveText(FACTS.flowSaved);
    await expect(page.locator('.mr-st-caption')).toContainText(FACTS.flowSaved);
    await expect(map).toContainText(t('flow.subtitle'));
    // The map fits the frame: nothing past the panel, the panel inside the stage.
    const fit = await page.evaluate((sel) => {
      const panel = document.querySelector(sel)!.getBoundingClientRect();
      const svgBox = document.querySelector(`${sel} .mr-flow-svg`)!.getBoundingClientRect();
      const stage = document.querySelector('main.mr-st-stage')!.getBoundingClientRect();
      return { svgIn: svgBox.left >= panel.left - 0.5 && svgBox.right <= panel.right + 0.5 && svgBox.bottom <= panel.bottom + 0.5, panelIn: panel.bottom <= stage.bottom + 0.5, share: (svgBox.width * svgBox.height) / (stage.width * stage.height) };
    }, `${LIVE} .mr-st-flow`);
    expect(fit.svgIn, 'the map inside its panel').toBe(true);
    expect(fit.panelIn, 'the panel inside the stage').toBe(true);
    if (page.viewportSize()!.width >= 1440) expect(fit.share, 'the map fills the stage').toBeGreaterThanOrEqual(0.4);
    // On a projector the map is drawn larger than laid out: its node names read at >= 18 px.
    if (page.viewportSize()!.width === 1920) {
      const px = await svg.locator('.mr-flow-text--name').first().evaluate((el) => el.getBoundingClientRect().height);
      expect(px, 'a node name’s rendered height at 1920').toBeGreaterThanOrEqual(18);
    }
    // Both callouts point into the map: the $ / day plate, then the saved plate on the hatched wedge.
    await showAt(page, STARTS[flow] + 1.5);
    await settle(page);
    await expect(page.locator(`${LIVE} .mr-flow-svg [data-callout="flow-plate"]`)).toHaveCount(1);
    await expect(page.locator(`${LIVE} .mr-flow-svg [data-callout="flow-plate"]`)).toContainText('/ day');
    await expect(page.locator(`${LIVE} .mr-flow-svg [data-callout="flow-saved"]`)).toContainText('saved');
    await expect(page.locator('.mr-st-callout[data-target="flow-plate"]')).toHaveText('priced at the destination');
    // The next pass draws the same map with the same figure its caption says (the engine resets the sample).
    await page.evaluate((s) => {
      const api = (window as unknown as { __MR_STORY__: { seek(n: number): void; resume(): void; pause(): void } }).__MR_STORY__;
      api.seek(s);
      api.resume();
    }, TOTAL - 0.4);
    await expect(page.locator('.mr-story')).toHaveAttribute('data-iteration', '1', { timeout: 5_000 });
    await page.evaluate((s) => {
      const api = (window as unknown as { __MR_STORY__: { seek(n: number): void; pause(): void } }).__MR_STORY__;
      api.pause();
      api.seek(s);
    }, STARTS[flow] + 5);
    await expect(page.locator('.mr-story')).toHaveAttribute('data-beat', 'flow');
    await expect(page.locator('.mr-story')).toHaveAttribute('data-iteration', '1');
    await expect(page.locator(`${LIVE} .mr-st-flow-total-figure`)).toHaveText(FACTS.flowSaved);
    expect(errors()).toEqual([]);
  });

  test('the number tells the incident: the rate drops by the alert’s $ a day and comes back; a clock runs to the card’s Caught in; the receipt prints (P2-W12)', async ({
    page,
  }) => {
    const errors = trackConsoleErrors(page);
    await openStory(page);
    const incident = TOUR.script.find((s) => s.action === 'incident.open' && (s.payload as Incident).type === 'regression')!.payload as Incident;
    const at = (id: string, sec: number) => STARTS[DOC.beats.findIndex((b) => b.id === id)] + sec;
    const hero = page.locator(`${LIVE} .mr-st-pv-hero`);
    const chip = page.locator(`${LIVE} .mr-st-pv-delta`);

    // (1) The savings rate: the hook's, less the open alert's $ a day (per second), then the hook's again.
    await showAt(page, at('hook', 3));
    const hookRate = Number(await hero.getAttribute('data-rate-m'));
    await expect(chip).toHaveAttribute('data-tone', 'none');
    await expect(chip).toBeHidden();
    await showAt(page, at('alert', 2));
    await settle(page);
    const alertRate = Number(await hero.getAttribute('data-rate-m'));
    expect(hookRate - alertRate, 'the per-second rate drops by the impact / 86,400').toBeCloseTo(incident.impactPerDayM / 86_400, 2);
    await expect(chip).toHaveAttribute('data-tone', 'loss');
    await expect(chip).toHaveText(`−${FACTS.perDay} / day`);
    await expect(chip).toBeVisible();
    // Nothing on the band moved for it: the chip's room was there in the hook.
    await showAt(page, at('restore', DOC.beats.find((b) => b.id === 'restore')!.seconds - 0.5));
    await settle(page);
    expect(Number(await hero.getAttribute('data-rate-m')), 'the rate is back after the restore').toBeCloseTo(hookRate, 3);
    await expect(chip).toHaveAttribute('data-tone', 'back');
    await expect(chip).toHaveText(`+${FACTS.perDay} / day back`);

    // (2) The watching beat's clock: from 0:00 at its start to the card's Caught in on its last frame.
    const clock = page.locator(`${LIVE} .mr-st-watch-clock-time`);
    const watching = DOC.beats.find((b) => b.id === 'watching')!;
    await showAt(page, at('change', 2));
    await expect(clock, 'no clock while the change ships').toHaveCount(0);
    await showAt(page, at('watching', 0.05));
    await expect(clock).toHaveText('0:00');
    await showAt(page, at('watching', watching.seconds / 2));
    const mid = (await clock.textContent())!;
    expect(mid > '0:00' && mid < FACTS.caughtIn, `mid-beat clock ${mid}`).toBe(true);
    await showAt(page, at('watching', watching.seconds - 0.05));
    await expect(clock).toHaveText(FACTS.caughtIn);
    await expect(page.locator(`${LIVE} .mr-st-watch-clock`)).toContainText('since the deploy');
    // The card that lands next says the same figure.
    await showAt(page, at('alert', 1.5));
    await settle(page);
    await expect(page.locator(`${LIVE} .mr-takeover .mr-tk-clock`)).toHaveText(FACTS.caughtIn);

    // (3) Monday's receipt prints a line at a time, its total last, then the callout points at it.
    const lines = page.locator(`${LIVE} .mr-slack-pre-line`);
    const total = page.locator(`${LIVE} [data-callout="receipt-total"]`);
    await showAt(page, at('receipt', 0.5));
    const n = await lines.count();
    expect(n).toBeGreaterThanOrEqual(8);
    await expect(page.locator(`${LIVE} .mr-slack-pre-line[data-shown="true"]`)).toHaveCount(1);
    await expect(total).toHaveAttribute('data-shown', 'false');
    await expect(total).toBeHidden();
    // Every line but the total, then the total (src/views/Story/stages.tsx PRINT_START 0.3 s, PRINT_STEP 0.3 s).
    await showAt(page, at('receipt', 0.3 + (n - 2) * 0.3 + 0.1));
    await expect(page.locator(`${LIVE} .mr-slack-pre-line[data-shown="true"]`)).toHaveCount(n - 1);
    await expect(total).toHaveAttribute('data-shown', 'false');
    await showAt(page, at('receipt', 0.3 + (n - 1) * 0.3 + 0.1));
    await expect(total).toHaveAttribute('data-shown', 'true');
    await expect(total).toBeVisible();
    const callout = DOC.beats.find((b) => b.id === 'receipt')!.callouts[0];
    expect(callout.at!, 'the callout waits for the total').toBeGreaterThan(0.3 + (n - 1) * 0.3);

    // The next pass starts clean: no chip in its hook, the hook's rate, a red chip again when its alert lands.
    await page.evaluate((s) => {
      const api = (window as unknown as { __MR_STORY__: { seek(n: number): void; resume(): void } }).__MR_STORY__;
      api.seek(s);
      api.resume();
    }, TOTAL - 0.4);
    await expect(page.locator('.mr-story')).toHaveAttribute('data-iteration', '1', { timeout: 5_000 });
    const again = async (sec: number) =>
      page.evaluate((s) => {
        const api = (window as unknown as { __MR_STORY__: { seek(n: number): void; pause(): void } }).__MR_STORY__;
        api.pause();
        api.seek(s);
      }, sec);
    // (seek() jumps within the current pass: the second one now.)
    await again(at('hook', 3));
    await expect(page.locator('.mr-story')).toHaveAttribute('data-beat', 'hook');
    await expect(page.locator('.mr-story')).toHaveAttribute('data-iteration', '1');
    await expect(chip).toHaveAttribute('data-tone', 'none');
    expect(Number(await hero.getAttribute('data-rate-m'))).toBeCloseTo(hookRate, 3);
    await again(at('alert', 2));
    await expect(page.locator('.mr-story')).toHaveAttribute('data-beat', 'alert');
    await expect(chip).toHaveAttribute('data-tone', 'loss');
    expect(errors()).toEqual([]);
  });

  test('the number tells the incident, reduced motion: the chip is there, the clock final, the receipt whole (P2-W12)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openStory(page);
    const at = (id: string, sec: number) => STARTS[DOC.beats.findIndex((b) => b.id === id)] + sec;
    await showAt(page, at('watching', 0.5));
    await expect(page.locator(`${LIVE} .mr-st-watch-clock-time`)).toHaveText(FACTS.caughtIn);
    await showAt(page, at('receipt', 0.5));
    const lines = page.locator(`${LIVE} .mr-slack-pre-line`);
    const n = await lines.count();
    for (let i = 0; i < n; i++) await expect(lines.nth(i)).not.toHaveAttribute('data-shown', 'false');
    await expect(page.locator(`${LIVE} [data-callout="receipt-total"]`)).toBeVisible();
    await showAt(page, at('alert', 2));
    await expect(page.locator(`${LIVE} .mr-st-pv-delta`)).toHaveAttribute('data-tone', 'loss');
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0);
  });

  test('Y enters Story mode from any view; the × and any key leave it', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/ledger');
    await page.keyboard.press('y');
    await page.locator(STORY).waitFor();
    await expect.poll(() => new URL(page.url()).searchParams.get('story')).toBe('1');
    await expect(page.locator('.mr-st-top')).toContainText('Meter Reader');
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.mr-story')).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/ledger');
    await page.keyboard.press('Y');
    await page.locator(STORY).waitFor();
    await page.keyboard.press('Escape');
    await expect(page.locator('.mr-story')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('the way out is findable on any screen: a 44 px ×, the hint for this input, Escape named (P1-C06)', async ({ page }, info) => {
    await openStory(page);
    await expect(page.locator('.mr-story')).toHaveAttribute('aria-keyshortcuts', 'Escape');
    const close = page.getByRole('button', { name: 'Close' });
    const box = (await close.boundingBox())!;
    expect(box.width, 'the × is a 44 px target').toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const touch = await page.evaluate(() => window.matchMedia('(hover: none)').matches);
    expect(touch, 'the mobile project is a touch screen').toBe(info.project.name === 'mobile');
    const keys = page.locator('.mr-st-hint[data-input="keys"]');
    const tap = page.locator('.mr-st-hint[data-input="touch"]');
    if (touch) {
      await expect(tap).toBeVisible();
      await expect(tap).toHaveText('Tap to exit');
      await expect(keys).toBeHidden();
    } else {
      await expect(keys).toBeVisible();
      await expect(keys).toHaveText('Press Esc or any key to exit');
      await expect(tap).toBeHidden();
    }
    // Nothing in the top bar spills out of the frame or under its neighbour.
    const bar = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      return { brand: r('.mr-st-brand'), exit: r('.mr-st-exit'), width: document.documentElement.clientWidth };
    });
    expect(bar.brand.right, 'the brand stays clear of the exit').toBeLessThanOrEqual(bar.exit.left);
    expect(bar.exit.right).toBeLessThanOrEqual(bar.width);
  });

  test('the progress bar sits on the frame’s centre line, with the sample chip or the longer replay chip (P1-C05)', async ({ page }) => {
    await openStory(page);
    const offCentre = () =>
      page.evaluate(() => {
        const r = document.querySelector('.mr-st-progress')!.getBoundingClientRect();
        return Math.abs(r.left + r.width / 2 - document.documentElement.clientWidth / 2);
      });
    expect(await offCentre(), 'progress centre vs viewport centre').toBeLessThanOrEqual(4);
    // The replay's chip is twice as long; the outer columns stay equal, so the bar does not move.
    await page.evaluate(() => {
      const chip = document.querySelector('.mr-st-chip')!;
      chip.firstChild!.textContent = 'Replay · recorded Sep 26';
    });
    expect(await offCentre(), 'with the replay chip').toBeLessThanOrEqual(4);
    for (const size of [
      { width: 1280, height: 720 },
      { width: 1024, height: 768 },
      { width: 820, height: 1180 },
    ]) {
      await page.setViewportSize(size);
      expect(await offCentre(), `at ${size.width}x${size.height}`).toBeLessThanOrEqual(4);
      const clear = await page.evaluate(() => {
        const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
        const [brand, bar, exit] = [r('.mr-st-brand'), r('.mr-st-progress'), r('.mr-st-exit')];
        const sameRow = bar.top < brand.bottom && brand.top < bar.bottom;
        return !sameRow || (brand.right <= bar.left && bar.right <= exit.left);
      });
      expect(clear, `at ${size.width}: the brand, the bar and the exit never overlap`).toBe(true);
    }
  });

  test('consecutive card beats share their edges: the meter’s receipt, the change and the watching chart (P1-C05)', async ({ page }) => {
    await openStory(page);
    const edges: Record<string, { left: number; right: number }> = {};
    for (const [id, sel] of [
      ['meter', '.mr-st-receipt-frame'],
      ['change', '.mr-st-watch'],
      ['watching', '.mr-st-watch'],
    ] as const) {
      const i = DOC.beats.findIndex((b) => b.id === id);
      await showAt(page, STARTS[i] + 1.5);
      await settle(page);
      edges[id] = await page.locator(`${LIVE} ${sel}`).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10 };
      });
    }
    expect(edges.change, 'the change beat keeps the meter beat’s card edges').toEqual(edges.meter);
    expect(edges.watching).toEqual(edges.meter);
    // The receipt card is perforated like the Receipt's hero (the mask also keeps the Meter's glow inside it).
    const meter = DOC.beats.findIndex((b) => b.id === 'meter');
    await showAt(page, STARTS[meter] + 1.5);
    await settle(page);
    const card = await page.locator(`${LIVE} .mr-st-receipt`).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { mask: cs.maskImage || cs.getPropertyValue('-webkit-mask-image') };
    });
    expect(card.mask, 'the receipt card is cut to teeth').toContain('conic-gradient');

    // The alert card is the presenter's width on a desk frame (1520 stage px), the whole stage on a phone.
    const alert = DOC.beats.findIndex((b) => b.id === 'alert');
    await showAt(page, STARTS[alert] + 3);
    await settle(page);
    const widths = await page.evaluate(() => {
      const stage = document.querySelector('main.mr-st-stage')!;
      const pad = parseFloat(getComputedStyle(stage).paddingLeft) + parseFloat(getComputedStyle(stage).paddingRight);
      const sp = Math.min(window.innerWidth, (window.innerHeight * 1920) / 1080) / 1920;
      return {
        card: document.querySelector('main .mr-st-scene:not([data-leaving]) .mr-takeover')!.getBoundingClientRect().width,
        room: stage.getBoundingClientRect().width - pad,
        presenter: 1520 * sp,
      };
    });
    if (page.viewportSize()!.width <= 720) expect(widths.card, 'a phone card spans the stage').toBeCloseTo(widths.room, 0);
    else expect(widths.card, 'the presenter card width').toBeCloseTo(Math.min(widths.room, Math.max(widths.presenter, 640)), 0);
  });

  test('the meter beat runs no animation loop of its own: well under one frame callback per display frame (P1-C05)', async ({ page }) => {
    await openStory(page);
    const meter = DOC.beats.findIndex((b) => b.id === 'meter');
    await showAt(page, STARTS[meter] + 0.5);
    await settle(page);
    const perSecond = await page.evaluate(async () => {
      const w = window as unknown as { requestAnimationFrame: typeof requestAnimationFrame; __MR_STORY__: { resume(): void; pause(): void } };
      const original = w.requestAnimationFrame.bind(window);
      let calls = 0;
      w.requestAnimationFrame = (cb: FrameRequestCallback) => {
        calls++;
        return original(cb);
      };
      w.__MR_STORY__.resume();
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 2_000));
      const seconds = (performance.now() - t0) / 1000;
      w.__MR_STORY__.pause();
      w.requestAnimationFrame = original;
      return calls / seconds;
    });
    // Played, not paused: the callouts come up (0.4 s, 1.6 s, 4 s in) and the figure is on screen.
    await expect(page.locator('.mr-story')).toHaveAttribute('data-beat', 'meter');
    expect(perSecond, 'requestAnimationFrame calls per second during the meter beat').toBeLessThan(70);
    expect(perSecond, 'no per-frame measuring loop').toBeLessThan(15);
  });

  test('on a touch screen a tap anywhere on the frame exits; a swipe down exits; a mouse click does not (P1-C06)', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    if (info.project.name === 'mobile') {
      // A tap on the stage, mid-beat.
      await openStory(page);
      await showAt(page, STARTS[DOC.beats.findIndex((b) => b.id === 'meter')] + 2);
      await page.locator('main.mr-st-stage').tap({ position: { x: 40, y: 40 } });
      await expect(page.locator('.mr-story')).toHaveCount(0);
      await expect.poll(() => new URL(page.url()).searchParams.get('story')).toBeNull();
      // The first-run card's way in, then a tap on the caption.
      await openStory(page);
      await page.locator('.mr-st-rail').tap();
      await expect(page.locator('.mr-story')).toHaveCount(0);
    } else {
      // At a desk a stray click is not an exit: the keyboard and the × are.
      await openStory(page);
      await page.locator('main.mr-st-stage').click({ position: { x: 40, y: 40 } });
      await page.waitForTimeout(300);
      await expect(page.locator(STORY)).toHaveCount(1);
    }
    // A swipe down (a touch pointer that travels down and lifts) exits on any screen.
    if ((await page.locator(STORY).count()) === 0) await openStory(page);
    await page.evaluate(() => {
      const stage = document.querySelector('main.mr-st-stage')!;
      const at = (type: string, y: number) =>
        stage.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: 200, clientY: y, bubbles: true }));
      at('pointerdown', 200);
      at('pointerup', 320);
    });
    await expect(page.locator('.mr-story')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('plays on its own in real time from a cold load: the hook follows the title card, on the fixture’s numbers', async ({ page }) => {
    // No seek anywhere here: the engine starts on first render, while the first KV hydration is still in
    // flight, and hydration must land in the live stash — never over the story's sample documents.
    await openStory(page);
    await expect(page.locator('.mr-story')).toHaveAttribute('data-beat', 'title');
    await expect(page.locator('.mr-story')).toHaveAttribute('data-beat', 'hook', { timeout: 8_000 });
    await expect(page.locator('.mr-st-caption')).toHaveText(positionAt(DOC, STARTS[1] + 0.1).line!);
    const meter = page.locator(`${LIVE} [data-callout="saved"]`);
    await expect(meter).toBeVisible();
    // Saved by Cribl as the presenter shows it — the annualized run rate, a rate that does not tick — read
    // from the tour fixture's own snapshot (never the emulator's live figure).
    await expect(page.locator(`${LIVE} .mr-st-pv-hero`)).toHaveAttribute('data-period', 'annualized');
    await expect(meter).toHaveAttribute('data-ticking', 'false');
    const dollars = Number(await meter.getAttribute('data-value-m')) / 100_000;
    expect(Math.abs(dollars - TOUR.snapshot.headline.annualizedM / 100_000)).toBeLessThan(1);
    await expect(page.locator('.mr-st-top .mr-st-chip[data-source="sample"]')).toBeVisible();
  });

  test('the loop is a stage: the sample source is a quiet chip on every beat, never the striped band; the change caption claims nothing "real"', async ({
    page,
  }) => {
    const errors = trackConsoleErrors(page);
    await openStory(page);
    for (let i = 0; i < DOC.beats.length; i++) {
      await showAt(page, STARTS[i] + DOC.beats[i].seconds / 2);
      await expect(page.locator('.mr-story .mr-sample-band'), DOC.beats[i].id).toHaveCount(0);
      await expect(page.locator('.mr-story [data-callout="sample-band"]'), DOC.beats[i].id).toHaveCount(0);
      await expect(page.locator('.mr-st-top .mr-st-chip'), DOC.beats[i].id).toBeVisible();
    }
    const change = DOC.beats.find((b) => b.id === 'change')!;
    expect(JSON.stringify(change.caption)).not.toMatch(/\breal\b/i);
    await showAt(page, STARTS[DOC.beats.indexOf(change)] + 1);
    await expect(page.locator('.mr-st-caption')).not.toContainText(/\breal\b/i);
    expect(errors()).toEqual([]);
  });

  test('the hook, alert and restore beats are the presenter: its period, its figure size, its basis and its savers (P1-C02)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    // The presenter itself, on the snapshot the story's hook plays, at this project's viewport.
    await gotoApp(page, '/?present=1');
    await page.waitForFunction(() => '__MR_PRESENTER__' in window);
    await page.evaluate((snap) => {
      const h = (window as unknown as { __MR_PRESENTER__: PresenterHook }).__MR_PRESENTER__;
      h.stop();
      const { settings } = h.store.getState();
      h.store.setState({ snapshot: snap, source: 'sample', errors: {}, settings: { ...settings, presenter: { ...settings.presenter, headlinePeriod: 'annualized' } } });
    }, TOUR.snapshot);
    await expect(page.locator('.mr-pv-figure [data-value-m]')).toBeVisible();
    await expect(page.locator('.mr-pv-item')).toHaveCount(5);
    const presenter = await page.evaluate(() => {
      const px = (sel: string) => parseFloat(getComputedStyle(document.querySelector(sel)!).fontSize);
      return { figure: px('.mr-pv-figure'), basis: px('.mr-pv-caption'), basisText: document.querySelector('.mr-pv-caption')!.textContent, item: px('.mr-pv-item') };
    });

    await openStory(page);
    for (const id of ['hook', 'alert', 'restore']) {
      const i = DOC.beats.findIndex((b) => b.id === id);
      await showAt(page, STARTS[i] + DOC.beats[i].seconds - 0.5);
      await settle(page);
      await expect(page.locator(`${LIVE} .mr-st-pv-hero`), id).toHaveAttribute('data-period', 'annualized');
      const story = await page.evaluate(() => {
        const px = (sel: string) => parseFloat(getComputedStyle(document.querySelector(sel)!).fontSize);
        return {
          figure: px('main .mr-st-scene:not([data-leaving]) .mr-st-pv-hero .mr-meter-figure'),
          basis: px('main .mr-st-scene:not([data-leaving]) .mr-st-pv-basis'),
          basisText: document.querySelector('main .mr-st-scene:not([data-leaving]) .mr-st-pv-basis')!.textContent,
          item: px('main .mr-st-scene:not([data-leaving]) .mr-st-pv-item'),
          items: [...document.querySelectorAll('main .mr-st-scene:not([data-leaving]) .mr-st-pv-item')].filter((el) => el.getBoundingClientRect().height > 0).length,
        };
      });
      // On a phone the band stacks into one column and, with the card up, the card is the story.
      const phoneCard = page.viewportSize()!.width <= 720 && id !== 'hook';
      expect(Math.abs(story.figure - presenter.figure), `${id}: the figure is the presenter's size`).toBeLessThanOrEqual(0.5);
      expect(story.basis, `${id}: the basis is the presenter's size`).toBe(presenter.basis);
      expect(story.basisText, `${id}: the basis says what the presenter says`).toBe(presenter.basisText);
      expect(story.item, `${id}: the savers are the presenter's size`).toBe(presenter.item);
      expect(story.items, `${id}: the savers`).toBe(phoneCard ? 0 : 5);
      if (page.viewportSize()!.width === 1920) {
        expect(story.basis, `${id}: the basis at 1920`).toBe(28);
        expect(story.figure, `${id}: the figure at 1920`).toBeGreaterThanOrEqual(160);
      }
    }
    // The month to date stays on the meter beat, whose receipt lines add up to it.
    await showAt(page, STARTS[DOC.beats.findIndex((b) => b.id === 'meter')] + 1);
    await expect(page.locator(`${LIVE} .mr-st-basis`)).toHaveText('month to date');
    expect(errors()).toEqual([]);
  });

  test('the alert beat: the figure holds its place and size while the card slides in (P1-C01)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openStory(page);
    const alert = DOC.beats.findIndex((b) => b.id === 'alert');
    const figure = () =>
      page.locator(`${LIVE} [data-callout="saved"]`).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, font: parseFloat(getComputedStyle(el).fontSize) };
      });

    // Seeked: 200 ms in (no card yet), 800 ms in (the card sliding up, 450 ms from 0.4 s), and settled.
    await showAt(page, STARTS[alert] + 0.2);
    await expect(page.locator(`${LIVE} .mr-takeover`)).toHaveCount(0);
    const at200 = await figure();
    await showAt(page, STARTS[alert] + 0.8);
    await expect(page.locator(`${LIVE} .mr-takeover`)).toHaveCount(1);
    const sliding = await figure();
    await settle(page);
    const at800 = await figure();
    expect(sliding, 'the figure while the card slides in').toEqual(at200);
    expect(at800, 'the figure with the card up').toEqual(at200);
    if (page.viewportSize()!.width === 1920) expect(at200.font, 'the figure at 1920').toBeGreaterThanOrEqual(160);

    // Played: from the end of "watching" into the alert, every frame of its first 1.4 s holds the figure still
    // (the scene crossfades in, the card slides into room the figure never gave up).
    await showAt(page, STARTS[alert] - 0.25);
    const frames = await page.evaluate(async () => {
      (window as unknown as { __MR_STORY__: { resume(): void } }).__MR_STORY__.resume();
      const out: string[] = [];
      let card = false;
      const t0 = performance.now();
      while (performance.now() - t0 < 1_700) {
        const el = document.querySelector('main .mr-st-scene:not([data-leaving]) [data-callout="saved"]');
        if (el) {
          const r = el.getBoundingClientRect();
          out.push([r.x, r.y, r.width, r.height].map((v) => v.toFixed(1)).join(','));
          card ||= document.querySelector('main .mr-takeover') !== null;
        }
        await new Promise((done) => requestAnimationFrame(done));
      }
      return { boxes: out, card };
    });
    expect(frames.card, 'the card arrived while the frames were sampled').toBe(true);
    expect(frames.boxes.length).toBeGreaterThan(20);
    expect(new Set(frames.boxes), 'the figure moved during the alert beat').toEqual(new Set([frames.boxes[0]]));
    expect(errors()).toEqual([]);
  });

  test('the meter beat shows the figure its caption says; the watching chart frames the drop (P1-C04)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openStory(page);
    // The meter beat: a static whole-dollar figure, the caption's own, on both lines and after time passes.
    const meterBeat = DOC.beats.findIndex((b) => b.id === 'meter');
    const figure = page.locator(`${LIVE} [data-callout="saved"]`);
    for (const sec of [STARTS[meterBeat] + 1, STARTS[meterBeat] + DOC.beats[meterBeat].seconds - 0.5]) {
      await showAt(page, sec);
      await expect(figure).toHaveAttribute('data-ticking', 'false');
      await expect(figure).toHaveText(FACTS.saved);
    }
    await expect(page.locator('.mr-st-caption')).toHaveText(`Saved by Cribl: ${FACTS.saved}.`);
    await page.waitForTimeout(1_500);
    await expect(figure).toHaveText(FACTS.saved);

    // The watching beat, fully drawn: the minutes after the change span >= 30 % of the plot, and the shaded
    // loss says what it costs — the alert card's own $ a day.
    const watching = DOC.beats.findIndex((b) => b.id === 'watching');
    await showAt(page, STARTS[watching] + DOC.beats[watching].seconds - 0.5);
    await settle(page);
    const plot = await page.locator(`${LIVE} .mr-rw-svg`).evaluate((svg) => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
      };
      const grid = box(svg.querySelector('.mr-rw-grid line')!);
      const lost = box(svg.querySelector('.mr-rw-lost')!);
      const diamond = box(svg.querySelector('[data-callout="change-marker"]')!);
      const loss = svg.querySelector('.mr-rw-loss')!;
      const ticks = [...svg.querySelectorAll('.mr-rw-grid text')].map((t) => t.textContent);
      return { grid, lost, diamond, loss: box(loss), place: loss.getAttribute('data-place'), ticks };
    });
    expect(plot.lost.width / plot.grid.width, 'the after-the-change share of the plot').toBeGreaterThanOrEqual(0.3);
    expect(plot.ticks, 'the axis starts below the drop, not at zero').toEqual(['25%', '50%', '75%', '100%']);
    // The drop begins at the change, never before the diamond that marks it.
    expect(Math.abs(plot.lost.left - (plot.diamond.left + plot.diamond.right) / 2), 'the drop starts at the diamond').toBeLessThanOrEqual(1.5);
    await expect(page.locator(`${LIVE} .mr-rw-loss`)).toHaveText(`Losing ${FACTS.perDay} a day`);
    // The loss is named inside its shading when it fits, else over the baseline at the right: never across the line.
    if (plot.place === 'inside') {
      expect(plot.loss.left, 'loss label inside its shading').toBeGreaterThanOrEqual(plot.lost.left);
      expect(plot.loss.right).toBeLessThanOrEqual(plot.lost.right);
      expect(plot.loss.top).toBeGreaterThanOrEqual(plot.lost.top);
    } else {
      expect(plot.place).toBe('above');
      expect(plot.loss.bottom, 'loss label over the baseline').toBeLessThanOrEqual(plot.lost.top);
      expect(plot.loss.right).toBeLessThanOrEqual(plot.grid.right + 1);
    }
    if (page.viewportSize()!.width >= 1440) expect(plot.place, 'a desktop frame names the loss inside it').toBe('inside');
    expect(errors()).toEqual([]);
  });

  test("the meter beat's percentage names its basis the Receipt's way: of dollars, month to date", async ({ page }) => {
    await openStory(page);
    const meterBeat = DOC.beats.findIndex((b) => b.id === 'meter');
    await showAt(page, STARTS[meterBeat] + 1);
    // The same composition as the Receipt's hero (Receipt/index.tsx: receipt.savedPctBasis over PERIOD_CAPTION.mtd).
    const basis = t('receipt.savedPctBasis', { period: t('meter.period.mtd') });
    expect(basis).toBe('of dollars, month to date');
    const pct = page.locator(`${LIVE} [data-testid="receipt-saved-pct"]`);
    await expect(pct).toHaveAttribute('title', basis);
    await expect(pct.locator('.mr-visually-hidden')).toHaveText(` ${basis}`);
    await expect(page.locator(`${LIVE} .mr-st-basis`)).toHaveText(t('meter.period.mtd'));
  });

  test('reduced motion: states switch without animating', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openStory(page);
    await expect(page.locator('.mr-story')).toHaveAttribute('data-reduced', 'true');
    const watching = DOC.beats.findIndex((b) => b.id === 'watching');
    await showAt(page, STARTS[watching] + 0.5);
    // The ratio line is fully drawn at once; nothing is animating.
    await expect(page.locator('.mr-rw-value--after')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0);
    expect(await page.locator('.mr-st-caption').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });
});

test.describe('Story mode beauty @beauty', () => {
  test.setTimeout(420_000);
  const THEMES: readonly Theme[] = ['dark', 'light'];
  const SIZES = [
    { width: 1920, height: 1080 },
    { width: 390, height: 844 },
  ] as const;

  test('every beat at 390 and 1920 px, both themes', async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'one pass sets its own viewports');
    const errors = trackConsoleErrors(page);
    await openStory(page);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      for (const theme of THEMES) {
        await setTheme(page, theme);
        for (let i = 0; i < DOC.beats.length; i++) {
          const sec = showcaseSecond(i);
          await showAt(page, sec);
          await settle(page);
          await checkCallouts(page, sec);
          await page.screenshot({ path: `tests/report/beauty/story-${DOC.beats[i].id}-${theme}-${size.width}.png` });
        }
      }
    }
    expect(errors()).toEqual([]);
  });
});
