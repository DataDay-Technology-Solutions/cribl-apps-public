// tests/unit/demo-client.test.ts — the Demo Console's lever client, scene runner and lever keys
// (src/demo/client.ts, sceneRunner.ts, keyboard.ts) against the emulated Cribl org (tests/integration/harness).

import { describe, expect, it, vi } from 'vitest';
import type { DemoState, Snapshot } from '../../core/types.ts';
import { emptyDemoState } from '../../core/demo/levers.ts';
import { minuteKey } from '../../core/sweep.ts';
import { MINUTE, createWorld, type World } from '../integration/harness.ts';
import {
  RETRIABLE,
  createDemoClient,
  routeIdFor,
  stageForCall,
  type ClientStatus,
  type DemoClient,
  type DemoTimers,
} from '../../src/demo/client.ts';
import { createSceneRunner, jobForCall, type RunnerEvent } from '../../src/demo/sceneRunner.ts';
import { LEVER_KEYS, installLeverKeys } from '../../src/demo/keyboard.ts';
import type { DemoActions } from '../../src/demo/actions.tsx';

// ─── Fixtures ────────────────────────────────────────────────────────────────
function manualTimers() {
  const queue: { fn: () => void; ms: number }[] = [];
  const timers: DemoTimers & {
    fire(): boolean;
    pending(): number;
    last(): number | undefined;
  } = {
    setTimeout(fn, ms) {
      const h = { fn, ms };
      queue.push(h);
      return h;
    },
    clearTimeout(h) {
      const i = queue.indexOf(h as (typeof queue)[number]);
      if (i >= 0) queue.splice(i, 1);
    },
    fire() {
      const h = queue.shift();
      h?.fn();
      return Boolean(h);
    },
    pending: () => queue.length,
    last: () => queue.at(-1)?.ms,
  };
  return timers;
}

function clientFor(
  w: World,
  extra: {
    timers?: DemoTimers;
    onDemoState?: (s: DemoState | null) => void;
    minuteBudget?: number;
  } = {},
): DemoClient {
  return createDemoClient({
    deps: {
      http: w.http,
      kv: w.kv,
      webhook: w.webhook,
      clock: { now: () => w.now() },
      codec: w.deps.codec,
      sleep: async (ms) => w.advance(ms),
      workspace: w.deps.workspace,
      linkBase: w.deps.linkBase,
      minuteBudget: extra.minuteBudget ?? 10_000,
    },
    author: async () => 's.koelpin',
    ...(extra.timers ? { timers: extra.timers } : {}),
    ...(extra.onDemoState ? { onDemoState: extra.onDemoState } : {}),
  });
}

const demoState = async (w: World): Promise<DemoState> => (await w.docs.getDemoState()) ?? emptyDemoState();
const timeline = async (w: World) => Object.values((await w.docs.getTimeline())?.byGroup ?? {}).flat();
const flush = () => new Promise((r) => setTimeout(r, 0));

