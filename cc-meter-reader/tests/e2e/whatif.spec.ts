// tests/e2e/whatif.spec.ts — the What-if calculator's polish (EPIC_AUDIT WP-J: P1-J01 … P1-J04).
//
// The What-if's functional tests (bases, dry run, Apply for real) live with the Flow view in flow.spec.ts;
// this spec holds the strip, the math, the slider, the states and the motion to their acceptance lines, on
// the emulator with the rig priced. Screenshots go to tests/report/screens/wave1-j-*.png from the desktop
// project (1440, and 390 by resizing) so two projects never write one file.

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { defaultSettings } from '../../core/settings.ts';
import { gotoApp, mockControl, resetMock, seedPrices, setTheme, trackConsoleErrors, waitForMock } from './helpers/index.ts';

const WS = 'default|mrd_windows_workstations|mrd_windows_workstations|mrd_siem_prod';
const DC = 'default|mrd_windows_dc|mrd_windows_dc|mrd_siem_prod';
const PAN = 'default|mrd_pan_firewall|mrd_pan_firewall|mrd_siem_prod';
const PAY = 'default|mrd_payments_api|mrd_payments_api|mrd_siem_prod';

const whatIfUrl = (stream: string, treatment: string, extra = ''): string => `/whatif?stream=${encodeURIComponent(stream)}&treatment=${treatment}${extra}`;

/** Prices the emulator's rig and opens a What-if URL once its results show. */
async function openWhatIf(page: Page, path: string, testId = 'whatif-results'): Promise<void> {
  await gotoApp(page, '/flow');
  // Let the lazy view finish loading before navigating on (a module load cut off by the next navigation is
  // logged as an error by Firefox and WebKit).
  await expect(page.getByTestId('flow-view')).toBeVisible({ timeout: 30_000 });
  await seedPrices(page);
  await gotoApp(page, path);
  await expect(page.getByTestId(testId)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500); // the first re-scale and the strip's roll settle
}

/** Only the desktop project writes the screenshots (the mobile one has DPR 3 and would race on the file). */
const shoots = (info: TestInfo): boolean => info.project.name === 'chromium';

/** The stage sizes (presenter): the projector, the laptop, a 720p capture and a phone. */
const STAGE_SIZES = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
];

/**
 * <prefix>-<name>-<theme>-<width>.png at 1440 and 390 (or `sizes`), both themes; back to light 1440 afterwards.
 * Wave 1's shots keep their wave1-j names; wave 2's pass `prefix: 'wave2-j'`.
 */
async function shootBoth(
  page: Page,
  info: TestInfo,
  name: string,
  opts: { fullPage?: boolean; locator?: string; prefix?: string; sizes?: { width: number; height: number }[] } = {},
): Promise<void> {
  if (!shoots(info)) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    for (const size of opts.sizes ?? [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(450);
      const tall = size.height === 720 ? `x${size.height}` : '';
      const path = `tests/report/screens/${opts.prefix ?? 'wave1-j'}-${name}-${theme}-${size.width}${tall}.png`;
      if (opts.locator) {
        // A full-page capture clipped to the element: the sticky nav stays at the top of the page, never over it.
        const clip = await page.locator(opts.locator).evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y + window.scrollY - 8), width: r.width + 16, height: r.height + 16 };
        });
        await page.screenshot({ path, fullPage: true, clip });
      } else await page.screenshot({ path, fullPage: opts.fullPage ?? true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, 'light');
}

/**
 * Every figure piece in the strip that runs past its cell's content box (measured by its rendered rectangle —
 * an inline span has no clientWidth to compare), every cell line whose content is wider than the line
 * (scrollWidth > clientWidth on the block), and the four cells' heights.
 */
function stripMetrics(page: Page) {
  return page.evaluate(() => {
    const strip = document.querySelector('[data-testid="whatif-compare"]') as HTMLElement;
    const contentBox = (cell: HTMLElement) => {
      const r = cell.getBoundingClientRect();
      const cs = getComputedStyle(cell);
      return { left: r.left + parseFloat(cs.paddingLeft), right: r.right - parseFloat(cs.paddingRight) };
    };
    const clipped = [...strip.querySelectorAll<HTMLElement>('.mr-num')]
      .filter((e) => {
        const box = contentBox(e.closest('.mr-whatif-cell') as HTMLElement);
        const r = e.getBoundingClientRect();
        return r.right > box.right + 0.5 || r.left < box.left - 0.5;
      })
      .map((e) => e.textContent);
    const overflowing = [...strip.querySelectorAll<HTMLElement>('.mr-whatif-cell > *')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent);
    const heights = [...strip.querySelectorAll<HTMLElement>('.mr-whatif-cell')].map((e) => Math.round(e.getBoundingClientRect().height * 10) / 10);
    const lines = [...strip.querySelectorAll<HTMLElement>('.mr-whatif-cell')].map((e) => e.querySelectorAll(':scope > dd').length);
    return { clipped, overflowing, heights, lines, text: strip.textContent ?? '' };
  });
}

test.describe('What if · the before → after strip (P1-J01)', () => {
  test('ranges fit the phone strip: no clipped figure, four equal cells, a change line in every cell', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    await openWhatIf(page, whatIfUrl(WS, 'aggressive-windows'));
    for (const size of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(300);
      const m = await stripMetrics(page);
      expect(m.clipped, `no figure is clipped at ${size.width}`).toEqual([]);
      expect(m.overflowing, `nothing runs past its cell at ${size.width}`).toEqual([]);
      expect(new Set(m.heights).size, `four equal cells at ${size.width}: ${m.heights.join(', ')}`).toBe(1);
    }
    // a range reaching $10,000 is compact; a byte range names its unit once
    const strip = page.getByTestId('whatif-compare');
    await expect(strip.locator('[data-cell="saved-year"]')).toContainText(/\$\d+(\.\d)?k–\$\d+(\.\d)?k \/ year/);
    await expect(strip.locator('[data-cell="volume"]')).toContainText(/\d+\.\d–\d+\.\d GB/);
    // cells 3 and 4 carry their change too
    await expect(strip.locator('[data-cell="ratio"] .mr-whatif-delta')).toHaveText(/^\+\d+–\d+ points$/);
    await expect(strip.locator('[data-cell="volume"] .mr-whatif-delta')).toHaveText(/^−\d+\.\d–\d+\.\d GB \/ day$/);
    await shootBoth(page, info, 'strip-aggressive', { locator: '[data-testid="whatif-compare"]' });
    expect(errors()).toEqual([]);
  });

  test('a stream that saves nothing today says its new figure once, tagged New', async ({ page }, info) => {
    await openWhatIf(page, whatIfUrl(WS, 'pack-windows'));
    const strip = page.getByTestId('whatif-compare');
    const day = strip.locator('[data-cell="saved-day"]');
    await expect(day.locator('.mr-whatif-new')).toHaveText('New');
    await expect(day.locator('.mr-whatif-delta')).toHaveCount(0);
    await expect(strip.locator('[data-cell="saved-year"] .mr-whatif-delta')).toHaveCount(0);
    const perDay = (await day.locator('[data-callout="per-day"]').innerText()).trim();
    expect(perDay).toMatch(/^\$\d+$/);
    const m = await stripMetrics(page);
    // "$66" once in the whole strip, and "$66 / day" once
    expect(m.text.split(perDay).length - 1, `${perDay} appears once in "${m.text}"`).toBe(1);
    expect(m.text.split(`${perDay} / day`).length - 1).toBe(1);
    expect(m.text).not.toContain('$0');
    // the ratio and the volume still show before → after and the change
    await expect(strip.locator('[data-cell="ratio"]')).toContainText(/0%→\s?33%\+33 points/);
    await expect(strip.locator('[data-cell="volume"] .mr-whatif-delta')).toHaveText(/^−\d+\.\d GB \/ day$/);
    // the hero is the one annual delta
    await expect(page.getByTestId('whatif-hero')).toContainText(/\+\$[\d,]+/);
    for (const size of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(300);
      const s = await stripMetrics(page);
      expect(s.clipped).toEqual([]);
      expect(new Set(s.heights).size, s.heights.join(', ')).toBe(1);
    }
    await shootBoth(page, info, 'strip-new', { locator: '[data-testid="whatif-compare"]' });
  });

  test('a stream that already saves shows before, → after and the change in every cell', async ({ page }, info) => {
    await openWhatIf(page, whatIfUrl(DC, 'aggressive-windows'));
    const strip = page.getByTestId('whatif-compare');
    for (const id of ['saved-day', 'saved-year', 'ratio', 'volume']) {
      const cell = strip.locator(`[data-cell="${id}"]`);
      await expect(cell.locator('.mr-whatif-before')).toBeVisible();
      await expect(cell.locator('.mr-whatif-delta')).toBeVisible();
    }
    await expect(strip.locator('[data-cell="saved-day"] .mr-whatif-delta')).toHaveText(/^\+\$\d+–\$\d+ \/ day$/);
    await expect(strip.locator('[data-cell="saved-year"] .mr-whatif-delta')).toHaveText(/^\+\$[\d.]+k–\$[\d.]+k \/ year$/);
    const m = await stripMetrics(page);
    expect(m.lines).toEqual([3, 3, 3, 3]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const phone = await stripMetrics(page);
    expect(phone.clipped).toEqual([]);
    expect(new Set(phone.heights).size, phone.heights.join(', ')).toBe(1);
    await page.setViewportSize({ width: 1440, height: 900 });
    await shootBoth(page, info, 'strip-dc');
  });

  test('a custom drop and a documented range keep the strip whole', async ({ page }) => {
    await openWhatIf(page, whatIfUrl(PAY, 'custom', '&drop=50'));
    let m = await stripMetrics(page);
    expect(m.clipped).toEqual([]);
    expect(m.lines).toEqual([3, 3, 3, 3]);
    await page.goto(whatIfUrl(PAN, 'pack-panos'));
    await expect(page.getByTestId('whatif-basis')).toHaveAttribute('data-basis', 'documented', { timeout: 30_000 });
    m = await stripMetrics(page);
    expect(m.clipped).toEqual([]);
    expect(new Set(m.heights).size).toBe(1);
  });
});

