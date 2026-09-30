// core/snapshot.ts — the one document the UI reads every few seconds (SPEC 7.6), and its compaction
// under the ~100 KB KV value cap (DECISIONS D13): top 500 flows, 12-point sparklines, coarser ratio series.

import type {
  Attribution,
  BaselinesDoc,
  Commit,
  DeliveryLog,
  DestinationFigures,
  Flow,
  FlowFigures,
  FlowKey,
  FlowState,
  ISO,
  Incident,
  InventoryDoc,
  MetricsSource,
  MinuteRow,
  ObjectKey,
  OutputInfo,
  PricesDoc,
  Settings,
  Snapshot,
  TimelineDoc,
  TopSaver,
  TotalsDoc,
  TrendPoint,
} from './types.ts';
import { INFLATION_NOISE, addedCost, budgetPace, computeHeadline, effectivePrices, isDiversion, meteredMinutesInMonth, ratio } from './pricing.ts';
import { humanize } from './humanize.ts';
import { flowObjectKeys, isInternalOutput, makeFlowKey, objectKey, parseFlowKey, parseObjectKey } from './flows.ts';
import { outputMonthTotals, poolMinuteRows, sparkline } from './rollups.ts';
import { isWarm } from './baseline.ts';
import { allCommits } from './timeline.ts';
import { DAY_MS, MINUTE_MS, addDaysToKey, fromIso, localDayKey, localDayStartMs, localMonthKey, toIso } from './time.ts';

export const MAX_TOP_SAVERS = 5;
export const MAX_SNAPSHOT_INCIDENTS = 50;
export const MAX_SNAPSHOT_TIMELINE = 30;
export const MAX_SNAPSHOT_DELIVERIES = 20;
export const MAX_RATIO_POINTS = 288;
export const RATIO_BUCKET_MS = 5 * MINUTE_MS;
export const SPARKLINE_POINTS = 30;
export const COMPACT_FLOWS = 500;
export const COMPACT_SPARKLINE_POINTS = 12;

export interface SnapshotParts {
  sweepAtMs: number;
  /** the last completed minute: [windowStart, windowEnd) */
  windowStartMs: number;
  windowEndMs: number;
  mode: Snapshot['mode'];
  settings: Settings;
  prices: PricesDoc;
  inventory?: InventoryDoc;
  flows: Flow[];
  /**
   * minute rows by flow covering at least the last 60 minutes (the current and previous roll/min docs),
   * including keys that are no longer current flows: a route's rows under the pipeline it ran through
   * before a swap, which its current flow's hourly projections and sparkline pool (routeHistoryKeys)
   */
  minuteRows: Record<FlowKey, MinuteRow[]>;
  /** attribution measured for the last window (attributeWindow); defaults to each flow's own */
  attribution?: Record<FlowKey, Attribution>;
  totals: TotalsDoc;
  collectingSinceMs: number;
  /** open incidents and recently closed ones */
  incidents: Incident[];
  timeline: TimelineDoc | Commit[];
  deliveries: DeliveryLog[];
  muted?: Record<ObjectKey, ISO>;
  baselines?: BaselinesDoc;
  calls: number;
  metricsSource: MetricsSource;
  /** the previous snapshot, whose ratioSeries carries the older 24 h history forward */
  previous?: Snapshot | null;
  /** founder-build r1 core-2: the zone the totals are bucketed in, recorded as Snapshot.zone (omitted: no zone field) */
  zone?: string;
  /**
   * Founder-build r1 core-14 (m3, #6): every minute row the sweep holds (a first-run or catch-up backfill reaches back up
   * to a day): the 24 h ratio series is built from these, not only the snapshot's last 60 minutes. Omitted: minuteRows.
   */
  ratioRows?: Record<FlowKey, MinuteRow[]>;
  /**
   * Core-6 (#42): where the rows the sweep passed (ratioRows, else minuteRows) begin — the first hour of minute documents
   * it held, rows or not. Only when they reach back to collecting since can a first run say where traffic began.
   */
  rowsFromMs?: number;
}

const byT = (a: { t: ISO }, b: { t: ISO }): number => fromIso(a.t) - fromIso(b.t);
const sum = <T>(xs: T[], f: (x: T) => number): number => xs.reduce((s, x) => s + f(x), 0);

/** Worst-first: route-only is ignored unless it is all there is. */
const ATTRIBUTION_RANK: Record<Attribution, number> = { reconciled: 0, route: 1, 'route-only': 2, pipeline: 3, proportional: 4 };

/** The weakest attribution method in use among flows with traffic (Show the math states it). */
export function summarizeAttribution(figures: Pick<FlowFigures, 'attribution' | 'inB' | 'whpPerDayM'>[]): Attribution {
  const live = figures.filter((f) => f.inB > 0 || f.whpPerDayM > 0);
  const pool = live.length > 0 ? live : figures;
  const methods = pool.map((f) => f.attribution);
  const measured = methods.filter((m) => m !== 'route-only');
  if (measured.length === 0) return methods.length > 0 ? 'route-only' : 'route';
  return measured.reduce((worst, m) => (ATTRIBUTION_RANK[m] > ATTRIBUTION_RANK[worst] ? m : worst), 'reconciled' as Attribution);
}

