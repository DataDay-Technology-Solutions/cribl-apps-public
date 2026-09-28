// core/adapters/metrics.ts — throughput per minute from POST /system/metrics/query (SPEC 7 step 4).
//
// One sweep (or one backfill of a multi-hour gap) costs exactly three calls, each covering every worker
// group at once by splitting on `__worker_group`:
//   inputs  : sum(total.in_bytes), sum(total.in_events)          split by [__worker_group, input]
//   outputs : sum(total.out_bytes), sum(total.out_events)        split by [__worker_group, output]
//   routes  : sum(route.in/out_bytes), sum(route.in/out_events)  split by [__worker_group, route, name]
// (+ an optional fourth for pipeline EVENTS — pipelines have no byte series.)
//
// Response facts this parser relies on (docs/platform/metrics.md, live captures in tests/fixtures/cribl):
//   • `{ results: Row[], metrics, info: { timeWindowSeconds } }`; bucketed rows carry `starttime`/`endtime`
//     in epoch SECONDS and no `_time`;
//   • split queries also return ROLLUP rows that lack one of the split keys and duplicate the sum of the
//     fully split rows — they are dropped (the one exception: a route row lacking only `name` is kept when it
//     is the only row for that route, since name is 1:1 with the rule id);
//   • an aggregation with no data is omitted from the row (missing = 0); idle objects can report explicit 0s;
//   • input/output dimension values are `<type>:<id>`, sometimes `<type>:<id>:<variant>` (e.g.
//     `syslog:in_syslog:udp`), a sub-series of the two-part parent — used only when the parent is absent;
//   • older data comes back at coarser resolution (300 s / 600 s), sometimes still claiming the requested
//     width. Such buckets are spread evenly over the minutes they cover and those minutes are flagged
//     `coarse` so the sweep can skip detection on them. Sums over the range are preserved exactly.
// Time bounds are absolute epoch milliseconds (relative strings answered an empty 200 live).

import type { ByteEvent, CriblHttp, HttpResult, InventoryDoc, MetricsWindow } from '../types.ts';
import { metricsQuery } from './cribl-urls.ts';

export const MINUTE_MS = 60_000;
/** Coarsest bucket width the spacing inference will accept (s). */
const MAX_INFERRED_WIDTH_S = 3_600;

export interface MetricsQueryBody {
  where: string;
  /** epoch ms */
  earliest: number;
  /** epoch ms */
  latest: number;
  aggs: { aggregations: string[]; splitBys: string[]; timeWindowSeconds: number };
}
export type MetricsQueryName = 'inputs' | 'outputs' | 'routes' | 'pipelines';
export interface WindowQueries {
  inputs: MetricsQueryBody;
  outputs: MetricsQueryBody;
  routes: MetricsQueryBody;
  pipelines?: MetricsQueryBody;
}

const AGGS = {
  inputs: ['sum("total.in_bytes").as("inB")', 'sum("total.in_events").as("inE")'],
  outputs: ['sum("total.out_bytes").as("outB")', 'sum("total.out_events").as("outE")'],
  routes: ['sum("route.in_bytes").as("inB")', 'sum("route.out_bytes").as("outB")', 'sum("route.in_events").as("inE")', 'sum("route.out_events").as("outE")'],
  pipelines: ['sum("pipe.in_events").as("inE")', 'sum("pipe.out_events").as("outE")'],
} as const;

const SPLITS = {
  inputs: ['__worker_group', 'input'],
  outputs: ['__worker_group', 'output'],
  routes: ['__worker_group', 'route', 'name'],
  pipelines: ['__worker_group', 'id'],
} as const;