/** Text in the panel set under 12 px (visually hidden text excepted), as "text: size". */
function smallText(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="whatif-panel"]') as HTMLElement;
    const out: string[] = [];
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !(n.textContent ?? '').trim() || el.closest('.mr-visually-hidden, [hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) out.push(`${(n.textContent ?? '').trim()}: ${size}px`);
    }
    return out;
  });
}

test.describe('What if · Show the math, the slider and the type (P1-J02)', () => {
  test('Show the math sits under one rule, opens receipt lines with their units, and names the dry run only where one is offered', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    await openWhatIf(page, whatIfUrl(WS, 'pack-windows'));
    const box = page.getByTestId('whatif-math');
    const toggle = box.getByRole('button', { name: 'Show the math' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const rules = await box.evaluate((root) => {
      const visible = (el: Element, side: 'Top' | 'Bottom' | 'Left' | 'Right') => {
        const cs = getComputedStyle(el);
        return parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none' && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(cs[`border${side}Color`]);
      };
      const own = { top: visible(root, 'Top'), bottom: visible(root, 'Bottom'), left: visible(root, 'Left'), right: visible(root, 'Right') };
      const inner = [...root.querySelectorAll('*')].filter((el) => (['Top', 'Bottom', 'Left', 'Right'] as const).some((s) => visible(el, s))).map((el) => el.className);
      return { own, inner };
    });
    // one horizontal rule above the math, and no box inside the card
    expect(rules.own).toEqual({ top: true, bottom: false, left: false, right: false });
    expect(rules.inner).toEqual([]);
    // receipt lines: every value carries its unit ("Saved / day ····· $66 / day")
    const lines = box.locator('.mr-whatif-math-line');
    await expect(lines).toHaveCount(5);
    const values = lines.locator('.mr-whatif-math-value');
    for (let i = 0; i < 5; i++) await expect(values.nth(i)).toHaveText(/^\S+(\s\S+)?\/ (day|year)$/);
    await expect(lines.nth(3).locator('.mr-whatif-math-label')).toHaveText('Saved / day');
    await expect(values.nth(3)).toHaveText(/^\$\d+\/ day$/);
    await expect(values.nth(4)).toHaveText(/^\$[\d,]+\/ year$/);
    // the dry run is offered here (live data, a pack), so the math says how one works
    await expect(box.getByText(/preview API/)).toBeVisible();
    // label ····· value on one line, the formula under it — at 390 too
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.waitForTimeout(200);
      const geo = await lines.nth(0).evaluate((line) => {
        const r = (sel: string) => (line.querySelector(sel) as HTMLElement).getBoundingClientRect();
        return { label: r('.mr-whatif-math-label'), value: r('.mr-whatif-math-value'), formula: r('.mr-whatif-math-formula') };
      });
      expect(Math.abs(geo.label.bottom - geo.value.bottom), `label and value share a line at ${width}`).toBeLessThan(4);
      expect(geo.value.left, `the value sits right of its label at ${width}`).toBeGreaterThan(geo.label.right);
      expect(geo.formula.top, `the formula is under the line at ${width}`).toBeGreaterThanOrEqual(geo.label.bottom - 1);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await shootBoth(page, info, 'math', { locator: '[data-testid="whatif-panel"]' });
    // a custom drop has no dry run: its math says nothing about one
    await page.goto(whatIfUrl(PAY, 'custom', '&drop=40'));
    await expect(page.getByTestId('whatif-basis')).toHaveAttribute('data-basis', 'custom', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Show the math' }).click();
    await expect(page.getByTestId('whatif-math').locator('.mr-whatif-math-line')).toHaveCount(5);
    await expect(page.getByTestId('whatif-math').getByText(/preview API/)).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('the drop slider is drawn from Capra tokens: a 4 px track, a round tokenised thumb that follows the value, keyboard and pointer', async ({ page }, info) => {
    await openWhatIf(page, whatIfUrl(PAY, 'custom', '&drop=40'));
    const track = page.getByTestId('whatif-drop-track');
    const thumb = page.getByTestId('whatif-drop-thumb');
    const input = page.getByTestId('whatif-drop');
    const look = () =>
      page.evaluate(() => {
        const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;background:var(--cds2-color-background-accent-solid-default);border-color:var(--cds2-color-background-neutral-track)';
        document.body.appendChild(probe);
        const accent = getComputedStyle(probe).backgroundColor;
        const neutralTrack = getComputedStyle(probe).borderTopColor;
        probe.remove();
        const t = getComputedStyle(q('whatif-drop-track'));
        const th = getComputedStyle(q('whatif-drop-thumb'));
        const ind = getComputedStyle(q('whatif-drop-track').firstElementChild as HTMLElement);
        return {
          trackHeight: t.height,
          trackColor: t.backgroundColor,
          neutralTrack,
          indicatorColor: ind.backgroundColor,
          thumb: { w: th.width, h: th.height, radius: th.borderTopLeftRadius, bg: th.backgroundColor },
          accent,
          thumbBox: q('whatif-drop-thumb').getBoundingClientRect().toJSON() as DOMRect,
          trackBox: q('whatif-drop-track').getBoundingClientRect().toJSON() as DOMRect,
          inputOpacity: getComputedStyle(q('whatif-drop')).opacity,
        };
      });
    const a = await look();
    expect(a.trackHeight).toBe('4px');
    expect(a.trackColor).toBe(a.neutralTrack);
    expect(a.indicatorColor).toBe(a.accent);
    expect(a.thumb.w).toBe('16px');
    expect(a.thumb.h).toBe('16px');
    expect(parseFloat(a.thumb.radius)).toBeGreaterThanOrEqual(8);
    expect(a.thumb.bg).toBe(a.accent);
    // the native input is still the control (focusable, labelled), only transparent
    expect(a.inputOpacity).toBe('0');
    await expect(input).toHaveAttribute('aria-valuetext', '40%');
    // the thumb sits at 40 / 90 of the track, centred on it vertically
    const at = (b: typeof a) => (b.thumbBox.x + b.thumbBox.width / 2 - b.trackBox.x - 8) / (b.trackBox.width - 16);
    expect(at(a)).toBeCloseTo(40 / 90, 1);
    expect(Math.abs(a.thumbBox.y + a.thumbBox.height / 2 - (a.trackBox.y + a.trackBox.height / 2))).toBeLessThan(1);
    // keyboard: one step right is 45 %, and the focus ring lands on the drawn thumb
    await input.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/drop=45/);
    await expect(input).toHaveAttribute('aria-valuetext', '45%');
    const ring = await thumb.evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }));
    expect(ring).toEqual({ style: 'solid', width: '2px' });
    const b = await look();
    expect(at(b)).toBeCloseTo(45 / 90, 1);
    await shootBoth(page, info, 'slider-focus', { locator: '.mr-whatif-controls' });
    // pointer: a click two thirds along the track lands on 60 %
    const box = (await track.boundingBox())!;
    await page.mouse.click(box.x + 8 + (box.width - 16) * (60 / 90), box.y + 2);
    await expect(page).toHaveURL(/drop=60/);
    await expect(page.getByTestId('whatif-basis')).toContainText('60%');
    await shootBoth(page, info, 'custom', { locator: '[data-testid="whatif-panel"]' });
  });

  test('no text under 12 px anywhere in the panel, in every state', async ({ page }) => {
    test.setTimeout(120_000);
    await openWhatIf(page, whatIfUrl(WS, 'pack-windows'));
    await page.getByRole('button', { name: 'Show the math' }).click();
    for (const [path, basis] of [
      [whatIfUrl(WS, 'pack-windows'), 'similar'],
      [whatIfUrl(PAN, 'pack-panos'), 'documented'],
      [whatIfUrl(PAY, 'custom', '&drop=40'), 'custom'],
      [whatIfUrl(WS, 'aggressive-windows'), 'documented'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByTestId('whatif-basis')).toHaveAttribute('data-basis', basis, { timeout: 30_000 });
      await page.getByRole('button', { name: 'Show the math' }).click();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.waitForTimeout(200);
        expect(await smallText(page), `${path} at ${width}`).toEqual([]);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    // the basis tag is 12 px semibold
    const tag = await page.locator('.mr-whatif-basis-tag').evaluate((el) => ({ size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight }));
    expect(tag).toEqual({ size: '12px', weight: '600' });
  });

  test('the free column holds the dry run for a pack and the slider for a custom drop', async ({ page }) => {
    await openWhatIf(page, whatIfUrl(WS, 'pack-windows'));
    const controls = page.locator('.mr-whatif-controls');
    const dry = controls.getByRole('button', { name: 'Dry run on sample events' });
    await expect(dry).toBeVisible();
    const [field, hero, stream, treatment] = await Promise.all([dry, page.getByTestId('whatif-hero'), page.getByTestId('whatif-stream'), page.getByTestId('whatif-treatment')].map((l) => l.boundingBox()));
    if ((page.viewportSize()?.width ?? 0) > 1024) {
      // on a desktop it sits on the Stream/Treatment row, over the hero preview
      expect(field!.x).toBeGreaterThanOrEqual(hero!.x - 1);
      expect(Math.abs(field!.y + field!.height - (stream!.y + stream!.height))).toBeLessThan(2);
    } else {
      // stacked under the two fields on a narrow screen
      expect(field!.y).toBeGreaterThan(treatment!.y + treatment!.height);
    }
    await page.goto(whatIfUrl(PAY, 'custom', '&drop=40'));
    await expect(controls.getByTestId('whatif-drop')).toBeAttached({ timeout: 30_000 });
    await expect(controls.getByRole('button', { name: /dry run/i })).toHaveCount(0);
  });
});

/** Delays the app's snapshot read (GET …/kvstore/snapshot) by `ms`, before any page script runs. */
async function delaySnapshot(page: Page, ms: number): Promise<void> {
  await page.addInitScript((delay: number) => {
    const real = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/\/kvstore\/snapshot$/.test(new URL(url, location.href).pathname) && (init?.method ?? 'GET') === 'GET') await new Promise((r) => setTimeout(r, delay));
      return real(input, init);
    };
  }, ms);
}