/** Workspace-wide savings ratio per 5-minute bucket, from minute rows (buckets with no would-have-paid are skipped). */
function ratioBuckets(minuteRows: Record<FlowKey, MinuteRow[]>, fromMs: number, untilMs: number): Map<number, { whp: number; saved: number }> {
  const buckets = new Map<number, { whp: number; saved: number }>();
  for (const rows of Object.values(minuteRows)) {
    for (const r of rows) {
      const t = fromIso(r.t);
      if (!(t >= fromMs && t < untilMs)) continue;
      const b = Math.floor(t / RATIO_BUCKET_MS) * RATIO_BUCKET_MS;
      const acc = buckets.get(b) ?? { whp: 0, saved: 0 };
      acc.whp += r.whpM;
      acc.saved += r.savedM;
      buckets.set(b, acc);
    }
  }
  return buckets;
}

/**
 * `groupId|inputId|routeId|outputId`: a flow without its pipeline, i.e. the route's identity across
 * pipeline swaps (Apply the pack, Revert, Go aggressive). Undefined for a key that does not parse.
 */
export function routeIdentity(key: FlowKey): string | undefined {
  const p = parseFlowKey(key);
  return p ? `${p.groupId}|${p.inputId}|${p.routeId}|${p.outputId}` : undefined;
}

/**
 * For each current flow, the other flow keys whose stored minute rows are its route's earlier history:
 * keys that share its route identity but are no longer current flows, because the route ran through
 * another pipeline before a swap. Each such key goes to exactly one current flow (the smallest key of
 * that identity), so two current flows sharing an identity never count the same history twice.
 */
export function routeHistoryKeys(flows: readonly Pick<Flow, 'key'>[], minuteRows: Record<FlowKey, unknown>): Map<FlowKey, FlowKey[]> {
  const current = new Set<FlowKey>();
  const heir = new Map<string, FlowKey>();
  for (const f of flows) {
    current.add(f.key);
    const id = routeIdentity(f.key);
    if (id === undefined) continue;
    const prev = heir.get(id);
    if (prev === undefined || f.key < prev) heir.set(id, f.key);
  }
  const out = new Map<FlowKey, FlowKey[]>();
  for (const key of Object.keys(minuteRows).sort()) {
    if (current.has(key)) continue;
    const id = routeIdentity(key);
    const to = id === undefined ? undefined : heir.get(id);
    if (to === undefined) continue;
    const list = out.get(to);
    if (list) list.push(key);
    else out.set(to, [key]);
  }
  return out;
}

function outputType(inventory: InventoryDoc | undefined, groupId: string, outputId: string): OutputInfo | undefined {
  return inventory?.byGroup?.[groupId]?.outputs?.find((o) => o.id === outputId);
}

/** `{ routeName }` when the route has a name of its own in Cribl (not blank, not its id), else nothing. */
function routeNamed(inventory: InventoryDoc | undefined, groupId: string, routeId: string): { routeName?: string } {
  const name = inventory?.byGroup?.[groupId]?.routes?.find((r) => r.id === routeId)?.name?.trim();
  return name && name !== routeId ? { routeName: name } : {};
}

/**
 * Two routes through one pipeline would list the same words twice ("Windows XML pack" at $123 and at $29 a
 * day, nothing to tell them apart): a label that repeats gains its route in front — "Windows DC security
 * events · Windows XML pack" — and, should the same route id repeat across worker groups, the group too.
 * The route leads because the lists truncate from the right; the tooltip carries the whole label.
 */
export function distinctLabels(savers: TopSaver[], overrides?: Record<string, string>): TopSaver[] {
  const routeOf = (s: TopSaver): string => parseObjectKey(s.objectKey)?.id ?? s.objectKey;
  const repeated = (list: TopSaver[]): Set<string> => {
    const seen = new Set<string>();
    const twice = new Set<string>();
    for (const s of list) (seen.has(s.label) ? twice : seen).add(s.label);
    return twice;
  };
  let out = savers;
  for (const widen of [(s: TopSaver) => `${humanize(routeOf(s), overrides)} · ${s.label}`, (s: TopSaver) => `${s.label} · ${s.groupId}`]) {
    const twice = repeated(out);
    if (twice.size === 0) break;
    out = out.map((s) => (twice.has(s.label) ? { ...s, label: widen(s) } : s));
  }
  return out;
}

