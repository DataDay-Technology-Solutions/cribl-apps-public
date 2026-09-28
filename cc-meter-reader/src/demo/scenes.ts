// src/demo/scenes.ts — the Demo Console's scenes (PRD 8.7, SPEC 11 `demoScene`) as a pure state machine.
//
// A scene is a script of steps. The runner (sceneRunner.ts) persists where it is in `demo/state.scene`
// (`step` = "<index>:<kind>", `stepAt` = when that step began) and advances it from the UI's own ticks:
// every snapshot the live poller lands, plus a coarse timer for the timed holds. Nothing here does I/O —
// `advanceScene()` reads the persisted scene, the latest snapshot and the clock, and says what to do next.
//
//   savings     apply the pack (Windows workstations by default) → wait for the ribbon to narrow → hold 60 s → revert
//   savingsX3   apply Windows, Palo Alto, VPC Flow 45 s apart → wait for all three to narrow → hold 60 s → revert all
//   regression  break the trim → wait for the alert → hold 60 s → restore → wait for the incident to close itself
//   spike       payments-api ×5 → wait for the cost-spike alert → calm
//   full        regression → 30 s → spike → 30 s → weekly receipt
//   budget      unsupported: core has no budget lever (only resetAll's budgetsOverride restore). The console
//               hides it; the name stays valid so a persisted `budget` scene still parses.
//
// Every scene starts behind the same confirmation as a lever (src/demo/confirm.ts, AGENTS.md "Confirming
// Destructive Operations"). A scene left in demo/state by a console that went away is never resumed on its
// own (REVIEW-3a #8): the console asks, and a scene that has not moved for SCENE_ABANDON_MS is "abandoned".
//
// Deviation (recorded in the report): SPEC 11 waits for "ratio ≥ 0.4" after a pack apply, but the rig measures
// the Windows XML pack at 0.34 and the Palo Alto pack at 0.37 (docs/RIG.md §5), so that wait would time out on
// every run. A flow counts as narrowed at ratio ≥ NARROW_RATIO (0.25) on a snapshot swept after the apply.

import type { DemoState, Incident, IncidentType, ObjectKey, Snapshot } from '../../core/types.ts';
import { objectKey } from '../../core/flows.ts';
import { PACK_ROUTE_KEYS, RIG_GROUP_ID, RIG_PIPELINES, rigObjectKeys, rigSource } from '../../core/demo/rig-ids.ts';

// ─── Timings (PRD 8.7, SPEC 11) ───────────────────────────────────────────────
export const WAIT_MAX_MS = 6 * 60_000;
export const HOLD_MS = 60_000;
export const X3_GAP_MS = 45_000;
export const FULL_PAUSE_MS = 30_000;
/** A pack-applied flow counts as "narrowed" at this savings ratio (see the header). */
export const NARROW_RATIO = 0.25;

/** The trim the Regression scene (and the B key) breaks: Payments API sampling (SPEC 14.2). */
export const TRIM_PIPELINE = RIG_PIPELINES.paySample;
/** The source the Spike scene (and S / C) throttles. */
export const SPIKE_INPUT = 'mrd_payments_api';
export const SPIKE_MULTIPLIER = 5;

export type PackRouteKey = (typeof PACK_ROUTE_KEYS)[number];
export type SceneName = 'savings' | 'savingsX3' | 'regression' | 'spike' | 'budget' | 'full';

/** A Cribl-config change a step makes through the lever client. */
export type LeverCall =
  | { kind: 'applyPack'; routeKey: PackRouteKey; level: 'pack' | 'aggressive' }
  | { kind: 'revertPack'; routeKey: PackRouteKey }
  | { kind: 'breakTrim'; pipelineId: string }
  | { kind: 'restoreTrim'; pipelineId: string }
  | { kind: 'setRate'; inputId: string; multiplier: number };

export type WaitFor =
  | { kind: 'narrow'; routeKeys: PackRouteKey[] }
  | { kind: 'alert'; type: IncidentType; sourceKey: string }
  | { kind: 'closed'; type: IncidentType; sourceKey: string };

export type SceneStep =
  | { kind: 'lever'; call: LeverCall; label: StepLabel }
  | { kind: 'wait'; until: WaitFor; maxMs: number; label: StepLabel }
  | { kind: 'hold'; ms: number; label: StepLabel }
  | { kind: 'receipt'; label: StepLabel };

