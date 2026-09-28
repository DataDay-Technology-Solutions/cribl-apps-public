import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type {
  BaselinesDoc,
  CriblHttp,
  DemoState,
  FlowFigures,
  Headline,
  HttpResult,
  Incident,
  IncidentsDoc,
  InventoryDoc,
  KvStore,
  Logger,
  Meta,
  NotifyLogDoc,
  PricesDoc,
  RollDayDoc,
  RollHourDoc,
  RollMinuteDoc,
  Settings,
  Snapshot,
  TimelineDoc,
  TotalsDoc,
} from '../../core/types.ts';
import { fnv1a, identityCodec, toBase64, webCodec } from '../../core/codec.ts';
import { createCountingHttp, type FetchLike, type FetchInit } from '../../core/http.ts';
import {
  assertValidKey,
  CHUNK_CHARS,
  CHUNK_THRESHOLD_BYTES,
  chunkKey,
  createFetchKvStore,
  createHttpKvStore,
  createKvDocs,
  createMemoryKvStore,
  incidentsKey,
  isChunkKey,
  isChunkManifest,
  KEYS,
  KV_VALUE_CAP_BYTES,
  KvDocTooLarge,
  KvHttpError,
  normalizeKeyList,
  PREFIXES,
  rollDayKey,
  rollHourKey,
  rollMinuteKey,
  unwrapKvText,
  type KvDocsDeps,
  type MemoryKvStore,
} from '../../core/kv.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────
const T = '2026-09-26T03:20:00.000Z';
const NOW = Date.parse(T);
const clock = (start = NOW) => {
  let t = start;
  return { now: () => t, set: (ms: number) => void (t = ms), advance: (ms: number) => void (t += ms) };
};

function capture(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, info: () => undefined, warn: (m) => void warnings.push(m), error: () => undefined };
}

const settings = (): Settings => ({
  schemaVersion: 1,
  updatedAt: T,
  displayTimezone: 'America/Chicago',
  headlinePeriodDefault: 'mtd',
  presenter: { headlinePeriod: 'annualized' },
  live: { pollSeconds: 10, presenterPollSeconds: 5 },
  budgets: {},
  thresholds: {
    regressionPoints: 15,
    regressionMinutes: 3,
    regressionCommitWindowMin: 30,
    spikeSigma: 3,
    spikeMinutes: 2,
    spikeMinCentsPerHour: 500,
    budgetWarnPct: 90,
    budgetAlertPct: 100,
    goodNewsPoints: 15,
    cooldownMinutes: 60,
    ewmaAlpha: 0.0014,
    warmupSamples: 10,
    recoveryMinutes: 5,
  },
  goodNewsEnabled: false,
  excludedObjectKeys: [],
  includeInternal: false,
  notifications: [],
  humanize: {},
  demo: { enabled: false, replayMode: false, profile: true },
  runtime: 'ui',
});
const prices = (): PricesDoc => ({
  schemaVersion: 1,
  updatedAt: T,
  versions: [{ effectiveFrom: T, byOutputId: { mrd_siem_prod: { milliCentsPerGb: 250_000, preset: 'splunk_cloud' } } }],
});
const headline: Headline = {
  todayM: 1,
  mtdM: 2,
  d30M: 3,
  annualizedM: 4,
  annualizedFromDays: 1,
  whpMtdM: 5,
  paidMtdM: 6,
  ratioMtd: 0.5,
  whpTodayM: 7,
  paidTodayM: 8,
  whp30dM: 9,
  paid30dM: 10,
};
function flow(i: number, pad = ''): FlowFigures {
  return {
    key: `default|mrd_in_${i}|mrd_r_${i}|mrd_p_${i}|mrd_siem_prod${pad}`,
    groupId: 'default',
    inputId: `mrd_in_${i}`,
    routeId: `mrd_r_${i}`,
    pipelineId: `mrd_p_${i}`,
    outputId: 'mrd_siem_prod',
    inB: 1_000_000 + i,
    outB: 500_000 + i,
    whpM: 250_000 + i,
    paidM: 125_000 + i,
    savedM: 125_000,
    ratio: 0.5,
    ratePerHourM: 7_500_000,
    savedPerDayM: 180_000_000,
    whpPerDayM: 360_000_000,
    paidPerDayM: 180_000_000,
    inBPerDay: 1_440_000_000,
    outBPerDay: 720_000_000,
    attribution: 'route',
    sparkline: Array.from({ length: 12 }, (_, k) => (k * 37 + i) % 100),
    state: 'ok',
  };
}
const snapshot = (flows: FlowFigures[] = [flow(1)]): Snapshot => ({
  schemaVersion: 1,
  sweepAt: T,
  windowStart: T,
  windowEnd: T,
  mode: 'ui',
  headline,
  ratePerSecM: 12,
  flows,
  destinations: [],
  topSavers: [],
  unpricedOutputIds: [],
  openIncidents: 0,
  incidents: [],
  trend: [],
  ratioSeries: [],
  timeline: [],
  deliveries: [],
  calls: 17,
  collectingSince: T,
  metricsSource: 'metrics-query',
  attributionSummary: 'route',
});
const inventory = (): InventoryDoc => ({
  schemaVersion: 1,
  updatedAt: T,
  hash: 'abcd1234',
  byGroup: { default: { inputs: [{ id: 'mrd_payments_api', type: 'datagen' }], outputs: [], pipelines: [], routes: [], routeTableId: 'default' } },
});
const baselines = (): BaselinesDoc => ({ schemaVersion: 1, updatedAt: T, byObject: { 'pipe:default:mrd_pay_sample': { mean: 0.75, variance: 0.001, samples: 20, warm: [] } }, rules: {} });
const timeline = (): TimelineDoc => ({
  schemaVersion: 1,
  updatedAt: T,
  byGroup: { default: [{ hash: 'a1f3c9e', message: 'demo: break the trim on mrd_pay_sample', author: 's', committedAt: T, groupId: 'default', files: [], source: 'demo' }] },
});
const notifyLog = (): NotifyLogDoc => ({ schemaVersion: 1, items: [{ endpointId: 'ep1', event: 'test', status: 200, attempt: 1, at: T }] });
const demoState = (): DemoState => ({ schemaVersion: 1, routes: {}, measuredLagSec: 240, trim: {}, rates: {}, muted: {} });
const meta = (): Meta => ({
  schemaVersion: 1,
  installedAt: T,
  collectingSince: T,
  appVersion: '1.0.0',
  build: 'release',
  metricsSource: 'metrics-query',
  sweepErrors: 0,
  consecutiveRateLimited: 0,
  sweepCount: 3,
});
const totals = (): TotalsDoc => ({ schemaVersion: 1, updatedAt: T, byDay: { '2026-09-26': { whpM: 1, paidM: 1, savedM: 0, minutes: 1 } } });
const minuteDoc = (): RollMinuteDoc => ({
  schemaVersion: 1,
  bucketStart: '2026-09-26T03:00:00.000Z',
  flows: { 'default|a|b|c|d': [{ t: T, inB: 1, outB: 1, inE: 1, outE: 1, whpM: 1, paidM: 1, savedM: 0 }] },
});
const hourDoc = (): RollHourDoc => ({ schemaVersion: 1, day: '2026-09-26', flows: { k: [{ t: T, inB: 1, outB: 1, whpM: 1, paidM: 1, savedM: 0, samples: 60 }] } });
const dayDoc = (): RollDayDoc => ({ schemaVersion: 1, month: '2026-09', flows: { k: [{ t: T, inB: 1, outB: 1, whpM: 1, paidM: 1, savedM: 0 }] } });
const incident = (id: string): Incident => ({
  id,
  type: 'regression',
  severity: 'high',
  objectKey: 'pipe:default:mrd_pay_sample',
  label: 'Payments API sampling',
  openedAt: T,
  before: 0.75,
  after: 0.5,
  impactPerDayM: 2_500_000,
  notes: [],
  deliveries: [],
});
const incidents = (): IncidentsDoc => ({ schemaVersion: 1, items: [incident('inc_1')] });

