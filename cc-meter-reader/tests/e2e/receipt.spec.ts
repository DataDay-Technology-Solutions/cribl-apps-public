// tests/e2e/receipt.spec.ts — the Receipt view (PRD 8.1, DESIGN_BRIEF 5.1, SPEC 13) on the in-browser
// Cribl emulator: behaviour, the ticking Meter's contract, and the beauty grid (PRD 8.8).
//
// Two data paths:
//   • a hand-built enterprise-scale workspace (45 days of totals, four destinations, two open alerts,
//     five commits) written straight into the emulator's KV with `runtime: 'backend'`, so no sweep in
//     the tab overwrites it — every figure is derived with core/pricing's computeHeadline, so the
//     receipt bar, the math drawer and the hero agree by construction;
//   • the real thing: prices only, then the tab's own ui-runtime sweep meters the emulated rig.
//
// Screenshots: tests/report/beauty/receipt-<dark|light>-<390|1440|1920>.png (+ math / how / tooltip).

import { expect, test, type Page } from '@playwright/test';
import { computeHeadline } from '../../core/pricing.ts';
import { defaultSettings } from '../../core/settings.ts';
import { fmtDollars, fmtDollarsCents, fmtDollarsCompact, footMoney } from '../../core/format.ts';
import { goalPace, mondayOf } from '../../core/goal.ts';
import { formatRangeParam } from '../../core/range.ts';
import { statementMonths } from '../../src/views/Receipt/model.ts';
import { netOfCribl, type NetOfCribl } from '../../core/net.ts';
import { DAY_MS, addDaysToKey, formatLocalMonthDay, localDayKey, localDayStartMs, localMidnightMs, localMonthStartMs } from '../../core/time.ts';
import type {
  Commit,
  DestinationFigures,
  FlowFigures,
  Incident,
  Meta,
  PricesDoc,
  Settings,
  Snapshot,
  TopSaver,
  TotalsDoc,
  TrendPoint,
} from '../../core/types.ts';
import {
  RIG_PRICES,
  allowClipboard,
  gotoApp,
  kvGet,
  mockControl,
  readClipboard,
  resetMock,
  setTheme,
  stubClipboardApi,
  trackConsoleErrors,
  waitForHydration,
} from './helpers/index.ts';

const TZ = 'America/Chicago';
const GID = 'default';
const $ = (dollars: number): number => Math.round(dollars * 100_000); // dollars → millicents
const GB = 1e9;

// ─── The enterprise-scale fixture ────────────────────────────────────────────

interface FlowSpec {
  route: string;
  pipeline: string;
  output: string;
  inGb: number;
  outGb: number;
  label: string;
}

/** Per-day rates, current. Prices: siem $2.50/GB, analytics $1.50/GB, archive $0.03/GB (whp at siem's price). */
const PRICE_MC: Record<string, number> = { mrd_siem_prod: 250_000, mrd_analytics: 150_000, mrd_archive_s3: 3_000 };
const WHP_PRICE_MC: Record<string, number> = { mrd_siem_prod: 250_000, mrd_analytics: 150_000, mrd_archive_s3: 250_000 };
const FLOWS: FlowSpec[] = [
  { route: 'mrd_vpc_flow', pipeline: 'mrd_vpc_pack', output: 'mrd_archive_s3', inGb: 1500, outGb: 300, label: 'VPC Flow aggregation' },
  { route: 'mrd_windows_dc', pipeline: 'mrd_win_xml_pack', output: 'mrd_siem_prod', inGb: 1600, outGb: 636, label: 'Windows XML pack' },
  { route: 'mrd_payments_api', pipeline: 'mrd_pay_sample', output: 'mrd_siem_prod', inGb: 341.333, outGb: 85.333, label: 'Payments API sampling' },
  { route: 'mrd_k8s_prod', pipeline: 'mrd_k8s_noise', output: 'mrd_analytics', inGb: 800, outGb: 380, label: 'Kubernetes noise filter' },
  { route: 'mrd_pan_firewall', pipeline: 'mrd_pan_pack', output: 'mrd_siem_prod', inGb: 458.667, outGb: 298.667, label: 'Palo Alto pack' },
  { route: 'mrd_edge_cdn', pipeline: 'mrd_passthrough', output: 'mrd_edge_cdn', inGb: 200, outGb: 200, label: 'Passthrough (no reduction)' },
];

function flowMoney(f: FlowSpec): { whpM: number; paidM: number; savedM: number } {
  const whpM = Math.round(f.inGb * (WHP_PRICE_MC[f.output] ?? 0));
  const paidM = Math.round(f.outGb * (PRICE_MC[f.output] ?? 0));
  return { whpM, paidM, savedM: Math.max(0, whpM - paidM) };
}

export interface Fixture {
  settings: Settings;
  prices: PricesDoc;
  meta: Meta;
  snapshot: Snapshot;
}

export interface FixtureOptions {
  withIncidents?: boolean;
  /** A younger workspace: when collecting began, from the browser's `nowMs` (default 9:41 PM, 45 days ago). */
  collectingSince?: (nowMs: number) => number;
}

/** Builds a consistent enterprise-scale workspace as of `nowMs` (the browser's clock). */
export function buildFixture(nowMs: number, opts: FixtureOptions = {}): Fixture {
  const nowIso = new Date(nowMs).toISOString();
  const todayKey = localDayKey(nowMs, TZ);
  const collectingSinceMs =
    opts.collectingSince?.(nowMs) ?? localDayStartMs(addDaysToKey(todayKey, -45), TZ) + (21 * 60 + 41) * 60_000; // 9:41 PM, 45 days ago
  const packDay = addDaysToKey(todayKey, -14);

  const rate = FLOWS.reduce(
    (acc, f) => {
      const m = flowMoney(f);
      return { whpM: acc.whpM + m.whpM, paidM: acc.paidM + m.paidM, savedM: acc.savedM + m.savedM };
    },
    { whpM: 0, paidM: 0, savedM: 0 },
  );
  const ratioAfter = rate.savedM / rate.whpM;
  const ratioBefore = ratioAfter - 0.09;

  // Daily totals: weekday rhythm (weekends ~12 % lighter), a gentle wobble, the Windows pack step 14 days ago.
  const byDay: TotalsDoc['byDay'] = {};
  const sinceKey = localDayKey(collectingSinceMs, TZ);
  for (let back = 45; back >= 0; back--) {
    const day = addDaysToKey(todayKey, -back);
    if (day < sinceKey) continue;
    const start = localDayStartMs(day, TZ);
    const dow = new Date(start + DAY_MS / 2).getUTCDay();
    const weekend = dow === 0 || dow === 6 ? 0.88 : 1;
    const wobble = 1 + 0.035 * Math.sin(back * 1.7) + 0.02 * Math.cos(back * 0.6);
    let minutes = 1440;
    if (day === sinceKey) minutes = Math.round((localDayStartMs(addDaysToKey(day, 1), TZ) - collectingSinceMs) / 60_000);
    if (day === todayKey) minutes = Math.max(1, Math.round((nowMs - Math.max(localMidnightMs(nowMs, TZ), collectingSinceMs)) / 60_000));
    const whpM = Math.round(rate.whpM * weekend * wobble * (minutes / 1440));
    const r = day >= packDay ? ratioAfter - 0.01 * Math.sin(back) : ratioBefore + 0.012 * Math.cos(back * 0.9);
    const savedM = Math.round(whpM * r);
    byDay[day] = { whpM, paidM: whpM - savedM, savedM, minutes };
  }
  const totals: TotalsDoc = { schemaVersion: 1, updatedAt: nowIso, byDay };
  const criblCostCentsPerMonth = 3_500_000; // $35,000 / month
  const headline = computeHeadline(totals, nowMs, TZ, collectingSinceMs, criblCostCentsPerMonth);

  const trend: TrendPoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = addDaysToKey(todayKey, -i);
    const d = byDay[day];
    trend.push({ day, savedM: d?.savedM ?? 0, whpM: d?.whpM ?? 0, paidM: d?.paidM ?? 0 });
  }

  const flows: FlowFigures[] = FLOWS.map((f) => {
    const m = flowMoney(f);
    const perMin = (x: number) => Math.round(x / 1440);
    return {
      key: `${GID}|mrd_${f.route.replace(/^mrd_/, '')}|${f.route}|${f.pipeline}|${f.output}`,
      groupId: GID,
      inputId: f.route,
      routeId: f.route,
      pipelineId: f.pipeline,
      outputId: f.output,
      inB: Math.round((f.inGb * GB) / 1440),
      outB: Math.round((f.outGb * GB) / 1440),
      whpM: perMin(m.whpM),
      paidM: perMin(m.paidM),
      savedM: perMin(m.savedM),
      ratio: m.whpM > 0 ? m.savedM / m.whpM : 0,
      ratePerHourM: Math.round(m.paidM / 24),
      savedPerDayM: m.savedM,
      whpPerDayM: m.whpM,
      paidPerDayM: m.paidM,
      inBPerDay: Math.round(f.inGb * GB),
      outBPerDay: Math.round(f.outGb * GB),
      attribution: 'route',
      sparkline: Array.from({ length: 30 }, (_, i) => (m.whpM > 0 ? m.savedM / m.whpM : 0) + 0.01 * Math.sin(i)),
      state: PRICE_MC[f.output] ? 'ok' : 'unpriced',
    };
  });

  const destTypes: Record<string, string> = { mrd_siem_prod: 'splunk_hec', mrd_analytics: 'datadog', mrd_archive_s3: 's3', mrd_edge_cdn: 'webhook' };
  const destIds = Object.keys(destTypes).sort();
  const perDay = (outputId: string, k: 'whpPerDayM' | 'paidPerDayM' | 'savedPerDayM') =>
    flows.filter((f) => f.outputId === outputId).reduce((s, f) => s + f[k], 0);
  // Month to date per destination: the headline's month split by each destination's share of the day, the
  // remainder on the heaviest, so the rows add up to the hero exactly — as core's per-output month totals do.
  const allocate = (total: number, k: 'whpPerDayM' | 'paidPerDayM' | 'savedPerDayM'): Record<string, number> => {
    const weights = destIds.map((id) => perDay(id, k));
    const all = weights.reduce((a, b) => a + b, 0);
    const parts = weights.map((w) => (all > 0 ? Math.floor((total * w) / all) : 0));
    const heaviest = weights.indexOf(Math.max(...weights));
    parts[heaviest] += total - parts.reduce((a, b) => a + b, 0);
    return Object.fromEntries(destIds.map((id, i) => [id, parts[i]]));
  };
  const mtdWhp = allocate(headline.whpMtdM, 'whpPerDayM');
  const mtdSaved = allocate(headline.mtdM, 'savedPerDayM');
  const destinations: DestinationFigures[] = destIds.map((outputId) => ({
    groupId: GID,
    outputId,
    type: destTypes[outputId],
    whpPerDayM: perDay(outputId, 'whpPerDayM'),
    paidPerDayM: perDay(outputId, 'paidPerDayM'),
    savedPerDayM: perDay(outputId, 'savedPerDayM'),
    mtdPaidM: mtdWhp[outputId] - mtdSaved[outputId],
    mtdSavedM: mtdSaved[outputId],
    mtdWhpM: mtdWhp[outputId],
    milliCentsPerGb: PRICE_MC[outputId] ?? 0,
    counterfactual: outputId === 'mrd_archive_s3' ? { kind: 'other', outputId: 'mrd_siem_prod' } : { kind: 'same' },
    unpriced: !PRICE_MC[outputId],
  }));

  const topSavers: TopSaver[] = FLOWS.filter((f) => flowMoney(f).savedM > 0)
    .map((f) => {
      const m = flowMoney(f);
      return { objectKey: `route:${GID}:${f.route}`, label: f.label, savedPerDayM: m.savedM, ratio: m.savedM / m.whpM, groupId: GID, pipelineId: f.pipeline };
    })
    .sort((a, b) => b.savedPerDayM - a.savedPerDayM)
    .slice(0, 5);

  const at = (msAgo: number) => new Date(nowMs - msAgo).toISOString();
  const dayAt = (daysAgo: number, hh: number, mm: number) =>
    new Date(localDayStartMs(addDaysToKey(todayKey, -daysAgo), TZ) + (hh * 60 + mm) * 60_000).toISOString();
  const commit = (hash: string, message: string, author: string, committedAt: string, files: string[]): Commit => ({
    hash,
    message,
    author,
    committedAt,
    deployedAt: new Date(Date.parse(committedAt) + 40_000).toISOString(),
    groupId: GID,
    files,
    source: 'api',
  });
  const timeline: Commit[] = [
    commit('a1f3c9e6b2d04c1f9e8a7b6c5d4e3f2a1b0c9d8e', 'demo: break the trim on mrd_pay_sample', 's.koelpin', at(6 * 60_000), [
      'groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml',
    ]),
    commit('91cc3d2f0a1b2c3d4e5f60718293a4b5c6d7e8f9', 'Tune Palo Alto pack field list', 'Steve Koelpin', dayAt(4, 10, 12), []),
    commit('e41a0b7c1d2e3f405162738495a6b7c8d9e0f1a2', 'Route k8s noise filter to analytics', 's.koelpin', dayAt(9, 15, 30), []),
    commit('7c2d410e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c', 'Apply the Windows XML pack to domain controllers', 'Steve Koelpin', dayAt(14, 9, 5), []),
    commit('3b9e122a0b1c2d3e4f5061728394a5b6c7d8e9f0', 'Aggregate VPC Flow Logs before the archive', 'm.chen', dayAt(22, 13, 45), []),
  ];

  const incidents: Incident[] = opts.withIncidents === false
    ? []
    : [
        {
          id: 'regression|pipe:default:mrd_pay_sample|1',
          type: 'regression',
          severity: 'high',
          objectKey: 'pipe:default:mrd_pay_sample',
          label: 'Payments API sampling',
          outputId: 'mrd_siem_prod',
          openedAt: at(3 * 60_000),
          lastNotifiedAt: at(2 * 60_000),
          cause: 'commit',
          commit: {
            hash: timeline[0].hash,
            message: timeline[0].message,
            author: timeline[0].author,
            committedAt: timeline[0].committedAt,
            deployedAt: timeline[0].deployedAt,
            groupId: GID,
            match: 'files',
          },
          before: 0.75,
          after: 0.5,
          impactPerDayM: $(213),
          caughtInSec: 171,
          notes: [],
          deliveries: [{ endpointId: 'slack', status: 200, at: at(2 * 60_000) }],
        },
        {
          id: 'budget|out:default:mrd_analytics|1',
          type: 'budget',
          severity: 'medium',
          objectKey: 'out:default:mrd_analytics',
          label: 'analytics',
          outputId: 'mrd_analytics',
          openedAt: at(52 * 60_000),
          before: 88,
          after: 104,
          impactPerDayM: $(34),
          notes: [],
          deliveries: [{ endpointId: 'slack', status: 200, at: at(51 * 60_000) }],
        },
      ];

  const sweepAt = new Date(nowMs).toISOString();
  const snapshot: Snapshot = {
    schemaVersion: 1,
    sweepAt,
    windowStart: new Date(Math.floor(nowMs / 60_000) * 60_000 - 60_000).toISOString(),
    windowEnd: new Date(Math.floor(nowMs / 60_000) * 60_000).toISOString(),
    mode: 'scheduled',
    headline,
    ratePerSecM: rate.savedM / 86_400,
    flows,
    destinations,
    topSavers,
    unpricedOutputIds: ['mrd_edge_cdn'],
    openIncidents: incidents.filter((i) => !i.closedAt).length,
    incidents,
    trend,
    ratioSeries: [],
    timeline,
    deliveries: [],
    calls: 23,
    collectingSince: new Date(collectingSinceMs).toISOString(),
    metricsSource: 'metrics-query',
    attributionSummary: 'route',
  };

  const settings: Settings = {
    ...defaultSettings(nowIso, TZ),
    runtime: 'backend',
    criblCostCentsPerMonth,
    humanize: { mrd_edge_cdn: 'edge-cdn-logs' },
    notifications: [
      // D57: Slack through a Cribl notification target (no build stores a webhook URL).
      {
        id: 'slack',
        name: 'Slack #cribl-savings',
        url: '',
        host: '',
        format: 'generic',
        minSeverity: 'medium',
        weeklyReceipt: true,
        enabled: true,
        channel: 'cribl-target',
        criblTargetId: 'cribl_savings_slack',
      },
    ],
  };
  const prices: PricesDoc = {
    schemaVersion: 1,
    updatedAt: new Date(collectingSinceMs).toISOString(),
    versions: [
      {
        effectiveFrom: new Date(collectingSinceMs).toISOString(),
        byOutputId: {
          mrd_siem_prod: { milliCentsPerGb: 250_000, preset: 'splunk_cloud' },
          mrd_analytics: { milliCentsPerGb: 150_000, preset: 'datadog' },
          mrd_archive_s3: { milliCentsPerGb: 3_000, preset: 's3', counterfactual: { kind: 'other', outputId: 'mrd_siem_prod' } },
        },
      },
    ],
  };
  const meta: Meta = {
    schemaVersion: 1,
    installedAt: new Date(collectingSinceMs).toISOString(),
    collectingSince: new Date(collectingSinceMs).toISOString(),
    appVersion: '1.0.0',
    build: 'release',
    metricsSource: 'metrics-query',
    lastSweepAt: sweepAt,
    lastSweepMs: 4100,
    lastSweepCalls: 23,
    lastSweepMode: 'scheduled',
    sweepErrors: 0,
    consecutiveRateLimited: 0,
    sweepCount: 64_800,
  };
  return { settings, prices, meta, snapshot };
}

