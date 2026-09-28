// tests/unit/gen.test.ts — the synthetic Cribl estate (testdata/gen.ts, testdata/scale.ts).
//
// The generator is the ground truth every other suite leans on, so it is held to the platform facts
// in docs/platform/metrics.md and version.md: determinism, row shapes, rollup rows, omitted
// aggregations, missing series, 3-part syslog keys, host splits, git log/show/files shapes, and the
// demo rig's economics (PRD 9.1) including the S15 break-the-trim script.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { MetricsWindow } from '../../core/types.ts';
import {
  DAY_MS,
  DEFAULT_END,
  DEMO_TAG,
  GB,
  GitApiError,
  HOUR_MS,
  MINUTE_MS,
  MetricsQueryError,
  RIG,
  RigRefusal,
  TRIM_TAG,
  buildCommit,
  commitSummary,
  deployEffects,
  demoRigWorld,
  diffFile,
  expectedMetricsWindow,
  flattenGitFiles,
  flowMinute,
  flowSeries,
  flowTotals,
  gitFiles,
  gitLog,
  gitShow,
  hashHex40,
  inventoryFromConfig,
  mergeGroupConfig,
  metricsEnum,
  metricsQuery,
  pipelineFile,
  rigApplyPack,
  rigBreakTrim,
  rigConfigObjects,
  rigFlowState,
  rigRestoreTrim,
  rigRevertPack,
  rigSetRate,
  routesFile,
  splitInteger,
  syntheticWorld,
  toInventoryDoc,
  toYaml,
  unit,
  type MetricsRow,
  type World,
} from '../../testdata/gen.ts';
import { SCALE_DEFAULTS, anomalyWindows, dailyVolume, estateSummary, minutes, scaleWorld } from '../../testdata/scale.ts';

// ─── helpers ─────────────────────────────────────────────────────────────────
const NOW = Date.UTC(2026, 8, 26, 12, 0, 0); // a Saturday, noon UTC
const bytesQuery = (metric: string, alias: string, splitBys: string[], extra: Record<string, unknown> = {}) => ({
  aggs: { aggregations: [`sum("${metric}").as("${alias}")`], splitBys, timeWindowSeconds: 60 },
  ...extra,
});
const isSplitRow = (row: MetricsRow, keys: string[]): boolean => keys.every((k) => typeof row[k] === 'string');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
/** `type:id[:protocol]` → id (the rule an adapter uses to fold protocol variants). */
const idOf = (dim: string): string => dim.split(':')[1];

/**
 * A reference adapter: the documented parsing rules (drop rollups = keep rows whose every split key
 * is a string; fold 3-part keys; sum hosts and buckets) applied to the generator's own rows. The
 * oracle `expectedMetricsWindow` is computed independently from flow minutes, so agreement proves
 * the engine's rows carry exactly the right totals.
 */
function parseWindow(world: World, start: number, end: number, now: number): MetricsWindow {
  const w: MetricsWindow = { windowStart: new Date(start).toISOString(), windowEnd: new Date(end).toISOString(), inputs: {}, outputs: {}, routesIn: {}, routesOut: {}, pipelinesIn: {}, pipelinesOut: {}, has: { routeBytes: true, pipelineBytes: false } };
  const run = (aggs: string[], dim: string, into: (row: MetricsRow, key: string) => void): void => {
    const { results } = metricsQuery(world, { earliest: start, latest: end, aggs: { aggregations: aggs, splitBys: [dim, '__worker_group'], timeWindowSeconds: 60 } }, { now });
    for (const row of results) if (isSplitRow(row, [dim, '__worker_group'])) into(row, `${row.__worker_group}:${dim === 'input' || dim === 'output' ? idOf(String(row[dim])) : row[dim]}`);
  };
  const bump = (rec: Record<string, { bytes: number; events: number }>, key: string, b: number, e: number): void => {
    const cur = rec[key] ?? (rec[key] = { bytes: 0, events: 0 });
    cur.bytes += b;
    cur.events += e;
  };
  run(['sum("total.in_bytes").as("b")', 'sum("total.in_events").as("e")'], 'input', (r, k) => bump(w.inputs, k, num(r.b), num(r.e)));
  run(['sum("total.out_bytes").as("b")', 'sum("total.out_events").as("e")'], 'output', (r, k) => bump(w.outputs, k, num(r.b), num(r.e)));
  run(['sum("route.in_bytes").as("ib")', 'sum("route.in_events").as("ie")', 'sum("route.out_bytes").as("ob")', 'sum("route.out_events").as("oe")'], 'route', (r, k) => {
    bump(w.routesIn!, k, num(r.ib), num(r.ie));
    bump(w.routesOut!, k, num(r.ob), num(r.oe));
  });
  run(['sum("pipe.in_events").as("ie")', 'sum("pipe.out_events").as("oe")'], 'id', (r, k) => {
    bump(w.pipelinesIn!, k, 0, num(r.ie));
    bump(w.pipelinesOut!, k, 0, num(r.oe));
  });
  return w;
}

// Worlds are pure data; building them once per file keeps the suite fast.
const synth = syntheticWorld({ seed: 7, flows: 60, groups: 2, days: 5, end: NOW, hostsPerGroup: 2, processesPerHost: 2 });
const rig = demoRigWorld({ now: NOW });