function docs(overrides: Partial<KvDocsDeps> = {}) {
  const kv = (overrides.kv as MemoryKvStore | undefined) ?? createMemoryKvStore();
  const logger = capture();
  const d = createKvDocs({ kv, codec: webCodec, clock: clock(), logger, ...overrides });
  return { kv: kv as MemoryKvStore, logger, d };
}

/** A snapshot whose JSON is ≈ `bytes` long, with enough entropy that gzip still needs several chunks. */
function bigSnapshot(bytes: number): Snapshot {
  const flows: FlowFigures[] = [];
  let x = 1;
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    const f = flow(i, `_${x.toString(36)}${(x ^ 0x5bd1e995).toString(36)}`);
    flows.push(f);
    size += JSON.stringify(f).length + 1;
  }
  return snapshot(flows);
}

// ─── Keys ────────────────────────────────────────────────────────────────────
describe('keys', () => {
  it('uses "/" separators everywhere', () => {
    expect(KEYS).toMatchObject({ notifyLog: 'notify/log', lock: 'lock/meter', demoState: 'demo/state', tour: 'tour/active' });
    for (const k of [...Object.values(KEYS), ...Object.values(PREFIXES)]) expect(k).not.toMatch(/[:|]/);
    expect(PREFIXES).toEqual({ rollMin: 'roll/min/', rollHour: 'roll/hour/', rollDay: 'roll/day/', incidents: 'incidents/' });
  });
  it('builds dated keys from epoch ms or ISO', () => {
    expect(rollMinuteKey(NOW)).toBe('roll/min/2026-09-26T03');
    expect(rollMinuteKey('2026-09-26T03:59:59.999Z')).toBe('roll/min/2026-09-26T03');
    expect(rollHourKey(T)).toBe('roll/hour/2026-09-26');
    expect(rollDayKey(T)).toBe('roll/day/2026-09');
    expect(incidentsKey(NOW)).toBe('incidents/2026-09-26');
    expect(() => rollMinuteKey('not a date')).toThrow(RangeError);
  });
  it('validates keys and recognizes chunk keys', () => {
    for (const ok of ['settings', 'roll/min/2026-09-26T03', 'a_b-c.d/e']) expect(() => assertValidKey(ok)).not.toThrow();
    for (const bad of ['', 'demo:state', 'a|b', '/lead', 'trail/', 'a//b', 'sp ace']) expect(() => assertValidKey(bad)).toThrow(/invalid KV key/);
    expect(chunkKey('snapshot', 3)).toBe('snapshot/c/3');
    expect(isChunkKey('snapshot/c/12')).toBe(true);
    expect(isChunkKey('snapshot/cx/1')).toBe(false);
    expect(isChunkKey('roll/min/2026-09-26T03')).toBe(false);
  });
  it('constants match the measured platform cap', () => {
    expect(KV_VALUE_CAP_BYTES).toBe(100_000);
    expect(CHUNK_THRESHOLD_BYTES).toBe(90_000);
    expect(CHUNK_CHARS).toBe(90_000);
  });
});

// ─── Memory store ────────────────────────────────────────────────────────────
describe('createMemoryKvStore', () => {
  it('stores, lists by prefix, deletes and logs every op', async () => {
    const kv = createMemoryKvStore({ initial: { 'b/1': '1' } });
    await kv.put('a/2', '2');
    await kv.put('a/1', '1');
    expect(await kv.get('a/1')).toBe('1');
    expect(await kv.get('nope')).toBeNull();
    expect(await kv.list('a/')).toEqual(['a/1', 'a/2']);
    await kv.del('a/1');
    await kv.del('never');
    expect(await kv.list('')).toEqual(['a/2', 'b/1']);
    expect(kv.ops.map((o) => o.op)).toEqual(['put', 'put', 'get', 'get', 'list', 'del', 'del', 'list']);
  });
  it('rejects values over 100 KB (in UTF-8 bytes) with a 413', async () => {
    const kv = createMemoryKvStore();
    await kv.put('ok', 'x'.repeat(100_000));
    const err = await kv.put('big', '€'.repeat(40_000)).catch((e: unknown) => e); // 40k chars, 120 KB
    expect(err).toBeInstanceOf(KvHttpError);
    expect(err).toMatchObject({ status: 413, op: 'PUT', key: 'big' });
    expect(kv.data.has('big')).toBe(false);
  });
});