// ─── Client ──────────────────────────────────────────────────────────────────
describe('demo lever client', () => {
  it('maps the Leader calls a lever makes to the status line’s stage', () => {
    expect(stageForCall('PATCH', '/m/default/pipelines/mrd_pay_sample')).toBe('saving');
    expect(stageForCall('PATCH', '/m/default/routes/default')).toBe('saving');
    expect(stageForCall('GET', '/m/default/version/status')).toBe('committing');
    expect(stageForCall('POST', '/m/default/version/commit')).toBe('committing');
    expect(stageForCall('PATCH', '/products/stream/groups/default/deploy')).toBe('deploying');
    expect(stageForCall('PUT', '/kvstore/timeline')).toBe('recording');
    expect(stageForCall('GET', '/kvstore/settings')).toBeNull();
    expect(routeIdFor('pan_firewall')).toBe('mrd_pan_firewall');
    expect([...RETRIABLE].sort()).toEqual(['budget', 'in_flight', 'locked', 'rate_limited']);
  });

  it('applies a pack as the caller, shows committing → deploying, and records the commit with the username', async () => {
    const w = await createWorld();
    const pushed: (DemoState | null)[] = [];
    const client = clientFor(w, { onDemoState: (s) => pushed.push(s) });
    const stages: ClientStatus['stage'][] = [];
    client.subscribe(() => {
      const s = client.status().stage;
      if (s && stages.at(-1) !== s) stages.push(s);
    });
    const outcome = await client.run({
      kind: 'applyPack',
      routeKey: 'windows_workstations',
      level: 'pack',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(stages).toEqual(['preparing', 'saving', 'committing', 'deploying', 'recording']);
    expect(client.status()).toMatchObject({ busy: false, last: { ok: true } });
    const commit = (await timeline(w)).find((c) => c.hash === outcome.commit);
    expect(commit).toMatchObject({
      author: 's.koelpin',
      message: 'demo: apply the pack on mrd_windows_workstations',
      source: 'demo',
    });
    expect(Object.keys((await demoState(w)).routes)).toEqual(['mrd_windows_workstations']);
    expect(pushed.at(-1)?.routes).toHaveProperty('mrd_windows_workstations');
    // The lever ledger's local copy (P2-W18): the same record the timeline got, at once, newest first.
    expect(client.status().recent).toEqual([
      expect.objectContaining({ hash: outcome.commit, message: commit!.message, author: 's.koelpin', deployedAt: commit!.deployedAt, source: 'demo' }),
    ]);
    const revert = await client.run({ kind: 'revertPack', routeKey: 'windows_workstations' });
    expect(client.status().recent?.map((c) => c.hash)).toEqual([revert.commit, outcome.commit]);
  });

  it('runs one job at a time: a second one while the first is in flight is refused as busy', async () => {
    const w = await createWorld();
    const client = clientFor(w);
    const first = client.run({
      kind: 'breakTrim',
      pipelineId: 'mrd_pay_sample',
    });
    expect(client.status().busy).toBe(true);
    const second = await client.run({
      kind: 'applyPack',
      routeKey: 'vpc_flow',
      level: 'pack',
    });
    expect(second).toMatchObject({ ok: false, error: 'busy' });
    expect((await first).ok).toBe(true);
    expect((await demoState(w)).routes).toEqual({});
  });

  it('retries a budget refusal after max(10 s, the lever’s retryInMs) with a countdown, then succeeds', async () => {
    const w = await createWorld();
    const timers = manualTimers();
    const client = clientFor(w, { timers, minuteBudget: 45 });
    await w.docs.putDemoState({
      ...emptyDemoState(),
      leverCalls: { minute: minuteKey(w.now()), calls: 45 },
    });
    const run = client.run({
      kind: 'applyPack',
      routeKey: 'pan_firewall',
      level: 'pack',
    });
    await vi.waitFor(() => expect(client.status().retry).toBeDefined());
    const retry = client.status().retry!;
    expect(retry.reason).toBe('budget');
    expect(retry.at - w.now()).toBeGreaterThanOrEqual(10_000);
    expect(timers.last()).toBe(retry.at - w.now());
    expect(client.status().busy).toBe(true);
    // The next minute's budget is free.
    w.advance(MINUTE);
    timers.fire();
    const outcome = await run;
    expect(outcome.ok).toBe(true);
    expect(client.status().retry).toBeUndefined();
  });

  it('lets the member cancel a pending retry: nothing changes', async () => {
    const w = await createWorld();
    const timers = manualTimers();
    const client = clientFor(w, { timers, minuteBudget: 45 });
    await w.docs.putDemoState({
      ...emptyDemoState(),
      leverCalls: { minute: minuteKey(w.now()), calls: 45 },
    });
    const run = client.run({
      kind: 'applyPack',
      routeKey: 'vpc_flow',
      level: 'pack',
    });
    await vi.waitFor(() => expect(client.status().retry).toBeDefined());
    client.cancelRetry();
    expect(await run).toMatchObject({ ok: false, error: 'cancelled' });
    expect(timers.pending()).toBe(0);
    expect(client.status()).toMatchObject({
      busy: false,
      last: { ok: false, error: 'cancelled' },
    });
    expect((await demoState(w)).routes).toEqual({});
  });

  it('Revert all reverts every applied pack; Restore with no id restores every broken trim', async () => {
    const w = await createWorld();
    const client = clientFor(w);
    expect((await client.run({ kind: 'revertAll' })).message).toBe('nothing_applied');
    await client.run({
      kind: 'applyPack',
      routeKey: 'windows_workstations',
      level: 'pack',
    });
    await client.run({
      kind: 'applyPack',
      routeKey: 'vpc_flow',
      level: 'pack',
    });
    await client.run({ kind: 'breakTrim', pipelineId: 'mrd_pay_sample' });
    const reverted = await client.run({ kind: 'revertAll' });
    expect(reverted.ok).toBe(true);
    expect(reverted.results.filter((r) => r.ok)).toHaveLength(2);
    const restored = await client.run({ kind: 'restoreTrim' });
    expect(restored.ok).toBe(true);
    const d = await demoState(w);
    expect(d.routes).toEqual({});
    expect(d.trim).toEqual({});
    const messages = (await timeline(w)).map((c) => c.message);
    expect(messages).toEqual(expect.arrayContaining(['demo: revert the pack on mrd_vpc_flow', 'demo: restore the trim on mrd_pay_sample']));
  });

  it('treats "already in that state" as done, and reports refusals', async () => {
    const w = await createWorld();
    const client = clientFor(w);
    expect((await client.run({ kind: 'restoreTrim', pipelineId: 'mrd_pay_sample' })).message).toBe('no_change');
    await w.putSettings((s) => {
      s.demo.enabled = false;
    });
    expect(await client.run({ kind: 'resetBaselines' })).toMatchObject({
      ok: false,
      error: 'demo_disabled',
    });
  });

  it('never lets a scene write race a lever: demo/state writes queue behind the job', async () => {
    const w = await createWorld();
    const client = clientFor(w);
    const lever = client.run({
      kind: 'breakTrim',
      pipelineId: 'mrd_pay_sample',
    });
    const write = client.updateDemoState((s) => ({
      ...s,
      scene: {
        name: 'regression',
        step: '1:wait',
        startedAt: new Date(w.now()).toISOString(),
        changed: {
          trims: ['mrd_pay_sample'],
          rates: [],
          budgets: [],
          routes: [],
        },
      },
    }));
    await Promise.all([lever, write]);
    const d = await demoState(w);
    expect(d.trim).toHaveProperty('mrd_pay_sample');
    expect(d.scene?.step).toBe('1:wait');
  });

  it('sends the weekly receipt now to every endpoint with the weekly receipt on (from a tab: the Cribl channels, D57)', async () => {
    const w = await createWorld();
    w.em.control({ action: 'config', options: { notificationApis: true } });
    await w.sweep();
    const client = clientFor(w);
    const outcome = await client.run({ kind: 'weekly' });
    expect(outcome.ok).toBe(true);
    // The default Cribl bell takes it; the world's direct webhook is the runner's (its .env), never a tab's.
    expect(outcome.weekly).toMatchObject({ sent: 1, endpoints: 1 });
    expect(w.em.bell().some((m) => /receipt/i.test(JSON.stringify(m)))).toBe(true);
    expect(w.em.sink().some((d) => d.host === 'webhook.site')).toBe(false);
  });
});

// ─── Scene runner ────────────────────────────────────────────────────────────
function storeFor(w: World) {
  let snapshot: Snapshot | null = null;
  let demo: DemoState | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    getDemoState: () => demo,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setDemo(d: DemoState | null) {
      demo = d;
      for (const l of [...listeners]) l();
    },
    async refresh() {
      snapshot = await w.docs.getSnapshot();
      demo = await w.docs.getDemoState();
      for (const l of [...listeners]) l();
    },
  };
}

const noTimers = {
  setInterval: () => 0,
  clearInterval: () => undefined,
  setTimeout: (fn: () => void) => {
    fn();
    return 0;
  },
};

describe('scene runner', () => {
  it('maps every step lever to a client job', () => {
    expect(jobForCall({ kind: 'revertPack', routeKey: 'vpc_flow' })).toEqual({
      kind: 'revertPack',
      routeKey: 'vpc_flow',
    });
    expect(jobForCall({ kind: 'restoreTrim', pipelineId: 'p' })).toEqual({
      kind: 'restoreTrim',
      pipelineId: 'p',
    });
    expect(jobForCall({ kind: 'setRate', inputId: 'i', multiplier: 5 })).toEqual({ kind: 'setRate', inputId: 'i', multiplier: 5 });
  });

  it('runs Regression end to end: break → alert (named commit) → hold → restore → recovery, persisted in demo/state.scene', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(3);
    const store = storeFor(w);
    const client = clientFor(w, { onDemoState: (s) => store.setDemo(s) });
    const events: RunnerEvent[] = [];
    const runner = createSceneRunner({
      client,
      ...store,
      now: () => w.now(),
      timers: noTimers,
      onEvent: (e) => events.push(e),
    });
    await store.refresh();

    expect(await runner.start('regression')).toEqual({ ok: true });
    await vi.waitFor(async () => expect((await demoState(w)).scene?.step).toBe('1:wait'));
    const persisted = (await demoState(w)).scene!;
    expect(persisted.changed.trims).toEqual(['mrd_pay_sample']);
    expect(persisted.expectedAlertAt).toBeDefined();
    expect((await demoState(w)).trim).toHaveProperty('mrd_pay_sample');

    // Sweeps catch the regression; the runner moves on when the snapshot shows it.
    for (let i = 0; i < 4 && runner.state().scene?.step === '1:wait'; i++) {
      await w.sweepMinutes(1);
      await store.refresh();
      await runner.evaluate();
    }
    expect(runner.state().scene?.step).toBe('2:hold');
    w.advance(60_000);
    await runner.evaluate();
    expect(runner.state().scene?.step).toBe('4:wait');
    expect((await demoState(w)).trim).toEqual({});

    for (let i = 0; i < 8 && runner.state().scene; i++) {
      await w.sweepMinutes(1);
      await store.refresh();
      await runner.evaluate();
    }
    expect(runner.state()).toMatchObject({ scene: null, owned: false });
    expect((await demoState(w)).scene).toBeUndefined();
    expect(events.map((e) => e.kind)).toEqual(['started', 'finished']);
  });

  it('refuses a second scene, and unsupported ones', async () => {
    const w = await createWorld();
    const store = storeFor(w);
    const client = clientFor(w, { onDemoState: (s) => store.setDemo(s) });
    const runner = createSceneRunner({
      client,
      ...store,
      now: () => w.now(),
      timers: noTimers,
    });
    expect(await runner.start('budget')).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    expect((await runner.start('savings')).ok).toBe(true);
    expect(await runner.start('regression')).toEqual({
      ok: false,
      reason: 'running',
    });
    await runner.abort();
  });

  it('Abort restores everything the scene changed (packs reverted, trims restored) and clears the scene', async () => {
    const w = await createWorld();
    await w.sweep();
    const store = storeFor(w);
    const client = clientFor(w, { onDemoState: (s) => store.setDemo(s) });
    const events: RunnerEvent[] = [];
    const runner = createSceneRunner({
      client,
      ...store,
      now: () => w.now(),
      timers: noTimers,
      onEvent: (e) => events.push(e),
    });
    await runner.start('savingsX3');
    await vi.waitFor(() => expect(runner.state().scene?.step).toBe('1:hold'));
    w.advance(45_000);
    await runner.evaluate();
    expect(runner.state().scene?.step).toBe('3:hold');
    expect(Object.keys((await demoState(w)).routes).sort()).toEqual(['mrd_pan_firewall', 'mrd_windows_workstations']);
    await runner.abort();
    const d = await demoState(w);
    expect(d.routes).toEqual({});
    expect(d.scene).toBeUndefined();
    expect(runner.state()).toMatchObject({ scene: null, aborting: false });
    expect(events.at(-1)).toEqual({
      kind: 'aborted',
      name: 'savingsX3',
      ok: true,
    });
  });

  it('never drives a persisted scene on its own: nothing runs until Resume (adopt), and an abandoned one cannot resume', async () => {
    const w = await createWorld();
    const store = storeFor(w);
    const client = clientFor(w, { onDemoState: (s) => store.setDemo(s) });
    const scene = {
      name: 'savings:vpc_flow',
      step: '0:lever',
      startedAt: new Date(w.now()).toISOString(),
      changed: { trims: [], rates: [], budgets: [], routes: [] },
    };
    await w.docs.putDemoState({ ...emptyDemoState(), scene });
    await store.refresh();
    const runner = createSceneRunner({ client, ...store, now: () => w.now(), timers: noTimers });
    // A console mounting, snapshots landing, the timer ticking: none of it takes the scene over.
    await runner.evaluate();
    await w.sweepMinutes(1);
    await store.refresh();
    await runner.evaluate();
    expect(runner.state()).toMatchObject({ scene: null, owned: false });
    expect((await demoState(w)).routes).toEqual({});
    expect(await timeline(w)).toEqual([]);

    // Abandoned (nothing moved for 30 min): Resume is refused.
    w.advance(31 * MINUTE);
    runner.adopt();
    expect(runner.state().owned).toBe(false);
    expect((await demoState(w)).routes).toEqual({});
    runner.dispose();
  });

  it('dismiss forgets an abandoned scene and restores nothing (and never a newer scene)', async () => {
    const w = await createWorld();
    const store = storeFor(w);
    const client = clientFor(w, { onDemoState: (s) => store.setDemo(s) });
    const events: RunnerEvent[] = [];
    const runner = createSceneRunner({ client, ...store, now: () => w.now(), timers: noTimers, onEvent: (e) => events.push(e) });
    // The trim really is broken; the scene recorded it.
    expect((await client.run({ kind: 'breakTrim', pipelineId: 'mrd_pay_sample' })).ok).toBe(true);
    const old = {
      name: 'regression',
      step: '1:wait',
      startedAt: new Date(w.now() - 45 * MINUTE).toISOString(),
      stepAt: new Date(w.now() - 44 * MINUTE).toISOString(),
      changed: { trims: ['mrd_pay_sample'], rates: [], budgets: [], routes: [] },
    };
    await client.updateDemoState((cur) => ({ ...cur, scene: old }));
    await store.refresh();
    const commitsBefore = (await timeline(w)).length;
    await runner.dismiss();
    const after = await demoState(w);
    expect(after.scene).toBeUndefined();
    expect(after.trim).toHaveProperty('mrd_pay_sample'); // nothing restored
    expect((await timeline(w)).length).toBe(commitsBefore);
    expect(runner.isEnded(old.startedAt)).toBe(true);
    expect(events).toEqual([{ kind: 'dismissed', name: 'regression' }]);

    // The store still shows the old scene while KV already holds a newer one: dismiss leaves the new one alone.
    const newer = { ...old, startedAt: new Date(w.now()).toISOString(), stepAt: new Date(w.now()).toISOString() };
    await w.docs.putDemoState({ ...after, scene: newer });
    store.setDemo({ ...after, scene: { ...old, startedAt: new Date(w.now() - 50 * MINUTE).toISOString() } });
    await runner.dismiss();
    expect((await demoState(w)).scene?.startedAt).toBe(newer.startedAt);
    runner.dispose();
  });

  it('adopts a persisted scene on Resume (a reloaded phone) and pauses on a failed step until Abort', async () => {
    const w = await createWorld();
    const store = storeFor(w);
    const client = clientFor(w, { onDemoState: (s) => store.setDemo(s) });
    // A scene another console started, one step in.
    await w.docs.putDemoState({
      ...emptyDemoState(),
      scene: {
        name: 'savings:vpc_flow',
        step: '0:lever',
        startedAt: new Date(w.now()).toISOString(),
        changed: { trims: [], rates: [], budgets: [], routes: [] },
      },
    });
    await store.refresh();
    await w.putSettings((s) => {
      s.demo.enabled = false; // the step's lever will be refused
    });
    const events: RunnerEvent[] = [];
    const runner = createSceneRunner({
      client,
      ...store,
      now: () => w.now(),
      timers: noTimers,
      onEvent: (e) => events.push(e),
    });
    runner.adopt();
    await runner.evaluate();
    await flush();
    expect(runner.state()).toMatchObject({
      owned: true,
      failed: { error: 'demo_disabled' },
    });
    expect(events.map((e) => e.kind)).toEqual(['failed']);
    await runner.abort();
    expect((await demoState(w)).scene).toBeUndefined();
    runner.dispose();
  });
});

