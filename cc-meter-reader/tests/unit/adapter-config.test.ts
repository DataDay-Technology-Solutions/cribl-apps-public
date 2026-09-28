import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CriblHttp, HttpResult } from '../../core/types.ts';
import {
  ConfigApiError,
  fetchGroupInventory,
  fetchInventory,
  inventoryHash,
  itemsOf,
  listWorkerGroups,
  normalizeInputs,
  normalizeOutputs,
  normalizePipelines,
  normalizeRoutes,
  workerGroupIds,
} from '../../core/adapters/config.ts';
import * as urls from '../../core/adapters/cribl-urls.ts';

interface Envelope {
  request: { method: string; path: string };
  status: number;
  source: string;
  body: unknown;
}
const fixture = (name: string): Envelope =>
  JSON.parse(readFileSync(new URL(`../fixtures/cribl/${name}.json`, import.meta.url), 'utf8')) as Envelope;

/** Serves every live fixture at the path it was captured from. */
function liveHttp(overrides: Record<string, HttpResult> = {}) {
  const byPath = new Map<string, HttpResult>();
  for (const name of ['groups', 'stream-groups', 'routes', 'pipelines', 'inputs', 'outputs', 'packs']) {
    const f = fixture(name);
    expect(f.source).toBe('live');
    byPath.set(f.request.path, { status: f.status, ok: f.status < 300, json: f.body });
  }
  const seen: string[] = [];
  const http: CriblHttp = {
    async request(method, path) {
      seen.push(`${method} ${path}`);
      return overrides[path] ?? byPath.get(path) ?? { status: 404, ok: false, json: { status: 'error', message: 'not found' } };
    },
  };
  return { http, seen };
}

describe('cribl-urls', () => {
  it('builds group-scoped config, version and deploy paths', () => {
    expect(urls.streamGroups()).toBe('/products/stream/groups');
    // P0-03: the deprecated, undeclared listing is gone from the URL module (only the demo deploy fallback keeps /master).
    expect('groups' in urls).toBe(false);
    expect(urls.inputs('default')).toBe('/m/default/system/inputs');
    expect(urls.input('default', 'mrd_payments_api')).toBe('/m/default/system/inputs/mrd_payments_api');
    expect(urls.outputs('default')).toBe('/m/default/system/outputs');
    expect(urls.output('default', 'mrd_siem_prod')).toBe('/m/default/system/outputs/mrd_siem_prod');
    expect(urls.pipelines('default')).toBe('/m/default/pipelines');
    expect(urls.pipeline('default', 'mrd_pay_sample')).toBe('/m/default/pipelines/mrd_pay_sample');
    expect(urls.routes('default')).toBe('/m/default/routes');
    expect(urls.route('default', 'default')).toBe('/m/default/routes/default');
    expect(urls.packs('default')).toBe('/m/default/packs');
    expect(urls.samples('default')).toBe('/m/default/system/samples');
    expect(urls.versionLog('default', 50)).toBe('/m/default/version?count=50');
    expect(urls.versionLog('default', 0)).toBe('/m/default/version?count=1');
    expect(urls.versionShow('default', 'abc')).toBe('/m/default/version/show?commit=abc&diffLineLimit=1');
    expect(urls.versionShow('default', 'abc', 0)).toBe('/m/default/version/show?commit=abc&diffLineLimit=1'); // 0 would mean unlimited
    expect(urls.versionFiles('default', 'abc')).toBe('/m/default/version/files?commit=abc');
    expect(urls.versionStatus('default')).toBe('/m/default/version/status');
    expect(urls.versionCommit('default')).toBe('/m/default/version/commit');
    expect(urls.deploy('default')).toBe('/products/stream/groups/default/deploy');
    expect(urls.deployLegacy('default')).toBe('/master/groups/default/deploy');
    expect(urls.metricsQuery()).toBe('/system/metrics/query');
    expect(urls.metricsEnum()).toBe('/system/metrics/enum');
    expect(urls.kvKey('roll/min/2026-09-26T03')).toBe('/kvstore/roll/min/2026-09-26T03');
    expect(urls.kvKeys()).toBe('/kvstore/keys');
    expect(urls.endpoint('meter')).toBe('/endpoints/meter');
  });
  it('percent-encodes id segments', () => {
    expect(urls.pipeline('my group', 'a/b')).toBe('/m/my%20group/pipelines/a%2Fb');
    expect(urls.kvKey('a b/c')).toBe('/kvstore/a%20b/c');
  });
});

