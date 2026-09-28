import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CriblHttp, HttpResult, InventoryDoc } from '../../core/types.ts';
import {
  buildWindowQueries,
  fetchMetrics,
  fetchMetricsWindows,
  groupWhere,
  inferBucketWidths,
  MetricsQueryError,
  splitDimension,
  type MetricsQueryBody,
} from '../../core/adapters/metrics.ts';

interface Envelope {
  request: { method: string; path: string; body?: MetricsQueryBody };
  status: number;
  body: unknown;
}
const fixture = (name: string): Envelope =>
  JSON.parse(readFileSync(new URL(`../fixtures/cribl/${name}.json`, import.meta.url), 'utf8')) as Envelope;

const T0 = 1790395200_000; // 2026-09-26T03:20:00Z — the synthetic fixtures' first minute
const iso = (ms: number) => new Date(ms).toISOString();

type Kind = 'input' | 'output' | 'route' | 'id';
/** Answers metrics queries by their split dimension; records every request body. */
function metricsHttp(answers: Partial<Record<Kind, HttpResult>>) {
  const bodies: MetricsQueryBody[] = [];
  const http: CriblHttp = {
    async request(method, path, body) {
      expect(method).toBe('POST');
      expect(path).toBe('/system/metrics/query');
      const b = body as MetricsQueryBody;
      bodies.push(b);
      const kind = b.aggs.splitBys[1] as Kind;
      return answers[kind] ?? { status: 200, ok: true, json: { results: [], info: { timeWindowSeconds: 60 } } };
    },
  };
  return { http, bodies };
}
const ok = (name: string): HttpResult => ({ status: 200, ok: true, json: fixture(name).body });

describe('buildWindowQueries', () => {
  it('builds one query per split set covering every group, with epoch-ms bounds aligned to minutes', () => {
    const q = buildWindowQueries(['default'], T0 + 1234, T0 + 180_000 + 59_999);
    expect(q.inputs).toEqual({
      where: "__worker_group=='default'",
      earliest: T0,
      latest: T0 + 180_000,
      aggs: { aggregations: ['sum("total.in_bytes").as("inB")', 'sum("total.in_events").as("inE")'], splitBys: ['__worker_group', 'input'], timeWindowSeconds: 60 },
    });
    expect(q.outputs.aggs.splitBys).toEqual(['__worker_group', 'output']);
    expect(q.outputs.aggs.aggregations).toEqual(['sum("total.out_bytes").as("outB")', 'sum("total.out_events").as("outE")']);
    expect(q.routes.aggs.splitBys).toEqual(['__worker_group', 'route', 'name']);
    expect(q.routes.aggs.aggregations).toHaveLength(4);
    expect(q.pipelines).toBeUndefined();
    const withPipes = buildWindowQueries(['a', 'b'], T0, T0 + 60_000, 300, { withPipelines: true });
    expect(withPipes.pipelines?.aggs).toMatchObject({ splitBys: ['__worker_group', 'id'], timeWindowSeconds: 300 });
    expect(withPipes.inputs.where).toBe("(__worker_group=='a' || __worker_group=='b')");
  });

  it('matches the request captured with the synthetic fixture', () => {
    const q = buildWindowQueries(['default'], T0, T0 + 180_000);
    expect(q.inputs).toEqual(fixture('metrics-inputs.synthetic').request.body);
    expect(q.outputs).toEqual(fixture('metrics-outputs.synthetic').request.body);
    expect(q.routes).toEqual(fixture('metrics-routes.synthetic').request.body);
  });

  it('escapes group literals and refuses an empty group list', () => {
    expect(groupWhere(["o'brien\\x"])).toBe("__worker_group=='o\\'brien\\\\x'");
    expect(() => groupWhere([])).toThrow(/at least one/);
  });
});

