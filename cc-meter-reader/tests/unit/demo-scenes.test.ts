// tests/unit/demo-scenes.test.ts — the Demo Console's scene state machine (src/demo/scenes.ts) and the
// console's derived state (src/demo/derive.ts). Pure: no I/O, no copy strings.

import { describe, expect, it } from 'vitest';
import type { DemoState, FlowFigures, Incident, Snapshot } from '../../core/types.ts';
import { emptyDemoState } from '../../core/demo/levers.ts';
import {
  HOLD_MS,
  NARROW_RATIO,
  SCENES,
  SCENE_ABANDON_MS,
  SCENE_ORDER,
  VISIBLE_SCENES,
  WAIT_MAX_MS,
  X3_GAP_MS,
  advanceScene,
  conditionMet,
  currentStep,
  expectedAlertAt,
  incidentsFor,
  isSceneAbandoned,
  leftScene,
  newScene,
  nextStep,
  parseSceneName,
  recordChange,
  sceneLastMovedMs,
  sceneProgress,
  sceneScript,
  stepIndex,
  type PersistedScene,
} from '../../src/demo/scenes.ts';
import {
  RECOVERED_SHOW_MS,
  focusIncident,
  isMeasuring,
  nextAlert,
  rateState,
  remoteLever,
  streamStates,
  trimState,
} from '../../src/demo/derive.ts';

const T0 = Date.UTC(2026, 8, 28, 15, 0, 20);
const iso = (ms: number) => new Date(ms).toISOString();

function flow(partial: Partial<FlowFigures>): FlowFigures {
  return {
    key: 'k',
    groupId: 'default',
    inputId: 'mrd_windows_workstations',
    routeId: 'mrd_windows_workstations',
    pipelineId: 'mrd_passthrough',
    outputId: 'mrd_siem_prod',
    inB: 1,
    outB: 1,
    whpM: 1,
    paidM: 1,
    savedM: 0,
    ratio: 0,
    ratePerHourM: 0,
    savedPerDayM: 0,
    whpPerDayM: 0,
    paidPerDayM: 0,
    inBPerDay: 0,
    outBPerDay: 0,
    attribution: 'route',
    sparkline: [],
    state: 'ok',
    ...partial,
  };
}

function incident(partial: Partial<Incident>): Incident {
  return {
    id: 'i1',
    type: 'regression',
    severity: 'high',
    objectKey: 'route:default:mrd_payments_api',
    label: 'Payments API sampling',
    openedAt: iso(T0),
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    notes: [],
    deliveries: [],
    ...partial,
  };
}

function snapshot(partial: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: 1,
    sweepAt: iso(T0),
    windowStart: iso(T0 - 60_000),
    windowEnd: iso(T0),
    mode: 'ui',
    headline: {} as Snapshot['headline'],
    ratePerSecM: 0,
    flows: [],
    destinations: [],
    topSavers: [],
    unpricedOutputIds: [],
    openIncidents: 0,
    incidents: [],
    trend: [],
    ratioSeries: [],
    timeline: [],
    deliveries: [],
    calls: 0,
    collectingSince: iso(T0 - 86_400_000),
    metricsSource: 'metrics-query',
    attributionSummary: 'route',
    ...partial,
  };
}

