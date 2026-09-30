import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Flow, GroupInventory, InventoryDoc, MetricsWindow } from '../../core/types.ts';
import { normalizePipelines } from '../../core/adapters/config.ts';
import {
  INTERNAL_TYPES,
  apportion,
  attributeWindow,
  passthroughPipelines,
  buildFlows,
  flowObjectKeys,
  isInternalInput,
  isInternalOutput,
  makeFlowKey,
  objectKey,
  parseFlowKey,
  parseObjectKey,
  parseRouteFilter,
  resolveRouteOutput,
  splitInputValue,
} from '../../core/flows.ts';

const TAG = '[meter-reader-demo]';
const ds = (id: string) => ({ id, type: 'datagen', description: `rig ${TAG}` });

const group = (): GroupInventory => ({
  inputs: [
    ds('mrd_windows_dc'),
    ds('mrd_windows_workstations'),
    ds('mrd_pan_firewall'),
    ds('mrd_vpc_flow'),
    ds('mrd_payments_api'),
    { id: 'mrd_k8s_prod', type: 'datagen' }, // tagged by the mrd_ prefix only
    { id: 'in_syslog', type: 'syslog' },
    { id: 'CriblMetrics', type: 'criblmetrics' },
    { id: 'CriblLogs', type: 'cribl' },
    { id: 'datagen_sample', type: 'datagen', description: 'built-in sample' },
    { id: 'old_input', type: 'syslog', disabled: true },
    { id: 'qc_input', type: 'http', sendToRoutes: false, connections: [{ output: 'mrd_archive_s3', pipeline: 'passthru' }, { output: 'devnull' }] },
  ],
  outputs: [
    { id: 'default', type: 'default', defaultId: 'devnull' },
    { id: 'devnull', type: 'devnull' },
    { id: 'mrd_siem_prod', type: 'devnull', description: TAG },
    { id: 'mrd_analytics', type: 'devnull', description: TAG },
    { id: 'mrd_archive_s3', type: 'devnull', description: TAG },
    { id: 'retired', type: 'splunk_hec', disabled: true },
    { id: 'metrics_out', type: 'cribl_metrics' },
  ],
  pipelines: [
    { id: 'mrd_pay_sample', functions: [] },
    { id: 'main', functions: [] },
    { id: 'routes_to_analytics', functions: [], output: 'mrd_analytics' },
  ],
  routes: [
    { id: 'r_dc', filter: "__inputId=='datagen:mrd_windows_dc'", pipeline: 'mrd_win_xml_pack', output: 'mrd_siem_prod', final: true },
    { id: 'r_ws', filter: '__inputId === "datagen:mrd_windows_workstations"', pipeline: 'mrd_passthrough', output: 'mrd_siem_prod' },
    { id: 'r_pan', filter: "__inputId.startsWith('datagen:mrd_pan')", pipeline: 'mrd_pan_pack', output: 'mrd_siem_prod', final: true },
    { id: 'r_vpc', filter: "['datagen:mrd_vpc_flow'].includes(__inputId)", pipeline: 'mrd_vpc_pack', output: 'mrd_archive_s3', final: true },
    { id: 'r_pay_clone', filter: "__inputId=='datagen:mrd_payments_api'", pipeline: 'main', output: 'mrd_analytics', final: false },
    { id: 'r_pay', filter: "__inputId in ['datagen:mrd_payments_api']", pipeline: 'mrd_pay_sample', output: 'mrd_siem_prod', final: true },
    { id: 'r_pay_dead', filter: "__inputId=='datagen:mrd_payments_api'", pipeline: 'main', output: 'mrd_siem_prod', final: true },
    { id: 'r_k8s', filter: "(__inputId=='datagen:mrd_k8s_prod' || __inputId=='mrd_k8s_other') && level!='debug'", pipeline: 'mrd_k8s_noise', output: 'mrd_analytics', final: true },
    { id: 'r_weird', filter: "sourcetype=='access_combined'", pipeline: 'routes_to_analytics' },
    { id: 'r_off', filter: 'true', pipeline: 'main', disabled: true },
    { id: 'r_metrics', filter: "__inputId=='criblmetrics:CriblMetrics'", pipeline: 'main', output: 'devnull' },
    { id: 'r_retired', filter: "__inputId=='syslog:in_syslog'", pipeline: 'main', output: 'retired', final: false },
    { id: 'default', filter: 'true', pipeline: 'main', output: 'default', final: true },
    { id: 'after_catch_all', filter: 'true', pipeline: 'main', output: 'devnull' },
  ],
});

const inventory = (g: GroupInventory = group()): InventoryDoc => ({ schemaVersion: 1, updatedAt: '', hash: 'h', byGroup: { default: g } });
const settings = { includeInternal: false, excludedObjectKeys: [] as string[] };

/** The pre-D20 estimate layer, tested on its own; reconciliation is tested separately below. */
const EST = { reconcile: false } as const;