describe('splitDimension', () => {
  it('strips the type prefix and flags variant sub-series', () => {
    expect(splitDimension('datagen:mrd_payments_api')).toEqual({ type: 'datagen', id: 'mrd_payments_api', variant: false });
    expect(splitDimension('syslog:in_syslog:udp')).toEqual({ type: 'syslog', id: 'in_syslog', variant: true });
    expect(splitDimension('bare')).toEqual({ type: '', id: 'bare', variant: false });
  });
  it('matches configured ids longest-first when they are known', () => {
    const known = new Set(['net:data', 'in_syslog']);
    expect(splitDimension('subscription:net:data', known)).toEqual({ type: 'subscription', id: 'net:data', variant: false });
    expect(splitDimension('subscription:net:data:team', known)).toEqual({ type: 'subscription', id: 'net:data', variant: true });
    expect(splitDimension('syslog:in_syslog:udp', known)).toEqual({ type: 'syslog', id: 'in_syslog', variant: true });
    expect(splitDimension('tcp:unknown:x', known)).toEqual({ type: 'tcp', id: 'unknown', variant: true });
  });
});

describe('fetchMetrics on the synthetic minute fixtures', () => {
  async function run() {
    const { http, bodies } = metricsHttp({ input: ok('metrics-inputs.synthetic'), output: ok('metrics-outputs.synthetic'), route: ok('metrics-routes.synthetic') });
    const result = await fetchMetrics(http, ['default'], T0, T0 + 180_000);
    return { result, bodies };
  }

  it('costs exactly three queries and returns one window per minute', async () => {
    const { result, bodies } = await run();
    expect(result.calls).toBe(3);
    expect(bodies).toHaveLength(3);
    expect(result.windows.map((w) => [w.windowStart, w.windowEnd])).toEqual([
      [iso(T0), iso(T0 + 60_000)],
      [iso(T0 + 60_000), iso(T0 + 120_000)],
      [iso(T0 + 120_000), iso(T0 + 180_000)],
    ]);
    expect(result.errors).toEqual([]);
    expect(result.coarse).toBe(false);
    for (const w of result.windows) expect(w).toMatchObject({ coarse: false, bucketSeconds: 60, has: { routeBytes: true, pipelineBytes: false } });
  });

  it('drops rollup rows, strips type prefixes and remembers the types', async () => {
    const { result } = await run();
    const w0 = result.windows[0];
    expect(w0.inputs['default:mrd_payments_api']).toEqual({ bytes: 27_777_000, events: 55_000 });
    expect(w0.inputs['default:mrd_windows_workstations']).toEqual({ bytes: 55_555_000, events: 40_000 });
    const totalIn = Object.values(w0.inputs).reduce((s, v) => s + v.bytes, 0);
    expect(totalIn).toBe(27_777_000 + 55_555_000 + 1_000 + 500); // no rollup double-count
    expect(result.inputTypes).toMatchObject({ 'default:mrd_payments_api': 'datagen', 'default:in_syslog': 'syslog', 'default:CriblMetrics': 'cribl' });
    expect(result.outputTypes).toEqual({ 'default:mrd_siem_prod': 'devnull', 'default:mrd_analytics': 'devnull' });
    expect(w0.outputs).toEqual({ 'default:mrd_siem_prod': { bytes: 6_944_000, events: 27_500 }, 'default:mrd_analytics': { bytes: 12_500_000, events: 9_000 } });
  });

  it('uses a variant sub-series only when its parent series is absent', async () => {
    const { result } = await run();
    const w0 = result.windows[0];
    expect(w0.inputs['default:in_syslog']).toEqual({ bytes: 1_000, events: 10 }); // not 2,000: :udp duplicates it
    expect(w0.inputs['default:in_syslog_tls']).toEqual({ bytes: 500, events: 5 }); // only the :tcp variant reported
  });

  it('treats missing aggregations and missing minutes as 0, keeping explicit zeros', async () => {
    const { result } = await run();
    expect(result.windows[0].inputs['default:CriblMetrics']).toEqual({ bytes: 0, events: 121_694 });
    expect(result.windows[0].inputs['default:in_tcp']).toEqual({ bytes: 0, events: 0 });
    expect(result.windows[1].inputs['default:mrd_windows_workstations']).toBeUndefined();
    expect(result.windows[1].inputs['default:mrd_payments_api']).toEqual({ bytes: 27_777_001, events: 55_001 });
  });

  it('keys routes by rule id, keeps a name-less route, drops the name rollup, and records names', async () => {
    const { result } = await run();
    const w0 = result.windows[0];
    expect(result.hasRouteBytes).toBe(true);
    expect(w0.routesIn).toEqual({
      'default:mrd_r_payments': { bytes: 27_777_000, events: 55_000 },
      'default:mrd_r_k8s': { bytes: 41_666_000, events: 30_000 },
      'default:default': { bytes: 0, events: 12 },
    });
    expect(w0.routesOut?.['default:mrd_r_payments']).toEqual({ bytes: 6_944_250, events: 27_500 });
    expect(result.routeNames).toEqual({ 'default:mrd_r_payments': 'payments_api', 'default:default': 'default' });
  });

  it('fetchMetricsWindows returns just the windows', async () => {
    const { http } = metricsHttp({ input: ok('metrics-inputs.synthetic'), output: ok('metrics-outputs.synthetic'), route: ok('metrics-routes.synthetic') });
    const windows = await fetchMetricsWindows(http, ['default'], T0, T0 + 180_000);
    expect(windows).toHaveLength(3);
    expect(windows[2].inputs['default:mrd_windows_workstations'].bytes).toBe(55_555_000);
  });

  it('resolves ids against the inventory when given one', async () => {
    const inventory: InventoryDoc = {
      schemaVersion: 1,
      updatedAt: iso(T0),
      hash: 'h',
      byGroup: { default: { inputs: [{ id: 'in_syslog', type: 'syslog' }], outputs: [{ id: 'mrd_siem_prod', type: 'devnull' }], pipelines: [], routes: [] } },
    };
    const { http } = metricsHttp({ input: ok('metrics-inputs.synthetic'), output: ok('metrics-outputs.synthetic') });
    const result = await fetchMetrics(http, ['default'], T0, T0 + 60_000, { inventory });
    expect(result.windows[0].inputs['default:in_syslog']).toEqual({ bytes: 1_000, events: 10 });
  });
});