// ─── primitives ──────────────────────────────────────────────────────────────
describe('primitives', () => {
  it('splitInteger always sums exactly and never goes negative', () => {
    fc.assert(
      fc.property(fc.nat(10_000_000_000), fc.array(fc.double({ min: 0.01, max: 10, noNaN: true }), { minLength: 1, maxLength: 12 }), (total, weights) => {
        const parts = splitInteger(total, weights);
        expect(parts).toHaveLength(weights.length);
        expect(parts.reduce((s, x) => s + x, 0)).toBe(total);
        expect(parts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
      }),
    );
  });

  it('unit() is a pure, uniform-looking function of its arguments', () => {
    expect(unit(1, 2, 3)).toBe(unit(1, 2, 3));
    expect(unit(1, 2, 3)).not.toBe(unit(3, 2, 1));
    const xs = Array.from({ length: 5000 }, (_, i) => unit(9, i));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it('hashHex40 looks like a SHA-1 and is stable', () => {
    expect(hashHex40('x')).toMatch(/^[0-9a-f]{40}$/);
    expect(hashHex40('x')).toBe(hashHex40('x'));
    expect(hashHex40('x')).not.toBe(hashHex40('y'));
  });
});

// ─── determinism ─────────────────────────────────────────────────────────────
describe('determinism', () => {
  const body = bytesQuery('total.in_bytes', 'inB', ['input'], { earliest: NOW - 20 * MINUTE_MS, latest: NOW });

  it('the same seed reproduces worlds and query results exactly', () => {
    const again = syntheticWorld({ seed: 7, flows: 60, groups: 2, days: 5, end: NOW, hostsPerGroup: 2, processesPerHost: 2 });
    expect(again.flows).toEqual(synth.flows);
    expect(again.commits).toEqual(synth.commits);
    expect(metricsQuery(again, body, { now: NOW })).toEqual(metricsQuery(synth, body, { now: NOW }));
  });

  it('a different seed produces different numbers', () => {
    const other = syntheticWorld({ seed: 8, flows: 60, groups: 2, days: 5, end: NOW });
    expect(metricsQuery(other, body, { now: NOW })).not.toEqual(metricsQuery(synth, body, { now: NOW }));
  });

  it('values depend on time only: two adjacent ranges equal one range covering both', () => {
    const q = (a: number, b: number) =>
      metricsQuery(synth, bytesQuery('route.out_bytes', 'outB', ['route'], { earliest: a, latest: b }), { now: NOW }).results;
    const whole = q(NOW - 30 * MINUTE_MS, NOW);
    const parts = [...q(NOW - 30 * MINUTE_MS, NOW - 12 * MINUTE_MS), ...q(NOW - 12 * MINUTE_MS, NOW)];
    const sortKey = (r: MetricsRow) => `${r.starttime}|${r.route ?? ''}`;
    expect([...parts].sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : 1))).toEqual([...whole].sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : 1)));
  });

  it('flowMinute is independent of evaluation order', () => {
    const f = synth.flows[3];
    const forward = flowSeries(synth, f.id, NOW - 10 * MINUTE_MS, NOW);
    const fresh = syntheticWorld({ seed: 7, flows: 60, groups: 2, days: 5, end: NOW, hostsPerGroup: 2, processesPerHost: 2 });
    const backward = [...Array(10).keys()].reverse().map((k) => flowMinute(fresh, fresh.flows[3], NOW - (10 - k) * MINUTE_MS)).reverse();
    expect(backward).toEqual(forward);
  });
});

