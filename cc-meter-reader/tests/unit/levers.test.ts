import { describe, expect, it } from 'vitest';
import type { CriblHttp, DemoState, Incident } from '../../core/types.ts';
import {
  DEFAULT_MEASURED_LAG_SEC,
  IN_FLIGHT_TTL_MS,
  LEVER_CALLS,
  LEVER_RETRY_MS,
  MUTE_MS,
  applyPack,
  breakTrim,
  emptyDemoState,
  resetAll,
  resetBaselines,
  restoreTrim,
  revertPack,
  setRate,
  type LeverResult,
} from '../../core/demo/levers.ts';
import {
  DEMO_TAG,
  RIG_SOURCES,
  TRIM_TAG,
  inputIdFromFilter,
  isDemoTagged,
  rigObjectKeys,
  rigSource,
  rigSourceForRoute,
  rigSourcesUsingPipeline,
} from '../../core/demo/rig-ids.ts';
import { LOCK_TTL_MS, minuteKey } from '../../core/sweep.ts';
import { MINUTE, createWorld, faultHttp, type World } from '../integration/harness.ts';

const PIPE = 'mrd_pay_sample';
type Obj = Record<string, unknown>;

async function getItem(w: World, path: string): Promise<Obj> {
  const res = await w.em.handle({
    method: 'GET',
    url: `/api/v1${path}`,
    headers: {},
    body: null,
  });
  return (JSON.parse(res.body ?? '{}') as { items: Obj[] }).items[0];
}
const pipeline = (w: World, id = PIPE) => getItem(w, `/m/default/pipelines/${id}`);
const routes = (w: World) => getItem(w, '/m/default/routes');
const input = (w: World, id: string) => getItem(w, `/m/default/system/inputs/${id}`);
const demoState = async (w: World): Promise<DemoState> => (await w.docs.getDemoState()) ?? emptyDemoState();
const ok = (r: LeverResult) => {
  if (!r.ok) throw new Error(`lever refused: ${r.error} ${r.message}`);
  return r;
};
const pendingOthers = (w: World): string[] => ((w.em.state() as { pending: string[] }).pending ?? []).filter((p) => !p.includes('mrd_'));

// ─── Rig ids ─────────────────────────────────────────────────────────────────
describe('core/demo/rig-ids', () => {
  it('resolves a rig Source by input id, key or either route-id spelling', () => {
    expect(rigSource('mrd_payments_api')?.key).toBe('payments_api');
    expect(rigSource('payments_api')?.inputId).toBe('mrd_payments_api');
    expect(rigSource('mrd_rt_payments_api')?.inputId).toBe('mrd_payments_api');
    expect(rigSource('nope')).toBeUndefined();
    expect(RIG_SOURCES).toHaveLength(6);
  });

  it('reads the one input a route filter selects', () => {
    expect(inputIdFromFilter("__inputId=='datagen:mrd_vpc_flow'")).toBe('mrd_vpc_flow');
    expect(inputIdFromFilter('true')).toBeUndefined();
    expect(inputIdFromFilter("__inputId.startsWith('datagen:')")).toBeUndefined();
    expect(inputIdFromFilter("__inputId=='datagen:a' || __inputId=='datagen:b'")).toBeUndefined();
    expect(
      rigSourceForRoute({
        id: 'whatever',
        filter: "__inputId=='datagen:mrd_k8s_prod'",
      })?.key,
    ).toBe('k8s_prod');
    expect(rigSourceForRoute({ id: 'mrd_rt_k8s_prod' })?.key).toBe('k8s_prod');
    expect(rigSourceForRoute({ id: 'default', filter: 'true' })).toBeUndefined();
  });

  it('lists the object keys a Source can be detected on, and the Sources a pipeline serves', () => {
    const keys = rigObjectKeys(rigSource('payments_api')!, 'default', ['mrd_extra', '-', undefined]);
    expect(keys).toEqual(
      expect.arrayContaining([
        'in:default:mrd_payments_api',
        'route:default:mrd_payments_api',
        'route:default:mrd_rt_payments_api',
        'pipe:default:mrd_pay_sample',
        'pipe:default:mrd_extra',
      ]),
    );
    expect(keys).toHaveLength(5);
    expect(rigSourcesUsingPipeline('mrd_win_xml_pack').map((s) => s.key)).toEqual(['windows_dc', 'windows_workstations']);
    expect(isDemoTagged(`x ${DEMO_TAG}`)).toBe(true);
    expect(isDemoTagged('plain')).toBe(false);
    expect(isDemoTagged(undefined)).toBe(false);
    expect(TRIM_TAG).toBe('[mr-trim]');
  });
});