// ─── HTTP store ──────────────────────────────────────────────────────────────
describe('createHttpKvStore', () => {
  function fakeHttp(reply: (method: string, path: string, body: unknown) => HttpResult) {
    const calls: { method: string; path: string; body: unknown; raw?: boolean }[] = [];
    const http: CriblHttp = {
      async request(method, path, body, opts) {
        calls.push({ method, path, body, raw: opts?.raw });
        return reply(method, path, body);
      },
    };
    return { http, calls };
  }

  it('GETs raw text at /kvstore/<key> with each segment encoded; 404 → null', async () => {
    const { http, calls } = fakeHttp((_m, path) =>
      path.endsWith('missing') ? { status: 404, ok: false, text: '{"status":"error","message":"Key not found"}' } : { status: 200, ok: true, text: '{"a":1}' },
    );
    const kv = createHttpKvStore(http);
    expect(await kv.get('roll/min/2026-09-26T03')).toBe('{"a":1}');
    expect(await kv.get('x/missing')).toBeNull();
    expect(calls[0]).toEqual({ method: 'GET', path: '/kvstore/roll/min/2026-09-26T03', body: undefined, raw: true });
    await kv.get('odd key/é');
    expect(calls[2].path).toBe('/kvstore/odd%20key/%C3%A9');
  });

  it('tolerates a JSON-string-wrapped value and a JSON-parsed transport answer', async () => {
    const answers: HttpResult[] = [
      { status: 200, ok: true, text: JSON.stringify('{"a":1}') },
      { status: 200, ok: true, text: '"H4sIAAAA"' },
      { status: 200, ok: true, json: { b: 2 } },
      { status: 200, ok: true },
    ];
    const kv = createHttpKvStore(fakeHttp(() => answers.shift() as HttpResult).http);
    expect(await kv.get('k')).toBe('{"a":1}');
    expect(await kv.get('k')).toBe('"H4sIAAAA"'); // a chunk stays a JSON string
    expect(await kv.get('k')).toBe('{"b":2}');
    expect(await kv.get('k')).toBe('');
  });

  it('reads the UI proxy rejection for a never-written key as missing, and nothing else', async () => {
    const answers: HttpResult[] = [
      {
        status: 0,
        ok: false,
        text: `network_error: Failed to execute 'close' on 'ReadableStreamDefaultController': "[object Object]" is not valid JSON`,
      },
      { status: 0, ok: false, text: 'network_error: Failed to fetch' },
    ];
    const kv = createHttpKvStore(fakeHttp(() => answers.shift() as HttpResult).http);
    expect(await kv.get('settings')).toBeNull();
    await expect(kv.get('settings')).rejects.toMatchObject({ name: 'KvHttpError', status: 0 });
  });

  it('throws KvHttpError on unexpected statuses', async () => {
    const kv = createHttpKvStore(fakeHttp(() => ({ status: 500, ok: false, text: 'boom' })).http);
    await expect(kv.get('k')).rejects.toMatchObject({ name: 'KvHttpError', op: 'GET', status: 500 });
    await expect(kv.put('k', '{}')).rejects.toMatchObject({ op: 'PUT', status: 500 });
    await expect(kv.del('k')).rejects.toMatchObject({ op: 'DELETE', status: 500 });
    await expect(kv.list('p/')).rejects.toMatchObject({ op: 'LIST', status: 500 });
    await expect(createHttpKvStore(fakeHttp(() => ({ status: 413, ok: false })).http).put('k', 'x')).rejects.toThrow(/HTTP 413$/);
  });

  it('PUTs the value verbatim (raw text/plain) and never parses the empty 201', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 201, ok: true, text: '' }));
    await createHttpKvStore(http).put('settings', '{"schemaVersion":1}');
    expect(calls[0]).toEqual({ method: 'PUT', path: '/kvstore/settings', body: '{"schemaVersion":1}', raw: true });
  });

  it('DELETE treats 404 as already gone', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 404, ok: false }));
    await expect(createHttpKvStore(http).del('gone')).resolves.toBeUndefined();
    expect(calls[0].method).toBe('DELETE');
  });

  it('lists via POST /kvstore/keys {prefix} and accepts every observed shape', async () => {
    const shapes: HttpResult[] = [
      { status: 200, ok: true, json: ['roll/min/b', '/roll/min/a', 'other/x'] },
      { status: 200, ok: true, json: { items: ['roll/min/a'] } },
      { status: 200, ok: true, json: { items: [{ key: 'roll/min/a' }, { name: 'roll/min/b' }, { id: 'roll/min/c' }, { nope: 1 }, 7] } },
      { status: 200, ok: true, json: { keys: ['roll/min/z'] } },
      { status: 200, ok: true, text: '["roll/min/t"]' },
      { status: 200, ok: true, text: 'not json' },
      { status: 200, ok: true, json: { unexpected: true } },
    ];
    const { http, calls } = fakeHttp(() => shapes.shift() as HttpResult);
    const kv = createHttpKvStore(http);
    expect(await kv.list('roll/min/')).toEqual(['roll/min/a', 'roll/min/b']);
    expect(calls[0]).toEqual({ method: 'POST', path: '/kvstore/keys', body: { prefix: 'roll/min/' }, raw: undefined });
    expect(await kv.list('roll/min/')).toEqual(['roll/min/a']);
    expect(await kv.list('roll/min/')).toEqual(['roll/min/a', 'roll/min/b', 'roll/min/c']);
    expect(await kv.list('roll/min/')).toEqual(['roll/min/z']);
    expect(await kv.list('roll/min/')).toEqual(['roll/min/t']);
    expect(await kv.list('roll/min/')).toEqual([]);
    expect(await kv.list('roll/min/')).toEqual([]);
  });

  it('normalizeKeyList and unwrapKvText edge cases', () => {
    expect(normalizeKeyList(null, '')).toEqual([]);
    expect(normalizeKeyList({ data: ['a', 'a', '/b', ''] }, '')).toEqual(['a', 'b']);
    expect(unwrapKvText('plain')).toBe('plain');
    expect(unwrapKvText('"not json')).toBe('"not json');
    expect(unwrapKvText(JSON.stringify('[1]'))).toBe('[1]');
    expect(unwrapKvText(JSON.stringify(JSON.stringify('x')))).toBe('"x"');
  });

  it('KV calls count against the sweep budget when built on the counting transport', async () => {
    const { http } = fakeHttp(() => ({ status: 200, ok: true, text: '{}' }));
    const counting = createCountingHttp(http, { budget: 2, clock: clock() });
    const kv = createHttpKvStore(counting);
    await kv.get('a');
    await kv.put('b', '{}');
    await expect(kv.get('c')).rejects.toMatchObject({ name: 'BudgetExceeded' });
    expect(counting.calls()).toBe(2);
  });
});

