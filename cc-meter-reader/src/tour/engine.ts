// src/tour/engine.ts — plays a TourDoc script on a timer inside the UI (SPEC 15, PRD 8.5; Story mode
// reuses it, PRD 8.9).
//
// What it does:
//   start   moves the fixture onto the wall clock (rebase.ts), shows it through the store's sample path
//           (`actions.enterSample`, which stashes the live documents), then applies each script step
//           when its second comes: 'snapshot' replaces the snapshot; 'incident.open' / 'incident.close'
//           upsert an incident; 'delivery' records a webhook delivery (and the incident's delivery ref);
//           'commit' adds a commit to the change timeline; 'caption' only notifies listeners.
//   pause / resume / seek / loop    for the tour controls and Story mode.
//   stop    clears the sample (`actions.clearSample`, which restores the stashed live documents).
//
// What it never does: call Cribl, write KV, or touch the store once the screen no longer shows ITS data.
// While the store's `source` is not 'live' the 'ui' runtime's meter loop does not sweep (meterLoop.ts
// `shouldMeter`), live polling reads nothing (live.ts) and every save is refused (services.ts
// `guardWrite`) — the tour needs no flag of its own for that. If anything else flips `source` back
// (the SAMPLE DATA band's "Clear sample data" calls `clearSample` directly), the engine notices on its
// store subscription and stops itself with reason 'cleared'.

import type { Commit, DeliveryLog, DeliveryRef, FlowFigures, Incident, Meta, Settings, Snapshot, TourStep, WeeklyReceipt } from '../../core/types.ts';
import { flowObjectKeys } from '../../core/flows.ts';
import { previousWeek } from '../../core/receipt.ts';
import { fromIso, weekRangeLabel } from '../../core/time.ts';
import { summarizeInventory } from '../state/hydrate.ts';
import type { Timers } from '../state/ports.ts';
import { browserTimers } from '../state/ports.ts';
import type { AppActions } from '../state/services.ts';
import type { AppState, AppStore } from '../state/store.ts';
import { planRebase, rebaseHeadline, rebaseValue, type RebasePlan } from './rebase.ts';
import type { TourEvent, TourFixture, TourPhase, TourStatus, TourStopReason } from './types.ts';

const MAX_INCIDENTS = 50;
const MAX_DELIVERIES = 20;
const MAX_TIMELINE = 30;

// ─── Pure snapshot patches (exported for tests and Story mode) ───────────────

const newestFirst = <T>(time: (x: T) => string) => (a: T, b: T): number => fromIso(time(b)) - fromIso(time(a));

function sameDelivery(a: Pick<DeliveryLog, 'endpointId' | 'at' | 'event' | 'incidentId'>, b: Pick<DeliveryLog, 'endpointId' | 'at' | 'event' | 'incidentId'>): boolean {
  return a.endpointId === b.endpointId && a.at === b.at && a.event === b.event && a.incidentId === b.incidentId;
}

function mergeRefs(a: DeliveryRef[] | undefined, b: DeliveryRef[] | undefined): DeliveryRef[] {
  const out = [...(a ?? [])];
  for (const r of b ?? []) if (!out.some((x) => x.endpointId === r.endpointId && x.at === r.at)) out.push(r);
  return out.sort((x, y) => fromIso(x.at) - fromIso(y.at));
}

/** Flow states follow open incidents exactly as core/snapshot.ts derives them. */
export function markFlowStates(flows: FlowFigures[], incidents: Incident[]): FlowFigures[] {
  const open = new Set(incidents.filter((i) => !i.closedAt).map((i) => `${i.type}|${i.objectKey}`));
  return flows.map((f) => {
    if (f.muted) return f;
    const keys = flowObjectKeys(f);
    let state = f.state;
    if ([keys.route, keys.pipeline].some((k) => k !== undefined && open.has(`regression|${k}`))) state = 'regression';
    else if (keys.input !== undefined && open.has(`spike|${keys.input}`)) state = 'spike';
    else if (state === 'regression' || state === 'spike') state = 'ok';
    return state === f.state ? f : { ...f, state };
  });
}