describe('scene scripts (PRD 8.7, SPEC 11)', () => {
  it('Savings applies the chosen stream, waits for it to narrow, holds 60 s, then reverts', () => {
    const steps = sceneScript('savings', 'pan_firewall');
    expect(steps.map((s) => s.kind)).toEqual(['lever', 'wait', 'hold', 'lever']);
    expect(steps[0]).toMatchObject({
      call: { kind: 'applyPack', routeKey: 'pan_firewall', level: 'pack' },
    });
    expect(steps[1]).toMatchObject({
      until: { kind: 'narrow', routeKeys: ['pan_firewall'] },
      maxMs: WAIT_MAX_MS,
    });
    expect(steps[2]).toMatchObject({ ms: HOLD_MS });
    expect(steps[3]).toMatchObject({
      call: { kind: 'revertPack', routeKey: 'pan_firewall' },
    });
  });

  it('Savings ×3 applies Windows, Palo Alto, VPC Flow 45 s apart and reverts all three', () => {
    const steps = sceneScript('savingsX3');
    const levers = steps
      .filter((s) => s.kind === 'lever')
      .map((s) => (s.kind === 'lever' ? `${s.call.kind}:${'routeKey' in s.call ? s.call.routeKey : ''}` : ''));
    expect(levers).toEqual([
      'applyPack:windows_workstations',
      'applyPack:pan_firewall',
      'applyPack:vpc_flow',
      'revertPack:vpc_flow',
      'revertPack:pan_firewall',
      'revertPack:windows_workstations',
    ]);
    expect(steps.filter((s) => s.kind === 'hold' && s.ms === X3_GAP_MS)).toHaveLength(2);
  });

  it('Regression breaks the Payments API trim, waits for the alert, holds, restores and waits for recovery', () => {
    expect(sceneScript('regression').map((s) => s.label)).toEqual(['breaking', 'waitingAlert', 'holding', 'restoring', 'waitingRecovery']);
    expect(sceneScript('regression')[0]).toMatchObject({
      call: { kind: 'breakTrim', pipelineId: 'mrd_pay_sample' },
    });
  });

  it('Full show chains regression → spike → weekly receipt; Budget pace is unsupported and hidden (BEAUTY F15)', () => {
    const full = sceneScript('full');
    expect(full.at(-1)?.kind).toBe('receipt');
    expect(full.some((s) => s.kind === 'lever' && s.call.kind === 'setRate')).toBe(true);
    expect(SCENES.budget.supported).toBe(false);
    expect(sceneScript('budget')).toEqual([]);
    // Hidden from the console, but a persisted `budget` scene still parses.
    expect(VISIBLE_SCENES).toEqual(['savings', 'regression', 'savingsX3', 'spike', 'full']);
    expect(SCENE_ORDER).toContain('budget');
    expect(parseSceneName('budget')).toEqual({ name: 'budget' });
  });

  it('the narrow threshold is one the rig reaches (Windows pack 0.34, Palo Alto 0.37: docs/RIG.md §5)', () => {
    expect(NARROW_RATIO).toBeLessThan(0.34);
  });
});

describe('persisted scene', () => {
  it('encodes its position as "<index>:<kind>" and moves forward one step at a time', () => {
    const s0 = newScene('regression', T0);
    expect(s0).toMatchObject({
      name: 'regression',
      step: '0:lever',
      startedAt: iso(T0),
      stepAt: iso(T0),
    });
    expect(s0.changed).toEqual({
      trims: [],
      rates: [],
      budgets: [],
      routes: [],
    });
    const { scene: s1, done } = nextStep(s0, T0 + 5_000);
    expect(done).toBe(false);
    expect(s1).toMatchObject({ step: '1:wait', stepAt: iso(T0 + 5_000) });
    expect(stepIndex(s1)).toBe(1);
    expect(currentStep(s1)?.kind).toBe('wait');
    let s = s1;
    for (let i = 0; i < 3; i++) s = nextStep(s, T0).scene;
    expect(nextStep(s, T0).done).toBe(true);
  });

  it('keeps the Savings stream in the name and reads it back', () => {
    const s = newScene('savings', T0, 'vpc_flow');
    expect(s.name).toBe('savings:vpc_flow');
    expect(parseSceneName(s.name)).toEqual({
      name: 'savings',
      routeKey: 'vpc_flow',
    });
    expect(parseSceneName('regression')).toEqual({ name: 'regression' });
    expect(parseSceneName('nonsense')).toBeUndefined();
    expect(stepIndex({ step: 'garbage' })).toBe(0);
  });

  it('records what each lever changed, so Abort can undo exactly that', () => {
    let s = newScene('full', T0);
    s = recordChange(s, { kind: 'breakTrim', pipelineId: 'mrd_pay_sample' });
    s = recordChange(s, {
      kind: 'applyPack',
      routeKey: 'pan_firewall',
      level: 'pack',
    });
    s = recordChange(s, {
      kind: 'setRate',
      inputId: 'mrd_payments_api',
      multiplier: 5,
    });
    expect(s.changed).toEqual({
      trims: ['mrd_pay_sample'],
      rates: ['mrd_payments_api'],
      budgets: [],
      routes: ['pan_firewall'],
    });
    s = recordChange(s, { kind: 'restoreTrim', pipelineId: 'mrd_pay_sample' });
    s = recordChange(s, { kind: 'revertPack', routeKey: 'pan_firewall' });
    s = recordChange(s, {
      kind: 'setRate',
      inputId: 'mrd_payments_api',
      multiplier: 1,
    });
    expect(s.changed).toEqual({
      trims: [],
      rates: [],
      budgets: [],
      routes: [],
    });
  });
});