describe('createFetchKvStore', () => {
  it('talks to <base>/kvstore/<key> with text/plain PUT bodies', async () => {
    const seen: { url: string; init?: FetchInit }[] = [];
    const data = new Map<string, string>();
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, init });
      const key = url.replace('https://leader.example/api/v1/kvstore/', '');
      if (init?.method === 'PUT') {
        data.set(key, init.body ?? '');
        return { status: 201, ok: true, text: async () => '' };
      }
      const v = data.get(key);
      return v === undefined
        ? { status: 404, ok: false, text: async () => '{"status":"error","message":"Key not found"}' }
        : { status: 200, ok: true, text: async () => v };
    };
    const kv = createFetchKvStore({ fetch, baseUrl: 'https://leader.example/api/v1' });
    expect(await kv.get('meta')).toBeNull();
    await kv.put('meta', '{"schemaVersion":1}');
    expect(await kv.get('meta')).toBe('{"schemaVersion":1}');
    expect(seen[1].init).toMatchObject({ method: 'PUT', headers: { 'content-type': 'text/plain' }, body: '{"schemaVersion":1}' });
  });
});

// ─── Typed documents ─────────────────────────────────────────────────────────
describe('createKvDocs: typed round-trips', () => {
  it('round-trips every document type', async () => {
    const { d, kv, logger } = docs();
    await d.putSettings(settings());
    await d.putPrices(prices());
    await d.putSnapshot(snapshot());
    await d.putInventory(inventory());
    await d.putBaselines(baselines());
    await d.putTimeline(timeline());
    await d.putNotifyLog(notifyLog());
    await d.putDemoState(demoState());
    await d.putMeta(meta());
    await d.putTotals(totals());
    await d.putRollMinute('roll/min/2026-09-26T03', minuteDoc());
    await d.putRollHour('2026-09-26', hourDoc());
    await d.putRollDay('roll/day/2026-09', dayDoc());
    await d.putIncidents('2026-09-26', incidents());

    expect(await d.getSettings()).toEqual(settings());
    expect(await d.getPrices()).toEqual(prices());
    expect(await d.getSnapshot()).toEqual(snapshot());
    expect(await d.getInventory()).toEqual(inventory());
    expect(await d.getBaselines()).toEqual(baselines());
    expect(await d.getTimeline()).toEqual(timeline());
    expect(await d.getNotifyLog()).toEqual(notifyLog());
    expect(await d.getDemoState()).toEqual(demoState());
    expect(await d.getMeta()).toEqual(meta());
    expect(await d.getTotals()).toEqual(totals());
    expect(await d.getRollMinute('2026-09-26T03')).toEqual(minuteDoc());
    expect(await d.getRollHour('roll/hour/2026-09-26')).toEqual(hourDoc());
    expect(await d.getRollDay('2026-09')).toEqual(dayDoc());
    expect(await d.getIncidents('incidents/2026-09-26')).toEqual(incidents());

    expect([...kv.data.keys()].sort()).toEqual(
      [
        'baselines',
        'demo/state',
        'incidents/2026-09-26',
        'inventory',
        'meta',
        'notify/log',
        'prices',
        'roll/day/2026-09',
        'roll/hour/2026-09-26',
        'roll/min/2026-09-26T03',
        'settings',
        'snapshot',
        'timeline',
        'totals',
      ].sort(),
    );
    expect(JSON.parse(kv.data.get('settings') as string)).toEqual(settings()); // stored as plain JSON text
    expect(logger.warnings).toEqual([]);
  });

  it('returns null for missing documents without warning', async () => {
    const { d, logger } = docs();
    expect(await d.getSettings()).toBeNull();
    expect(await d.getRollMinute('2026-01-01T00')).toBeNull();
    expect(logger.warnings).toEqual([]);
  });

  it('counts every KV call and can reset the count', async () => {
    const { d } = docs();
    await d.putMeta(meta());
    await d.getMeta();
    await d.listKeys('roll/');
    expect(d.calls()).toBe(3);
    d.resetCalls();
    expect(d.calls()).toBe(0);
  });
});