/** Adds or replaces an incident (by id), keeping delivery refs already recorded. */
export function withIncident(snapshot: Snapshot, incident: Incident): Snapshot {
  const existing = snapshot.incidents.find((i) => i.id === incident.id);
  const deliveries = mergeRefs(existing?.deliveries, incident.deliveries);
  const next: Incident = { ...incident, deliveries };
  if (deliveries.length > 0) next.lastNotifiedAt = deliveries[deliveries.length - 1].at;
  const incidents = [next, ...snapshot.incidents.filter((i) => i.id !== incident.id)]
    .sort((a, b) => fromIso(b.openedAt) - fromIso(a.openedAt) || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_INCIDENTS);
  return {
    ...snapshot,
    incidents,
    openIncidents: incidents.filter((i) => !i.closedAt).length,
    flows: markFlowStates(snapshot.flows, incidents),
  };
}

/** Records a webhook delivery in the snapshot's log and on its incident. Idempotent. */
export function withDelivery(snapshot: Snapshot, log: DeliveryLog): Snapshot {
  const logged = snapshot.deliveries.some((d) => sameDelivery(d, log));
  const deliveries = logged ? snapshot.deliveries : [log, ...snapshot.deliveries].sort(newestFirst((d: DeliveryLog) => d.at)).slice(0, MAX_DELIVERIES);
  let incidents = snapshot.incidents;
  const target = log.incidentId ? snapshot.incidents.find((i) => i.id === log.incidentId) : undefined;
  if (target) {
    const ref: DeliveryRef = { endpointId: log.endpointId, status: log.status, at: log.at };
    if (log.error) ref.error = log.error;
    const refs = mergeRefs(target.deliveries, [ref]);
    if (refs.length !== target.deliveries.length) {
      const updated: Incident = { ...target, deliveries: refs, lastNotifiedAt: refs[refs.length - 1].at };
      incidents = snapshot.incidents.map((i) => (i === target ? updated : i));
    }
  }
  if (logged && incidents === snapshot.incidents) return snapshot;
  return { ...snapshot, deliveries, incidents };
}

/** Adds a commit to the change timeline (newest first). Idempotent by hash. */
export function withCommit(snapshot: Snapshot, commit: Commit): Snapshot {
  if (snapshot.timeline.some((c) => c.hash === commit.hash)) return snapshot;
  const timeline = [commit, ...snapshot.timeline].sort(newestFirst((c: Commit) => c.committedAt)).slice(0, MAX_TIMELINE);
  return { ...snapshot, timeline };
}

/** The footer / freshness document after a scripted sweep. */
export function metaForSnapshot(meta: Meta | null, snapshot: Snapshot): Meta | null {
  if (!meta) return meta;
  return { ...meta, lastSweepAt: snapshot.sweepAt, meteredThrough: snapshot.windowEnd, lastSweepCalls: snapshot.calls };
}

/** Applies one step's (already rebased) payload to the snapshot. Unknown actions change nothing. */
export function applyStepToSnapshot(snapshot: Snapshot, step: Pick<TourStep, 'action'>, payload: unknown): Snapshot {
  switch (step.action) {
    case 'snapshot':
      return payload as Snapshot;
    case 'incident.open':
    case 'incident.close':
      return withIncident(snapshot, payload as Incident);
    case 'delivery':
      return withDelivery(snapshot, payload as DeliveryLog);
    case 'commit':
      return withCommit(snapshot, payload as Commit);
    default:
      return snapshot;
  }
}

/**
 * The fixture's weekly receipt as it would read at `nowMs`: the same amounts, labelled with the
 * previous complete local week (the week a Monday send would cover), so the preview never names a
 * week from the day the fixture was generated.
 */
export function weeklyReceiptAt(receipt: WeeklyReceipt | undefined, nowMs: number, tz: string): WeeklyReceipt | undefined {
  if (!receipt) return undefined;
  try {
    const week = previousWeek(nowMs, tz);
    return {
      ...receipt,
      periodStart: new Date(week.startMs).toISOString(),
      periodEnd: new Date(week.endMs).toISOString(),
      label: weekRangeLabel(week.startMs, week.endMs, tz),
    };
  } catch {
    return receipt;
  }
}

// ─── The engine ──────────────────────────────────────────────────────────────

export interface TourEngineOptions {
  store: AppStore;
  actions: Pick<AppActions, 'enterSample' | 'clearSample'>;
  doc: TourFixture;
  /** Which non-live source the fixture is shown as (default 'sample': the SAMPLE DATA band). */
  source?: 'sample' | 'replay';
  /** Restart from the top after `durationSec` (Story mode). Default false: hold the last state. */
  loop?: boolean;
  /** Script seconds per wall second (default 1). */
  speed?: number;
  /** Move timestamps onto the wall clock (default true). */
  rebase?: boolean;
  /**
   * Recompute month to date (and its net) from the moved trend when the days move (default true). Story mode
   * passes false: its captions quote the recording's month to date, so the screen keeps the recording's money.
   */
  rebaseMoney?: boolean;
  /** Zone the sample's times display in (default: the member's current display timezone). */
  displayTimezone?: string;
  timers?: Timers;
  now?: () => number;
  onEvent?: (event: TourEvent) => void;
  onStop?: (reason: TourStopReason) => void;
}