describe('keys', () => {
  it('builds and parses flow keys', () => {
    const k = makeFlowKey('default', 'mrd_payments_api', 'r_pay', 'mrd_pay_sample', 'mrd_siem_prod');
    expect(k).toBe('default|mrd_payments_api|r_pay|mrd_pay_sample|mrd_siem_prod');
    expect(parseFlowKey(k)).toEqual({ groupId: 'default', inputId: 'mrd_payments_api', routeId: 'r_pay', pipelineId: 'mrd_pay_sample', outputId: 'mrd_siem_prod' });
    expect(makeFlowKey('g', '', 'r', undefined as unknown as string, 'o')).toBe('g|-|r|-|o');
    expect(parseFlowKey('a|b')).toBeNull();
    expect(parseFlowKey(undefined as unknown as string)).toBeNull();
  });
  it('builds and parses object keys', () => {
    expect(objectKey('pipe', 'default', 'mrd_pay_sample')).toBe('pipe:default:mrd_pay_sample');
    expect(parseObjectKey('route:default:r:with:colons')).toEqual({ kind: 'route', groupId: 'default', id: 'r:with:colons' });
    expect(parseObjectKey('bogus:default:x')).toBeNull();
    expect(parseObjectKey('in:default')).toBeNull();
    expect(flowObjectKeys({ groupId: 'g', inputId: '-', routeId: 'r', pipelineId: 'p', outputId: 'o' })).toEqual({
      input: undefined,
      route: 'route:g:r',
      pipeline: 'pipe:g:p',
      output: 'out:g:o',
    });
    expect(flowObjectKeys({ groupId: 'g', inputId: 'i', routeId: '-', pipelineId: '-', outputId: '-' })).toEqual({
      input: 'in:g:i',
      route: undefined,
      pipeline: undefined,
      output: undefined,
    });
  });
  it('splits input dimension values', () => {
    expect(splitInputValue('datagen:mrd_x')).toEqual({ type: 'datagen', id: 'mrd_x' });
    expect(splitInputValue('mrd_x')).toEqual({ id: 'mrd_x' });
  });
});

describe('parseRouteFilter', () => {
  it.each([
    ['true', { kind: 'all' }],
    ['', { kind: 'all' }],
    [' (true) ', { kind: 'all' }],
    ["__inputId=='datagen:x'", { kind: 'inputs', refs: [{ value: 'datagen:x', prefix: false }], exact: true }],
    ['__inputId === "x"', { kind: 'inputs', refs: [{ value: 'x', prefix: false }], exact: true }],
    ["'datagen:x' == __inputId", { kind: 'inputs', refs: [{ value: 'datagen:x', prefix: false }], exact: true }],
    ["__inputId.startsWith('datagen:x')", { kind: 'inputs', refs: [{ value: 'datagen:x', prefix: true }], exact: true }],
    ["['a', \"b\"].includes(__inputId)", { kind: 'inputs', refs: [{ value: 'a', prefix: false }, { value: 'b', prefix: false }], exact: true }],
    ["__inputId in ['a','b']", { kind: 'inputs', refs: [{ value: 'a', prefix: false }, { value: 'b', prefix: false }], exact: true }],
    ["__inputId=='a' || __inputId=='b'", { kind: 'inputs', refs: [{ value: 'a', prefix: false }, { value: 'b', prefix: false }], exact: true }],
    ["((__inputId=='a') || (__inputId=='b'))", { kind: 'inputs', refs: [{ value: 'a', prefix: false }, { value: 'b', prefix: false }], exact: true }],
    ["__inputId=='a' && level=='error'", { kind: 'inputs', refs: [{ value: 'a', prefix: false }], exact: false }],
    ["(__inputId=='a' || __inputId=='b') && x > 1", { kind: 'inputs', refs: [{ value: 'a', prefix: false }, { value: 'b', prefix: false }], exact: false }],
  ])('classifies %s', (filter, expected) => {
    expect(parseRouteFilter(filter)).toEqual(expected);
  });
  it.each([
    "sourcetype=='syslog'",
    "__inputId != 'a'",
    "!(__inputId=='a')",
    "!__inputId.startsWith('a')",
    "__inputId=='a' || sourcetype=='x'",
    "[a, 'b'].includes(__inputId)",
    "__inputId in [x]",
    '__inputId.match(/x/)',
  ])('treats %s as unknown', (filter) => {
    expect(parseRouteFilter(filter)).toEqual({ kind: 'unknown' });
  });
  it('treats undefined as all', () => {
    expect(parseRouteFilter(undefined)).toEqual({ kind: 'all' });
    expect(parseRouteFilter('(a) && (b)')).toEqual({ kind: 'unknown' });
  });
});