describe('createKvDocs: validation, repair and migration', () => {
  async function stored(raw: string) {
    const kv = createMemoryKvStore({ initial: { settings: raw, 'notify/log': raw, meta: raw } });
    return docs({ kv });
  }

  it('treats invalid JSON and "[object Object]" as missing, with a warning', async () => {
    for (const raw of ['{broken', '[object Object]', ' [object Object] ']) {
      const { d, logger } = await stored(raw);
      expect(await d.getSettings()).toBeNull();
      expect(logger.warnings[0]).toMatch(/not valid JSON/);
    }
  });

  it('treats a wrong shape, a non-object and a bad schemaVersion as missing', async () => {
    const cases: [unknown, RegExp][] = [
      [{ schemaVersion: 1, displayTimezone: 'UTC' }, /failed shape validation/],
      [[1, 2], /not a JSON object/],
      ['just a string', /not a JSON object/],
      [{ ...settings(), schemaVersion: 'one' }, /invalid schemaVersion/],
      [{ ...settings(), schemaVersion: -1 }, /invalid schemaVersion/],
      [{ ...settings(), schemaVersion: 2 }, /newer than this build/],
      [{ ...settings(), runtime: 'server' }, /failed shape validation/],
    ];
    for (const [value, msg] of cases) {
      const { d, logger } = await stored(JSON.stringify(value));
      expect(await d.getSettings()).toBeNull();
      expect(logger.warnings.join('\n')).toMatch(msg);
    }
  });

  it('migrates an unversioned legacy document to schemaVersion 1', async () => {
    const legacy: Record<string, unknown> = { ...meta() };
    delete legacy.schemaVersion;
    const { d } = await stored(JSON.stringify(legacy));
    expect(await d.getMeta()).toEqual(meta());
  });

  it('unwraps one level of double-encoded JSON', async () => {
    const { d } = await stored(JSON.stringify(JSON.stringify(meta())));
    expect(await d.getMeta()).toEqual(meta());
  });

  it('repairs lists by dropping malformed entries', async () => {
    const kv = createMemoryKvStore({
      initial: {
        'notify/log': JSON.stringify({ schemaVersion: 1, items: [notifyLog().items[0], null, { status: 1 }] }),
        'incidents/2026-09-26': JSON.stringify({ schemaVersion: 1, items: [incident('a'), 'x', { id: 7 }] }),
        timeline: JSON.stringify({ ...timeline(), byGroup: { default: [timeline().byGroup.default[0], { message: 'no hash' }], other: 'bad' } }),
      },
    });
    const { d, logger } = docs({ kv });
    expect((await d.getNotifyLog())?.items).toHaveLength(1);
    expect((await d.getIncidents('2026-09-26'))?.items.map((i) => i.id)).toEqual(['a']);
    expect(await d.getTimeline()).toBeNull(); // byGroup.other is not a list: unrepairable
    expect(logger.warnings.filter((w) => /dropped \d+ malformed/.test(w))).toHaveLength(3);
  });

  it('refuses to write invalid documents or keys', async () => {
    const { d, kv } = docs();
    await expect(d.putSettings({ ...settings(), notifications: 'nope' } as unknown as Settings)).rejects.toThrow(TypeError);
    await expect(d.putMeta({ ...meta(), schemaVersion: 2 } as unknown as Meta)).rejects.toThrow(/invalid meta/);
    await expect(d.putRollMinute('2026:09', minuteDoc())).rejects.toThrow(/invalid KV key/);
    await expect(d.putDoc('a|b', {})).rejects.toThrow(/invalid KV key/);
    await expect(d.putDoc('ok', undefined)).rejects.toThrow(/non-JSON value/);
    expect(kv.data.size).toBe(0);
  });

  it('each guard rejects its own broken shape', async () => {
    const broken: [string, unknown, (x: ReturnType<typeof createKvDocs>) => Promise<unknown>][] = [
      ['prices', { schemaVersion: 1, versions: [{ effectiveFrom: 1 }] }, (x) => x.getPrices()],
      ['snapshot', { schemaVersion: 1, sweepAt: T, headline: {}, flows: {} }, (x) => x.getSnapshot()],
      ['inventory', { schemaVersion: 1, hash: 'h', byGroup: { default: { inputs: [] } } }, (x) => x.getInventory()],
      ['baselines', { schemaVersion: 1, byObject: {} }, (x) => x.getBaselines()],
      ['demo/state', { schemaVersion: 1, routes: {}, trim: {}, rates: {}, muted: {} }, (x) => x.getDemoState()],
      ['totals', { schemaVersion: 1 }, (x) => x.getTotals()],
      ['roll/min/x', { schemaVersion: 1, bucketStart: T, flows: { k: {} } }, (x) => x.getRollMinute('x')],
      ['roll/hour/x', { schemaVersion: 1, flows: {} }, (x) => x.getRollHour('x')],
      ['roll/day/x', { schemaVersion: 1, month: '2026-09' }, (x) => x.getRollDay('x')],
      ['incidents/x', { schemaVersion: 1, items: {} }, (x) => x.getIncidents('x')],
    ];
    for (const [key, value, read] of broken) {
      const { d, logger } = docs({ kv: createMemoryKvStore({ initial: { [key]: JSON.stringify(value) } }) });
      expect(await read(d)).toBeNull();
      expect(logger.warnings.join()).toMatch(/failed shape validation/);
    }
  });
});

