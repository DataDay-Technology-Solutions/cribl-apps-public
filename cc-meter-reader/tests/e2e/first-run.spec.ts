// tests/e2e/first-run.spec.ts — first run, empty and loading states (EPIC_AUDIT WP-M: P1-M01, P1-M02, P2-W27).
//
//   P1-M01  every empty state shows the ghost of what will fill it (the Flow and What-if maps a Sankey outline,
//           not table rows); the first-run primary reads as the primary (wider than the secondary); step 4 of
//           the strip fits two lines; Story's how-strip dims the steps still to come with a colour that still
//           reads (≥ 4.5:1 in both themes), never with opacity.
//   P1-M02  the tour survives a reload (a sticky ?tour=1); the pre-JS splash is the Receipt skeleton's shape.
//   P2-W27  the product explains itself: the first-run strip lights step by step (all at once under reduced
//           motion); the card's meter rolls to the sample's figure on hover / focus of the tour button; the
//           unpriced presenter still pitches (the strip at caption size, and the QR); the sample band reads
//           like a receipt stamp (perforated edge, striped cap only, Source Code Pro, the tour's beat).
//
// Evidence: tests/report/screens/wave1-m-<screen>-<theme>-<width>.png (the chromium project owns the files).
//
// Run: MR_E2E_PORT=5214 npx playwright test tests/e2e/first-run.spec.ts --project=chromium --project=chromium-1920 --project=mobile

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { StoryDoc } from '../../core/types.ts';
import { beatStarts } from '../../src/story/timeline.ts';
import { fmtDollars } from '../../core/format.ts';
import { fromIso } from '../../core/time.ts';
import { planRebase, rebaseHeadline, rebaseValue } from '../../src/tour/rebase.ts';
import type { TourFixture } from '../../src/tour/types.ts';
import { expectPath, gotoApp, kvGet, mockControl, resetMock, seedPrices, setTheme, trackConsoleErrors, type Theme } from './helpers/index.ts';

const TOUR_DOC = JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/tour.json', import.meta.url)), 'utf8')) as TourFixture;

/** The month to date the tour opens on now (src/tour/controller.ts sampleOpeningMtdM, recomputed here from rebase.ts). */
function tourOpeningMtdM(nowMs = Date.now()): number {
  const zone = TOUR_DOC.timezone || 'UTC';
  const plan = planRebase(fromIso(TOUR_DOC.anchor ?? TOUR_DOC.generatedAt), nowMs, zone);
  if (plan.dayShift === 0) return TOUR_DOC.snapshot.headline.mtdM;
  return rebaseHeadline(rebaseValue(TOUR_DOC.snapshot, plan), zone, TOUR_DOC.settings.criblCostCentsPerMonth).headline.mtdM;
}

const STORY_DOC = JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/story.json', import.meta.url)), 'utf8')) as StoryDoc;
const THEMES: readonly Theme[] = ['light', 'dark'];

/** A fresh emulated org with nothing in KV, then a reload: the judge's empty workspace. */
async function emptyWorkspace(page: Page, path = '/'): Promise<void> {
  await gotoApp(page, '/');
  await resetMock(page);
  await gotoApp(page, path);
}

/** Waits until nothing is animating and no how-it-works strip is still lighting its steps, then two frames. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getAnimations().every((a) => a.playState !== 'running') && !document.querySelector('.mr-how[data-sequence="playing"]'),
    undefined,
    { timeout: 5_000 },
  );
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/**
 * Firefox and WebKit reject a lazy view's dynamic import that the spec's own navigation cancelled (the reset
 * reload, a goto while a chunk is still on its way), and the page being left logs it through the view's error
 * boundary ("Importing a module script failed" / Firefox's unserialised "JSHandle@object"). It is not an app
 * fault — tests/e2e/tour.spec.ts "the story link and the Set prices path" fails the same way on WebKit on dev
 * (477a7d3) — and a view that really failed to load still fails the visible assertions. Chromium stays strict.
 */
function abortedByNavigation(): RegExp[] {
  const name = test.info().project.name;
  if (name !== 'firefox' && name !== 'webkit') return [];
  return [/Importing a module script failed/, /^JSHandle@object\s+The above error occurred in one of your React components/, /^\[meter-reader\] view crashed (JSHandle@object|TypeError: Importing a module script failed)/];
}

