// tests/unit/demo-confirm.test.ts — every volatile Demo Console lever and scene start asks first, naming
// exactly what changes (REVIEW-3a #7; src/demo/confirm.ts, src/demo/actions.tsx, src/demo/keyboard.ts).
//
// The specs are checked with the demo build's real copy (VITE_MR_BUILD=demo, modules re-imported), so the
// strings asserted here are the ones on stage. Capra's Modal / Toast are stubbed: the tests drive the
// confirmation the way a person does (confirm, cancel) and read what it said.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DemoState } from '../../core/types.ts';
import { emptyDemoState } from '../../core/demo/levers.ts';

interface OpenedModal {
  title: string;
  content: unknown;
  confirmButtonText?: string;
  cancelButtonText?: string;
  onConfirm?: () => unknown;
  confirm(): void;
  cancel(): void;
}

const modals: OpenedModal[] = [];
const toasts: { kind: string; text: unknown }[] = [];

vi.mock('@capra/core', () => {
  // notify wraps every toast body in its marker span (src/components/common/notify.tsx): read the text inside.
  const body = (content: unknown): unknown =>
    content !== null && typeof content === 'object' && 'props' in content ? (content as { props: { children?: unknown } }).props.children : content;
  const toast = (kind: string) => (text: unknown) => {
    toasts.push({ kind, text: body(text) });
    return `t${toasts.length}`;
  };
  return {
    Modal: {
      confirm(opts: Omit<OpenedModal, 'confirm' | 'cancel'>) {
        let resolve!: () => void;
        const closed = new Promise<void>((r) => (resolve = r));
        const m: OpenedModal = {
          ...opts,
          confirm() {
            void opts.onConfirm?.();
            resolve();
          },
          cancel() {
            resolve();
          },
        };
        modals.push(m);
        return { close: () => resolve(), closed };
      },
    },
    Toast: { success: toast('success'), info: toast('info'), warning: toast('warning'), error: toast('error') },
  };
});

type ConfirmModule = typeof import('../../src/demo/confirm.ts');
type ActionsModule = typeof import('../../src/demo/actions.tsx');
type KeyboardModule = typeof import('../../src/demo/keyboard.ts');

let C: ConfirmModule;
let A: ActionsModule;
let K: KeyboardModule;