describe('internal detection and output resolution', () => {
  it('flags internal inputs and outputs', () => {
    for (const t of INTERNAL_TYPES) expect(isInternalInput({ id: 'x', type: t })).toBe(true);
    // C3 option A (founder-build r1, FINDINGS_R1 B2 #40): a Datagen Source is data the member chose to route and
    // price, tagged or not; only Cribl's own system inputs (INTERNAL_TYPES) are plumbing.
    expect(isInternalInput({ id: 'x', type: 'datagen' })).toBe(false);
    expect(isInternalInput({ id: 'in_datagen_test', type: 'datagen', description: 'CLEAN_INSTALL_TEST 0.3' })).toBe(false);
    expect(isInternalInput({ id: 'mrd_x', type: 'datagen' })).toBe(false);
    expect(isInternalInput({ id: 'x', type: 'datagen', description: `a ${TAG}` })).toBe(false);
    expect(isInternalInput({ id: 'x', type: 'syslog' })).toBe(false);
    expect(isInternalOutput({ type: 'cribl_metrics' })).toBe(true);
    expect(isInternalOutput({ type: 'devnull' })).toBe(false);
  });
  it('follows an Output Router whose rules all lead to one destination; a splitting router is the end (core-12, M12)', () => {
    const g = group();
    g.outputs = [
      ...(g.outputs ?? []),
      { id: 'one_way', type: 'router', rules: [{ output: 'mrd_siem_prod', filter: 'true', final: true }, { output: 'mrd_siem_prod', filter: "x==1" }] },
      { id: 'split', type: 'router', rules: [{ output: 'mrd_siem_prod' }, { output: 'mrd_archive_s3' }] },
      { id: 'mostly', type: 'router', rules: [{ output: 'mrd_siem_prod' }, { output: 'mrd_archive_s3', disabled: true }] },
      { id: 'to_default', type: 'router', rules: [{ output: 'default' }] },
    ];
    expect(resolveRouteOutput({ output: 'one_way', pipeline: 'x' }, g)).toBe('mrd_siem_prod');
    expect(resolveRouteOutput({ output: 'split', pipeline: 'x' }, g)).toBe('split');
    expect(resolveRouteOutput({ output: 'mostly', pipeline: 'x' }, g)).toBe('mrd_siem_prod');
    expect(resolveRouteOutput({ output: 'to_default', pipeline: 'x' }, g)).toBe('devnull');
  });
  it('resolves route → pipeline → default output, following defaultId', () => {
    const g = group();
    expect(resolveRouteOutput({ output: 'mrd_siem_prod', pipeline: 'x' }, g)).toBe('mrd_siem_prod');
    expect(resolveRouteOutput({ pipeline: 'routes_to_analytics' }, g)).toBe('mrd_analytics');
    expect(resolveRouteOutput({ pipeline: 'main' }, g)).toBe('devnull');
    expect(resolveRouteOutput({ output: 'default', pipeline: 'main' }, g)).toBe('devnull');
    expect(resolveRouteOutput({ pipeline: 'main' }, { ...g, outputs: [] })).toBe('default');
    const loop: GroupInventory = { ...g, outputs: [{ id: 'default', type: 'default', defaultId: 'default' }] };
    expect(resolveRouteOutput({ pipeline: 'main' }, loop)).toBe('default');
  });
});

describe('buildFlows', () => {
  it('walks the routing table in order with FINAL claiming', () => {
    const keys = buildFlows(inventory(), settings).map((f) => `${f.key}#${f.attribution}`);
    expect(keys).toEqual([
      'default|mrd_windows_dc|r_dc|mrd_win_xml_pack|mrd_siem_prod#route',
      'default|mrd_windows_workstations|r_ws|mrd_passthrough|mrd_siem_prod#route',
      'default|mrd_pan_firewall|r_pan|mrd_pan_pack|mrd_siem_prod#route',
      'default|mrd_vpc_flow|r_vpc|mrd_vpc_pack|mrd_archive_s3#route',
      'default|mrd_payments_api|r_pay_clone|main|mrd_analytics#route',
      'default|mrd_payments_api|r_pay|mrd_pay_sample|mrd_siem_prod#route',
      'default|mrd_k8s_prod|r_k8s|mrd_k8s_noise|mrd_analytics#route',
      'default|mrd_k8s_other|r_k8s|mrd_k8s_noise|mrd_analytics#route',
      'default|-|r_weird|routes_to_analytics|mrd_analytics#route-only',
      'default|mrd_k8s_prod|default|main|devnull#route',
      'default|in_syslog|default|main|devnull#route',
      'default|datagen_sample|default|main|devnull#route', // an untagged Datagen is metered (C3 option A)
      'default|qc_input|-|passthru|mrd_archive_s3#proportional',
      'default|qc_input|-|-|devnull#proportional',
    ]);
  });
  it('meters an untagged Datagen → Drop → priced DevNull as one flow; Cribl system inputs stay excluded (C3 option A, B2 #40)', () => {
    // CLEAN_INSTALL_TEST 0.3 / DDT2's recipe: a plain Datagen, a route to a Drop pipeline, DevNull. No demo tag.
    const g: GroupInventory = {
      inputs: [
        { id: 'in_datagen_test', type: 'datagen', description: 'syslog sample, 100 EPS' },
        { id: 'CriblMetrics', type: 'criblmetrics' },
        { id: 'CriblLogs', type: 'cribl' },
        ...INTERNAL_TYPES.map((t, i) => ({ id: `sys_${i}`, type: t })),
      ],
      outputs: [
        { id: 'devnull', type: 'devnull' },
        { id: 'default', type: 'default', defaultId: 'devnull' },
      ],
      pipelines: [
        { id: 'drop_half', functions: [{ id: 'drop', filter: 'Math.random() < 0.5' }] },
        { id: 'main', functions: [] },
      ],
      routes: [
        { id: 'r_dg', filter: "__inputId=='datagen:in_datagen_test'", pipeline: 'drop_half', output: 'devnull', final: true },
        { id: 'default', filter: 'true', pipeline: 'main', output: 'default', final: true },
      ],
    };
    const keys = buildFlows(inventory(g), settings).map((f) => f.key);
    expect(keys).toEqual(['default|in_datagen_test|r_dg|drop_half|devnull']);
    // The tagged control is unchanged: one flow.
    const tagged: GroupInventory = { ...g, inputs: [{ id: 'in_datagen_test', type: 'datagen', description: `test ${TAG}` }, ...g.inputs.slice(1)] };
    expect(buildFlows(inventory(tagged), settings).map((f) => f.key)).toEqual(['default|in_datagen_test|r_dg|drop_half|devnull']);
    // includeInternal still brings the system inputs in, on the catch-all.
    const all = buildFlows(inventory(g), { includeInternal: true, excludedObjectKeys: [] }).map((f) => f.key);
    expect(all).toContain('default|CriblMetrics|default|main|devnull');
  });
  it('includes internal objects when asked', () => {
    const keys = buildFlows(inventory(), { includeInternal: true, excludedObjectKeys: [] }).map((f) => f.key);
    expect(keys).toContain('default|CriblMetrics|r_metrics|main|devnull');
    expect(keys).toContain('default|datagen_sample|default|main|devnull');
    expect(keys).toContain('default|CriblLogs|default|main|devnull');
    expect(keys.some((k) => k.includes('old_input'))).toBe(false);
    expect(keys.some((k) => k.includes('retired'))).toBe(false);
  });
  it('drops internal outputs unless included', () => {
    const g = group();
    g.routes = [{ id: 'r', filter: 'true', pipeline: 'main', output: 'metrics_out' }];
    const routed = (s: typeof settings) => buildFlows(inventory(g), s).filter((f) => f.routeId !== '-');
    expect(routed(settings)).toEqual([]);
    expect(routed({ includeInternal: true, excludedObjectKeys: [] }).length).toBeGreaterThan(0);
  });
  it('respects excluded object keys of every kind', () => {
    const all = buildFlows(inventory(), settings).length;
    const ex = (k: string) => buildFlows(inventory(), { includeInternal: false, excludedObjectKeys: [k] }).length;
    expect(ex('in:default:mrd_payments_api')).toBe(all - 2);
    expect(ex('route:default:default')).toBe(all - 3);
    expect(ex('pipe:default:main')).toBe(all - 4);
    expect(ex('out:default:mrd_siem_prod')).toBe(all - 4);
  });
  it('handles empty and missing inventories', () => {
    expect(buildFlows({ schemaVersion: 1, updatedAt: '', hash: '', byGroup: {} }, settings)).toEqual([]);
    expect(buildFlows(undefined as unknown as InventoryDoc, settings)).toEqual([]);
    expect(buildFlows(inventory({ inputs: [], outputs: [], pipelines: [], routes: [] }), settings)).toEqual([]);
  });
  it('prefix-matches bare ids and keeps unknown inputs typed by their prefix', () => {
    const g: GroupInventory = {
      inputs: [{ id: 'web_1', type: 'http' }, { id: 'web_2', type: 'http' }],
      outputs: [],
      pipelines: [],
      routes: [
        { id: 'a', filter: "__inputId.startsWith('web_')", pipeline: 'p', output: 'o' },
        { id: 'b', filter: "__inputId=='cribl:pack_internal' || __inputId=='tcp:ghost'", pipeline: 'p', output: 'o' },
      ],
    };
    expect(buildFlows(inventory(g), settings).map((f) => f.inputId)).toEqual(['web_1', 'web_2', 'ghost']);
  });
});