/** The Windows workstations ribbon's sent band (its thickness at the destination), sampled every frame. */
async function recordBand(page: Page, ribbon: string, forMs: number): Promise<void> {
  await page.evaluate(
    ({ rib, ms }) => {
      const w = window as unknown as { __band: { t: number; w: number }[]; __bandStart: number };
      w.__band = [];
      w.__bandStart = performance.now();
      const step = () => {
        const d = document.querySelectorAll(`[data-ribbon="${rib}"] .mr-flow-band`)[1]?.getAttribute('d') ?? '';
        const n = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
        // M x0,top0 C xm,top0 xm,top1 x1,top1 L x1,top1+w …
        if (n.length > 9) w.__band.push({ t: performance.now() - w.__bandStart, w: n[9] - n[7] });
        if (!(window as unknown as { __bandStop?: boolean }).__bandStop && performance.now() - w.__bandStart < ms) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    { rib: ribbon, ms: forMs },
  );
}

/**
 * Logs the strip's saved-per-day figure on every frame (and whether an opacity animation — the reduced-motion
 * crossfade — runs on the results) from now on.
 */
async function startFigureLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __roll: string[]; __fades: number; __rollStop: boolean };
    w.__roll = [];
    w.__fades = 0;
    w.__rollStop = false;
    const step = () => {
      const el = document.querySelector('[data-cell="saved-day"] [data-callout="per-day"]');
      w.__roll.push((el?.textContent ?? '').trim());
      const results = document.querySelector('[data-testid="whatif-results"]');
      if (results?.getAnimations().some((a) => (a.effect as KeyframeEffect | null)?.getKeyframes().some((k) => k.opacity !== undefined))) w.__fades++;
      if (!w.__rollStop) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Waits until the figure has left `from` and held still for 600 ms, then stops the log and returns it. */
async function settledFigureLog(page: Page, from: string): Promise<{ roll: string[]; fades: number }> {
  await expect
    .poll(
      () =>
        page.evaluate((f) => {
          const w = window as unknown as { __roll: string[]; __rollHeld?: { v: string; at: number } };
          const v = w.__roll[w.__roll.length - 1];
          if (v === undefined || v === f) return false;
          if (!w.__rollHeld || w.__rollHeld.v !== v) w.__rollHeld = { v, at: performance.now() };
          return performance.now() - w.__rollHeld.at > 600;
        }, from),
      { timeout: 10_000, intervals: [100] },
    )
    .toBe(true);
  return page.evaluate(() => {
    const w = window as unknown as { __roll: string[]; __fades: number; __rollStop: boolean };
    w.__rollStop = true;
    return { roll: w.__roll, fades: w.__fades };
  });
}

test.describe('What if · states and motion (P1-J04)', () => {
  test('the hero caption keeps a space between its phrases, one per line', async ({ page }, info) => {
    await openWhatIf(page, whatIfUrl(WS, 'pack-windows'));
    const caption = page.getByTestId('whatif-hero-caption');
    const text = await caption.evaluate((el) => el.textContent ?? '');
    expect(text).toMatch(/^annualized, \+\$[\d,]+ from \$[\d,]+ today$/);
    const lines = await caption.locator('.mr-whatif-hero-line').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(lines).size, 'each phrase on its own line').toBe(lines.length);
    // a documented range adds where on the range the hero stands, as a third phrase
    await page.goto(whatIfUrl(PAN, 'pack-panos'));
    await expect(page.getByTestId('whatif-basis')).toHaveAttribute('data-basis', 'documented', { timeout: 30_000 });
    await expect(caption).toHaveText(/^annualized, \+\$[\d,]+ from \$[\d,]+ today at the middle of the documented range$/);
    await shootBoth(page, info, 'hero', { locator: '[data-testid="whatif-hero"]' });
  });

  test('loading shows the What-if skeleton (not the Flow map’s), then the calculator', async ({ page }, info) => {
    await gotoApp(page, '/flow');
    await expect(page.getByTestId('flow-view')).toBeVisible({ timeout: 30_000 });
    await seedPrices(page);
    await delaySnapshot(page, 6_000);
    await page.goto(whatIfUrl(WS, 'pack-windows'), { waitUntil: 'domcontentloaded' });
    await waitForMock(page);
    const skeleton = page.getByTestId('whatif-skeleton');
    await expect(skeleton).toBeVisible();
    await expect(page.locator('.mr-flowview-skeleton')).toHaveCount(0);
    // the calculator's own shape: two fields and the four-cell strip beside the hero
    await expect(skeleton.locator('.mr-whatif-skel-field')).toHaveCount(2);
    await expect(skeleton.locator('.mr-whatif-cell')).toHaveCount(4);
    await expect(skeleton.locator('.mr-whatif-hero--skeleton')).toHaveCount(1);
    if (shoots(info)) {
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme).catch(() => undefined);
        for (const size of [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(size);
          if (await skeleton.count()) await skeleton.screenshot({ path: `tests/report/screens/wave1-j-skeleton-${theme}-${size.width}.png` });
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await expect(page.getByTestId('whatif-results')).toBeVisible({ timeout: 30_000 });
    await expect(skeleton).toHaveCount(0);
  });

  test('nothing priced: the What-if says so in its own words', async ({ page }, info) => {
    await gotoApp(page, whatIfUrl(WS, 'pack-windows'));
    const empty = page.getByTestId('flow-empty-unpriced');
    await expect(empty).toBeVisible({ timeout: 30_000 });
    await expect(empty).toContainText('Set a price to project what a pack would save');
    await expect(empty).not.toContainText('on this map');
    await expect(empty.getByRole('button', { name: 'Set prices' })).toBeVisible();
    await shootBoth(page, info, 'unpriced', { locator: '[data-testid="flow-empty-unpriced"]' });
  });

  test('the dry run is one secondary button; its outcome is a neutral inline notice that names the fallback', async ({ page }, info) => {
    const errors = trackConsoleErrors(page, [/Failed to load resource: .*\b404\b/]);
    await openWhatIf(page, whatIfUrl(WS, 'pack-windows'));
    // The emulator answers the preview API (WP-O); the fallback needs a Leader without it.
    await mockControl(page, { action: 'fault', method: 'POST', pattern: '/preview$', status: 404, times: -1 });
    const control = page.getByTestId('whatif-dryrun');
    const button = control.getByRole('button', { name: 'Dry run on sample events' });
    await expect(control.getByRole('button')).toHaveCount(1);
    await button.click();
    await expect(control).not.toHaveAttribute('data-status', /idle|running/, { timeout: 30_000 });
    const notice = control.getByRole('status');
    await expect(notice).toContainText('The estimate stays on the similar stream.');
    await expect(notice).not.toContainText('Datagen');
    // the same one button, never a second style, and the notice is neutral (no accent or warning hue)
    await expect(control.getByRole('button')).toHaveCount(1);
    const tone = await notice.evaluate((el) => getComputedStyle(el.closest('.mr-whatif-dryrun-note') as HTMLElement).backgroundColor);
    const neutral = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.background = 'var(--cds2-color-background-neutral-subtle)';
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return c;
    });
    expect(tone).toBe(neutral);
    await shootBoth(page, info, 'dryrun-fallback', { locator: '[data-testid="whatif-panel"]' });
    expect(errors()).toEqual([]);
  });

  test('the card is revealed, not popped: 200 ms of opacity and a small rise', async ({ page }) => {
    await openWhatIf(page, whatIfUrl(WS, 'pack-windows'));
    const anim = await page.getByTestId('whatif-panel').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { name: cs.animationName, duration: cs.animationDuration };
    });
    expect(anim).toEqual({ name: 'mr-whatif-enter', duration: '0.2s' });
  });

  test('a projection is one ~400 ms morph of the band, with no overshoot', async ({ page, browserName }, info) => {
    test.skip(info.project.name === 'mobile', 'a phone shows the ranked list, not the map (F9)');
    // Painted-frame timing: Firefox and WebKit headless drop and delay frames on a loaded build machine, which
    // cuts the visible part of a time-based tween; the tween itself is the same JavaScript in every engine.
    test.skip(browserName !== 'chromium', 'frame timing is measured in Chromium');
    await gotoApp(page, '/flow');
    await expect(page.getByTestId('flow-view')).toBeVisible({ timeout: 30_000 });
    await seedPrices(page);
    await gotoApp(page, '/flow');
    const ribbon = page.locator(`[data-ribbon="${WS}"]`);
    await expect(ribbon).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    await recordBand(page, WS, 15_000);
    await page.getByRole('button', { name: 'What if…' }).click();
    await expect(page.getByTestId('projection-chip')).toBeVisible();
    await page.waitForTimeout(1_200); // the 400 ms morph, then still frames
    const rec = await page.evaluate(() => {
      const w = window as unknown as { __band: { t: number; w: number }[]; __bandStop: boolean };
      w.__bandStop = true;
      return w.__band;
    });
    expect(rec.length).toBeGreaterThan(10);
    const start = rec[0].w;
    const end = rec[rec.length - 1].w;
    expect(end, 'the projected band is thinner').toBeLessThan(start - 1);
    const moves = rec.filter((r, i) => i > 0 && Math.abs(r.w - rec[i - 1].w) > 0.05);
    const first = moves[0].t;
    const last = moves[moves.length - 1].t;
    // one move: the band never stands still on painted frames for more than 120 ms inside it (a frame the
    // browser never painted — a stalled main thread on a loaded machine — is not a pause in the motion)
    const frames = rec.slice(1).map((r, i) => r.t - rec[i].t).sort((a, b) => a - b);
    const frame = frames[Math.floor(frames.length / 2)];
    let lastMove = first;
    const pauses: number[] = [];
    for (const r of rec) {
      if (r.t < first || r.t > last) continue;
      if (moves.includes(r)) lastMove = r.t;
      else if (r.t - lastMove > 120) pauses.push(Math.round(r.t));
    }
    expect(pauses, `one contiguous move (${moves.map((m) => Math.round(m.t)).join(',')})`).toEqual([]);
    test.info().annotations.push({ type: 'morph', description: `${Math.round(last - first)} ms of painted motion, band ${start.toFixed(1)} → ${end.toFixed(1)} px` });
    // ~400 ms of ease-out (its last ~70 ms move less than 0.05 px a frame): not the old 200 ms second tween
    expect(last - first, `morph duration ${Math.round(last - first)} ms`).toBeGreaterThan(250);
    expect(last - first, `morph duration ${Math.round(last - first)} ms`).toBeLessThan(560 + frame);
    // no overshoot: every frame between the band's start and end
    const lo = Math.min(start, end) - 0.15;
    const hi = Math.max(start, end) + 0.15;
    expect(rec.filter((r) => r.w < lo || r.w > hi).map((r) => r.w)).toEqual([]);
    // and monotonic: it only ever narrows (to the path's own precision: its coordinates print to 0.1 px, so the
    // last eased frame and the settled layout can round a tenth apart)
    expect(moves.filter((m, i) => i > 0 && m.w > moves[i - 1].w + 0.15)).toEqual([]);
  });

  test('the strip rolls to a new drop over the same 400 ms', async ({ page }) => {
    await openWhatIf(page, whatIfUrl(PAY, 'custom', '&drop=10'));
    const cell = page.getByTestId('whatif-compare').locator('[data-cell="saved-day"] [data-callout="per-day"]');
    const from = (await cell.innerText()).trim();
    await startFigureLog(page);
    await page.getByTestId('whatif-drop').focus();
    await page.keyboard.press('End'); // 10 → 90 in one step
    await expect(page).toHaveURL(/drop=90/);
    const { roll } = await settledFigureLog(page, from);
    const seen = [...new Set(roll)];
    expect(seen[0]).toBe(from);
    expect(seen.length, `in-between figures: ${seen.join(' ')}`).toBeGreaterThanOrEqual(3);
  });

  test('reduced motion: the figures change at once and the strip crossfades instead of rolling', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openWhatIf(page, whatIfUrl(PAY, 'custom', '&drop=10'));
    const cell = page.getByTestId('whatif-compare').locator('[data-cell="saved-day"] [data-callout="per-day"]');
    const from = (await cell.innerText()).trim();
    await startFigureLog(page);
    await page.getByTestId('whatif-drop').focus();
    await page.keyboard.press('End'); // 10 → 90 in one step
    await expect(page).toHaveURL(/drop=90/);
    const { roll, fades } = await settledFigureLog(page, from);
    expect([...new Set(roll)], 'the figure jumps from the old value to the new one').toHaveLength(2);
    expect(fades, 'a crossfade ran on the results').toBeGreaterThan(0);
  });
});