beforeEach(async () => {
  vi.stubEnv('VITE_MR_BUILD', 'demo');
  vi.resetModules();
  C = await import('../../src/demo/confirm.ts');
  A = await import('../../src/demo/actions.tsx');
  K = await import('../../src/demo/keyboard.ts');
  modals.length = 0;
  toasts.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const T = '2026-09-26T08:00:00.000Z';
const demo = (patch: Partial<DemoState> = {}): DemoState => ({ ...emptyDemoState(), ...patch });
const ctx = (d: DemoState | null = demo(), weekly: { id: string; name: string }[] = []) => ({ demoState: d, weeklyEndpoints: weekly, groupId: 'default' });

describe('lever confirmations name exactly what changes', () => {
  it('Apply the pack: the route, its pipeline before → after, committed and deployed to worker group default', () => {
    const spec = C.confirmSpecForJob({ kind: 'applyPack', routeKey: 'windows_workstations', level: 'pack' }, ctx())!;
    expect(spec.title).toBe('Apply the Windows XML pack to Windows workstations?');
    expect(spec.items).toEqual([
      { label: 'Route for Windows workstations', id: 'mrd_windows_workstations', action: 'pipeline mrd_passthrough → mrd_win_xml_pack' },
    ]);
    expect(spec.deployGroup).toBe('default');
    expect(spec.tone).toBe('default');
    expect(spec.confirmText).toBe('Apply the pack');
  });

  it('Go aggressive over an applied pack reads the route id demo/state holds (either spelling)', () => {
    const d = demo({ routes: { mrd_rt_windows_workstations: { previousPipelineId: 'mrd_passthrough', appliedAt: T, level: 'pack' } } });
    const spec = C.confirmSpecForJob({ kind: 'applyPack', routeKey: 'windows_workstations', level: 'aggressive' }, ctx(d))!;
    expect(spec.title).toBe('Go aggressive on Windows workstations?');
    expect(spec.items[0]).toMatchObject({ id: 'mrd_rt_windows_workstations', action: 'pipeline mrd_win_xml_pack → mrd_win_docs_reduce' });
    // Already there: nothing to ask.
    expect(C.confirmSpecForJob({ kind: 'applyPack', routeKey: 'windows_workstations', level: 'pack' }, ctx(d))).toBeNull();
  });

  it('Revert and Revert all go back to the recorded previous pipeline; nothing applied → no question', () => {
    const d = demo({
      routes: {
        mrd_pan_firewall: { previousPipelineId: 'mrd_passthrough', appliedAt: T, level: 'pack' },
        mrd_vpc_flow: { previousPipelineId: 'mrd_passthrough', appliedAt: T, level: 'pack' },
      },
    });
    expect(C.confirmSpecForJob({ kind: 'revertPack', routeKey: 'pan_firewall' }, ctx(d))!.items).toEqual([
      { label: 'Route for Palo Alto firewalls', id: 'mrd_pan_firewall', action: 'pipeline mrd_pan_pack → mrd_passthrough' },
    ]);
    const all = C.confirmSpecForJob({ kind: 'revertAll' }, ctx(d))!;
    expect(all.items.map((i) => i.id)).toEqual(['mrd_pan_firewall', 'mrd_vpc_flow']);
    expect(all.deployGroup).toBe('default');
    expect(C.confirmSpecForJob({ kind: 'revertAll' }, ctx())).toBeNull();
    expect(C.confirmSpecForJob({ kind: 'revertPack', routeKey: 'vpc_flow' }, ctx())).toBeNull();
  });

  it('Break the trim keeps its danger variant and says when the alert is expected (measured lag 127 s → ~2:07)', () => {
    const measured = C.confirmSpecForJob({ kind: 'breakTrim', pipelineId: 'mrd_pay_sample' }, ctx(demo({ measuredLagSec: 127 })))!;
    expect(measured.title).toBe('Break the trim on Payments API sampling?');
    expect(measured.tone).toBe('danger');
    expect(measured.items).toEqual([{ label: 'Pipeline Payments API sampling', id: 'mrd_pay_sample', action: 'disable the [mr-trim] function' }]);
    expect(measured.deployGroup).toBe('default');
    expect(measured.note).toBe('Alert expected in ~2:07 (measured lag).');
    // Unmeasured (the 240 s default) says it is an estimate.
    expect(C.confirmSpecForJob({ kind: 'breakTrim', pipelineId: 'mrd_pay_sample' }, ctx())!.note).toBe(
      'Alert expected in ~4:00 (estimate until the lag is measured).',
    );
    const broken = demo({ trim: { mrd_pay_sample: { functionIndex: 1, previous: {}, brokenAt: T } } });
    expect(C.confirmSpecForJob({ kind: 'breakTrim', pipelineId: 'mrd_pay_sample' }, ctx(broken))).toBeNull();
  });

  it('Restore names every broken trim; with none broken there is nothing to ask', () => {
    const broken = demo({ trim: { mrd_pay_sample: { functionIndex: 1, previous: {}, brokenAt: T } } });
    const spec = C.confirmSpecForJob({ kind: 'restoreTrim' }, ctx(broken))!;
    expect(spec.items).toEqual([{ label: 'Pipeline Payments API sampling', id: 'mrd_pay_sample', action: 'enable the [mr-trim] function again' }]);
    expect(spec.deployGroup).toBe('default');
    expect(C.confirmSpecForJob({ kind: 'restoreTrim' }, ctx())).toBeNull();
    // demo/state not loaded yet: ask about the stage trim rather than refuse.
    expect(C.confirmSpecForJob({ kind: 'restoreTrim' }, ctx(null))!.items[0]!.id).toBe('mrd_pay_sample');
  });

  it('Spike and Calm name the Source and the rate before → after', () => {
    const spike = C.confirmSpecForJob({ kind: 'setRate', inputId: 'mrd_payments_api', multiplier: 5 }, ctx())!;
    expect(spike.title).toBe('Spike Payments API ×5?');
    expect(spike.items).toEqual([{ label: 'Source Payments API', id: 'mrd_payments_api', action: 'Datagen rate 1× → 5×' }]);
    const hot = demo({ rates: { mrd_payments_api: { baselineEps: 100, multiplier: 5, setAt: T } } });
    expect(C.confirmSpecForJob({ kind: 'setRate', inputId: 'mrd_payments_api', multiplier: 1 }, ctx(hot))!.items[0]!.action).toBe(
      'Datagen rate 5× → 1×',
    );
    expect(C.confirmSpecForJob({ kind: 'setRate', inputId: 'mrd_payments_api', multiplier: 1 }, ctx())).toBeNull();
  });

  it('Reset everything lists what it restores; it deploys only when a trim or rate changes', () => {
    const quiet = C.confirmSpecForJob({ kind: 'resetAll' }, ctx())!;
    expect(quiet.deployGroup).toBeUndefined();
    expect(quiet.items).toEqual([{ label: 'Open demo alerts', action: 'close' }]);
    const busy = demo({
      trim: { mrd_pay_sample: { functionIndex: 1, previous: {}, brokenAt: T } },
      rates: { mrd_payments_api: { baselineEps: 100, multiplier: 5, setAt: T } },
      budgetsOverride: { mrd_siem_prod: {} },
      scene: { name: 'full', step: '6:lever', startedAt: T, changed: { trims: [], rates: [], budgets: [], routes: [] } },
    });
    const spec = C.confirmSpecForJob({ kind: 'resetAll' }, ctx(busy))!;
    expect(spec.deployGroup).toBe('default');
    expect(spec.items.map((i) => i.id ?? i.label)).toEqual([
      'mrd_pay_sample',
      'mrd_payments_api',
      'mrd_siem_prod',
      'Open demo alerts',
      'The scene in progress',
    ]);
  });

  it('Reset baselines and the weekly receipt change nothing in Cribl, so they name no worker group', () => {
    const baselines = C.confirmSpecForJob({ kind: 'resetBaselines' }, ctx())!;
    expect(baselines.items).toEqual([{ label: 'Detection baselines', id: 'baselines', action: 'delete' }]);
    expect(baselines.deployGroup).toBeUndefined();
    expect(baselines.note).toBe('This cannot be undone.');
    const weekly = C.confirmSpecForJob({ kind: 'weekly' }, ctx(demo(), [{ id: 'ep1', name: 'Stage webhook' }]))!;
    expect(weekly.items).toEqual([{ label: 'Endpoint Stage webhook', action: 'send the receipt' }]);
    expect(weekly.deployGroup).toBeUndefined();
    expect(C.confirmSpecForJob({ kind: 'weekly' }, ctx())).toBeNull();
  });

  it('every config lever names its object ids and the worker group', () => {
    const d = demo({ routes: { mrd_vpc_flow: { previousPipelineId: 'mrd_passthrough', appliedAt: T, level: 'pack' } } });
    const jobs = [
      { kind: 'applyPack', routeKey: 'pan_firewall', level: 'pack' },
      { kind: 'revertPack', routeKey: 'vpc_flow' },
      { kind: 'revertAll' },
      { kind: 'breakTrim', pipelineId: 'mrd_pay_sample' },
      { kind: 'setRate', inputId: 'mrd_payments_api', multiplier: 5 },
    ] as const;
    for (const job of jobs) {
      const spec = C.confirmSpecForJob(job, ctx(d))!;
      expect(spec.deployGroup, job.kind).toBe('default');
      expect(spec.items.length, job.kind).toBeGreaterThan(0);
      for (const item of spec.items) expect(item.id, job.kind).toMatch(/^mrd_/);
    }
  });
});

describe('scene confirmations', () => {
  it('every visible scene asks, listing each object it changes and undoes', async () => {
    const { VISIBLE_SCENES } = await import('../../src/demo/scenes.ts');
    const weekly = [{ id: 'ep1', name: 'Stage webhook' }];
    for (const name of VISIBLE_SCENES) {
      const spec = C.confirmSpecForScene(name, undefined, ctx(demo({ measuredLagSec: 127 }), weekly));
      expect(spec.deployGroup, name).toBe('default');
      expect(spec.items.length, name).toBeGreaterThan(0);
    }
    const regression = C.confirmSpecForScene('regression', undefined, ctx(demo({ measuredLagSec: 127 })));
    expect(regression.title).toBe('Start the Regression scene?');
    expect(regression.tone).toBe('danger');
    expect(regression.items).toEqual([
      { label: 'Pipeline Payments API sampling', id: 'mrd_pay_sample', action: 'disable the [mr-trim] function, then restore it' },
    ]);
    expect(regression.note).toBe('Alert expected in ~2:07 (measured lag).');
    const x3 = C.confirmSpecForScene('savingsX3', undefined, ctx());
    expect(x3.tone).toBe('default');
    expect(x3.items.map((i) => i.id)).toEqual(['mrd_windows_workstations', 'mrd_pan_firewall', 'mrd_vpc_flow']);
    expect(x3.items[2]!.action).toBe('pipeline mrd_passthrough → mrd_vpc_pack, then back');
    const full = C.confirmSpecForScene('full', undefined, ctx(demo(), weekly));
    expect(full.items.map((i) => i.id ?? i.label)).toEqual(['mrd_pay_sample', 'mrd_payments_api', 'Endpoint Stage webhook']);
    expect(full.items[1]!.action).toBe('Datagen rate 1× → 5×, then back to 1×');
  });

  it('Abandon and restore lists the packs to revert and what Reset everything restores', () => {
    const d = demo({
      routes: { mrd_windows_workstations: { previousPipelineId: 'mrd_passthrough', appliedAt: T, level: 'pack' } },
      trim: { mrd_pay_sample: { functionIndex: 1, previous: {}, brokenAt: T } },
    });
    const scene = { name: 'savings', step: '2:hold', startedAt: T, changed: { trims: ['mrd_pay_sample'], rates: [], budgets: [], routes: ['windows_workstations'] } };
    const out = C.abandonItems(scene, ctx(d));
    expect(out.deployGroup).toBe('default');
    expect(out.items.map((i) => [i.id, i.action])).toEqual([
      ['mrd_windows_workstations', 'pipeline mrd_win_xml_pack → mrd_passthrough'],
      ['mrd_pay_sample', 'enable the [mr-trim] function again'],
    ]);
    const untouched = C.abandonItems({ ...scene, changed: { trims: [], rates: [], budgets: [], routes: [] } }, ctx(d));
    expect(untouched).toEqual({ items: [] });
  });
});

// ─── Actions: the confirmation is the only way in ────────────────────────────
function fakeClient(opts: { busy?: boolean } = {}) {
  const runs: unknown[] = [];
  return {
    runs,
    client: {
      run: vi.fn(async (job: unknown) => {
        runs.push(job);
        return { ok: true, job, results: [] };
      }),
      status: () => ({ busy: Boolean(opts.busy) }),
    },
  };
}

function fakeRunner(scene: unknown = null) {
  return {
    state: () => ({ scene, owned: false, acting: false, aborting: false }),
    start: vi.fn(async () => ({ ok: true })),
    abort: vi.fn(async () => undefined),
    adopt: vi.fn(),
    dismiss: vi.fn(async () => undefined),
  };
}

function actionsWith(d: DemoState | null, extra: { busy?: boolean; scene?: unknown } = {}) {
  const c = fakeClient(extra);
  const runner = fakeRunner(extra.scene ?? null);
  const actions = A.createDemoActions({
    client: c.client as never,
    runner: runner as never,
    demoProfile: () => true,
    demoState: () => d,
    weeklyEndpoints: () => [{ id: 'ep1', name: 'Stage webhook' }],
  });
  return { actions, runs: c.runs, runner };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('demo actions', () => {
  it('asks before every lever and runs it only on confirm; cancel runs nothing', async () => {
    const { actions, runs } = actionsWith(demo());
    const levers: [string, () => Promise<unknown>][] = [
      ['apply', () => actions.applyPack('pan_firewall')],
      ['aggressive', () => actions.applyPack('windows_workstations', 'aggressive')],
      ['break', () => actions.breakTrim()],
      ['spike', () => actions.spike()],
      ['reset', () => actions.resetAll()],
      ['baselines', () => actions.resetBaselines()],
      ['weekly', () => actions.weekly()],
    ];
    for (const [name, pull] of levers) {
      const cancelled = pull();
      await flush();
      expect(modals, name).toHaveLength(1);
      expect(actions.isConfirming(), name).toBe(true);
      modals.pop()!.cancel();
      expect(await cancelled, name).toBeNull();
      expect(actions.isConfirming(), name).toBe(false);
    }
    expect(runs).toEqual([]);

    const confirmed = actions.applyPack('pan_firewall');
    await flush();
    const m = modals.pop()!;
    expect(m.title).toBe('Apply the Palo Alto pack to Palo Alto firewalls?');
    expect(m.confirmButtonText).toBe('Apply the pack');
    expect(m.cancelButtonText).toBe('Cancel');
    m.confirm();
    expect(await confirmed).toMatchObject({ ok: true });
    expect(runs).toEqual([{ kind: 'applyPack', routeKey: 'pan_firewall', level: 'pack' }]);
    expect(toasts.at(-1)).toMatchObject({ kind: 'success' });
  });

  it('opens one confirmation at a time: a second lever while one is up does nothing', async () => {
    const { actions } = actionsWith(demo());
    void actions.applyPack('vpc_flow');
    await flush();
    expect(await actions.spike()).toBeNull();
    expect(await actions.startScene('savings')).toBe(false);
    expect(modals).toHaveLength(1);
    modals.pop()!.cancel();
  });

  it('never asks while a lever is in flight, or when nothing would change', async () => {
    const busy = actionsWith(demo(), { busy: true });
    expect(await busy.actions.breakTrim()).toBeNull();
    expect(modals).toHaveLength(0);
    expect(toasts.at(-1)).toMatchObject({ kind: 'info', text: 'A lever is running. Try again when it returns.' });

    const idle = actionsWith(demo());
    expect(await idle.actions.revertAll()).toBeNull();
    expect(await idle.actions.calm()).toBeNull();
    expect(modals).toHaveLength(0);
    expect(idle.runs).toEqual([]);
    expect(toasts.map((x) => x.text)).toContain('No pack is applied; nothing to revert.');
  });

  it('starts a scene only after its confirmation, and never over a scene already in demo/state', async () => {
    const { actions, runner } = actionsWith(demo());
    const started = actions.startScene('regression');
    await flush();
    const m = modals.pop()!;
    expect(m.title).toBe('Start the Regression scene?');
    expect(runner.start).not.toHaveBeenCalled();
    m.confirm();
    expect(await started).toBe(true);
    expect(runner.start).toHaveBeenCalledWith('regression', undefined);

    const left = { name: 'savings', step: '1:wait', startedAt: T, changed: { trims: [], rates: [], budgets: [], routes: [] } };
    const blocked = actionsWith(demo({ scene: left }));
    expect(await blocked.actions.startScene('savings')).toBe(false);
    expect(modals).toHaveLength(0);
    expect(blocked.runner.start).not.toHaveBeenCalled();
  });

  it('Resume, Abandon and restore, and Dismiss go straight to the runner (the left-scene card is the question)', async () => {
    const { actions, runner } = actionsWith(demo());
    actions.resumeScene();
    await actions.abortScene();
    await actions.dismissScene();
    expect(runner.adopt).toHaveBeenCalledTimes(1);
    expect(runner.abort).toHaveBeenCalledTimes(1);
    expect(runner.dismiss).toHaveBeenCalledTimes(1);
    expect(modals).toHaveLength(0);
  });
});

describe('lever keys open the same confirmation', () => {
  it('a key opens the question; keys pressed while it is up do nothing (no chip, no second question)', async () => {
    globalThis.KeyboardEvent ??= class extends Event {} as unknown as typeof KeyboardEvent;
    const { actions } = actionsWith(demo());
    const handlers = new Map<string, () => void>();
    const chips: string[] = [];
    const off = K.installLeverKeys({
      actions,
      isEnabled: () => true,
      subscribe: () => () => undefined,
      isBusy: () => false,
      register: (key, handler) => {
        handlers.set(key, () => handler(new KeyboardEvent('keydown')));
        return () => handlers.delete(key);
      },
      chip: (label) => chips.push(label),
    });
    handlers.get('B')!();
    await flush();
    expect(modals).toHaveLength(1);
    expect(modals[0]!.title).toBe('Break the trim on Payments API sampling?');
    expect(chips).toEqual(['Break the trim']);
    handlers.get('0')!();
    handlers.get('2')!();
    await flush();
    expect(modals).toHaveLength(1);
    expect(chips).toEqual(['Break the trim']);
    modals.pop()!.cancel();
    await flush();
    handlers.get('0')!();
    await flush();
    expect(modals.pop()!.title).toBe('Reset everything to baseline?');
    off();
  });
});