/** Copy ids for each step's progress line (resolved to strings by the view: `demo.step.<label>`). */
export type StepLabel =
  | 'applying'
  | 'applied'
  | 'narrowing'
  | 'holding'
  | 'reverting'
  | 'breaking'
  | 'waitingAlert'
  | 'restoring'
  | 'waitingRecovery'
  | 'spiking'
  | 'waitingSpike'
  | 'calming'
  | 'pausing'
  | 'sendingReceipt';

export interface SceneDef {
  name: SceneName;
  /** false: the core has no lever for it, so the console does not show it (BEAUTY F15). */
  supported: boolean;
  /** Rough length, minutes, shown on the scene row. */
  approxMinutes: number;
  /** Starts with an alert the console should count down to (regression, spike, full). */
  expectsAlert: boolean;
}

export const SCENES: Readonly<Record<SceneName, SceneDef>> = {
  savings: {
    name: 'savings',
    supported: true,
    approxMinutes: 3,
    expectsAlert: false,
  },
  regression: {
    name: 'regression',
    supported: true,
    approxMinutes: 4,
    expectsAlert: true,
  },
  savingsX3: {
    name: 'savingsX3',
    supported: true,
    approxMinutes: 5,
    expectsAlert: false,
  },
  spike: {
    name: 'spike',
    supported: true,
    approxMinutes: 4,
    expectsAlert: true,
  },
  budget: {
    name: 'budget',
    supported: false,
    approxMinutes: 2,
    expectsAlert: true,
  },
  full: {
    name: 'full',
    supported: true,
    approxMinutes: 9,
    expectsAlert: true,
  },
};

/** Every scene name, in display order (persisted names are checked against this list). */
export const SCENE_ORDER: readonly SceneName[] = ['savings', 'regression', 'savingsX3', 'spike', 'budget', 'full'];

/** The scenes the console offers: unsupported ones are hidden, never shown disabled (BEAUTY F15). */
export const VISIBLE_SCENES: readonly SceneName[] = SCENE_ORDER.filter((name) => SCENES[name].supported);

const regressionSteps = (): SceneStep[] => [
  {
    kind: 'lever',
    call: { kind: 'breakTrim', pipelineId: TRIM_PIPELINE },
    label: 'breaking',
  },
  {
    kind: 'wait',
    until: { kind: 'alert', type: 'regression', sourceKey: 'payments_api' },
    maxMs: WAIT_MAX_MS,
    label: 'waitingAlert',
  },
  { kind: 'hold', ms: HOLD_MS, label: 'holding' },
  {
    kind: 'lever',
    call: { kind: 'restoreTrim', pipelineId: TRIM_PIPELINE },
    label: 'restoring',
  },
  {
    kind: 'wait',
    until: { kind: 'closed', type: 'regression', sourceKey: 'payments_api' },
    maxMs: WAIT_MAX_MS,
    label: 'waitingRecovery',
  },
];

const spikeSteps = (): SceneStep[] => [
  {
    kind: 'lever',
    call: {
      kind: 'setRate',
      inputId: SPIKE_INPUT,
      multiplier: SPIKE_MULTIPLIER,
    },
    label: 'spiking',
  },
  {
    kind: 'wait',
    until: { kind: 'alert', type: 'spike', sourceKey: 'payments_api' },
    maxMs: WAIT_MAX_MS,
    label: 'waitingSpike',
  },
  {
    kind: 'lever',
    call: { kind: 'setRate', inputId: SPIKE_INPUT, multiplier: 1 },
    label: 'calming',
  },
];

