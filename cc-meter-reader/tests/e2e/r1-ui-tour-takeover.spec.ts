// r1 ui-11, FOUNDER_PLAN row 11 (L8): the tour's savings drop lands as the takeover card.
//   • Tour beat 2 (+25 s) puts the takeover card on the Receipt, under the SAMPLE DATA band, labelled sample ("Sample
//     data. Nothing is written to your workspace."), at 1440 × 900 and at 390 px, in the first screen.
//   • It never takes focus (role="alert" announces it); the close button is in the tab order and sends focus to the view;
//     Escape dismisses it (never while a dialog or drawer owns the key); it goes by itself 45 s after it landed.
//   • The tour carries on: its toasts still land at 25, 31, 70, 110 and 130 s. Closing the regression's toast by its
//     close button closes the card too (the capture harness's h.closeToast leaves a clean Receipt); the toast timing out
//     by itself does not.
//   • Receipt only: the Ledger, Flow and Settings never show it.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { gotoApp, resetMock, trackConsoleErrors } from './helpers/index.ts';

const REGRESSION = 'Savings dropped: Payments API sampling';
const NOTE = 'Sample data. Nothing is written to your workspace.';

/** Starts the sample tour from first run on an installed (fake) clock; the tour's second 0 is the click. */
async function startTour(page: Page): Promise<void> {
  await page.clock.install();
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await gotoApp(page, '/first-run');
  await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
  await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-mr-tour', 'running');
}

const takeover = (page: Page): Locator => page.getByTestId('tour-takeover');

/** A tour toast (Capra's toast root, role status or alert) whose body contains `text`. */
const toast = (page: Page, text: string): Locator =>
  page.locator(':is([role="status"], [role="alert"])').filter({ has: page.locator('[data-mr-toast]', { hasText: text }) });

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal page scroll').toBeLessThanOrEqual(0);
}

for (const vp of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const) {
  test.describe(`${vp.width} × ${vp.height}`, () => {
    test.use({ viewport: vp });

    test('+25 s: the card lands under the band, labelled sample, without taking focus; Escape dismisses it', async ({ page }) => {
      test.setTimeout(90_000);
      const errors = trackConsoleErrors(page);
      await startTour(page);
      await page.clock.fastForward(24_000);
      await expect(takeover(page)).toHaveCount(0);
      await page.clock.fastForward(2_000);

      // Landed between 24 and 26 s (25 ± 1), in the Receipt, with the band above it.
      const card = takeover(page);
      await expect(card).toBeVisible();
      await expect(page.getByRole('main').getByTestId('tour-takeover')).toHaveCount(1);
      await expect(card.getByRole('heading', { name: REGRESSION })).toBeVisible();
      await expect(card.getByRole('alert')).toBeVisible();
      await expect(card).toContainText(NOTE);
      const band = page.locator('[data-callout="sample-band"]');
      await expect(band).toBeVisible();
      if (vp.width > 640) await expect(band.getByText('Nothing is written to your workspace.')).toBeVisible();
      // Under the band, and in the first screen (its title at least; a phone scrolls for the rest).
      const bandBox = (await band.boundingBox())!;
      const title = (await card.getByRole('heading', { name: REGRESSION }).boundingBox())!;
      const cardBox = (await card.boundingBox())!;
      expect(cardBox.y).toBeGreaterThanOrEqual(bandBox.y + bandBox.height - 1);
      expect(title.y + title.height).toBeLessThanOrEqual(vp.height);
      if (vp.width > 640) expect(cardBox.y + cardBox.height, 'the whole card in the first screen').toBeLessThanOrEqual(vp.height);
      await noHorizontalScroll(page);
      // It never takes focus, and it carries no callout (the Receipt keeps one of each).
      expect(await card.evaluate((el) => el.contains(document.activeElement))).toBe(false);
      await expect(card.locator('[data-callout]')).toHaveCount(0);

      await page.keyboard.press('Escape');
      await expect(card).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute('data-mr-tour', 'running');
      // It does not come back.
      await page.clock.fastForward(3_000);
      await expect(card).toHaveCount(0);
      expect(errors()).toEqual([]);
    });

    test('the close button is in the tab order and sends focus to the view', async ({ page }) => {
      test.setTimeout(90_000);
      const errors = trackConsoleErrors(page);
      await startTour(page);
      await page.clock.fastForward(26_000);
      const card = takeover(page);
      await expect(card).toBeVisible();
      const close = card.getByRole('button', { name: 'Dismiss' });
      await close.focus();
      await expect(close).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(card).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName)).toBe('main');
      expect(errors()).toEqual([]);
    });
  });
}