// ─── Chunking ────────────────────────────────────────────────────────────────
describe('createKvDocs: transparent chunking', () => {
  it('round-trips a 1 MB snapshot as gzip+base64 chunks, every value under the 100 KB cap', async () => {
    const { d, kv, logger } = docs();
    const doc = bigSnapshot(1_000_000);
    const json = JSON.stringify(doc);
    expect(json.length).toBeGreaterThan(1_000_000);
    await d.putSnapshot(doc);

    const manifest = JSON.parse(kv.data.get('snapshot') as string);
    expect(isChunkManifest(manifest)).toBe(true);
    expect(manifest).toMatchObject({ schemaVersion: 1, chunked: true, encoding: 'gzip-base64', bytes: json.length, sha: fnv1a(json), updatedAt: T });
    expect(manifest.chunks).toBeGreaterThanOrEqual(2);
    const chunkKeys = [...kv.data.keys()].filter((k) => k.startsWith('snapshot/c/'));
    expect(chunkKeys.sort()).toEqual(Array.from({ length: manifest.chunks }, (_, i) => `snapshot/c/${i}`).sort());
    for (const k of chunkKeys) {
      const v = kv.data.get(k) as string;
      expect(v.length).toBeLessThanOrEqual(CHUNK_CHARS + 2);
      expect(typeof JSON.parse(v)).toBe('string'); // chunks are JSON strings
    }
    // Chunks first, manifest last.
    const puts = kv.ops.filter((o) => o.op === 'put').map((o) => o.key);
    expect(puts[puts.length - 1]).toBe('snapshot');
    expect(puts.slice(0, -1).every((k) => k.startsWith('snapshot/c/'))).toBe(true);

    const fresh = createKvDocs({ kv, codec: webCodec, clock: clock() });
    expect(await fresh.getSnapshot()).toEqual(doc);
    expect(logger.warnings).toEqual([]);
  });

  it('chunks on UTF-8 bytes, not characters', async () => {
    const { d, kv } = docs({ codec: identityCodec });
    const doc = { ...meta(), lastError: '€'.repeat(35_000) }; // ~35k chars, ~105 KB
    await d.putMeta(doc);
    expect(isChunkManifest(JSON.parse(kv.data.get('meta') as string))).toBe(true);
    expect(await d.getMeta()).toEqual(doc);
  });

  it('with the identity codec labels chunks identity-base64, readable by a gzip instance', async () => {
    const { d, kv } = docs({ codec: identityCodec });
    const doc = bigSnapshot(300_000);
    await d.putSnapshot(doc);
    const manifest = JSON.parse(kv.data.get('snapshot') as string);
    expect(manifest.encoding).toBe('identity-base64');
    expect(manifest.chunks).toBe(Math.ceil(Math.ceil((manifest.bytes * 4) / 3 / 4) * 4 / CHUNK_CHARS));
    expect(await createKvDocs({ kv, codec: webCodec, clock: clock() }).getSnapshot()).toEqual(doc);
  });

  it('an identity-only reader cannot decode gzip chunks and reports the document missing', async () => {
    const { d, kv } = docs();
    await d.putSnapshot(bigSnapshot(200_000));
    const logger = capture();
    const reader = createKvDocs({ kv, codec: identityCodec, clock: clock(), logger });
    expect(await reader.getSnapshot()).toBeNull();
    expect(logger.warnings.join()).toMatch(/cannot decode gzip-base64 with an identity codec/);
  });

  it('accepts a bare (unquoted) base64 chunk', async () => {
    const { d, kv } = docs({ codec: identityCodec, chunkThresholdBytes: 10, chunkChars: 16 });
    await d.putMeta(meta());
    kv.data.set('meta/c/0', JSON.parse(kv.data.get('meta/c/0') as string));
    expect(await d.getMeta()).toEqual(meta());
  });

  describe('corrupt chunked documents read as missing', () => {
    async function chunked() {
      const ctx = docs({ codec: identityCodec, chunkThresholdBytes: 50, chunkChars: 64 });
      await ctx.d.putMeta(meta());
      const manifest = JSON.parse(ctx.kv.data.get('meta') as string);
      expect(manifest.chunks).toBeGreaterThan(3);
      return { ...ctx, manifest };
    }
    it('hash mismatch', async () => {
      const { d, kv, logger, manifest } = await chunked();
      kv.data.set('meta', JSON.stringify({ ...manifest, sha: '00000000' }));
      expect(await d.getMeta()).toBeNull();
      expect(logger.warnings.join()).toMatch(/failed verification \(hash mismatch\)/);
    });
    it('missing chunk', async () => {
      const { d, kv, logger } = await chunked();
      kv.data.delete('meta/c/1');
      expect(await d.getMeta()).toBeNull();
      expect(logger.warnings.join()).toMatch(/chunk 1 of \d+ is missing/);
    });
    it('non-base64 chunk, non-string chunk, invalid JSON chunk', async () => {
      for (const bad of [JSON.stringify('$$$$'), '{"x":1}', '"unterminated']) {
        const { d, kv, logger } = await chunked();
        kv.data.set('meta/c/0', bad);
        expect(await d.getMeta()).toBeNull();
        expect(logger.warnings.join()).toMatch(/chunks do not decode/);
      }
    });
    it('malformed manifests', async () => {
      for (const patch of [{ chunks: 0 }, { chunks: 1.5 }, { chunks: 10_000 }, { encoding: 'br-base64' }, { sha: undefined }]) {
        const { d, kv, logger, manifest } = await chunked();
        kv.data.set('meta', JSON.stringify({ ...manifest, ...patch }));
        expect(await d.getMeta()).toBeNull();
        expect(logger.warnings.join()).toMatch(/malformed chunk manifest/);
      }
    });
    it('reassembled text that is not JSON', async () => {
      const { d, kv, logger } = docs();
      const text = 'not json at all';
      const b64 = toBase64(await webCodec.gzip(text));
      kv.data.set('meta', JSON.stringify({ schemaVersion: 1, chunked: true, encoding: 'gzip-base64', chunks: 1, bytes: text.length, sha: fnv1a(text) }));
      kv.data.set('meta/c/0', JSON.stringify(b64));
      expect(await d.getMeta()).toBeNull();
      expect(logger.warnings.join()).toMatch(/reassembled document is not valid JSON/);
    });
  });

  describe('reader racing a writer', () => {
    /** A store that swaps in `next` right after the first read of `key` (a writer finishing mid-read). */
    function racing(base: Map<string, string>, key: string, next: Map<string, string>): MemoryKvStore {
      const inner = createMemoryKvStore();
      for (const [k, v] of base) inner.data.set(k, v);
      let swapped = false;
      return {
        ...inner,
        async get(k) {
          const v = await inner.get(k);
          if (k === key && !swapped) {
            swapped = true;
            inner.data.clear();
            for (const [nk, nv] of next) inner.data.set(nk, nv);
          }
          return v;
        },
      };
    }
    const small = { codec: identityCodec, chunkThresholdBytes: 50, chunkChars: 64 } as const;
    async function written(value: Meta | null, extra: (d: ReturnType<typeof createKvDocs>) => Promise<void> = async () => undefined) {
      const kv = createMemoryKvStore();
      const d = createKvDocs({ kv, clock: clock(), ...small });
      if (value) await d.putMeta(value);
      await extra(d);
      return kv.data;
    }

    it('re-reads the manifest once and returns the new generation', async () => {
      const a = await written(meta());
      const b = await written({ ...meta(), sweepCount: 999, lastError: 'a longer error text to change the chunks' });
      const logger = capture();
      const d = createKvDocs({ kv: racing(a, 'meta', b), clock: clock(), logger, ...small });
      expect((await d.getMeta())?.sweepCount).toBe(999);
      expect(logger.warnings).toEqual([]);
    });

    it('returns a plain document that replaced the chunked one', async () => {
      const a = await written(meta());
      const b = new Map([['meta', JSON.stringify({ ...meta(), sweepCount: 5 })], ['meta/c/0', JSON.stringify('!!!!')]]);
      const d = createKvDocs({ kv: racing(a, 'meta', b), clock: clock(), ...small });
      expect((await d.getMeta())?.sweepCount).toBe(5);
    });

    it('returns null when the document vanished, or the manifest did not move', async () => {
      const a = await written(meta());
      expect(await createKvDocs({ kv: racing(a, 'meta', new Map()), clock: clock(), ...small }).getMeta()).toBeNull();
      const broken = new Map(a);
      broken.set('meta/c/0', JSON.stringify('AAAA'));
      const logger = capture();
      expect(await createKvDocs({ kv: racing(a, 'meta', broken), clock: clock(), logger, ...small }).getMeta()).toBeNull();
      expect(logger.warnings.join()).toMatch(/failed verification/);
      const garbage = new Map(broken);
      garbage.set('meta', '{oops');
      expect(await createKvDocs({ kv: racing(a, 'meta', garbage), clock: clock(), ...small }).getMeta()).toBeNull();
    });
  });

  describe('stale chunks: a write never DELETEs (rules round 2, AGENTS.md "Confirming Destructive Operations")', () => {
    const small = { codec: identityCodec, chunkThresholdBytes: 50, chunkChars: 64 } as const;
    const withError = (n: number): Meta => ({ ...meta(), lastError: 'e'.repeat(n) });
    const chunkKeysOf = (kv: MemoryKvStore) => [...kv.data.keys()].filter(isChunkKey).sort();

    it('a shorter chunked rewrite issues no DELETE and no LIST: the manifest bounds the read', async () => {
      const { d, kv } = docs(small);
      await d.putMeta(withError(600));
      const before = chunkKeysOf(kv).length;
      kv.ops.length = 0;
      await d.putMeta(withError(10));
      const after = JSON.parse(kv.data.get('meta') as string).chunks;
      expect(after).toBeLessThan(before);
      expect(kv.ops.filter((o) => o.op === 'del' || o.op === 'list')).toEqual([]);
      // The old chunks past the new count stay, unreferenced; a reader (this one, and a fresh one) reads the new document.
      expect(chunkKeysOf(kv)).toHaveLength(before);
      expect(await d.getMeta()).toEqual(withError(10));
      expect(await createKvDocs({ kv, clock: clock(), ...small }).getMeta()).toEqual(withError(10));
    });

    it('a plain rewrite over a chunked document issues no DELETE, and reads back plain', async () => {
      const { d, kv } = docs(small);
      await d.putMeta(withError(600));
      const d2 = createKvDocs({ kv, clock: clock(), codec: identityCodec }); // default 90 KB threshold → plain
      await d2.getMeta();
      kv.ops.length = 0;
      await d2.putMeta(meta());
      expect(kv.ops.filter((o) => o.op === 'del')).toEqual([]);
      expect(JSON.parse(kv.data.get('meta') as string)).toEqual(meta());
      expect(await createKvDocs({ kv, clock: clock(), ...small }).getMeta()).toEqual(meta());
    });

    it('the next longer write overwrites the leftover chunks by PUT, and they read back whole', async () => {
      const { d, kv } = docs(small);
      await d.putMeta(withError(600));
      const keys = chunkKeysOf(kv);
      await d.putMeta(withError(10));
      await d.putMeta(withError(700));
      expect(chunkKeysOf(kv).length).toBeGreaterThanOrEqual(keys.length);
      expect(await createKvDocs({ kv, clock: clock(), ...small }).getMeta()).toEqual(withError(700));
    });

    it("a dated document's expiry (the only caller that deletes) still removes every chunk its listing shows", async () => {
      const { d, kv } = docs(small);
      await d.putDoc('roll/min/2026-01-01T00', { v: 'x'.repeat(600) });
      await d.putDoc('roll/min/2026-01-01T00', { v: 'y' });
      const listing = await d.listKeysWithChunks('roll/');
      await d.del('roll/min/2026-01-01T00', { listed: listing.chunks['roll/min/2026-01-01T00'] ?? [] });
      expect([...kv.data.keys()].filter((k) => k.startsWith('roll/'))).toEqual([]);
    });

    it('refuses documents that would need more than maxChunks chunks, writing nothing', async () => {
      const { d, kv } = docs({ ...small, maxChunks: 3 });
      await expect(d.putMeta(withError(2_000))).rejects.toBeInstanceOf(KvDocTooLarge);
      expect(kv.data.size).toBe(0);
    });
  });

  it('round-trips arbitrary JSON documents through putDoc/getDoc (property)', async () => {
    // Documents are JSON objects (a top-level string that itself looks like JSON would be read as the
    // tolerated legacy double encoding).
    await fc.assert(
      fc.asyncProperty(fc.dictionary(fc.string(), fc.jsonValue()), fc.integer({ min: 8, max: 200 }), async (value, chunkChars) => {
        const kv = createMemoryKvStore();
        const d = createKvDocs({ kv, codec: identityCodec, clock: clock(), chunkThresholdBytes: 40, chunkChars, maxChunks: 1_000_000 });
        await d.putDoc('prop/doc', value);
        const back = await d.getDoc('prop/doc', (_v): _v is unknown => true);
        expect(back).toEqual(JSON.parse(JSON.stringify(value)));
      }),
      { numRuns: 60 },
    );
  });
});