describe('advanceScene', () => {
  it('asks for the lever of a lever step, and for the receipt of a receipt step', () => {
    expect(advanceScene(newScene('regression', T0), null, T0)).toEqual({
      kind: 'lever',
      call: { kind: 'breakTrim', pipelineId: 'mrd_pay_sample' },
    });
    let s = newScene('full', T0);
    while (currentStep(s)?.kind !== 'receipt') s = nextStep(s, T0).scene;
    expect(advanceScene(s, null, T0)).toEqual({ kind: 'receipt' });
  });

  it('holds until the hold has elapsed', () => {
    let s = newScene('regression', T0);
    s = nextStep(nextStep(s, T0).scene, T0).scene; // hold
    expect(advanceScene(s, null, T0 + HOLD_MS - 1)).toEqual({ kind: 'idle' });
    expect(advanceScene(s, null, T0 + HOLD_MS)).toEqual({
      kind: 'advance',
      reason: 'elapsed',
    });
  });

  it('waits for the alert on the payments objects opened after the scene started, else times out at 6 min', () => {
    const s = nextStep(newScene('regression', T0), T0 + 10_000).scene;
    const before = snapshot({
      incidents: [incident({ openedAt: iso(T0 - 60_000) })],
    });
    expect(advanceScene(s, before, T0 + 60_000)).toEqual({ kind: 'idle' });
    const other = snapshot({
      incidents: [
        incident({
          objectKey: 'route:default:mrd_k8s_prod',
          openedAt: iso(T0 + 90_000),
        }),
      ],
    });
    expect(advanceScene(s, other, T0 + 100_000)).toEqual({ kind: 'idle' });
    const hit = snapshot({
      incidents: [incident({ openedAt: iso(T0 + 150_000) })],
    });
    expect(advanceScene(s, hit, T0 + 160_000)).toEqual({
      kind: 'advance',
      reason: 'met',
    });
    // Either route-id spelling (live rig vs the first emulator rig) counts.
    const alt = snapshot({
      incidents: [
        incident({
          objectKey: 'route:default:mrd_rt_payments_api',
          openedAt: iso(T0 + 150_000),
        }),
      ],
    });
    expect(advanceScene(s, alt, T0 + 160_000)).toEqual({
      kind: 'advance',
      reason: 'met',
    });
    expect(advanceScene(s, before, T0 + 10_000 + WAIT_MAX_MS)).toEqual({
      kind: 'advance',
      reason: 'timeout',
    });
  });

  it('waits for the incident the scene caused to close (recovery)', () => {
    let s = newScene('regression', T0);
    for (let i = 0; i < 4; i++) s = nextStep(s, T0 + 200_000).scene;
    expect(currentStep(s)?.label).toBe('waitingRecovery');
    const open = snapshot({
      incidents: [incident({ openedAt: iso(T0 + 150_000) })],
    });
    expect(advanceScene(s, open, T0 + 260_000).kind).toBe('idle');
    const closed = snapshot({
      incidents: [incident({ openedAt: iso(T0 + 150_000), closedAt: iso(T0 + 300_000) })],
    });
    expect(advanceScene(s, closed, T0 + 310_000)).toEqual({
      kind: 'advance',
      reason: 'met',
    });
  });

  it('counts a stream as narrowed only on a sweep after the wait began, at ratio ≥ 0.25', () => {
    const s = nextStep(newScene('savings', T0), T0 + 10_000).scene;
    const stale = snapshot({
      sweepAt: iso(T0 + 5_000),
      flows: [flow({ ratio: 0.34 })],
    });
    expect(conditionMet({ kind: 'narrow', routeKeys: ['windows_workstations'] }, stale, T0 + 10_000, T0)).toBe(false);
    const raw = snapshot({
      sweepAt: iso(T0 + 70_000),
      flows: [flow({ ratio: 0 })],
    });
    expect(advanceScene(s, raw, T0 + 70_000).kind).toBe('idle');
    const narrowed = snapshot({
      sweepAt: iso(T0 + 130_000),
      flows: [flow({ ratio: 0.34, pipelineId: 'mrd_win_xml_pack' })],
    });
    expect(advanceScene(s, narrowed, T0 + 130_000)).toEqual({
      kind: 'advance',
      reason: 'met',
    });
    expect(conditionMet({ kind: 'narrow', routeKeys: ['windows_workstations', 'vpc_flow'] }, narrowed, T0, T0)).toBe(false);
  });

  it('finishes past the last step', () => {
    let s = newScene('savings', T0);
    for (let i = 0; i < 4; i++) s = nextStep(s, T0).scene;
    expect(advanceScene(s, null, T0)).toEqual({ kind: 'finish' });
  });
});