describe('normalizers on live fixtures', () => {
  it('routes: reads the default table in order', () => {
    const r = normalizeRoutes(fixture('routes').body);
    expect(r.routeTableId).toBe('default');
    expect(r.routes).toEqual([{ id: 'default', name: 'default', filter: 'true', pipeline: 'main', output: 'default', final: true, disabled: false }]);
  });

  it('outputs: keeps type, and defaultId only for the default output', () => {
    expect(normalizeOutputs(fixture('outputs').body)).toEqual([
      { id: 'default', type: 'default', defaultId: 'devnull' },
      { id: 'devnull', type: 'devnull' },
    ]);
  });

  it('inputs: trimmed shape, sorted by id, runtime noise dropped', () => {
    const inputs = normalizeInputs(fixture('inputs').body);
    expect(inputs.map((i) => i.id)).toEqual([...inputs.map((i) => i.id)].sort());
    expect(inputs.find((i) => i.id === 'CriblMetrics')).toEqual({ id: 'CriblMetrics', type: 'criblmetrics', disabled: true, pipeline: 'cribl_metrics_rollup' });
    expect(inputs.find((i) => i.id === 'in_cribl_http')).toEqual({ id: 'in_cribl_http', type: 'cribl_http', disabled: false, sendToRoutes: true });
    for (const i of inputs) expect(Object.keys(i).every((k) => ['id', 'type', 'disabled', 'description', 'pipeline', 'connections', 'sendToRoutes'].includes(k))).toBe(true);
  });

  it('pipelines: functions with id, filter, disabled, description; description and output from conf', () => {
    const pipes = normalizePipelines(fixture('pipelines').body);
    const asa = pipes.find((p) => p.id === 'cisco_asa');
    expect(asa).toMatchObject({ id: 'cisco_asa', description: 'Filter and Sample Cisco ASA events', output: 'default' });
    expect(asa?.functions[0]).toEqual({ id: 'eval', filter: "sourcetype!='cisco:asa'", description: 'Short-circuit all events that are NOT sourcetype cisco:asa' });
    expect(asa?.functions.find((f) => f.id === 'sampling')).toEqual({
      id: 'sampling',
      filter: 'true',
      disabled: false,
      description: 'Sample permitted ASA-6-106100 messages at 10:1',
    });
    expect(pipes.find((p) => p.id === 'passthru')).toEqual({ id: 'passthru', functions: [] });
  });

  it('handles the rig-shaped objects the live org will carry (QuickConnect, pre-processing, trims)', () => {
    const inputs = normalizeInputs({
      items: [
        {
          id: 'mrd_pan_firewall',
          type: 'datagen',
          disabled: false,
          description: '[meter-reader-demo]',
          pipeline: 'syslog_pre',
          sendToRoutes: false,
          connections: [{ output: 'mrd_siem_prod', pipeline: 'pan_pack' }, { output: 'mrd_archive_s3' }, { pipeline: 'no_output' }, 'junk'],
          status: { health: 'Green' },
        },
        { type: 'no id' },
        { id: 'x' },
      ],
    });
    expect(inputs).toEqual([
      {
        id: 'mrd_pan_firewall',
        type: 'datagen',
        disabled: false,
        description: '[meter-reader-demo]',
        pipeline: 'syslog_pre',
        sendToRoutes: false,
        connections: [{ output: 'mrd_siem_prod', pipeline: 'pan_pack' }, { output: 'mrd_archive_s3' }],
      },
      { id: 'x', type: 'unknown' },
    ]);
    const pipes = normalizePipelines({
      items: [{ id: 'mrd_pay_sample', conf: { functions: [{ id: 'sampling', conf: { rules: [] } }, { id: 'eval', description: 'trim [mr-trim]', disabled: true, filter: 'true' }, {}] } }, { id: 'bare' }],
    });
    expect(pipes[1].functions).toEqual([{ id: 'sampling' }, { id: 'eval', description: 'trim [mr-trim]', disabled: true, filter: 'true' }, { id: 'unknown' }]);
    expect(pipes[0]).toEqual({ id: 'bare', functions: [] });
    // an installed Pack, as GET /pipelines lists it live: marked as a Pack, never a function-free pipeline
    expect(normalizePipelines({ items: [{ id: 'pack:cribl-palo-alto-networks', conf: { pack: true } }] })).toEqual([{ id: 'pack:cribl-palo-alto-networks', functions: [], packId: 'cribl-palo-alto-networks' }]);
    const outs = normalizeOutputs({ items: [{ id: 'o', type: 'devnull', pipeline: 'post', description: 'd', disabled: true, defaultId: 'ignored' }, {}] });
    expect(outs).toEqual([{ id: 'o', type: 'devnull', pipeline: 'post', description: 'd', disabled: true }]);
  });

  it('routes: prefers the default table, defaults a missing filter to true, skips id-less rules', () => {
    const r = normalizeRoutes({
      items: [
        { id: 'other', routes: [{ id: 'x' }] },
        { id: 'default', routes: [{ id: 'mrd_r_pay', name: 'payments', pipeline: 'mrd_pay_sample', output: 'mrd_siem_prod', final: true, description: 'demo' }, { name: 'no id' }, { id: 'no_pipe' }] },
      ],
    });
    expect(r.routes).toEqual([
      { id: 'mrd_r_pay', name: 'payments', filter: 'true', pipeline: 'mrd_pay_sample', output: 'mrd_siem_prod', final: true, description: 'demo' },
      { id: 'no_pipe', filter: 'true', pipeline: '' },
    ]);
    expect(normalizeRoutes({ items: [{ routes: 'nope' }] })).toEqual({ routes: [] });
    expect(normalizeRoutes({})).toEqual({ routes: [] });
  });

  it('itemsOf accepts envelopes and bare arrays', () => {
    expect(itemsOf({ items: [{ a: 1 }, 2] })).toEqual([{ a: 1 }]);
    expect(itemsOf([{ b: 1 }])).toEqual([{ b: 1 }]);
    expect(itemsOf('x')).toEqual([]);
  });
});