const window = (over: Partial<MetricsWindow>): MetricsWindow => ({
  windowStart: '2026-09-26T03:40:00.000Z',
  windowEnd: '2026-09-26T03:41:00.000Z',
  inputs: {},
  outputs: {},
  has: { routeBytes: false, pipelineBytes: false },
  ...over,
});
const flow = (inputId: string, routeId: string, pipelineId: string, outputId: string, attribution: Flow['attribution'] = 'route'): Flow => ({
  key: makeFlowKey('g', inputId, routeId, pipelineId, outputId),
  groupId: 'g',
  inputId,
  routeId,
  pipelineId,
  outputId,
  attribution,
});

describe('apportion', () => {
  it('splits exactly by largest remainder', () => {
    expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(apportion(100, [3, 1])).toEqual([75, 25]);
    expect(apportion(5, [0, 0])).toEqual([3, 2]);
    expect(apportion(-5, [1])).toEqual([0]);
    expect(apportion(7, [])).toEqual([]);
    expect(apportion(7, [Number.NaN, 2])).toEqual([0, 7]);
  });
  it('never creates or loses a unit (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e12 }), fc.array(fc.integer({ min: 0, max: 1e9 }), { minLength: 1, maxLength: 20 }), (total, weights) => {
        const parts = apportion(total, weights);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        expect(parts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
      }),
    );
  });
});