describe('scene progress ("Broke the trim 0:42 ago · alert expected in ~1:30")', () => {
  it('counts from the break and the expected alert time', () => {
    const s: PersistedScene = {
      ...nextStep(newScene('regression', T0), T0 + 5_000).scene,
      expectedAlertAt: expectedAlertAt(T0 + 5_000, 240),
    };
    const p = sceneProgress(s, T0 + 47_000, {
      brokenAtMs: T0 + 5_000,
      measuredLagSec: 240,
    })!;
    expect(p).toMatchObject({
      name: 'regression',
      index: 1,
      total: 5,
      label: 'waitingAlert',
      sinceBreakMs: 42_000,
      alertInMs: 198_000,
    });
    expect(p.stepRemainingMs).toBe(WAIT_MAX_MS - 42_000);
  });

  it('falls back to the break time plus the measured lag, and reports holds as time left', () => {
    let s = newScene('regression', T0);
    s = nextStep(s, T0).scene;
    const p = sceneProgress(s, T0 + 30_000, {
      brokenAtMs: T0,
      measuredLagSec: 120,
    })!;
    expect(p.alertInMs).toBe(90_000);
    s = nextStep(s, T0 + 100_000).scene;
    expect(sceneProgress(s, T0 + 130_000, { measuredLagSec: 120 })!.stepRemainingMs).toBe(30_000);
    expect(sceneProgress({ ...s, name: 'bogus' }, T0, { measuredLagSec: 120 })).toBeUndefined();
  });
});