// ─── metrics row shapes ──────────────────────────────────────────────────────
describe('metricsQuery: row shapes (docs/platform/metrics.md §5)', () => {
  it('bucketed rows carry epoch-second, width-aligned starttime/endtime and no _time', () => {
    for (const width of [60, 300, 3600]) {
      const { results } = metricsQuery(synth, { earliest: NOW - 3 * HOUR_MS, latest: NOW, aggs: { aggregations: ['sum("total.out_bytes").as("outB")'], splitBys: ['output'], timeWindowSeconds: width } }, { now: NOW });
      expect(results.length).toBeGreaterThan(0);
      for (const row of results) {
        expect(row).not.toHaveProperty('_time');
        expect(Number.isInteger(row.starttime)).toBe(true);
        expect(row.starttime as number).toBeLessThan(1e11); // seconds, not ms
        expect((row.starttime as number) % width).toBe(0);
        expect((row.endtime as number) - (row.starttime as number)).toBe(width);
      }
    }
  });

  it('answers in the live envelope: results + engine metrics + info', () => {
    const r = metricsQuery(rig, { earliest: NOW - 2 * MINUTE_MS, latest: NOW, aggs: { aggregations: ['sum("total.in_bytes").as("b")', 'sum("total.in_events").as("e")'], splitBys: ['__worker_group', 'input'], timeWindowSeconds: 60 } }, { now: NOW });
    expect(Object.keys(r).sort()).toEqual(['info', 'metrics', 'results']);
    expect(r.info).toEqual({ timeWindowSeconds: 60 });
    expect(r.metrics['metrics_aggregator.results']).toBe(r.results.length);
    expect(Object.keys(r.metrics).sort()).toEqual([
      'metrics_aggregator.execution_time',
      'metrics_aggregator.referenced_metrics',
      'metrics_aggregator.results',
      'metrics_reader.execution_time',
      'metrics_reader.invalid_series',
      'metrics_reader.matched',
    ]);
    const cum = metricsQuery(rig, { earliest: NOW - 2 * MINUTE_MS, latest: NOW, aggs: { aggregations: ['sum("total.in_bytes").as("b")'], cumulative: true } }, { now: NOW });
    expect(cum.info).toEqual({ cumulative: true });
  });

  it('cumulative queries return one row per split value with _time', () => {
    const { results } = metricsQuery(rig, { earliest: NOW - 10 * MINUTE_MS, latest: NOW, aggs: { aggregations: ['sum("route.in_bytes").as("inB")'], splitBys: ['route'], cumulative: true } }, { now: NOW });
    const split = results.filter((r) => typeof r.route === 'string');
    expect(split).toHaveLength(RIG.sources.length);
    for (const r of results) {
      expect(r._time).toBe(NOW / 1000);
      expect(r).not.toHaveProperty('starttime');
    }
  });

  it('min(_time)/max(_time) aliases report the data span in seconds', () => {
    const { results } = metricsQuery(rig, { earliest: NOW - 10 * MINUTE_MS, latest: NOW, aggs: { aggregations: ['min(_time).as(starttime)', 'max(_time).as(endtime)', 'sum("total.in_bytes").as("b")'], splitBys: ['input'], cumulative: true } }, { now: NOW });
    const row = results.find((r) => r.input === 'datagen:mrd_payments_api')!;
    expect(row.starttime).toBe((NOW - 10 * MINUTE_MS) / 1000);
    expect(row.endtime).toBe((NOW - MINUTE_MS) / 1000);
  });

  it('rollup rows lack the split key and repeat the sum of the split rows (summing everything doubles)', () => {
    const { results } = metricsQuery(synth, bytesQuery('total.in_bytes', 'inB', ['input'], { where: "__worker_group=='default'", earliest: NOW - 5 * MINUTE_MS, latest: NOW }), { now: NOW });
    const byBucket = new Map<number, MetricsRow[]>();
    for (const r of results) byBucket.set(r.starttime as number, [...(byBucket.get(r.starttime as number) ?? []), r]);
    expect(byBucket.size).toBe(5);
    for (const rows of byBucket.values()) {
      const rollups = rows.filter((r) => !('input' in r));
      expect(rollups).toHaveLength(1);
      const split = rows.filter((r) => typeof r.input === 'string').reduce((s, r) => s + num(r.inB), 0);
      expect(rollups[0].inB).toBe(split);
      expect(rows.reduce((s, r) => s + num(r.inB), 0)).toBe(2 * split);
    }
  });

  it('a two-dimension split yields per-host rollup rows that omit the other key', () => {
    const { results } = metricsQuery(synth, bytesQuery('total.in_bytes', 'inB', ['input', '__worker_node_hostname'], { where: "__worker_group=='default'", earliest: NOW - MINUTE_MS, latest: NOW }), { now: NOW });
    const hosts = synth.hosts.default;
    const rollups = results.filter((r) => !('input' in r));
    expect(rollups.map((r) => r.__worker_node_hostname).sort()).toEqual([...hosts].sort());
    for (const host of hosts) {
      const split = results.filter((r) => r.__worker_node_hostname === host && typeof r.input === 'string').reduce((s, r) => s + num(r.inB), 0);
      expect(rollups.find((r) => r.__worker_node_hostname === host)!.inB).toBe(split);
    }
  });

  it('splitting by cribl_wp (not a dimension) returns unsplit rows without the key', () => {
    const { results } = metricsQuery(rig, bytesQuery('total.in_bytes', 'inB', ['cribl_wp'], { earliest: NOW - 2 * MINUTE_MS, latest: NOW }), { now: NOW });
    expect(results).toHaveLength(2); // one per bucket
    for (const r of results) expect(r).not.toHaveProperty('cribl_wp');
  });

  it('an aggregation with no data is omitted from the row, never reported as 0', () => {
    const { results } = metricsQuery(rig, { earliest: NOW - MINUTE_MS, latest: NOW, aggs: { aggregations: ['sum("total.in_bytes").as("inB")', 'max("health.inputs").as("health")'], splitBys: ['input'], timeWindowSeconds: 60 } }, { now: NOW });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r).not.toHaveProperty('health');
    const onlyUnknown = metricsQuery(rig, { earliest: NOW - MINUTE_MS, latest: NOW, aggs: { aggregations: ['max("pq.queue_size").as("pq")'], splitBys: ['output'], timeWindowSeconds: 60 } }, { now: NOW });
    expect(onlyUnknown.results).toEqual([]);
  });

  it('configured-but-idle inputs report explicit zero rows; disabled inputs report nothing', () => {
    const { results } = metricsQuery(synth, bytesQuery('total.in_bytes', 'inB', ['input'], { earliest: NOW - MINUTE_MS, latest: NOW }), { now: NOW });
    const idle = results.filter((r) => r.input === 'tcp:in_idle_default');
    expect(idle).toHaveLength(1);
    expect(idle[0].inB).toBe(0);
    expect(results.some((r) => String(r.input).includes('in_disabled_default'))).toBe(false);
  });

  it('missing series: a quiet source is simply absent in some minutes (zero is not reported)', () => {
    const quiet = synth.flows.find((f) => f.shape === 'quiet')!;
    const series = flowSeries(synth, quiet.id, NOW - 60 * MINUTE_MS, NOW);
    const gap = series.find((m) => !m.present)!;
    expect(gap).toBeDefined();
    const { results } = metricsQuery(synth, bytesQuery('total.in_bytes', 'inB', ['input'], { earliest: gap.t, latest: gap.t + MINUTE_MS }), { now: NOW });
    expect(results.some((r) => String(r.input).includes(quiet.inputId))).toBe(false);
  });

  it('syslog inputs surface as 3-part protocol keys that must be folded and summed', () => {
    const syslog = synth.flows.find((f) => f.inputType === 'syslog' && f.shape !== 'quiet')!;
    const { results } = metricsQuery(synth, bytesQuery('total.in_bytes', 'inB', ['input'], { earliest: NOW - MINUTE_MS, latest: NOW }), { now: NOW });
    const keys = results.map((r) => r.input).filter((k) => typeof k === 'string' && idOf(k) === syslog.inputId);
    expect(keys.sort()).toEqual([`syslog:${syslog.inputId}:tcp`, `syslog:${syslog.inputId}:udp`]);
    const folded = results.filter((r) => typeof r.input === 'string' && idOf(r.input) === syslog.inputId).reduce((s, r) => s + num(r.inB), 0);
    expect(folded).toBe(flowMinute(synth, syslog, NOW - MINUTE_MS).srcB);
  });

  it('pipelines report events only; asking for pipe bytes returns no rows', () => {
    const { results } = metricsQuery(rig, bytesQuery('pipe.in_bytes', 'b', ['id'], { earliest: NOW - MINUTE_MS, latest: NOW }), { now: NOW });
    expect(results).toEqual([]);
  });
});

