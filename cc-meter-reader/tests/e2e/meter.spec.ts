// tests/e2e/meter.spec.ts — the Receipt Meter's frame cost on a phone (P1-B05), measured the way the motion
// audit measured it: the Tour's sample workspace (an enterprise-scale meter, ~37 cents a second) on a 390 px
// frame with the CPU throttled 4×, Chromium's own counters over CDP.
//
//   • idle: style recalculations per second while the figure ticks (the audit found ~57 — every frame wrote
//     a transform on all 8 wheel strips and the value attribute);
//   • scroll: no long frame over 50 ms caused by the Meter while the page scrolls under the ticking figure (long
//     animation frames, attributed by script), nor by the Receipt view: the audit's 59 ms long task was the view
//     re-rendering whole on the 1 Hz clock (src/lib/ticker.ts → src/views/Receipt/index.tsx); it now ticks only
//     while a custom range shows, and the leaves that print the time tick themselves (W3-RECEIPT-4);
//   • offscreen: the frame loop stops once the figure has scrolled out of view, and comes back when it returns.
//
// Chromium only (CDP); the numbers are printed so a regression shows its size, not just a red line.

import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { gotoApp, resetMock, setTheme, trackConsoleErrors, waitForHydration, waitForMock } from './helpers/index.ts';

const HERO = '[data-testid="receipt-hero"] [data-callout="saved"]';

async function openTour(page: Page): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await page.goto('/first-run', { waitUntil: 'domcontentloaded' });
  await waitForMock(page);
  await waitForHydration(page);
  await page.getByRole('button', { name: 'Tour with sample data' }).click();
  await page.locator(`${HERO}[data-ticking="true"]`).waitFor({ timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
}

async function metric(cdp: CDPSession, name: string): Promise<number> {
  const { metrics } = (await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] };
  return metrics.find((m) => m.name === name)?.value ?? 0;
}

/** Style recalculations per second over `ms`. */
async function recalcsPerSecond(page: Page, cdp: CDPSession, ms: number): Promise<number> {
  const a = await metric(cdp, 'RecalcStyleCount');
  const t0 = Date.now();
  await page.waitForTimeout(ms);
  const b = await metric(cdp, 'RecalcStyleCount');
  return (b - a) / ((Date.now() - t0) / 1000);
}

