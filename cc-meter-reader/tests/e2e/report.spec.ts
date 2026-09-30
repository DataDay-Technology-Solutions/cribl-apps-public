// tests/e2e/report.spec.ts — the Report card (/report) on the in-browser Cribl emulator: opened from the Receipt,
// the preview is the downloaded HTML, every download fires with the right name and content (the PDF opens in
// pdfinfo), Copy for email puts the report on the clipboard, sample data is watermarked, live data is not, and
// the view works in both themes and at 390 px.
//
// Two data paths:
//   • the enterprise sample the tour plays (demo/sample/tour.json), started from the first-run card;
//   • live: 40 days of seeded rollup history for the emulated rig, then this tab's own sweep meters it (the
//     real pipeline: reconciled flows, destinations, top savers, the headline from the totals). The chromium
//     project keeps both PDFs as the canonical artifacts: tests/report/screens/report-sample.pdf and
//     report-live-mock.pdf.
//
// Run: MR_E2E_PORT=5185 npx playwright test tests/e2e/report.spec.ts --project=chromium

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Download, type Page } from '@playwright/test';
import { defaultSettings } from '../../core/settings.ts';
import { fmtDollars } from '../../core/format.ts';
import type { Meta, Snapshot } from '../../core/types.ts';
import type { TourFixture } from '../../src/tour/types.ts';
import { planRebase, rebaseHeadline, rebaseValue } from '../../src/tour/rebase.ts';
import { allowClipboard, expectPath, gotoApp, kvGet, mockControl, readClipboard, resetMock, setTheme, trackConsoleErrors, waitForHydration, type Theme } from './helpers/index.ts';

const TOUR = JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/tour.json', import.meta.url)), 'utf8')) as TourFixture;
const TZ = 'America/Chicago';
const DAY_MS = 86_400_000;
const PDFINFO = '/opt/homebrew/bin/pdfinfo';
// r2 core-7 (FINDINGS_R2 #3): the last column says whether the Cribl cost is the list-price estimate.
const CSV_HEADER = 'Record,Name,Worker group,Source,Pipeline,Destination,Priced as,Would-have-paid price $ / GB,Paid price $ / GB,GB / day in,GB / day out,Volume reduced %,Would-have-paid $ / day,Paid $ / day,Saved $ / day,cribl_cost_is_estimate';

/** The demo rig's destinations at the sourced presets (D41, D43). */
const LIVE_PRICES = {
  schemaVersion: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  versions: [
    {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      byOutputId: {
        mrd_siem_prod: { milliCentsPerGb: 225_000, preset: 'splunk_cloud' },
        mrd_siem_apps: { milliCentsPerGb: 225_000, preset: 'splunk_cloud' },
        mrd_analytics: { milliCentsPerGb: 180_000, preset: 'datadog' },
        mrd_archive_s3: { milliCentsPerGb: 2_300, preset: 's3' },
      },
    },
  ],
};
/** D48: 450.1 GB/day × $0.32/GB × 365/12. */
const CRIBL_COST_CENTS = 438_097;

/**
 * Playwright's trace recorder injects a script into every frame, and the preview frame (sandbox="", no scripts)
 * refuses it with this console error — one per preview document. Measured: 0 without tracing, 1 per document with
 * `context.tracing.start({ snapshots: true })`. The report itself never runs a script in the frame.
 */
const TRACER_IN_SANDBOX = /^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.$/;

/** One project owns the artifacts (the others would overwrite the same files). */
const ownsArtifacts = (): boolean => test.info().project.name === 'chromium';
/** Keeps a canonical artifact in tests/report/screens (made here: the public export ships no tests/report). */
function keepArtifact(from: string, name: string): void {
  if (!ownsArtifacts()) return;
  mkdirSync('tests/report/screens', { recursive: true });
  copyFileSync(from, `tests/report/screens/${name}`);
}