// ─── sums: the reference adapter reproduces the oracle ───────────────────────
describe('sums', () => {
  it('rows parsed by the documented rules equal the independent oracle (multi-group, hosts × processes)', () => {
    const start = NOW - 7 * MINUTE_MS;
    const end = NOW - 2 * MINUTE_MS;
    expect(parseWindow(synth, start, end, NOW)).toEqual(expectedMetricsWindow(synth, start, end));
  });

  it('the same holds for the demo rig across the break-the-trim script', () => {
    const breakAt = NOW - 20 * MINUTE_MS;
    const world = demoRigWorld({ now: NOW, script: { breakAt, withPacks: true } });
    expect(parseWindow(world, breakAt - 5 * MINUTE_MS, breakAt + 5 * MINUTE_MS, NOW)).toEqual(expectedMetricsWindow(world, breakAt - 5 * MINUTE_MS, breakAt + 5 * MINUTE_MS));
  });

  it('per-part values sum to the flow total for every metric (hosts × processes)', () => {
    const f = synth.flows.find((x) => x.shape === 'flat' && x.inputType !== 'syslog')!;
    const m = flowMinute(synth, f, NOW - MINUTE_MS);
    const { results } = metricsQuery(
      synth,
      { where: `route=='${f.routeId}'`, earliest: NOW - MINUTE_MS, latest: NOW, aggs: { aggregations: ['sum("route.in_bytes").as("ib")', 'sum("route.out_bytes").as("ob")', 'sum("route.in_events").as("ie")', 'sum("route.out_events").as("oe")', 'sum("route.dropped_events").as("de")'], splitBys: ['route', '__worker_node_hostname'], timeWindowSeconds: 60 } },
      { now: NOW },
    );
    expect(results).toHaveLength(synth.hosts[f.groupId].length);
    const total = (k: string) => results.reduce((s, r) => s + num(r[k]), 0);
    expect([total('ib'), total('ob'), total('ie'), total('oe'), total('de')]).toEqual([m.inB, m.outB, m.inE, m.outE, m.inE - m.outE]);
  });

  it('host-agnostic and group-pinned shortcuts answer exactly what the full per-host computation does', () => {
    const range = { earliest: NOW - 4 * MINUTE_MS, latest: NOW };
    const q = (splitBys: string[], where?: string) =>
      metricsQuery(synth, { ...range, ...(where ? { where } : {}), aggs: { aggregations: ['sum("route.in_bytes").as("b")', 'sum("total.in_events").as("e")'], splitBys, timeWindowSeconds: 60 } }, { now: NOW }).results;
    const fold = (rows: MetricsRow[], keys: string[]) => {
      const out: Record<string, { b: number; e: number }> = {};
      for (const r of rows) {
        const k = `${r.starttime}|${keys.map((x) => r[x] ?? '-').join('|')}`;
        const cur = out[k] ?? (out[k] = { b: 0, e: 0 });
        cur.b += num(r.b);
        cur.e += num(r.e);
      }
      return out;
    };
    // per-host rows, summed over hosts, equal the host-agnostic rows (rollups included)
    expect(fold(q(['input', '__worker_group', '__worker_node_hostname']), ['input', '__worker_group'])).toEqual(fold(q(['input', '__worker_group']), ['input', '__worker_group']));
    // pinning a group equals filtering the unpinned answer
    const pinned = q(['route', '__worker_group'], "__worker_group == 'wg_east'");
    const all = q(['route', '__worker_group']).filter((r) => r.__worker_group === 'wg_east');
    expect(fold(pinned, ['route', '__worker_group'])).toEqual(fold(all, ['route', '__worker_group']));
    // a disjunction is never pinned
    expect(q(['__worker_group'], "__worker_group == 'wg_east' || __worker_group == 'default'").map((r) => r.__worker_group).sort()).toEqual(['default', 'default', 'default', 'default', 'wg_east', 'wg_east', 'wg_east', 'wg_east']);
  });

  it('flowTotals equals the sum of flowSeries minutes', () => {
    const f = synth.flows[0];
    const t = flowTotals(synth, f.id, NOW - HOUR_MS, NOW);
    const s = flowSeries(synth, f.id, NOW - HOUR_MS, NOW).filter((m) => m.present);
    expect(t.minutes).toBe(s.length);
    expect(t.inB).toBe(s.reduce((a, m) => a + m.inB, 0));
    expect(t.outB).toBe(s.reduce((a, m) => a + m.outB, 0));
  });
});

// ─── time bounds, filters, validation ────────────────────────────────────────
describe('metricsQuery: time, where and validation', () => {
  const q = (body: Record<string, unknown>, opts: { now: number; retentionMs?: number } = { now: NOW }) => metricsQuery(rig, body, opts).results;
  const aggs = { aggregations: ['sum("total.in_bytes").as("b")'], splitBys: ['input'], timeWindowSeconds: 60 };

  it('relative time strings like -1h answer an empty 200, as the live Leader does', () => {
    expect(q({ earliest: '-1h', latest: 'now', aggs })).toEqual([]);
  });

  it('accepts epoch ms numbers, numeric strings and the "<n>s" relative form', () => {
    const a = q({ earliest: NOW - 5 * MINUTE_MS, latest: NOW, aggs });
    expect(q({ earliest: String(NOW - 5 * MINUTE_MS), latest: String(NOW), aggs })).toEqual(a);
    expect(q({ earliest: '300s', latest: NOW, aggs })).toEqual(a);
  });

  it('only completed minutes before now exist, and retention hides old data', () => {
    const now = NOW + 30_000; // half-way through a minute
    const rows = q({ earliest: NOW - 2 * MINUTE_MS, latest: now + 5 * MINUTE_MS, aggs }, { now });
    expect(Math.max(...rows.map((r) => r.starttime as number))).toBe((NOW - MINUTE_MS) / 1000);
    expect(q({ earliest: NOW - 3 * DAY_MS, latest: NOW - 2 * DAY_MS, aggs }, { now: NOW, retentionMs: DAY_MS })).toEqual([]);
  });

  it('no data before the rig was applied', () => {
    expect(q({ earliest: rig.start - 10 * MINUTE_MS, latest: rig.start, aggs })).toEqual(expect.not.arrayContaining([expect.objectContaining({ input: 'datagen:mrd_payments_api' })]));
  });

  it('where supports ==, !=, &&, ||, !, parentheses, has_no_dimensions and string methods', () => {
    const base = { earliest: NOW - MINUTE_MS, latest: NOW };
    const inputs = (where: string) =>
      metricsQuery(synth, { ...base, where, aggs }, { now: NOW }).results.map((r) => (r.input as string | undefined) ?? '(rollup)').sort();
    const all = inputs('true');
    const east = new Set(synth.config.wg_east.inputs.map((i) => i.id));
    const eastRows = inputs("__worker_group=='wg_east'");
    expect(eastRows.length).toBeGreaterThan(1);
    expect(eastRows.every((k) => k === '(rollup)' || east.has(idOf(k)))).toBe(true);
    // Split only by input, the two groups' rollups share the (missing) key and merge into one row;
    // adding __worker_group to the split separates them, as criblvision's per-group totals rely on.
    expect(inputs('has_no_dimensions')).toEqual(['(rollup)']);
    const perGroup = metricsQuery(synth, { ...base, where: 'has_no_dimensions', aggs: { ...aggs, splitBys: ['__worker_group'] } }, { now: NOW }).results;
    expect(perGroup.map((r) => r.__worker_group).sort()).toEqual(['default', 'wg_east']);
    expect(inputs("input.startsWith('syslog:')").every((k) => k.startsWith('syslog:'))).toBe(true);
    expect(inputs("(input.startsWith('syslog:') || input.startsWith('kafka:')) && !input.endsWith(':udp')").every((k) => (k.startsWith('syslog:') && k.endsWith(':tcp')) || k.startsWith('kafka:'))).toBe(true);
    // JavaScript semantics: a missing dimension is undefined, and undefined != 'x' — rollups pass too.
    expect(inputs("input != 'x'")).toEqual(all);
    expect(inputs("input == 'x'")).toEqual([]);
  });

  it('rejects malformed bodies with a 400', () => {
    const bad = (body: Record<string, unknown>) => () => metricsQuery(rig, body, { now: NOW });
    expect(bad({ aggs: { splitBys: ['input'], timeWindowSeconds: 60 } })).toThrow(MetricsQueryError);
    expect(bad({ aggs: { aggregations: ['sum("x")'], splitBys: ['input'] } })).toThrow(/timeWindowSeconds/);
    expect(bad({ aggs: { aggregations: ['bogus(x)'], timeWindowSeconds: 60 } })).toThrow(/invalid aggregation/);
    expect(bad({ where: "input =~ 'x'", aggs })).toThrow(MetricsQueryError);
    try {
      metricsQuery(rig, { where: 'input.match(/x/)', aggs }, { now: NOW });
    } catch (e) {
      expect((e as MetricsQueryError).status).toBe(400);
    }
  });

  it('metricsEnum lists metric names and dimension values', () => {
    const e = metricsEnum(rig, { metricNameFilter: '^route\\.', maxValues: 50 });
    expect(e.items.map((i) => i.name)).toEqual(['route.in_bytes', 'route.out_bytes', 'route.in_events', 'route.out_events', 'route.dropped_events']);
    const route = e.items[0].dims.find((d) => d.name === 'route')!;
    expect(route.values).toEqual(RIG.sources.map((s) => s.routeId).sort());
    const inputs = metricsEnum(rig, { metricNameFilter: ['total.in_bytes'], dimKeyFilter: '^input$' }).items[0].dims[0];
    expect(inputs.values).toContain('datagen:mrd_payments_api');
  });
});