/** The Chromium projects write the evidence files; each names them by its own width (1440, 1920, 390). */
const ownsScreens = (): boolean => ['chromium', 'chromium-1920', 'mobile'].includes(test.info().project.name);

async function shoot(page: Page, name: string, theme: Theme, opts: { fullPage?: boolean; clip?: Locator } = {}): Promise<void> {
  if (!ownsScreens()) return;
  const width = page.viewportSize()?.width ?? 0;
  await settle(page);
  const path = `tests/report/screens/wave1-m-${name}-${theme}-${width}.png`;
  if (opts.clip) await opts.clip.screenshot({ path });
  else await page.screenshot({ path, fullPage: opts.fullPage ?? false });
}

/**
 * WCAG contrast of an element's text against the background it is actually painted on (the first opaque
 * background up the tree, translucent layers composited over it), plus the lowest opacity on the way up to
 * `rootSelector` — the dim the audit's axe run failed was an opacity, which a colour check alone would miss.
 */
function contrastOf(
  target: Locator,
  rootSelector: string,
  /** Elements whose own background is not what shows behind the text (a border painted and masked to an outline). */
  ignoreBackgroundOf = '',
): Promise<{ ratio: number; minOpacity: number; color: string; background: string }> {
  return target.evaluate((el, [root, ignore]) => {
    const parse = (c: string): [number, number, number, number] => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return [0, 0, 0, 0];
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const over = (top: [number, number, number, number], under: [number, number, number]): [number, number, number] => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
    ];
    const lum = ([r, g, b]: [number, number, number]): number => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    // Background: collect translucent layers until an opaque one, then composite bottom-up.
    const layers: [number, number, number, number][] = [];
    let minOpacity = 1;
    let node: Element | null = el;
    const stop = document.querySelector(root);
    while (node) {
      const cs = getComputedStyle(node);
      if (stop && stop.contains(node)) minOpacity = Math.min(minOpacity, Number(cs.opacity));
      const bg = ignore && node.matches(ignore) ? ([0, 0, 0, 0] as [number, number, number, number]) : parse(cs.backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 1) break;
      node = node.parentElement;
    }
    let base: [number, number, number] = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    const fg = over(parse(getComputedStyle(el).color), base);
    const [hi, lo] = [lum(fg), lum(base)].sort((a, b) => b - a);
    return {
      ratio: (hi + 0.05) / (lo + 0.05),
      minOpacity,
      color: getComputedStyle(el).color,
      background: `rgb(${base.map((v) => Math.round(v)).join(', ')})`,
    };
  }, [rootSelector, ignoreBackgroundOf] as const);
}