// ─── listKeys / del / generic docs ───────────────────────────────────────────
describe('createKvDocs: listKeys, del, getDoc', () => {
  it('lists document keys only, sorted, with leading slashes stripped', async () => {
    const kv = createMemoryKvStore({
      initial: { 'roll/min/2026-09-26T04': '{}', 'roll/min/2026-09-26T03': '{}', 'roll/min/2026-09-26T03/c/0': '""', 'roll/hour/x': '{}' },
    });
    const { d } = docs({ kv });
    expect(await d.listKeys('roll/min/')).toEqual(['roll/min/2026-09-26T03', 'roll/min/2026-09-26T04']);
    const slashy: KvStore = { ...kv, list: async () => ['/roll/min/a', 'roll/min/a', 'roll/hour/b'] };
    expect(await docs({ kv: slashy as MemoryKvStore }).d.listKeys('roll/min/')).toEqual(['roll/min/a']);
    await expect(d.listKeys('bad:prefix')).rejects.toThrow(/invalid KV prefix/);
    expect(await d.listKeys('')).toHaveLength(3);
  });

  it('deletes a chunked document manifest-first, then every chunk', async () => {
    const { d, kv } = docs({ codec: identityCodec, chunkThresholdBytes: 50, chunkChars: 64 });
    await d.putRollMinute('2026-09-26T03', minuteDoc());
    const fresh = createKvDocs({ kv, codec: identityCodec, clock: clock() });
    kv.ops.length = 0;
    await fresh.del('roll/min/2026-09-26T03');
    expect(kv.data.size).toBe(0);
    const dels = kv.ops.filter((o) => o.op === 'del').map((o) => o.key);
    expect(dels[0]).toBe('roll/min/2026-09-26T03');
    expect(dels.slice(1).every(isChunkKey)).toBe(true);
  });

  it('deletes plain and missing documents, and chunks it knew about', async () => {
    const { d, kv } = docs({ codec: identityCodec, chunkThresholdBytes: 50, chunkChars: 64 });
    await d.putDoc('plain/doc', { a: 1 });
    kv.data.set('plain/doc', '{"a":1}');
    await d.del('plain/doc');
    await d.del('never/written');
    await d.putMeta(meta()); // chunked; count known
    kv.data.delete('meta'); // manifest lost, chunks orphaned
    await d.del('meta');
    expect(kv.data.size).toBe(0);
    await expect(d.del('x:y')).rejects.toThrow(/invalid KV key/);
  });

  it('getDoc/putDoc work for untyped keys such as tour/active', async () => {
    const { d, logger } = docs();
    const isTour = (v: unknown): v is { active: boolean; since: string } =>
      typeof v === 'object' && v !== null && typeof (v as { active?: unknown }).active === 'boolean';
    await d.putDoc(KEYS.tour, { active: true, since: T });
    expect(await d.getDoc(KEYS.tour, isTour)).toEqual({ active: true, since: T });
    await d.putDoc(KEYS.tour, { nope: 1 });
    expect(await d.getDoc(KEYS.tour, isTour)).toBeNull();
    expect(logger.warnings.join()).toMatch(/failed its guard/);
    expect(await d.getDoc('missing/doc', isTour)).toBeNull();
    const kv = createMemoryKvStore({ initial: { 'bad/doc': '{' } });
    expect(await docs({ kv }).d.getDoc('bad/doc', isTour)).toBeNull();
  });
});