describe('attributeWindow', () => {
  it('uses route bytes for a single-input route', () => {
    const f = flow('pay', 'r_pay', 'pay_sample', 'siem');
    const w = window({
      inputs: { 'g:pay': { bytes: 1000, events: 10 } },
      outputs: { 'g:siem': { bytes: 400, events: 5 } },
      routesIn: { 'g:r_pay': { bytes: 1000, events: 10 } },
      routesOut: { 'g:r_pay': { bytes: 250, events: 5 } },
      has: { routeBytes: true, pipelineBytes: false },
    });
    expect(attributeWindow([f], w, EST)[f.key]).toEqual({ inB: 1000, outB: 250, inE: 10, outE: 5, attribution: 'route' });
  });
  it('splits a shared catch-all by input share and caps pre-cascade over-counts', () => {
    // route.* on the catch-all counts every input's events (pre-cascade): 10,000 in, 5,000 out.
    const a = flow('a', 'default', 'main', 'devnull');
    const b = flow('b', 'default', 'main', 'devnull');
    const w = window({
      inputs: { 'g:a': { bytes: 1000, events: 10 }, 'g:b': { bytes: 3000, events: 30 }, 'g:claimed': { bytes: 6000, events: 60 } },
      routesIn: { 'g:default': { bytes: 10_000, events: 100 } },
      routesOut: { 'g:default': { bytes: 5_000, events: 50 } },
      has: { routeBytes: true, pipelineBytes: false },
    });
    const r = attributeWindow([a, b], w, EST);
    expect(r[a.key]).toEqual({ inB: 1000, outB: 500, inE: 10, outE: 5, attribution: 'route' });
    expect(r[b.key]).toEqual({ inB: 3000, outB: 1500, inE: 30, outE: 15, attribution: 'route' });
  });
  it('gives a route-only flow the whole route and treats missing series as zero', () => {
    const f = flow('-', 'r_weird', 'p', 'o', 'route-only');
    const g = flow('x', 'r_silent', 'p', 'o');
    const w = window({ routesIn: { 'g:r_weird': { bytes: 700, events: 7 } }, routesOut: { 'g:r_weird': { bytes: 70, events: 1 } }, has: { routeBytes: true, pipelineBytes: false } });
    const r = attributeWindow([f, g], w, EST);
    expect(r[f.key]).toEqual({ inB: 700, outB: 70, inE: 7, outE: 1, attribution: 'route-only' });
    expect(r[g.key]).toEqual({ inB: 0, outB: 0, inE: 0, outE: 0, attribution: 'route' });
  });
  it('falls back to pipeline series', () => {
    const a = flow('a', 'r1', 'p', 'o');
    const b = flow('b', 'r2', 'p', 'o');
    const w = window({
      inputs: { 'g:a': { bytes: 100, events: 1 }, 'g:b': { bytes: 300, events: 3 } },
      pipelinesIn: { 'g:p': { bytes: 400, events: 4 } },
      pipelinesOut: { 'g:p': { bytes: 200, events: 2 } },
      has: { routeBytes: false, pipelineBytes: true },
    });
    const r = attributeWindow([a, b], w, EST);
    expect(r[a.key]).toMatchObject({ inB: 100, outB: 50, attribution: 'pipeline' });
    expect(r[b.key]).toMatchObject({ inB: 300, outB: 150, attribution: 'pipeline' });
  });
  it('is proportional without route or pipeline series, and accepts type-prefixed keys', () => {
    const a1 = flow('a', 'r1', 'p1', 'siem');
    const a2 = flow('a', 'r2', 'p2', 'lake');
    const b = flow('b', 'r3', 'p3', 'siem');
    const w = window({
      inputs: { 'g:datagen:a': { bytes: 1000, events: 10 }, 'g:b': { bytes: 2000, events: 20 } },
      outputs: { 'g:devnull:siem': { bytes: 900, events: 9 }, 'g:lake': { bytes: 100, events: 1 } },
    });
    const r = attributeWindow([a1, a2, b], w, EST);
    expect(r[a1.key]).toEqual({ inB: 500, outB: 180, inE: 5, outE: 2, attribution: 'proportional' });
    expect(r[a2.key]).toEqual({ inB: 500, outB: 100, inE: 5, outE: 1, attribution: 'proportional' });
    expect(r[b.key]).toEqual({ inB: 2000, outB: 720, inE: 10 * 2, outE: 7, attribution: 'proportional' });
  });
  it('gives QuickConnect flows what the routed flows left of their output', () => {
    const routed = flow('a', 'r1', 'p', 'lake');
    const qc = flow('q', '-', 'passthru', 'lake', 'proportional');
    const w = window({
      inputs: { 'g:a': { bytes: 1000, events: 10 }, 'g:q': { bytes: 500, events: 5 } },
      outputs: { 'g:lake': { bytes: 900, events: 9 } },
      routesIn: { 'g:r1': { bytes: 1000, events: 10 } },
      routesOut: { 'g:r1': { bytes: 400, events: 4 } },
      has: { routeBytes: true, pipelineBytes: false },
    });
    const r = attributeWindow([routed, qc], w, EST);
    expect(r[qc.key]).toEqual({ inB: 500, outB: 500, inE: 5, outE: 5, attribution: 'proportional' });
    const noLeft = attributeWindow([routed, qc], { ...w, outputs: { 'g:lake': { bytes: 300, events: 1 } } }, EST);
    expect(noLeft[qc.key].outB).toBe(0);
    // an unattributed proportional flow gets no input bytes
    const orphan = flow('-', 'r9', 'p', 'lake', 'route-only');
    expect(attributeWindow([orphan], window({ outputs: { 'g:lake': { bytes: 10, events: 1 } } }), EST)[orphan.key]).toEqual({
      inB: 0,
      outB: 10,
      inE: 0,
      outE: 1,
      attribution: 'proportional',
    });
  });
  it('conserves input and output bytes in proportional mode (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ i: fc.integer({ min: 0, max: 3 }), o: fc.integer({ min: 0, max: 2 }) }), { minLength: 1, maxLength: 12 }),
        fc.array(fc.integer({ min: 0, max: 1e10 }), { minLength: 4, maxLength: 4 }),
        fc.array(fc.integer({ min: 0, max: 1e10 }), { minLength: 3, maxLength: 3 }),
        (pairs, inBytes, outBytes) => {
          const flows = pairs.map((p, n) => flow(`i${p.i}`, `r${n}`, 'p', `o${p.o}`));
          const w = window({
            inputs: Object.fromEntries(inBytes.map((b, i) => [`g:i${i}`, { bytes: b, events: 0 }])),
            outputs: Object.fromEntries(outBytes.map((b, o) => [`g:o${o}`, { bytes: b, events: 0 }])),
          });
          const r = attributeWindow(flows, w);
          for (let i = 0; i < 4; i++) {
            const mine = flows.filter((f) => f.inputId === `i${i}`);
            if (mine.length) expect(mine.reduce((s, f) => s + r[f.key].inB, 0)).toBe(inBytes[i]);
          }
          for (let o = 0; o < 3; o++) {
            const mine = flows.filter((f) => f.outputId === `o${o}`);
            if (mine.length) expect(mine.reduce((s, f) => s + r[f.key].outB, 0)).toBe(outBytes[o]);
          }
        },
      ),
    );
  });
});