// ─── shapes over time: diurnal, weekend, anomalies ───────────────────────────
describe('synthetic estate behaviour', () => {
  it('diurnal sources peak mid-afternoon UTC and dip at weekends', () => {
    const f = synth.flows.find((x) => x.shape === 'diurnal')!;
    const wed = Date.UTC(2026, 8, 23); // Wednesday
    const sat = Date.UTC(2026, 8, 26);
    const hourSum = (day: number, hour: number) => flowTotals(synth, f.id, day + hour * HOUR_MS, day + (hour + 1) * HOUR_MS).srcB;
    expect(hourSum(wed, 15 - Math.round(f.phaseHours))).toBeGreaterThan(hourSum(wed, 3 - Math.round(f.phaseHours)));
    expect(hourSum(sat, 3)).toBeLessThan(hourSum(Date.UTC(2026, 8, 24), 3)); // Sat vs Thu, same hour
  });

  it('injected spikes, regressions, recoveries and outages are visible in the series', () => {
    const w = syntheticWorld({ seed: 11, flows: 200, days: 10, end: NOW });
    expect(w.anomalies.filter((a) => a.kind === 'spike').length).toBeGreaterThan(0);
    for (const a of w.anomalies) {
      const flow = w.flows.find((f) => f.id === a.flowId)!;
      const before = flowMinute(w, flow, a.start - 5 * MINUTE_MS);
      const during = flowMinute(w, flow, a.start + MINUTE_MS);
      if (a.kind === 'outage') {
        expect(during.present).toBe(false);
        expect(flowMinute(w, flow, a.end!).present || flow.shape === 'quiet').toBe(true);
      } else if (a.kind === 'spike' && during.present && before.present && flow.shape !== 'bursty') {
        expect(during.srcB / before.srcB).toBeGreaterThan(a.multiplier! * 0.35);
      } else if (a.kind === 'regression' && during.present) {
        expect(during.ratio).toBeLessThan(a.before! - 0.1);
        if (a.end !== undefined) expect(flowMinute(w, flow, a.end + MINUTE_MS).ratio).toBeGreaterThan(a.after! + 0.1);
      }
    }
  });

  it('regressions with a commit have one touching the flow’s pipeline within 30 min; those without have none within 45', () => {
    const w = syntheticWorld({ seed: 12, flows: 300, days: 10, end: NOW, anomalies: { regressionsWithCommit: 4, regressionsWithoutCommit: 4, benignCommits: 40 } });
    const regs = w.anomalies.filter((a) => a.kind === 'regression');
    expect(regs).toHaveLength(8);
    for (const a of regs) {
      const flow = w.flows.find((f) => f.id === a.flowId)!;
      const window = w.commits.filter((c) => c.at <= a.start && c.at >= a.start - (a.withCommit ? 30 : 45) * MINUTE_MS);
      if (a.withCommit) {
        const c = w.commits.find((x) => x.hash === a.commitHash)!;
        expect(window).toContain(c);
        expect(c.files).toEqual([pipelineFile(flow.groupId, flow.pipelineId)]);
      } else expect(window).toEqual([]);
    }
  });

  it('builds InventoryDoc in the core shape, stable per config', () => {
    const inv = toInventoryDoc(synth, NOW);
    expect(inv.schemaVersion).toBe(1);
    expect(Object.keys(inv.byGroup).sort()).toEqual(['default', 'wg_east']);
    const g = inv.byGroup.default;
    expect(g.routeTableId).toBe('default');
    expect(g.routes.at(-1)).toMatchObject({ id: 'default', filter: 'true', final: true });
    expect(g.routes[0].filter).toMatch(/^__inputId==/);
    expect(g.outputs.find((o) => o.id === 'default')).toMatchObject({ type: 'default', defaultId: 'devnull' });
    expect(g.inputs.find((i) => i.id === 'in_disabled_default')?.disabled).toBe(true);
    expect(Object.values(inv.byGroup).some((grp) => grp.routes.some((r) => r.filter.includes('sourcetype')))).toBe(true); // route-only attribution case
    expect(toInventoryDoc(synth, NOW).hash).toBe(inv.hash);
    const changed = inventoryFromConfig({ ...synth.config, default: { ...synth.config.default, routes: { id: 'default', routes: [] } } }, 'x');
    expect(changed.hash).not.toBe(inv.hash);
  });
});