describe('fetchMetrics on the live empty answer and on failures', () => {
  it('never throws on an empty result: every minute exists with zero series', async () => {
    const empty = fixture('metrics-empty');
    expect(empty.status).toBe(200);
    const { http } = metricsHttp({ input: ok('metrics-empty'), output: ok('metrics-empty'), route: ok('metrics-empty') });
    const result = await fetchMetrics(http, ['default'], T0, T0 + 600_000);
    expect(result.windows).toHaveLength(10);
    expect(result.windows.every((w) => Object.keys(w.inputs).length === 0 && Object.keys(w.outputs).length === 0)).toBe(true);
    expect(result.hasRouteBytes).toBe(false);
    expect(result.windows[0].routesIn).toEqual({});
    expect(result.windows[0].has).toEqual({ routeBytes: false, pipelineBytes: false });
  });

  it('tolerates bodies without results, junk rows and rows without a time', async () => {
    const junk: HttpResult = {
      status: 200,
      ok: true,
      json: { results: [null, 7, { __worker_group: 'default', input: 'x:y', inB: 5 }, { __worker_group: 'default', input: 'x:z', starttime: 'abc' }, { __worker_group: 'other', input: 'x:y', starttime: T0 / 1000, inB: 9 }, { __worker_group: 'default', input: 'x:y', starttime: String(T0 / 1000), inB: '12', inE: Number.NaN }] },
    };
    const { http } = metricsHttp({ input: junk, output: { status: 200, ok: true, text: 'not json' }, route: { status: 200, ok: true, json: [] } });
    const result = await fetchMetrics(http, ['default'], T0, T0 + 60_000);
    expect(result.windows[0].inputs).toEqual({ 'default:y': { bytes: 12, events: 0 } });
    expect(result.windows[0].outputs).toEqual({});
  });

  it('throws MetricsQueryError when the inputs or outputs query fails (abstain, never zero-fill)', async () => {
    const denied: HttpResult = { status: 403, ok: false, json: { status: 'error', message: 'Forbidden' } };
    const a = metricsHttp({ input: denied });
    const err = await fetchMetrics(a.http, ['default'], T0, T0 + 60_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetricsQueryError);
    expect(err).toMatchObject({ query: 'inputs', status: 403 });
    expect((err as Error).message).toMatch(/Forbidden/);
    const b = metricsHttp({ output: { status: 0, ok: false, text: 'timeout: no response' } });
    await expect(fetchMetrics(b.http, ['default'], T0, T0 + 60_000)).rejects.toMatchObject({ query: 'outputs', status: 0 });
    const c = metricsHttp({ output: { status: 500, ok: false } });
    await expect(fetchMetrics(c.http, ['default'], T0, T0 + 60_000)).rejects.toThrow(/HTTP 500$/);
  });

  it('a failed routes query only turns route bytes off', async () => {
    const { http } = metricsHttp({ input: ok('metrics-inputs.synthetic'), output: ok('metrics-outputs.synthetic'), route: { status: 500, ok: false, text: 'boom' } });
    const result = await fetchMetrics(http, ['default'], T0, T0 + 60_000);
    expect(result.hasRouteBytes).toBe(false);
    expect(result.errors).toEqual([{ query: 'routes', status: 500, message: 'boom' }]);
    expect(result.windows[0].routesIn).toBeUndefined();
    expect(result.windows[0].has.routeBytes).toBe(false);
  });

  it('route rows with events but no byte aggregations report routeBytes=false', async () => {
    const eventsOnly: HttpResult = { status: 200, ok: true, json: { results: [{ starttime: T0 / 1000, endtime: T0 / 1000 + 60, __worker_group: 'default', route: 'r1', inE: 5, outE: 4 }] } };
    const { http } = metricsHttp({ route: eventsOnly });
    const result = await fetchMetrics(http, ['default'], T0, T0 + 60_000);
    expect(result.hasRouteBytes).toBe(false);
    expect(result.windows[0].routesIn).toEqual({ 'default:r1': { bytes: 0, events: 5 } });
  });

  it('issues no call for an empty range or no groups', async () => {
    const { http, bodies } = metricsHttp({});
    expect((await fetchMetrics(http, ['default'], T0, T0 + 59_999)).windows).toEqual([]);
    expect((await fetchMetrics(http, [], T0, T0 + 600_000)).calls).toBe(0);
    expect(bodies).toHaveLength(0);
  });

  it('optionally queries pipeline events (never bytes) and passes a per-call timeout', async () => {
    const pipes: HttpResult = {
      status: 200,
      ok: true,
      json: {
        results: [
          { starttime: T0 / 1000, endtime: T0 / 1000 + 60, __worker_group: 'default', id: 'mrd_pay_sample', inE: 100, outE: 50 },
          { starttime: T0 / 1000, endtime: T0 / 1000 + 60, __worker_group: 'default', id: 'mrd_pay_sample', inE: 1, outE: 1 },
          { starttime: T0 / 1000, endtime: T0 / 1000 + 60, __worker_group: 'default', inE: 101, outE: 51 },
        ],
      },
    };
    const seen: unknown[] = [];
    const inner = metricsHttp({ id: pipes });
    const http: CriblHttp = {
      request: (m, p, b, o) => {
        seen.push(o);
        return inner.http.request(m, p, b, o);
      },
    };
    const result = await fetchMetrics(http, ['default'], T0, T0 + 60_000, { withPipelines: true, timeoutMs: 20_000 });
    expect(result.calls).toBe(4);
    expect(seen).toEqual(Array(4).fill({ timeoutMs: 20_000 }));
    expect(result.windows[0].pipelinesIn).toEqual({ 'default:mrd_pay_sample': { bytes: 0, events: 101 } });
    expect(result.windows[0].pipelinesOut).toEqual({ 'default:mrd_pay_sample': { bytes: 0, events: 51 } });
    expect(result.windows[0].has.pipelineBytes).toBe(false);

    const failing = metricsHttp({ id: { status: 404, ok: false, text: 'nope' } });
    const r2 = await fetchMetrics(failing.http, ['default'], T0, T0 + 60_000, { withPipelines: true });
    expect(r2.errors).toEqual([{ query: 'pipelines', status: 404, message: 'nope' }]);
    expect(r2.windows[0].pipelinesIn).toBeUndefined();
  });
});