describe('console state (src/demo/derive.ts)', () => {
  const demo = (patch: Partial<DemoState>): DemoState => ({
    ...emptyDemoState(),
    ...patch,
  });

  it('reads each raw stream as raw / pack / aggressive from demo/state, under either route-id spelling', () => {
    const d = demo({
      routes: {
        mrd_windows_workstations: {
          previousPipelineId: 'mrd_passthrough',
          appliedAt: iso(T0),
          level: 'aggressive',
        },
        mrd_rt_pan_firewall: {
          previousPipelineId: 'mrd_passthrough',
          appliedAt: iso(T0),
          level: 'pack',
        },
      },
    });
    const snap = snapshot({
      windowEnd: iso(T0 + 3 * 60_000),
      flows: [flow({ ratio: 0.7, savedPerDayM: 14_000_000 })],
    });
    const states = streamStates(d, snap);
    expect(states.map((s) => s.level)).toEqual(['aggressive', 'pack', 'raw']);
    expect(states[0]).toMatchObject({
      ratio: 0.7,
      savedPerDayM: 14_000_000,
      measuring: false,
    });
    expect(states[2].ratio).toBeUndefined();
  });

  it('says "measuring" until the snapshot has metered a whole minute after the change', () => {
    const change = T0; // 15:00:20 → takes effect 15:01:00 → first full minute ends 15:02:00
    expect(isMeasuring(change, snapshot({ windowEnd: iso(Date.UTC(2026, 8, 28, 15, 1, 0)) }))).toBe(true);
    expect(isMeasuring(change, snapshot({ windowEnd: iso(Date.UTC(2026, 8, 28, 15, 2, 0)) }))).toBe(false);
    expect(isMeasuring(change, null)).toBe(true);
  });

  it('reads the trim and the payments rate', () => {
    expect(trimState(null, null)).toMatchObject({
      pipelineId: 'mrd_pay_sample',
      broken: false,
    });
    const d = demo({
      trim: {
        mrd_pay_sample: { functionIndex: 2, previous: {}, brokenAt: iso(T0) },
      },
      rates: {
        mrd_payments_api: { baselineEps: 100, multiplier: 5, setAt: iso(T0) },
      },
    });
    const flows = [
      flow({
        inputId: 'mrd_payments_api',
        routeId: 'mrd_payments_api',
        pipelineId: 'mrd_pay_sample',
        ratio: 0.5,
        savedPerDayM: 5_000_000,
      }),
    ];
    expect(trimState(d, snapshot({ flows }))).toMatchObject({
      broken: true,
      brokenAtMs: T0,
      ratio: 0.5,
    });
    expect(rateState(d)).toEqual({
      inputId: 'mrd_payments_api',
      multiplier: 5,
      setAtMs: T0,
    });
    expect(rateState(null).multiplier).toBe(1);
  });

  it('counts down to the next alert from the break plus the measured lag, until the alert opens', () => {
    const d = demo({
      measuredLagSec: 180,
      trim: {
        mrd_pay_sample: { functionIndex: 2, previous: {}, brokenAt: iso(T0) },
      },
    });
    expect(nextAlert(d, snapshot(), T0 + 80_000)).toEqual({
      inMs: 100_000,
      cause: 'trim',
      sinceMs: T0,
    });
    expect(nextAlert(d, snapshot(), T0 + 200_000)!.inMs).toBeLessThan(0);
    const opened = snapshot({
      incidents: [incident({ openedAt: iso(T0 + 150_000) })],
    });
    expect(nextAlert(d, opened, T0 + 160_000)).toBeUndefined();
    const spiked = demo({
      rates: {
        mrd_payments_api: { baselineEps: 100, multiplier: 5, setAt: iso(T0) },
      },
    });
    expect(nextAlert(spiked, snapshot(), T0 + 40_000)).toMatchObject({
      cause: 'rate',
      inMs: 200_000,
    });
    expect(nextAlert(demo({}), snapshot(), T0)).toBeUndefined();
  });

  it('focuses the most severe open incident, else a recovery from the last 10 minutes', () => {
    const snap = snapshot({
      incidents: [
        incident({ id: 'med', severity: 'medium', openedAt: iso(T0 + 2_000) }),
        incident({ id: 'high', severity: 'high', openedAt: iso(T0) }),
      ],
    });
    expect(focusIncident(snap, T0 + 5_000)).toMatchObject({
      incident: { id: 'high' },
      recovered: false,
    });
    const closed = snapshot({
      incidents: [incident({ id: 'c', closedAt: iso(T0) }), incident({ id: 'g', type: 'goodnews', closedAt: iso(T0 + 1) })],
    });
    expect(focusIncident(closed, T0 + 60_000)).toMatchObject({
      incident: { id: 'c' },
      recovered: true,
    });
    expect(focusIncident(closed, T0 + RECOVERED_SHOW_MS + 1)).toBeUndefined();
    expect(focusIncident(null, T0)).toBeUndefined();
  });

  it('shows a lever another device is running for up to 90 s, never over this tab’s own', () => {
    const d = demo({ inFlight: { lever: 'breakTrim', since: iso(T0) } });
    expect(remoteLever(d, T0 + 30_000, false)).toEqual({
      lever: 'breakTrim',
      sinceMs: T0,
    });
    expect(remoteLever(d, T0 + 30_000, true)).toBeUndefined();
    expect(remoteLever(d, T0 + 90_000, false)).toBeUndefined();
  });

  it('finds incidents about a rig Source by any of its object keys', () => {
    const snap = snapshot({
      incidents: [
        incident({
          objectKey: 'pipe:default:mrd_pay_sample',
          openedAt: iso(T0),
        }),
        incident({ objectKey: 'in:default:mrd_k8s_prod' }),
      ],
    });
    expect(incidentsFor(snap, 'regression', 'payments_api', T0 - 1).map((i) => i.objectKey)).toEqual(['pipe:default:mrd_pay_sample']);
    expect(incidentsFor(snap, 'regression', 'nope', 0)).toEqual([]);
  });
});