test.describe('P1-M01 · empty states show what will fill them; the first-run card reads right', () => {
  test('the Flow and What-if empty states render the Sankey ghost, not table rows', async ({ page }) => {
    await emptyWorkspace(page, '/flow');
    const errors = trackConsoleErrors(page, abortedByNavigation());
    const empty = page.getByTestId('flow-empty-unpriced');
    await expect(empty).toBeVisible();
    // The map's own frame with its Sankey ghost (P1-I07: six flows, two ribbons each), never table rows.
    await expect(empty.locator('[data-ghost="flow-map"]')).toBeVisible();
    await expect(empty.locator('[data-ghost="rows"]')).toHaveCount(0);
    await expect(empty.locator('[data-ghost="flow-map"] path.mr-ghost-ribbon')).toHaveCount(12);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await shoot(page, 'empty-flow', theme);
    }
    await setTheme(page, 'light');

    await page.goto('/whatif', { waitUntil: 'domcontentloaded' });
    const whatif = page.getByTestId('flow-empty-unpriced');
    await expect(whatif.locator('[data-ghost="flow-map"]')).toBeVisible();
    await expect(whatif.locator('[data-ghost="rows"]')).toHaveCount(0);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await shoot(page, 'empty-whatif', theme);
    }
    expect(errors()).toEqual([]);
  });

  test('the first-run primary is the wider button (side by side on desktop, stacked on a phone)', async ({ page }) => {
    await emptyWorkspace(page);
    await expectPath(page, '/first-run');
    const card = page.getByTestId('first-run');
    const primary = await card.getByRole('link', { name: 'Set prices to start the meter' }).boundingBox();
    const secondary = await card.getByRole('button', { name: 'Tour with sample data' }).boundingBox();
    expect(primary && secondary).toBeTruthy();
    const width = page.viewportSize()!.width;
    if (width > 640) {
      expect(primary!.width, 'primary wider than secondary').toBeGreaterThan(secondary!.width + 8);
      expect(Math.abs(primary!.y - secondary!.y), 'one row').toBeLessThan(2);
      expect(secondary!.x, 'secondary right of primary').toBeGreaterThan(primary!.x + primary!.width);
    } else {
      expect(secondary!.y, 'stacked').toBeGreaterThan(primary!.y + primary!.height - 1);
      expect(Math.abs(primary!.width - secondary!.width), 'full width each').toBeLessThan(2);
    }
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await shoot(page, 'firstrun', theme, { fullPage: true });
    }
  });

  test('at 390 px every tab, Settings included, sits inside the viewport on /first-run (craft review, round 1)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await emptyWorkspace(page);
    await expectPath(page, '/first-run');
    const status = page.locator('.mr-topnav-status .mr-status');
    await expect(status).toHaveAttribute('data-status', 'not-metering');
    // The dot alone, the label announced and in its tooltip.
    await expect(status.locator('.mr-status-label--short')).toBeHidden();
    await expect(status).toHaveAttribute('title', 'Not metering yet');
    expect(await status.ariaSnapshot()).toContain('Not metering yet');
    const tabs = page.locator('.mr-topnav-tabs a');
    await expect(tabs).toHaveCount(5);
    for (const tab of await tabs.all()) {
      const b = (await tab.boundingBox())!;
      expect(b.x, `${await tab.textContent()} starts in view`).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, `${await tab.textContent()} ends in view`).toBeLessThanOrEqual(390);
    }
    const settings = (await page.locator('.mr-topnav-tabs a[href*="/settings"]').boundingBox())!;
    const dot = (await status.locator('.mr-status-dot').boundingBox())!;
    expect(settings.x + settings.width, 'Settings clear of the status dot').toBeLessThanOrEqual(dot.x);
  });

  test('every step of the first-run strip fits on two lines', async ({ page }) => {
    await emptyWorkspace(page);
    const labels = page.getByTestId('first-run').locator('.mr-how-label');
    await expect(labels).toHaveCount(4);
    const lines = await labels.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight))),
    );
    for (const n of lines) expect(n).toBeLessThanOrEqual(2);
    await expect(labels.nth(3)).toHaveText('Alerts in dollars');
  });

  test("Story's how-strip dims the steps to come with a readable colour, never opacity (both themes)", async ({ page }) => {
    await gotoApp(page, '/?story=1');
    await page.locator('.mr-story[data-ready="true"]').waitFor();
    await page.waitForFunction(() => '__MR_STORY__' in window);
    const how = STORY_DOC.beats.findIndex((b) => b.id === 'how');
    const start = beatStarts(STORY_DOC)[how];
    // Early in the beat, while only the first step is lit (the strip lights a step a quarter of the way through a
    // beat that is now 3 s long, P2-W11).
    await page.evaluate((s) => {
      const api = (window as unknown as { __MR_STORY__: { pause(): void; seek(n: number): void } }).__MR_STORY__;
      api.pause();
      api.seek(s);
    }, start + STORY_DOC.beats[how].seconds * 0.1);
    await expect(page.locator('.mr-story')).toHaveAttribute('data-beat', 'how');
    const strip = page.locator('.mr-st-how .mr-how');
    await expect(strip.locator('li[data-active="false"]')).toHaveCount(3);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await settle(page);
      for (const step of [2, 3, 4]) {
        const li = strip.locator(`li[data-step="${step}"]`);
        await expect(li).toHaveAttribute('data-active', 'false');
        const label = await contrastOf(li.locator('.mr-how-label'), '.mr-st-how');
        expect(label.minOpacity, `step ${step} opacity (${theme})`).toBe(1);
        expect(label.ratio, `step ${step} label ${label.color} on ${label.background} (${theme})`).toBeGreaterThanOrEqual(4.5);
      }
      // Lit and dimmed still read as different (the dim is a real step down, not a no-op).
      const lit = await contrastOf(strip.locator('li[data-step="1"] .mr-how-label'), '.mr-st-how');
      const dim = await contrastOf(strip.locator('li[data-step="4"] .mr-how-label'), '.mr-st-how');
      expect(lit.color).not.toBe(dim.color);
      await shoot(page, 'story-how', theme, { clip: page.locator('.mr-st-how') });
    }
  });
});

