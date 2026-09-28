// tests/e2e/wave1-n.spec.ts — what WP-N (docs, pitch, packaging, policies) changed on screen in wave 1.
//
//   · Story mode's watching and receipt captions say what the release does (EPIC_AUDIT P0-12): it never changes a
//     pipeline, route, source or destination, and the weekly receipt is not promised for "every Monday".
//   · The tour's weekly-receipt toast and dialog qualify the receipt the same way (P0-12), about 130 s in.
//   · The Demo Console subtitle says who to share the demo build with (P0-22). Demo build only, on a server of
//     its own so the release-build server and other checkouts' emulators are left alone:
//
//       VITE_MR_MOCK=1 VITE_MR_BUILD=demo npx vite --port 15215 --strictPort &
//       MR_DEMO_BASE_URL=http://localhost:15215 MR_E2E_PORT=5215 npx playwright test tests/e2e/wave1-n.spec.ts
//
// Screens (Chromium projects only): tests/report/screens/wave1-n-<screen>-<theme>-<width>[x<height>].png, at the
// project's width; the 1920 project also shoots the Story frames at 1280 × 720 (a projector at 720p).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { StoryDoc } from '../../core/types.ts';
import { defaultSettings } from '../../core/settings.ts';
import { beatStarts, positionAt } from '../../src/story/timeline.ts';
import { expectPath, gotoApp, resetMock, seedPrices, setTheme, trackConsoleErrors, type Theme } from './helpers/index.ts';

const DOC = JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/story.json', import.meta.url)), 'utf8')) as StoryDoc;
const STARTS = beatStarts(DOC);
const THEMES: readonly Theme[] = ['light', 'dark'];

/** The copy this package wrote (src/copy/en.ts), as the screen must show it. */
const WATCHING = 'Meter Reader never changes a pipeline, route, source or destination.';
const RECEIPT = 'A weekly receipt goes to leadership. They never open Cribl.';
const TOAST_BODY = 'Leadership gets this in Slack, without opening Cribl.';
const DIALOG_CAPTION = 'Sent after Monday 12:00 UTC while Meter Reader is metering. Leadership never opens Cribl.';
const DEMO_SUBTITLE = 'Share this build only with the people running the demo: its write grants cover every pipeline, route and source in the workspace.';
/** What the copy must never say again (the P0-12 overclaims). */
const OVERCLAIM = /touches config|read-only|every Monday|minute and a half/i;

const project = (): string => test.info().project.name;
const shoots = (): boolean => project() === 'chromium' || project() === 'chromium-1920' || project() === 'mobile';

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), undefined, { timeout: 5_000 }).catch(() => undefined);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function shoot(page: Page, screen: string, theme: Theme, size?: { width: number; height: number }): Promise<void> {
  if (!shoots()) return;
  const vp = size ?? page.viewportSize() ?? { width: 0, height: 0 };
  const suffix = size && size.width === 1280 ? `${size.width}x${size.height}` : String(vp.width);
  await settle(page);
  await page.screenshot({ path: `tests/report/screens/wave1-n-${screen}-${theme}-${suffix}.png` });
}

// ─── Story mode ──────────────────────────────────────────────────────────────

async function openStory(page: Page): Promise<void> {
  await gotoApp(page, '/?story=1');
  await page.locator('.mr-story[data-ready="true"]').waitFor();
  await page.waitForFunction(() => '__MR_STORY__' in window);
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

const beatStart = (id: string): number => {
  const i = DOC.beats.findIndex((b) => b.id === id);
  expect(i, `beat ${id}`).toBeGreaterThanOrEqual(0);
  return STARTS[i];
};

test.describe('Story mode captions (P0-12)', () => {
  test('the watching and receipt beats say what the release does, in both themes', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openStory(page);
    const sizes = project() === 'chromium-1920' ? [undefined, { width: 1280, height: 720 }] : [undefined];
    for (const theme of THEMES) {
      await setTheme(page, theme);
      for (const size of sizes) {
        if (size) await page.setViewportSize(size);
        await showAt(page, beatStart('watching') + 0.5);
        await expect(page.locator('.mr-st-caption')).toHaveText(WATCHING);
        await shoot(page, 'story-watching', theme, size);
        await showAt(page, beatStart('receipt') + 0.5);
        await expect(page.locator('.mr-st-caption')).toHaveText(RECEIPT);
        await shoot(page, 'story-receipt', theme, size);
      }
      if (sizes.length > 1) await page.setViewportSize({ width: 1920, height: 1080 });
    }
    // No caption in the loop overclaims.
    const lines = DOC.beats.flatMap((b) => (Array.isArray(b.caption) ? b.caption : b.caption ? [b.caption] : []));
    expect(lines.filter((l) => OVERCLAIM.test(l))).toEqual([]);
    expect(errors()).toEqual([]);
  });
});