/** Assembles the snapshot for one sweep. Pure and deterministic for the same parts. */
export function buildSnapshot(parts: SnapshotParts): Snapshot {
  const { settings, sweepAtMs, windowStartMs, windowEndMs } = parts;
  const tz = settings.displayTimezone || 'UTC';
  const windowStartIso = toIso(windowStartMs);
  const hourAgo = windowEndMs - 60 * MINUTE_MS;
  // Minutes of the last hour that metering actually covered (extrapolation base for per-day figures).
  const coveredMin = Math.min(60, Math.max(1, Math.round((windowEndMs - Math.max(hourAgo, parts.collectingSinceMs)) / MINUTE_MS)));
  const perDayFactor = 1440 / coveredMin;

  const openIncidents = (parts.incidents ?? []).filter((i) => !i.closedAt);
  const openByKey = new Map<string, Incident>();
  for (const i of openIncidents) openByKey.set(`${i.type}|${i.objectKey}`, i);
  const mutedUntil = (key: ObjectKey | undefined): ISO | undefined => {
    const until = key ? parts.muted?.[key] : undefined;
    return until !== undefined && fromIso(until) > sweepAtMs ? until : undefined;
  };
  /** P1-F07: a member's "Mute for 24 hours" (settings.mutes), while it lasts. */
  const memberMutedUntil = (key: ObjectKey | undefined): ISO | undefined => {
    const until = key ? settings.mutes?.[key]?.until : undefined;
    return until !== undefined && fromIso(until) > sweepAtMs ? until : undefined;
  };

  // ── Flows ──────────────────────────────────────────────────────────────────
  const priceCache = new Map<string, ReturnType<typeof effectivePrices>>();
  const pricesFor = (groupId: string, outputId: string) => {
    const k = `${groupId}:${outputId}`;
    let p = priceCache.get(k);
    if (!p) {
      // The whole output (type, id, description): a DevNull standing in for a paid destination stays unpriced (P0-04).
      p = effectivePrices(parts.prices, groupId, outputId, sweepAtMs, outputType(parts.inventory, groupId, outputId));
      priceCache.set(k, p);
    }
    return p;
  };

  // A pipeline swap (Apply the pack) changes a flow's key but not its traffic: the trailing-hour
  // projections and the sparkline read the route's whole history, whatever pipeline it ran through;
  // the last minute's figures (bytes, money, ratio, rate) stay the current pipeline's own.
  const history = routeHistoryKeys(parts.flows, parts.minuteRows);
  let lastMinuteSavedM = 0;
  const flows: FlowFigures[] = parts.flows.map((f) => {
    const own = [...(parts.minuteRows[f.key] ?? [])].sort(byT);
    const earlier = history.get(f.key);
    const rows = earlier ? poolMinuteRows([own, ...earlier.map((k) => parts.minuteRows[k])]) : own;
    const last = own.find((r) => r.t === windowStartIso) ?? { t: windowStartIso, inB: 0, outB: 0, inE: 0, outE: 0, whpM: 0, paidM: 0, savedM: 0 };
    const hour = rows.filter((r) => {
      const t = fromIso(r.t);
      return t >= hourAgo && t < windowEndMs;
    });
    lastMinuteSavedM += last.savedM;
    const keys = flowObjectKeys(f);
    const demoMuted = mutedUntil(keys.route) ?? mutedUntil(keys.pipeline) ?? mutedUntil(keys.input);
    const memberMuted = demoMuted ? undefined : (memberMutedUntil(keys.route) ?? memberMutedUntil(keys.pipeline) ?? memberMutedUntil(keys.input) ?? memberMutedUntil(keys.output));
    const muted = demoMuted ?? memberMuted;
    const price = pricesFor(f.groupId, f.outputId);
    let state: FlowState = 'ok';
    if (!muted) {
      if ([keys.route, keys.pipeline].some((k) => k && openByKey.has(`regression|${k}`))) state = 'regression';
      else if (keys.input && openByKey.has(`spike|${keys.input}`)) state = 'spike';
      else if (price.unpriced) state = 'unpriced';
      else if (parts.baselines && keys.route && !isWarm(parts.baselines.byObject[keys.route], settings.thresholds.warmupSamples)) state = 'learning';
    }
    const fig: FlowFigures = {
      key: f.key,
      groupId: f.groupId,
      inputId: f.inputId,
      routeId: f.routeId,
      ...routeNamed(parts.inventory, f.groupId, f.routeId),
      pipelineId: f.pipelineId,
      outputId: f.outputId,
      inB: last.inB,
      outB: last.outB,
      whpM: last.whpM,
      paidM: last.paidM,
      savedM: last.savedM,
      ratio: ratio(last.savedM, last.whpM),
      ratePerHourM: last.paidM * 60,
      savedPerDayM: Math.round(sum(hour, (r) => r.savedM) * perDayFactor),
      whpPerDayM: Math.round(sum(hour, (r) => r.whpM) * perDayFactor),
      paidPerDayM: Math.round(sum(hour, (r) => r.paidM) * perDayFactor),
      inBPerDay: Math.round(sum(hour, (r) => r.inB) * perDayFactor),
      outBPerDay: Math.round(sum(hour, (r) => r.outB) * perDayFactor),
      attribution: parts.attribution?.[f.key] ?? f.attribution,
      sparkline: sparkline(rows.slice(-SPARKLINE_POINTS), SPARKLINE_POINTS),
      state,
    };
    if (muted) {
      fig.muted = true;
      fig.mutedUntil = muted;
      if (memberMuted) fig.mutedByMember = true;
    }
    // P1-F02: credited at another destination's price — its savings are a diversion, not bytes dropped.
    if (isDiversion(price.counterfactual, f.outputId) && price.counterfactual.kind === 'other') {
      fig.diverted = true;
      fig.divertedTo = price.counterfactual.outputId;
    }
    // P1-F03: the hour's cost beyond what it would have been (bytes grown past the counting noise), per day.
    const hourWhp = sum(hour, (r) => r.whpM);
    const added = addedCost({ whpM: hourWhp, paidM: sum(hour, (r) => r.paidM) });
    if (added > INFLATION_NOISE * hourWhp) fig.addedPerDayM = Math.round(added * perDayFactor);
    return fig;
  });

  // ── Destinations ───────────────────────────────────────────────────────────
  const monthKey = localMonthKey(sweepAtMs, tz);
  const mtdMinutes = meteredMinutesInMonth(parts.totals, monthKey);
  const destKeys = new Map<string, { groupId: string; outputId: string }>();
  for (const f of flows) if (f.outputId !== '-') destKeys.set(`${f.groupId}:${f.outputId}`, { groupId: f.groupId, outputId: f.outputId });
  for (const [gid, g] of Object.entries(parts.inventory?.byGroup ?? {})) {
    for (const o of g.outputs ?? []) {
      if (o.disabled || o.type === 'default' || (!settings.includeInternal && isInternalOutput(o))) continue;
      destKeys.set(`${gid}:${o.id}`, { groupId: gid, outputId: o.id });
    }
  }
  const destinations: DestinationFigures[] = [...destKeys.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, { groupId, outputId }]) => {
      const mine = flows.filter((f) => f.groupId === groupId && f.outputId === outputId);
      const price = pricesFor(groupId, outputId);
      const mtd = outputMonthTotals(parts.totals, monthKey, key);
      const d: DestinationFigures = {
        groupId,
        outputId,
        type: outputType(parts.inventory, groupId, outputId)?.type ?? 'unknown',
        whpPerDayM: sum(mine, (f) => f.whpPerDayM),
        paidPerDayM: sum(mine, (f) => f.paidPerDayM),
        savedPerDayM: sum(mine, (f) => f.savedPerDayM),
        mtdPaidM: mtd.paidM,
        mtdSavedM: mtd.savedM,
        mtdWhpM: mtd.whpM,
        mtdMinutes,
        milliCentsPerGb: price.paidMcPerGb,
        counterfactual: price.counterfactual,
        unpriced: price.unpriced,
      };
      if (price.counterfactualUnpriced) d.counterfactualUnpriced = true;
      const budget = settings.budgets?.[outputId];
      if (budget && budget.centsPerMonth > 0) {
        // P0-17: the detector's projection, over the minutes metered this month.
        const projectedM = Math.round(
          budgetPace({ paidMtdM: mtd.paidM, nowMs: sweepAtMs, tz, meteredMinutes: mtdMinutes, collectingSinceMs: parts.collectingSinceMs }).projectedM,
        );
        d.budget = { centsPerMonth: budget.centsPerMonth, projectedM, pct: (projectedM / (budget.centsPerMonth * 1000)) * 100 };
      }
      return d;
    });

  // ── Top savers (routes, labelled by what their pipeline does) ─────────────
  const byRoute = new Map<string, { groupId: string; routeId: string; pipelineId: string; saved: number; whp: number; divertedSaved: number }>();
  for (const f of flows) {
    if (f.routeId === '-') continue;
    const k = `${f.groupId}:${f.routeId}`;
    const acc = byRoute.get(k) ?? { groupId: f.groupId, routeId: f.routeId, pipelineId: f.pipelineId, saved: 0, whp: 0, divertedSaved: 0 };
    acc.saved += f.savedPerDayM;
    acc.whp += f.whpPerDayM;
    if (f.diverted) acc.divertedSaved += f.savedPerDayM;
    byRoute.set(k, acc);
  }
  const topSavers: TopSaver[] = distinctLabels(
    [...byRoute.values()]
      .filter((r) => r.saved > 0)
      .map((r) => {
        const saver: TopSaver = {
          objectKey: objectKey('route', r.groupId, r.routeId),
          label: humanize(r.pipelineId !== '-' ? r.pipelineId : r.routeId, settings.humanize),
          savedPerDayM: r.saved,
          ratio: ratio(r.saved, r.whp),
          groupId: r.groupId,
          pipelineId: r.pipelineId,
        };
        // P1-F02: every dollar it saves is a diversion credit (a route with some bytes dropped too is not tagged).
        if (r.divertedSaved >= r.saved) saver.diverted = true;
        return saver;
      })
      .sort((a, b) => b.savedPerDayM - a.savedPerDayM || (a.objectKey < b.objectKey ? -1 : 1))
      .slice(0, MAX_TOP_SAVERS),
    settings.humanize,
  );

  // ── Trend: the last 30 local days since collecting began, oldest first ────
  const todayKey = localDayKey(sweepAtMs, tz);
  const sinceKey = localDayKey(Number.isFinite(parts.collectingSinceMs) ? parts.collectingSinceMs : sweepAtMs, tz);
  const trend: TrendPoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = addDaysToKey(todayKey, -i);
    if (day < sinceKey) continue;
    const d = parts.totals?.byDay?.[day];
    trend.push({ day, savedM: d?.savedM ?? 0, whpM: d?.whpM ?? 0, paidM: d?.paidM ?? 0 });
  }

  // ── 24 h ratio series: recompute buckets the minute rows fully cover, carry older ones forward ──
  const seriesRows = parts.ratioRows ?? parts.minuteRows;
  let coverageStart = Number.POSITIVE_INFINITY;
  for (const rows of Object.values(seriesRows)) for (const r of rows) coverageStart = Math.min(coverageStart, fromIso(r.t));
  const firstFullBucket = Number.isFinite(coverageStart) ? Math.ceil(coverageStart / RATIO_BUCKET_MS) * RATIO_BUCKET_MS : windowEndMs;
  const dayAgo = sweepAtMs - DAY_MS;
  const series = new Map<number, number>();
  for (const p of parts.previous?.ratioSeries ?? []) {
    const t = fromIso(p.t);
    if (t >= dayAgo && t < firstFullBucket) series.set(t, p.ratio);
  }
  for (const [t, b] of ratioBuckets(seriesRows, firstFullBucket, windowEndMs)) if (b.whp > 0) series.set(t, ratio(b.saved, b.whp));
  const ratioSeries = [...series.entries()]
    .filter(([t]) => t >= dayAgo)
    .sort((a, b) => a[0] - b[0])
    .slice(-MAX_RATIO_POINTS)
    .map(([t, r]) => ({ t: toIso(t), ratio: r }));

  // ── Incidents, timeline, deliveries ───────────────────────────────────────
  const incidents = (parts.incidents ?? [])
    .filter((i) => !i.closedAt || fromIso(i.closedAt) >= sweepAtMs - DAY_MS)
    .sort((a, b) => fromIso(b.openedAt) - fromIso(a.openedAt) || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_SNAPSHOT_INCIDENTS);
  const everyCommit = Array.isArray(parts.timeline) ? [...parts.timeline].sort((a, b) => fromIso(b.committedAt) - fromIso(a.committedAt)) : allCommits(parts.timeline);
  const timeline = everyCommit.slice(0, MAX_SNAPSHOT_TIMELINE);
  // A commit of the last 7 days left out (the Changes list says it shows the latest ones only).
  const timelineTruncated = droppedRecentCommit(everyCommit, MAX_SNAPSHOT_TIMELINE, sweepAtMs);
  const deliveries = [...(parts.deliveries ?? [])].sort((a, b) => fromIso(b.at) - fromIso(a.at)).slice(0, MAX_SNAPSHOT_DELIVERIES);

  // Founder-build r1 core-6 (#42): where priced traffic began, for the annualized basis (see Snapshot.pricedSince).
  const pricedSinceMs = pricedSince(parts, seriesRows);
  // Founder-build r3 core-5 (#3): the priced-since day's metered minutes before it, for the annualized basis.
  const emptyBefore = pricedSinceMs !== undefined ? emptyMinutesBeforePriced(parts, pricedSinceMs, tz) : undefined;
  const headline = computeHeadline(parts.totals, sweepAtMs, tz, parts.collectingSinceMs, settings.criblCostCentsPerMonth, parts.windowEndMs, {
    ...(pricedSinceMs !== undefined ? { pricedSinceMs } : {}),
    ...(emptyBefore !== undefined ? { emptyMinutesBeforePriced: emptyBefore } : {}),
  });
  Object.assign(headline, savingsSplit(headline.mtdM, destinations, parts.totals, monthKey), costAddedFigures(flows));

  return {
    schemaVersion: 1,
    sweepAt: toIso(sweepAtMs),
    windowStart: windowStartIso,
    windowEnd: toIso(windowEndMs),
    mode: parts.mode,
    headline,
    ratePerSecM: lastMinuteSavedM / 60,
    flows,
    destinations,
    topSavers,
    unpricedOutputIds: [...new Set(destinations.filter((d) => d.unpriced).map((d) => d.outputId))],
    openIncidents: openIncidents.length,
    incidents,
    trend,
    ratioSeries,
    timeline,
    ...(timelineTruncated ? { timelineTruncated: true as const } : {}),
    deliveries,
    calls: parts.calls,
    collectingSince: toIso(Number.isFinite(parts.collectingSinceMs) ? parts.collectingSinceMs : sweepAtMs),
    metricsSource: parts.metricsSource,
    attributionSummary: summarizeAttribution(flows),
    flowCounts: flowCounts(flows),
    ...(parts.zone ? { zone: parts.zone } : {}),
    ...(pricedSinceMs !== undefined ? { pricedSince: toIso(pricedSinceMs) } : {}),
    ...(emptyBefore !== undefined ? { pricedSinceEmptyMinutes: emptyBefore } : {}),
  };
}