test.describe('What if · projected against measured, after Apply for real (P1-J03)', () => {
  test('with ?applied= the strip, the hero and a Measured column stay; it fills in as sweeps arrive and the metric line reads the measured ratio', async ({ page }, info) => {
    test.setTimeout(150_000);
    // The emulator's handlers run in the page, so the page clock is the Leader's clock too (as in demo.spec.ts).
    await page.clock.install();
    await gotoApp(page, '/flow');
    await expect(page.getByTestId('flow-view')).toBeVisible({ timeout: 30_000 });
    await seedPrices(page);
    await gotoApp(page, '/flow');
    await expect(page.locator(`[data-ribbon="${WS}"], [data-testid="flow-list"] li`).first()).toBeVisible({ timeout: 30_000 });
    // "Apply for real" at `now`: the rig's lever puts the Windows XML pack on the workstations route, and the
    // URL freezes the projection (33 %, the similar stream's) and the ratio it ran before (0 %).
    const now = await page.evaluate(() => Date.now());
    await mockControl(page, { action: 'applyPack', routeId: 'mrd_windows_workstations', at: now });
    await gotoApp(page, whatIfUrl(WS, 'pack-windows', `&applied=${now}&projected=0.33&was=0`));
    const applied = page.getByTestId('whatif-applied');
    await expect(applied).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('whatif-panel')).toHaveAttribute('data-state', 'applied');
    // before a sweep has metered a minute after the change: the projection stands, the Measured column waits
    const ratio = page.getByTestId('whatif-measured-ratio');
    await expect(ratio).toHaveAttribute('data-state', 'waiting');
    await expect(page.getByTestId('whatif-actual')).toHaveText('Applied. Waiting for the next sweep to measure it.');
    await expect(page.getByTestId('whatif-applied-table').locator('[data-row="ratio"] td').nth(1)).toHaveText('33%');
    await expect(page.getByTestId('whatif-applied-hero')).toContainText('Saved by Cribl now reads');
    await shootBoth(page, info, 'applied-waiting', { locator: '[data-testid="whatif-panel"]' });

    // Sweeps arrive (fake time in sweep-sized steps; real time for each sweep's round-trips).
    const advanceUntil = async (until: () => Promise<boolean>, label: string, steps = 60) => {
      for (let i = 0; i < steps && !(await until()); i++) {
        await page.clock.fastForward(15_000);
        await page.waitForTimeout(600);
      }
      expect(await until(), label).toBe(true);
    };
    await advanceUntil(async () => (await ratio.getAttribute('data-state')) === 'measured', 'the first measured sweep lands');
    const line = page.getByTestId('whatif-actual');
    await expect(line).toHaveText(/^Projected 33%, measured \d+% after \d+\u00a0min$/);
    // A lever pulled outside this tab reaches the sweep's route inventory at its next timeline refresh (≤ 5 min,
    // core/sweep.ts step 4); until then the minute measures the old pipeline. The column follows every sweep.
    const pctOf = async () => Number((await page.getByTestId('whatif-actual-measured').innerText()).replace(/[^\d]/g, ''));
    await advanceUntil(async () => (await pctOf()) >= 25, 'the measured ratio reaches the pack', 50);
    const measured = (await page.getByTestId('whatif-actual-measured').innerText()).trim();
    // the whole Measured column reads, and it is the number the metric line says
    await expect(ratio).toHaveText(measured);
    for (const row of ['saved-day', 'volume']) await expect(page.getByTestId(`whatif-measured-${row}`)).toHaveAttribute('data-state', 'measured');
    await expect(page.getByTestId('whatif-measured-saved-day')).toHaveText(/^\$\d+$/);
    // it beats the 0 % the stream ran before, so it reads in the saved green; the hero names its yearly change
    await expect(ratio).toHaveAttribute('data-tone', 'saved');
    await expect(page.getByTestId('whatif-applied-measured-year')).toHaveText(/^This stream, measured: \+\$[\d,]+ a year$/);
    const minutes = async () => Number(/after (\d+)\s+min/.exec(await line.innerText())?.[1] ?? NaN);
    const firstMinutes = await minutes();
    await shootBoth(page, info, 'applied-measured', { locator: '[data-testid="whatif-panel"]' });

    // a later sweep: the measured figures follow it
    await advanceUntil(async () => (await minutes()) > firstMinutes, 'a later sweep moves the clock on the metric line');
    await expect(line).toHaveText(/^Projected 33%, measured \d+% after \d+\u00a0min$/);
    await expect(ratio).toHaveAttribute('data-state', 'measured');
  });

  test('a change that has not landed measures neutral, never a green 0 %', async ({ page }) => {
    test.setTimeout(120_000);
    await page.clock.install();
    await gotoApp(page, '/flow');
    await expect(page.getByTestId('flow-view')).toBeVisible({ timeout: 30_000 });
    await seedPrices(page);
    const now = await page.evaluate(() => Date.now());
    // no lever: the stream keeps running its old pipeline after the "apply"
    await gotoApp(page, whatIfUrl(WS, 'pack-windows', `&applied=${now}&projected=0.33&was=0`));
    const ratio = page.getByTestId('whatif-measured-ratio');
    await expect(ratio).toHaveAttribute('data-state', 'waiting', { timeout: 30_000 });
    for (let i = 0; i < 40 && (await ratio.getAttribute('data-state')) !== 'measured'; i++) {
      await page.clock.fastForward(15_000);
      await page.waitForTimeout(600);
    }
    await expect(ratio).toHaveAttribute('data-state', 'measured');
    await expect(ratio).toHaveText('0%');
    await expect(ratio).toHaveAttribute('data-tone', 'neutral');
    const colors = await page.evaluate(() => {
      const c = (sel: string) => getComputedStyle(document.querySelector(sel) as HTMLElement).color;
      return { measured: c('[data-testid="whatif-actual-measured"]'), projected: c('[data-testid="whatif-actual-projected"]') };
    });
    expect(colors.measured).toBe(colors.projected);
  });
});

