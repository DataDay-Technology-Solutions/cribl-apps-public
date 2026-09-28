// tests/e2e/name.spec.ts — Meter Reader is signed by its builder, Steve Koelpin, on the in-browser emulator: every place
// the name appears reads it, in both themes, at 1440 (chromium) and 390 (mobile); the presenter also at 1920
// (chromium-1920). Evidence: tests/report/screens/name-<place>-<theme>-<width>.png.
//
//   footer        the shell footer, beside the version (the Receipt on the sample tour)
//   first-run     the first-run card's eyebrow line
//   about         Settings → Runtime, the About line
//   prices        Settings → Prices, "set by" on the sample's price version (Show the math reads the same)
//   ledger        the sample's change timeline: the regression and most commits by Steve Koelpin
//   presenter     the wordmark: "Meter Reader by Steve Koelpin"
//   story-*       the title beat, the alert (deployed by), Slack (By, and the context line), Monday's receipt (the
//                 sign-off), the summary kicker and the ask's first caption ("Meter Reader by Steve Koelpin.")
//   report        the report card's preview: "Prepared by" and the footer's "Made with Meter Reader, built by …"

import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StoryDoc } from '../../core/types.ts';
import { beatStarts } from '../../src/story/timeline.ts';
import { gotoApp, resetMock, setTheme, trackConsoleErrors, type Theme } from './helpers/index.ts';

const NAME = 'Steve Koelpin';
const SCREENS = 'tests/report/screens';
const DOC = JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/story.json', import.meta.url)), 'utf8')) as StoryDoc;
const STARTS = beatStarts(DOC);
const beatAt = (id: string, late = 0.85): number => {
  const i = DOC.beats.findIndex((b) => b.id === id);
  return STARTS[i] + DOC.beats[i].seconds * late;
};

interface Size {
  width: number;
  height: number;
  project: string;
}
const DESKTOP: Size = { width: 1440, height: 900, project: 'chromium' };
const PHONE: Size = { width: 390, height: 844, project: 'mobile' };
const WIDE: Size = { width: 1920, height: 1080, project: 'chromium-1920' };
const THEMES: Theme[] = ['light', 'dark'];

const onlyOn = (info: TestInfo, s: Size): void => test.skip(info.project.name !== s.project, `${s.width} runs on ${s.project}`);

async function shot(page: Page, place: string, theme: Theme, s: Size, opts: { fullPage?: boolean; clip?: Locator } = {}): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const path = `${SCREENS}/name-${place}-${theme}-${s.width}.png`;
  if (opts.clip) await opts.clip.screenshot({ path });
  else await page.screenshot({ path, fullPage: opts.fullPage ?? false });
}

async function open(page: Page, path: string, s: Size, theme: Theme): Promise<void> {
  await page.setViewportSize({ width: s.width, height: s.height });
  await gotoApp(page, path);
  await setTheme(page, theme);
}

async function openStoryAt(page: Page, s: Size, theme: Theme, sec: number): Promise<void> {
  await open(page, '/?story=1', s, theme);
  await page.locator('.mr-story[data-ready="true"]').waitFor();
  await page.waitForFunction(() => '__MR_STORY__' in window);
  await page.evaluate((x) => {
    const api = (window as unknown as { __MR_STORY__: { pause(): void; seek(n: number): void } }).__MR_STORY__;
    api.pause();
    api.seek(x);
  }, sec);
  await page.waitForFunction(() => document.querySelector('.mr-st-scene[data-leaving]') === null, undefined, { timeout: 5_000 });
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), undefined, {
    timeout: 5_000,
  });
}

const LIVE = 'main .mr-st-scene:not([data-leaving])';

