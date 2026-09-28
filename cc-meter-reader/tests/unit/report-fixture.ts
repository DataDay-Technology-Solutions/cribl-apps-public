// tests/unit/report-fixture.ts — inputs for the report card tests: the enterprise sample the tour plays
// (demo/sample/tour.json) and a small hand-built live workspace that reaches the edges the sample doesn't
// (an unpriced destination, 'nowhere' and 'another destination' counterfactuals, open and recovered alerts with
// and without a commit, a budget alert and a good-news one that the report must leave out).

import { computeHeadline } from '../../core/pricing.ts';
import { makeFlowKey } from '../../core/flows.ts';
import { addDaysToKey, localDayKey, localDayStartMs, localMidnightMs } from '../../core/time.ts';
import type { DestinationFigures, FlowFigures, Incident, PricesDoc, Settings, Snapshot, TopSaver, TotalsDoc, TrendPoint } from '../../core/types.ts';
import { buildReportCard, type ReportCopy, type ReportInput, type ReportPeriod } from '../../core/report.ts';
import { en } from '../../src/copy/en.ts';
import { TOUR_FIXTURE } from '../../src/tour/fixture.ts';

/** The words the report renders (the compile-time check that en.ts satisfies the contract). */
export const COPY: ReportCopy = en.report.doc;

export const TOUR = TOUR_FIXTURE;
export const TOUR_TZ = TOUR.settings.displayTimezone;

/** A card of the enterprise sample, as the Report card view builds it in sample mode. */
export function sampleInput(period: ReportPeriod = { kind: 'mtd' }, extra: Partial<ReportInput> = {}): ReportInput {
  return {
    snapshot: TOUR.snapshot,
    prices: TOUR.prices,
    settings: TOUR.settings,
    period,
    nowMs: Date.parse(TOUR.snapshot.sweepAt) + 60_000,
    tz: TOUR_TZ,
    copy: COPY,
    source: 'sample',
    appVersion: 'v1.0.0',
    workspace: TOUR.workspace.name,
    viewer: 'Jordan Lee',
    ...extra,
  };
}

export const LIVE_TZ = 'America/Chicago';
/** Friday 25 Sep 2026, 3:30 PM in Chicago. */
export const LIVE_NOW = Date.UTC(2026, 8, 25, 20, 30, 0);
const GB = 1e9;
const $ = (dollars: number): number => Math.round(dollars * 100_000);

interface FlowSpec {
  group: string;
  input: string;
  route: string;
  pipeline: string;
  output: string;
  inGb: number;
  outGb: number;
  whpPrice: number;
  paidPrice: number;
}

const FLOW_SPECS: FlowSpec[] = [
  { group: 'default', input: 'win_dc', route: 'r_win', pipeline: 'win_trim', output: 'siem', inGb: 400, outGb: 160, whpPrice: 2.25, paidPrice: 2.25 },
  { group: 'default', input: 'win_ws', route: 'r_win', pipeline: 'win_trim', output: 'siem', inGb: 100, outGb: 50, whpPrice: 2.25, paidPrice: 2.25 },
  { group: 'default', input: 'fw', route: 'r_fw', pipeline: 'fw_dedupe', output: 'siem', inGb: 300, outGb: 210, whpPrice: 2.25, paidPrice: 2.25 },
  { group: 'default', input: 'k8s', route: 'r_k8s', pipeline: 'k8s_noise', output: 'analytics', inGb: 200, outGb: 80, whpPrice: 1.8, paidPrice: 1.8 },
  { group: 'default', input: 'vpc', route: 'r_vpc', pipeline: 'vpc_agg', output: 'archive', inGb: 500, outGb: 50, whpPrice: 2.25, paidPrice: 0.023 },
  { group: 'default', input: 'cdn', route: 'r_cdn', pipeline: 'passthru', output: 'edge_cdn', inGb: 50, outGb: 50, whpPrice: 0, paidPrice: 0 },
  { group: 'default', input: 'dns', route: 'r_dns', pipeline: 'dns_drop', output: 'devnull_copy', inGb: 20, outGb: 5, whpPrice: 0, paidPrice: 0.5 },
];