// ─── P1-F13 · a pack only projects on the source it is written for ──────────

test.describe('What if · a treatment that does not fit the source (P1-F13)', () => {
  test('the Windows XML pack on a Palo Alto stream: the select captions it, nothing is projected, the fitting pack is one tap away', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    await openWhatIf(page, whatIfUrl(PAN, 'pack-windows'), 'whatif-not-applicable');
    const treatment = page.getByTestId('whatif-treatment');
    // the Windows tile is selected (from the URL) but disabled, and captioned (P2-W23 tiles)
    await expect(treatment.locator('input[data-treatment="pack-windows"]')).toBeDisabled();
    await expect(page.getByTestId('whatif-tile-foot-pack-windows')).toHaveText('Not for this stream: written for Windows event sources');
    const state = page.getByTestId('whatif-not-applicable');
    await expect(state).toContainText('The Windows XML pack does not fit Palo Alto firewall');
    await expect(state).toContainText('Nothing is projected.');
    // the projection is not computed: no strip, no hero, no math, no dry run, no ghosted stream on the map
    for (const id of ['whatif-results', 'whatif-compare', 'whatif-hero', 'whatif-math', 'whatif-dryrun']) await expect(page.getByTestId(id)).toHaveCount(0);
    await shootBoth(page, info, 'not-applicable', { locator: '[data-testid="whatif-panel"]', prefix: 'wave2-j' });
    await state.getByRole('button', { name: 'Try the Palo Alto + syslog packs' }).click();
    await expect(page).toHaveURL(/treatment=pack-panos/);
    await expect(page.getByTestId('whatif-results')).toBeVisible();
    await expect(page.getByTestId('whatif-tile-foot-pack-panos')).not.toContainText('Not for this stream');
    expect(errors()).toEqual([]);
  });

  test('a source no pack is written for offers a custom drop', async ({ page }) => {
    await openWhatIf(page, whatIfUrl(PAY, 'pack-vpc'), 'whatif-not-applicable');
    const state = page.getByTestId('whatif-not-applicable');
    await expect(state).toContainText('It is written for VPC Flow Logs');
    await expect(state.getByRole('button', { name: /^Try the / })).toHaveCount(0);
    await state.getByRole('button', { name: 'Try a custom drop' }).click();
    await expect(page).toHaveURL(/treatment=custom/);
    await expect(page.getByTestId('whatif-results')).toBeVisible();
  });
});