export interface TourEngine {
  /** Shows the fixture and starts the script. A second call while active does nothing. */
  start(): void;
  /** Stops the script. Clears the sample (restoring live data) unless it was already cleared. */
  stop(reason?: TourStopReason): void;
  pause(): void;
  resume(): void;
  /** Jumps to a script second: rebuilds the state up to it silently, then carries on. */
  seek(sec: number): void;
  status(): TourStatus;
  subscribe(listener: (status: TourStatus) => void): () => void;
  /** The fixture as currently shown (rebased), or null when not active. */
  current(): TourFixture | null;
  /** The weekly receipt preview for this play (rebased amounts, current week label). */
  weeklyReceipt(): WeeklyReceipt | undefined;
  /** True from start until stop (running, paused or finished). */
  isActive(): boolean;
}

export function createTourEngine(opts: TourEngineOptions): TourEngine {
  const { store, actions, doc } = opts;
  const source = opts.source ?? 'sample';
  const loop = opts.loop === true;
  const speed = opts.speed !== undefined && opts.speed > 0 ? opts.speed : 1;
  const timers = opts.timers ?? browserTimers;
  const now = opts.now ?? Date.now;
  const anchorMs = fromIso(doc.anchor ?? doc.generatedAt);
  const durationSec = Math.max(doc.durationSec ?? 0, ...doc.script.map((s) => s.at));
  // Stable order: by second, then as written (a step's snapshot lands before the event it carries).
  const script = doc.script.map((s, i) => ({ s, i })).sort((a, b) => a.s.at - b.s.at || a.i - b.i).map((x) => x.s);

  let phase: TourPhase = 'idle';
  let iteration = 0;
  let nextIndex = 0;
  let offsetSec = 0;
  let runStartWall = 0;
  let handle: unknown;
  let unsubscribe: (() => void) | null = null;
  let shown: TourFixture | null = null;
  let steps: TourStep[] = [];
  let plan: RebasePlan = { deltaMs: 0, dayShift: 0 };
  let tz = 'UTC';
  let sampleInventory: AppState['inventory'] = null;
  let liveInventory: AppState['inventory'] = null;
  const listeners = new Set<(s: TourStatus) => void>();

  const active = (): boolean => phase === 'running' || phase === 'paused' || phase === 'finished';
  const elapsed = (): number => (phase === 'running' ? offsetSec + ((now() - runStartWall) / 1000) * speed : offsetSec);
  const ownsScreen = (): boolean => store.getState().source === source;

  const status = (): TourStatus => ({
    phase,
    elapsedSec: Math.min(durationSec, Math.max(0, elapsed())),
    durationSec,
    loop,
    iteration,
    nextStep: nextIndex,
  });
  const notify = (): void => {
    const s = status();
    for (const l of [...listeners]) l(s);
  };

  const clearTimer = (): void => {
    if (handle !== undefined) timers.clearTimeout(handle);
    handle = undefined;
  };

  const viewerTimezone = (): string => {
    if (opts.displayTimezone) return opts.displayTimezone;
    const s = store.getState();
    const live = s.source === 'live' ? s.settings : (s.liveStash?.settings ?? s.settings);
    return live.displayTimezone || doc.timezone || 'UTC';
  };

  /** Rebases the fixture so script second `atSec` reads as the wall clock now, and shows its base state. */
  const enterBase = (atSec: number): void => {
    const dayZone = doc.timezone || tz;
    plan = opts.rebase === false ? { deltaMs: 0, dayShift: 0 } : planRebase(anchorMs + atSec * 1000, now(), dayZone);
    const { script: _script, ...rest } = doc;
    // Moving the days can move the first of the month: month to date (and its net) follows the moved trend.
    const cost = doc.settings.criblCostCentsPerMonth;
    const headlineFor = (snapshot: Snapshot): Snapshot => (plan.dayShift === 0 || opts.rebaseMoney === false ? snapshot : rebaseHeadline(snapshot, dayZone, cost));
    steps = script.map((s) => {
      const payload = rebaseValue(s.payload, plan);
      return { ...s, payload: s.action === 'snapshot' && payload ? headlineFor(payload as Snapshot) : payload };
    });
    const moved = rebaseValue(rest, plan);
    shown = { ...moved, snapshot: headlineFor(moved.snapshot), script: steps };
    const settings: Settings = { ...shown.settings, displayTimezone: tz };
    actions.enterSample({ source, snapshot: shown.snapshot, settings, prices: shown.prices, meta: shown.meta });
    sampleInventory = shown.inventory ? summarizeInventory(shown.inventory, settings) : null;
    if (sampleInventory) store.setState({ inventory: sampleInventory });
    nextIndex = 0;
  };

  const applyStep = (index: number, silent: boolean): void => {
    const step = steps[index];
    if (!step || !ownsScreen()) return;
    const state = store.getState();
    if (state.snapshot) {
      const snapshot = applyStepToSnapshot(state.snapshot, step, step.payload);
      if (snapshot !== state.snapshot) {
        store.setState(step.action === 'snapshot' ? { snapshot, meta: metaForSnapshot(state.meta, snapshot) } : { snapshot });
      }
    }
    opts.onEvent?.({ step, payload: step.payload, silent, iteration });
  };

  const restoreInventory = (): void => {
    const s = store.getState();
    if (s.source !== source && sampleInventory && s.inventory === sampleInventory) store.setState({ inventory: liveInventory });
    sampleInventory = null;
  };

  const halt = (reason: TourStopReason): void => {
    clearTimer();
    unsubscribe?.();
    unsubscribe = null;
    phase = 'stopped';
    restoreInventory();
    shown = null;
    notify();
    opts.onStop?.(reason);
  };

  const finish = (): void => {
    if (!active()) return;
    if (loop) {
      iteration += 1;
      offsetSec = 0;
      runStartWall = now();
      enterBase(0);
      notify();
      tick();
      return;
    }
    clearTimer();
    offsetSec = durationSec;
    phase = 'finished';
    notify();
  };

  function tick(): void {
    clearTimer();
    if (phase !== 'running') return;
    if (!ownsScreen()) {
      halt('cleared');
      return;
    }
    const t = elapsed();
    let applied = false;
    while (nextIndex < steps.length && steps[nextIndex].at <= t + 1e-6) {
      applyStep(nextIndex, false);
      nextIndex += 1;
      applied = true;
      if (phase !== 'running') return; // a listener stopped the tour
    }
    if (applied) notify();
    const target = nextIndex < steps.length ? steps[nextIndex].at : durationSec;
    if (nextIndex >= steps.length && t >= durationSec) {
      finish();
      return;
    }
    handle = timers.setTimeout(tick, Math.max(0, ((target - t) / speed) * 1000));
  }

  const watchStore = (): void => {
    unsubscribe?.();
    unsubscribe = store.subscribe(() => {
      if (active() && !ownsScreen()) halt('cleared');
    });
  };

  return {
    start() {
      if (active()) return;
      tz = viewerTimezone();
      liveInventory = store.getState().inventory;
      iteration = 0;
      offsetSec = 0;
      enterBase(0);
      phase = 'running';
      runStartWall = now();
      watchStore();
      notify();
      tick();
    },

    stop(reason = 'user') {
      if (!active()) return;
      clearTimer();
      unsubscribe?.();
      unsubscribe = null;
      const owned = ownsScreen();
      phase = 'stopped';
      if (owned) actions.clearSample();
      restoreInventory();
      shown = null;
      notify();
      opts.onStop?.(reason);
    },

    pause() {
      if (phase !== 'running') return;
      offsetSec = elapsed();
      phase = 'paused';
      clearTimer();
      notify();
    },

    resume() {
      if (phase !== 'paused') return;
      runStartWall = now();
      phase = 'running';
      notify();
      tick();
    },

    seek(sec) {
      if (!active()) return;
      const target = Math.min(durationSec, Math.max(0, Number.isFinite(sec) ? sec : 0));
      clearTimer();
      enterBase(target);
      while (nextIndex < steps.length && steps[nextIndex].at <= target) {
        applyStep(nextIndex, true);
        nextIndex += 1;
      }
      offsetSec = target;
      runStartWall = now();
      if (phase === 'finished') phase = 'running';
      notify();
      if (phase === 'running') tick();
    },

    status,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    current: () => (active() ? shown : null),

    weeklyReceipt() {
      if (!shown) return undefined;
      return weeklyReceiptAt(shown.weeklyReceipt, now(), tz);
    },

    isActive: active,
  };
}