/** A worker-group `where` clause with quoted, escaped literals. */
export function groupWhere(groupIds: readonly string[]): string {
  if (groupIds.length === 0) throw new Error('groupWhere needs at least one worker group');
  const lit = (g: string) => `'${g.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const terms = groupIds.map((g) => `__worker_group==${lit(g)}`);
  return terms.length === 1 ? terms[0] : `(${terms.join(' || ')})`;
}

function alignDown(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * Request bodies for one range. Bounds are aligned down to whole minutes, so an unaligned `windowEndMs`
 * never pulls in a partial minute.
 */
export function buildWindowQueries(
  groupIds: readonly string[],
  windowStartMs: number,
  windowEndMs: number,
  timeWindowSeconds = 60,
  opts: { withPipelines?: boolean } = {},
): WindowQueries {
  const where = groupWhere(groupIds);
  const earliest = alignDown(windowStartMs);
  const latest = alignDown(windowEndMs);
  const body = (name: MetricsQueryName): MetricsQueryBody => ({
    where,
    earliest,
    latest,
    aggs: { aggregations: [...AGGS[name]], splitBys: [...SPLITS[name]], timeWindowSeconds },
  });
  const q: WindowQueries = { inputs: body('inputs'), outputs: body('outputs'), routes: body('routes') };
  if (opts.withPipelines) q.pipelines = body('pipelines');
  return q;
}

// ─── Results ─────────────────────────────────────────────────────────────────
/** A MetricsWindow plus how trustworthy its per-minute split is. */
export interface MeteredWindow extends MetricsWindow {
  /** True when any value in this minute was spread from a bucket wider than one minute. */
  coarse: boolean;
  /** Widest source bucket (s) that contributed to this minute; 60 when every value was per-minute. */
  bucketSeconds: number;
}

export interface MetricsFetchResult {
  windows: MeteredWindow[];
  /** `${groupId}:${inputId}` → input type (the stripped dimension prefix). */
  inputTypes: Record<string, string>;
  /** `${groupId}:${outputId}` → output type. */
  outputTypes: Record<string, string>;
  /** `${groupId}:${routeId}` → route name, when the `name` dimension came back. */
  routeNames: Record<string, string>;
  /** Route byte series existed in the answer (drives SPEC 7.5 attribution). */
  hasRouteBytes: boolean;
  /** Any window is coarse. */
  coarse: boolean;
  /** Metrics queries issued. */
  calls: number;
  /** Non-fatal query failures (routes / pipelines); inputs/outputs failures throw MetricsQueryError. */
  errors: { query: MetricsQueryName; status: number; message: string }[];
}

export interface FetchMetricsOptions {
  timeWindowSeconds?: number;
  withPipelines?: boolean;
  timeoutMs?: number;
  /** When given, input/output ids are matched against the configured ids (see splitDimension). */
  inventory?: InventoryDoc | null;
}

/** The inputs or outputs query failed: no throughput can be priced for this range (abstain, don't zero-fill). */
export class MetricsQueryError extends Error {
  readonly query: MetricsQueryName;
  readonly status: number;
  constructor(query: MetricsQueryName, status: number, detail?: string) {
    super(`metrics ${query} query failed: HTTP ${status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
    this.name = 'MetricsQueryError';
    this.query = query;
    this.status = status;
  }
}