// ─── P2-W08 · the hero IS the receipt ───────────────────────────────────────

/** "$1,234" → 123_400_000 millicents (whole dollars, as the bar prints them). */
const dollarsToM = (s: string): number => Number(s.replace(/[^\d]/g, '')) * 100_000;

test.describe('What if · the hero is the receipt (P2-W08)', () => {
  test('the hero is the Receipt hero card: the Projection pill, a still figure, and a hatched segment as wide as the projected saved share', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    await openWhatIf(page, whatIfUrl(WS, 'pack-windows'));
    const hero = page.getByTestId('whatif-hero');
    await expect(hero).toHaveClass(/\bmr-hero\b/);
    await expect(hero).toHaveClass(/mr-hero--projection/);
    // no separate .mr-whatif-hero box in the projection
    await expect(page.getByTestId('whatif-results').locator('.mr-whatif-hero')).toHaveCount(0);
    await expect(hero.getByTestId('projection-pill')).toHaveText('Projection');
    await expect(hero.getByRole('heading', { name: 'Saved by Cribl would read' })).toBeVisible();
    // the perforated edge is the Receipt's (the card is masked to its teeth)
    expect(await hero.evaluate((el) => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage)).toMatch(/conic-gradient/);
    // the figure holds still (a preview never ticks) and reads in the display type
    const value = hero.getByTestId('whatif-hero-value');
    const first = await value.innerText();
    await page.waitForTimeout(1_500);
    expect(await value.innerText()).toBe(first);
    expect(parseFloat(await value.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(40);

    // The bar: paid grey, saved green, and the change hatched at the end of the green, as wide as its share.
    const seg = hero.getByTestId('rbar-projected');
    await expect(seg).toBeVisible();
    const geo = await hero.evaluate((el) => {
      const track = el.querySelector('.mr-rbar-track') as HTMLElement;
      const w = (sel: string) => (el.querySelector(sel) as HTMLElement).getBoundingClientRect().width;
      const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
      const seg = el.querySelector('[data-testid="rbar-projected"]') as HTMLElement;
      const cs = getComputedStyle(seg);
      return {
        track: track.getBoundingClientRect().width,
        gap,
        paid: w('.mr-rbar-paid'),
        saved: w('.mr-rbar-saved'),
        projected: w('[data-testid="rbar-projected"]'),
        share: Number(seg.dataset.share),
        hatch: cs.backgroundImage,
        border: cs.borderTopStyle,
        order: [...track.children].map((c) => c.className),
      };
    });
    expect(geo.order).toEqual(['mr-rbar-paid', 'mr-rbar-saved', 'mr-rbar-projected']);
    expect(geo.hatch).toMatch(/repeating-linear-gradient/);
    expect(geo.border).toBe('dashed');
    expect(Math.abs(geo.projected - geo.share * (geo.track - 2 * geo.gap))).toBeLessThan(1.5);
    // …and the share is the projected change over what you would have paid, as the bar's own labels print them
    const whp = dollarsToM((await hero.locator('.mr-rbar-whp .mr-rbar-amount').innerText()).trim());
    const delta = dollarsToM((await hero.getByTestId('rbar-projected-legend').locator('.mr-rbar-amount').innerText()).trim());
    expect(Math.abs(geo.share - delta / whp)).toBeLessThan(0.002);
    await expect(hero.getByTestId('rbar-projected-legend')).toHaveText(/^\+?\$[\d,]+ from this change$/);
    await expect(hero.locator('.mr-rbar-legend-paid')).toHaveText(/^You would pay \$[\d,]+$/);
    await shootBoth(page, info, 'hero-receipt', { locator: '[data-testid="whatif-hero"]', prefix: 'wave2-j' });
    await shootBoth(page, info, 'panel', { locator: '[data-testid="whatif-panel"]', prefix: 'wave2-j' });
    expect(errors()).toEqual([]);
  });

  test('a custom drop moves the hatched segment with the figure', async ({ page }) => {
    await openWhatIf(page, whatIfUrl(PAY, 'custom', '&drop=20'));
    const seg = page.getByTestId('rbar-projected');
    const at20 = Number(await seg.getAttribute('data-share'));
    await page.goto(whatIfUrl(PAY, 'custom', '&drop=60'));
    await expect(page.getByTestId('whatif-results')).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => Number(await page.getByTestId('rbar-projected').getAttribute('data-share'))).toBeGreaterThan(at20 * 2);
  });
});

// ─── P2-W23 · packs as tiles, the biggest unclaimed savings ─────────────────

