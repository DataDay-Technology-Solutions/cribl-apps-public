// tests/unit/demo-run-of-show.test.ts — the scene card's run of show (EPIC_AUDIT P2-W18, day-2 slice): each
// scene as timed beats with a caret, recorded times for what happened, "~" estimates for what is still to come.

import { describe, expect, it } from 'vitest';
import { NARROW_EST_MS, X3_GAP_MS, HOLD_MS, newScene, nextStep, runOfShow, type PersistedScene } from '../../src/demo/scenes.ts';

const T0 = Date.UTC(2026, 8, 28, 15, 0, 0);
const S = 1_000;
const LAG = { measuredLagSec: 127 };

const view = (scene: PersistedScene, nowMs: number) =>
  runOfShow(scene, nowMs, LAG).map((b) => ({ label: b.label, state: b.state, at: b.atMs === undefined ? undefined : b.atMs / 1000, est: b.estimated }));

describe('runOfShow', () => {
  it('a fresh Regression: the break now at 0:00, then the alert, the restore and the recovery planned from the measured lag', () => {
    const scene = newScene('regression', T0);
    expect(scene.stepsAt).toEqual([new Date(T0).toISOString()]);
    expect(view(scene, T0)).toEqual([
      { label: 'breakTrim', state: 'now', at: 0, est: false },
      { label: 'alertLands', state: 'next', at: 127, est: true },
      { label: 'restoreTrim', state: 'next', at: 187, est: true },
      { label: 'closesItself', state: 'next', at: 314, est: true },
    ]);
  });

  it('after the break deployed: the alert is planned at the runner’s expectedAlertAt (deploy + lag)', () => {
    let scene = newScene('regression', T0);
    scene = { ...scene, expectedAlertAt: new Date(T0 + 9 * S + 127 * S).toISOString() };
    scene = nextStep(scene, T0 + 9 * S).scene; // → 1: waiting for the alert
    expect(scene.stepsAt).toHaveLength(2);
    expect(view(scene, T0 + 30 * S)).toEqual([
      { label: 'breakTrim', state: 'done', at: 0, est: false },
      { label: 'alertLands', state: 'now', at: 136, est: true },
      { label: 'restoreTrim', state: 'next', at: 196, est: true },
      { label: 'closesItself', state: 'next', at: 323, est: true },
    ]);
    // Overdue: the alert is "due now", never planned in the past.
    expect(view(scene, T0 + 200 * S)[1]).toEqual({ label: 'alertLands', state: 'now', at: 200, est: true });
  });

  it('once the alert landed its recorded time replaces the estimate; during the hold the caret sits on the restore', () => {
    let scene = newScene('regression', T0);
    scene = nextStep(scene, T0 + 9 * S).scene; // waiting for the alert
    scene = nextStep(scene, T0 + 141 * S).scene; // the alert landed → holding 60 s
    expect(view(scene, T0 + 150 * S)).toEqual([
      { label: 'breakTrim', state: 'done', at: 0, est: false },
      { label: 'alertLands', state: 'done', at: 141, est: false },
      { label: 'restoreTrim', state: 'now', at: 201, est: true },
      { label: 'closesItself', state: 'next', at: 328, est: true },
    ]);
    scene = nextStep(scene, T0 + 201 * S).scene; // restoring
    // While the restore runs, what follows is planned from now (the lever has not returned yet).
    const restoring = view(scene, T0 + 203 * S);
    expect(restoring[2]).toEqual({ label: 'restoreTrim', state: 'now', at: 201, est: false });
    expect(restoring[3]).toEqual({ label: 'closesItself', state: 'next', at: 330, est: true });
  });

  it('Savings ×3: three applies 45 s apart, one narrowing beat for all three, then three reverts', () => {
    const scene = newScene('savingsX3', T0);
    const beats = runOfShow(scene, T0, LAG);
    expect(beats.map((b) => [b.label, b.routeKey])).toEqual([
      ['applyPack', 'windows_workstations'],
      ['applyPack', 'pan_firewall'],
      ['applyPack', 'vpc_flow'],
      ['narrowedAll', undefined],
      ['revertPack', 'vpc_flow'],
      ['revertPack', 'pan_firewall'],
      ['revertPack', 'windows_workstations'],
    ]);
    const narrowAt = 2 * X3_GAP_MS + NARROW_EST_MS;
    expect(beats.map((b) => b.atMs)).toEqual([0, X3_GAP_MS, 2 * X3_GAP_MS, narrowAt, narrowAt + HOLD_MS, narrowAt + HOLD_MS, narrowAt + HOLD_MS]);
  });

  it('Savings on another stream names it; the Spike scene carries its Source and multiplier', () => {
    expect(runOfShow(newScene('savings', T0, 'pan_firewall'), T0, LAG).map((b) => [b.label, b.routeKey])).toEqual([
      ['applyPack', 'pan_firewall'],
      ['narrowed', undefined],
      ['revertPack', 'pan_firewall'],
    ]);
    expect(runOfShow(newScene('spike', T0), T0, LAG).map((b) => [b.label, b.inputId, b.multiplier])).toEqual([
      ['spike', 'mrd_payments_api', 5],
      ['spikeAlertLands', undefined, undefined],
      ['calm', 'mrd_payments_api', 1],
    ]);
  });

  it('the Full show uses expectedAlertAt only for the alert its own lever caused', () => {
    let scene = newScene('full', T0);
    // The regression's break set expectedAlertAt long ago; the spike lever has not run yet.
    scene = { ...scene, expectedAlertAt: new Date(T0 + 130 * S).toISOString() };
    const beats = runOfShow(scene, T0, LAG);
    const spikeAlert = beats.find((b) => b.label === 'spikeAlertLands')!;
    const spike = beats.find((b) => b.label === 'spike')!;
    expect(spikeAlert.atMs! - spike.atMs!).toBe(127 * S);
    expect(beats.at(-1)).toMatchObject({ label: 'receipt', estimated: true });
  });

  it('a scene persisted before step times were kept: done beats have no time, the rest are still planned', () => {
    const scene: PersistedScene = {
      name: 'regression',
      step: '2:hold',
      startedAt: new Date(T0).toISOString(),
      stepAt: new Date(T0 + 141 * S).toISOString(),
      changed: { trims: ['mrd_pay_sample'], rates: [], budgets: [], routes: [] },
    };
    expect(view(scene, T0 + 150 * S)).toEqual([
      { label: 'breakTrim', state: 'done', at: 0, est: false },
      { label: 'alertLands', state: 'done', at: 141, est: false },
      { label: 'restoreTrim', state: 'now', at: 201, est: true },
      { label: 'closesItself', state: 'next', at: 328, est: true },
    ]);
    // One step later the alert's landing (the hold's start) was never recorded: done, without a time.
    const older = { ...scene, step: '3:lever', stepAt: new Date(T0 + 201 * S).toISOString() };
    expect(view(older, T0 + 205 * S).slice(1, 3)).toEqual([
      { label: 'alertLands', state: 'done', at: undefined, est: false },
      { label: 'restoreTrim', state: 'now', at: 201, est: false },
    ]);
  });

  it('nextStep keeps stepsAt index-aligned, filling what an older scene never recorded', () => {
    const scene: PersistedScene = {
      name: 'regression',
      step: '1:wait',
      startedAt: new Date(T0).toISOString(),
      stepAt: new Date(T0 + 9 * S).toISOString(),
      changed: { trims: [], rates: [], budgets: [], routes: [] },
    };
    const next = nextStep(scene, T0 + 140 * S).scene;
    expect(next.stepsAt).toEqual(['', new Date(T0 + 9 * S).toISOString(), new Date(T0 + 140 * S).toISOString()]);
  });

  it('an unknown scene name has no run of show', () => {
    expect(runOfShow({ ...newScene('regression', T0), name: 'nope' }, T0, LAG)).toEqual([]);
  });
});