/** The script a scene runs. `routeKey` picks the Savings scene's stream (default Windows workstations). */
export function sceneScript(name: SceneName, routeKey: PackRouteKey = 'windows_workstations'): SceneStep[] {
  switch (name) {
    case 'savings':
      return [
        {
          kind: 'lever',
          call: { kind: 'applyPack', routeKey, level: 'pack' },
          label: 'applying',
        },
        {
          kind: 'wait',
          until: { kind: 'narrow', routeKeys: [routeKey] },
          maxMs: WAIT_MAX_MS,
          label: 'narrowing',
        },
        { kind: 'hold', ms: HOLD_MS, label: 'holding' },
        {
          kind: 'lever',
          call: { kind: 'revertPack', routeKey },
          label: 'reverting',
        },
      ];
    case 'savingsX3': {
      const [a, b, c] = PACK_ROUTE_KEYS;
      return [
        {
          kind: 'lever',
          call: { kind: 'applyPack', routeKey: a, level: 'pack' },
          label: 'applying',
        },
        { kind: 'hold', ms: X3_GAP_MS, label: 'applied' },
        {
          kind: 'lever',
          call: { kind: 'applyPack', routeKey: b, level: 'pack' },
          label: 'applying',
        },
        { kind: 'hold', ms: X3_GAP_MS, label: 'applied' },
        {
          kind: 'lever',
          call: { kind: 'applyPack', routeKey: c, level: 'pack' },
          label: 'applying',
        },
        {
          kind: 'wait',
          until: { kind: 'narrow', routeKeys: [a, b, c] },
          maxMs: WAIT_MAX_MS,
          label: 'narrowing',
        },
        { kind: 'hold', ms: HOLD_MS, label: 'holding' },
        {
          kind: 'lever',
          call: { kind: 'revertPack', routeKey: c },
          label: 'reverting',
        },
        {
          kind: 'lever',
          call: { kind: 'revertPack', routeKey: b },
          label: 'reverting',
        },
        {
          kind: 'lever',
          call: { kind: 'revertPack', routeKey: a },
          label: 'reverting',
        },
      ];
    }
    case 'regression':
      return regressionSteps();
    case 'spike':
      return spikeSteps();
    case 'full':
      return [
        ...regressionSteps(),
        { kind: 'hold', ms: FULL_PAUSE_MS, label: 'pausing' },
        ...spikeSteps(),
        { kind: 'hold', ms: FULL_PAUSE_MS, label: 'pausing' },
        { kind: 'receipt', label: 'sendingReceipt' },
      ];
    case 'budget':
      return [];
  }
}

// ─── Persisted form ──────────────────────────────────────────────────────────
export type PersistedScene = NonNullable<DemoState['scene']>;

/** `"<index>:<kind>"` — readable in KV, parseable back to an index. */
export function stepId(index: number, step: SceneStep | undefined): string {
  return `${index}:${step?.kind ?? 'done'}`;
}