test.describe('Receipt Meter frame cost (P1-B05)', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP performance counters are Chromium-only');
  });

  test('at 4x CPU on a phone: < 15 style recalcs/s idle, no long task > 50 ms while scrolling, the loop pauses offscreen', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = trackConsoleErrors(page);
    await page.addInitScript(() => {
      interface LoafScript {
        invoker: string;
        sourceURL: string;
        duration: number;
      }
      const w = window as unknown as { __mrLongFrames: { duration: number; scripts: string[] }[] };
      w.__mrLongFrames = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as (PerformanceEntry & { scripts: LoafScript[] })[]) {
          if (e.duration <= 50) continue;
          w.__mrLongFrames.push({ duration: e.duration, scripts: e.scripts.map((x) => `${x.invoker} ${x.sourceURL.split('/').pop() ?? ''} ${Math.round(x.duration)}ms`) });
        }
      }).observe({ type: 'long-animation-frame', buffered: true });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await openTour(page);
    const hero = page.locator(HERO);
    await page.waitForTimeout(1_500); // the entry settles (period toggle, first sweep of the sample)

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    // Idle: the figure ticks at the sample's rate; the page is otherwise still.
    await expect(hero).toHaveAttribute('data-running', 'true');
    const idle = await recalcsPerSecond(page, cdp, 5_000);
    test.info().annotations.push({ type: 'recalcStylesPerSec.idle.4x', description: idle.toFixed(1) });
    expect(idle).toBeLessThan(15);

    // Scrolling under the ticking figure: no long frame over 50 ms caused by the Meter.
    await page.evaluate(() => ((window as unknown as { __mrLongFrames: unknown[] }).__mrLongFrames = []));
    await page.evaluate(async () => {
      const t0 = performance.now();
      await new Promise<void>((done) => {
        const step = (t: number) => {
          window.scrollBy(0, (t - t0) % 2_000 < 1_000 ? 6 : -6);
          if (t - t0 < 3_000) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
    });
    const longFrames = await page.evaluate(() => (window as unknown as { __mrLongFrames: { duration: number; scripts: string[] }[] }).__mrLongFrames);
    test.info().annotations.push({ type: 'longFrames.scroll.4x', description: JSON.stringify(longFrames) });
    const meterFrames = longFrames.filter((f) => f.scripts.some((x) => /Meter\.tsx|meterMath\.ts/.test(x)));
    expect(meterFrames).toEqual([]);
    // …nor by the Receipt view: it no longer re-renders whole on the 1 Hz clock (W3-RECEIPT-4, the rest of P1-B05).
    // The shared clock (src/lib/ticker.ts) still ticks the shell's few labels, a script of a few ms (18 ms at 4x on a
    // host at load 130); the Receipt re-rendering whole on it was a 56–74 ms script, so a clock callback of 35 ms or
    // more is the view's, as is any script in its own files.
    const scriptMs = (x: string): number => Number(/(\d+)ms$/.exec(x)?.[1] ?? 0);
    const receiptFrames = longFrames.filter((f) =>
      f.scripts.some((x) => /clock\.ts|Sections\.tsx|HeroCard\.tsx|Receipt\/index\.tsx/.test(x) || (/ticker\.ts/.test(x) && scriptMs(x) >= 35)),
    );
    expect(receiptFrames).toEqual([]);

    // Scrolled out of view: the loop stops (no frames, no timer, the spinning cents parked) and stays stopped;
    // back in view it runs again. (A re-render of the view still writes the current value to the attribute.)
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(hero).not.toBeInViewport();
    await expect(hero).toHaveAttribute('data-running', 'false');
    const parked = await hero.getAttribute('data-value-m');
    expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && (a.effect as KeyframeEffect | null)?.target?.closest('.mr-meter')).length)).toBe(0);
    await page.waitForTimeout(1_000);
    await expect(hero).toHaveAttribute('data-running', 'false');
    const offscreen = await recalcsPerSecond(page, cdp, 2_000);
    test.info().annotations.push({ type: 'recalcStylesPerSec.offscreen.4x', description: offscreen.toFixed(1) });
    expect(offscreen).toBeLessThan(3);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(hero).toBeInViewport();
    await expect(hero).toHaveAttribute('data-running', 'true');
    // Coming back jumps to where the money is now (the accrual while away), then keeps ticking.
    await expect.poll(async () => Number(await hero.getAttribute('data-value-m'))).toBeGreaterThan(Number(parked));
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    expect(errors()).toEqual([]);
  });

  // The unreadably fast wheel spins on the compositor, in step with the value; every other wheel still steps digit
  // by digit from the frame loop. Evidence in both themes.
  for (const width of [1440, 390] as const) {
    test(`the last cent spins on the compositor, the other wheels step from the loop (${width})`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await openTour(page);
      const hero = page.locator(HERO);
      await expect(hero).toHaveAttribute('data-running', 'true');
      const spins = () =>
        page.evaluate(() =>
          document
            .getAnimations()
            .filter((a) => a.playState === 'running')
            .map((a) => (a.effect as KeyframeEffect | null)?.target as Element | null)
            .filter((el): el is Element => !!el?.closest('[data-testid="receipt-hero"] .mr-meter'))
            .map((el) => (el.closest('.mr-meter-cents') ? 'cents' : 'dollars')),
        );
      // ~37 cents a second: only the last cent wheel is too fast to read (≥ 8 digits a second) and spins; the
      // tens of cents (~3.7 a second) and the dollars step from the frame loop.
      await expect.poll(spins).toEqual(['cents']);
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.evaluate(() => document.fonts.ready);
        await page.locator('[data-testid="receipt-hero"]').screenshot({ path: `tests/report/screens/wave1-b-meter-spin-${theme}-${width}.png` });
      }
      // Reduced motion: nothing spins, nothing ticks.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(hero).toHaveAttribute('data-ticking', 'false');
      expect(await spins()).toEqual([]);
      expect(errors()).toEqual([]);
    });
  }
});