function money(f: FlowSpec): { whpM: number; paidM: number; savedM: number } {
  const whpM = Math.round(f.inGb * f.whpPrice * 100_000);
  const paidM = Math.round(f.outGb * f.paidPrice * 100_000);
  return { whpM, paidM, savedM: Math.max(0, whpM - paidM) };
}

export interface LiveOptions {
  criblCostCentsPerMonth?: number;
  withIncidents?: boolean;
  prices?: PricesDoc | null;
  /** Days of history before today (collecting since then, 9:41 PM). */
  historyDays?: number;
}

/** A small, consistent live workspace as of LIVE_NOW (every headline figure from core computeHeadline). */
export function liveWorkspace(opts: LiveOptions = {}): { snapshot: Snapshot; prices: PricesDoc | null; settings: Pick<Settings, 'criblCostCentsPerMonth' | 'humanize'> } {
  const tz = LIVE_TZ;
  const nowIso = new Date(LIVE_NOW).toISOString();
  const todayKey = localDayKey(LIVE_NOW, tz);
  const historyDays = opts.historyDays ?? 40;
  const collectingSinceMs = localDayStartMs(addDaysToKey(todayKey, -historyDays), tz) + (21 * 60 + 41) * 60_000;
  const rate = FLOW_SPECS.reduce(
    (acc, f) => {
      const m = money(f);
      return { whpM: acc.whpM + m.whpM, paidM: acc.paidM + m.paidM, savedM: acc.savedM + m.savedM };
    },
    { whpM: 0, paidM: 0, savedM: 0 },
  );
  const byDay: TotalsDoc['byDay'] = {};
  const sinceKey = localDayKey(collectingSinceMs, tz);
  for (let back = historyDays; back >= 0; back--) {
    const day = addDaysToKey(todayKey, -back);
    if (day < sinceKey) continue;
    let minutes = 1440;
    if (day === sinceKey) minutes = Math.round((localDayStartMs(addDaysToKey(day, 1), tz) - collectingSinceMs) / 60_000);
    if (day === todayKey) minutes = Math.max(1, Math.round((LIVE_NOW - localMidnightMs(LIVE_NOW, tz)) / 60_000));
    const wobble = 1 + 0.03 * Math.sin(back);
    const whpM = Math.round(rate.whpM * wobble * (minutes / 1440));
    const savedM = Math.round(whpM * (rate.savedM / rate.whpM));
    byDay[day] = { whpM, paidM: whpM - savedM, savedM, minutes };
  }
  const totals: TotalsDoc = { schemaVersion: 1, updatedAt: nowIso, byDay };
  const cost = opts.criblCostCentsPerMonth;
  const headline = computeHeadline(totals, LIVE_NOW, tz, collectingSinceMs, cost);
  const trend: TrendPoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = addDaysToKey(todayKey, -i);
    const d = byDay[day];
    if (d) trend.push({ day, savedM: d.savedM, whpM: d.whpM, paidM: d.paidM });
  }
  const flows: FlowFigures[] = FLOW_SPECS.map((f) => {
    const m = money(f);
    return {
      key: makeFlowKey(f.group, f.input, f.route, f.pipeline, f.output),
      groupId: f.group,
      inputId: f.input,
      routeId: f.route,
      pipelineId: f.pipeline,
      outputId: f.output,
      inB: Math.round((f.inGb * GB) / 1440),
      outB: Math.round((f.outGb * GB) / 1440),
      whpM: Math.round(m.whpM / 1440),
      paidM: Math.round(m.paidM / 1440),
      savedM: Math.round(m.savedM / 1440),
      ratio: m.whpM > 0 ? m.savedM / m.whpM : 0,
      ratePerHourM: Math.round(m.paidM / 24),
      savedPerDayM: m.savedM,
      whpPerDayM: m.whpM,
      paidPerDayM: m.paidM,
      inBPerDay: Math.round(f.inGb * GB),
      outBPerDay: Math.round(f.outGb * GB),
      attribution: 'reconciled',
      sparkline: [],
      state: 'ok',
    };
  });
  const destTypes: Record<string, string> = { siem: 'splunk_hec', analytics: 'datadog', archive: 's3', edge_cdn: 'webhook', devnull_copy: 'devnull' };
  const destinations: DestinationFigures[] = Object.keys(destTypes).map((outputId) => {
    const mine = flows.filter((f) => f.outputId === outputId);
    const sum = (k: 'whpPerDayM' | 'paidPerDayM' | 'savedPerDayM') => mine.reduce((s, f) => s + f[k], 0);
    const perGb: Record<string, number> = { siem: 225_000, analytics: 180_000, archive: 2_300, edge_cdn: 0, devnull_copy: 50_000 };
    return {
      groupId: 'default',
      outputId,
      type: destTypes[outputId],
      whpPerDayM: sum('whpPerDayM'),
      paidPerDayM: sum('paidPerDayM'),
      savedPerDayM: sum('savedPerDayM'),
      mtdPaidM: 0,
      mtdSavedM: 0,
      mtdWhpM: 0,
      milliCentsPerGb: perGb[outputId],
      counterfactual: outputId === 'archive' ? { kind: 'other', outputId: 'siem' } : outputId === 'devnull_copy' ? { kind: 'none' } : { kind: 'same' },
      unpriced: outputId === 'edge_cdn',
    };
  });
  const byRoute = new Map<string, { saved: number; whp: number; pipeline: string }>();
  for (const f of flows) {
    const acc = byRoute.get(f.routeId) ?? { saved: 0, whp: 0, pipeline: f.pipelineId };
    acc.saved += f.savedPerDayM;
    acc.whp += f.whpPerDayM;
    byRoute.set(f.routeId, acc);
  }
  const topSavers: TopSaver[] = [...byRoute.entries()]
    .filter(([, r]) => r.saved > 0)
    .map(([route, r]) => ({ objectKey: `route:default:${route}`, label: `${r.pipeline} label`, savedPerDayM: r.saved, ratio: r.saved / r.whp, groupId: 'default', pipelineId: r.pipeline }))
    .sort((a, b) => b.savedPerDayM - a.savedPerDayM)
    .slice(0, 5);
  const at = (msAgo: number) => new Date(LIVE_NOW - msAgo).toISOString();
  const incidents: Incident[] =
    opts.withIncidents === false
      ? []
      : [
          {
            id: 'reg-open',
            type: 'regression',
            severity: 'high',
            objectKey: 'pipe:default:win_trim',
            label: 'Windows trimming',
            openedAt: at(10 * 60_000),
            cause: 'commit',
            commit: { hash: 'a1f3c9e6b2d04c1f', message: 'break the trim', author: 'Zx9QgE@clients', committedAt: at(12 * 60_000), groupId: 'default', match: 'files' },
            before: 0.75,
            after: 0.5,
            impactPerDayM: $(250),
            caughtInSec: 171,
            notes: [],
            deliveries: [],
          },
          {
            id: 'reg-recovered',
            type: 'regression',
            severity: 'medium',
            objectKey: 'pipe:default:fw_dedupe',
            label: 'Firewall duplicate suppression',
            openedAt: at(5 * 3_600_000),
            closedAt: at(4 * 3_600_000),
            cause: 'unknown',
            before: 0.3,
            after: 0.12,
            recoveredTo: 0.31,
            impactPerDayM: $(90),
            caughtInSec: 95,
            notes: [],
            deliveries: [],
          } as Incident,
          {
            id: 'spike-closed',
            type: 'spike',
            severity: 'high',
            objectKey: 'in:default:fw',
            label: 'Firewall',
            openedAt: at(8 * 3_600_000),
            closedAt: at(7 * 3_600_000),
            before: $(20),
            after: $(19),
            impactPerDayM: $(400),
            caughtInSec: 120,
            notes: [],
            deliveries: [],
          },
          {
            id: 'spike-open',
            type: 'spike',
            severity: 'high',
            objectKey: 'in:default:k8s',
            label: 'Kubernetes',
            openedAt: at(2 * 60_000),
            before: $(15),
            after: $(48),
            impactPerDayM: $(792),
            notes: [],
            deliveries: [],
          },
          {
            id: 'budget-open',
            type: 'budget',
            severity: 'medium',
            objectKey: 'out:default:analytics',
            label: 'analytics',
            openedAt: at(30 * 60_000),
            before: 88,
            after: 104,
            impactPerDayM: $(34),
            notes: [],
            deliveries: [],
          },
          {
            id: 'good',
            type: 'goodnews',
            severity: 'info',
            objectKey: 'pipe:default:k8s_noise',
            label: 'Kubernetes noise filter',
            openedAt: at(60 * 60_000),
            before: 0.4,
            after: 0.6,
            impactPerDayM: $(50),
            notes: [],
            deliveries: [],
          },
          {
            id: 'old-regression',
            type: 'regression',
            severity: 'high',
            objectKey: 'pipe:default:vpc_agg',
            label: 'VPC aggregation',
            openedAt: new Date(localDayStartMs(addDaysToKey(todayKey, -35), tz)).toISOString(),
            before: 0.9,
            after: 0.5,
            impactPerDayM: $(10),
            notes: [],
            deliveries: [],
          },
        ];
  const snapshot: Snapshot = {
    schemaVersion: 1,
    sweepAt: nowIso,
    windowStart: nowIso,
    windowEnd: nowIso,
    mode: 'ui',
    headline,
    ratePerSecM: rate.savedM / 86_400,
    flows,
    destinations,
    topSavers,
    unpricedOutputIds: ['edge_cdn'],
    openIncidents: incidents.filter((i) => !i.closedAt).length,
    incidents,
    trend,
    ratioSeries: [],
    timeline: [],
    deliveries: [],
    calls: 23,
    collectingSince: new Date(collectingSinceMs).toISOString(),
    metricsSource: 'metrics-query',
    attributionSummary: 'reconciled',
  };
  const prices: PricesDoc | null =
    opts.prices !== undefined
      ? opts.prices
      : {
          schemaVersion: 1,
          updatedAt: snapshot.collectingSince,
          versions: [
            {
              effectiveFrom: snapshot.collectingSince,
              byOutputId: {
                siem: { milliCentsPerGb: 225_000, preset: 'splunk_cloud' },
                analytics: { milliCentsPerGb: 150_000, preset: 'datadog' },
                archive: { milliCentsPerGb: 2_300, preset: 's3', counterfactual: { kind: 'other', outputId: 'siem' } },
                devnull_copy: { milliCentsPerGb: 50_000, counterfactual: { kind: 'none' } },
              },
            },
          ],
        };
  return { snapshot, prices, settings: { criblCostCentsPerMonth: opts.criblCostCentsPerMonth, humanize: { edge_cdn: 'Edge CDN, "public"' } } };
}

export function liveInput(period: ReportPeriod = { kind: 'mtd' }, opts: LiveOptions = {}, extra: Partial<ReportInput> = {}): ReportInput {
  const w = liveWorkspace(opts);
  return {
    snapshot: w.snapshot,
    prices: w.prices,
    settings: w.settings,
    period,
    nowMs: LIVE_NOW + 30_000,
    tz: LIVE_TZ,
    copy: COPY,
    source: 'live',
    appVersion: 'v1.0.0',
    build: 'release',
    workspace: 'acme-prod',
    viewer: 'Sam Rivera',
    lastSweepOwner: 'runner:workhorse:4242',
    ...extra,
  };
}

export const sampleCard = (period?: ReportPeriod, extra?: Partial<ReportInput>) => buildReportCard(sampleInput(period, extra));
export const liveCard = (period?: ReportPeriod, opts?: LiveOptions, extra?: Partial<ReportInput>) => buildReportCard(liveInput(period, opts, extra));