// ─── Gates ───────────────────────────────────────────────────────────────────
describe('lever gates', () => {
  it('refuses while demo mode is off', async () => {
    const w = await createWorld({
      settings: (s) => void (s.demo.enabled = false),
    });
    const r = await breakTrim(w.lever, { pipelineId: PIPE });
    expect(r).toMatchObject({ ok: false, error: 'demo_disabled', status: 403 });
    expect(r.calls).toBe(3);
  });

  it('allows one lever in flight at a time; a stale marker (90 s) is ignored', async () => {
    const w = await createWorld();
    await w.docs.putDemoState({
      ...emptyDemoState(),
      inFlight: {
        lever: 'applyPack',
        since: new Date(w.now() - 10_000).toISOString(),
      },
    });
    const r = await breakTrim(w.lever, { pipelineId: PIPE });
    expect(r).toMatchObject({
      ok: false,
      error: 'in_flight',
      status: 409,
      retryInMs: LEVER_RETRY_MS,
    });
    expect(r.ok ? '' : r.message).toContain('applyPack is running');
    await w.docs.putDemoState({
      ...emptyDemoState(),
      inFlight: {
        lever: 'applyPack',
        since: new Date(w.now() - IN_FLIGHT_TTL_MS - 1).toISOString(),
      },
    });
    ok(await breakTrim(w.lever, { pipelineId: PIPE }));
    expect((await demoState(w)).inFlight).toBeUndefined();
  });

  it('refuses a second lever while it is running (a real race on the in-flight marker)', async () => {
    let inner: LeverResult | undefined;
    const holder: { w?: World } = {};
    const w = await createWorld({
      wrapHttp: (h): CriblHttp => ({
        async request(m, p, b, o) {
          if (m === 'PATCH' && p.includes('/pipelines/') && holder.w && !inner)
            inner = await applyPack(holder.w.lever, {
              routeId: 'mrd_windows_workstations',
            });
          return h.request(m, p, b, o);
        },
      }),
    });
    holder.w = w;
    ok(await breakTrim(w.lever, { pipelineId: PIPE }));
    expect(inner).toMatchObject({ ok: false, error: 'in_flight' });
  });

  it('shares the minute budget with the sweep: refuses past 45 and says when to retry', async () => {
    const w = await createWorld();
    const minute = minuteKey(w.now());
    await w.docs.putMeta({
      schemaVersion: 1,
      installedAt: new Date(w.now()).toISOString(),
      collectingSince: new Date(w.now()).toISOString(),
      appVersion: '1',
      build: 'demo',
      metricsSource: 'metrics-query',
      sweepErrors: 0,
      consecutiveRateLimited: 0,
      sweepCount: 1,
      callsThisMinute: { minute, calls: 25 },
    });
    const lever = { ...w.lever, minuteBudget: undefined };
    const first = ok(await breakTrim(lever, { pipelineId: PIPE }));
    expect(first.calls).toBe(LEVER_CALLS);
    expect((await demoState(w)).leverCalls).toEqual({
      minute,
      calls: LEVER_CALLS,
    });
    const second = await applyPack(lever, {
      routeId: 'mrd_windows_workstations',
    });
    // T0 is 20 s into its minute: retry 1 s after the next minute starts.
    expect(second).toMatchObject({
      ok: false,
      error: 'budget',
      status: 429,
      retryInMs: 41_000,
    });
    // Next minute neither the sweep's nor the lever's calls count against it.
    w.advance(MINUTE);
    ok(await applyPack(lever, { routeId: 'mrd_windows_workstations' }));
  });

  it('refuses objects without the [meter-reader-demo] token, and unknown objects', async () => {
    const w = await createWorld();
    const pipe = await breakTrim(w.lever, { pipelineId: 'main' });
    expect(pipe).toMatchObject({
      ok: false,
      error: 'not_demo_tagged',
      status: 403,
      id: 'main',
    });
    const route = await applyPack(w.lever, { routeId: 'default' });
    expect(route).toMatchObject({
      ok: false,
      error: 'not_demo_tagged',
      id: 'default',
    });
    const missing = await breakTrim(w.lever, { pipelineId: 'mrd_nope' });
    expect(missing).toMatchObject({
      ok: false,
      error: 'not_found',
      status: 404,
    });
    const noRoute = await revertPack(w.lever, { routeId: 'mrd_nope' });
    expect(noRoute).toMatchObject({ ok: false, error: 'not_found' });
    expect((await demoState(w)).inFlight).toBeUndefined();
    expect((w.em.state() as { violations: unknown[] }).violations).toEqual([]);
  });

  it('refuses levers that make no sense for the object', async () => {
    const w = await createWorld();
    expect(await applyPack(w.lever, { routeId: 'mrd_payments_api' })).toMatchObject({ ok: false, error: 'invalid', status: 400 });
    expect(await breakTrim(w.lever, { pipelineId: 'mrd_passthrough' })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await setRate(w.lever, { inputId: 'mrd_payments_api', multiplier: 20 })).toMatchObject({ ok: false, error: 'invalid' });
    expect(
      await setRate(w.lever, {
        inputId: 'mrd_payments_api',
        multiplier: Number.NaN,
      }),
    ).toMatchObject({ ok: false, error: 'invalid' });
    expect(await restoreTrim(w.lever, { pipelineId: PIPE })).toMatchObject({
      ok: false,
      error: 'no_change',
      status: 409,
    });
    expect(await revertPack(w.lever, { routeId: 'mrd_windows_workstations' })).toMatchObject({ ok: false, error: 'no_change' });
    expect(await setRate(w.lever, { inputId: 'mrd_payments_api', multiplier: 1 })).toMatchObject({ ok: false, error: 'no_change' });
  });
});