// ─── Parsing ─────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
interface Sample {
  startSec: number;
  widthSec: number;
  series: string; // `${gid}:${id}`
  a: ByteEvent; // in (inputs, routes, pipelines) or out (outputs)
  b?: ByteEvent; // out side for routes / pipelines
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const count = (v: unknown): number => Math.max(0, Math.round(num(v) ?? 0));
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function resultsOf(res: HttpResult): { rows: Row[]; declaredWidth?: number } {
  const body = res.json !== null && typeof res.json === 'object' ? (res.json as Record<string, unknown>) : {};
  const rows = Array.isArray(body.results) ? body.results.filter((r): r is Row => r !== null && typeof r === 'object') : [];
  const info = body.info !== null && typeof body.info === 'object' ? (body.info as Record<string, unknown>) : {};
  const w = num(info.timeWindowSeconds);
  return { rows, declaredWidth: w !== undefined && w > 0 ? w : undefined };
}

function rowTiming(row: Row, fallbackWidth: number): { startSec: number; widthSec: number } | null {
  const start = num(row.starttime) ?? num(row._time);
  if (start === undefined) return null;
  const end = num(row.endtime);
  return { startSec: start, widthSec: end !== undefined && end > start ? end - start : fallbackWidth };
}

/**
 * Splits an input/output dimension value: `datagen:mrd_payments_api` → { type: 'datagen', id:
 * 'mrd_payments_api', variant: false }. With the group's configured ids (`known`), the id is matched
 * longest-first, so an id that itself contains ':' resolves correctly and `<type>:<id>:<suffix>` is
 * recognized as a variant sub-series of `<id>`. Without them, the id is the segment after the type.
 */
export function splitDimension(value: string, known?: ReadonlySet<string>): { type: string; id: string; variant: boolean } {
  const at = value.indexOf(':');
  if (at < 0) return { type: '', id: value, variant: false };
  const type = value.slice(0, at);
  const rest = value.slice(at + 1);
  const segs = rest.split(':');
  if (known && known.size > 0) {
    if (known.has(rest)) return { type, id: rest, variant: false };
    for (let k = segs.length - 1; k >= 1; k--) {
      const candidate = segs.slice(0, k).join(':');
      if (known.has(candidate)) return { type, id: candidate, variant: true };
    }
  }
  return { type, id: segs[0], variant: segs.length > 1 };
}

const add = (x: ByteEvent, y: ByteEvent): ByteEvent => ({ bytes: x.bytes + y.bytes, events: x.events + y.events });

/** inputs / outputs: drop rollups, fold `<type>:<id>:<variant>` rows only when the parent row is absent. */
function parseEndpointRows(
  rows: Row[],
  dim: 'input' | 'output',
  bytesAlias: 'inB' | 'outB',
  eventsAlias: 'inE' | 'outE',
  groups: ReadonlySet<string>,
  fallbackWidth: number,
  types: Record<string, string>,
  knownIds: ReadonlyMap<string, ReadonlySet<string>>,
): Sample[] {
  const buckets = new Map<string, { startSec: number; widthSec: number; series: string; exact: ByteEvent | null; sub: ByteEvent | null }>();
  for (const row of rows) {
    const gid = row.__worker_group;
    const value = row[dim];
    if (!nonEmpty(gid) || !nonEmpty(value) || !groups.has(gid)) continue; // rollup or foreign group
    const timing = rowTiming(row, fallbackWidth);
    if (!timing) continue;
    const { type, id, variant } = splitDimension(value, knownIds.get(gid));
    const series = `${gid}:${id}`;
    if (type && !types[series]) types[series] = type;
    const k = `${timing.startSec}|${series}`;
    let b = buckets.get(k);
    if (!b) {
      b = { ...timing, series, exact: null, sub: null };
      buckets.set(k, b);
    }
    b.widthSec = Math.max(b.widthSec, timing.widthSec);
    const be: ByteEvent = { bytes: count(row[bytesAlias]), events: count(row[eventsAlias]) };
    if (variant) b.sub = b.sub ? add(b.sub, be) : be;
    else b.exact = b.exact ? add(b.exact, be) : be;
  }
  return [...buckets.values()].map((b) => ({ startSec: b.startSec, widthSec: b.widthSec, series: b.series, a: (b.exact ?? b.sub) as ByteEvent }));
}

/** routes: drop rollups; a row lacking only `name` counts only when no named row exists for that route. */
function parseRouteRows(
  rows: Row[],
  groups: ReadonlySet<string>,
  fallbackWidth: number,
  names: Record<string, string>,
): { samples: Sample[]; sawBytes: boolean } {
  let sawBytes = false;
  const buckets = new Map<string, { startSec: number; widthSec: number; series: string; named: [ByteEvent, ByteEvent] | null; unnamed: [ByteEvent, ByteEvent] | null }>();
  for (const row of rows) {
    const gid = row.__worker_group;
    const routeId = row.route;
    if (!nonEmpty(gid) || !nonEmpty(routeId) || !groups.has(gid)) continue;
    const timing = rowTiming(row, fallbackWidth);
    if (!timing) continue;
    const series = `${gid}:${routeId}`;
    const hasName = nonEmpty(row.name);
    if (hasName && !names[series]) names[series] = row.name as string;
    if (num(row.inB) !== undefined || num(row.outB) !== undefined) sawBytes = true;
    const k = `${timing.startSec}|${series}`;
    let b = buckets.get(k);
    if (!b) {
      b = { ...timing, series, named: null, unnamed: null };
      buckets.set(k, b);
    }
    b.widthSec = Math.max(b.widthSec, timing.widthSec);
    const pair: [ByteEvent, ByteEvent] = [
      { bytes: count(row.inB), events: count(row.inE) },
      { bytes: count(row.outB), events: count(row.outE) },
    ];
    const slot = hasName ? 'named' : 'unnamed';
    const prev = b[slot];
    b[slot] = prev ? [add(prev[0], pair[0]), add(prev[1], pair[1])] : pair;
  }
  const samples = [...buckets.values()].map((b) => {
    const [a, out] = (b.named ?? b.unnamed) as [ByteEvent, ByteEvent];
    return { startSec: b.startSec, widthSec: b.widthSec, series: b.series, a, b: out };
  });
  return { samples, sawBytes };
}

function parsePipelineRows(rows: Row[], groups: ReadonlySet<string>, fallbackWidth: number): Sample[] {
  const buckets = new Map<string, Sample>();
  for (const row of rows) {
    const gid = row.__worker_group;
    const id = row.id;
    if (!nonEmpty(gid) || !nonEmpty(id) || !groups.has(gid)) continue;
    const timing = rowTiming(row, fallbackWidth);
    if (!timing) continue;
    const series = `${gid}:${id}`;
    const k = `${timing.startSec}|${series}`;
    const inE: ByteEvent = { bytes: 0, events: count(row.inE) };
    const outE: ByteEvent = { bytes: 0, events: count(row.outE) };
    const prev = buckets.get(k);
    if (prev) {
      prev.a = add(prev.a, inE);
      prev.b = add(prev.b as ByteEvent, outE);
      prev.widthSec = Math.max(prev.widthSec, timing.widthSec);
    } else buckets.set(k, { ...timing, series, a: inE, b: outE });
  }
  return [...buckets.values()];
}

/**
 * Effective width per bucket start. The declared width is trusted unless the union of bucket starts shows a
 * steady coarser spacing (e.g. rows every 600 s that claim 300 s, or every 300 s that claim 60 s): a start
 * aligned to a gap g > declared, with g a multiple of it, where the neighbouring gap is also g.
 */
export function inferBucketWidths(declared: ReadonlyMap<number, number>): Map<number, number> {
  const starts = [...declared.keys()].sort((x, y) => x - y);
  const eff = new Map<number, number>();
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const w = declared.get(s) as number;
    const gNext = i + 1 < starts.length ? starts[i + 1] - s : undefined;
    const gPrev = i > 0 ? s - starts[i - 1] : undefined;
    const gAfter = i + 2 < starts.length ? starts[i + 2] - starts[i + 1] : undefined;
    const coarse = (g: number | undefined): g is number => g !== undefined && g > w && g % w === 0 && g <= MAX_INFERRED_WIDTH_S && s % g === 0;
    let width = w;
    if (coarse(gNext) && (gPrev === gNext || gAfter === gNext)) width = gNext;
    else if (gNext === undefined && coarse(gPrev) && eff.get(starts[i - 1]) === gPrev) width = gPrev;
    eff.set(s, width);
  }
  return eff;
}

