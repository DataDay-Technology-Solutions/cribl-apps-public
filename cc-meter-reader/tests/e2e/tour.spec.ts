// tests/e2e/tour.spec.ts — First run + "Tour with sample data" (PRD 8.5, DESIGN_BRIEF 5.6, SPEC 15).
//
//   empty workspace → first run → Tour with sample data → the Receipt under the SAMPLE DATA band
//   (the fixture's month to date, ≈ $545k on the enterprise sample) → the regression card at ~25 s, its
//   Slack delivery at ~31 s → Clear sample data → back to first run, live, nothing written. Every figure
//   is read from demo/sample/tour.json, never typed.
//
// Beauty loop (PRD 8.8): screenshots of the first-run card and the tour Receipt in both themes at 390,
// 1440 and 1920 px land in tests/report/beauty/<screen>-<theme>-<width>.png.
//
// Run: npx playwright test tests/e2e/tour.spec.ts --project=chromium

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { Incident, Snapshot } from '../../core/types.ts';
import { weeklyReceiptAt } from '../../src/tour/engine.ts';
import { fmtDollars } from '../../core/format.ts';
import type { TourFixture } from '../../src/tour/types.ts';
import { planRebase, rebaseHeadline, rebaseValue } from '../../src/tour/rebase.ts';
import { expectPath, gotoApp, kvGet, resetMock, setTheme, trackConsoleErrors, type Theme } from './helpers/index.ts';

/** The fixture the tour plays. */
const TOUR = JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/tour.json', import.meta.url)), 'utf8')) as TourFixture;

/** The tour's month to date as the engine shows it today: the recorded days moved onto today (src/tour/rebase.ts). */
function movedMtdM(): number {
  const zone = TOUR.timezone || 'America/Chicago';
  const plan = planRebase(Date.parse(TOUR.anchor ?? TOUR.generatedAt), Date.now(), zone);
  return plan.dayShift === 0 ? TOUR.snapshot.headline.mtdM : rebaseHeadline(rebaseValue(TOUR.snapshot, plan), zone, TOUR.settings.criblCostCentsPerMonth).headline.mtdM;
}

/**
 * The weekly receipt the tour previews at 130 s (src/tour/engine.ts weeklyReceiptAt): the week before today, from the
 * hour rows of the snapshot on screen then (the script's last snapshot, moved onto today's date), in the page's zone.
 */
function sampleWeekReceipt() {
  const zone = TOUR.timezone || 'America/Chicago';
  const plan = planRebase(Date.parse(TOUR.anchor ?? TOUR.generatedAt), Date.now(), zone);
  const last = [...TOUR.script].reverse().find((st) => st.action === 'snapshot')!.payload as Snapshot;
  const moved = rebaseValue(last, plan);
  const snapshot = plan.dayShift === 0 ? moved : rebaseHeadline(moved, zone, TOUR.settings.criblCostCentsPerMonth);
  return weeklyReceiptAt(TOUR.weeklyReceipt, Date.now(), 'America/Chicago', { snapshot, labels: TOUR.settings.humanize })!;
}

/** The sample's annualized run rate as the tour shows it (the same move onto today's date). */
function movedAnnualizedM(): number {
  const zone = TOUR.timezone || 'America/Chicago';
  const plan = planRebase(Date.parse(TOUR.anchor ?? TOUR.generatedAt), Date.now(), zone);
  if (plan.dayShift === 0) return TOUR.snapshot.headline.annualizedM;
  return rebaseHeadline(rebaseValue(TOUR.snapshot, plan), zone, TOUR.settings.criblCostCentsPerMonth).headline.annualizedM;
}
const REG_AUTHOR = (TOUR.script.find((s) => s.action === 'incident.open')!.payload as Incident).commit!.author;
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const WIDTHS = [390, 1440, 1920] as const;
const HEIGHTS: Record<(typeof WIDTHS)[number], number> = { 390: 844, 1440: 900, 1920: 1080 };
const THEMES: readonly Theme[] = ['light', 'dark'];