test.describe('What if · packs as tiles and the biggest unclaimed savings (P2-W23)', () => {
  test('the treatment is a radio group of tiles with their ranges; a pack that does not fit is a disabled tile that says why', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    await openWhatIf(page, whatIfUrl(WS, 'pack-windows'));
    const group = page.getByTestId('whatif-treatment');
    await expect(group.getByRole('radio')).toHaveCount(5);
    await expect(group.getByRole('radio', { name: /^Windows XML pack/ })).toBeChecked();
    const ranges: Record<string, string> = {
      'pack-windows': '30%–35% documented',
      'pack-panos': '32%–51% documented',
      'pack-vpc': 'No published number',
      'aggressive-windows': '34%–70% documented',
      custom: 'Your drop: 20%',
    };
    for (const [k, text] of Object.entries(ranges)) await expect(page.getByTestId(`whatif-tile-range-${k}`)).toHaveText(text);
    // what this workspace already runs: the DC runs the Windows XML pack at 33 %
    await expect(page.getByTestId('whatif-tile-foot-pack-windows')).toHaveText('Runs on 1 stream here · 33%');
    await expect(page.getByTestId('whatif-tile-foot-pack-panos')).toHaveText('Not for this stream: written for Palo Alto firewall syslog');
    await expect(group.locator('input[data-treatment="pack-panos"]')).toBeDisabled();
    await expect(group.locator('input[data-treatment="pack-vpc"]')).toBeDisabled();
    await expect(group.locator('input[data-treatment="aggressive-windows"]')).toBeEnabled();
    await shootBoth(page, info, 'tiles', { locator: '[data-testid="whatif-panel"]', prefix: 'wave2-j' });
    // a tile is the control: picking the custom drop loads it
    await group.getByText('Custom: drop a share of bytes').click();
    await expect(page).toHaveURL(/treatment=custom/);
    await expect(page.getByTestId('whatif-drop')).toBeAttached();
    await expect(group.getByRole('radio', { name: /^Custom/ })).toBeChecked();
    // keyboard: arrows move between the enabled tiles
    await group.getByRole('radio', { name: /^Custom/ }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(/treatment=aggressive-windows/);
    expect(errors()).toEqual([]);
  });

  test('the unclaimed list is ranked, and its first line loads the highest estimate in the calculator', async ({ page }, info) => {
    await openWhatIf(page, whatIfUrl(PAY, 'custom', '&drop=20'));
    const list = page.getByTestId('whatif-unclaimed');
    await expect(list.getByRole('heading', { name: 'Biggest unclaimed savings' })).toBeVisible();
    const lines = list.locator('a.mr-whatif-unclaimed-line');
    const n = await lines.count();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(5);
    const deltas = await lines.evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.delta)));
    expect([...deltas].sort((a, b) => b - a)).toEqual(deltas);
    const first = lines.first();
    const stream = (await first.getAttribute('data-stream'))!;
    const treatment = (await first.getAttribute('data-treatment'))!;
    const amount = (await first.locator('.mr-rlist-amount').innerText()).trim();
    await shootBoth(page, info, 'unclaimed', { locator: '[data-testid="whatif-unclaimed"]', prefix: 'wave2-j' });
    await first.click();
    await expect(page).toHaveURL(new RegExp(`stream=${encodeURIComponent(stream).replace(/[|]/g, '\\|')}.*treatment=${treatment}|treatment=${treatment}.*stream=${encodeURIComponent(stream)}`));
    await expect(page.getByTestId('whatif-treatment').getByRole('radio', { checked: true })).toHaveAttribute('value', treatment);
    await expect(first).toHaveAttribute('aria-current', 'true');
    // the line's figure is the calculator's: the hero reads the same change a year
    await expect(page.getByTestId('whatif-hero-caption')).toContainText(amount.replace(/\s/g, ''));
  });
});

// ─── P2-W26 · a dry run over the group's samples ────────────────────────────

/**
 * A customer-shaped Palo Alto Source (syslog: no sample of its own) plus a disabled Datagen lab Source that
 * generates from the Palo Alto sample, and the two Leader calls the emulator lacks (the sample's content and
 * POST /preview), patched on window.fetch like flow.spec.ts's dry-run tests (MSW answers before page.route).
 */
async function stubSyslogPan(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __mrPreviewBodies: string[] };
    w.__mrPreviewBodies = [];
    const real = window.fetch.bind(window);
    const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, location.href).pathname;
      if (/\/m\/default\/system\/inputs$/.test(path) && (init?.method ?? 'GET') === 'GET') {
        const res = await real(input, init);
        const body = (await res.json()) as { count: number; items: Record<string, unknown>[] };
        const items = body.items.map((i) => (i.id === 'mrd_pan_firewall' ? { id: i.id, type: 'syslog', port: 9514 } : i));
        items.push({ id: 'pan_lab', type: 'datagen', disabled: true, samples: [{ sample: 'mrd_pan_traffic', eventsPerSec: 1 }] });
        return json(200, { count: items.length, items });
      }
      if (/\/m\/[^/]+\/system\/samples\/[^/]+\/content$/.test(path)) {
        return json(200, Array.from({ length: 10 }, (_, i) => ({ _raw: `<14>1 2026-09-26T12:00:0${i}Z fw1 - - - - 1,2026/09/26,TRAFFIC,${'y'.repeat(900)}`, _time: 1_790_000_000 + i })));
      }
      if (/\/m\/[^/]+\/preview$/.test(path) && (init?.method ?? 'GET') === 'POST') {
        const raw = String(init?.body ?? '');
        w.__mrPreviewBodies.push(raw);
        const req = JSON.parse(raw) as { pipelineId: string; events: { _raw: string; _time: number }[] };
        return json(200, { count: req.events.length, items: req.events.map((e, i) => ({ __id: i, _time: e._time, _raw: e._raw.slice(0, 600), cribl_pipe: req.pipelineId })) });
      }
      return real(input, init);
    };
  });
}

test.describe('What if · a dry run over the group’s samples (P2-W26)', () => {
  test('a Source with no sample of its own offers the group’s samples, and a picked one is measured and named', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    await stubSyslogPan(page);
    await openWhatIf(page, whatIfUrl(PAN, 'pack-panos'));
    await expect(page.getByTestId('whatif-basis')).toHaveAttribute('data-basis', 'documented');
    await page.getByRole('button', { name: 'Dry run on sample events' }).click();
    const control = page.getByTestId('whatif-dryrun');
    await expect(control).toHaveAttribute('data-status', 'no-sample', { timeout: 30_000 });
    await expect(control).toContainText('No dry run: this source has no sample file of its own to run through the pipeline.');
    const picker = page.getByTestId('whatif-sample-picker');
    await expect(picker).toBeVisible();
    await shootBoth(page, info, 'sample-picker', { locator: '[data-testid="whatif-panel"]', prefix: 'wave2-j' });
    await picker.getByRole('button').first().click();
    const first = page.getByRole('option').first();
    await expect(first).toHaveText(/^mrd_pan_traffic · from /); // the Palo Alto sample first, for a Palo Alto stream
    await first.click();
    const basis = page.getByTestId('whatif-basis');
    await expect(basis).toHaveAttribute('data-basis', 'dry-run', { timeout: 30_000 });
    await expect(basis).toContainText('Measured by dry run on 10 events of the sample mrd_pan_traffic:');
    await expect(basis).toContainText('through Palo Alto pack.');
    await expect(control).toHaveAttribute('data-status', 'measured');
    const bodies = await page.evaluate(() => (window as unknown as { __mrPreviewBodies: string[] }).__mrPreviewBodies);
    expect(bodies).toHaveLength(1);
    expect((JSON.parse(bodies[0]) as { pipelineId: string }).pipelineId).toBe('mrd_pan_pack');
    // "again" re-measures on the same picked sample
    await page.getByRole('button', { name: 'Dry run again' }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __mrPreviewBodies: string[] }).__mrPreviewBodies)).length).toBe(2);
    await expect(basis).toContainText('of the sample mrd_pan_traffic');
    await shootBoth(page, info, 'sample-measured', { locator: '[data-testid="whatif-panel"]', prefix: 'wave2-j' });
    expect(errors()).toEqual([]);
  });
});

// ─── P2-W06 · flip it on, watch it land ─────────────────────────────────────

interface StageHook {
  store: { getState(): { settings: Record<string, unknown> & { goodNewsEnabled: boolean }; snapshot: { incidents: unknown[] } | null }; setState(p: Record<string, unknown>): void };
  stop(): void;
}

/** A good-news incident on the Windows workstations route, as the detector opens it (born closed). */
function goodNews(appliedAt: number, landedAfterMs = 180_000): Record<string, unknown> {
  const at = (ms: number) => new Date(ms).toISOString();
  return {
    id: `inc_goodnews_${appliedAt}`,
    type: 'goodnews',
    severity: 'info',
    objectKey: 'route:default:mrd_windows_workstations',
    label: 'Windows workstations',
    outputId: 'mrd_siem_prod',
    openedAt: at(appliedAt + landedAfterMs),
    closedAt: at(appliedAt + landedAfterMs),
    cause: 'commit',
    commit: {
      hash: '7c2d410e9b',
      message: 'demo: apply the pack on mrd_windows_workstations',
      author: 's.koelpin',
      committedAt: at(appliedAt - 8_000),
      deployedAt: at(appliedAt),
      groupId: 'default',
      match: 'message',
    },
    before: 0,
    after: 0.33,
    impactPerDayM: 134_000_000,
    caughtInSec: Math.round(landedAfterMs / 1000),
    notes: ['demo-profile'],
    deliveries: [],
  };
}

/**
 * The What-if applied on Windows workstations at `appliedAt` (frozen projection 30–35 %, ran at 0 % before),
 * then — in-app, so the forecast stays in memory — the Receipt tab and P for the stage, polling paused.
 */