describe('coarse buckets and backfill', () => {
  const C0 = 1790394000_000;

  it('spreads 600 s / 300 s buckets evenly over their minutes and flags them coarse; sums are exact', async () => {
    const { http, bodies } = metricsHttp({ input: ok('metrics-inputs-coarse.synthetic') });
    const result = await fetchMetrics(http, ['default'], C0, C0 + 3_600_000);
    expect(bodies).toHaveLength(3); // a one-hour backfill costs the same three queries
    expect(result.windows).toHaveLength(60);
    for (const w of result.windows) expect(w.inputs['default:mrd_payments_api']).toEqual({ bytes: 600, events: 6 });
    expect(result.windows.slice(0, 40).every((w) => w.coarse && w.bucketSeconds === 600)).toBe(true);
    expect(result.windows.slice(40, 50).every((w) => w.coarse && w.bucketSeconds === 300)).toBe(true);
    expect(result.windows.slice(50).every((w) => !w.coarse && w.bucketSeconds === 60)).toBe(true);
    expect(result.coarse).toBe(true);
    const total = result.windows.reduce((s, w) => s + w.inputs['default:mrd_payments_api'].bytes, 0);
    expect(total).toBe(4 * 6_000 + 2 * 3_000 + 10 * 600);
  });

  it('keeps integer counts when a bucket does not divide evenly, and clips to the requested range', async () => {
    const rows = { status: 200, ok: true, json: { results: [{ starttime: C0 / 1000, endtime: C0 / 1000 + 300, __worker_group: 'default', input: 'd:x', inB: 1_001, inE: 7 }] } };
    const { http } = metricsHttp({ input: rows });
    const all = await fetchMetrics(http, ['default'], C0, C0 + 300_000);
    expect(all.windows.map((w) => w.inputs['default:x'].bytes)).toEqual([201, 200, 200, 200, 200]);
    expect(all.windows.map((w) => w.inputs['default:x'].events)).toEqual([2, 2, 1, 1, 1]);
    const clipped = await fetchMetrics(http, ['default'], C0 + 120_000, C0 + 240_000);
    expect(clipped.windows.map((w) => w.inputs['default:x'].bytes)).toEqual([501, 500]);
    const outside = await fetchMetrics(http, ['default'], C0 + 600_000, C0 + 660_000);
    expect(outside.windows[0].inputs).toEqual({});
  });

  it('uses info.timeWindowSeconds as the declared width for rows without endtime', async () => {
    const rows = { status: 200, ok: true, json: { results: [{ starttime: C0 / 1000, __worker_group: 'default', input: 'd:x', inB: 300, inE: 3 }], info: { timeWindowSeconds: 180 } } };
    const { http } = metricsHttp({ input: rows });
    const r = await fetchMetrics(http, ['default'], C0, C0 + 180_000);
    expect(r.windows.map((w) => [w.inputs['default:x'].bytes, w.coarse, w.bucketSeconds])).toEqual([
      [100, true, 180],
      [100, true, 180],
      [100, true, 180],
    ]);
  });

  it('adds up sub-minute buckets within their minute', async () => {
    const rows = {
      status: 200,
      ok: true,
      json: { results: [0, 30].map((o) => ({ starttime: C0 / 1000 + o, endtime: C0 / 1000 + o + 30, __worker_group: 'default', output: 'devnull:o', outB: 10, outE: 1 })) },
    };
    const { http } = metricsHttp({ output: rows });
    const r = await fetchMetrics(http, ['default'], C0, C0 + 60_000, { timeWindowSeconds: 30 });
    expect(r.windows[0].outputs['default:o']).toEqual({ bytes: 20, events: 2 });
    expect(r.windows[0].coarse).toBe(false);
  });
});

describe('inferBucketWidths', () => {
  const m = (entries: [number, number][]) => new Map(entries);
  it('widens a steady coarser spacing, including the last bucket of the run', () => {
    const eff = inferBucketWidths(m([[0, 300], [600, 300], [1200, 300], [1800, 300]]));
    expect([...eff.values()]).toEqual([600, 600, 600, 600]);
  });
  it('widens rows that claim 60 s but arrive every 300 s', () => {
    const eff = inferBucketWidths(m([[0, 60], [300, 60], [600, 60], [660, 60], [720, 60]]));
    expect([...eff.values()]).toEqual([300, 300, 60, 60, 60]);
  });
  it('does not widen an isolated gap in per-minute data or a misaligned start', () => {
    expect([...inferBucketWidths(m([[0, 60], [60, 60], [360, 60], [420, 60]])).values()]).toEqual([60, 60, 60, 60]);
    expect([...inferBucketWidths(m([[60, 60], [660, 60], [1260, 60]])).values()]).toEqual([60, 60, 60]);
    expect([...inferBucketWidths(m([[0, 60]])).values()]).toEqual([60]);
  });
});