for (const s of [DESKTOP, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`signed by ${NAME} · ${theme} · ${s.width}`, () => {
      test('the footer, beside the version', async ({ page }, info) => {
        onlyOn(info, s);
        const errors = trackConsoleErrors(page);
        await open(page, '/?tour=1', s, theme);
        await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
        await expect(page.getByTestId('footer-sweep')).toHaveText('Showing sample data');
        const credit = page.getByTestId('footer-credit');
        await expect(credit).toHaveText(`Meter Reader · built by ${NAME}`);
        await expect(credit.locator('.mr-credit-name')).toHaveText(NAME);
        await expect(page.getByTestId('footer-build')).toHaveText(/^v\d+\.\d+\.\d+ · (release|demo build)$/);
        // The signature never runs off the frame.
        const box = await credit.boundingBox();
        expect(box && box.x + box.width).toBeLessThanOrEqual(s.width);
        await page.locator('.mr-footer').scrollIntoViewIfNeeded();
        await shot(page, 'footer', theme, s, { clip: page.locator('.mr-footer') });
        expect(errors()).toEqual([]);
      });

      test('the first-run card', async ({ page }, info) => {
        onlyOn(info, s);
        await open(page, '/first-run', s, theme);
        await resetMock(page);
        await gotoApp(page, '/first-run');
        await setTheme(page, theme);
        await expect(page.getByTestId('first-run-credit')).toHaveText(`Built by ${NAME}`);
        await shot(page, 'first-run', theme, s, { fullPage: true });
      });

      test('Settings → Runtime, the About line', async ({ page }, info) => {
        onlyOn(info, s);
        await open(page, '/settings?section=runtime&tour=1', s, theme);
        const about = page.getByTestId('runtime-credit');
        await expect(about).toHaveText(new RegExp(`^Meter Reader v\\d+\\.\\d+\\.\\d+ · built by ${NAME} · Apache\\u00a02\\.0\\u00a0license$`));
        await about.scrollIntoViewIfNeeded();
        await shot(page, 'about', theme, s, { clip: page.locator('section.mr-set-card[data-section="runtime"]') });
      });

      test('Settings → Prices, set by', async ({ page }, info) => {
        onlyOn(info, s);
        await open(page, '/settings?section=prices&tour=1', s, theme);
        const toggle = page.locator('[data-testid^="price-history-toggle-"]').first();
        await toggle.click();
        const by = page.getByTestId('price-history-by').first();
        await expect(by).toHaveText(`by ${NAME}`);
        await by.scrollIntoViewIfNeeded();
        await shot(page, 'prices', theme, s);
      });

      test('the Ledger: the regression and most of the timeline', async ({ page }, info) => {
        onlyOn(info, s);
        // The regression's own commit card, opened by its hash.
        await open(page, '/ledger?tour=1&commit=22d0a5e', s, theme);
        const card = page.getByTestId('commit-card');
        await expect(card).toContainText('Keep full payload on payments API errors');
        await expect(card.locator('.mr-ct-card-author')).toContainText(NAME);
        await card.scrollIntoViewIfNeeded();
        await shot(page, 'ledger', theme, s);
        // The changes list: most rows are his.
        const changes = page.getByTestId('changes-list');
        await changes.scrollIntoViewIfNeeded();
        const rows = changes.locator('[data-changes-row]');
        const authors = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
        expect(authors.filter((a) => a.includes('Steve Koelpin')).length).toBeGreaterThan(authors.length / 2);
        await shot(page, 'ledger-changes', theme, s, { clip: changes });
      });

      test('the presenter wordmark', async ({ page }, info) => {
        onlyOn(info, s);
        await open(page, '/?present=1&tour=1', s, theme);
        await expect(page.getByTestId('presenter-credit')).toHaveText(`by ${NAME}`);
        await expect(page.locator('.mr-pv-wordmark')).toHaveText(`Meter Reader by ${NAME}`);
        await shot(page, 'presenter', theme, s);
      });

      test('Story mode: the title, the alert, Slack, the receipt, the summary and the ask', async ({ page }, info) => {
        onlyOn(info, s);
        await openStoryAt(page, s, theme, beatAt('title'));
        await expect(page.locator(LIVE).getByTestId('story-credit')).toHaveText(`Built by ${NAME}`);
        await shot(page, 'story-title', theme, s);

        // The alert's second caption window: "Commit 22d0a5e, deployed by Steve Koelpin."
        await openStoryAt(page, s, theme, beatAt('alert', 0.5));
        await expect(page.locator('.mr-story')).toContainText(`deployed by ${NAME}`);
        await shot(page, 'story-alert', theme, s);

        await openStoryAt(page, s, theme, beatAt('slack'));
        await expect(page.locator(LIVE)).toContainText(`Meter Reader by ${NAME} · `);
        await shot(page, 'story-slack', theme, s);

        await openStoryAt(page, s, theme, beatAt('receipt', 0.95));
        const signOff = page.locator(LIVE).locator('.mr-slack-pre-line').last();
        await expect(signOff).toHaveText(new RegExp(`Meter Reader by ${NAME}$`));
        // The whole message, sign-off included, stays inside the frame and above the caption rail.
        const frame = await page.locator(LIVE).locator('.mr-st-slack').boundingBox();
        expect(frame && frame.y).toBeGreaterThanOrEqual(0);
        await shot(page, 'story-receipt', theme, s);

        await openStoryAt(page, s, theme, beatAt('summary'));
        await expect(page.locator(LIVE).getByTestId('story-summary-credit')).toHaveText(`Meter Reader by ${NAME}`);
        await shot(page, 'story-summary', theme, s);

        // The ask's first caption window signs the story; the ask follows in the second (D54: the vote ask on the
        // demo build only, the network to join on the release build this server usually runs).
        await openStoryAt(page, s, theme, beatAt('ask', 0.3));
        await expect(page.locator('.mr-st-rail')).toContainText(`Meter Reader by ${NAME}.`);
        await shot(page, 'story-ask', theme, s);
        await openStoryAt(page, s, theme, beatAt('ask', 0.8));
        await expect(page.locator('.mr-st-rail')).toContainText(
          process.env.VITE_MR_BUILD === 'demo' ? 'Customer track · vote in the CriblCon app.' : 'Join the Cribl Innovators Network.',
        );
        if (process.env.VITE_MR_BUILD !== 'demo') await expect(page.locator('.mr-st-rail')).not.toContainText('vote');
      });

      test('the report card: prepared by, and its footer', async ({ page }, info) => {
        onlyOn(info, s);
        await open(page, '/report?tour=1', s, theme);
        const preview = page.frameLocator('[data-testid="report-preview"]');
        await expect(preview.locator('footer .credit')).toHaveText(`Made with Meter Reader, built by ${NAME}`);
        await expect(preview.locator('footer .credit strong')).toHaveText(NAME);
        await expect(preview.locator('body')).toContainText(`Prepared by ${NAME}`);
        await shot(page, 'report', theme, s);
        // The preview's footer: the frame into view on the page, then the document scrolled to its end inside it.
        await page.getByTestId('report-preview').evaluate((el) => el.scrollIntoView({ block: 'end' }));
        await preview.locator('footer').evaluate((el) => el.scrollIntoView({ block: 'end' }));
        await shot(page, 'report-footer', theme, s);
      });
    });
  }
}

test.describe(`signed by ${NAME} · the stage at 1920`, () => {
  for (const theme of THEMES) {
    test(`the presenter wordmark · ${theme}`, async ({ page }, info) => {
      onlyOn(info, WIDE);
      await open(page, '/?present=1&tour=1', WIDE, theme);
      await expect(page.locator('.mr-pv-wordmark')).toHaveText(`Meter Reader by ${NAME}`);
      await shot(page, 'presenter', theme, WIDE);
    });
  }
});