/**
 * Founder-build r3 core-5 (FINDINGS_R3 #3): how many of the minutes metered on `pricedSinceMs`'s local day came before it
 * (none carried priced traffic) — counted, never inferred from the wall clock. The sweep that finds pricedSince metered
 * every minute from it to its window end (the first priced minute is always in its own range: a first run's rows reach
 * back to collecting since, and a later sweep finds it at or after the previous window end, or on the minute before it
 * that the same sweep rewrote — 1.1.5, A2), so the day's metered minutes less those this sweep metered from
 * pricedSince on are the ones before it. A pricedSince carried unchanged
 * carries its count; one carried from a snapshot without a count, or across a zone change, has none (the basis falls
 * back to r2's arithmetic).
 */
function emptyMinutesBeforePriced(parts: SnapshotParts, pricedSinceMs: number, tz: string): number | undefined {
  const prev = parts.previous;
  if (prev?.pricedSince && fromIso(prev.pricedSince) === pricedSinceMs) {
    const sameZone = (prev.zone ?? parts.zone ?? tz) === tz;
    return sameZone && typeof prev.pricedSinceEmptyMinutes === 'number' && Number.isFinite(prev.pricedSinceEmptyMinutes) ? prev.pricedSinceEmptyMinutes : undefined;
  }
  const key = localDayKey(pricedSinceMs, tz);
  const dayMinutes = parts.totals?.byDay?.[key]?.minutes ?? 0;
  const dayEnd = localDayStartMs(addDaysToKey(key, 1), tz);
  const fromPriced = Math.max(0, Math.floor((Math.min(dayEnd, parts.windowEndMs) - pricedSinceMs) / MINUTE_MS));
  return Math.max(0, dayMinutes - fromPriced);
}

