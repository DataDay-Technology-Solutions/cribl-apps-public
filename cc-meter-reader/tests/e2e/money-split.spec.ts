// tests/e2e/money-split.spec.ts — WP-F wave 2 on the Ledger fixture (the demo rig's week), reshaped into the two
// situations the CFO lens found the money unclear on:
//   P1-F02  VPC Flow Logs go whole to the S3 archive, credited at SIEM (prod)'s price ("without Cribl this data would
//           go to SIEM (prod)"): a diversion credit, not bytes dropped. The Ledger's Volume reduced cell reads
//           "diverted" (where the data would have gone in its hover), the hero's bar splits bytes dropped (solid)
//           from the diversion (hatched) with "By reduction $X · by diversion $Y", Show the math has a Measured and
//           assumed section, and Copy receipt tags the line "(diverted)" and prints the split.
//   P1-F03  Windows workstation events are enriched: 30 % more bytes out than in. The Ledger reads −30 % (it used to
//           clamp at 0 %), the totals row carries "Cost added by Cribl on 1 flow: $60 / day", Show the math too.
//   P1-F10  The hero says what its dollars are priced at: the fixture's prices are the member's own rates everywhere
//           ("at your contract rates"; Show the math: "Your rate · Splunk Cloud list $2.25"); with SIEM (prod) back at
//           the Splunk Cloud preset's typical list price it reads "at typical list prices", its hover counting 2 of 3.
// The documents are what core/snapshot.ts writes since P1-F02/F03 (diverted, divertedTo, addedPerDayM, the headline's
// split and cost added).
//
// Screenshots: tests/report/screens/wave2-f-<shot>-<light|dark>-<width>.png from chromium (1440) and mobile (390).

import { expect, test, type Page } from '@playwright/test';
import type { Snapshot } from '../../core/types.ts';
import { allowClipboard, gotoApp, readClipboard, screenPath, setTheme, trackConsoleErrors, waitForHydration, waitForMock, type Theme } from './helpers/index.ts';
import { injectLedgerDocs, loadDemoFixture, type LedgerDocs } from './ledger-fixture.ts';

const THEMES: readonly Theme[] = ['light', 'dark'];
const BENIGN = [/ResizeObserver loop completed with undelivered notifications/];
const shoots = (): boolean => ['chromium', 'mobile'].includes(test.info().project.name);
const SIEM_PRICE = 250_000; // mc/GB, the fixture's SIEM (prod) price
const DIVERTED_MTD = 50_000_000; // $500 of the month credited by diversion

let docs: LedgerDocs;
let addedPerDayM = 0;

/** The fixture, reshaped: VPC Flow Logs credited at SIEM (prod)'s price; Windows workstation events enriched +30 %. */
function reshape(base: LedgerDocs): LedgerDocs {
  const s: Snapshot = structuredClone(base.snapshot);
  const vpc = s.flows.find((f) => f.inputId === 'mrd_vpc_flow' && f.outputId === 'mrd_archive_s3');
  const ws = s.flows.find((f) => f.inputId === 'mrd_windows_workstations');
  if (!vpc || !ws) throw new Error('the Ledger fixture changed: no VPC or workstation flow');
  vpc.whpPerDayM = Math.round((vpc.inBPerDay / 1e9) * SIEM_PRICE);
  vpc.savedPerDayM = vpc.whpPerDayM - vpc.paidPerDayM;
  vpc.diverted = true;
  vpc.divertedTo = 'mrd_siem_prod';
  ws.outBPerDay = Math.round(ws.inBPerDay * 1.3);
  ws.paidPerDayM = Math.round(ws.whpPerDayM * 1.3);
  ws.savedPerDayM = 0;
  ws.addedPerDayM = ws.paidPerDayM - ws.whpPerDayM;
  addedPerDayM = ws.addedPerDayM;
  const archive = s.destinations.find((d) => d.outputId === 'mrd_archive_s3')!;
  archive.counterfactual = { kind: 'other', outputId: 'mrd_siem_prod' };
  archive.mtdSavedM += DIVERTED_MTD;
  archive.mtdWhpM += DIVERTED_MTD;
  const h = s.headline;
  h.reducedMtdM = h.mtdM;
  h.divertedMtdM = DIVERTED_MTD;
  h.mtdM += DIVERTED_MTD;
  h.whpMtdM += DIVERTED_MTD;
  h.ratioMtd = h.mtdM / h.whpMtdM;
  h.addedPerDayM = ws.addedPerDayM;
  h.addedFlows = 1;
  s.topSavers = [
    ...s.topSavers,
    { objectKey: `route:default:${vpc.routeId}`, label: 'Passthrough (no reduction)', savedPerDayM: vpc.savedPerDayM, ratio: vpc.savedPerDayM / vpc.whpPerDayM, groupId: 'default', pipelineId: vpc.pipelineId, diverted: true as const },
  ].sort((a, b) => b.savedPerDayM - a.savedPerDayM);
  const prices = structuredClone(base.prices);
  const last = prices.versions[prices.versions.length - 1];
  for (const k of Object.keys(last.byOutputId)) if (k === 'mrd_archive_s3' || k.endsWith(':mrd_archive_s3')) last.byOutputId[k].counterfactual = { kind: 'other', outputId: 'mrd_siem_prod' };
  return { ...base, snapshot: s, prices };
}

test.beforeAll(() => {
  docs = reshape(loadDemoFixture());
});

async function openApp(page: Page, path: string): Promise<void> {
  await gotoApp(page, '/ledger');
  await injectLedgerDocs(page, docs);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForMock(page);
  await waitForHydration(page);
}

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.mouse.move(0, 0);
}

const dollars = (mc: number): string => `$${Math.round(mc / 100_000).toLocaleString('en-US')}`;