async function putKv(page: Page, docs: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (entries) => {
    for (const [key, value] of entries) {
      const r = await fetch(`/mock-api/v1/kvstore/${key}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(value) });
      if (r.status >= 300) throw new Error(`PUT ${key} → ${r.status}`);
    }
  }, Object.entries(docs));
}

/** The first-run card of an empty emulated org, then "Tour with sample data": the Receipt under the band. */
async function openSampleReceipt(page: Page): Promise<void> {
  await gotoApp(page, '/');
  await resetMock(page);
  await gotoApp(page, '/');
  await expectPath(page, '/first-run');
  await page.getByTestId('first-run').getByRole('button', { name: 'Tour with sample data' }).click();
  await expectPath(page, '/');
  await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
  await page.getByTestId('receipt-hero').waitFor();
}

/**
 * Every "Saved by Cribl" month-to-date figure the tour can show today (its snapshot, and each snapshot step),
 * moved onto today's date the way the tour engine moves them: month to date follows the moved days.
 */
function sampleMtdFigures(): string[] {
  const zone = TOUR.timezone || TZ;
  const plan = planRebase(Date.parse(TOUR.anchor ?? TOUR.generatedAt), Date.now(), zone);
  const snaps = [TOUR.snapshot, ...TOUR.script.filter((s) => s.action === 'snapshot').map((s) => s.payload as Snapshot)];
  const moved = (s: Snapshot) => (plan.dayShift === 0 ? s : rebaseHeadline(rebaseValue(s, plan), zone, TOUR.settings.criblCostCentsPerMonth));
  return [...new Set(snaps.map((s) => fmtDollars(moved(s).headline.mtdM)))];
}

/**
 * The preview's document: the iframe's srcdoc, read as an attribute. The frame is sandboxed with no permissions at
 * all, so a test must not reach into it (Playwright's own injected scripts would be blocked there, and logged).
 */
async function previewHtml(page: Page): Promise<string> {
  return (await page.getByTestId('report-preview').getAttribute('srcdoc')) ?? '';
}

/** The "Saved by Cribl" figure in the preview. */
async function previewFigure(page: Page): Promise<string> {
  return /data-figure="saved">([^<]*)</.exec(await previewHtml(page))?.[1] ?? '';
}
const reportButton = (page: Page, name: string) => page.getByTestId('report-view').getByRole('button', { name, exact: true });

async function download(page: Page, name: string): Promise<{ download: Download; path: string; text: string; bytes: Buffer }> {
  const [dl] = await Promise.all([page.waitForEvent('download'), reportButton(page, name).click()]);
  const path = await dl.path();
  const bytes = readFileSync(path);
  return { download: dl, path, bytes, text: bytes.toString('utf8') };
}

function checkPdf(path: string, bytes: Buffer): void {
  expect(bytes.subarray(0, 9).toString('latin1')).toBe('%PDF-1.4\n');
  expect(bytes.subarray(bytes.length - 6).toString('latin1')).toBe('%%EOF\n');
  if (existsSync(PDFINFO)) {
    const r = spawnSync(PDFINFO, [path], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/Page size:\s+612 x 792 pts \(letter\)/);
    expect(Number(/Pages:\s+(\d+)/.exec(r.stdout)?.[1])).toBeGreaterThanOrEqual(2);
  }
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal page scroll').toBeLessThanOrEqual(0);
}

async function shoot(page: Page, id: string, theme: Theme): Promise<void> {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await frames();
    // Chromium doesn't paint a sandboxed (opaque-origin) frame while it is off screen, and at 390 px the preview
    // sits below the controls: scroll it into view so the full-page capture has it painted.
    const frame = page.getByTestId('report-preview');
    await frame.scrollIntoViewIfNeeded();
    await frames();
    await page.waitForTimeout(300);
    const box = await frame.boundingBox();
    expect(box?.height ?? 0, 'the preview has a height').toBeGreaterThan(400);
    await noHorizontalScroll(page);
    await page.screenshot({ path: `tests/report/screens/${id}-${theme}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe('Report card', () => {
  test.setTimeout(240_000);

  test('sample data: from the Receipt, the preview is the file, every download and the email copy', async ({ page, context, browserName }) => {
    const errors = trackConsoleErrors(page, [TRACER_IN_SANDBOX]);
    await allowClipboard(context, browserName);
    await openSampleReceipt(page);

    // ── Open from the Receipt's hero ───────────────────────────────────────
    await page.getByTestId('receipt-hero').getByRole('button', { name: 'Report card' }).click();
    await expectPath(page, '/report');
    const view = page.getByTestId('report-view');
    await expect(view.getByRole('heading', { level: 1, name: 'Report card' })).toBeVisible();
    await expect(view).toHaveAttribute('data-source', 'sample');
    await expect(page.getByTestId('report-sample-note')).toBeVisible();
    // What the sender should know (typical list prices) sits above the actions, not on the document.
    await expect(page.getByTestId('report-checks')).toContainText('typical list prices, not your contract rates');
    // The Receipt tab stays lit.
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Receipt' })).toHaveAttribute('aria-current', 'page');

    // ── The preview: the document, watermarked ─────────────────────────────
    await expect(page.getByTestId('report-preview')).toBeVisible();
    await expect(page.getByTestId('report-preview')).toHaveAttribute('sandbox', '');
    const figure = await previewFigure(page);
    expect(sampleMtdFigures()).toContain(figure);
    expect(await previewHtml(page)).toContain('<div class="watermark" aria-hidden="true">SAMPLE DATA</div>');
    expect(await previewHtml(page)).toContain('Illustrative figures from the Meter Reader tour workspace');

    // ── Prepared for and a note; shell shortcuts stay quiet inside the fields ──
    const forField = page.getByTestId('report-prepared-for').getByRole('textbox');
    await forField.fill('Finance leadership');
    await forField.press('?');
    await forField.press('Backspace');
    await forField.press('P');
    await forField.press('Backspace');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('present')).toBeNull();
    await page.getByTestId('report-note').getByRole('textbox').fill('Numbers for the Q3 renewal conversation.');
    await expect.poll(() => previewHtml(page)).toContain('<span>Prepared for Finance leadership</span>');
    await expect.poll(() => previewHtml(page)).toContain('<p>Numbers for the Q3 renewal conversation.</p>');

    // ── Download PDF ───────────────────────────────────────────────────────
    const nameRe = (ext: string) => new RegExp(`^meter-reader-report-sample-enterprise-mtd-\\d{4}-\\d{2}-\\d{2}\\.${ext}$`);
    const pdf = await download(page, 'Download PDF');
    expect(pdf.download.suggestedFilename()).toMatch(nameRe('pdf'));
    checkPdf(pdf.path, pdf.bytes);
    await expect(page.getByText(`Downloaded ${pdf.download.suggestedFilename()}.`)).toBeVisible();
    keepArtifact(pdf.path, 'report-sample.pdf');

    // ── Download HTML: the very document the preview shows ─────────────────
    const html = await download(page, 'Download HTML');
    expect(html.download.suggestedFilename()).toMatch(nameRe('html'));
    expect(html.text).toBe(await previewHtml(page));
    expect(html.text.startsWith('<!doctype html>')).toBe(true);
    expect(html.text).toContain(`data-figure="saved">${figure}<`);
    expect(html.text).toContain('data-sample="true"');
    expect(html.text).toContain('Prepared for Finance leadership');
    expect(html.text).not.toMatch(/<script/i);
    // Page 1 says what the prices are; links leave the document in a new tab.
    expect(html.text).toContain('At typical list prices for 8 destinations, not contract rates');
    expect(html.text).toContain('<base target="_blank">');
    keepArtifact(html.path, 'report-sample.html');

    // ── Download CSV ───────────────────────────────────────────────────────
    const csv = await download(page, 'Download CSV');
    expect(csv.download.suggestedFilename()).toMatch(nameRe('csv'));
    const lines = csv.text.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines.filter((l) => l.startsWith('flow,')).length).toBe(TOUR.snapshot.flows.length);
    expect(lines.filter((l) => l.startsWith('destination,')).length).toBeGreaterThan(0);
    // r2 core-7 (IC-13): a sample card's CSV ends with the sample-data note (the header stays row 1).
    expect(lines.filter((l) => l !== '').at(-1)).toMatch(/^note,SAMPLE DATA: /);

    // ── Copy for email ─────────────────────────────────────────────────────
    await reportButton(page, 'Copy for email').click();
    await expect(page.getByText(/^Report copied/)).toBeVisible();
    if (browserName === 'chromium') {
      await expect(page.getByText('Report copied. Paste it into an email.')).toBeVisible();
      const text = await readClipboard(page);
      expect(text).toContain('METER READER · Cribl savings report card');
      expect(text).toContain(figure);
      for (const line of text.split('\n')) expect([...line].length).toBeLessThanOrEqual(60);
    }

    // ── Periods ────────────────────────────────────────────────────────────
    const periods = view.getByRole('radiogroup', { name: 'Period' });
    await periods.getByRole('radio', { name: 'Today' }).click();
    await expect(view).toHaveAttribute('data-period', 'today');
    await expect.poll(() => previewHtml(page)).toContain('<span class="eyebrow">Saved by Cribl, today</span>');
    await expect(periods.getByRole('radio', { name: 'Custom range' })).toHaveCount(0); // sample data has no rollup history
    const today = await download(page, 'Download PDF');
    expect(today.download.suggestedFilename()).toMatch(/-today-\d{4}-\d{2}-\d{2}\.pdf$/);

    // ── Both themes, desktop and phone (the chrome follows the theme; the document is paper) ──
    if (ownsArtifacts()) {
      await periods.getByRole('radio', { name: 'Month to date' }).click();
      await page.evaluate(() => document.fonts.ready);
      // The download toasts auto-dismiss; the screenshots are of the view, not of them.
      await expect(page.getByText(/^(Downloaded |Report copied)/)).toHaveCount(0, { timeout: 20_000 });
      await shoot(page, 'report-view', 'light');
      await setTheme(page, 'dark');
      await shoot(page, 'report-view', 'dark');
      await setTheme(page, 'light');
    }
    await noHorizontalScroll(page);
    expect(errors()).toEqual([]);
  });

  test('live data: the emulated rig metered by this tab, reconciled to the Receipt, no watermark', async ({ page }) => {
    const errors = trackConsoleErrors(page, [TRACER_IN_SANDBOX]);
    await gotoApp(page, '/first-run');
    await resetMock(page);
    const at = await page.evaluate(() => Date.now());
    const since = at - 40 * DAY_MS;
    await mockControl(page, { action: 'seedRollups', at, since, tz: TZ, prices: LIVE_PRICES });
    const iso = (ms: number) => new Date(ms).toISOString();
    const settings = { ...defaultSettings(iso(at), TZ), criblCostCentsPerMonth: CRIBL_COST_CENTS };
    const meta: Meta = {
      schemaVersion: 1,
      installedAt: iso(since),
      collectingSince: iso(since),
      appVersion: '1.0.0',
      build: 'release',
      metricsSource: 'metrics-query',
      sweepErrors: 0,
      consecutiveRateLimited: 0,
      sweepCount: 0,
      meteredThrough: iso(Math.floor(at / 60_000) * 60_000),
    };
    await putKv(page, { settings, prices: LIVE_PRICES, meta });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    // This tab meters the rig: the first snapshot lands about a minute after the last whole minute settles.
    await expect.poll(async () => (await kvGet(page, 'snapshot')) !== null, { timeout: 150_000, intervals: [2_000] }).toBe(true);
    const snapshot = JSON.parse((await kvGet(page, 'snapshot')) ?? '{}') as Snapshot;
    expect(snapshot.flows.length).toBeGreaterThan(0);
    await expect(page.getByTestId('receipt-hero').getByRole('button', { name: 'Report card' })).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('receipt-hero').getByRole('button', { name: 'Report card' }).click();
    await expectPath(page, '/report');

    const view = page.getByTestId('report-view');
    await expect(view).toHaveAttribute('data-source', 'live');
    await expect(page.getByTestId('report-sample-note')).toHaveCount(0);
    // The report pins the snapshot it opened with. When the tab has swept since, the notice offers the newer
    // figures: take them, until the report is built from the snapshot in KV, and its figure is that snapshot's.
    await expect
      .poll(
        async () => {
          const kv = JSON.parse((await kvGet(page, 'snapshot')) ?? '{}') as Snapshot;
          if ((await view.getAttribute('data-swept')) !== kv.sweepAt) {
            const update = page.getByTestId('report-newer').getByRole('button', { name: 'Update figures' });
            if (await update.isVisible()) await update.click();
            return false;
          }
          return (await previewFigure(page)) === fmtDollars(kv.headline.mtdM);
        },
        { timeout: 120_000, intervals: [1_000] },
      )
      .toBe(true);
    const live = await previewHtml(page);
    expect(live).not.toContain('class="watermark"');
    expect(live).not.toContain('data-sample');
    expect(live).toMatch(/<div class="kpi neutral"><div class="k">Cribl paid for itself<\/div><div class="v">\d+\.\d×<\/div>/);

    const pdf = await download(page, 'Download PDF');
    expect(pdf.download.suggestedFilename()).toMatch(/^meter-reader-report-[a-z0-9-]+-mtd-\d{4}-\d{2}-\d{2}\.pdf$/);
    checkPdf(pdf.path, pdf.bytes);
    expect(pdf.bytes.toString('latin1')).not.toContain('SAMPLE DATA');
    keepArtifact(pdf.path, 'report-live-mock.pdf');
    const html = await download(page, 'Download HTML');
    expect(html.text).not.toContain('data-sample');
    keepArtifact(html.path, 'report-live-mock.html');

    // A custom range on the Receipt carries over as the report's period.
    await page.goto('/report?range=24h', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.getByTestId('report-view')).toHaveAttribute('data-period', 'range', { timeout: 30_000 });
    await expect(page.getByTestId('report-view').getByRole('radiogroup', { name: 'Period' }).getByRole('radio', { name: 'Custom range' })).toBeChecked();
    const range = await download(page, 'Download PDF');
    expect(range.download.suggestedFilename()).toMatch(/-range-\d{8}t\d{4}-\d{8}t\d{4}-\d{4}-\d{2}-\d{2}\.pdf$/);
    checkPdf(range.path, range.bytes);
    await noHorizontalScroll(page);
    expect(errors()).toEqual([]);
  });

  test('before the first sweep: the actions wait, and say why', async ({ page }) => {
    const errors = trackConsoleErrors(page, [TRACER_IN_SANDBOX]);
    await gotoApp(page, '/first-run');
    await resetMock(page);
    // Priced, but nothing metered yet: settings in the backend runtime, so this tab never sweeps.
    await putKv(page, { prices: LIVE_PRICES, settings: { ...defaultSettings(new Date().toISOString(), TZ), runtime: 'backend' } });
    await page.goto('/report', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.getByTestId('report-unavailable')).toContainText('The report card needs the first sweep.');
    for (const name of ['Download PDF', 'Download HTML', 'Copy for email', 'Download CSV']) await expect(reportButton(page, name)).toBeDisabled();
    expect(errors()).toEqual([]);
  });
});