/**
 * Founder-build r1 core-6 (#42): the minute priced traffic began (no minute before it carried any), carried from
 * snapshot to snapshot. Priced traffic is money either way: would-have-paid, or paid alone (1.1.5, HARDENING_1.1.4 A1:
 * a destination whose counterfactual is Nowhere never carries would-have-paid, so its pricedSince fell to the window's
 * end on every sweep and its annualized paid was the day's spend over one minute). A previous snapshot that kept one:
 * it stands once the workspace has had traffic; while it had none yet, the first priced minute in this sweep's rows at
 * or after collecting since, else this window's end. At or after collecting since, not only at or after the kept
 * minute (1.1.5, A2): the sweep that first finds a flow built after Start the meter also rewrites the minute before its
 * window, which falls before the kept minute, and rejecting it kept that minute's savings in the rate but its minute out
 * of the basis (up to 3× the true rate). A previous snapshot from before core-6: collecting since (the old basis,
 * unchanged). No previous snapshot (a first run): the first priced minute in the rows, when those rows reach back to
 * collecting since; otherwise (the tour, whose rows are its last hour) undefined — the old basis.
 */
function pricedSince(parts: SnapshotParts, rows: Record<FlowKey, MinuteRow[]>): number | undefined {
  const firstTraffic = (fromMs: number): number | undefined => {
    let first = Number.POSITIVE_INFINITY;
    for (const list of Object.values(rows)) for (const r of list) if (r.whpM > 0 || r.paidM > 0) first = Math.min(first, fromIso(r.t));
    return Number.isFinite(first) && first >= fromMs ? first : undefined;
  };
  const prev = parts.previous;
  if (prev) {
    if (!prev.pricedSince) return undefined; // a snapshot from before core-6: the basis stays collecting since
    const kept = fromIso(prev.pricedSince);
    const h = prev.headline;
    const hadTraffic = (h?.whp30dM ?? 0) > 0 || (h?.whpMtdM ?? 0) > 0 || (h?.paid30dM ?? 0) > 0 || (h?.paidMtdM ?? 0) > 0;
    if (hadTraffic) return kept;
    const from = Number.isFinite(parts.collectingSinceMs) ? Math.min(kept, parts.collectingSinceMs) : kept;
    return firstTraffic(from) ?? parts.windowEndMs;
  }
  // A first run: the rows it held must reach back to where collecting began (the tour's last hour does not).
  if (parts.rowsFromMs === undefined || !Number.isFinite(parts.collectingSinceMs) || !(parts.rowsFromMs <= parts.collectingSinceMs)) return undefined;
  return firstTraffic(parts.collectingSinceMs) ?? parts.windowEndMs;
}