/** The sample tour owns the screen: the band, the DOM flag and the sticky param. */
async function expectTourOn(page: Page): Promise<void> {
  await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-mr-tour', /running|paused|finished/);
  await expect.poll(() => new URL(page.url()).searchParams.get('tour')).toBe('1');
}

test.describe('P1-M02 · the tour survives a reload; the splash is the Receipt skeleton', () => {
  test.setTimeout(120_000);

  test('start the tour, reload → still the sample Receipt with the band; tabs, the presenter and Story keep it', async ({ page }) => {
    await emptyWorkspace(page);
    const errors = trackConsoleErrors(page, abortedByNavigation());
    await expectPath(page, '/first-run');
    await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
    await expectPath(page, '/');
    await expectTourOn(page);

    // A reload: the tour is in memory only, and the URL brings it back — never the first-run card.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectTourOn(page);
    await expectPath(page, '/');
    await expect(page.getByTestId('first-run')).toHaveCount(0);
    await expect(page.locator('main [data-callout="saved"]').first()).toBeVisible();

    // The param follows the tabs (sticky), so a reload on another view keeps the tour too.
    await page.getByRole('navigation').getByRole('link', { name: /flow/i }).first().click();
    await expectPath(page, '/flow');
    await expectTourOn(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectPath(page, '/flow');
    await expectTourOn(page);

    // The presenter opened by URL shows the sample workspace (the chip), not an empty stage.
    await page.goto('/?present=1&tour=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.mr-pv .mr-pv-chip--sample')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-mr-tour', /running|paused|finished/);

    // Story takes the sample screen while it plays; when it ends, the tour comes back.
    await page.goto('/?tour=1&story=1', { waitUntil: 'domcontentloaded' });
    await page.locator('.mr-story[data-ready="true"]').waitFor();
    await expect(page.locator('html')).not.toHaveAttribute('data-mr-tour', /.*/);
    await page.keyboard.press('Escape');
    await expect.poll(() => new URL(page.url()).searchParams.get('story')).toBeNull();
    await expectTourOn(page);

    // Clear sample data ends it for good: first run, no param, and a reload stays on first run.
    await page.locator('[data-callout="sample-band"]').getByRole('button', { name: 'Clear sample data' }).click();
    await expectPath(page, '/first-run');
    await expect.poll(() => new URL(page.url()).searchParams.get('tour')).toBeNull();
    await expect(page.getByTestId('first-run')).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('first-run')).toBeVisible();
    await expect(page.locator('[data-callout="sample-band"]')).toHaveCount(0);
    expect(await kvGet(page, 'settings')).toBeNull();
    expect(errors()).toEqual([]);
  });

  test("the pre-JS splash is the Receipt skeleton's shape: its number block lands within 8 px of the skeleton's", async ({ page, browser, baseURL }) => {
    const viewport = page.viewportSize()!;
    type Box = { x: number; y: number; width: number; height: number };

    // The skeleton: the Receipt while hydration is held back by the emulator's latency.
    await gotoApp(page, '/');
    await resetMock(page, { preset: 'demo' });
    await mockControl(page, { action: 'config', options: { latencyMs: 8_000 } });
    // Open `/` itself (a reload could land on /first-run, where the never-priced page was sent before the reset).
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const skeleton = page.getByTestId('receipt-skeleton');
    await skeleton.waitFor();
    const skel = (await skeleton.locator('.mr-skel--number').boundingBox()) as Box;
    const skelHero = (await skeleton.locator('.mr-hero--skeleton').boundingBox()) as Box;
    if (ownsScreens()) await page.screenshot({ path: `tests/report/screens/wave1-m-skeleton-light-${viewport.width}.png` });
    await mockControl(page, { action: 'config', options: { latencyMs: 0 } });

    // The splash: index.html as it paints before any script runs.
    for (const theme of THEMES) {
      const context = await browser.newContext({ baseURL, viewport, javaScriptEnabled: false, colorScheme: theme, serviceWorkers: 'block' });
      const splashPage = await context.newPage();
      await splashPage.goto('/', { waitUntil: 'load' });
      const splash = splashPage.locator('.mr-splash');
      await expect(splash).toBeVisible();
      const number = (await splash.locator('.mr-splash-number').boundingBox()) as Box;
      const hero = (await splash.locator('.mr-splash-hero').boundingBox()) as Box;
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(number[key] - skel[key]), `number block ${key}: splash ${number[key]} vs skeleton ${skel[key]}`).toBeLessThanOrEqual(8);
        expect(Math.abs(hero[key] - skelHero[key]), `hero card ${key}: splash ${hero[key]} vs skeleton ${skelHero[key]}`).toBeLessThanOrEqual(8);
      }
      if (ownsScreens()) await splashPage.screenshot({ path: `tests/report/screens/wave1-m-splash-${theme}-${viewport.width}.png` });
      await context.close();
    }
  });
});