test.describe('P1-F02 / P1-F03 · measured vs assumed dollars, and the cost a pipeline adds', () => {
  test('Ledger: the diverted flow reads "diverted", the enriched one −30%, and the totals row carries the cost added', async ({ page }) => {
    await openApp(page, '/ledger');
    const errors = trackConsoleErrors(page, BENIGN);
    const vpcRow = page.locator('[data-row-id*="|mrd_vpc_flow|"]').first();
    const wsRow = page.locator('[data-row-id*="|mrd_windows_workstations|"]').first();
    await expect(vpcRow).toBeVisible();
    const diverted = vpcRow.locator('[data-diverted="true"]');
    await expect(diverted).toHaveText('diverted');
    await expect(diverted).toHaveAttribute('title', /Without Cribl this data would go to SIEM \(prod\)/);
    await expect(wsRow).toContainText('−30%');
    const vw = page.viewportSize()?.width ?? 0;
    if (vw >= 760) {
      await expect(page.getByTestId('ledger-added')).toHaveText(`Cost added by Cribl on 1 flow: ${dollars(addedPerDayM)} / day`);
    }
    if (shoots()) {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await blur(page);
        await page.screenshot({ path: screenPath('wave2-f-ledger-split', theme, page) });
      }
    }
    expect(errors()).toEqual([]);
  });

  test('Receipt: the bar splits bytes dropped from the diversion credit, and Show the math says which is which', async ({ page }) => {
    await openApp(page, '/');
    const errors = trackConsoleErrors(page, BENIGN);
    const split = page.getByTestId('receipt-split');
    await expect(split).toBeVisible();
    await expect(split).toContainText(`By reduction ${dollars(docs.snapshot.headline.reducedMtdM!)}`);
    await expect(split).toContainText(`by diversion ${dollars(DIVERTED_MTD)}`);
    await expect(page.getByTestId('receipt-bar-diverted')).toBeVisible();
    if (shoots()) {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await blur(page);
        await page.getByTestId('receipt-hero').screenshot({ path: screenPath('wave2-f-hero-split', theme, page) });
      }
      await setTheme(page, 'light');
    }

    await page.getByRole('button', { name: 'Show the math' }).click();
    const math = page.getByTestId('math-drawer');
    await expect(math.getByTestId('math-split')).toContainText(`Saved by reduction ${dollars(docs.snapshot.headline.reducedMtdM!)} · by diversion ${dollars(DIVERTED_MTD)}, month to date`);
    await expect(math.getByTestId('math-added')).toContainText(`Cost added by Cribl on 1 flow: ${dollars(addedPerDayM)} a day`);
    if (shoots()) {
      await math.getByTestId('math-split').scrollIntoViewIfNeeded();
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await page.screenshot({ path: screenPath('wave2-f-math-split', theme, page) });
      }
    }
    expect(errors()).toEqual([]);
  });

  test('Copy receipt: the diverted line is tagged and the total is split', async ({ page, context, browserName }) => {
    await allowClipboard(context, browserName);
    await openApp(page, '/');
    await page.getByRole('button', { name: 'Copy receipt' }).click();
    await expect.poll(() => readClipboard(page)).toContain('(diverted)');
    const text = await readClipboard(page);
    expect(text).toMatch(/^Passthrough \(no.*\(diverted\) \.{4,} +\$1[0-9]{2}\/day$/m);
    expect(text).toContain(`Saved by reduction ${dollars(docs.snapshot.headline.reducedMtdM!)} · by diversion ${dollars(DIVERTED_MTD)}`);
    for (const line of text.split('\n')) if (!line.startsWith('http')) expect(line.length).toBeLessThanOrEqual(48);
  });

  test('P1-F10: the hero says "at your contract rates" on the member\'s own rates, and Show the math sets each beside its list price', async ({ page }) => {
    await openApp(page, '/');
    const errors = trackConsoleErrors(page, BENIGN);
    const badge = page.getByTestId('hero-price-basis');
    await expect(badge).toHaveText('at your contract rates');
    await expect(badge).toHaveAttribute('data-basis', 'contract');
    if (shoots()) {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await blur(page);
        await page.getByTestId('receipt-hero').screenshot({ path: screenPath('wave2-f-hero-contract', theme, page) });
      }
      await setTheme(page, 'light');
    }
    await page.getByRole('button', { name: 'Show the math' }).click();
    const rate = page.getByTestId('math-drawer').getByTestId('math-your-rate').first();
    await expect(rate).toHaveText('Your rate · Splunk Cloud list $2.25');
    if (shoots()) {
      await rate.scrollIntoViewIfNeeded();
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await page.screenshot({ path: screenPath('wave2-f-math-your-rate', theme, page) });
      }
    }
    expect(errors()).toEqual([]);
  });

  test('P1-F10: with one destination back at a preset\'s typical list price the hero reads "at typical list prices"', async ({ page }) => {
    const preset = structuredClone(docs);
    const v = preset.prices.versions[preset.prices.versions.length - 1];
    v.byOutputId.mrd_siem_prod = { ...v.byOutputId.mrd_siem_prod, milliCentsPerGb: 225_000, preset: 'splunk_cloud' };
    await gotoApp(page, '/ledger');
    await injectLedgerDocs(page, preset);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForMock(page);
    await waitForHydration(page);
    const badge = page.getByTestId('hero-price-basis');
    await expect(badge).toHaveText('at typical list prices');
    await expect(badge).toHaveAttribute('title', /^2 of 3 destinations at your own rates/);
    if (shoots()) {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await blur(page);
        await page.getByTestId('receipt-hero').screenshot({ path: screenPath('wave2-f-hero-preset', theme, page) });
      }
    }
  });
});