/**
 * Every flow, and the distinct routes and sources, of a snapshot's full flow list (before compactSnapshot folds any
 * into 'Other'): the Ledger's header and the Receipt's "Watching now" count the estate from these (rules round 2).
 */
export function flowCounts(flows: readonly Pick<FlowFigures, 'key' | 'groupId' | 'routeId' | 'inputId' | 'folded'>[]): NonNullable<Snapshot['flowCounts']> {
  const routes = new Set<string>();
  const sources = new Set<string>();
  let n = 0;
  for (const f of flows) {
    if (f.key === OTHER_FLOW_KEY) {
      n += f.folded ?? 0;
      continue;
    }
    n++;
    if (f.routeId && f.routeId !== '-') routes.add(`${f.groupId}:${f.routeId}`);
    if (f.inputId && f.inputId !== '-') sources.add(`${f.groupId}:${f.inputId}`);
  }
  return { flows: n, routes: routes.size, sources: sources.size };
}

/** The Ledger's Changes list covers the last 7 days of commits. */
const CHANGES_WINDOW_MS = 7 * DAY_MS;

/** Whether keeping the newest `keep` of `commits` (newest first) leaves out one of the last 7 days before `nowMs`. */
export function droppedRecentCommit(commits: readonly Pick<Commit, 'committedAt'>[], keep: number, nowMs: number): boolean {
  const first = commits[keep];
  return first !== undefined && fromIso(first.committedAt) >= nowMs - CHANGES_WINDOW_MS;
}