// ─── git shapes ──────────────────────────────────────────────────────────────
describe('git: /version, /version/show, /version/files', () => {
  const breakAt = NOW - 20 * MINUTE_MS;
  const world = demoRigWorld({ now: NOW, script: { breakAt, withPacks: true } });

  it('log rows: 40-hex hash, "YYYY-MM-DD HH:MM:SS +0000" dates, newest first, HEAD ref only on the newest', () => {
    const log = gitLog(world.commits, { groupId: 'default', count: 50 });
    expect(log).not.toHaveProperty('totalCount');
    expect(log.count).toBe(log.items.length);
    for (const row of log.items) {
      expect(Object.keys(row).sort()).toEqual(['author_email', 'author_name', 'body', 'date', 'hash', 'message', 'refs']);
      expect(row.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(row.date).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \+0000$/);
      expect(row.body).toBe('');
    }
    const times = log.items.map((r) => Date.parse(r.date.replace(' ', 'T').replace(' +0000', 'Z')));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(log.items.map((r) => r.refs)).toEqual(['HEAD -> master', ...Array(log.items.length - 1).fill('')]);
    expect(log.items[0].message).toBe('demo: break the trim on mrd_pay_sample');
  });

  it('paging follows the measured rules', () => {
    expect(() => gitLog(world.commits, { limit: 2 })).toThrow(GitApiError);
    try {
      gitLog(world.commits, { limit: 2 });
    } catch (e) {
      expect((e as GitApiError).status).toBe(400);
      expect((e as Error).message).toBe("missing 'offset' parameter, 'offset' is required when 'limit' is provided");
    }
    const page = gitLog(world.commits, { offset: 1, limit: 2 });
    expect(page).toMatchObject({ count: 2, offset: 1, limit: 2, totalCount: world.commits.length });
    expect(gitLog(world.commits, { count: 2 }).items).toHaveLength(2);
    expect(gitLog(world.commits, { groupId: 'default_search' }).items).toEqual([]);
  });

  it('show: URL-encoded git-show header and diffJson items with the required fields', () => {
    const head = gitLog(world.commits, { count: 1 }).items[0];
    const show = gitShow(world.commits, head.hash.slice(0, 7), 'default');
    expect(show.count).toBe(1);
    const header = decodeURIComponent(show.items[0].commitMessage);
    expect(header).toMatch(new RegExp(`^commit ${head.hash}\\nAuthor: Steve Koelpin <s\\.koelpin@example\\.com>\\nDate:   \\w{3} \\w{3} \\d+ \\d\\d:\\d\\d:\\d\\d \\d{4} \\+0000\\n\\n    demo: break the trim on mrd_pay_sample\\n$`));
    const [d] = show.items[0].diffJson;
    for (const k of ['addedLines', 'blocks', 'deletedLines', 'isCombined', 'isGitDiff', 'language', 'newName', 'oldName']) expect(d).toHaveProperty(k);
    expect(d.newName).toBe(pipelineFile('default', RIG.pipelines.paySample));
    const lines = d.blocks.flatMap((b) => b.lines.map((l) => l.content));
    expect(lines).toContain('-    disabled: false');
    expect(lines).toContain('+    disabled: true');
    expect(lines.indexOf('-    disabled: false')).toBeLessThan(lines.indexOf('+    disabled: true'));
    expect(gitShow(world.commits, head.hash, 'wg_other')).toEqual({ items: [{ commitMessage: '', diffJson: [] }], count: 1 });
    // Over diffLineLimit changed lines the hunks are replaced by the Leader's notice (MEASURED).
    const [small] = gitShow(world.commits, head.hash, 'default', 1).items[0].diffJson;
    expect(small).toMatchObject({ isTooBig: true, newName: pipelineFile('default', RIG.pipelines.paySample) });
    expect(small.blocks).toEqual([{ oldStartLine: 0, newStartLine: 0, header: expect.stringMatching(/^Diff too big to be displayed, showing at most 1 lines\./), lines: [] }]);
    expect(gitShow(world.commits, head.hash, 'default', 0).items[0].diffJson[0].isTooBig).toBe(false);
    expect(() => gitShow(world.commits, 'deadbeef')).toThrow(/bad revision/);
  });

  it('files: nested tree of that one commit; the root commit answers 500', () => {
    const packCommit = world.commits.find((c) => c.message === 'demo: apply the pack on mrd_pan_firewall')!;
    const files = gitFiles(world.commits, packCommit.hash, 'default');
    expect(files.items[0].commitMessage).toBe(packCommit.message);
    expect(flattenGitFiles(files.items[0].items).sort()).toEqual([...packCommit.files].sort());
    expect(files.items[0].items[0]).toMatchObject({ name: 'groups', children: [expect.objectContaining({ name: 'default' })] });
    const root = [...world.commits].sort((a, b) => a.at - b.at)[0];
    expect(() => gitFiles(world.commits, root.hash)).toThrow(/bad revision '.{7}~\.\..{7}'/);
  });

  it('commit summaries and new-file diffs follow the openapi shapes', () => {
    const rigCommit = world.commits.find((c) => c.message === 'demo: apply the rig')!;
    const s = commitSummary(rigCommit);
    expect(s.branch).toBe('master');
    expect(s.commit).toBe(rigCommit.hash);
    // pipelines are new files; the route table, inputs and outputs already existed in the org
    expect(s.files.created).toHaveLength(8);
    expect(s.files.modified.sort()).toEqual([routesFile('default'), 'groups/default/local/cribl/inputs.yml', 'groups/default/local/cribl/outputs.yml'].sort());
    expect(s.summary.changes).toBe(s.summary.insertions + s.summary.deletions);
    const nf = diffFile('groups/default/local/cribl/x.yml', null, 'a: 1\nb: 2\n');
    expect(nf).toMatchObject({ isNew: true, oldName: '/dev/null', addedLines: 2, deletedLines: 0 });
    expect(nf.blocks[0].header).toBe('@@ -0,0 +1,2 @@');
    const c = buildCommit({ seed: 1, at: NOW, message: 'x', author: RIG.author, files: ['groups/default/local/cribl/secrets.yml'] });
    expect(c.diff[0].isNew).toBe(true);
  });

  it('YAML is deterministic and quotes what YAML would misread', () => {
    expect(toYaml({ a: 'true', b: '', c: [{ d: 1, e: 'x y' }], f: {}, g: [] })).toBe("a: 'true'\nb: ''\nc:\n  - d: 1\n    e: x y\nf: {}\ng: []\n");
  });
});