// ─── Lock ────────────────────────────────────────────────────────────────────
describe('createKvDocs: lock/meter', () => {
  it('acquires a free lock, blocks other owners until expiry, is re-entrant, and releases by expiring', async () => {
    const c = clock();
    const kv = createMemoryKvStore();
    const tabA = createKvDocs({ kv, codec: webCodec, clock: c });
    const tabB = createKvDocs({ kv, codec: webCodec, clock: c });
    expect(await tabA.acquireLock('tab-a', 90_000)).toBe(true);
    expect(await tabB.getLock()).toEqual({ owner: 'tab-a', expiresAt: new Date(NOW + 90_000).toISOString() });
    expect(await tabB.acquireLock('tab-b', 90_000)).toBe(false);
    expect(await tabA.acquireLock('tab-a', 90_000)).toBe(true); // renew
    c.advance(90_001);
    expect(await tabB.acquireLock('tab-b', 90_000)).toBe(true); // A's lock expired
    expect(await tabA.releaseLock('tab-a')).toBe(false); // not the owner any more
    expect(await tabB.releaseLock('tab-b')).toBe(true);
    const released = await tabA.getLock();
    expect(released).toEqual({ owner: 'tab-b', expiresAt: new Date(c.now()).toISOString() });
    expect(await tabA.acquireLock('tab-a', 1_000)).toBe(true); // released = immediately free
    expect(kv.ops.some((o) => o.op === 'del')).toBe(false); // never DELETEs the lock
  });

  it('verify=true catches a concurrent writer; verify=false skips the re-read', async () => {
    const inner = createMemoryKvStore();
    const thief: KvStore = {
      ...inner,
      async put(k, v) {
        await inner.put(k, v);
        if (k === KEYS.lock) inner.data.set(k, JSON.stringify({ owner: 'tab-b', expiresAt: new Date(NOW + 90_000).toISOString() }));
      },
    };
    const d = createKvDocs({ kv: thief, codec: webCodec, clock: clock() });
    expect(await d.acquireLock('tab-a', 90_000)).toBe(false);
    inner.data.clear();
    inner.ops.length = 0;
    const d2 = createKvDocs({ kv: inner, codec: webCodec, clock: clock() });
    expect(await d2.acquireLock('tab-a', 90_000, { verify: false })).toBe(true);
    expect(inner.ops.map((o) => o.op)).toEqual(['get', 'put']);
  });

  it('treats a malformed lock as free, rejects an empty owner, and releases nothing when unlocked', async () => {
    const kv = createMemoryKvStore({ initial: { [KEYS.lock]: JSON.stringify({ owner: 7 }) } });
    const { d, logger } = docs({ kv });
    expect(await d.getLock()).toBeNull();
    expect(logger.warnings.join()).toMatch(/malformed lock/);
    expect(await d.acquireLock('tab-a', 1_000)).toBe(true);
    await expect(d.acquireLock('', 1_000)).rejects.toThrow(/non-empty owner/);
    expect(await docs().d.releaseLock('nobody')).toBe(false);
    expect(await docs({ kv: createMemoryKvStore({ initial: { [KEYS.lock]: '{bad' } }) }).d.getLock()).toBeNull();
  });
});