/** Records, per animation frame, when each first-run step first reads data-active="true" (ms from the strip's first frame). */
async function recordStripTimeline(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __MR_HOW__?: { first: number; states: string[]; lit: Record<string, number> } };
    const tick = () => {
      const steps = [...document.querySelectorAll('[data-testid="first-run"] .mr-how li[data-step]')];
      if (steps.length === 4) {
        const now = performance.now();
        if (!w.__MR_HOW__) w.__MR_HOW__ = { first: now, states: steps.map((li) => li.getAttribute('data-active') ?? ''), lit: {} };
        for (const li of steps) {
          const step = li.getAttribute('data-step') ?? '';
          if (li.getAttribute('data-active') === 'true' && w.__MR_HOW__.lit[step] === undefined) w.__MR_HOW__.lit[step] = now - w.__MR_HOW__.first;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

type StripTimeline = { first: number; states: string[]; lit: Record<string, number> };
const stripTimeline = (page: Page): Promise<StripTimeline | undefined> =>
  page.evaluate(() => (window as unknown as { __MR_HOW__?: StripTimeline }).__MR_HOW__);

/** Each digit a card-meter wheel shows now: its strip's translateY over one cell's height (0 = the idle dash). */
function wheelReadings(page: Page): Promise<{ digit: string; cell: number }[]> {
  return page.locator('[data-testid="first-run-meter"] .mr-fr-meter-wheel').evaluateAll((wheels) =>
    wheels.map((wheel) => {
      const strip = wheel.firstElementChild as HTMLElement;
      const m = new DOMMatrixReadOnly(getComputedStyle(strip).transform);
      const cell = (strip.firstElementChild as HTMLElement).getBoundingClientRect().height;
      return { digit: wheel.getAttribute('data-digit') ?? '', cell: Math.round(-m.m42 / cell) };
    }),
  );
}

test.describe('P2-W27 · the product explains itself', () => {
  test.setTimeout(120_000);

  test('the first-run strip lights step by step over ~1.6 s, the hairline drawing ahead of it', async ({ page }) => {
    await recordStripTimeline(page);
    await emptyWorkspace(page);
    await expectPath(page, '/first-run');
    const strip = page.getByTestId('first-run').locator('.mr-how');
    await expect(strip).toHaveAttribute('data-sequence', 'done', { timeout: 5_000 });
    const timeline = (await stripTimeline(page))!;
    // It starts dim, then 1, 2, 3, 4 light in order, ~400 ms apart, all within about 1.6 s.
    expect(timeline.states).toEqual(['false', 'false', 'false', 'false']);
    const at = [1, 2, 3, 4].map((n) => timeline.lit[String(n)]);
    for (let i = 1; i < 4; i++) {
      expect(at[i] - at[i - 1], `step ${i + 1} after step ${i}`).toBeGreaterThan(250);
      expect(at[i] - at[i - 1], `step ${i + 1} after step ${i}`).toBeLessThan(900);
    }
    expect(at[3], 'the last step lights by ~1.6 s').toBeGreaterThan(1_100);
    expect(at[3], 'the last step lights by ~1.6 s').toBeLessThan(2_600);
    // The hairline ends fully drawn: the strip looks exactly like the static one.
    await expect(strip).toHaveCSS('--mr-how-drawn', '1');
    await expect(strip.locator('li[data-active="true"]')).toHaveCount(4);
  });

  test('under reduced motion every step is lit from the first frame and nothing draws', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await recordStripTimeline(page);
    await emptyWorkspace(page);
    await expectPath(page, '/first-run');
    await expect(page.getByTestId('first-run').locator('.mr-how li[data-active="true"]')).toHaveCount(4);
    const timeline = (await stripTimeline(page))!;
    expect(timeline.states).toEqual(['true', 'true', 'true', 'true']);
    expect(await page.getByTestId('first-run').locator('.mr-how').getAttribute('data-sequence')).toBeNull();
    // The card meter swaps without rolling.
    await page.getByTestId('start-tour').hover();
    await expect(page.getByTestId('first-run-meter')).toHaveAttribute('data-rolled', 'true');
    const running = await page.evaluate(
      () =>
        document.getAnimations().filter((a) => {
          // The app's reduced-motion base rule leaves 0.01 ms transitions behind; those are instant, not motion.
          const effect = a.effect as KeyframeEffect | null;
          const target = effect?.target;
          const duration = Number(effect?.getTiming().duration ?? 0);
          return a.playState === 'running' && duration > 1 && target instanceof Element && target.closest('[data-testid="first-run-meter"], .mr-how') !== null;
        }).length,
    );
    expect(running, 'nothing on the card animates').toBe(0);
  });

  test('hovering or focusing the tour button rolls the card meter to the figure the tour opens on', async ({ page }) => {
    await emptyWorkspace(page);
    const errors = trackConsoleErrors(page, abortedByNavigation());
    await expectPath(page, '/first-run');
    const meter = page.getByTestId('first-run-meter');
    const figure = meter.locator('.mr-fr-meter-figure');
    const expected = fmtDollars(tourOpeningMtdM());
    await expect(meter).toHaveAttribute('data-rolled', 'false');
    await settle(page);
    // Idle: every wheel on its dash ("$–––,–––"), dimmed but readable, never a display-size zero.
    expect((await wheelReadings(page)).every((w) => w.cell === 0)).toBe(true);
    await expect(meter.locator('.mr-fr-meter-caption')).toHaveText('Your number, once prices are set');
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await settle(page);
      for (const part of ['.mr-fr-meter-figure', '.mr-fr-meter-caption', '.mr-fr-meter-label']) {
        const c = await contrastOf(meter.locator(part), '[data-testid="first-run"]', '.mr-fr-meter');
        expect(c.ratio, `${part} ${c.color} on ${c.background} (${theme})`).toBeGreaterThanOrEqual(4.5);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await shoot(page, 'firstrun-meter-idle', theme);
    }
    await setTheme(page, 'light');

    // Hover: the wheels roll (running transitions), then read the sample's month to date.
    await page.getByTestId('start-tour').hover();
    await expect(meter).toHaveAttribute('data-rolled', 'true');
    await expect(figure).toHaveAttribute('data-value', expected);
    const rolling = await page.evaluate(
      () => document.getAnimations().filter((a) => (a as CSSTransition).transitionProperty === 'transform' && ((a as CSSTransition).effect as KeyframeEffect | null)?.target instanceof Element && (((a as CSSTransition).effect as KeyframeEffect).target as Element).classList.contains('mr-fr-meter-strip')).length,
    );
    expect(rolling, 'wheels roll').toBeGreaterThan(0);
    await settle(page);
    const readings = await wheelReadings(page);
    expect(readings.map((w) => w.cell - 1).join('')).toBe(expected.replace(/\D/g, ''));
    await expect(meter.locator('.mr-fr-meter-caption')).toHaveText('The sample workspace, month to date');
    await expect(meter.locator('.mr-visually-hidden')).toHaveText(`Saved by Cribl in the sample workspace: ${expected} month to date.`);
    // On a phone the hover scrolled the button into view: hold the roll with focus and go back to the top.
    if (page.viewportSize()!.width <= 640) {
      await page.getByTestId('start-tour').focus();
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await settle(page);
      await expect(meter).toHaveAttribute('data-rolled', 'true');
      const c = await contrastOf(figure, '[data-testid="first-run"]', '.mr-fr-meter');
      expect(c.ratio, `rolled figure ${c.color} on ${c.background} (${theme})`).toBeGreaterThanOrEqual(4.5);
      await shoot(page, 'firstrun-meter-rolled', theme);
    }
    // At 1440 × 900 the whole card, meter included, is on screen without scrolling.
    if (page.viewportSize()!.height === 900) {
      const card = (await page.getByTestId('first-run').boundingBox())!;
      expect(card.y + card.height).toBeLessThanOrEqual(900);
    }
    await setTheme(page, 'light');

    // Pointer away (and no focus): back to the dashes. Keyboard focus rolls it too.
    await page.getByTestId('start-tour').blur();
    await page.mouse.move(2, 2);
    await expect(meter).toHaveAttribute('data-rolled', 'false');
    await page.getByTestId('start-tour').focus();
    await expect(meter).toHaveAttribute('data-rolled', 'true');

    // The tour opens on the sample's annualized run rate (founder-build r1 ui-2: its Receipt defaults to Annualized); its
    // month to date is that same figure (plus the seconds it has ticked since).
    await page.getByTestId('start-tour').click();
    await expectPath(page, '/');
    await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'annualized');
    await page.getByRole('radio', { name: 'MTD' }).click();
    await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'mtd');
    const hero = page.locator('main .mr-meter-figure[data-callout="saved"]').first();
    await expect(hero).toHaveAttribute('data-value-m', /\d+/);
    const openedM = Number(await hero.getAttribute('data-value-m'));
    const cardM = tourOpeningMtdM();
    expect(openedM).toBeGreaterThanOrEqual(cardM - 100_000);
    expect(openedM - cardM, 'within $100 of the card (the seconds it has ticked since)').toBeLessThan(100 * 100_000);
    expect(errors()).toEqual([]);
  });

  test('the unpriced presenter still pitches: the four steps at caption size, and the QR', async ({ page }) => {
    await emptyWorkspace(page, '/?present=1');
    const errors = trackConsoleErrors(page, abortedByNavigation());
    const stage = page.locator('.mr-pv');
    await expect(stage).toBeVisible();
    await expect(stage.locator('.mr-pv-figure--empty')).toBeVisible();
    const strip = stage.locator('.mr-pv-how.mr-how--stage');
    await expect(strip).toBeVisible();
    await expect(strip.locator('li[data-step]')).toHaveCount(4);
    await expect(strip).toHaveAttribute('data-sequence', 'done', { timeout: 5_000 });
    await expect(stage.locator('[data-callout="qr"]')).toBeVisible();
    const sizes = await strip.locator('.mr-how-label').first().evaluate((el) => ({
      label: parseFloat(getComputedStyle(el).fontSize),
      caption: parseFloat(getComputedStyle(document.querySelector('.mr-pv-caption')!).fontSize),
    }));
    expect(sizes.label, 'labels at the caption size').toBeCloseTo(sizes.caption, 1);
    if (page.viewportSize()!.width === 1920) expect(sizes.label).toBeGreaterThanOrEqual(28);
    // Nothing on the stage overlaps: under the hero, left of the QR column, and the QR stays inside the frame.
    const box = (await strip.boundingBox())!;
    const hero = (await stage.locator('.mr-pv-hero').boundingBox())!;
    const qr = (await stage.locator('.mr-pv-qr').boundingBox())!;
    const { width, height } = page.viewportSize()!;
    expect(box.y, 'under the hero').toBeGreaterThanOrEqual(hero.y + hero.height);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    if (width > 720) {
      expect(box.x + box.width, 'left of the QR column').toBeLessThanOrEqual(qr.x);
      expect(qr.y + qr.height, 'the QR is not pushed off the frame').toBeLessThanOrEqual(height);
      // Every label fits two lines at stage size.
      const lines = await strip.locator('.mr-how-label').evaluateAll((els) =>
        els.map((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight))),
      );
      for (const n of lines) expect(n).toBeLessThanOrEqual(2);
    } else {
      expect(box.y + box.height, 'the strip comes before the savers').toBeLessThanOrEqual((await stage.locator('.mr-pv-savers').boundingBox())!.y);
    }
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await settle(page);
      await shoot(page, 'presenter-unpriced', theme);
    }
    // A laptop projector at 1280 × 720 (the chromium project also records it).
    if (test.info().project.name === 'chromium') {
      await page.setViewportSize({ width: 1280, height: 720 });
      const qr720 = (await stage.locator('.mr-pv-qr').boundingBox())!;
      const strip720 = (await strip.boundingBox())!;
      expect(qr720.y + qr720.height).toBeLessThanOrEqual(720);
      expect(strip720.x + strip720.width).toBeLessThanOrEqual(qr720.x);
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await settle(page);
        await page.screenshot({ path: `tests/report/screens/wave1-m-presenter-unpriced-${theme}-1280x720.png` });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    expect(errors()).toEqual([]);

    // Priced (waiting for the first sweep): no strip — the stage is about to have its number.
    await seedPrices(page);
    await gotoApp(page, '/?present=1');
    await expect(page.locator('.mr-pv')).toBeVisible();
    await expect(page.locator('.mr-pv .mr-how--stage')).toHaveCount(0);
  });

  test('the sample band reads like a stamp: perforated edge, striped cap only, Source Code Pro, and the tour beat', async ({ page }) => {
    await page.clock.install();
    await emptyWorkspace(page);
    const errors = trackConsoleErrors(page, abortedByNavigation());
    await expectPath(page, '/first-run');
    await page.getByTestId('start-tour').click();
    await expectPath(page, '/');
    const band = page.locator('[data-callout="sample-band"]');
    await expect(band).toBeVisible();
    const look = await band.evaluate((el) => {
      const cs = getComputedStyle(el);
      const cap = getComputedStyle(el.querySelector('.mr-sample-band-cap')!);
      const stamp = el.querySelector('.mr-sample-band-stamp')!;
      return {
        bandImage: cs.backgroundImage,
        mask: cs.maskImage || cs.getPropertyValue('-webkit-mask-image'),
        capImage: cap.backgroundImage,
        stampFont: getComputedStyle(stamp).fontFamily,
        stampText: (stamp as HTMLElement).innerText,
      };
    });
    expect(look.bandImage, 'the band itself is flat').toBe('none');
    expect(look.capImage, 'the stripe lives on the cap').toContain('repeating-linear-gradient');
    expect(look.mask, 'perforated lower edge').toContain('conic-gradient');
    expect(look.stampFont).toContain('Source Code Pro');
    expect(look.stampText).toBe('SAMPLE DATA');
    // Screen readers still get the whole sentence.
    await expect(band).toContainText('Sample data. This is how Meter Reader looks once it is metering your traffic.');

    const beats = 1 + new Set((JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/tour.json', import.meta.url)), 'utf8')) as { script: { at: number }[] }).script.map((s) => s.at)).size;
    const chip = band.getByTestId('sample-band-beat');
    const phone = page.viewportSize()!.width <= 640;
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('data-beats', String(beats));
    await expect(chip).toHaveAttribute('data-beat', '1');
    const visible = await chip.evaluate((el) => (el as HTMLElement).innerText.trim());
    expect(visible).toBe(phone ? `1 of ${beats}` : `Tour · beat 1 of ${beats}`);

    for (const theme of THEMES) {
      await setTheme(page, theme);
      await settle(page);
      for (const part of ['.mr-sample-band-stamp', ...(phone ? [] : ['.mr-sample-band-note']), '.mr-sample-band-beat']) {
        const c = await contrastOf(band.locator(part), '[data-callout="sample-band"]');
        expect(c.ratio, `${part} ${c.color} on ${c.background} (${theme})`).toBeGreaterThanOrEqual(4.5);
      }
      // One row: nothing in the band wraps onto a second line (40 px row + the 6 px teeth).
      expect((await band.boundingBox())!.height).toBeLessThanOrEqual(52);
      await shoot(page, 'sample-band', theme);
    }
    await setTheme(page, 'light');

    // The script moves on (its first scripted second is 25): the chip follows it.
    await page.clock.fastForward(26_000);
    await expect(chip).not.toHaveAttribute('data-beat', '1');
    expect(errors()).toEqual([]);
  });
});