/** Splits an integer total over `n` parts, remainder to the first parts, so the parts sum exactly. */
function splitInt(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  let rem = total - base * n;
  return Array.from({ length: n }, () => base + (rem-- > 0 ? 1 : 0));
}

type Target = 'inputs' | 'outputs' | 'routesIn' | 'routesOut' | 'pipelinesIn' | 'pipelinesOut';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ─── Fetch ───────────────────────────────────────────────────────────────────
/**
 * Metrics for every minute in [startMs, endMs) (bounds aligned down to minutes) across `groupIds`, with
 * everything the sweep needs besides the windows. Throws MetricsQueryError when the inputs or outputs query
 * fails; a failed routes query only turns `hasRouteBytes` off (attribution falls back, SPEC 19.1).
 */
export async function fetchMetrics(
  http: CriblHttp,
  groupIds: readonly string[],
  startMs: number,
  endMs: number,
  opts: FetchMetricsOptions = {},
): Promise<MetricsFetchResult> {
  const rangeStart = alignDown(startMs);
  const rangeEnd = alignDown(endMs);
  const result: MetricsFetchResult = {
    windows: [],
    inputTypes: {},
    outputTypes: {},
    routeNames: {},
    hasRouteBytes: false,
    coarse: false,
    calls: 0,
    errors: [],
  };
  if (rangeEnd <= rangeStart || groupIds.length === 0) return result;

  const requested = opts.timeWindowSeconds ?? 60;
  const queries = buildWindowQueries(groupIds, rangeStart, rangeEnd, requested, { withPipelines: opts.withPipelines });
  const names: MetricsQueryName[] = ['inputs', 'outputs', 'routes'];
  if (queries.pipelines) names.push('pipelines');
  const responses = await Promise.all(
    names.map((n) => http.request('POST', metricsQuery(), queries[n], opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined)),
  );
  result.calls = responses.length;
  const byName = new Map(names.map((n, i) => [n, responses[i]] as const));

  for (const n of ['inputs', 'outputs'] as const) {
    const res = byName.get(n) as HttpResult;
    if (!res.ok) throw new MetricsQueryError(n, res.status, res.text ?? (res.json === undefined ? undefined : JSON.stringify(res.json)));
  }

  const groups = new Set(groupIds);
  const inputsRes = resultsOf(byName.get('inputs') as HttpResult);
  const outputsRes = resultsOf(byName.get('outputs') as HttpResult);
  const knownInputs = new Map<string, ReadonlySet<string>>();
  const knownOutputs = new Map<string, ReadonlySet<string>>();
  for (const [gid, g] of Object.entries(opts.inventory?.byGroup ?? {})) {
    knownInputs.set(gid, new Set(g.inputs.map((i) => i.id)));
    knownOutputs.set(gid, new Set(g.outputs.map((o) => o.id)));
  }
  const inputSamples = parseEndpointRows(inputsRes.rows, 'input', 'inB', 'inE', groups, inputsRes.declaredWidth ?? requested, result.inputTypes, knownInputs);
  const outputSamples = parseEndpointRows(outputsRes.rows, 'output', 'outB', 'outE', groups, outputsRes.declaredWidth ?? requested, result.outputTypes, knownOutputs);

  let routeSamples: Sample[] | null = null;
  const routesRaw = byName.get('routes') as HttpResult;
  if (routesRaw.ok) {
    const r = resultsOf(routesRaw);
    const parsed = parseRouteRows(r.rows, groups, r.declaredWidth ?? requested, result.routeNames);
    routeSamples = parsed.samples;
    result.hasRouteBytes = parsed.sawBytes;
  } else {
    result.errors.push({ query: 'routes', status: routesRaw.status, message: (routesRaw.text ?? '').slice(0, 200) });
  }

  let pipelineSamples: Sample[] | null = null;
  const pipesRaw = byName.get('pipelines');
  if (pipesRaw) {
    if (pipesRaw.ok) {
      const p = resultsOf(pipesRaw);
      pipelineSamples = parsePipelineRows(p.rows, groups, p.declaredWidth ?? requested);
    } else {
      result.errors.push({ query: 'pipelines', status: pipesRaw.status, message: (pipesRaw.text ?? '').slice(0, 200) });
    }
  }

  // One minute grid for the whole range; missing = 0.
  const windows = new Map<number, MeteredWindow>();
  for (let m = rangeStart; m < rangeEnd; m += MINUTE_MS) {
    const w: MeteredWindow = {
      windowStart: iso(m),
      windowEnd: iso(m + MINUTE_MS),
      inputs: {},
      outputs: {},
      has: { routeBytes: result.hasRouteBytes, pipelineBytes: false },
      coarse: false,
      bucketSeconds: 60,
    };
    if (routeSamples) {
      w.routesIn = {};
      w.routesOut = {};
    }
    if (pipelineSamples) {
      w.pipelinesIn = {};
      w.pipelinesOut = {};
    }
    windows.set(m, w);
  }

  // Effective bucket widths from the union of every series' bucket starts.
  const declared = new Map<number, number>();
  const everySample = [...inputSamples, ...outputSamples, ...(routeSamples ?? []), ...(pipelineSamples ?? [])];
  for (const s of everySample) declared.set(s.startSec, Math.max(declared.get(s.startSec) ?? 0, s.widthSec));
  const effective = inferBucketWidths(declared);

  const place = (samples: Sample[], a: Target, b?: Target): void => {
    for (const s of samples) {
      const width = Math.max(s.widthSec, effective.get(s.startSec) ?? s.widthSec);
      const bucketStart = s.startSec * 1000;
      if (width <= 60) {
        const w = windows.get(alignDown(bucketStart));
        if (!w) continue;
        accumulate(w, a, s.series, s.a);
        if (b && s.b) accumulate(w, b, s.series, s.b);
        continue;
      }
      // Coarse: spread over the minutes of the bucket that fall inside the requested range.
      const from = Math.max(Math.ceil(bucketStart / MINUTE_MS) * MINUTE_MS, rangeStart);
      const to = Math.min(bucketStart + width * 1000, rangeEnd);
      const minutes: number[] = [];
      for (let m = from; m < to; m += MINUTE_MS) minutes.push(m);
      if (minutes.length === 0) continue;
      const spread = (be: ByteEvent): ByteEvent[] => {
        const bytes = splitInt(be.bytes, minutes.length);
        const events = splitInt(be.events, minutes.length);
        return minutes.map((_, i) => ({ bytes: bytes[i], events: events[i] }));
      };
      const partsA = spread(s.a);
      const partsB = b && s.b ? spread(s.b) : null;
      minutes.forEach((m, i) => {
        const w = windows.get(m) as MeteredWindow;
        w.coarse = true;
        w.bucketSeconds = Math.max(w.bucketSeconds, width);
        accumulate(w, a, s.series, partsA[i]);
        if (b && partsB) accumulate(w, b, s.series, partsB[i]);
      });
    }
  };

  place(inputSamples, 'inputs');
  place(outputSamples, 'outputs');
  if (routeSamples) place(routeSamples, 'routesIn', 'routesOut');
  if (pipelineSamples) place(pipelineSamples, 'pipelinesIn', 'pipelinesOut');

  result.windows = [...windows.values()];
  result.coarse = result.windows.some((w) => w.coarse);
  return result;
}

function accumulate(w: MeteredWindow, target: Target, series: string, be: ByteEvent): void {
  const map = w[target] as Record<string, ByteEvent>;
  const prev = map[series];
  map[series] = prev ? add(prev, be) : { bytes: be.bytes, events: be.events };
}

/** One MeteredWindow per minute in [startMs, endMs); see fetchMetrics for the rich result. */
export async function fetchMetricsWindows(
  http: CriblHttp,
  groupIds: readonly string[],
  startMs: number,
  endMs: number,
  opts: FetchMetricsOptions = {},
): Promise<MeteredWindow[]> {
  return (await fetchMetrics(http, groupIds, startMs, endMs, opts)).windows;
}