// ─── Seeding ─────────────────────────────────────────────────────────────────

async function putKv(page: Page, docs: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (entries) => {
    for (const [key, value] of entries) {
      const r = await fetch(`/mock-api/v1/kvstore/${key}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(value) });
      if (r.status >= 300) throw new Error(`PUT ${key} → ${r.status}`);
    }
  }, Object.entries(docs));
}

/** Loads the Receipt over the enterprise fixture. Seeds twice so a sweep from the first (empty) load can't win. */
async function openSeeded(page: Page, path = '/', opts: FixtureOptions & { mutate?: (f: Fixture) => void } = {}): Promise<Fixture> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  let fixture = buildFixture(await page.evaluate(() => Date.now()), opts);
  opts.mutate?.(fixture);
  await putKv(page, { settings: fixture.settings, prices: fixture.prices, meta: fixture.meta, snapshot: fixture.snapshot });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  fixture = buildFixture(await page.evaluate(() => Date.now()), opts);
  opts.mutate?.(fixture);
  await putKv(page, { settings: fixture.settings, prices: fixture.prices, meta: fixture.meta, snapshot: fixture.snapshot });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await page.getByTestId('receipt-hero').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return fixture;
}

/**
 * Fixed-name evidence shots (`-1440`, the grid) are written by the chromium project only: the mobile project
 * would overwrite them with 390-wide DPR-3 images and chromium-1920 with 1920-wide ones (BEAUTY F28).
 */
function shoots(): boolean {
  return test.info().project.name === 'chromium';
}

/** Screenshots never carry a stray focus ring from the previous step. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.mouse.move(0, 0);
}

/** SPEC 12.4: the copied receipt's heading and total, every line within 48 columns. */
function expectReceiptText(text: string): void {
  expect(text).toContain('Meter Reader — receipt');
  expect(text).toContain('Saved by Cribl, month to date');
  for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(48);
}

async function meterValue(page: Page): Promise<number> {
  return Number(await page.locator('[data-testid="receipt-hero"] [data-callout="saved"]').getAttribute('data-value-m'));
}

/**
 * Net after Cribl as the Receipt figures it (core/net.ts): saved − the Cribl cost for the minutes from the later of
 * the period's start and when collecting began, to the sweep.
 */
function expectedNet(fx: Fixture, savedM: number, periodStartMs: number): NetOfCribl {
  const sweep = Date.parse(fx.snapshot.sweepAt);
  const from = Math.max(periodStartMs, Date.parse(fx.snapshot.collectingSince));
  const net = netOfCribl(savedM, (sweep - from) / 60_000, fx.settings.criblCostCentsPerMonth);
  if (!net) throw new Error('the fixture sets a Cribl cost');
  return net;
}

// ─── Behaviour ───────────────────────────────────────────────────────────────

test.describe('Receipt view', () => {
  test('hero shows month to date with the receipt bar, net line and callouts', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const fx = await openSeeded(page);
    const hero = page.getByTestId('receipt-hero');
    await expect(hero.getByRole('heading', { level: 1, name: 'Saved by Cribl' })).toBeVisible();
    await expect(page.getByTestId('hero-caption')).toHaveText('month to date');
    // The meter starts at the snapshot value and only moves up from there.
    expect(await meterValue(page)).toBeGreaterThanOrEqual(fx.snapshot.headline.mtdM);
    await expect(hero.locator('[data-callout="whp"]')).toBeVisible();
    await expect(hero.locator('[data-callout="paid"]')).toBeAttached();
    // The bar's legends foot to the saved figure (W3-RECEIPT-1): paid prints as would have paid − saved as printed.
    const footed = footMoney({ whpM: fx.snapshot.headline.whpMtdM, paidM: fx.snapshot.headline.paidMtdM, savedM: fx.snapshot.headline.mtdM });
    await expect(hero).toContainText(`You would have paid ${fmtDollars(footed.whpM)}`);
    await expect(hero).toContainText(`You paid ${fmtDollars(footed.paidM)}`);
    // Net after Cribl: saved − Cribl's cost for the minutes metered this month (core/net.ts), with what the cost covers.
    const net = expectedNet(fx, fx.snapshot.headline.mtdM, localMonthStartMs(Date.parse(fx.snapshot.sweepAt), TZ));
    await expect(page.getByTestId('receipt-net')).toContainText(`Net after Cribl ${fmtDollars(net.netM)}`);
    await expect(page.getByTestId('receipt-net')).toContainText(`Paid for itself ${(net.paybackX ?? 0).toFixed(1)}×`);
    await expect(page.getByTestId('receipt-net-basis')).toContainText(`Cribl cost ${fmtDollars(net.costM)}, prorated to the`);
    expect(errors()).toEqual([]);
  });

  test('the meter ticks at the snapshot rate inside a fixed box', async ({ page }) => {
    await openSeeded(page);
    const figure = page.locator('[data-testid="receipt-hero"] [data-callout="saved"]');
    await expect(figure).toHaveAttribute('data-ticking', 'true');
    const first = await meterValue(page);
    const boxes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const b = await figure.boundingBox();
      boxes.push(b ? `${b.x.toFixed(1)},${b.y.toFixed(1)},${b.width.toFixed(1)},${b.height.toFixed(1)}` : 'none');
      await page.waitForTimeout(250);
    }
    const last = await meterValue(page);
    expect(last).toBeGreaterThan(first);
    expect(new Set(boxes).size).toBe(1);
    // Cents only while ticking, as a trailing segment.
    await expect(page.locator('.mr-meter-cents')).toBeVisible();
  });

  test('a long figure never overflows a 390 px card: the meter shrinks to its box', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSeeded(page, '/', {
      mutate: (f) => {
        f.snapshot.headline.mtdM = 1_234_567_800_000; // $12,345,678
      },
    });
    const figure = page.locator('[data-testid="receipt-hero"] [data-callout="saved"]');
    const box = page.locator('[data-testid="receipt-hero"] .mr-hero-number');
    await expect(figure).toHaveAttribute('data-ticking', 'true');
    const f = await figure.boundingBox();
    const b = await box.boundingBox();
    if (!f || !b) throw new Error('no boxes');
    expect(f.x + f.width).toBeLessThanOrEqual(b.x + b.width + 0.5);
    const size = await figure.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeLessThan(56);
    expect(size).toBeGreaterThan(36);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await blur(page);
    if (shoots()) await page.screenshot({ path: 'tests/report/beauty/receipt-long-figure-light-390.png' });
  });

  test('period toggle drives ?period= and the annualized rate holds still', async ({ page }) => {
    const fx = await openSeeded(page);
    await page.getByRole('radio', { name: 'Annualized' }).or(page.getByRole('button', { name: 'Annualized' })).first().click();
    await expect.poll(() => new URL(page.url()).searchParams.get('period')).toBe('annualized');
    const figure = page.locator('[data-testid="receipt-hero"] [data-callout="saved"]');
    await expect(figure).toHaveAttribute('data-ticking', 'false');
    await expect(figure).toHaveText(fmtDollars(fx.snapshot.headline.annualizedM));
    await expect(page.getByTestId('hero-caption')).toHaveText('annualized run rate, from the last 30 days');
    await expect(page.getByTestId('receipt-net')).toContainText('/ year');
    await expect(page.getByTestId('receipt-net-basis')).toHaveText('· Cribl cost $420,000 a year');
    await setTheme(page, 'dark');
    await blur(page);
    if (shoots()) await page.screenshot({ path: 'tests/report/beauty/receipt-annualized-dark-1440.png' });

    await page.goto('/?period=today');
    await waitForHydration(page);
    await expect(page.getByTestId('hero-caption')).toHaveText('today');
    expect(await meterValue(page)).toBeGreaterThanOrEqual(fx.snapshot.headline.todayM);
    // Today has a net too: its Cribl cost is prorated to the hours metered since midnight.
    const today = expectedNet(fx, fx.snapshot.headline.todayM, localMidnightMs(Date.parse(fx.snapshot.sweepAt), TZ));
    await expect(page.getByTestId('receipt-net')).toContainText(`Net after Cribl ${fmtDollars(today.netM)}`);
    await expect(page.getByTestId('receipt-net-basis')).toContainText(`Cribl cost ${fmtDollars(today.costM)}, prorated to the`);
  });

  test('Show the math shows every formula, price, counterfactual and basis, live', async ({ page }) => {
    await openSeeded(page);
    await page.locator('.mr-hero-actions').getByRole('button', { name: 'Show the math' }).click();
    const drawer = page.getByTestId('math-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('Would have paid = bytes in × price');
    await expect(drawer).toContainText('Paid = bytes out × price');
    await expect(drawer).toContainText('Saved by Cribl = would have paid − paid');
    await expect(drawer).toContainText('1 GB = 1,000,000,000 bytes');
    await expect(drawer).toContainText('Without Cribl this data would go to SIEM (prod)');
    // $2.50 is not Splunk Cloud's typical $2.25: the member's own rate, beside the list price it replaced (P1-G01, P1-F10).
    await expect(drawer).toContainText('$2.50 / GB · Your rate · Splunk Cloud list $2.25');
    await expect(drawer).toContainText('Paid is measured at the route output');
    await expect(drawer).toContainText('edge-cdn-logs');
    const live1 = await page.getByTestId('math-live').textContent();
    await page.waitForTimeout(1_200);
    const live2 = await page.getByTestId('math-live').textContent();
    expect(live2).not.toBe(live1);
  });

  test('Copy receipt writes the SPEC 12.4 text and confirms', async ({ page, context, browserName }) => {
    await allowClipboard(context, browserName);
    await openSeeded(page);
    await page.getByRole('button', { name: 'Copy receipt' }).click();
    await expect(page.getByText('Receipt copied.')).toBeVisible();
    expectReceiptText(await readClipboard(page));
  });

  // Cribl runs the app in a sandboxed iframe: the async Clipboard API can be missing, or refuse a frame without
  // the clipboard-write permission. The hidden-textarea path must still put the receipt on the real clipboard
  // in every engine, and hand focus back to the button (it is activated from the keyboard here: WebKit never
  // focuses a button on a mouse click, so a click could not show that).
  for (const api of ['missing', 'rejects'] as const) {
    test(`Copy receipt falls back to a hidden textarea when the Clipboard API ${api === 'missing' ? 'is missing' : 'refuses'}`, async ({
      page,
      context,
      browserName,
    }) => {
      const errors = trackConsoleErrors(page);
      await allowClipboard(context, browserName);
      await stubClipboardApi(context, api);
      await openSeeded(page);
      const button = page.getByRole('button', { name: 'Copy receipt' });
      await button.focus();
      const scrollY = await page.evaluate(() => window.scrollY);
      await page.keyboard.press('Enter');
      await expect(page.getByText('Receipt copied.')).toBeVisible();
      expectReceiptText(await readClipboard(page));
      await expect(button).toBeFocused();
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
      await expect(page.locator('textarea[aria-hidden="true"]')).toHaveCount(0);
      expect(errors()).toEqual([]);
    });
  }

  test('Copy receipt says so when no clipboard path works', async ({ page, context }) => {
    await stubClipboardApi(context, 'missing', { execCommandFails: true });
    await openSeeded(page);
    await page.getByRole('button', { name: 'Copy receipt' }).click();
    await expect(page.getByText("Couldn't copy the receipt. Select the text and copy it manually.")).toBeVisible();
    await expect(page.getByText('Receipt copied.')).toHaveCount(0);
  });

  test('How this number is made expands the four-step strip and says where the bytes come from', async ({ page }) => {
    await openSeeded(page, '/', {
      mutate: (f) => {
        f.snapshot.attributionSummary = 'reconciled';
      },
    });
    const toggle = page.getByRole('button', { name: 'How this number is made' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const steps = page.getByRole('list', { name: 'How this number is made' }).getByRole('listitem');
    await expect(steps).toHaveCount(4);
    await expect(steps.first()).toContainText('Reads every flow, every minute');
    // DECISIONS D20: reconciled attribution, in the words the disclosure uses.
    const measured = page.getByTestId('how-measured');
    await expect(measured).toContainText("Bytes in are each source's own counter and bytes out each destination's");
    await expect(measured).toContainText("Cribl's per-route estimates split its bytes");
    await expect(measured).toContainText('Saved is the difference.');
  });

  test('top savers are receipt lines that deep-link to the pipeline in Cribl', async ({ page }) => {
    await openSeeded(page);
    const card = page.getByTestId('receipt-top-savers');
    const links = card.getByRole('list', { name: 'Top savers' }).getByRole('link');
    await expect(links).toHaveCount(5);
    await expect(card.getByRole('link', { name: 'See every flow in the Ledger' })).toHaveAttribute('href', '/ledger');
    const top = links.first();
    await expect(top).toHaveAttribute('target', '_top');
    const origin = new URL(page.url()).origin;
    await expect(top).toHaveAttribute('href', `${origin}/stream/m/default/pipelines/mrd_vpc_pack`);
    await expect(top).toContainText('VPC Flow aggregation');
    await expect(top).toContainText('$3,741');
  });

  test('where the money goes: bars, counterfactual and unpriced chips; unpriced notice links to prices', async ({ page }) => {
    await openSeeded(page);
    const card = page.getByTestId('receipt-destinations');
    await expect(card.getByRole('listitem')).toHaveCount(4);
    await expect(card).toContainText('Without Cribl → SIEM (prod)');
    await expect(card.locator('[data-chip="unpriced"]')).toHaveCount(1);
    const notice = page.getByTestId('unpriced-notice');
    await expect(notice).toContainText('1 destination is unpriced. Set prices to include it.');
    await notice.getByRole('button', { name: 'Set prices' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/settings/prices');
  });

  test('alerts card shows open incidents, and a designed empty state without them', async ({ page }) => {
    await openSeeded(page);
    const alerts = page.getByTestId('receipt-alerts');
    await expect(alerts).toContainText('Payments API sampling');
    await expect(alerts.getByRole('listitem')).toHaveCount(2);
    await openSeeded(page, '/', { withIncidents: false });
    await expect(page.getByTestId('receipt-alerts')).toContainText('No open alerts');
    // A calm line, not a box (BEAUTY F14): no dashed border anywhere in the card.
    const dashed = await page
      .getByTestId('receipt-alerts')
      .evaluate((el) => [el, ...el.querySelectorAll('*')].some((n) => getComputedStyle(n).borderTopStyle === 'dashed'));
    expect(dashed).toBe(false);
  });

  test('trend chart: deploy diamonds and a hover read-out', async ({ page }) => {
    await openSeeded(page);
    const chart = page.getByTestId('trend-chart');
    // Four deploys fall on whole days; today's (the open regression's commit) is on the partial day, which isn't drawn.
    await expect(chart.locator('[data-callout="change-marker"]')).toHaveCount(4);
    // On a phone the chart sits below the hero's fold: bring it on screen before pointing at it.
    await chart.scrollIntoViewIfNeeded();
    const box = await chart.boundingBox();
    if (!box) throw new Error('no chart box');
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
    await expect(page.getByTestId('trend-tip')).toBeVisible();
    await expect(page.getByTestId('trend-tip')).toContainText('Would have paid');
  });

  test('reduced motion: no ticking, whole dollars', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const fx = await openSeeded(page);
    const figure = page.locator('[data-testid="receipt-hero"] [data-callout="saved"]');
    await expect(figure).toHaveAttribute('data-ticking', 'false');
    await expect(page.locator('.mr-meter-cents')).toHaveCount(0);
    await expect(figure).toHaveText(fmtDollars(fx.snapshot.headline.mtdM));
  });

  test('a 403 on the snapshot shows an inline notice, not a blank page', async ({ page }) => {
    await openSeeded(page);
    await mockControl(page, { action: 'fault', method: 'GET', path: '/kvstore/snapshot', status: 403, times: -1 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.locator('[data-state="forbidden"]')).toBeVisible();
    await expect(page.getByRole('navigation').first()).toBeVisible();
    // Everything on the Receipt comes from the snapshot, so the copy claims nothing else works (BEAUTY F14),
    // and the page is a ghost of its own layout, not a blank.
    await expect(page.locator('[data-state="forbidden"]')).not.toContainText('Everything else');
    // Nothing will load until the read succeeds: the cards say so in one still line, never loading outlines (craft r2).
    await expect(page.locator('[data-state="error"][data-stopped="error"]')).toBeVisible();
    await expect(page.locator('[data-state="error"] .mr-ghost')).toHaveCount(0);
    await expect(page.getByTestId('ghost-card-stopped')).toHaveCount(4);
    await expect(page.getByTestId('ghost-card-stopped').first()).toHaveText('Nothing to show until the saved figures can be read.');
    await expect(page.getByTestId('hero-caption')).toHaveText("Figures appear here once your role can read Meter Reader's savings.");
    await blur(page);
    if (shoots()) await page.screenshot({ path: 'tests/report/beauty/receipt-state-403-light-1440.png', fullPage: true });
    await mockControl(page, { action: 'clearFaults' });
  });

  test('waiting for the first sweep is a ghost of the Receipt with one sentence, not an illustration', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/first-run');
    await resetMock(page);
    const fx = buildFixture(await page.evaluate(() => Date.now()));
    // Backend runtime: the tab never sweeps, so the snapshot stays absent and the waiting state holds still.
    await putKv(page, { settings: fx.settings, prices: fx.prices, meta: { ...fx.meta, lastSweepAt: undefined } });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const waiting = page.locator('[data-state="waiting"]');
    await expect(waiting).toBeVisible();
    await expect(page.getByTestId('hero-caption')).toHaveText('Waiting for the first sweep. Figures appear about a minute after metering starts.');
    await expect(waiting.locator('.mr-ghost')).toHaveCount(4);
    await expect(waiting).not.toHaveAttribute('data-stopped', /.+/);
    await expect(page.getByTestId('ghost-card-stopped')).toHaveCount(0);
    await expect(waiting.locator('svg image, img')).toHaveCount(0); // no stock illustration
    if (shoots()) {
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        for (const size of [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(size);
          await blur(page);
          await page.waitForTimeout(200);
          await page.screenshot({ path: `tests/report/beauty/receipt-state-waiting-${theme}-${size.width}.png`, fullPage: true });
        }
      }
    }
    expect(errors()).toEqual([]);
  });

  test('real sweep: prices alone, then the tab meters the emulated rig', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/first-run');
    await resetMock(page);
    const now = await page.evaluate(() => Date.now());
    await putKv(page, {
      prices: {
        schemaVersion: 1,
        updatedAt: new Date(now - 3 * DAY_MS).toISOString(),
        versions: [
          {
            effectiveFrom: new Date(now - 3 * DAY_MS).toISOString(),
            byOutputId: {
              mrd_siem_prod: { milliCentsPerGb: 250_000, preset: 'splunk_cloud' },
              mrd_analytics: { milliCentsPerGb: 150_000, preset: 'datadog' },
              mrd_archive_s3: { milliCentsPerGb: 3_000, preset: 's3' },
            },
          },
        ],
      },
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    // Waiting state first (no snapshot yet), then the sweep lands.
    const waiting = page.locator('[data-state="waiting"]');
    const sawWaiting = await waiting.waitFor({ timeout: 2_500 }).then(
      () => true,
      () => false,
    );
    if (sawWaiting && shoots()) await page.screenshot({ path: 'tests/report/beauty/receipt-state-waiting-light-1440.png', fullPage: true });
    await expect(page.getByTestId('receipt-hero')).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => meterValue(page), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId('receipt-top-savers').getByRole('list', { name: 'Top savers' }).getByRole('link').first()).toBeVisible();
    // Two days of history: the trend is in its learning state or just past it; either is designed.
    await expect(page.getByTestId('receipt-trend').locator('.mr-trend')).toHaveAttribute('data-state', /learning|ready/);
    await page.waitForTimeout(500);
    await blur(page);
    if (shoots()) await page.screenshot({ path: 'tests/report/beauty/receipt-state-realsweep-light-1440.png', fullPage: true });
    expect(errors()).toEqual([]);
  });
});

test.describe('Receipt on the bundled tour', () => {
  test('Tour with sample data lands on a ticking Receipt under the sample band', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page, '/first-run');
    await resetMock(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const tour = page.getByRole('button', { name: 'Tour with sample data' });
    await expect(tour).toBeVisible();
    await tour.click();
    await expect(page.getByTestId('receipt-hero')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-callout="sample-band"]')).toBeVisible();
    const figure = page.locator('[data-testid="receipt-hero"] [data-callout="saved"]');
    await expect(figure).toHaveAttribute('data-ticking', 'true');
    const v0 = await meterValue(page);
    await page.waitForTimeout(1_500);
    expect(await meterValue(page)).toBeGreaterThan(v0);
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await blur(page);
        await page.waitForTimeout(300);
        if (shoots()) await page.screenshot({ path: `tests/report/beauty/receipt-tour-${theme}-${width}.png`, fullPage: true });
      }
    }
    expect(errors()).toEqual([]);
  });
});

// ─── Young workspaces, failures and Show the math (wave 1, WP-H) ─────────────

/** 2:20 AM local, `days` days before the browser's today: a workspace that began metering mid-night. */
const sinceDaysAgo = (days: number) => (nowMs: number) => localDayStartMs(addDaysToKey(localDayKey(nowMs, TZ), -days), TZ) + (2 * 60 + 20) * 60_000;

/** Every open-drawer scroll container must be focusable or hold focusable content (axe scrollable-region-focusable). */
async function unreachableScrollRegions(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const focusable = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const out: string[] = [];
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      for (const el of [dialog, ...dialog.querySelectorAll('*')] as HTMLElement[]) {
        const style = getComputedStyle(el);
        const scrolls = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
        if (!scrolls) continue;
        const reachable = el.matches(focusable) || [...el.querySelectorAll<HTMLElement>(focusable)].some((n) => n.offsetParent !== null || n === el);
        if (!reachable) out.push(el.className || el.tagName);
      }
    }
    return out;
  });
}

async function openMath(page: Page): Promise<void> {
  await page.locator('.mr-hero-actions').getByRole('button', { name: 'Show the math' }).click();
  await page.getByTestId('math-drawer').waitFor();
}

test.describe('Receipt on a young workspace (P0-18, P1-H08)', () => {
  test('the trend starts the day collecting began, marks that day partial and counts the days (P0-18)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const fx = await openSeeded(page, '/', { collectingSince: sinceDaysAgo(4) });
    const todayKey = localDayKey(Date.parse(fx.snapshot.sweepAt), TZ);
    const sinceKey = addDaysToKey(todayKey, -4);
    // The snapshot carries the whole 30-day window, $0 before collecting began — as core does for a young org.
    expect(fx.snapshot.trend.filter((p) => p.day < sinceKey && p.savedM === 0).length).toBe(25);
    const chart = page.getByTestId('trend-chart');
    await expect(chart).toHaveAttribute('data-first-day', sinceKey);
    await expect(chart).toHaveAttribute('data-days', '4');
    await expect(chart).toHaveAttribute('data-partial-first', 'true');
    await expect(chart).toHaveAttribute('aria-label', 'Saved per day, last 30 days · 4 days collected');
    await expect(page.getByTestId('trend-partial')).toBeAttached();
    await expect(page.getByTestId('trend-legend-partial')).toHaveText('Partial first day');
    await expect(chart.locator('.mr-trend-xlabel').first()).toHaveText(formatLocalMonthDay(localDayStartMs(sinceKey, TZ), TZ));
    // The card's title says when the chart starts (not "the last 30 days"), its caption how many days it holds.
    const since = formatLocalMonthDay(Date.parse(fx.snapshot.collectingSince), TZ);
    const card = page.getByTestId('receipt-trend');
    await expect(card).toContainText(`Saved per day since ${since}`);
    await expect(card).not.toContainText('Saved over the last 30 days');
    await expect(card).toContainText('4 days metered so far · diamonds mark configuration deploys');
    await expect(chart.locator('.mr-trend-xlabel')).toHaveCount(4);
    // The first day's read-out says why its bar is short.
    await chart.focus();
    await page.keyboard.press('Home');
    await expect(page.getByTestId('trend-tip')).toContainText('Partial day: metered from 2:20 AM');
    expect(errors()).toEqual([]);
  });

  test('whole days in and nothing saved on any: one sentence over a $0 / $50 / $100 grid, no flat line (P0-18)', async ({ page }) => {
    await openSeeded(page, '/', {
      mutate: (f) => {
        f.snapshot.trend = f.snapshot.trend.map((p) => ({ ...p, savedM: 0, paidM: p.whpM }));
      },
    });
    const empty = page.getByTestId('trend-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('Nothing saved yet');
    await expect(empty).toContainText('Savings appear once a pipeline reduces what reaches a priced destination.');
    await expect(empty.locator('.mr-trend-ylabel')).toHaveText(['$0', '$50', '$100']);
    // No line and no diamonds are drawn, so the caption doesn't mention them.
    await expect(page.getByTestId('receipt-trend')).not.toContainText('diamonds');
    await expect(page.locator('[data-testid="receipt-trend"] .mr-trend-line')).toHaveCount(0);
    await expect(page.getByTestId('trend-chart')).toHaveCount(0);
  });

  test('metering for an hour opens on the annualized run rate; after a day, month to date (P1-H08)', async ({ page }) => {
    const fx = await openSeeded(page, '/', { collectingSince: (now) => now - 60 * 60_000 });
    await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'annualized');
    expect(new URL(page.url()).searchParams.get('period')).toBeNull();
    // Under a day it is a projection, and says how little traffic it rests on (craft review, round 1).
    await expect(page.getByTestId('hero-caption')).toHaveText(
      /^annualized run rate, projected from (the last \d+ (minutes?|hours?) of traffic|today so far) · settles after the first full day$/,
    );
    await expect(page.getByTestId('hero-projection')).toHaveText('Projection');
    const figure = page.locator('[data-testid="receipt-hero"] [data-callout="saved"]');
    await expect(figure).toHaveText(fmtDollars(fx.snapshot.headline.annualizedM));
    await expect(page.getByRole('radio', { name: 'Annualized' })).toBeChecked();
    // Choosing a period still wins, and sticks in the URL.
    await page.getByRole('radio', { name: 'MTD' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('period')).toBe('mtd');
    await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'mtd');
    await expect(page.getByTestId('hero-projection')).toHaveCount(0);

    await openSeeded(page, '/', { collectingSince: (now) => now - DAY_MS - 60 * 60_000 });
    await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'mtd');
    await expect(page.getByTestId('hero-caption')).toContainText('month to date');
  });
});

test.describe('Receipt when the snapshot cannot be read (P1-H03)', () => {
  const CASES = [
    { status: 500, state: 'server-error', caption: 'Figures appear here once Cribl answers again.' },
    { status: 401, state: undefined, caption: 'Figures appear here once you sign in to Cribl again.' },
    { status: 429, state: 'rate-limited', caption: 'Figures appear after the next sweep.' },
  ] as const;
  for (const c of CASES) {
    test(`a ${c.status} gets its own sentence, not the 403 role sentence`, async ({ page }) => {
      await openSeeded(page);
      await mockControl(page, { action: 'fault', method: 'GET', path: '/kvstore/snapshot', status: c.status, times: -1 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForHydration(page);
      await expect(page.getByTestId('hero-caption')).toHaveText(c.caption);
      await expect(page.getByTestId('hero-caption')).not.toContainText('role');
      // Nothing from the snapshot is on the page, so the notice never says it is showing the last good data.
      if (c.status === 500) await expect(page.locator('[data-state="server-error"]')).toContainText('Nothing to show yet. Meter Reader will keep trying.');
      await expect(page.locator('main')).not.toContainText('Showing the last good data');
      if (c.state) await expect(page.locator(`[data-state="${c.state}"]`)).toBeVisible();
      if (c.status === 429) {
        // DESIGN_BRIEF §6: "Rate limited by the Leader. Next sweep in 0:42." — and it counts down.
        const notice = page.locator('[data-state="rate-limited"]');
        await expect(notice).toContainText(/Next sweep in \d+:\d\d/, { timeout: 20_000 });
        const first = await notice.textContent();
        await expect.poll(async () => notice.textContent(), { timeout: 5_000 }).not.toBe(first);
      }
      await mockControl(page, { action: 'clearFaults' });
    });
  }

  test('Settings under a 503 shows exactly one alert, the prices section a quiet ghost', async ({ page }) => {
    await openSeeded(page);
    await mockControl(page, { action: 'fault', method: 'GET', path: '/kvstore/', status: 503, times: -1 });
    // Settings can't be read, so the app never hydrates: wait for the page's own notice instead.
    await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-state="settings-error"]')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    await expect(page.locator('[data-state="server-error"]')).toHaveCount(1);
    await expect(page.getByRole('alert')).toHaveCount(1);
    await mockControl(page, { action: 'clearFaults' });
  });
});

test.describe('Show the math (P1-F09, P1-H07, net of Cribl)', () => {
  test('month to date: each destination shows its month, and the rows add up to the figure above (P1-F09)', async ({ page }) => {
    const fx = await openSeeded(page);
    await openMath(page);
    const drawer = page.getByTestId('math-drawer');
    await expect(drawer.getByRole('heading', { name: 'At each destination, month to date' })).toBeVisible();
    const h = fx.snapshot.headline;
    await expect(page.getByTestId('math-reconcile')).toHaveAttribute('data-matches', 'true');
    // Printed money adds up (core/format footMoney): whole dollars, would have paid − paid = saved (review W2).
    const hf = footMoney({ whpM: h.whpMtdM, paidM: h.paidMtdM, savedM: h.mtdM });
    await expect(page.getByTestId('math-reconcile')).toHaveText(
      `These rows add up to the figures above: ${fmtDollars(hf.whpM)} would have paid − ${fmtDollars(hf.paidM)} paid = ${fmtDollars(hf.savedM)} saved month to date.`,
    );
    const siem = fx.snapshot.destinations.find((d) => d.outputId === 'mrd_siem_prod')!;
    const sf = footMoney({ whpM: siem.mtdWhpM, paidM: siem.mtdPaidM, savedM: siem.mtdSavedM });
    await expect(drawer.getByTestId('math-dest-mtd').first()).toContainText(`${fmtDollars(sf.whpM)} − ${fmtDollars(sf.paidM)} = ${fmtDollars(sf.savedM)} saved`);
    expect(Math.round((sf.whpM - sf.paidM) / 100_000)).toBe(Math.round(sf.savedM / 100_000));
    await expect(page.getByTestId('math-rate-note')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Other periods: the rows are the last hour × 24, and the drawer says they are not parts of the figure.
    await page.getByRole('radio', { name: 'Today' }).click();
    await openMath(page);
    await expect(drawer.getByRole('heading', { name: 'At each destination, per day at current rates' })).toBeVisible();
    await expect(page.getByTestId('math-rate-note')).toHaveText(
      "Per day at current rates means the last hour × 24: where the money goes now. These rows are a rate, so they don't add up to the figure above.",
    );
    await expect(page.getByTestId('math-reconcile')).toHaveCount(0);
  });

  test('destination heads say "priced as <preset>" like Where the money goes; unpriced ones keep their type', async ({ page }) => {
    await openSeeded(page);
    await openMath(page);
    const heads = page.locator('[data-testid="math-drawer"] .mr-math-dest-head');
    await expect(heads.filter({ hasText: 'SIEM (prod)' })).toContainText('priced as Splunk Cloud');
    await expect(heads.filter({ hasText: 'analytics' })).toContainText('priced as Datadog');
    await expect(heads.filter({ hasText: 'Archive (S3)' })).toContainText('priced as Amazon S3');
    await expect(heads.filter({ hasText: 'edge-cdn-logs' })).toContainText('webhook');
    await expect(page.locator('[data-testid="math-drawer"] [data-basis="type"]')).toHaveCount(1);
    // The same words as the Receipt's own rows.
    for (const preset of ['Splunk Cloud', 'Datadog', 'Amazon S3']) {
      await expect(page.getByTestId('receipt-destinations')).toContainText(`priced as ${preset}`);
    }
  });

  test("net after Cribl: the formula with values, the payback, the cost's basis and Cribl's list price (D48)", async ({ page }) => {
    const fx = await openSeeded(page);
    await openMath(page);
    const net = expectedNet(fx, fx.snapshot.headline.mtdM, localMonthStartMs(Date.parse(fx.snapshot.sweepAt), TZ));
    const section = page.getByTestId('math-net');
    await expect(section).toContainText("Net after Cribl = saved − Cribl's cost for the same span");
    await expect(section).toContainText(`${fmtDollars(fx.snapshot.headline.mtdM)} − ${fmtDollars(net.costM)} = ${fmtDollars(net.netM)}`);
    const drawer = page.getByTestId('math-drawer');
    await expect(drawer).toContainText(`${fmtDollars(fx.snapshot.headline.mtdM)} ÷ ${fmtDollars(net.costM)} = ${(net.paybackX ?? 0).toFixed(1)}×`);
    // $35,000 a month × 12 ÷ 365 = $1,150.68 a day.
    await expect(page.getByTestId('math-net-cost')).toHaveText('Cribl cost: $35,000.00 a month, from Settings → Cribl cost. That is $1,150.68 a day (× 12 months ÷ 365 days).');
    // A span that starts at a local midnight names the day, not "12:00 AM".
    const monthStart = localMonthStartMs(Date.parse(fx.snapshot.sweepAt), TZ);
    await expect(page.getByTestId('math-net-span')).toContainText('Prorated to the');
    await expect(page.getByTestId('math-net-span')).toHaveText(
      new RegExp(`^Prorated to the [\\d.]+ \\w+ metered since ${formatLocalMonthDay(monthStart, TZ)}: ${fmtDollars(net.costM).replace('$', '\\$')}\\.$`),
    );
    await expect(page.getByTestId('math-net-rate')).toContainText("Cribl's published Enterprise Cloud Worker list price is $0.32 per GB, billed on the bytes Cribl receives");
    // The hero's net line is the receipt's total: its own row, the payback chip, the basis.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="receipt-net"] .mr-rbar-net-payback')).toHaveAttribute('data-full', 'true');
    const size = await page.locator('[data-testid="receipt-net"] .mr-rbar-net-amount').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(20);
  });

  test('Settings → Cribl cost previews the same month-to-date net as the Receipt (the metered span, not day 26 of 30)', async ({ page }) => {
    // A workspace metering for two days: SPEC 8 would charge the month's days so far against two days of savings.
    const fx = await openSeeded(page, '/', { collectingSince: sinceDaysAgo(2) });
    const net = expectedNet(fx, fx.snapshot.headline.mtdM, localMonthStartMs(Date.parse(fx.snapshot.sweepAt), TZ));
    await page.getByRole('radio', { name: 'MTD' }).click();
    await expect(page.getByTestId('receipt-net')).toContainText(`Net after Cribl ${fmtDollars(net.netM)}`);
    await gotoApp(page, '/settings?section=cost');
    await waitForHydration(page);
    await expect(page.getByTestId('cost-net')).toContainText(fmtDollars(net.netM));
    await expect(page.getByTestId('cost-payback')).toContainText(`${(net.paybackX ?? 0).toFixed(1)}×`);
    await expect(page.getByTestId('cost-basis')).toHaveText(/^Cost prorated to the [\d.]+ (days|hours) metered this month, the same span as the savings\.$/);
  });

  test('the net line shows on every period and the hero keeps its height as the periods toggle (P1-F12)', async ({ page }) => {
    await openSeeded(page, '/?period=mtd');
    const hero = page.locator('.mr-hero').first();
    const heights: number[] = [];
    for (const name of ['MTD', 'Today', '30 days', 'Annualized']) {
      await page.getByRole('radio', { name }).click();
      await expect(page.getByTestId('receipt-net')).toBeVisible();
      await page.waitForTimeout(250);
      heights.push(Math.round((await hero.boundingBox())!.height));
    }
    expect(new Set(heights).size, `hero heights ${heights.join(', ')}`).toBe(1);
  });

  test("a Source cloned to two routes: the drawer prints Cribl's list price alone, never a double-counted $/GB (D48)", async ({ page }) => {
    await openSeeded(page, '/', {
      mutate: (f) => {
        // An archive copy of the first flow on a non-final route: the same Source bytes on a second flow.
        const first = f.snapshot.flows[0];
        f.snapshot.flows = [...f.snapshot.flows, { ...first, key: `${first.key}/archive`, routeId: 'r_archive' }];
      },
    });
    await openMath(page);
    await expect(page.getByTestId('math-net-rate')).toHaveText(
      "Cribl's published Enterprise Cloud Worker list price is $0.32 per GB, billed on the bytes Cribl receives: a pipeline's reduction lowers the destination's bill, not Cribl's.",
    );
    await expect(page.getByTestId('math-net-rate')).not.toContainText('this workspace receives');
  });

  test('without a Cribl cost, the hero nets a labelled list-price estimate with a link to the real cost, and the section says how to add one', async ({ page }) => {
    await openSeeded(page, '/', {
      mutate: (f) => {
        delete f.settings.criblCostCentsPerMonth;
      },
    });
    // Usefulness review, round 2: "did Cribl pay for itself?" is never blank when the ingest is measured, and never
    // passed off as the contract figure.
    const net = page.getByTestId('receipt-net');
    await expect(net).toHaveAttribute('data-estimate', 'true');
    await expect(net).toContainText('Net after Cribl ≈');
    await expect(net).toContainText(/(Paid for itself ≈[\d.]+× at list price|Covered ≈\d+% of its cost at list price)/);
    await expect(net).toContainText(/Estimate at Cribl's list price: .+ a day × \$0\.32 per GB ≈ \$[\d,]+ a month\./);
    await expect(net.getByTestId('receipt-net-estimate-link')).toHaveText('Set your contract cost');
    await expect(net.getByTestId('receipt-net-estimate-link')).toHaveAttribute('href', /\/settings\?section=cost/);
    // …and it lands on Settings → Cribl cost (a path Settings does not serve would bounce to the Receipt)
    await net.getByTestId('receipt-net-estimate-link').click();
    await expect(page.locator('.mr-settings[data-section="cost"]')).toBeVisible();
    await page.goBack();
    await openMath(page);
    await expect(page.getByTestId('math-net-none')).toHaveText(
      'No Cribl cost is set. Add what you pay Cribl each month under Settings → Cribl cost to see net savings and how many times Cribl paid for itself.',
    );
  });

  test('the drawer body is a keyboard stop, so its formulas can be scrolled (P1-H07, WCAG 2.1.1)', async ({ page }) => {
    await openSeeded(page);
    await openMath(page);
    const region = page.getByRole('region', { name: 'The formulas, prices and assumptions' });
    await expect(region).toHaveAttribute('tabindex', '0');
    expect(await unreachableScrollRegions(page)).toEqual([]);
    // Tab from the dialog's first close control lands on the region; the arrow keys then scroll it.
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /close/i }).first().focus();
    await page.keyboard.press('Tab');
    await expect(region).toBeFocused();
    const scroller = await region.evaluate((el) => {
      let n: HTMLElement | null = el as HTMLElement;
      while (n && !(n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY))) n = n.parentElement;
      return n ? n.className : null;
    });
    expect(scroller).not.toBeNull();
    const before = await page.evaluate((cls) => document.getElementsByClassName(cls!)[0]?.scrollTop ?? 0, scroller);
    await page.keyboard.press('PageDown');
    await expect.poll(() => page.evaluate((cls) => document.getElementsByClassName(cls!)[0]?.scrollTop ?? 0, scroller)).toBeGreaterThan(before);
  });

  test('the live line is a rate a minute in cents, and never more than two decimals (P1-H07)', async ({ page }) => {
    const fx = await openSeeded(page);
    await openMath(page);
    const section = page.getByTestId('math-drawer').locator('.mr-math-section').filter({ has: page.getByRole('heading', { name: 'Between sweeps' }) });
    await expect(section).toContainText(`The meter adds ${fmtDollarsCents(fx.snapshot.ratePerSecM * 60)} a minute (the last completed minute of savings) since the sweep at`);
    const text = (await section.textContent()) ?? '';
    expect(text).not.toMatch(/\d\.\d{3,}/);
    expect(text).not.toContain('per second');
    await expect(page.getByTestId('math-live')).toHaveText(/^\$[\d,]+\.\d\d \+ \$[\d,]+\.\d\d = \$[\d,]+\.\d\d$/);
  });
});

// ─── Evidence (wave 1, WP-H): every visible change in both themes at 1440 and 390 ───

test.describe('Receipt wave-1 evidence', () => {
  const SIZES = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ] as const;
  const THEMES = ['light', 'dark'] as const;
  const shot = (name: string, theme: string, width: number) => `tests/report/screens/wave1-h-${name}-${theme}-${width}.png`;

  /** Runs `each` for both themes × 1440 / 390 on the page as it is. */
  async function grid(page: Page, each: (theme: (typeof THEMES)[number], width: number) => Promise<void>): Promise<void> {
    for (const theme of THEMES) {
      await setTheme(page, theme);
      for (const size of SIZES) {
        await page.setViewportSize(size);
        await blur(page);
        await page.waitForTimeout(350);
        await each(theme, size.width);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await setTheme(page, 'light');
  }

  test.beforeEach(({ browserName }, info) => {
    test.skip(browserName !== 'chromium' || info.project.name !== 'chromium', 'evidence is shot once, from the chromium project (it sets every width itself)');
    test.setTimeout(240_000);
  });

  test('P0-18: the trend on a young workspace, and with nothing saved', async ({ page }) => {
    await openSeeded(page, '/', { collectingSince: sinceDaysAgo(4) });
    await grid(page, async (theme, width) => {
      await page.getByTestId('receipt-trend').screenshot({ path: shot('p018-young-trend', theme, width) });
    });
    // The whole page first, from the top (focusing the chart scrolls, and a full-page shot then paints the sticky nav mid-page).
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: shot('p018-young-receipt', 'light', 1440), fullPage: true });
    const chart = page.getByTestId('trend-chart');
    await chart.focus();
    await page.keyboard.press('Home');
    await page.getByTestId('trend-tip').waitFor();
    await page.getByTestId('receipt-trend').screenshot({ path: shot('p018-young-trend-tip', 'light', 1440) });

    await openSeeded(page, '/', {
      mutate: (f) => {
        f.snapshot.trend = f.snapshot.trend.map((p) => ({ ...p, savedM: 0, paidM: p.whpM }));
      },
    });
    await grid(page, async (theme, width) => {
      await page.getByTestId('receipt-trend').screenshot({ path: shot('p018-empty-trend', theme, width) });
    });
  });

  test('P1-H08: an hour-old workspace lands on the annualized run rate', async ({ page }) => {
    await openSeeded(page, '/', { collectingSince: (now) => now - 60 * 60_000 });
    await grid(page, async (theme, width) => {
      await page.screenshot({ path: shot('h08-landing', theme, width) });
    });
  });

  test('P1-H03: each failure has its own sentence; Settings shows one alert', async ({ page }) => {
    for (const status of [500, 429, 401] as const) {
      await openSeeded(page);
      await mockControl(page, { action: 'fault', method: 'GET', path: '/kvstore/snapshot', status, times: -1 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForHydration(page);
      await page.getByTestId('hero-caption').waitFor();
      if (status === 429) await expect(page.locator('[data-state="rate-limited"]')).toContainText(/Next sweep in/, { timeout: 20_000 });
      await grid(page, async (theme, width) => {
        await page.screenshot({ path: shot(`h03-snapshot-${status}`, theme, width) });
      });
      await mockControl(page, { action: 'clearFaults' });
    }
    await openSeeded(page);
    await mockControl(page, { action: 'fault', method: 'GET', path: '/kvstore/', status: 503, times: -1 });
    await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-state="settings-error"]').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1_000);
    await grid(page, async (theme, width) => {
      await page.screenshot({ path: shot('h03-settings-503', theme, width) });
    });
    await mockControl(page, { action: 'clearFaults' });
  });

  test('Show the math: net of Cribl, priced as, month-to-date rows, the focusable body and the live line', async ({ page }) => {
    await openSeeded(page);
    await grid(page, async (theme, width) => {
      await page.getByTestId('receipt-hero').screenshot({ path: shot('net-hero-mtd', theme, width) });
    });
    await page.getByRole('radio', { name: 'Annualized' }).click();
    await grid(page, async (theme, width) => {
      await page.getByTestId('receipt-hero').screenshot({ path: shot('net-hero-annualized', theme, width) });
    });
    await page.getByRole('radio', { name: 'MTD' }).click();
    await grid(page, async (theme, width) => {
      await openMath(page);
      await page.waitForTimeout(400);
      await page.screenshot({ path: shot('math-top', theme, width) });
      await page.getByTestId('math-net').scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: shot('math-net', theme, width) });
      await page.getByTestId('math-reconcile').scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: shot('math-mtd-rows', theme, width) });
      await page.getByRole('heading', { name: 'Between sweeps' }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: shot('math-live', theme, width) });
      // Keyboard: Tab from the close control onto the scrollable body (the app's focus ring).
      await page.getByRole('dialog').getByRole('button', { name: /close/i }).first().focus();
      await page.keyboard.press('Tab');
      await page.waitForTimeout(150);
      await page.screenshot({ path: shot('math-focus', theme, width) });
      await page.keyboard.press('Escape');
      await page.getByTestId('math-drawer').waitFor({ state: 'detached' });
    });
    await page.getByRole('radio', { name: 'Today' }).click();
    await grid(page, async (theme, width) => {
      await openMath(page);
      await page.getByTestId('math-rate-note').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: shot('math-today-rows', theme, width) });
      await page.keyboard.press('Escape');
      await page.getByTestId('math-drawer').waitFor({ state: 'detached' });
    });
  });

  test('Settings → Cribl cost: the preview prorates to the span metered, on a two-day-old workspace', async ({ page }) => {
    await openSeeded(page, '/', { collectingSince: sinceDaysAgo(2) });
    await gotoApp(page, '/settings?section=cost');
    await waitForHydration(page);
    await page.getByTestId('cost-preview').waitFor();
    await grid(page, async (theme, width) => {
      await page.locator('section.mr-set-card[data-section="cost"]').scrollIntoViewIfNeeded();
      await page.locator('section.mr-set-card[data-section="cost"]').screenshot({ path: shot('cost-preview', theme, width) });
    });
    // The Receipt on the same workspace, month to date: the hero's net matches the preview.
    await gotoApp(page, '/?period=mtd');
    await waitForHydration(page);
    await grid(page, async (theme, width) => {
      await page.getByTestId('receipt-hero').screenshot({ path: shot('net-hero-young-mtd', theme, width) });
    });
  });
});

// ─── Beauty grid (PRD 8.8) ───────────────────────────────────────────────────

const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

test.describe('Receipt beauty grid', () => {
  test('screenshots: both themes × 390 / 1440 / 1920, plus math, how and tooltip', async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'the grid is shot once, from the chromium project (it sets every width itself)');
    test.setTimeout(180_000);
    const errors = trackConsoleErrors(page);
    await openSeeded(page);
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme);
      for (const size of WIDTHS) {
        await page.setViewportSize(size);
        await blur(page);
        await page.waitForTimeout(350);
        // No horizontal page scroll at any width.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `horizontal overflow at ${size.width}`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: `tests/report/beauty/receipt-${theme}-${size.width}.png`, fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('button', { name: 'How this number is made' }).click();
      const chart = page.getByTestId('trend-chart');
      const box = await chart.boundingBox();
      if (box) await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.35);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `tests/report/beauty/receipt-how-tip-${theme}-1440.png`, fullPage: false, clip: undefined });
      await page.getByRole('button', { name: 'How this number is made' }).click();
      await page.locator('.mr-hero-actions').getByRole('button', { name: 'Show the math' }).click();
      await page.getByTestId('math-drawer').waitFor();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `tests/report/beauty/receipt-math-${theme}-1440.png` });
      await page.getByTestId('math-drawer').getByText('Between sweeps').scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `tests/report/beauty/receipt-math-end-${theme}-1440.png` });
      await page.keyboard.press('Escape');
      await page.getByTestId('math-drawer').waitFor({ state: 'detached' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('.mr-hero-actions').getByRole('button', { name: 'Show the math' }).click();
      await page.getByTestId('math-drawer').waitFor();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `tests/report/beauty/receipt-math-${theme}-390.png` });
      await page.keyboard.press('Escape');
      await page.getByTestId('math-drawer').waitFor({ state: 'detached' });
    }
    expect(errors()).toEqual([]);
  });
});

// ─── Wave 2 (WP-H): the hero aside, wrapping savers, card voids, motion ──────

/** The bundled sample tour, landed on the Receipt. */
async function openTour(page: Page): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await page.getByRole('button', { name: 'Tour with sample data' }).click();
  await expect(page.getByTestId('receipt-hero')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
}

const heroFigure = (page: Page) => page.locator('[data-testid="receipt-hero"] [data-callout="saved"]');

/** Every receipt line's words are whole (never ellipsised or clipped), and a list's amounts share one right edge. */
async function receiptLinesIntact(page: Page, scope: string): Promise<{ clipped: string[]; rightEdges: number[] }> {
  return page.evaluate((sel) => {
    const clipped: string[] = [];
    const root = document.querySelector(sel);
    for (const label of root?.querySelectorAll<HTMLElement>('.mr-rlist-label') ?? []) {
      const box = label.closest('.mr-rlist-labelbox') as HTMLElement;
      const style = getComputedStyle(label);
      const words = label.getBoundingClientRect();
      const room = box.getBoundingClientRect();
      if (style.textOverflow === 'ellipsis' || style.whiteSpace === 'nowrap' || words.right > room.right + 0.5 || getComputedStyle(box).textOverflow === 'ellipsis') {
        clipped.push(label.textContent ?? '');
      }
    }
    const rightEdges = [...(root?.querySelectorAll<HTMLElement>('.mr-rlist-amount') ?? [])].map((a) => Math.round(a.getBoundingClientRect().right));
    return { clipped, rightEdges };
  }, scope);
}

test.describe('Receipt wave 2 (WP-H)', () => {
  test('P1-H01: at 1024 px and up the hero right half holds the other periods; a phone keeps one column', async ({ page }) => {
    const fx = await openSeeded(page, '/?period=mtd');
    const aside = page.getByTestId('hero-aside');
    const width = page.viewportSize()!.width;
    if (width < 1024) {
      await expect(aside).toBeHidden();
      const columns = await page.locator('.mr-hero').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      expect(columns).toBe(1);
      return;
    }
    await expect(aside).toBeVisible();
    // The other three periods (MTD is the number itself), in whole dollars as the wheels show them, then a day at current rates.
    await expect(page.getByTestId('hero-aside-mtd')).toHaveCount(0);
    const floor = (m: number) => fmtDollars(Math.floor(m / 100_000) * 100_000);
    await expect(page.getByTestId('hero-aside-today')).toContainText(floor(fx.snapshot.headline.todayM));
    await expect(page.getByTestId('hero-aside-30d')).toContainText(floor(fx.snapshot.headline.d30M));
    await expect(page.getByTestId('hero-aside-annualized')).toContainText(floor(fx.snapshot.headline.annualizedM));
    await expect(page.getByTestId('hero-aside-annualized')).toContainText('/ year');
    const perDay = fx.snapshot.flows.reduce((sum, f) => sum + Math.max(0, f.savedPerDayM), 0);
    await expect(page.getByTestId('hero-aside-now')).toContainText(fmtDollars(perDay));
    // Geometry: the aside sits in the card's right half, and no band wider than 300 px is left beside the number.
    const hero = (await page.getByTestId('receipt-hero').boundingBox())!;
    const box = (await aside.boundingBox())!;
    const figure = (await heroFigure(page).boundingBox())!;
    expect(box.x + box.width / 2).toBeGreaterThan(hero.x + hero.width / 2);
    expect(box.x - (figure.x + figure.width), 'empty band beside the meter').toBeLessThanOrEqual(300);
    // A line is a button that switches the period.
    await page.getByTestId('hero-aside-today').getByRole('button').click();
    await expect(page).toHaveURL(/period=today/);
    await expect(page.getByTestId('hero-aside-mtd')).toBeVisible();
    await expect(page.getByTestId('hero-aside-today')).toHaveCount(0);
  });

  test('P1-H02: on the tour no top-saver label is cut, and the amounts stay right-aligned', async ({ page }) => {
    await openTour(page);
    const card = '[data-testid="receipt-top-savers"]';
    const { clipped, rightEdges } = await receiptLinesIntact(page, card);
    expect(clipped, 'labels cut short').toEqual([]);
    expect(rightEdges.length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...rightEdges) - Math.min(...rightEdges), `amount right edges ${rightEdges.join(', ')}`).toBeLessThanOrEqual(1);
    // The unit is the caption's ("per day"), not repeated on every line.
    await expect(page.locator(card).locator('.mr-rlist-per')).toHaveCount(0);
    await expect(page.locator(card).locator('.mr-receipt-card-caption')).toContainText('per day');
  });

  test('P1-H04: the savers end in a total, the empty Alerts card says what it watches, one Show the math', async ({ page }) => {
    await openTour(page);
    const savers = page.getByTestId('receipt-top-savers');
    await expect(savers.getByTestId('savers-total')).toContainText('All flows');
    // The total is every saving flow at current rates: the same figure as the hero's "A day at current rates".
    if (page.viewportSize()!.width >= 1024) {
      const total = (await savers.getByTestId('savers-total').locator('.mr-rlist-amount').textContent())!.trim();
      await expect(page.getByTestId('hero-aside-now').locator('.mr-rlist-amount')).toHaveText(total);
    }
    if (page.viewportSize()!.width === 1440) {
      const band = await savers.evaluate((card) => {
        const lists = card.querySelectorAll('.mr-rlist');
        const list = lists[lists.length - 1].getBoundingClientRect();
        const foot = card.querySelector('.mr-receipt-card-foot')!.getBoundingClientRect();
        return foot.top - list.bottom;
      });
      expect(band, 'empty band above the savers footer').toBeLessThanOrEqual(40);
    }
    const alerts = page.getByTestId('receipt-alerts');
    await expect(alerts.getByText('No open alerts')).toBeVisible();
    await expect(alerts.getByTestId('alerts-watching')).toContainText(/Savings ratio.*routes/s);
    await expect(alerts.getByTestId('alerts-watching')).toContainText(/Cost spikes.*sources/s);
    // The How panel no longer carries a second Show the math: exactly one is visible with it open.
    const toggle = page.getByRole('button', { name: 'How this number is made' });
    const size = await toggle.evaluate((el) => ({ h: el.getBoundingClientRect().height, font: parseFloat(getComputedStyle(el).fontSize) }));
    expect(size.h).toBeGreaterThanOrEqual(32);
    expect(size.font).toBeGreaterThanOrEqual(14);
    await toggle.click();
    await expect(page.getByTestId('how-measured')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show the math' }).filter({ visible: true })).toHaveCount(1);
  });

  test('P1-H04: a compact alert is an eyebrow (kind · time) over a one-line object title', async ({ page }) => {
    await openSeeded(page);
    const card = page.getByTestId('receipt-alerts').locator('.mr-inc--compact').first();
    await expect(card.getByRole('heading', { name: 'Savings dropped: Payments API sampling' })).toBeVisible();
    await expect(card.locator('.mr-inc-eyebrow')).toContainText(/Savings dropped\s*·\s*\d{1,2}:\d{2} [AP]M/);
    const lines = await card.locator('.mr-inc-title').evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    expect(lines).toBe(1);
  });

  test('P1-H09: MTD → Today rolls the digits; How reveals; the Custom popover never covers the number', async ({ page }) => {
    const fx = await openSeeded(page, '/?period=mtd');
    await expect(heroFigure(page)).toHaveAttribute('data-ticking', 'true');
    const mtdM = fx.snapshot.headline.mtdM;
    const todayM = fx.snapshot.headline.todayM;
    // Sample the figure every frame for 1 s from the click: a roll passes through values between the two. (The Meter
    // refreshes data-value-m at most every 250 ms, so a 900 ms roll shows two or three of them; a cut shows none.)
    const sampling = page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const seen: number[] = [];
          const start = performance.now();
          const tick = () => {
            const el = document.querySelector('[data-testid="receipt-hero"] [data-callout="saved"]');
            if (el) seen.push(Number(el.getAttribute('data-value-m')));
            if (performance.now() - start < 1000) requestAnimationFrame(tick);
            else resolve(seen);
          };
          requestAnimationFrame(tick);
        }),
    );
    await page.getByRole('radio', { name: 'Today' }).click();
    const seen = await sampling;
    const between = seen.filter((v) => v > todayM + $(1_000) && v < mtdM - $(1_000));
    expect(new Set(between).size, 'values between the two figures').toBeGreaterThanOrEqual(2);
    await expect.poll(() => meterValue(page)).toBeLessThan(todayM + $(100));

    // How this number is made: the panel eases open (its row and opacity transition), and is inert while shut.
    const panel = page.getByTestId('how-panel');
    await expect(panel).toHaveAttribute('inert', '');
    const transition = await panel.evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(transition).toContain('grid-template-rows');
    await page.getByRole('button', { name: 'How this number is made' }).click();
    await expect(panel).not.toHaveAttribute('inert', '');
    await expect(page.getByTestId('how-measured')).toBeVisible();

    // The Custom popover opens under the toggle's right end, over the empty right half — never over the figure.
    await page.getByRole('radiogroup', { name: 'Headline period' }).getByRole('radio', { name: 'Custom' }).click();
    const dialog = page.getByRole('dialog', { name: 'Custom range' });
    await expect(dialog).toBeVisible();
    const pop = (await dialog.boundingBox())!;
    const fig = (await heroFigure(page).boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(pop.x + pop.width).toBeLessThanOrEqual(width + 0.5);
    if (width >= 1024) {
      const overlaps = pop.x < fig.x + fig.width && fig.x < pop.x + pop.width && pop.y < fig.y + fig.height && fig.y < pop.y + pop.height;
      expect(overlaps, 'popover over the hero figure').toBe(false);
    }
    await page.keyboard.press('Escape');
  });
});

/** Under forced colours the hero bar's two segments keep their own fills and gain an outline (P1-H05). */
async function expectForcedColorsBar(page: Page): Promise<void> {
  await page.emulateMedia({ forcedColors: 'active' });
  const parts = await page.evaluate(() =>
    ['.mr-rbar-paid', '.mr-rbar-saved'].map((sel) => {
      const cs = getComputedStyle(document.querySelector(sel)!);
      return { adjust: cs.forcedColorAdjust, bg: cs.backgroundColor, border: cs.borderTopWidth };
    }),
  );
  for (const p of parts) {
    expect(p.adjust).toBe('none');
    expect(p.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(p.border).toBe('1px');
  }
  expect(parts[0].bg).not.toBe(parts[1].bg);
  await page.emulateMedia({ forcedColors: 'none' });
}

test.describe('Receipt wave 2 (WP-H), bars and the learning trend', () => {
  /** Adjacent paid / saved segments: their gap in px and the contrast of their fills. */
  async function segmentPairs(page: Page): Promise<{ where: string; gap: number; contrast: number }[]> {
    return page.evaluate(() => {
      const lum = (c: string): number => {
        const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
        const [r, g, b] = m.slice(0, 3).map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const fill = (el: Element): string => {
        const own = getComputedStyle(el).backgroundColor;
        return own !== 'rgba(0, 0, 0, 0)' ? own : getComputedStyle(el, '::before').backgroundColor;
      };
      const out: { where: string; gap: number; contrast: number }[] = [];
      const pairs: [string, string, string][] = [
        ['.mr-rbar-track', '.mr-rbar-paid', '.mr-rbar-saved'],
        ['.mr-wmg-bar', '.mr-wmg-bar-paid', '.mr-wmg-bar-saved'],
      ];
      for (const [track, a, b] of pairs) {
        for (const t of document.querySelectorAll(track)) {
          const pa = t.querySelector(a);
          const pb = t.querySelector(b);
          if (!pa || !pb) continue;
          const ra = pa.getBoundingClientRect();
          const rb = pb.getBoundingClientRect();
          if (ra.width < 4 || rb.width < 4) continue;
          const [l1, l2] = [lum(fill(pa)), lum(fill(pb))].sort((x, y) => y - x);
          out.push({ where: track, gap: rb.left - ra.right, contrast: (l1 + 0.05) / (l2 + 0.05) });
        }
      }
      return out;
    });
  }

  test('P1-H05: segments sit a gap apart, the unpriced track shows in dark, forced colours keep both parts', async ({ page, browserName }) => {
    await openSeeded(page);
    await setTheme(page, 'dark');
    // The unpriced destination's track: a hatch, not the card's own colour.
    const unpriced = page.locator('.mr-wmg-row[data-unpriced="true"] .mr-wmg-track').first();
    const hatch = await unpriced.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(hatch).toContain('repeating-linear-gradient');
    // The head figure names itself.
    await expect(page.locator('.mr-wmg-row').first().locator('.mr-wmg-paid')).toContainText(/^paid \$[\d,]+\s*\/ day$/);
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme);
      const pairs = await segmentPairs(page);
      expect(pairs.length).toBeGreaterThanOrEqual(3);
      const bad = pairs.filter((p) => p.contrast < 1.3 && p.gap < 1.5);
      expect(bad, `${theme}: segments that read as one`).toEqual([]);
    }
    // Forced colours: both segments keep a fill of their own and an outline. (WebKit has no forced-colours mode
    // and no forced-color-adjust property to read.)
    if (browserName !== 'webkit') await expectForcedColorsBar(page);
    // The would-have-paid length is a dimension line: its label centred over the bar, ticks at both ends.
    const dim = await page.locator('.mr-hero .mr-rbar-whp').evaluate((el) => {
      const text = el.querySelector('.mr-rbar-whp-text')!.getBoundingClientRect();
      const row = el.getBoundingClientRect();
      const before = getComputedStyle(el, '::before');
      const after = getComputedStyle(el, '::after');
      return { offset: text.left + text.width / 2 - (row.left + row.width / 2), ticks: [before.borderLeftWidth, after.borderRightWidth] };
    });
    expect(Math.abs(dim.offset)).toBeLessThanOrEqual(2);
    expect(dim.ticks).toEqual(['1px', '1px']);
  });

  test('P1-H06: the learning trend keeps one continuous ghost line and names the 30-day window', async ({ page }) => {
    await openSeeded(page, '/', { collectingSince: (nowMs) => localDayStartMs(addDaysToKey(localDayKey(nowMs, TZ), -1), TZ) + (2 * 60 + 20) * 60_000 });
    const trend = page.getByTestId('trend-learning');
    await expect(trend).toBeVisible();
    await expect(trend.getByRole('img')).toHaveAttribute('aria-label', 'Saved per day, last 30 days · 1 day collected');
    const geo = await trend.evaluate((el) => {
      const text = el.querySelector('.mr-trend-learning')!;
      const words = [...text.children].map((c) => c.getBoundingClientRect());
      const ghost = el.querySelector('[data-testid="trend-ghost"]')!.getBoundingClientRect();
      const lines = [...el.querySelectorAll('.mr-trend-grid')].map((l) => l.getBoundingClientRect().top);
      return { plate: getComputedStyle(text).backgroundColor, wordsBottom: Math.max(...words.map((w) => w.bottom)), wordsTop: Math.min(...words.map((w) => w.top)), ghostTop: ghost.top, lines };
    });
    expect(geo.plate).toBe('rgba(0, 0, 0, 0)');
    // Nothing covers the ghost: the words end above it, and no gridline runs through the words.
    expect(geo.wordsBottom).toBeLessThanOrEqual(geo.ghostTop);
    for (const y of geo.lines) expect(y < geo.wordsTop || y > geo.wordsBottom, `gridline at ${y} through the words`).toBe(true);
  });
});

test.describe('Receipt wave 2 (WP-H), P2-W20: goal, this week, price basis', () => {
  const GOAL_CENTS = 25_000_000; // $250,000 a month

  test('a savings goal puts a pace strip on the month-to-date hero, naming the goal; other periods hide it', async ({ page }) => {
    const fx = await openSeeded(page, '/?period=mtd', { mutate: (f) => (f.settings.savingsGoalCentsPerMonth = GOAL_CENTS) });
    const pace = goalPace({
      savedMtdM: fx.snapshot.headline.mtdM,
      goalCentsPerMonth: GOAL_CENTS,
      sweepMs: Date.parse(fx.snapshot.sweepAt),
      collectingSinceMs: Date.parse(fx.snapshot.collectingSince),
      tz: TZ,
    })!;
    const strip = page.getByTestId('goal-pace');
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute('data-state', pace.onPace ? 'ahead' : 'behind');
    await expect(strip).toContainText('$250k');
    await expect(strip).toContainText(fmtDollarsCompact(pace.projectedM!));
    // Another period keeps the strip's room but not the strip: the hero's height holds (the P1-F12 rule).
    const height = async () => Math.round((await page.locator('.mr-hero').first().boundingBox())!.height);
    const mtdHeight = await height();
    await page.getByRole('radio', { name: 'Today' }).click();
    await expect(strip).toBeHidden();
    await page.waitForTimeout(250);
    expect(await height()).toBe(mtdHeight);
    await page.getByRole('radio', { name: 'MTD' }).click();
    await expect(strip).toBeVisible();
  });

  test('Settings → Cribl cost saves a goal, and the Receipt reads against it', async ({ page }) => {
    await openSeeded(page);
    await page.goto('/settings?section=cost', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const input = page.getByTestId('goal-input');
    await input.scrollIntoViewIfNeeded();
    await input.fill('100000');
    await page.locator('[data-section="cost"]').getByRole('button', { name: /^Save/ }).click();
    await expect.poll(async () => JSON.parse((await kvGet(page, 'settings')) ?? '{}').savingsGoalCentsPerMonth).toBe(10_000_000);
    await page.goto('/?period=mtd', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.getByTestId('goal-pace')).toHaveAttribute('data-state', 'ahead');
    await expect(page.getByTestId('goal-pace')).toContainText('goal $100k');
  });

  test('this week so far reads the same rows whatever the hero shows: a custom range waits, then the same total (review W2)', async ({ page }) => {
    await openSeeded(page);
    await mockControl(page, { action: 'seedRollups', at: await page.evaluate(() => Date.now()), tz: TZ, prices: RIG_PRICES });
    const read = async (path: string) => {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await waitForHydration(page);
      const week = page.getByTestId('receipt-week');
      await week.scrollIntoViewIfNeeded();
      const summed = week.locator('.mr-week');
      await expect(summed).toBeVisible({ timeout: 20_000 });
      await expect(summed).toHaveAttribute('data-from', /Z$/);
      return { total: (await week.getByTestId('week-total').textContent())!.trim(), from: await summed.getAttribute('data-from'), to: await summed.getAttribute('data-to') };
    };
    const plain = await read('/');
    const ranged = await read('/?range=7d');
    expect(ranged).toEqual(plain);
  });

  test("this week so far adds up to Copy receipt for the same window, and previews Monday's message", async ({ page, context, browserName }) => {
    await allowClipboard(context, browserName);
    await openSeeded(page);
    await mockControl(page, { action: 'seedRollups', at: await page.evaluate(() => Date.now()), tz: TZ, prices: RIG_PRICES });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const week = page.getByTestId('receipt-week');
    await week.scrollIntoViewIfNeeded();
    const summed = week.locator('.mr-week');
    await expect(summed).toBeVisible({ timeout: 15_000 });
    const from = Date.parse((await summed.getAttribute('data-from'))!);
    const to = Date.parse((await summed.getAttribute('data-to'))!);
    // Monday 00:00 local of this week, to the sweep (through the last whole hour).
    const mondayKey = mondayOf(localDayKey(await page.evaluate(() => Date.now()), TZ));
    expect(from).toBe(localDayStartMs(mondayKey, TZ));
    const total = (await week.getByTestId('week-total').textContent())!.trim();
    const firstLine = (await week.locator('.mr-rlist-item').first().textContent())!;
    // The same window as a custom range: Copy receipt prints receiptTextForRange for it.
    await page.goto(`/?range=${formatRangeParam({ kind: 'absolute', fromMs: from, toMs: to })}`, { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(page.getByTestId('receipt-hero')).toHaveAttribute('data-range-status', 'ready', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Copy receipt' }).click();
    await expect(page.getByText('Receipt copied.')).toBeVisible();
    const text = await readClipboard(page);
    const totalLine = text.split('\n').find((l) => l.startsWith('Saved by Cribl'))!;
    expect(totalLine.trim().split(/\s+/).pop()).toBe(total);
    const [label] = firstLine.split(/\s*\$/);
    expect(text).toContain(label.trim());
    // The message beside it is the weekly receipt as Slack would draw it (1024 px and up; a button on a phone).
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await page.getByTestId('receipt-week').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('receipt-week').locator('.mr-week')).toBeVisible({ timeout: 15_000 });
    if (page.viewportSize()!.width >= 1024) {
      await expect(page.getByTestId('week-message')).toContainText('Weekly receipt');
      await expect(page.getByTestId('week-message')).toContainText(total);
    } else {
      await page.getByRole('button', { name: "Preview Monday's message" }).click();
      await expect(page.getByTestId('week-preview')).toContainText(total);
    }
  });

  test('one price-basis chip: "at your contract rates" only when every priced destination has an entered rate', async ({ page }) => {
    await openSeeded(page, '/?period=mtd');
    // The hero states the basis once, beside its title (review W2: a second chip after the caption said it again).
    await expect(page.getByTestId('hero-price-basis')).toHaveText('at your contract rates');
    await expect(page.getByTestId('price-basis')).toHaveCount(0);
    await openSeeded(page, '/?period=mtd', {
      mutate: (f) => {
        f.prices.versions[0].byOutputId.mrd_siem_prod = { milliCentsPerGb: 225_000, preset: 'splunk_cloud' };
      },
    });
    await expect(page.getByTestId('hero-price-basis')).toHaveText('at typical list prices');
    await expect(page.locator('main')).not.toContainText('at preset prices');
  });
});

test.describe('Receipt wave 2 (WP-H), P2-W25: statement, hour map, the ghost, the tear-off', () => {
  /** The emulated org's hour rollups for the last 40 days, and per-destination months in the running totals. */
  async function withHistory(page: Page, fx: Fixture): Promise<{ thisPaid: number; lastPaid: number }> {
    await mockControl(page, { action: 'seedRollups', at: await page.evaluate(() => Date.now()), tz: TZ, prices: RIG_PRICES });
    const totals = JSON.parse((await kvGet(page, 'totals')) ?? '{}') as TotalsDoc;
    const m = statementMonths(Date.parse(fx.snapshot.sweepAt), TZ);
    const thisMonth = { whpM: $(91_234), paidM: $(36_789), savedM: $(54_445) };
    const lastMonth = { whpM: $(101_000), paidM: $(41_500), savedM: $(59_500) };
    totals.byOutputMonth = { [m.thisKey]: { [`${GID}:mrd_siem_prod`]: thisMonth }, [m.lastKey]: { [`${GID}:mrd_siem_prod`]: lastMonth } };
    await putKv(page, { totals });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await page.getByTestId('receipt-hero').waitFor();
    return { thisPaid: thisMonth.paidM, lastPaid: lastMonth.paidM };
  }

  test('a destination opens its statement: two months from totals.byOutputMonth, prices, and a 168-hour map', async ({ page, context, browserName }) => {
    await allowClipboard(context, browserName);
    const fx = await openSeeded(page);
    const { thisPaid, lastPaid } = await withHistory(page, fx);
    await page.locator('.mr-wmg-row:has(.mr-wmg-name[title="mrd_siem_prod"])').getByTestId('open-statement').click();
    const st = page.getByTestId('statement');
    await expect(st).toBeVisible();
    await expect(st.locator('tr[data-row="paidM"] td[data-col="this"]')).toHaveText(fmtDollars(thisPaid));
    await expect(st.locator('tr[data-row="paidM"] td[data-col="last"]')).toHaveText(fmtDollars(lastPaid));
    await expect(st.getByTestId('statement-this-head')).toHaveText(new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: TZ }).format(new Date(fx.snapshot.sweepAt)));
    await expect(st).toContainText('$2.50 / GB');
    await expect(st).toContainText('Without Cribl this data would go to this destination.');
    // The hour map: 168 cells, the top three ranked and listed.
    const cells = st.getByTestId('heat-cell');
    await expect(cells).toHaveCount(168);
    await expect(st.locator('[data-testid="heat-cell"][data-rank]')).toHaveCount(3);
    await expect(st.getByRole('list', { name: 'The three biggest hours' }).getByRole('listitem')).toHaveCount(3);
    const map = st.getByTestId('heatmap').locator('svg');
    await map.focus();
    await page.keyboard.press('ArrowRight');
    await expect(st.getByTestId('heat-readout')).toContainText(/saved \$[\d,]+ · would have paid \$[\d,]+ · paid \$[\d,]+|not metered/);
    // Copy statement: a 48-column receipt with both months.
    await st.getByRole('button', { name: 'Copy statement' }).click();
    await expect(page.getByText('Statement copied.')).toBeVisible();
    const text = await readClipboard(page);
    expect(text).toContain('Meter Reader — statement');
    expect(text).toContain(fmtDollars(thisPaid));
    expect(text).toContain(fmtDollars(lastPaid));
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(48);
  });

  test('archive-s3 draws its counterfactual: a hatched ghost to siem-prod beyond its own saving', async ({ page }) => {
    await openSeeded(page);
    const row = page.locator('.mr-wmg-row:has(.mr-wmg-name[title="mrd_archive_s3"])');
    const ghost = row.getByTestId('wmg-ghost');
    await expect(ghost).toBeVisible();
    const share = await row.evaluate((el) => el.querySelector('[data-testid="wmg-ghost"]')!.getBoundingClientRect().width / el.querySelector('.mr-wmg-bar')!.getBoundingClientRect().width);
    // S3 at $0.03 against siem-prod at $2.50: 98.8 % of what it would have paid is the other destination's price.
    expect(share).toBeGreaterThan(0.95);
    await expect(page.locator('.mr-wmg-row:has(.mr-wmg-name[title="mrd_siem_prod"])').getByTestId('wmg-ghost')).toHaveCount(0);
  });

  test('Copy receipt tears a strip off the perforation, unless motion is reduced', async ({ page, context, browserName }) => {
    await allowClipboard(context, browserName);
    await openSeeded(page);
    // Record the strip's animations the moment it is inserted (it lives 300 ms).
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __tear: string[] }).__tear = seen;
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of r.addedNodes)
            if (n instanceof HTMLElement && n.dataset.testid === 'hero-tear') {
              // Reading the computed style flushes it, so the strip's animations exist to be recorded.
              n.dataset.flushed = getComputedStyle(n).transform;
              for (const a of n.getAnimations()) seen.push((a as CSSAnimation).animationName);
            }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.getByRole('button', { name: 'Copy receipt' }).click();
    const tear = page.getByTestId('hero-tear');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __tear: string[] }).__tear)).toContain('mr-hero-tear');
    await expect(tear).toHaveCount(0, { timeout: 3_000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Copy receipt' }).click();
    await expect(page.getByText('Receipt copied.').first()).toBeVisible();
    await expect(tear).toHaveCount(0);
  });
});

test.describe('Receipt wave-2 evidence', () => {
  const SIZES = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ] as const;
  const THEMES = ['light', 'dark'] as const;
  const shot = (name: string, theme: string, width: number) => `tests/report/screens/wave2-h-${name}-${theme}-${width}.png`;

  /** Runs `each` for both themes × 1440 / 390 (and any extra sizes) on the page as it is. */
  async function grid(page: Page, each: (theme: (typeof THEMES)[number], width: number) => Promise<void>, extra: { width: number; height: number }[] = []): Promise<void> {
    for (const theme of THEMES) {
      await setTheme(page, theme);
      for (const size of [...SIZES, ...extra]) {
        await page.setViewportSize(size);
        await blur(page);
        await page.waitForTimeout(400);
        await each(theme, size.width);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await setTheme(page, 'light');
  }

  test.beforeEach(({ browserName }, info) => {
    test.skip(browserName !== 'chromium' || info.project.name !== 'chromium', 'evidence is shot once, from the chromium project (it sets every width itself)');
    test.setTimeout(300_000);
  });

  test('P1-H01 / P1-H04 / P1-H09: the hero with its aside, compact alerts, How open, the Custom popover', async ({ page }) => {
    await openSeeded(page, '/?period=mtd');
    await grid(
      page,
      async (theme, width) => {
        await page.screenshot({ path: shot('receipt-seeded', theme, width), fullPage: true });
        await page.getByTestId('receipt-hero').screenshot({ path: shot('hero', theme, width) });
        await page.getByTestId('receipt-alerts').screenshot({ path: shot('alerts-compact', theme, width) });
      },
      [{ width: 1920, height: 1080 }],
    );
    await grid(page, async (theme, width) => {
      await page.getByRole('button', { name: 'How this number is made' }).click();
      await page.waitForTimeout(500);
      await page.getByTestId('receipt-hero').screenshot({ path: shot('how-open', theme, width) });
      await page.getByRole('button', { name: 'How this number is made' }).click();
      await page.getByRole('radiogroup', { name: 'Headline period' }).getByRole('radio', { name: 'Custom' }).click();
      await page.getByRole('dialog', { name: 'Custom range' }).waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({ path: shot('custom-popover', theme, width) });
      await page.keyboard.press('Escape');
      await page.getByRole('dialog', { name: 'Custom range' }).waitFor({ state: 'detached' });
    });
  });

  test('P1-H02 / P1-H04: the tour — wrapping savers with their total, the calm Alerts card', async ({ page }) => {
    await openTour(page);
    await grid(page, async (theme, width) => {
      await page.screenshot({ path: shot('tour', theme, width), fullPage: true });
      await page.getByTestId('receipt-top-savers').screenshot({ path: shot('savers', theme, width) });
      await page.getByTestId('receipt-alerts').screenshot({ path: shot('alerts-calm', theme, width) });
    });
  });

  test('P1-H05 / P1-H06: the bars, the unpriced hatch, forced colours, the learning trend', async ({ page }) => {
    await openSeeded(page);
    await grid(page, async (theme, width) => {
      await page.locator('.mr-hero .mr-hero-bar').screenshot({ path: shot('bar', theme, width) });
      await page.getByTestId('receipt-destinations').screenshot({ path: shot('destinations', theme, width) });
    });
    await page.emulateMedia({ forcedColors: 'active' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('forced-colors', 'light', 1440) });
    await page.emulateMedia({ forcedColors: 'none' });
    await openSeeded(page, '/', { collectingSince: (nowMs) => localDayStartMs(addDaysToKey(localDayKey(nowMs, TZ), -1), TZ) + (2 * 60 + 20) * 60_000 });
    await grid(page, async (theme, width) => {
      await page.getByTestId('receipt-trend').screenshot({ path: shot('trend-learning', theme, width) });
    });
  });


  test('P2-W20: the goal pace, the price basis, this week so far and its message', async ({ page }) => {
    await openSeeded(page, '/?period=mtd', { mutate: (f) => (f.settings.savingsGoalCentsPerMonth = 25_000_000) });
    await mockControl(page, { action: 'seedRollups', at: await page.evaluate(() => Date.now()), tz: TZ, prices: RIG_PRICES });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await page.getByTestId('receipt-week').scrollIntoViewIfNeeded();
    await page.getByTestId('receipt-week').locator('.mr-week').waitFor({ timeout: 15_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await grid(page, async (theme, width) => {
      await page.screenshot({ path: shot('w20-receipt', theme, width), fullPage: true });
      await page.getByTestId('receipt-hero').screenshot({ path: shot('w20-hero-goal', theme, width) });
      await page.getByTestId('receipt-week').screenshot({ path: shot('w20-week', theme, width) });
      if (width < 1024) {
        await page.getByRole('button', { name: "Preview Monday's message" }).click();
        await page.getByTestId('week-preview').waitFor();
        await page.waitForTimeout(300);
        await page.screenshot({ path: shot('w20-week-preview', theme, width) });
        await page.keyboard.press('Escape');
        await page.getByTestId('week-preview').waitFor({ state: 'detached' });
      }
    });
    await openSeeded(page, '/?period=mtd', { mutate: (f) => (f.settings.savingsGoalCentsPerMonth = 15_000_000) });
    await grid(page, async (theme, width) => {
      await page.getByTestId('receipt-hero').screenshot({ path: shot('w20-hero-goal-ahead', theme, width) });
    });
    await openTour(page);
    await page.getByTestId('receipt-week').scrollIntoViewIfNeeded();
    await page.getByTestId('receipt-week').locator('.mr-week').waitFor({ timeout: 15_000 });
    await grid(page, async (theme, width) => {
      await page.getByTestId('receipt-week').screenshot({ path: shot('w20-week-tour', theme, width) });
    });
  });


  test('P2-W25: the statement drawer with its hour map, the counterfactual ghost, the tear-off', async ({ page, context, browserName }) => {
    await allowClipboard(context, browserName);
    const fx = await openSeeded(page);
    await mockControl(page, { action: 'seedRollups', at: await page.evaluate(() => Date.now()), tz: TZ, prices: RIG_PRICES });
    const totals = JSON.parse((await kvGet(page, 'totals')) ?? '{}') as TotalsDoc;
    const m = statementMonths(Date.parse(fx.snapshot.sweepAt), TZ);
    totals.byOutputMonth = {
      [m.thisKey]: { [`${GID}:mrd_siem_prod`]: { whpM: $(91_234), paidM: $(36_789), savedM: $(54_445) } },
      [m.lastKey]: { [`${GID}:mrd_siem_prod`]: { whpM: $(101_000), paidM: $(41_500), savedM: $(59_500) } },
    };
    await putKv(page, { totals });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await page.getByTestId('receipt-hero').waitFor();
    await grid(page, async (theme, width) => {
      await page.getByTestId('receipt-destinations').screenshot({ path: shot('w25-destinations-ghost', theme, width) });
      await page.locator('.mr-wmg-row:has(.mr-wmg-name[title="mrd_siem_prod"])').getByTestId('open-statement').click();
      await page.getByTestId('heatmap').waitFor();
      await page.waitForTimeout(500);
      await page.screenshot({ path: shot('w25-statement', theme, width) });
      await page.getByTestId('statement').evaluate((el) => el.closest('[class*="body"], [class*="Body"]')?.scrollTo(0, 10_000));
      await page.getByTestId('heatmap').scrollIntoViewIfNeeded();
      await page.getByTestId('heatmap').locator('svg').focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(200);
      await page.screenshot({ path: shot('w25-statement-heatmap', theme, width) });
      await page.keyboard.press('Escape');
      await page.getByTestId('statement').waitFor({ state: 'detached' });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByRole('button', { name: 'Copy receipt' }).click();
      await page.waitForTimeout(110);
      await page.screenshot({ path: shot('w25-tear-off', theme, width) });
      await page.waitForTimeout(600);
    });
  });


  test('P1-H05 on the stage: the Story meter beat draws the new receipt bar at 1920 and 1280 x 720', async ({ page }) => {
    await gotoApp(page, '/?story=1');
    await page.locator('.mr-story[data-ready="true"]').waitFor();
    await page.waitForFunction(() => '__MR_STORY__' in window);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      for (const size of [
        { width: 1920, height: 1080 },
        { width: 1280, height: 720 },
      ]) {
        await page.setViewportSize(size);
        // The meter beat (the fourth) at its end: the receipt bar is fully drawn.
        await page.evaluate(() => {
          const api = (window as unknown as { __MR_STORY__: { pause(): void; seek(n: number): void } }).__MR_STORY__;
          api.pause();
          api.seek(4 + 5 + 10 + 7.5);
        });
        await expect(page.locator('.mr-story')).toHaveAttribute('data-beat', 'meter');
        await page.waitForTimeout(700);
        await page.screenshot({ path: shot('story-meter-bar', theme, size.width) });
      }
    }
  });


  test('P2-W25 on the tour: the statement and its hour map from the synthesized sample hours', async ({ page }) => {
    await openTour(page);
    await grid(page, async (theme, width) => {
      await page.getByTestId('open-statement').first().click();
      await page.getByTestId('heatmap').waitFor();
      await page.waitForTimeout(400);
      await page.getByTestId('heatmap').scrollIntoViewIfNeeded();
      await page.screenshot({ path: shot('w25-tour-statement', theme, width) });
      await page.keyboard.press('Escape');
      await page.getByTestId('statement').waitFor({ state: 'detached' });
    });
  });

});