// ─── the demo rig (PRD 9.1) ──────────────────────────────────────────────────
describe('demo rig', () => {
  it('six tagged Datagen sources and three tagged DevNull destinations', () => {
    const cfg = rig.config.default;
    const inputs = cfg.inputs.filter((i) => i.id.startsWith('mrd_'));
    expect(inputs.map((i) => i.id)).toEqual(['mrd_windows_dc', 'mrd_windows_workstations', 'mrd_pan_firewall', 'mrd_vpc_flow', 'mrd_payments_api', 'mrd_k8s_prod']);
    expect(inputs.every((i) => i.type === 'datagen' && i.description!.includes(DEMO_TAG) && i.samples![0].eventsPerSec > 0)).toBe(true);
    const outputs = cfg.outputs.filter((o) => o.id.startsWith('mrd_'));
    expect(outputs.map((o) => [o.id, o.type])).toEqual([['mrd_siem_prod', 'devnull'], ['mrd_analytics', 'devnull'], ['mrd_archive_s3', 'devnull']]);
    expect(cfg.pipelines.filter((p) => p.id.startsWith('mrd_')).every((p) => p.conf.description!.includes(DEMO_TAG))).toBe(true);
    expect(cfg.routes.routes.every((r) => r.description!.includes(DEMO_TAG))).toBe(true);
    expect(cfg.pipelines.find((p) => p.id === RIG.pipelines.paySample)!.conf.functions.map((f) => [f.id, (f.description ?? '').includes(TRIM_TAG)])).toEqual([
      ['sampling', false],
      ['serde', false],
      ['eval', true],
      ['serialize', false],
      ['eval', false],
    ]);
  });

  it('route ratios are 0.33 / 0 / 0 / 0 / 0.75 / 0.70 and the rig runs ≈ 450 GB/day', () => {
    expect(rig.flows.map((f) => f.ratio)).toEqual([0.33, 0, 0, 0, 0.75, 0.7]);
    const day = { start: NOW - DAY_MS - HOUR_MS, end: NOW - HOUR_MS };
    let total = 0;
    for (const f of rig.flows) {
      const t = flowTotals(rig, f.id, day.start, day.end);
      total += t.srcB;
      expect(1 - t.outB / t.inB).toBeCloseTo(f.ratio, 2);
    }
    expect(total / GB).toBeGreaterThan(445);
    expect(total / GB).toBeLessThan(455);
  });

  it('the metrics dimension for a rig input is datagen:<inputId>', () => {
    const { results } = metricsQuery(rig, bytesQuery('total.in_bytes', 'b', ['input'], { earliest: NOW - MINUTE_MS, latest: NOW }), { now: NOW });
    expect(results.map((r) => r.input).filter(Boolean)).toContain('datagen:mrd_payments_api');
  });

  it('S15 script: apply-the-pack commits land 70/55/40 s before the break; payments drops 0.75 → 0.50 at the break', () => {
    const breakAt = NOW - 20 * MINUTE_MS;
    const w = demoRigWorld({ now: NOW, script: { breakAt, withPacks: true } });
    const demo = [...w.commits].filter((c) => c.message.startsWith('demo: ') && c.message !== 'demo: apply the rig').sort((a, b) => a.at - b.at);
    expect(demo.map((c) => [(breakAt - c.at) / 1000, c.message, c.files])).toEqual([
      [70, 'demo: apply the pack on mrd_windows_workstations', [routesFile('default')]],
      [55, 'demo: apply the pack on mrd_pan_firewall', [routesFile('default')]],
      [40, 'demo: apply the pack on mrd_vpc_flow', [routesFile('default')]],
      [0, 'demo: break the trim on mrd_pay_sample', [pipelineFile('default', 'mrd_pay_sample')]],
    ]);
    const pay = w.flows.find((f) => f.id === 'mrd_payments_api')!;
    const ratio = (t0: number, t1: number) => {
      const t = flowTotals(w, pay.id, t0, t1);
      return 1 - t.outB / t.inB;
    };
    expect(ratio(breakAt - 10 * MINUTE_MS, breakAt)).toBeCloseTo(0.75, 2);
    expect(ratio(breakAt, breakAt + 10 * MINUTE_MS)).toBeCloseTo(0.5, 2);
    const ws = w.flows.find((f) => f.id === 'mrd_windows_workstations')!;
    expect(flowMinute(w, ws, breakAt + MINUTE_MS)).toMatchObject({ pipelineId: RIG.pipelines.winXmlPack });
    expect(flowMinute(w, ws, breakAt - 2 * MINUTE_MS)).toMatchObject({ pipelineId: RIG.pipelines.passthrough, ratio: 0 });
    // the rig config ends in the scripted state; the PAN pack carries its own syslog step (no Source pre-processing)
    expect(w.config.default.routes.routes.find((r) => r.id === 'mrd_pan_firewall')!.pipeline).toBe(RIG.pipelines.panPack);
    expect(w.config.default.inputs.find((i) => i.id === 'mrd_pan_firewall')!.pipeline).toBeUndefined();
    const pan = w.flows.find((f) => f.id === 'mrd_pan_firewall')!;
    expect(flowMinute(w, pan, breakAt + MINUTE_MS).ratio).toBeGreaterThan(0.35);
    expect(flowMinute(w, pan, breakAt + MINUTE_MS).ratio).toBeLessThan(0.5);
  });

  it('restore brings the ratio back; setRate scales volume; a deploy with no change has no effects', () => {
    const breakAt = NOW - 30 * MINUTE_MS;
    const w = demoRigWorld({ now: NOW, script: { breakAt, restoreAt: breakAt + 10 * MINUTE_MS } });
    const pay = w.flows.find((f) => f.id === 'mrd_payments_api')!;
    expect(flowMinute(w, pay, breakAt + 5 * MINUTE_MS).ratio).toBeLessThan(0.55);
    expect(flowMinute(w, pay, breakAt + 15 * MINUTE_MS).ratio).toBeGreaterThan(0.7);
    const cfg = rigConfigObjects();
    const faster = rigSetRate(cfg, 'default', 'mrd_payments_api', 5);
    expect(faster.message).toBe('demo: set mrd_payments_api to 5x');
    expect(rigFlowState(faster.config, pay).volume).toBeCloseTo(5, 2);
    expect(deployEffects(w.flows, cfg, cfg, NOW)).toEqual([]);
    expect(deployEffects(w.flows, cfg, faster.config, NOW)).toEqual([{ kind: 'volume', flowId: pay.id, start: NOW, multiplier: rigFlowState(faster.config, pay).volume }]);
  });

  it('levers refuse untagged objects and unknown targets', () => {
    const cfg = rigConfigObjects();
    const untagged = JSON.parse(JSON.stringify(cfg)) as typeof cfg;
    untagged.pipelines.find((p) => p.id === RIG.pipelines.paySample)!.conf.description = 'no tag';
    expect(() => rigBreakTrim(untagged, 'default')).toThrow(RigRefusal);
    expect(() => rigBreakTrim(cfg, 'default', 'nope')).toThrow(/not found/);
    expect(() => rigApplyPack(cfg, 'default', 'mrd_payments_api')).toThrow(/no pack/);
    expect(() => rigSetRate(cfg, 'default', 'mrd_payments_api', 50)).toThrow(/multiplier/);
    const broken = rigBreakTrim(cfg, 'default');
    expect(rigRestoreTrim(broken.config, 'default').config).toEqual(cfg);
    const applied = rigApplyPack(cfg, 'default', 'mrd_vpc_flow');
    const reverted = rigRevertPack(applied.config, 'default', 'mrd_vpc_flow');
    expect([applied.message, reverted.message]).toEqual(['demo: apply the pack on mrd_vpc_flow', 'demo: revert the pack on mrd_vpc_flow']);
    expect(reverted.config).toEqual(cfg);
    expect(() => rigRevertPack(cfg, 'default', 'mrd_k8s_prod')).toThrow(/no pack/);
    const aggressive = rigApplyPack(cfg, 'default', 'mrd_windows_workstations', 'aggressive').config;
    expect(aggressive.routes.routes[1].pipeline).toBe(RIG.pipelines.winDocsReduce);
    const ws = rig.flows.find((f) => f.id === 'mrd_windows_workstations')!;
    expect(rigFlowState(aggressive, ws).ratio).toBeGreaterThanOrEqual(0.6);
    expect(rigFlowState(rigApplyPack(cfg, 'default', 'mrd_windows_workstations').config, ws).ratio).toBe(0.33);
  });

  it('merging live config keeps the rig routes ahead of the catch-all', () => {
    const merged = mergeGroupConfig(rigConfigObjects(), {
      routes: { id: 'default', routes: [{ id: 'default', name: 'default', final: true, pipeline: 'main', output: 'default', filter: 'true' }] },
      pipelines: [{ id: 'main', conf: { functions: [] } }],
      outputs: [{ id: 'devnull', type: 'devnull' }],
      inputs: [{ id: 'http', type: 'http' }],
    });
    expect(merged.routes.routes.map((r) => r.id)).toEqual([...RIG.sources.map((s) => s.routeId), 'default']);
    // Sources and routes share ids, as in the live rig (docs/RIG.md)
    expect(RIG.sources.every((s) => s.routeId === s.inputId && s.routeName === s.inputId)).toBe(true);
    expect(merged.inputs[0].id).toBe('http');
    expect(merged.pipelines[0].id).toBe('main');
  });
});