const TITLE = 'Meter Reader prices every data flow and shows what Cribl saves.';
const REGRESSION = 'Savings dropped: Payments API sampling';

/** A fresh emulated org with nothing in KV, then a reload: the judge's empty workspace. */
async function emptyWorkspace(page: Page): Promise<void> {
  await gotoApp(page, '/');
  await resetMock(page);
  await gotoApp(page, '/');
  await expectPath(page, '/first-run');
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal page scroll').toBeLessThanOrEqual(0);
}

async function shoot(page: Page, screen: string, theme: Theme, width: (typeof WIDTHS)[number]): Promise<void> {
  await page.setViewportSize({ width, height: HEIGHTS[width] });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await noHorizontalScroll(page);
  await settle(page);
  await page.screenshot({ path: `tests/report/beauty/${screen}-${theme}-${width}.png`, fullPage: true });
}

/**
 * Waits until nothing is animating (a Capra modal fades in; a screenshot mid-fade reads as translucent). An
 * endless animation never settles — the Meter's fastest cent wheel spins for as long as the money runs (P1-B05) —
 * so, like story.spec's settle, it waits only for the finite ones.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
    undefined,
    { timeout: 5_000 },
  );
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/**
 * One project owns the screenshot files: the chromium project sets every width itself. The others would write
 * the same names (the mobile project's 3× touch context over the -1440 files; F28).
 */
const ownsScreens = (): boolean => test.info().project.name === 'chromium';

