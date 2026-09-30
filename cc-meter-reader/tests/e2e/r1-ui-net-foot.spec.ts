// r1 ui-8 (FINDINGS_R1 m9 #19, m10 #20, m12 #24; seeded from AA/r1/skeptic1-f19/zz-sk1-f19.spec.ts): printed money
// adds up on the sample tour, at two tour times.
//   m9:  Show the math's "saved − cost = net" foots to the dollar, and the hero's net line is that same net.
//   m10: the month-to-date destination rows, column by column, add up to the "These rows add up to …" sentence.
//   m12: the presenter's wheels read the run rate as every other surface prints it (half-up whole dollars).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { fmtDollars, roundToDollarsM } from '../../core/format.ts';
import type { TourFixture } from '../../src/tour/types.ts';
import { planRebase, rebaseHeadline, rebaseValue } from '../../src/tour/rebase.ts';
import { expectPath, gotoApp, resetMock, trackConsoleErrors } from './helpers/index.ts';

const TOUR = JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/tour.json', import.meta.url)), 'utf8')) as TourFixture;

/** '$1,234' / '−$1,234' → signed whole dollars. */
const dollars = (s: string): number => Number(s.replace(/[^0-9]/g, '')) * (/[−-]\s*\$/.test(s.trim().slice(0, 2)) ? -1 : 1);
const money = /[−-]?\$[\d,]+/g;

async function startTour(page: Page): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await gotoApp(page, '/first-run');
  await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
  await expectPath(page, '/');
  await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
  await page.getByRole('radio', { name: 'MTD' }).click();
  await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'mtd');
}

/** Opens Show the math and checks that everything it prints adds up. Returns the net it prints. */
async function checkMath(page: Page, when: string): Promise<number> {
  await page.getByRole('button', { name: 'Show the math' }).click();
  const drawer = page.getByTestId('math-drawer');
  await expect(drawer).toBeVisible();

  // m9: "$saved − $cost = $net".
  const netLine = (await drawer.getByTestId('math-net').innerText()).split('\n').find((l) => / − .* = /.test(l)) ?? '';
  const [saved, cost, net] = (netLine.match(money) ?? []).map(dollars);
  expect(netLine, `${when}: the net formula`).toMatch(/\$[\d,]+ − \$[\d,]+ = [−-]?\$[\d,]+/);
  expect(saved - cost, `${when}: ${netLine}`).toBe(net);

  // m10: the rows add up to the sentence, column by column.
  const rows = await drawer.getByTestId('math-dest-mtd').allInnerTexts();
  expect(rows.length, `${when}: month-to-date rows`).toBeGreaterThan(1);
  const cols = { whp: 0, paid: 0, saved: 0 };
  for (const row of rows) {
    const line = row.split('\n').find((l) => / − .* = .* saved/.test(l)) ?? '';
    const [w, p, s] = (line.match(money) ?? []).map(dollars);
    expect(w - p, `${when}: row ${line}`).toBe(s);
    cols.whp += w;
    cols.paid += p;
    cols.saved += s;
  }
  const sentence = await drawer.getByTestId('math-reconcile').innerText();
  expect(await drawer.getByTestId('math-reconcile').getAttribute('data-matches')).toBe('true');
  const [tw, tp, ts] = (sentence.match(money) ?? []).map(dollars);
  expect({ whp: cols.whp, paid: cols.paid, saved: cols.saved }, `${when}: ${sentence}`).toEqual({ whp: tw, paid: tp, saved: ts });

  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  return net;
}

test('the tour: Show the math foots (net, and the rows to their sentence) at +0 s and after the regression', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackConsoleErrors(page);
  await startTour(page);
  const net0 = await checkMath(page, '+0 s');
  // The hero's net line is the drawer's net, to the dollar.
  await expect(page.getByTestId('receipt-net')).toContainText(`Net after Cribl ${fmtDollars(net0 * 100_000)}`);

  // After the regression lands (25 s), the snapshot moves: the arithmetic still adds up.
  await expect(page.getByText('Savings dropped: Payments API sampling').first()).toBeVisible({ timeout: 45_000 });
  const net1 = await checkMath(page, 'after the regression');
  await expect(page.getByTestId('receipt-net')).toContainText(`Net after Cribl ${fmtDollars(net1 * 100_000)}`);
  expect(errors()).toEqual([]);
});

test('the presenter reads the run rate as the Receipt prints it: half-up whole dollars (m12)', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await gotoApp(page, '/?present=1&tour=1');
  await expect(page.locator('html')).toHaveAttribute('data-mr-tour', 'running', { timeout: 20_000 });
  const figure = page.locator('.mr-pv-figure [data-callout="saved"][data-value-m]').first();
  await expect(figure).toBeAttached({ timeout: 20_000 });
  const zone = TOUR.timezone || 'America/Chicago';
  const plan = planRebase(Date.parse(TOUR.anchor ?? TOUR.generatedAt), Date.now(), zone);
  const annualizedM = plan.dayShift === 0 ? TOUR.snapshot.headline.annualizedM : rebaseHeadline(rebaseValue(TOUR.snapshot, plan), zone, TOUR.settings.criblCostCentsPerMonth).headline.annualizedM;
  // The wheels settle on the figure rounded half-up (never floored a dollar below it).
  await expect.poll(async () => Number(await figure.getAttribute('data-value-m')), { timeout: 10_000 }).toBe(roundToDollarsM(annualizedM));
  expect(fmtDollars(roundToDollarsM(annualizedM))).toBe(fmtDollars(annualizedM));
  expect(errors()).toEqual([]);
});