// ─── scale ───────────────────────────────────────────────────────────────────
describe('scale (2,000 flows × 30 days)', () => {
  it('builds the estate quickly and answers a one-minute query for every flow', () => {
    const t0 = performance.now();
    const w = scaleWorld();
    const built = performance.now() - t0;
    const s = estateSummary(w);
    expect(s).toMatchObject({ flows: SCALE_DEFAULTS.flows, groups: SCALE_DEFAULTS.groups });
    expect(s.routes).toBe(SCALE_DEFAULTS.flows + SCALE_DEFAULTS.groups);
    expect(s.anomalies.spike + s.anomalies.regression + s.anomalies.outage).toBe(w.anomalies.length);
    expect(built).toBeLessThan(3000);
    const t1 = performance.now();
    const { results } = metricsQuery(w, bytesQuery('route.in_bytes', 'b', ['route', '__worker_group'], { earliest: w.end - MINUTE_MS, latest: w.end }), { now: w.end });
    expect(performance.now() - t1).toBeLessThan(3000);
    const routes = new Set(results.filter((r) => isSplitRow(r, ['route', '__worker_group'])).map((r) => r.route));
    expect(routes.size).toBeGreaterThan(SCALE_DEFAULTS.flows * 0.8); // quiet flows may be silent this minute
    expect(anomalyWindows(w).every((x) => x.windowStart < x.anomaly.start && x.windowEnd > x.anomaly.start)).toBe(true);
    expect([...minutes(w.end - 5 * MINUTE_MS, w.end)]).toHaveLength(5);
  });

  it('dailyVolume sampling approximates the exact daily total', () => {
    const w = scaleWorld({ flows: 40, groups: 1 });
    const day = DEFAULT_END - 2 * DAY_MS;
    const exact = dailyVolume(w, day, 1).bytes;
    const sampled = dailyVolume(w, day, 15).bytes;
    expect(Math.abs(sampled - exact) / exact).toBeLessThan(0.1);
  });
});