/**
 * P1-F02: month to date, saved by reduction (bytes dropped, priced at the destination's own price) and by diversion
 * (data a destination is credited for at another's price). The diverted part is Σ the month's savings at destinations
 * whose counterfactual names another; reduction is the rest, so the two always add up to the hero. Nothing without
 * per-destination month totals (an older totals document).
 */
export function savingsSplit(
  mtdM: number,
  destinations: readonly Pick<DestinationFigures, 'outputId' | 'counterfactual' | 'mtdSavedM'>[],
  totals: TotalsDoc | null | undefined,
  monthKey: string,
): Pick<Snapshot['headline'], 'reducedMtdM' | 'divertedMtdM'> {
  if (Object.keys(totals?.byOutputMonth?.[monthKey] ?? {}).length === 0) return {};
  let diverted = 0;
  for (const d of destinations) if (isDiversion(d.counterfactual, d.outputId)) diverted += Math.max(0, d.mtdSavedM);
  const divertedMtdM = Math.min(Math.max(0, mtdM), diverted);
  return { reducedMtdM: mtdM - divertedMtdM, divertedMtdM };
}

/**
 * P1-F02: the destination a flow's data is credited at, when it is a diversion — from the flow itself, or (a snapshot
 * written before P1-F02, such as the bundled sample) from its destination's counterfactual. Undefined otherwise.
 */
export function diversionTarget(
  flow: Pick<FlowFigures, 'diverted' | 'divertedTo' | 'groupId' | 'outputId'>,
  destinations?: readonly Pick<DestinationFigures, 'groupId' | 'outputId' | 'counterfactual'>[],
): string | undefined {
  if (flow.diverted) return flow.divertedTo;
  const d = destinations?.find((x) => x.groupId === flow.groupId && x.outputId === flow.outputId);
  return d && isDiversion(d.counterfactual, d.outputId) && d.counterfactual.kind === 'other' ? d.counterfactual.outputId : undefined;
}

/**
 * P1-F02: month to date by reduction and by diversion, for display — the headline's own split, or (a snapshot
 * written before P1-F02) the same rule over its destinations' month totals when those add up to the hero.
 */
export function headlineSplit(snapshot: Pick<Snapshot, 'headline' | 'destinations'> | null | undefined): { reducedM: number; divertedM: number } | undefined {
  const h = snapshot?.headline;
  if (!h) return undefined;
  if (h.reducedMtdM !== undefined && h.divertedMtdM !== undefined) return { reducedM: h.reducedMtdM, divertedM: h.divertedMtdM };
  const dests = snapshot?.destinations ?? [];
  const rows = dests.reduce((s, d) => s + Math.max(0, d.mtdSavedM), 0);
  // Only when the month totals are the hero's (the same minutes): within a dollar of it.
  if (!(rows > 0) || Math.abs(rows - h.mtdM) > 100_000) return undefined;
  const diverted = Math.min(h.mtdM, dests.filter((d) => isDiversion(d.counterfactual, d.outputId)).reduce((s, d) => s + Math.max(0, d.mtdSavedM), 0));
  return { reducedM: h.mtdM - diverted, divertedM: diverted };
}

/** P1-F03: per day, the cost Cribl adds across flows that grow bytes, and how many flows; nothing when none do. */
export function costAddedFigures(flows: readonly Pick<FlowFigures, 'addedPerDayM'>[]): Pick<Snapshot['headline'], 'addedPerDayM' | 'addedFlows'> {
  const adding = flows.filter((f) => (f.addedPerDayM ?? 0) > 0);
  if (adding.length === 0) return {};
  return { addedPerDayM: adding.reduce((s, f) => s + (f.addedPerDayM ?? 0), 0), addedFlows: adding.length };
}

// ─── Compaction ──────────────────────────────────────────────────────────────