describe('a scene left behind (REVIEW-3a #8)', () => {
  it('is abandoned once it has not moved for 30 minutes, counting from its latest step', () => {
    const scene = { ...newScene('regression', T0), step: '1:wait', stepAt: iso(T0 + 2 * 60_000) };
    expect(SCENE_ABANDON_MS).toBe(30 * 60_000);
    expect(SCENE_ABANDON_MS).toBeGreaterThan(WAIT_MAX_MS * 4);
    expect(sceneLastMovedMs(scene)).toBe(T0 + 2 * 60_000);
    expect(isSceneAbandoned(scene, T0 + 31 * 60_000)).toBe(false); // started 31 min ago, moved 29 min ago
    expect(isSceneAbandoned(scene, T0 + 32 * 60_000)).toBe(true);
    // No stepAt: its start counts; unreadable timestamps count as abandoned (never resumed on a guess).
    const { stepAt: _drop, ...noStep } = newScene('savings', T0);
    void _drop;
    expect(isSceneAbandoned(noStep, T0 + 29 * 60_000)).toBe(false);
    expect(isSceneAbandoned({ startedAt: 'nope' }, T0)).toBe(true);
  });

  it('describes where it stopped: scene, step n of total, what Resume runs next', () => {
    const scene = { ...newScene('regression', T0), step: '3:lever', stepAt: iso(T0 + 3 * 60_000) };
    const left = leftScene(scene, T0 + 12 * 60_000)!;
    expect(left).toMatchObject({ name: 'regression', step: 4, total: 5, abandoned: false, startedMs: T0, movedMs: T0 + 3 * 60_000 });
    expect(left.next).toMatchObject({ kind: 'lever', call: { kind: 'restoreTrim', pipelineId: 'mrd_pay_sample' } });
    expect(leftScene(scene, T0 + 40 * 60_000)!.abandoned).toBe(true);
    expect(leftScene({ ...scene, name: 'savings:vpc_flow' }, T0)!.routeKey).toBe('vpc_flow');
    expect(leftScene({ ...scene, name: 'nonsense' }, T0)).toBeUndefined();
  });
});