// ─── Trim ────────────────────────────────────────────────────────────────────
describe('breakTrim / restoreTrim', () => {
  it('round-trips the pipeline exactly, committing only its own file each time', async () => {
    const w = await createWorld();
    const before = await pipeline(w);
    const others = pendingOthers(w);
    const broken = ok(await breakTrim(w.lever, { pipelineId: PIPE }));
    expect(broken.message).toBe(`demo: break the trim on ${PIPE}`);
    expect(broken.files).toEqual([`groups/default/local/cribl/pipelines/${PIPE}/conf.yml`]);
    expect(broken.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(broken.deployedAt).toBe(new Date(w.now()).toISOString());
    const mid = await pipeline(w);
    const fns = (mid.conf as { functions: Obj[] }).functions;
    const trimAt = fns.findIndex((f) => String(f.description).includes(TRIM_TAG));
    expect(fns[trimAt].disabled).toBe(true);
    const state = await demoState(w);
    expect(state.trim[PIPE]).toMatchObject({
      functionIndex: trimAt,
      brokenAt: broken.deployedAt,
    });
    expect(state.trim[PIPE].previous).toEqual((before.conf as { functions: Obj[] }).functions[trimAt]);
    expect(state.measuredLagSec).toBe(DEFAULT_MEASURED_LAG_SEC);
    expect(await breakTrim(w.lever, { pipelineId: PIPE })).toMatchObject({
      ok: false,
      error: 'no_change',
    });

    w.advance(MINUTE);
    const restored = ok(await restoreTrim(w.lever, { pipelineId: PIPE }));
    expect(restored.message).toBe(`demo: restore the trim on ${PIPE}`);
    expect(await pipeline(w)).toEqual(before);
    const after = await demoState(w);
    expect(after.trim[PIPE]).toBeUndefined();
    expect(after.muted['route:default:mrd_payments_api']).toBe(new Date(w.now() + MUTE_MS).toISOString());
    expect(after.muted['pipe:default:mrd_pay_sample']).toBeDefined();
    // Both commits are on the timeline with the member's username and the deploy time.
    const timeline = (await w.docs.getTimeline())!.byGroup.default;
    expect(timeline.slice(0, 2).map((c) => [c.message, c.author, c.source])).toEqual([
      [restored.message, 's.koelpin', 'demo'],
      [broken.message, 's.koelpin', 'demo'],
    ]);
    expect(timeline[0].deployedAt).toBe(restored.deployedAt);
    // Nobody else's pending change was swept into either commit; no commit went out without a file list.
    expect(pendingOthers(w)).toEqual(others);
    expect((w.em.state() as { violations: unknown[] }).violations).toEqual([]);
  });

  it('restores from the function itself when demo/state was lost', async () => {
    const w = await createWorld();
    ok(await breakTrim(w.lever, { pipelineId: PIPE }));
    await w.docs.putDemoState(emptyDemoState());
    ok(await restoreTrim(w.lever, { pipelineId: PIPE }));
    const fns = ((await pipeline(w)).conf as { functions: Obj[] }).functions;
    expect(fns.find((f) => String(f.description).includes(TRIM_TAG))?.disabled).toBe(false);
  });
});

// ─── Packs ───────────────────────────────────────────────────────────────────
describe('applyPack / revertPack', () => {
  it('points a raw route at its pack and back, leaving the table exactly as it was', async () => {
    const w = await createWorld();
    const before = await routes(w);
    const applied = ok(await applyPack(w.lever, { routeId: 'mrd_windows_workstations' }));
    expect(applied.message).toBe('demo: apply the pack on mrd_windows_workstations');
    expect(applied.files).toEqual(['groups/default/local/cribl/pipelines/route.yml']);
    const table = (await routes(w)) as { routes: Obj[] };
    expect(table.routes.find((r) => r.id === 'mrd_windows_workstations')?.pipeline).toBe('mrd_win_xml_pack');
    expect((await demoState(w)).routes.mrd_windows_workstations).toMatchObject({
      previousPipelineId: 'mrd_passthrough',
      level: 'pack',
    });
    expect(await applyPack(w.lever, { routeId: 'mrd_windows_workstations' })).toMatchObject({ ok: false, error: 'no_change' });
    // Go aggressive keeps the ORIGINAL previous pipeline.
    ok(
      await applyPack(w.lever, {
        routeId: 'mrd_windows_workstations',
        level: 'aggressive',
      }),
    );
    expect((await demoState(w)).routes.mrd_windows_workstations).toMatchObject({
      previousPipelineId: 'mrd_passthrough',
      level: 'aggressive',
    });
    const reverted = ok(await revertPack(w.lever, { routeId: 'mrd_windows_workstations' }));
    expect(reverted.message).toBe('demo: revert the pack on mrd_windows_workstations');
    expect(await routes(w)).toEqual(before);
    const state = await demoState(w);
    expect(state.routes.mrd_windows_workstations).toBeUndefined();
    expect(state.muted['route:default:mrd_windows_workstations']).toBeDefined();
    expect(state.muted['pipe:default:mrd_win_docs_reduce']).toBeDefined();
  });

  it('accepts a rig key or the other route-id spelling, and reverts to the steady pipeline without state', async () => {
    const w = await createWorld();
    const r = ok(await applyPack(w.lever, { routeId: 'vpc_flow' }));
    expect(r.message).toBe('demo: apply the pack on mrd_vpc_flow');
    await w.docs.putDemoState(emptyDemoState());
    ok(await revertPack(w.lever, { routeId: 'mrd_rt_vpc_flow' }));
    const table = (await routes(w)) as { routes: Obj[] };
    expect(table.routes.find((x) => x.id === 'mrd_vpc_flow')?.pipeline).toBe('mrd_passthrough');
  });
});

// ─── Rate ────────────────────────────────────────────────────────────────────
describe('setRate', () => {
  it('multiplies the baseline events/s and returns to it exactly', async () => {
    const w = await createWorld();
    const before = await input(w, 'mrd_payments_api');
    const eps = (before.samples as { eventsPerSec: number }[])[0].eventsPerSec;
    const spiked = ok(await setRate(w.lever, { inputId: 'mrd_payments_api', multiplier: 5 }));
    expect(spiked.message).toBe('demo: set mrd_payments_api to 5x');
    expect(spiked.files).toEqual(['groups/default/local/cribl/inputs.yml']);
    expect(
      (
        (await input(w, 'mrd_payments_api')).samples as {
          eventsPerSec: number;
        }[]
      )[0].eventsPerSec,
    ).toBe(Math.round(eps * 5));
    expect((await demoState(w)).rates.mrd_payments_api).toMatchObject({
      baselineEps: eps,
      multiplier: 5,
    });
    ok(await setRate(w.lever, { inputId: 'mrd_payments_api', multiplier: 2 }));
    expect(
      (
        (await input(w, 'mrd_payments_api')).samples as {
          eventsPerSec: number;
        }[]
      )[0].eventsPerSec,
    ).toBe(Math.round(eps * 2));
    ok(await setRate(w.lever, { inputId: 'mrd_payments_api', multiplier: 1 }));
    expect(await input(w, 'mrd_payments_api')).toEqual(before);
    expect((await demoState(w)).rates.mrd_payments_api).toBeUndefined();
  });
});

// ─── Resets ──────────────────────────────────────────────────────────────────
describe('resetBaselines / resetAll', () => {
  it('Reset baselines deletes the EWMA state under the sweep lock', async () => {
    const w = await createWorld();
    await w.sweep();
    expect(await w.docs.getBaselines()).not.toBeNull();
    const r = ok(await resetBaselines(w.lever));
    expect(r.commit).toBeUndefined();
    expect(await w.docs.getBaselines()).toBeNull();
    await w.docs.acquireLock('tab-b', LOCK_TTL_MS);
    expect(await resetBaselines(w.lever)).toMatchObject({
      ok: false,
      error: 'locked',
      status: 409,
      retryInMs: LEVER_RETRY_MS,
    });
  });

  it('Reset everything restores trims, rates and budgets in one commit and closes demo incidents', async () => {
    const w = await createWorld();
    const pipeBefore = await pipeline(w);
    const inputBefore = await input(w, 'mrd_payments_api');
    ok(await breakTrim(w.lever, { pipelineId: PIPE }));
    ok(await setRate(w.lever, { inputId: 'mrd_payments_api', multiplier: 5 }));
    await w.putSettings((s) => void (s.budgets = { mrd_siem_prod: { centsPerMonth: 50 } }));
    const state = await demoState(w);
    await w.docs.putDemoState({
      ...state,
      budgetsOverride: { mrd_siem_prod: { previousCentsPerMonth: 90_000 } },
      scene: {
        name: 'regression',
        step: 'waiting',
        startedAt: new Date(w.now()).toISOString(),
        changed: { trims: [PIPE], rates: [], budgets: [], routes: [] },
      },
    });
    const incident: Incident = {
      id: 'inc_demo01',
      type: 'regression',
      severity: 'high',
      objectKey: 'route:default:mrd_payments_api',
      label: 'Payments API sampling',
      openedAt: new Date(w.now()).toISOString(),
      before: 0.75,
      after: 0.5,
      impactPerDayM: 1,
      notes: ['demo-profile'],
      deliveries: [],
    };
    const realOne: Incident = { ...incident, id: 'inc_real01', notes: [] };
    const day = new Date(w.now()).toISOString().slice(0, 10);
    await w.docs.putIncidents(day, {
      schemaVersion: 1,
      items: [incident, realOne],
    });

    const r = ok(await resetAll(w.lever));
    expect(r.message).toBe('demo: reset everything');
    expect(r.files?.sort()).toEqual([`groups/default/local/cribl/inputs.yml`, `groups/default/local/cribl/pipelines/${PIPE}/conf.yml`]);
    expect(await pipeline(w)).toEqual(pipeBefore);
    expect(await input(w, 'mrd_payments_api')).toEqual(inputBefore);
    expect((await w.settings()).budgets).toEqual({
      mrd_siem_prod: { centsPerMonth: 90_000 },
    });
    const items = (await w.docs.getIncidents(day))!.items;
    expect(items.find((i) => i.id === 'inc_demo01')?.closedAt).toBeDefined();
    expect(items.find((i) => i.id === 'inc_real01')?.closedAt).toBeUndefined();
    const after = await demoState(w);
    expect(after).toMatchObject({ trim: {}, rates: {} });
    expect(after.scene).toBeUndefined();
    expect(after.budgetsOverride).toBeUndefined();
    expect(Object.keys(after.muted)).toEqual(
      expect.arrayContaining(['route:default:mrd_payments_api', 'in:default:mrd_payments_api', 'out:default:mrd_siem_prod']),
    );
    // Nothing left to reset: succeeds without a commit.
    const again = ok(await resetAll(w.lever));
    expect(again.commit).toBeUndefined();
  });

  it('Reset everything removes a budget a scene added', async () => {
    const w = await createWorld();
    await w.putSettings((s) => void (s.budgets = { mrd_siem_prod: { centsPerMonth: 50 } }));
    await w.docs.putDemoState({
      ...emptyDemoState(),
      budgetsOverride: { mrd_siem_prod: {} },
    });
    ok(await resetAll(w.lever));
    expect((await w.settings()).budgets).toEqual({});
  });
});

// ─── Failures ────────────────────────────────────────────────────────────────
describe('lever failures', () => {
  it('rolls the object back when the commit fails, and clears the in-flight marker', async () => {
    const w = await createWorld({
      wrapHttp: (h) => faultHttp(h, (m, p) => m === 'POST' && p.endsWith('/version/commit'), 500, 1),
    });
    const before = await pipeline(w);
    const r = await breakTrim(w.lever, { pipelineId: PIPE });
    expect(r).toMatchObject({ ok: false, error: 'commit_failed', status: 500 });
    expect(await pipeline(w)).toEqual(before);
    const state = await demoState(w);
    expect(state.inFlight).toBeUndefined();
    expect(state.trim[PIPE]).toBeUndefined();
  });

  it('reports a failed deploy with the commit it made and keeps demo/state in step', async () => {
    const w = await createWorld({
      wrapHttp: (h) => faultHttp(h, (m, p) => m === 'PATCH' && p.endsWith('/deploy'), 500, 1),
    });
    const r = await breakTrim(w.lever, { pipelineId: PIPE });
    expect(r).toMatchObject({ ok: false, error: 'deploy_failed', status: 500 });
    expect(r.ok ? undefined : r.commit).toMatch(/^[0-9a-f]{40}$/);
    const state = await demoState(w);
    expect(state.trim[PIPE]).toBeDefined();
    expect(state.inFlight).toBeUndefined();
    expect((await w.docs.getTimeline())?.byGroup.default ?? []).toHaveLength(0);
  });

  it('treats a change that dirtied no file as no_change and undoes it', async () => {
    const w = await createWorld({
      wrapHttp: (h): CriblHttp => ({
        request: (m, p, b, o) =>
          p.endsWith('/version/status')
            ? Promise.resolve({
                status: 200,
                ok: true,
                json: { items: [{ files: [] }] },
              })
            : h.request(m, p, b, o),
      }),
    });
    const before = await pipeline(w);
    expect(await breakTrim(w.lever, { pipelineId: PIPE })).toMatchObject({
      ok: false,
      error: 'no_change',
    });
    expect(await pipeline(w)).toEqual(before);
  });

  it('maps Leader refusals: 403 forbidden, 5xx failed, two 429s rate_limited', async () => {
    const w = await createWorld();
    const forbidden = faultHttp(w.http, (m, p) => m === 'GET' && p.includes('/pipelines/'), 403, 1);
    expect(await breakTrim({ ...w.lever, http: forbidden }, { pipelineId: PIPE })).toMatchObject({
      ok: false,
      error: 'forbidden',
      status: 403,
    });
    const broken = faultHttp(w.http, (m, p) => m === 'PATCH' && p.includes('/pipelines/'), 502, 1);
    expect(await breakTrim({ ...w.lever, http: broken }, { pipelineId: PIPE })).toMatchObject({ ok: false, error: 'failed', status: 502 });
    const busy = faultHttp(w.http, (m, p) => m === 'GET' && p.includes('/pipelines/'), 429, 2);
    const t0 = w.now();
    expect(await breakTrim({ ...w.lever, http: busy }, { pipelineId: PIPE })).toMatchObject({
      ok: false,
      error: 'rate_limited',
      status: 429,
    });
    expect(w.now() - t0).toBe(5_000);
    const tables = faultHttp(w.http, (m, p) => m === 'GET' && p === '/m/default/routes', 500, 1);
    expect(await applyPack({ ...w.lever, http: tables }, { routeId: 'mrd_vpc_flow' })).toMatchObject({
      ok: false,
      error: 'failed',
      status: 500,
    });
    expect((await demoState(w)).inFlight).toBeUndefined();
  });

  it('surfaces a KV failure as failed and still clears the marker', async () => {
    const w = await createWorld();
    let timelineReads = 0;
    const kv = {
      ...w.kv,
      get: (k: string) => {
        if (k === 'timeline' && ++timelineReads === 1) return Promise.reject(new Error('kv down'));
        return w.kv.get(k);
      },
    };
    const r = await breakTrim({ ...w.lever, kv }, { pipelineId: PIPE });
    expect(r).toMatchObject({
      ok: false,
      error: 'failed',
      status: 500,
      message: 'kv down',
    });
    expect((await demoState(w)).inFlight).toBeUndefined();
  });
});

describe('lever failures after the object was changed', () => {
  const commitFault = (h: CriblHttp) => faultHttp(h, (m, p) => m === 'POST' && p.endsWith('/version/commit'), 500, 1);

  it('puts a route table back when the pack commit fails (apply and revert)', async () => {
    const w = await createWorld();
    const before = await routes(w);
    expect(await applyPack({ ...w.lever, http: commitFault(w.http) }, { routeId: 'mrd_pan_firewall' })).toMatchObject({
      ok: false,
      error: 'commit_failed',
    });
    expect(await routes(w)).toEqual(before);
    ok(await applyPack(w.lever, { routeId: 'mrd_pan_firewall' }));
    const applied = await routes(w);
    expect(await revertPack({ ...w.lever, http: commitFault(w.http) }, { routeId: 'mrd_pan_firewall' })).toMatchObject({
      ok: false,
      error: 'commit_failed',
    });
    expect(await routes(w)).toEqual(applied);
    expect((await demoState(w)).routes.mrd_pan_firewall).toBeDefined();
  });

  it('puts a Source back when the rate commit fails; reset everything rolls back all it changed', async () => {
    const w = await createWorld();
    const inputBefore = await input(w, 'mrd_k8s_prod');
    expect(await setRate({ ...w.lever, http: commitFault(w.http) }, { inputId: 'mrd_k8s_prod', multiplier: 3 })).toMatchObject({
      ok: false,
      error: 'commit_failed',
    });
    expect(await input(w, 'mrd_k8s_prod')).toEqual(inputBefore);
    ok(await setRate(w.lever, { inputId: 'mrd_k8s_prod', multiplier: 3 }));
    ok(await breakTrim(w.lever, { pipelineId: 'mrd_k8s_noise' }));
    const spiked = await input(w, 'mrd_k8s_prod');
    const broken = await pipeline(w, 'mrd_k8s_noise');
    expect(await resetAll({ ...w.lever, http: commitFault(w.http) })).toMatchObject({ ok: false, error: 'commit_failed' });
    expect(await input(w, 'mrd_k8s_prod')).toEqual(spiked);
    expect(await pipeline(w, 'mrd_k8s_noise')).toEqual(broken);
    expect(Object.keys((await demoState(w)).trim)).toEqual(['mrd_k8s_noise']);
  });

  it('a failed status read or an empty commit undoes the change', async () => {
    const w = await createWorld();
    const before = await pipeline(w);
    const status = faultHttp(w.http, (_m, p) => p.endsWith('/version/status'), 500, 1);
    expect(await breakTrim({ ...w.lever, http: status }, { pipelineId: PIPE })).toMatchObject({ ok: false, error: 'failed', status: 500 });
    expect(await pipeline(w)).toEqual(before);
    // version/status lists a file that is not really pending: the Leader answers "nothing to commit".
    const ghost: CriblHttp = {
      request: (m, p, b, o) =>
        p.endsWith('/version/status')
          ? Promise.resolve({
              status: 200,
              ok: true,
              json: {
                items: [
                  {
                    files: [
                      {
                        path: `groups/default/local/cribl/pipelines/${PIPE}/ghost.yml`,
                      },
                    ],
                  },
                ],
              },
            })
          : w.http.request(m, p, b, o),
    };
    expect(await breakTrim({ ...w.lever, http: ghost }, { pipelineId: PIPE })).toMatchObject({
      ok: false,
      error: 'no_change',
      status: 409,
    });
    expect(await pipeline(w)).toEqual(before);
  });

  it('refuses a routing table it cannot find and a Source without a Datagen rate', async () => {
    const w = await createWorld();
    const empty: CriblHttp = {
      request: (m, p, b, o) =>
        m === 'GET' && p === '/m/default/routes'
          ? Promise.resolve({ status: 200, ok: true, json: { items: [] } })
          : w.http.request(m, p, b, o),
    };
    expect(await applyPack({ ...w.lever, http: empty }, { routeId: 'mrd_vpc_flow' })).toMatchObject({ ok: false, error: 'not_found' });
    const k8s = await input(w, 'mrd_k8s_prod');
    await w.em.handle({
      method: 'PATCH',
      url: '/api/v1/m/default/system/inputs/mrd_k8s_prod',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...k8s, type: 'http', samples: undefined }),
    });
    expect(await setRate(w.lever, { inputId: 'mrd_k8s_prod', multiplier: 2 })).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('Reset everything reads before it writes, and skips what is already back to normal', async () => {
    const w = await createWorld();
    const eps = ((await input(w, 'mrd_vpc_flow')).samples as { eventsPerSec: number }[])[0].eventsPerSec;
    const pipeBefore = await pipeline(w);
    const k8sBefore = await pipeline(w, 'mrd_k8s_noise');
    const k8sFns = (k8sBefore.conf as { functions: Obj[] }).functions;
    const k8sAt = k8sFns.findIndex((f) => String(f.description).includes(TRIM_TAG));
    const setAt = new Date(w.now()).toISOString();
    await w.docs.putDemoState({
      ...emptyDemoState(),
      // A garbage 'previous' is not trusted; the live trim is not broken, so nothing is written for it.
      trim: {
        [PIPE]: { functionIndex: 0, previous: { id: 'eval' }, brokenAt: setAt },
        mrd_k8s_noise: {
          functionIndex: k8sAt,
          previous: k8sFns[k8sAt],
          brokenAt: setAt,
        },
      },
      rates: {
        mrd_vpc_flow: { baselineEps: eps, multiplier: 1, setAt },
        mrd_other: { baselineEps: 1, multiplier: 2, setAt },
      },
    });
    // mrd_other is not an object in the org: the reset refuses before changing anything.
    expect(await resetAll(w.lever)).toMatchObject({
      ok: false,
      error: 'not_found',
    });
    expect(await pipeline(w)).toEqual(pipeBefore);
    const s = await demoState(w);
    delete s.rates.mrd_other;
    await w.docs.putDemoState(s);
    const r = ok(await resetAll(w.lever));
    expect(r.commit).toBeUndefined();
    expect(await pipeline(w)).toEqual(pipeBefore);
    expect(await pipeline(w, 'mrd_k8s_noise')).toEqual(k8sBefore);
  });

  it('Reset everything puts back what it changed when a later PATCH fails', async () => {
    const w = await createWorld();
    ok(await breakTrim(w.lever, { pipelineId: PIPE }));
    ok(await setRate(w.lever, { inputId: 'mrd_vpc_flow', multiplier: 4 }));
    const broken = await pipeline(w);
    const inputFault = faultHttp(w.http, (m, p) => m === 'PATCH' && p.includes('/system/inputs/'), 500, 1);
    expect(await resetAll({ ...w.lever, http: inputFault })).toMatchObject({
      ok: false,
      error: 'failed',
      status: 500,
    });
    expect(await pipeline(w)).toEqual(broken);
  });

  it('keeps going when demo/state is briefly unwritable, and warns when the in-flight marker cannot be cleared', async () => {
    const w = await createWorld();
    let puts = 0;
    const flaky: typeof w.kv = {
      ...w.kv,
      put: (k, v) => (k === 'demo/state' && ++puts === 2 ? Promise.reject(new Error('blip')) : w.kv.put(k, v)),
    };
    ok(await breakTrim({ ...w.lever, kv: flaky }, { pipelineId: PIPE }));
    expect(w.logs.some((l) => l.msg.includes('could not record demo/state'))).toBe(true);
    expect((await demoState(w)).trim[PIPE]).toBeDefined();
    let marks = 0;
    const stuck: typeof w.kv = {
      ...w.kv,
      put: (k, v) => (k === 'demo/state' && ++marks > 1 ? Promise.reject(new Error('stuck')) : w.kv.put(k, v)),
    };
    expect(await breakTrim({ ...w.lever, kv: stuck }, { pipelineId: 'mrd_nope' })).toMatchObject({ ok: false, error: 'not_found' });
    expect(w.logs.some((l) => l.msg.includes('could not clear the in-flight marker'))).toBe(true);
  });
});

describe('levers after a change made by hand in the Cribl UI', () => {
  it('Revert and Restore forget their state when the object is already back, without a commit', async () => {
    const w = await createWorld();
    ok(await applyPack(w.lever, { routeId: 'mrd_vpc_flow' }));
    ok(await breakTrim(w.lever, { pipelineId: PIPE }));
    w.em.control({ action: 'revertPack', routeId: 'mrd_vpc_flow' });
    w.em.control({ action: 'restore' });
    const reverted = ok(await revertPack(w.lever, { routeId: 'mrd_vpc_flow' }));
    expect(reverted.commit).toBeUndefined();
    const restored = ok(await restoreTrim(w.lever, { pipelineId: PIPE }));
    expect(restored.commit).toBeUndefined();
    const state = await demoState(w);
    expect(state.routes.mrd_vpc_flow).toBeUndefined();
    expect(state.trim[PIPE]).toBeUndefined();
  });
});