/** UTF-8 byte length of a string (what the KV cap measures), without TextEncoder. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export function snapshotBytes(s: Snapshot): number {
  return utf8Length(JSON.stringify(s));
}

export const OTHER_FLOW_KEY: FlowKey = makeFlowKey('-', 'other', '-', '-', '-');

/** Keeps the top `keep` flows by would-have-paid per day and folds the rest into one 'other' flow. */
function foldFlows(flows: FlowFigures[], keep: number): FlowFigures[] {
  const existingOther = flows.find((f) => f.key === OTHER_FLOW_KEY);
  const ranked = flows
    .filter((f) => f.key !== OTHER_FLOW_KEY)
    .sort((a, b) => b.whpPerDayM - a.whpPerDayM || (a.key < b.key ? -1 : 1));
  const rest = [...ranked.slice(keep), ...(existingOther ? [existingOther] : [])];
  if (rest.length === 0) return ranked.slice(0, keep);
  const total = (k: keyof FlowFigures): number => sum(rest, (f) => f[k] as number);
  // How many real flows 'Other' holds: the folded ones, plus what an earlier fold already held.
  const folded = ranked.length - Math.min(keep, ranked.length) + (existingOther?.folded ?? 0);
  const other: FlowFigures = {
    key: OTHER_FLOW_KEY,
    groupId: '-',
    inputId: 'other',
    routeId: '-',
    pipelineId: '-',
    outputId: '-',
    inB: total('inB'),
    outB: total('outB'),
    whpM: total('whpM'),
    paidM: total('paidM'),
    savedM: total('savedM'),
    ratio: ratio(total('savedM'), total('whpM')),
    ratePerHourM: total('ratePerHourM'),
    savedPerDayM: total('savedPerDayM'),
    whpPerDayM: total('whpPerDayM'),
    paidPerDayM: total('paidPerDayM'),
    inBPerDay: total('inBPerDay'),
    outBPerDay: total('outBPerDay'),
    attribution: 'proportional',
    sparkline: [],
    state: 'ok',
    folded,
  };
  return [...ranked.slice(0, keep), other];
}

/** Last `points` values, averaged down when longer (deterministic). */
function shrinkSparkline(values: number[], points: number): number[] {
  if (values.length <= points) return values;
  const out: number[] = [];
  for (let b = 0; b < points; b++) {
    const from = Math.floor((b * values.length) / points);
    const to = Math.floor(((b + 1) * values.length) / points);
    out.push(sum(values.slice(from, to), (v) => v) / Math.max(1, to - from));
  }
  return out;
}

/** Halves the ratio series resolution by averaging neighbouring points. */
function halveSeries(series: Snapshot['ratioSeries']): Snapshot['ratioSeries'] {
  const out: Snapshot['ratioSeries'] = [];
  for (let i = 0; i < series.length; i += 2) {
    const pair = series.slice(i, i + 2);
    out.push({ t: pair[0].t, ratio: sum(pair, (p) => p.ratio) / pair.length });
  }
  return out;
}

/**
 * Shrinks a snapshot until its JSON fits `maxJsonBytes` (DECISIONS D13), in a fixed order so the
 * result is deterministic: top 500 flows + 'other', 12-point sparklines, then halve the ratio series
 * (down to 36 points), then keep fewer flows (250, 100, 50), then trim incidents, timeline and
 * deliveries, then drop sparklines. Returns the input unchanged when it already fits.
 */

/** The newest `keep` commits of a snapshot being compacted, flagged when one of the last 7 days goes with the rest. */
function keepCommits(x: Snapshot, keep: number): Pick<Snapshot, 'timeline' | 'timelineTruncated'> {
  const cut = x.timelineTruncated || droppedRecentCommit(x.timeline, keep, fromIso(x.sweepAt));
  return { timeline: x.timeline.slice(0, keep), ...(cut ? { timelineTruncated: true as const } : {}) };
}

export function compactSnapshot(snapshot: Snapshot, maxJsonBytes: number): Snapshot {
  if (snapshotBytes(snapshot) <= maxJsonBytes) return snapshot;
  let s: Snapshot = {
    ...snapshot,
    flows: foldFlows(snapshot.flows, COMPACT_FLOWS).map((f) => ({ ...f, sparkline: shrinkSparkline(f.sparkline, COMPACT_SPARKLINE_POINTS) })),
  };
  const steps: ((x: Snapshot) => Snapshot | undefined)[] = [
    (x) => (x.ratioSeries.length > 144 ? { ...x, ratioSeries: halveSeries(x.ratioSeries) } : undefined),
    (x) => (x.ratioSeries.length > 72 ? { ...x, ratioSeries: halveSeries(x.ratioSeries) } : undefined),
    (x) => (x.ratioSeries.length > 36 ? { ...x, ratioSeries: halveSeries(x.ratioSeries) } : undefined),
    (x) => (x.flows.length > 251 ? { ...x, flows: foldFlows(x.flows, 250) } : undefined),
    (x) => (x.flows.length > 101 ? { ...x, flows: foldFlows(x.flows, 100) } : undefined),
    (x) => (x.flows.length > 51 ? { ...x, flows: foldFlows(x.flows, 50) } : undefined),
    (x) => ({ ...x, incidents: x.incidents.slice(0, 20), ...keepCommits(x, 10), deliveries: x.deliveries.slice(0, 10) }),
    (x) => ({ ...x, flows: x.flows.map((f) => ({ ...f, sparkline: [] })) }),
    (x) => ({ ...x, incidents: x.incidents.filter((i) => !i.closedAt).slice(0, 10), ...keepCommits(x, 5), deliveries: [] }),
  ];
  for (const step of steps) {
    if (snapshotBytes(s) <= maxJsonBytes) break;
    s = step(s) ?? s;
  }
  return s;
}