describe('reconciled attribution (DECISIONS D20)', () => {
  // Numbers from the live rig, one minute at rate 1.0 (docs/RIG.md §9): route estimates read reshaped
  // events low; Source and Destination counters are exact.
  const mk = (input: string, route: string, pipe: string, out: string): Flow => ({
    key: makeFlowKey('default', input, route, pipe, out), groupId: 'default', inputId: input, routeId: route, pipelineId: pipe, outputId: out, attribution: 'route',
  });
  const dc = mk('dc', 'r_dc', 'win_pack', 'siem');
  const ws = mk('ws', 'r_ws', 'passthru', 'siem');
  const pay = mk('pay', 'r_pay', 'pay_sample', 'apps');
  const k8s = mk('k8s', 'r_k8s', 'k8s_noise', 'analytics');
  const w: MetricsWindow = {
    windowStart: '2026-09-26T07:00:00.000Z', windowEnd: '2026-09-26T07:01:00.000Z',
    inputs: { 'default:dc': { bytes: 104_000_000, events: 41_000 }, 'default:ws': { bytes: 55_500_000, events: 22_000 }, 'default:pay': { bytes: 27_800_000, events: 24_400 }, 'default:k8s': { bytes: 41_600_000, events: 53_000 } },
    // siem receives dc (true ratio 0.342 → 68.4 MB) + ws passthrough (55.5 MB); apps receives pay (0.773 → 6.3 MB); analytics k8s (0.724 → 11.5 MB)
    outputs: { 'default:siem': { bytes: 123_900_000, events: 63_000 }, 'default:apps': { bytes: 6_310_000, events: 12_200 }, 'default:analytics': { bytes: 11_480_000, events: 31_700 } },
    routesIn: { 'default:r_dc': { bytes: 104_100_000, events: 41_000 }, 'default:r_ws': { bytes: 56_000_000, events: 22_000 }, 'default:r_pay': { bytes: 27_900_000, events: 24_400 }, 'default:r_k8s': { bytes: 41_700_000, events: 53_000 } },
    routesOut: { 'default:r_dc': { bytes: 51_900_000, events: 41_000 }, 'default:r_ws': { bytes: 56_700_000, events: 22_000 }, 'default:r_pay': { bytes: 4_760_000, events: 12_200 }, 'default:r_k8s': { bytes: 5_800_000, events: 31_700 } },
    has: { routeBytes: true, pipelineBytes: false },
  };
  const pass = new Set(['default:passthru']);

  it('prices would-have-paid from the exact Source counters', () => {
    const r = attributeWindow([dc, ws, pay, k8s], w, { passthroughPipelines: pass });
    expect(r[dc.key].inB).toBe(104_000_000);
    expect(r[ws.key].inB).toBe(55_500_000);
    expect(r[pay.key].inB).toBe(27_800_000);
    expect(Object.values(r).every((x) => x.attribution === 'reconciled')).toBe(true);
  });
  it('pins passthrough flows to out = in and gives the rest of the destination to the reshaped flow', () => {
    const r = attributeWindow([dc, ws, pay, k8s], w, { passthroughPipelines: pass });
    expect(r[ws.key].outB).toBe(55_500_000); // ratio exactly 0, never negative
    expect(r[dc.key].outB).toBe(123_900_000 - 55_500_000); // 68.4 MB → true ratio 0.342, not the estimate's 0.50
    expect(1 - r[dc.key].outB / r[dc.key].inB).toBeCloseTo(0.342, 3);
  });
  it('uses the exact destination counter for a flow that owns its destination', () => {
    const r = attributeWindow([dc, ws, pay, k8s], w, { passthroughPipelines: pass });
    expect(r[pay.key].outB).toBe(6_310_000);
    expect(1 - r[pay.key].outB / r[pay.key].inB).toBeCloseTo(0.773, 3);
    expect(1 - r[k8s.key].outB / r[k8s.key].inB).toBeCloseTo(0.724, 3);
  });
  it('conserves bytes: flows sum to each measured Source and Destination', () => {
    const r = attributeWindow([dc, ws, pay, k8s], w, { passthroughPipelines: pass });
    expect(r[dc.key].outB + r[ws.key].outB).toBe(123_900_000);
  });
  it('leaves a destination alone when it also receives traffic the flows do not explain', () => {
    const noisy = { ...w, outputs: { ...w.outputs, 'default:apps': { bytes: 60_000_000, events: 1 } } };
    const r = attributeWindow([dc, ws, pay, k8s], noisy, { passthroughPipelines: pass });
    // the estimate stands (60 MB is > 2× what the flow could send): same as the estimate layer's answer
    expect(r[pay.key].outB).toBe(attributeWindow([dc, ws, pay, k8s], noisy, EST)[pay.key].outB);
  });
  it('scales passthrough flows down when they alone exceed the destination (counter skew)', () => {
    const skew = { ...w, outputs: { ...w.outputs, 'default:siem': { bytes: 50_000_000, events: 1 } } };
    const r = attributeWindow([ws], { ...skew, inputs: { 'default:ws': w.inputs['default:ws'] } }, { passthroughPipelines: pass });
    expect(r[ws.key].outB).toBe(50_000_000);
  });
  it('a sibling keeps its ratio while a neighbour on its destination waits for its deploy (rules round 2, the live 16:43–16:46Z minutes)', () => {
    // ws's route is committed as passthrough, but the workers still run its pack: its route series read reduced (the
    // estimate reads reshaped events low, like dc's: 51.9 of 68.4 MB), and SIEM receives dc 68.4 + ws 36.7 MB.
    const deploying: MetricsWindow = {
      ...w,
      outputs: { ...w.outputs, 'default:siem': { bytes: 105_100_000, events: 63_000 } },
      routesOut: { ...w.routesOut, 'default:r_ws': { bytes: 27_850_000, events: 22_000 } },
    };
    const before = attributeWindow([dc, ws, pay, k8s], w, { passthroughPipelines: pass });
    const during = attributeWindow([dc, ws, pay, k8s], deploying, { passthroughPipelines: pass });
    const ratio = (r: typeof during) => 1 - r[dc.key].outB / r[dc.key].inB;
    // dc's config never changed: its priced ratio stays within a point (pinning ws would have read 0.523).
    expect(Math.abs(ratio(during) - ratio(before))).toBeLessThan(0.01);
    // ws is split by its estimate, not pinned to out = in, and the destination still sums exactly.
    expect(during[ws.key].outB).toBeLessThan(during[ws.key].inB);
    expect(during[dc.key].outB + during[ws.key].outB).toBe(105_100_000);
    expect(during[ws.key].attribution).toBe('reconciled');
    // Once the workers run the passthrough (its estimate reads out ≥ in), it is pinned again.
    expect(before[ws.key].outB).toBe(before[ws.key].inB);
  });
  it('can be switched off', () => {
    const r = attributeWindow([dc], w, { reconcile: false });
    expect(r[dc.key].attribution).toBe('route');
  });

  describe('the destination gate reads the event counters (DECISIONS D56)', () => {
    // The live minute 2026-09-27T15:32Z (App QA): Payments API is the only flow into mrd_siem_apps and its events
    // match to the event (12,191 = 12,191), but Cribl's route out-byte estimate had drifted just past half of the
    // destination's exact counter (6,303,608 / 3,113,557 = 2.025). The old 0.5–2× byte guard skipped the destination,
    // so Meter Reader priced the flow at half what it delivered — still labelled 'reconciled'.
    const livePay = mk('mrd_payments_api', 'mrd_payments_api', 'mrd_pay_sample', 'mrd_siem_apps');
    const live = (routeOutBytes: number, destEvents = 12_191): MetricsWindow => ({
      windowStart: '2026-09-27T15:32:00.000Z',
      windowEnd: '2026-09-27T15:33:00.000Z',
      inputs: { 'default:mrd_payments_api': { bytes: 27_737_756, events: 24_380 } },
      outputs: { 'default:mrd_siem_apps': { bytes: 6_303_608, events: destEvents } },
      routesIn: { 'default:mrd_payments_api': { bytes: 27_737_756, events: 24_380 } },
      routesOut: { 'default:mrd_payments_api': { bytes: routeOutBytes, events: 12_191 } },
      has: { routeBytes: true, pipelineBytes: false },
    });

    it('reconciles the 15:32Z window: the same events, so the destination counter prices the flow (2.025× the estimate)', () => {
      const r = attributeWindow([livePay], live(3_113_557), { passthroughPipelines: new Set() })[livePay.key];
      expect(r.outB).toBe(6_303_608);
      expect(r.outE).toBe(12_191);
      expect(r.inB).toBe(27_737_756);
      expect(r.attribution).toBe('reconciled');
      // a 1.2 % change in the estimate no longer doubles the priced bytes out: both sides of the old cliff agree
      expect(attributeWindow([livePay], live(3_151_805), { passthroughPipelines: new Set() })[livePay.key].outB).toBe(6_303_608);
    });

    it('reconciles within 1 % of the events (counter skew), and one event on a small destination', () => {
      expect(attributeWindow([livePay], live(3_113_557, 12_191 + 120), {})[livePay.key].outB).toBe(6_303_608);
      const tiny: MetricsWindow = {
        ...live(1_000),
        inputs: { 'default:mrd_payments_api': { bytes: 5_000, events: 10 } },
        outputs: { 'default:mrd_siem_apps': { bytes: 3_000, events: 6 } },
        routesIn: { 'default:mrd_payments_api': { bytes: 5_000, events: 10 } },
        routesOut: { 'default:mrd_payments_api': { bytes: 1_000, events: 5 } },
      };
      expect(attributeWindow([livePay], tiny, {})[livePay.key]).toMatchObject({ outB: 3_000, attribution: 'reconciled' });
    });

    it('keeps the estimate, labelled route, when the destination counts more events than its flows sent (other traffic)', () => {
      // within the old byte band (1.5×), but 30 % more events than the flow sent: unmetered traffic reaches it
      const noisy = live(4_202_405, 15_850);
      const r = attributeWindow([livePay], noisy, {})[livePay.key];
      expect(r.outB).toBe(4_202_405);
      expect(r.attribution).toBe('route');
      // its bytes in are still the Source's exact counter
      expect(r.inB).toBe(27_737_756);
    });

    it('falls back to the 0.5–2× byte band without event counts, or with fewer events than routed (drops)', () => {
      const noEvents: MetricsWindow = { ...live(3_113_557, 0) };
      expect(attributeWindow([livePay], noEvents, {})[livePay.key]).toMatchObject({ outB: 3_113_557, attribution: 'route' });
      expect(attributeWindow([livePay], live(4_000_000, 0), {})[livePay.key]).toMatchObject({ outB: 6_303_608, attribution: 'reconciled' });
      // fewer events delivered than routed: the band decides (inside it here)
      expect(attributeWindow([livePay], live(4_000_000, 9_000), {})[livePay.key]).toMatchObject({ outB: 6_303_608, attribution: 'reconciled' });
    });

    it('labels a flow reconciled only when its bytes out were: a destination with no counter keeps the estimate label', () => {
      const r = attributeWindow([dc, ws, pay, k8s], { ...w, outputs: { 'default:siem': w.outputs!['default:siem'] } }, { passthroughPipelines: pass });
      expect(r[pay.key].inB).toBe(27_800_000); // the Source side is still exact
      expect(r[pay.key].attribution).toBe('route');
      expect(r[k8s.key].attribution).toBe('route');
      expect(r[dc.key].attribution).toBe('reconciled');
      expect(r[ws.key].attribution).toBe('reconciled');
    });

    it('reconciles every destination of the live rig at 15:32Z: SIEM (prod) 113,390 events = 41,091 + 21,923 + 50,376', () => {
      const a = mk('mrd_windows_dc', 'r_dc', 'mrd_win_pack', 'mrd_siem_prod');
      const b = mk('mrd_windows_workstations', 'r_ws', 'pack:cribl_splunk_forwarder_windows_xml_events_to_json', 'mrd_siem_prod');
      const c = mk('mrd_pan_firewall', 'r_pan', 'pack:cribl-palo-alto-networks', 'mrd_siem_prod');
      const win: MetricsWindow = {
        windowStart: '2026-09-27T15:32:00.000Z',
        windowEnd: '2026-09-27T15:33:00.000Z',
        inputs: { 'default:mrd_windows_dc': { bytes: 100_000_000, events: 41_091 }, 'default:mrd_windows_workstations': { bytes: 50_000_000, events: 21_923 }, 'default:mrd_pan_firewall': { bytes: 40_000_000, events: 50_376 } },
        outputs: { 'default:mrd_siem_prod': { bytes: 110_000_000, events: 113_390 } },
        routesIn: { 'default:r_dc': { bytes: 100_000_000, events: 41_091 }, 'default:r_ws': { bytes: 50_000_000, events: 21_923 }, 'default:r_pan': { bytes: 40_000_000, events: 50_376 } },
        // estimates 30 % low overall (a reshaped estimate), still inside the old band: reconciled either way
        routesOut: { 'default:r_dc': { bytes: 40_000_000, events: 41_091 }, 'default:r_ws': { bytes: 25_000_000, events: 21_923 }, 'default:r_pan': { bytes: 20_000_000, events: 50_376 } },
        has: { routeBytes: true, pipelineBytes: false },
      };
      const r = attributeWindow([a, b, c], win, {});
      expect(r[a.key].outB + r[b.key].outB + r[c.key].outB).toBe(110_000_000);
      expect([a, b, c].every((f) => r[f.key].attribution === 'reconciled')).toBe(true);
    });
  });
  it('finds passthrough pipelines in the inventory (no enabled functions, not a pack)', () => {
    const inv = { schemaVersion: 1, updatedAt: '', hash: '', byGroup: { default: { inputs: [], outputs: [], routes: [], pipelines: [
      { id: 'passthru', functions: [] }, { id: 'off', functions: [{ id: 'eval', disabled: true }] }, { id: 'live', functions: [{ id: 'eval' }] }, { id: 'pk', functions: [], packId: 'x' },
      // an installed Pack as GET /pipelines lists it, from an inventory stored before packId was parsed
      { id: 'pack:cribl-palo-alto-networks', functions: [] },
    ] } } } as const;
    expect([...passthroughPipelines(inv as never)].sort()).toEqual(['default:off', 'default:passthru']);
  });
  it('a route on a Pack keeps the savings the Pack makes (live regression 2026-09-27: it read 0 %)', () => {
    // The live shape: GET /pipelines lists the installed Pack as { id: 'pack:…', conf: { pack: true } }.
    const pipelines = normalizePipelines({ items: [{ id: 'pack:cribl-palo-alto-networks', conf: { pack: true } }, { id: 'mrd_passthrough', conf: { functions: [] } }] });
    const inv = { schemaVersion: 1, updatedAt: '', hash: '', byGroup: { default: { inputs: [], outputs: [], routes: [], pipelines } } };
    const pass = passthroughPipelines(inv as never);
    expect([...pass]).toEqual(['default:mrd_passthrough']);
    const pan = mk('pan', 'r_pan', 'pack:cribl-palo-alto-networks', 'siem');
    const win: MetricsWindow = {
      windowStart: '2026-09-27T14:30:00.000Z', windowEnd: '2026-09-27T14:31:00.000Z',
      inputs: { 'default:pan': { bytes: 100_000_000, events: 1000 } },
      outputs: { 'default:siem': { bytes: 55_000_000, events: 1000 } },
      routesIn: { 'default:r_pan': { bytes: 100_000_000, events: 1000 } },
      routesOut: { 'default:r_pan': { bytes: 48_000_000, events: 1000 } },
      has: { routeBytes: true, pipelineBytes: false },
    };
    const r = attributeWindow([pan], win, { passthroughPipelines: pass });
    expect(r[pan.key].inB).toBe(100_000_000);
    expect(r[pan.key].outB).toBe(55_000_000); // the destination's exact bytes, not pinned to in
  });
});