// ─── The tour's weekly receipt ───────────────────────────────────────────────

test.describe('the tour weekly receipt (P0-12)', () => {
  test('the toast and the receipt dialog qualify the weekly receipt', async ({ page }) => {
    test.skip(project() !== 'chromium' && project() !== 'mobile', 'a 130 s tour: the 1440 and 390 projects cover it');
    test.setTimeout(260_000);
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/');
    await resetMock(page);
    await gotoApp(page, '/');
    await expectPath(page, '/first-run');
    await page.getByRole('button', { name: 'Tour with sample data' }).click();
    await expectPath(page, '/');

    // ~130 s: Monday's receipt, as a toast with a View receipt action (on screen 12 s).
    const viewReceipt = page.getByRole('button', { name: 'View receipt' });
    await expect(viewReceipt).toBeVisible({ timeout: 200_000 });
    await expect(page.getByText(TOAST_BODY)).toBeVisible();
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await shoot(page, 'tour-weekly-toast', theme);
    }
    await viewReceipt.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Meter Reader — weekly receipt');
    await expect(dialog).toContainText(DIALOG_CAPTION);
    expect(await dialog.textContent()).not.toMatch(OVERCLAIM);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await shoot(page, 'tour-weekly-dialog', theme);
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    expect(errors()).toEqual([]);
  });
});

// ─── The Demo Console (demo build) ───────────────────────────────────────────

test.describe('the Demo Console subtitle (P0-22)', () => {
  if (process.env.MR_DEMO_BASE_URL) test.use({ baseURL: process.env.MR_DEMO_BASE_URL });

  async function kvPut(page: Page, key: string, value: unknown): Promise<void> {
    const status = await page.evaluate(
      async ({ k, v }) => (await fetch(`/mock-api/v1/kvstore/${k}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(v) })).status,
      { k: key, v: value },
    );
    expect(status, `PUT kvstore/${key}`).toBeLessThan(300);
  }

  test('says who to share the demo build with, in both themes', async ({ page }) => {
    test.skip(!process.env.MR_DEMO_BASE_URL, 'demo build only: start a demo server and set MR_DEMO_BASE_URL (see the header)');
    test.skip(project() !== 'chromium' && project() !== 'mobile', 'the 1440 and 390 projects cover it');
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/');
    await expect(page.locator('footer')).toContainText(/demo build/i);
    await resetMock(page);
    await seedPrices(page);
    const now = new Date(await page.evaluate(() => Date.now())).toISOString();
    await kvPut(page, 'settings', { ...defaultSettings(now, 'America/Chicago', 'ui'), demo: { enabled: true, replayMode: false, profile: true } });
    await kvPut(page, 'demo/state', { schemaVersion: 1, routes: {}, measuredLagSec: 127, trim: {}, rates: {}, muted: {} });
    await gotoApp(page, '/demo');
    const consoleView = page.getByTestId('demo-console');
    await expect(consoleView).toBeVisible();
    await expect(page.getByTestId('demo-off')).toHaveCount(0);
    await expect(consoleView).toContainText(DEMO_SUBTITLE);
    await expect(page.getByText('Metering live').first()).toBeVisible({ timeout: 45_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'horizontal page scroll').toBeLessThanOrEqual(0);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await shoot(page, 'demo-console', theme);
    }
    expect(errors()).toEqual([]);
  });
});