test('reduced motion: the card fades in (no slide) and is fully shown', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await startTour(page);
  await page.clock.fastForward(26_000);
  const card = takeover(page);
  await expect(card).toBeVisible();
  // The card's own entrance moves nothing (a fade at most), and it settles at full opacity.
  const transforms = await card.evaluate((el) =>
    [el, ...el.querySelectorAll(':scope > .mr-takeover')]
      .flatMap((node) => node.getAnimations())
      .filter((a) => JSON.stringify((a.effect as KeyframeEffect | null)?.getKeyframes() ?? []).includes('transform')).length,
  );
  expect(transforms).toBe(0);
  await expect.poll(() => card.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
});

test('the tour carries on: toasts at 31, 70, 110 and 130 s; the card goes by itself at 70 s', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackConsoleErrors(page);
  await startTour(page);
  await page.clock.fastForward(25_500);
  await expect(toast(page, REGRESSION)).toBeVisible();
  const card = takeover(page);
  await expect(card).toBeVisible();

  await page.clock.fastForward(6_000); // 31.5 s: the delivery
  await expect(page.getByRole('button', { name: 'View message' })).toBeVisible();
  // The regression's toast times out by itself at ~34 s: the card stays.
  await page.clock.fastForward(8_000); // 39.5 s
  await expect(toast(page, REGRESSION)).toHaveCount(0);
  await expect(card).toBeVisible();

  await page.clock.fastForward(29_000); // 68.5 s: still up (landed at 25 s, 45 s)
  await expect(card).toBeVisible();
  await page.clock.fastForward(2_000); // 70.5 s: gone, and the spike's toast is up
  await expect(card).toHaveCount(0);
  await expect(page.getByText('Cost spike: Kubernetes prod').first()).toBeVisible();

  await page.clock.fastForward(40_000); // 110.5 s
  await expect(page.getByText('Savings back: Payments API sampling').first()).toBeVisible();
  await expect(card).toHaveCount(0); // the recovery is not a card on the Receipt
  await page.clock.fastForward(20_000); // 130.5 s
  await expect(page.getByRole('button', { name: 'View receipt' })).toBeVisible();
  expect(errors()).toEqual([]);
});

test("closing the regression's toast closes the card too (a clean Receipt for the capture harness)", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = trackConsoleErrors(page);
  await startTour(page);
  await page.clock.fastForward(26_000);
  const card = takeover(page);
  await expect(card).toBeVisible();
  await toast(page, REGRESSION)
    .getByRole('button', { name: /^(close|dismiss)$/i })
    .click();
  await expect(toast(page, REGRESSION)).toHaveCount(0);
  await expect(card).toHaveCount(0);
  expect(errors()).toEqual([]);
});

test('Receipt only: the Ledger never shows it, and Escape in a drawer stays with the drawer', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = trackConsoleErrors(page);
  await startTour(page);
  await page.clock.fastForward(26_000);
  const card = takeover(page);
  await expect(card).toBeVisible();

  // Show the math over the card: Escape closes the drawer, not the card.
  await page.getByRole('button', { name: 'Show the math' }).click();
  const drawer = page.getByTestId('math-drawer');
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(card).toBeVisible();

  await page.getByRole('navigation').getByRole('link', { name: /^Ledger/ }).first().click();
  await expect(page).toHaveURL(/\/ledger/);
  await expect(page.getByTestId('tour-takeover')).toHaveCount(0);
  expect(errors()).toEqual([]);
});