// ─── Lever keys ──────────────────────────────────────────────────────────────
describe('lever keys (SPEC 13)', () => {
  function harness() {
    let enabled = false;
    let busy = false;
    const listeners = new Set<() => void>();
    const registered = new Map<string, () => void>();
    const chips: string[] = [];
    const calls: string[] = [];
    const actions = new Proxy({} as DemoActions, {
      get: (_t, prop: string) =>
        prop === 'isConfirming'
          ? () => false
          : (...args: unknown[]) => {
              calls.push(`${prop}(${args.join(',')})`);
              return Promise.resolve();
            },
    });
    const off = installLeverKeys({
      actions,
      isEnabled: () => enabled,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      isBusy: () => busy,
      register: (key, handler) => {
        registered.set(key, () => handler(new KeyboardEvent('keydown')));
        return () => registered.delete(key);
      },
      chip: (label) => chips.push(label),
    });
    return {
      set(next: boolean) {
        enabled = next;
        for (const l of [...listeners]) l();
      },
      busy(next: boolean) {
        busy = next;
      },
      press: (key: string) => registered.get(key)?.(),
      registered,
      chips,
      calls,
      off,
    };
  }

  it('registers the twelve lever keys only while demo mode is on', () => {
    globalThis.KeyboardEvent ??= class extends Event {} as unknown as typeof KeyboardEvent;
    const h = harness();
    expect(h.registered.size).toBe(0);
    h.set(true);
    expect([...h.registered.keys()].sort()).toEqual(['0', '1', '2', '3', 'A', 'B', 'C', 'G', 'R', 'S', 'V', 'W']);
    h.set(false);
    expect(h.registered.size).toBe(0);
    h.set(true);
    h.off();
    expect(h.registered.size).toBe(0);
  });

  it('maps each key to its lever (each opens its confirmation), with a chip', () => {
    globalThis.KeyboardEvent ??= class extends Event {} as unknown as typeof KeyboardEvent;
    const h = harness();
    h.set(true);
    for (const k of ['1', 'A', '2', '3', 'G', 'V', 'B', 'R', 'S', 'C', 'W', '0']) h.press(k);
    expect(h.calls).toEqual([
      'applyPack(windows_workstations)',
      'applyPack(windows_workstations)',
      'applyPack(pan_firewall)',
      'applyPack(vpc_flow)',
      'applyPack(windows_workstations,aggressive)',
      'revertAll()',
      'breakTrim()',
      'restore()',
      'spike()',
      'calm()',
      'weekly()',
      'resetAll()',
    ]);
    expect(h.chips).toHaveLength(12);
    expect(h.chips).toEqual(LEVER_KEYS.map((d) => d.chip)); // vitest folds demo copy to its keys
  });

  it('while a lever runs, a key only shows the busy chip', () => {
    globalThis.KeyboardEvent ??= class extends Event {} as unknown as typeof KeyboardEvent;
    const h = harness();
    h.set(true);
    h.busy(true);
    h.press('B');
    expect(h.calls).toEqual([]);
    expect(h.chips).toEqual(['demo.chipBusy']);
  });
});