async function applyThenStage(page: Page, appliedAt: number, goodNewsEnabled: boolean): Promise<void> {
  await gotoApp(page, whatIfUrl(WS, 'pack-windows', `&applied=${appliedAt}&projected=0.3~0.35&was=0`));
  await expect(page.getByTestId('whatif-applied')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Receipt', exact: true }).first().click();
  await expect(page).toHaveURL(/\/(\?.*)?$/);
  await expect(page.getByTestId('receipt-hero')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('p');
  await page.waitForFunction(() => '__MR_PRESENTER__' in window);
  await expect(page.locator('.mr-pv-figure')).toBeVisible({ timeout: 30_000 });
  await page.evaluate((on) => {
    const h = (window as unknown as { __MR_PRESENTER__: StageHook }).__MR_PRESENTER__;
    h.stop();
    const { settings } = h.store.getState();
    h.store.setState({ settings: { ...settings, goodNewsEnabled: on } });
  }, goodNewsEnabled);
}

async function publishGoodNews(page: Page, incident: Record<string, unknown>): Promise<void> {
  await page.evaluate((inc) => {
    const h = (window as unknown as { __MR_PRESENTER__: StageHook }).__MR_PRESENTER__;
    const snap = h.store.getState().snapshot;
    if (!snap) throw new Error('no snapshot on stage');
    h.store.setState({ snapshot: { ...snap, incidents: [inc, ...snap.incidents] } });
  }, incident);
}

test.describe('What if · flip it on, watch it land (P2-W06)', () => {
  test('good news on the applied stream takes the stage in green, carrying the projection it proved', async ({ page }, info) => {
    test.setTimeout(150_000);
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/flow');
    await expect(page.getByTestId('flow-view')).toBeVisible({ timeout: 30_000 });
    await seedPrices(page);
    const appliedAt = await page.evaluate(() => Date.now());
    await applyThenStage(page, appliedAt, true);
    const card = page.getByTestId('landed-takeover');
    await expect(card).toHaveCount(0);

    await publishGoodNews(page, goodNews(appliedAt));
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-mode', 'landed');
    await expect(card).toHaveAttribute('role', 'status');
    await expect(card.locator('.mr-tk-title')).toHaveText('Savings improved: Windows workstations');
    await expect(page.getByTestId('landed-forecast')).toHaveText('What-ifProjected 30%–35%, measured 33% after 3 min');
    await expect(page.getByTestId('landed-money')).toHaveText('+$1,340 a day · +$489,100 a year');
    await expect(card.locator('[data-callout="commit"]')).toHaveText('7c2d410');
    await expect(card.locator('[data-callout="author"]')).toHaveText('s.koelpin');
    // saved green, not the alert's red: the band is the recovery's
    const band = await card.locator('.mr-tk-head').evaluate((el) => getComputedStyle(el).backgroundColor);
    const recovery = await page.evaluate(() => {
      const probe = document.createElement('section');
      probe.className = 'mr-takeover mr-takeover--recovered';
      probe.innerHTML = '<header class="mr-tk-head"></header>';
      // Inside the stage: it is dark on every account (P1-A07), so its tokens are the dark ones.
      (document.querySelector('.mr-pv') ?? document.body).appendChild(probe);
      const c = getComputedStyle(probe.querySelector('header') as HTMLElement).backgroundColor;
      probe.remove();
      return c;
    });
    expect(band).toBe(recovery);
    await page.waitForTimeout(600); // the 450 ms slide-up settles
    // the stage frames: the projector, the laptop, 720p and a phone, both themes (the card stays up 15 s,
    // so the shots re-publish it when it has gone)
    if (shoots(info)) {
      for (const theme of ['dark', 'light'] as const) {
        await setTheme(page, theme);
        for (const size of STAGE_SIZES) {
          await page.setViewportSize(size);
          if ((await card.count()) === 0) {
            await publishGoodNews(page, goodNews(appliedAt + Math.round(Math.random() * 1000)));
            await expect(card).toBeVisible();
          }
          await page.waitForTimeout(650);
          const tall = size.height === 720 ? 'x720' : '';
          await page.screenshot({ path: `tests/report/screens/wave2-j-landed-${theme}-${size.width}${tall}.png` });
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    // any key dismisses it, like the alert
    if ((await card.count()) === 0) {
      await publishGoodNews(page, goodNews(appliedAt + 7));
      await expect(card).toBeVisible();
    }
    await page.keyboard.press('x');
    await expect(card).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('the release build never opens one while the switch is off', async ({ page }) => {
    test.setTimeout(120_000);
    await gotoApp(page, '/flow');
    await expect(page.getByTestId('flow-view')).toBeVisible({ timeout: 30_000 });
    await seedPrices(page);
    const appliedAt = await page.evaluate(() => Date.now());
    await applyThenStage(page, appliedAt, false);
    await publishGoodNews(page, goodNews(appliedAt));
    await page.waitForTimeout(1_000);
    await expect(page.getByTestId('landed-takeover')).toHaveCount(0);
    await expect(page.locator('.mr-takeover')).toHaveCount(0);
  });
});

// Demo build only (VITE_MR_BUILD=demo MR_E2E_PORT=… npx playwright test tests/e2e/whatif.spec.ts -g "demo build"):
// the whole loop — Apply for real, the lever's commit, the sweeps that measure it, the detector's good news
// under the demo profile — ends on the stage in green with the projection the What-if made.
test.describe('What if · flip it on, watch it land (P2-W06, demo build)', () => {
  test('Apply for real on Windows workstations, then the sweeps at the projected ratio open the green takeover', async ({ page }, info) => {
    test.setTimeout(300_000);
    await page.clock.install();
    await gotoApp(page, '/flow');
    test.skip(!(await page.locator('footer').innerText()).includes('demo'), 'release build: no Apply for real');
    await resetMock(page);
    const settings = defaultSettings(new Date(await page.evaluate(() => Date.now())).toISOString(), 'America/Chicago');
    settings.demo = { ...settings.demo, enabled: true, profile: true };
    expect(settings.goodNewsEnabled).toBe(false); // the demo profile turns good news on by itself
    await page.evaluate(async (body) => {
      await fetch('/mock-api/v1/kvstore/settings', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body });
    }, JSON.stringify(settings));
    await seedPrices(page);
    await gotoApp(page, whatIfUrl(WS, 'pack-windows'));
    await expect(page.getByTestId('whatif-results')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Apply for real' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Apply for real' }).click();
    await expect(page).toHaveURL(/applied=\d+/, { timeout: 60_000 });
    const projected = decodeURIComponent(/projected=([^&]+)/.exec(page.url())?.[1] ?? '');
    expect(projected, 'the projection is frozen into the URL').toMatch(/^0\.\d+(~0\.\d+)?$/);

    // The stage, in-app (the forecast stays in memory): the Receipt tab, then P.
    await page.getByRole('link', { name: 'Receipt', exact: true }).first().click();
    await expect(page.getByTestId('receipt-hero')).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('p');
    await expect(page.locator('.mr-pv-figure')).toBeVisible({ timeout: 30_000 });

    const card = page.getByTestId('landed-takeover');
    for (let i = 0; i < 48 && (await card.count()) === 0; i++) {
      await page.clock.fastForward(15_000);
      await page.waitForTimeout(700);
    }
    await expect(card).toBeVisible();
    await expect(card.locator('.mr-tk-title')).toHaveText(/^Savings improved: /);
    await expect(page.getByTestId('landed-forecast')).toHaveText(/^What-ifProjected \d+%(–\d+%)?, measured \d+% after \d+\s+min$/);
    await expect(card.locator('[data-callout="author"]')).not.toHaveText('');
    if (info.project.name === 'chromium') {
      await page.waitForTimeout(600);
      await page.screenshot({ path: 'tests/report/screens/wave2-j-landed-demo-light-1440.png' });
    }
  });
});