describe('fetchInventory', () => {
  it('reads inputs, outputs, pipelines and routes per group (4 calls) into an InventoryDoc', async () => {
    const { http, seen } = liveHttp();
    const inv = await fetchInventory(http, ['default'], { clock: { now: () => Date.parse('2026-09-26T04:00:00Z') } });
    expect(seen.sort()).toEqual(['GET /m/default/pipelines', 'GET /m/default/routes', 'GET /m/default/system/inputs', 'GET /m/default/system/outputs']);
    expect(inv.schemaVersion).toBe(1);
    expect(inv.updatedAt).toBe('2026-09-26T04:00:00.000Z');
    expect(inv.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(inv.hash).toBe(inventoryHash(inv.byGroup));
    expect(inv.byGroup.default.routeTableId).toBe('default');
    expect(inv.byGroup.default.outputs).toHaveLength(2);
    expect(inv.byGroup.default.pipelines.length).toBeGreaterThan(5);
    expect(inv.byGroup.default.inputs.length).toBeGreaterThan(5);
  });

  it('defaults updatedAt to the wall clock', async () => {
    const before = Date.now();
    const inv = await fetchInventory(liveHttp().http, ['default']);
    expect(Date.parse(inv.updatedAt)).toBeGreaterThanOrEqual(before);
  });

  it('hash is stable across key order and volatile status, and moves on meaningful change', async () => {
    const a = await fetchGroupInventory(liveHttp().http, 'default');
    const reordered = fixture('outputs').body as { items: Record<string, unknown>[] };
    const shuffled = { items: [...reordered.items].reverse().map((o) => ({ status: { health: 'Red', timestamp: 1 }, ...Object.fromEntries(Object.entries(o).reverse()) })) };
    const b = await fetchGroupInventory(liveHttp({ '/m/default/system/outputs': { status: 200, ok: true, json: shuffled } }).http, 'default');
    expect(inventoryHash({ default: b })).toBe(inventoryHash({ default: a }));
    const changed = { items: [...reordered.items, { id: 'mrd_siem_prod', type: 'devnull' }] };
    const c = await fetchGroupInventory(liveHttp({ '/m/default/system/outputs': { status: 200, ok: true, json: changed } }).http, 'default');
    expect(inventoryHash({ default: c })).not.toBe(inventoryHash({ default: a }));
  });

  it('throws ConfigApiError (no partial inventory) when any read fails', async () => {
    const { http } = liveHttp({ '/m/default/routes': { status: 403, ok: false, json: { status: 'error', message: 'Forbidden' } } });
    const err = await fetchInventory(http, ['default']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigApiError);
    expect(err).toMatchObject({ status: 403, path: '/m/default/routes' });
    expect((err as Error).message).toMatch(/Forbidden/);
    await expect(fetchInventory(liveHttp().http, ['missing_group'])).rejects.toMatchObject({ status: 404 });
    const textErr = liveHttp({ '/m/default/pipelines': { status: 502, ok: false, text: 'bad gateway' } });
    await expect(fetchInventory(textErr.http, ['default'])).rejects.toThrow(/HTTP 502 bad gateway/);
    const bare = liveHttp({ '/m/default/pipelines': { status: 500, ok: false } });
    await expect(fetchInventory(bare.http, ['default'])).rejects.toThrow(/HTTP 500$/);
  });
});

describe('listWorkerGroups', () => {
  it('returns only Stream worker groups from the declared /products/stream/groups listing (P0-03: never /master/groups)', async () => {
    const { http, seen } = liveHttp();
    expect(await listWorkerGroups(http)).toEqual(['default']);
    expect(seen).toEqual(['GET /products/stream/groups']);
  });
  it('filters a listing that carries non-Stream groups the same way (a Leader that answers the full group list)', async () => {
    const { http } = liveHttp({ '/products/stream/groups': { status: 200, ok: true, json: fixture('live-master-groups') } });
    expect(await listWorkerGroups(http)).toEqual(['default']);
  });
  it('keeps typeless groups unless they are fleets or search, and drops edge/outpost', () => {
    expect(
      workerGroupIds({
        items: [
          { id: 'legacy' },
          { id: 'fleet', isFleet: true },
          { id: 'default_search' },
          { id: 'search2', isSearch: true },
          { id: 'edge', type: 'edge' },
          { id: 'out', type: 'outpost' },
          { id: 'prod', type: 'stream' },
          { type: 'stream' },
        ],
      }),
    ).toEqual(['legacy', 'prod']);
  });
  it('throws when the groups read fails', async () => {
    await expect(listWorkerGroups(liveHttp({ '/products/stream/groups': { status: 403, ok: false } }).http)).rejects.toBeInstanceOf(ConfigApiError);
  });
});