test.describe('first run and the sample tour', () => {
  test.setTimeout(180_000);

  test('empty workspace → first run → tour → Receipt with the band → regression at ~25 s → clear', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await emptyWorkspace(page);

    // ── The first-run card ─────────────────────────────────────────────────
    const card = page.getByTestId('first-run');
    await expect(card.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
    await expect(card.getByRole('list', { name: 'How it works' }).getByRole('listitem')).toHaveCount(4);
    // REVIEW-3a #3: the tab meters only once prices exist, so the primary action names that order.
    await expect(card.getByRole('link', { name: 'Set prices to start the meter' })).toHaveAttribute('href', /\/settings\/prices$/);
    await expect(card.getByRole('link', { name: 'Watch the 90-second story' })).toHaveAttribute('href', /story=1/);
    const w = TOUR.workspace;
    await expect(card).toContainText(new RegExp(`${w.sources}\\s+sources, ${w.destinations}\\s+destinations, ${w.historyDays}\\s+days of history`));
    await expect(card).toContainText('Nothing is written to your workspace.');

    // ── Start the tour ─────────────────────────────────────────────────────
    await card.getByRole('button', { name: 'Tour with sample data' }).click();
    const startedAt = Date.now();
    await expectPath(page, '/');
    await expect(page.locator('html')).toHaveAttribute('data-mr-tour', 'running');
    const band = page.locator('[data-callout="sample-band"]');
    await expect(band).toBeVisible();
    await expect(band).toContainText('Sample data. This is how Meter Reader looks once it is metering your traffic.');
    await expect(page.getByTestId('footer-sweep')).toHaveText('Showing sample data');

    // ── The Receipt shows the sample workspace: its annualized run rate first (founder-build r1 ui-2, about $8.1M a
    //    year), then, one click away, the fixture's month to date, ticking at its rate ──
    const meter = page.locator('main [data-callout="saved"][data-value-m], main [data-callout="saved"] [data-value-m]').first();
    await expect(meter).toBeVisible();
    await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'annualized');
    await expect.poll(async () => Number(await meter.getAttribute('data-value-m'))).toBe(movedAnnualizedM());
    await page.getByRole('radio', { name: 'MTD' }).click();
    await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'mtd');
    const dollars = Number(await meter.getAttribute('data-value-m')) / 100_000;
    const atSweep = movedMtdM() / 100_000;
    expect(dollars).toBeGreaterThan(atSweep - 1);
    expect(dollars).toBeLessThan(atSweep + (60 * TOUR.snapshot.ratePerSecM) / 100_000 + 1);

    // ── The regression fires at ~25 s (toast + the Receipt's alert card) ───
    await expect(page.getByText(REGRESSION).first()).toBeVisible({ timeout: 45_000 });
    const firedAfter = (Date.now() - startedAt) / 1000;
    expect(firedAfter).toBeGreaterThan(20);
    expect(firedAfter).toBeLessThan(38);
    await expect(page.getByText(new RegExp(`Commit [0-9a-f]{7} by ${escapeRe(REG_AUTHOR)}, caught in 2:51`)).first()).toBeVisible();
    await expect(page.getByRole('main').getByText(REGRESSION).first()).toBeVisible();

    // ── Its delivery at ~31 s, and the message it sent ─────────────────────
    const viewMessage = page.getByRole('button', { name: 'View message' });
    await expect(viewMessage).toBeVisible({ timeout: 15_000 });
    // A notification target: Cribl accepted it for delivery (craft review, round 1), not "Sent" — the toast says so too
    // (founder-build r1 ui-7, m1).
    await expect(page.getByText(/^Handed to Cribl for FinOps alerts ✓/).first()).toBeVisible();
    await expect(page.getByText(/^Sent to FinOps alerts/)).toHaveCount(0);
    await viewMessage.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // What the target received: the plain text a release target gets (as Settings previews it), no Block Kit card.
    await expect(dialog.getByRole('heading', { name: 'Handed to Cribl for FinOps alerts' })).toBeVisible();
    await expect(dialog.locator('[data-callout="target-message"]')).toContainText(REGRESSION);
    await expect(dialog.locator('[data-callout="target-message"]')).toContainText(/[Cc]aught in 2:51/);
    await expect(dialog.locator('[data-callout="slack-message"]')).toHaveCount(0);
    await expect(dialog.locator('.mr-slack-fields, .mr-slack-field')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // ── The sample's Settings agree: its FinOps target reads connected (m1) ───
    await page.getByRole('navigation').getByRole('link', { name: 'Settings', exact: true }).first().click();
    await expect(page.locator('.mr-settings-layout')).toBeVisible();
    const railLink = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: /^Where to send alerts/ });
    if (await railLink.isVisible()) await railLink.click();
    else {
      await page.getByRole('button', { name: /Section/ }).click();
      await page.getByRole('option', { name: /^Where to send alerts/ }).click();
    }
    await expect(page.getByTestId('endpoint-0-relay')).toHaveAttribute('data-relay', 'ready', { timeout: 15_000 });
    await expect(page.getByTestId('endpoint-0-relay')).toHaveText('Connected. Alerts reach finops_slack through Cribl.');
    await page.getByRole('navigation').getByRole('link', { name: 'Receipt', exact: true }).first().click();
    await expectPath(page, '/');

    // ── Clear sample data → back to first run, live, nothing written ───────
    await band.getByRole('button', { name: 'Clear sample data' }).click();
    await expectPath(page, '/first-run');
    await expect(band).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveAttribute('data-mr-tour', /.*/);
    await expect(page.getByTestId('first-run')).toBeVisible();
    expect(await kvGet(page, 'settings')).toBeNull();
    expect(await kvGet(page, 'prices')).toBeNull();
    expect(errors()).toEqual([]);
  });

  test('the story link and the Set prices path', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await emptyWorkspace(page);
    await page.getByTestId('first-run').getByRole('link', { name: 'Set prices to start the meter' }).click();
    await expectPath(page, '/settings/prices');
    await page.goBack();
    await expectPath(page, '/first-run');
    await page.getByRole('link', { name: 'Watch the 90-second story' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('story')).toBe('1');
    expect(errors()).toEqual([]);
  });

  test('narration: the Slack message, the spike, the recovery and the weekly receipt preview @beauty', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = trackConsoleErrors(page);
    await emptyWorkspace(page);
    await page.getByRole('button', { name: 'Tour with sample data' }).click();
    await expectPath(page, '/');

    // 31 s: the regression's Slack delivery → the message it sent.
    await expect(page.getByText(REGRESSION).first()).toBeVisible({ timeout: 45_000 });
    const viewMessage = page.getByRole('button', { name: 'View message' });
    await expect(viewMessage).toBeVisible({ timeout: 15_000 });
    await viewMessage.click();
    const dialog = page.getByRole('dialog');
    // m1 (founder-build r1 ui-7): the target's plain text, not a Slack card.
    await expect(dialog.locator('[data-callout="target-message"]')).toBeVisible();
    for (const theme of ownsScreens() ? THEMES : []) {
      await setTheme(page, theme);
      await settle(page);
      await page.screenshot({ path: `tests/report/beauty/tour-slack-${theme}-1440.png` });
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await setTheme(page, 'light');

    // 70 s: the cost spike. 110 s: the regression closes itself.
    await expect(page.getByText('Cost spike: Kubernetes prod').first()).toBeVisible({ timeout: 50_000 });
    await expect(page.getByText('Savings back: Payments API sampling')).toBeVisible({ timeout: 50_000 });
    await expect(page.getByText('Recovered · savings back to 75% · closed itself.').first()).toBeVisible();

    // 130 s: Monday's receipt, previewed.
    const viewReceipt = page.getByRole('button', { name: 'View receipt' });
    await expect(viewReceipt).toBeVisible({ timeout: 30_000 });
    await viewReceipt.click();
    const receipt = page.getByRole('dialog');
    await expect(receipt).toContainText('Meter Reader — weekly receipt');
    // Its top line is the sample's own week (founder-build r1 ui-7, M3: rebuilt from the rebased hour rows a Custom range
    // over that week sums), with its dollars.
    const top = sampleWeekReceipt().lines[0];
    await expect(receipt).toContainText(new RegExp(`${escapeRe(top.label)} \\.+ +${escapeRe(fmtDollars(top.savedM))}`));
    await expect(receipt).toContainText('Open alerts: 1 (Cost spike: Kubernetes prod)');
    for (const theme of ownsScreens() ? THEMES : []) {
      await setTheme(page, theme);
      for (const width of [390, 1440] as const) {
        await page.setViewportSize({ width, height: HEIGHTS[width] });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await noHorizontalScroll(page);
        await settle(page);
        await page.screenshot({ path: `tests/report/beauty/tour-weekly-${theme}-${width}.png` });
      }
    }
    await receipt.getByRole('button', { name: 'Close', exact: true }).click();
    expect(errors()).toEqual([]);
  });

  test('beauty: first run and the tour Receipt, both themes, 390 / 1440 / 1920 @beauty', async ({ page }) => {
    test.skip(!ownsScreens(), 'one project owns the grid (it sets every width itself)');
    const errors = trackConsoleErrors(page);
    await emptyWorkspace(page);
    await expect(page.getByTestId('first-run')).toBeVisible();
    for (const theme of THEMES) {
      await setTheme(page, theme);
      for (const width of WIDTHS) await shoot(page, 'first-run', theme, width);
    }

    await setTheme(page, 'light');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Tour with sample data' }).click();
    await expectPath(page, '/');
    await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
    // Past the regression (25 s) and its Slack delivery (31 s), after their toasts have gone, before the spike (70 s).
    await expect(page.getByText(REGRESSION).first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('button', { name: 'View message' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'View message' })).toHaveCount(0, { timeout: 20_000 });
    // The drop's takeover card (row 11) stays until 70 s: dismissed (Escape), so the grid is the Receipt itself.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('tour-takeover')).toHaveCount(0);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      for (const width of WIDTHS) await shoot(page, 'tour-receipt', theme, width);
    }
    expect(errors()).toEqual([]);
  });
});