export function stepIndex(scene: Pick<PersistedScene, 'step'>): number {
  const n = Number.parseInt(String(scene.step).split(':')[0] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function isSceneName(name: unknown): name is SceneName {
  return typeof name === 'string' && (SCENE_ORDER as readonly string[]).includes(name);
}

/** A fresh scene record, at its first step. */
export function newScene(name: SceneName, nowMs: number, routeKey?: PackRouteKey): PersistedScene {
  const script = sceneScript(name, routeKey);
  const at = new Date(nowMs).toISOString();
  return {
    name: routeKey && name === 'savings' ? `${name}:${routeKey}` : name,
    step: stepId(0, script[0]),
    startedAt: at,
    stepAt: at,
    stepsAt: [at],
    changed: { trims: [], rates: [], budgets: [], routes: [] },
  };
}

/** Splits `savings:pan_firewall` into the scene and its stream. */
export function parseSceneName(stored: string): { name: SceneName; routeKey?: PackRouteKey } | undefined {
  const [name, routeKey] = stored.split(':');
  if (!isSceneName(name)) return undefined;
  const key = (PACK_ROUTE_KEYS as readonly string[]).includes(routeKey ?? '') ? (routeKey as PackRouteKey) : undefined;
  return key ? { name, routeKey: key } : { name };
}

export function scriptFor(scene: Pick<PersistedScene, 'name'>): SceneStep[] {
  const parsed = parseSceneName(scene.name);
  return parsed ? sceneScript(parsed.name, parsed.routeKey) : [];
}

export function currentStep(scene: PersistedScene): SceneStep | undefined {
  return scriptFor(scene)[stepIndex(scene)];
}

/**
 * Moves to the next step (stamping `stepAt`, and the step's start in `stepsAt` for the run of show); `done`
 * when the script is finished.
 */
export function nextStep(scene: PersistedScene, nowMs: number): { scene: PersistedScene; done: boolean } {
  const script = scriptFor(scene);
  const index = stepIndex(scene) + 1;
  const at = new Date(nowMs).toISOString();
  // Index-aligned; a scene persisted before stepsAt existed has only what it recorded since ('' = unknown).
  const stepsAt = [...(scene.stepsAt ?? [])];
  if (stepsAt.length === 0 && scene.stepAt) stepsAt[index - 1] = scene.stepAt;
  for (let i = 0; i < index; i++) stepsAt[i] ??= '';
  stepsAt[index] = at;
  const next: PersistedScene = {
    ...scene,
    step: stepId(index, script[index]),
    stepAt: at,
    stepsAt: stepsAt.slice(0, index + 1),
  };
  return { scene: next, done: index >= script.length };
}

/** Records what a lever step changed, for Abort (SPEC 11: abort restores everything the scene changed). */
export function recordChange(scene: PersistedScene, call: LeverCall): PersistedScene {
  const changed = {
    trims: [...scene.changed.trims],
    rates: [...scene.changed.rates],
    budgets: [...scene.changed.budgets],
    routes: [...(scene.changed.routes ?? [])],
  };
  const add = (list: string[], id: string) => {
    if (!list.includes(id)) list.push(id);
  };
  const drop = (list: string[], id: string) => {
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
  };
  switch (call.kind) {
    case 'applyPack':
      add(changed.routes, call.routeKey);
      break;
    case 'revertPack':
      drop(changed.routes, call.routeKey);
      break;
    case 'breakTrim':
      add(changed.trims, call.pipelineId);
      break;
    case 'restoreTrim':
      drop(changed.trims, call.pipelineId);
      break;
    case 'setRate':
      if (call.multiplier === 1) drop(changed.rates, call.inputId);
      else add(changed.rates, call.inputId);
      break;
  }
  return { ...scene, changed };
}

// ─── Conditions over the snapshot ────────────────────────────────────────────
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (at: string | undefined): number => (at ? Date.parse(at) : Number.NaN);

/** Object keys an incident about this rig Source may carry (every route spelling, its input, its pipelines). */
export function sourceObjectKeys(sourceKey: string, groupId = RIG_GROUP_ID): Set<ObjectKey> {
  const src = rigSource(sourceKey);
  if (!src) return new Set();
  const keys = new Set<ObjectKey>(rigObjectKeys(src, groupId, [src.trimPipelineId, src.packPipelineId, src.aggressivePipelineId]));
  keys.add(objectKey('out', groupId, src.outputId));
  return keys;
}

/** Incidents of `type` about `sourceKey` opened at or after `sinceMs` (newest first). */
export function incidentsFor(snapshot: Snapshot | null, type: IncidentType, sourceKey: string, sinceMs: number): Incident[] {
  if (!snapshot) return [];
  const keys = sourceObjectKeys(sourceKey);
  return snapshot.incidents
    .filter((i) => i.type === type && keys.has(i.objectKey) && ms(i.openedAt) >= sinceMs)
    .sort((a, b) => ms(b.openedAt) - ms(a.openedAt));
}

/** The flow(s) of a rig route in the snapshot (either route-id spelling, or by input). */
function flowsOfRoute(snapshot: Snapshot, routeKey: PackRouteKey) {
  const src = rigSource(routeKey);
  if (!src) return [];
  return snapshot.flows.filter((f) => src.routeIds.includes(f.routeId) || f.inputId === src.inputId);
}

/** Whether a wait condition holds on this snapshot. `sinceMs`: when the wait began (the change was live). */
export function conditionMet(until: WaitFor, snapshot: Snapshot | null, sinceMs: number, sceneStartMs: number): boolean {
  if (!snapshot) return false;
  switch (until.kind) {
    case 'narrow': {
      // Only a sweep after the wait began can show the new pipeline's ratio.
      if (!(ms(snapshot.sweepAt) > sinceMs)) return false;
      return until.routeKeys.every((key) => {
        const flows = flowsOfRoute(snapshot, key);
        return flows.length > 0 && flows.some((f) => f.ratio >= NARROW_RATIO);
      });
    }
    case 'alert':
      return incidentsFor(snapshot, until.type, until.sourceKey, sceneStartMs).some((i) => !i.closedAt);
    case 'closed': {
      const mine = incidentsFor(snapshot, until.type, until.sourceKey, sceneStartMs);
      return mine.length > 0 && mine.every((i) => Boolean(i.closedAt));
    }
  }
}

// ─── The transition function ─────────────────────────────────────────────────
export type SceneAction =
  | { kind: 'lever'; call: LeverCall }
  | { kind: 'receipt' }
  /** Move on: a wait condition held, a wait timed out, or a hold elapsed. */
  | { kind: 'advance'; reason: 'met' | 'timeout' | 'elapsed' }
  | { kind: 'finish' }
  | { kind: 'idle' };

/**
 * What the runner should do now for this scene. Levers and the receipt are actions the runner executes
 * (then calls `nextStep`); waits and holds either stay idle or say `advance`.
 */
export function advanceScene(scene: PersistedScene, snapshot: Snapshot | null, nowMs: number): SceneAction {
  const script = scriptFor(scene);
  const index = stepIndex(scene);
  const step = script[index];
  if (!step) return { kind: 'finish' };
  const stepStart = Number.isFinite(ms(scene.stepAt)) ? ms(scene.stepAt) : ms(scene.startedAt);
  switch (step.kind) {
    case 'lever':
      return { kind: 'lever', call: step.call };
    case 'receipt':
      return { kind: 'receipt' };
    case 'hold':
      return nowMs - stepStart >= step.ms ? { kind: 'advance', reason: 'elapsed' } : { kind: 'idle' };
    case 'wait':
      if (conditionMet(step.until, snapshot, stepStart, ms(scene.startedAt))) return { kind: 'advance', reason: 'met' };
      return nowMs - stepStart >= step.maxMs ? { kind: 'advance', reason: 'timeout' } : { kind: 'idle' };
  }
}

// ─── Progress (the scene's one-line status) ──────────────────────────────────
export interface SceneProgress {
  name: SceneName;
  routeKey?: PackRouteKey;
  index: number;
  total: number;
  label: StepLabel | 'done';
  /** ms since the step began. */
  stepElapsedMs: number;
  /** ms until a hold ends or a wait times out (undefined for levers). */
  stepRemainingMs?: number;
  /** ms since the scene's last trim break (for "Broke the trim 0:42 ago"). */
  sinceBreakMs?: number;
  /** ms until the expected alert (negative = overdue). */
  alertInMs?: number;
}

/**
 * Where a scene is, for the console's progress line and the presenter's scene indicator:
 * "Broke the trim 0:42 ago · alert expected in ~1:30".
 */
export function sceneProgress(
  scene: PersistedScene,
  nowMs: number,
  opts: { brokenAtMs?: number; measuredLagSec: number },
): SceneProgress | undefined {
  const parsed = parseSceneName(scene.name);
  if (!parsed) return undefined;
  const script = sceneScript(parsed.name, parsed.routeKey);
  const index = stepIndex(scene);
  const step = script[index];
  const stepStart = Number.isFinite(ms(scene.stepAt)) ? ms(scene.stepAt) : ms(scene.startedAt);
  const out: SceneProgress = {
    name: parsed.name,
    index,
    total: script.length,
    label: step?.label ?? 'done',
    stepElapsedMs: Math.max(0, nowMs - stepStart),
  };
  if (parsed.routeKey) out.routeKey = parsed.routeKey;
  if (step?.kind === 'hold') out.stepRemainingMs = Math.max(0, step.ms - (nowMs - stepStart));
  if (step?.kind === 'wait') out.stepRemainingMs = Math.max(0, step.maxMs - (nowMs - stepStart));
  const expected = ms(scene.expectedAlertAt);
  if (Number.isFinite(expected)) out.alertInMs = expected - nowMs;
  else if (opts.brokenAtMs !== undefined) out.alertInMs = opts.brokenAtMs + opts.measuredLagSec * 1000 - nowMs;
  if (opts.brokenAtMs !== undefined) out.sinceBreakMs = Math.max(0, nowMs - opts.brokenAtMs);
  return out;
}

// ─── Run of show (the scene card's timed beats, EPIC_AUDIT P2-W18) ──────────
/**
 * A scene as a receipt of beats with their times from the start, "Break the trim ........ 0:00 · Alert lands
 * ........ ~2:07 · Restore the trim ........ ~3:07", and a caret on the one that happens next. A beat is a
 * lever or the receipt (it happens when its step starts) or a wait (it happens when the wait ends: the alert
 * lands, the ribbon narrows, the alert closes itself). Holds and pauses are the gaps between beats.
 *
 * Done beats carry the times the scene recorded (`stepsAt`), with no "~". The rest are planned from where the
 * scene is now: the alert the runner expects (`expectedAlertAt`, set from the break's deploy time), else the
 * measured lag; the recovery also by the measured lag; a narrowing ribbon by NARROW_EST_MS; holds by their
 * length. Planned times are estimates and say so.
 */
export type ShowLabel =
  | 'applyPack'
  | 'revertPack'
  | 'breakTrim'
  | 'restoreTrim'
  | 'spike'
  | 'calm'
  | 'narrowed'
  | 'narrowedAll'
  | 'alertLands'
  | 'spikeAlertLands'
  | 'closesItself'
  | 'receipt';

export interface ShowBeat {
  /** The step it belongs to. */
  index: number;
  label: ShowLabel;
  /** Apply / revert: the stream. */
  routeKey?: PackRouteKey;
  /** Spike / calm: the Source and the multiplier. */
  inputId?: string;
  multiplier?: number;
  /** done · now (the caret: what happens next, or is happening) · next. */
  state: 'done' | 'now' | 'next';
  /** ms from the scene's start; absent when a done beat's time was not recorded. */
  atMs?: number;
  /** A planned time (shown with "~"), not a recorded one. */
  estimated: boolean;
}

/**
 * How long after a pack goes live its ribbon narrows: the first whole minute metered after the change (up to
 * a minute to the boundary, the minute itself, the 20 s settle, D31) and the sweep that reads it. The console
 * tells the member the same ("The ribbon narrows in about 2 minutes").
 */
export const NARROW_EST_MS = 120_000;

function beatOf(step: SceneStep): Pick<ShowBeat, 'label' | 'routeKey' | 'inputId' | 'multiplier'> | undefined {
  switch (step.kind) {
    case 'lever': {
      const c = step.call;
      switch (c.kind) {
        case 'applyPack':
          return { label: 'applyPack', routeKey: c.routeKey };
        case 'revertPack':
          return { label: 'revertPack', routeKey: c.routeKey };
        case 'breakTrim':
          return { label: 'breakTrim' };
        case 'restoreTrim':
          return { label: 'restoreTrim' };
        case 'setRate':
          return c.multiplier > 1 ? { label: 'spike', inputId: c.inputId, multiplier: c.multiplier } : { label: 'calm', inputId: c.inputId, multiplier: c.multiplier };
      }
      return undefined;
    }
    case 'wait':
      switch (step.until.kind) {
        case 'narrow':
          return { label: step.until.routeKeys.length > 1 ? 'narrowedAll' : 'narrowed' };
        case 'alert':
          return { label: step.until.type === 'spike' ? 'spikeAlertLands' : 'alertLands' };
        case 'closed':
          return { label: 'closesItself' };
      }
      return undefined;
    case 'receipt':
      return { label: 'receipt' };
    case 'hold':
      return undefined;
  }
}

/** Alert-causing levers: the wait right after one can use the runner's `expectedAlertAt`. */
const causesAlert = (step: SceneStep | undefined): boolean =>
  step?.kind === 'lever' && (step.call.kind === 'breakTrim' || (step.call.kind === 'setRate' && step.call.multiplier > 1));

export function runOfShow(scene: PersistedScene, nowMs: number, opts: { measuredLagSec: number }): ShowBeat[] {
  const parsed = parseSceneName(scene.name);
  if (!parsed) return [];
  const script = sceneScript(parsed.name, parsed.routeKey);
  const cur = stepIndex(scene);
  const startMs = ms(scene.startedAt);
  if (!Number.isFinite(startMs)) return [];
  const lagMs = Math.max(0, opts.measuredLagSec) * 1000;
  /** A recorded step start (epoch ms), when there is one. */
  const recorded = (i: number): number => {
    const at = ms(scene.stepsAt?.[i] || undefined);
    if (Number.isFinite(at)) return at;
    if (i === cur) return Number.isFinite(ms(scene.stepAt)) ? ms(scene.stepAt) : Number.NaN;
    return i === 0 ? startMs : Number.NaN;
  };

  // Planned start and end of every step from the current one on (earlier ones use what was recorded).
  const plannedStart: number[] = [];
  const plannedEnd: number[] = [];
  let t = Number.isFinite(recorded(cur)) ? recorded(cur) : nowMs;
  for (let j = cur; j < script.length; j++) {
    const step = script[j]!;
    plannedStart[j] = t;
    const live = j === cur;
    let end = t;
    switch (step.kind) {
      case 'hold':
        end = t + step.ms;
        break;
      case 'wait': {
        let expected = t + (step.until.kind === 'narrow' ? NARROW_EST_MS : lagMs);
        // The runner's own expectation, once the lever that causes this alert has gone live (SPEC 11).
        const alertAt = ms(scene.expectedAlertAt);
        if (step.until.kind === 'alert' && causesAlert(script[j - 1]) && j - 1 < cur && Number.isFinite(alertAt) && alertAt >= recorded(j - 1) - 1_000) {
          expected = alertAt;
        }
        end = live ? Math.max(nowMs, expected) : expected;
        break;
      }
      default:
        end = live ? Math.max(nowMs, t) : t;
    }
    plannedEnd[j] = end;
    t = end;
  }

  const beats: ShowBeat[] = [];
  let caret = false;
  script.forEach((step, i) => {
    const beat = beatOf(step);
    if (!beat) return;
    const done = i < cur;
    let at: number;
    let estimated = false;
    if (done) {
      at = step.kind === 'wait' ? recorded(i + 1) : recorded(i);
    } else if (step.kind === 'wait') {
      at = plannedEnd[i]!;
      estimated = true;
    } else {
      // A lever that has started happened at its recorded start; one still to come is planned.
      at = i === cur && Number.isFinite(recorded(i)) ? recorded(i) : plannedStart[i]!;
      estimated = !(i === cur && Number.isFinite(recorded(i)));
    }
    const state: ShowBeat['state'] = done ? 'done' : caret ? 'next' : 'now';
    if (state === 'now') caret = true;
    const out: ShowBeat = { index: i, ...beat, state, estimated };
    if (Number.isFinite(at)) out.atMs = Math.max(0, at - startMs);
    beats.push(out);
  });
  return beats;
}

/** When the alert is expected after a change went live at `liveAtMs` (SPEC 11: the measured lag). */
export function expectedAlertAt(liveAtMs: number, measuredLagSec: number): string {
  return iso(liveAtMs + Math.max(0, measuredLagSec) * 1000);
}

// ─── A scene left behind (REVIEW-3a #8) ──────────────────────────────────────
/**
 * A persisted scene that has not moved for this long is "abandoned": the console offers to restore what it
 * changed or to dismiss it, never to resume it, and nothing is restored on its own. No step can hold a scene
 * still for more than WAIT_MAX_MS (6 min), so 30 minutes without a step means nobody is driving it.
 */
export const SCENE_ABANDON_MS = 30 * 60_000;

/** When the scene last moved: its current step's start, else when it started. */
export function sceneLastMovedMs(scene: Pick<PersistedScene, 'startedAt' | 'stepAt'>): number {
  const step = ms(scene.stepAt);
  const start = ms(scene.startedAt);
  if (Number.isFinite(step) && Number.isFinite(start)) return Math.max(step, start);
  return Number.isFinite(step) ? step : start;
}

/** True when the scene has not moved for SCENE_ABANDON_MS (or its timestamps are unreadable). */
export function isSceneAbandoned(scene: Pick<PersistedScene, 'startedAt' | 'stepAt'>, nowMs: number): boolean {
  const moved = sceneLastMovedMs(scene);
  return !Number.isFinite(moved) || nowMs - moved >= SCENE_ABANDON_MS;
}

/** What the console says about a scene no tab here is driving ("Regression, step 2 of 5, started 12 min ago"). */
export interface LeftScene {
  scene: PersistedScene;
  name: SceneName;
  routeKey?: PackRouteKey;
  /** 1-based step shown to people, capped at the step count. */
  step: number;
  total: number;
  /** The step it would run next on Resume. */
  next: SceneStep | undefined;
  startedMs: number;
  movedMs: number;
  abandoned: boolean;
}

export function leftScene(scene: PersistedScene, nowMs: number): LeftScene | undefined {
  const parsed = parseSceneName(scene.name);
  if (!parsed) return undefined;
  const script = sceneScript(parsed.name, parsed.routeKey);
  const index = stepIndex(scene);
  const out: LeftScene = {
    scene,
    name: parsed.name,
    step: Math.min(index + 1, Math.max(1, script.length)),
    total: script.length,
    next: script[index],
    startedMs: ms(scene.startedAt),
    movedMs: sceneLastMovedMs(scene),
    abandoned: isSceneAbandoned(scene, nowMs),
  };
  if (parsed.routeKey) out.routeKey = parsed.routeKey;
  return out;
}
