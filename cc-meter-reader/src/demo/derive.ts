// src/demo/derive.ts — what the Demo Console shows, derived from demo/state + the snapshot. Pure; no I/O.
// DEMO BUILD ONLY.

import type { DemoState, FlowFigures, HeadlinePeriod, Incident, Snapshot } from '../../core/types.ts';
import { DEFAULT_MEASURED_LAG_SEC, IN_FLIGHT_TTL_MS } from '../../core/demo/levers.ts';
import { PACK_ROUTE_KEYS, rigSource, rigSourcesUsingPipeline } from '../../core/demo/rig-ids.ts';
import { severityRank } from '../../core/incidents.ts';
import { SPIKE_INPUT, TRIM_PIPELINE, incidentsFor, type PackRouteKey } from './scenes.ts';
import { periodFigure } from '../views/Presenter/heroValue.ts';
import { targetAt } from '../components/Meter/meterMath.ts';
import { TAKEOVER_MS } from '../components/IncidentTakeover/tracker.ts';

const ms = (at: string | undefined): number => (at ? Date.parse(at) : Number.NaN);

export type StreamLevel = 'raw' | 'pack' | 'aggressive';

export interface StreamState {
  key: PackRouteKey;
  inputId: string;
  level: StreamLevel;
  /** When the pack went live (demo/state.routes[…].appliedAt). */
  appliedAtMs?: number;
  /** The snapshot has not metered a whole minute since the change: its ratio is the old pipeline's. */
  measuring?: boolean;
  /** The flow's last-minute savings ratio, when the snapshot has it. */
  ratio?: number;
  savedPerDayM?: number;
  paidPerDayM?: number;
}

/** The rig flow a stream's route feeds (either route-id spelling, or by input). */
export function flowForSource(snapshot: Snapshot | null, sourceKey: string): FlowFigures | undefined {
  const src = rigSource(sourceKey);
  if (!snapshot || !src) return undefined;
  const flows = snapshot.flows.filter((f) => src.routeIds.includes(f.routeId) || f.inputId === src.inputId);
  // One route → one destination in the rig; prefer the route-attributed row when there are several.
  return flows.find((f) => src.routeIds.includes(f.routeId)) ?? flows[0];
}

/** Apply-the-pack state per raw stream (keys 1 / 2 / 3), from demo/state.routes. */
export function streamStates(demo: DemoState | null, snapshot: Snapshot | null): StreamState[] {
  return PACK_ROUTE_KEYS.map((key) => {
    const src = rigSource(key)!;
    const entry = Object.entries(demo?.routes ?? {}).find(([routeId]) => rigSource(routeId)?.key === key)?.[1];
    const level: StreamLevel = entry ? (entry.level === 'aggressive' ? 'aggressive' : 'pack') : 'raw';
    const flow = flowForSource(snapshot, key);
    const out: StreamState = { key, inputId: src.inputId, level };
    const appliedAt = ms(entry?.appliedAt);
    if (entry && Number.isFinite(appliedAt)) {
      out.appliedAtMs = appliedAt;
      out.measuring = isMeasuring(appliedAt, snapshot);
    }
    if (flow) {
      out.ratio = flow.ratio;
      out.savedPerDayM = flow.savedPerDayM;
      out.paidPerDayM = flow.paidPerDayM;
    }
    return out;
  });
}

/**
 * A change deployed at `changeAtMs` takes effect from the next minute boundary; until the snapshot has
 * metered that whole minute, the flow's ratio still describes the old pipeline.
 */
export function isMeasuring(changeAtMs: number, snapshot: Snapshot | null): boolean {
  if (!snapshot) return true;
  const firstFullMinuteEnd = Math.ceil(changeAtMs / 60_000) * 60_000 + 60_000;
  const meteredThrough = ms(snapshot.windowEnd);
  return !(meteredThrough >= firstFullMinuteEnd);
}

export interface TrimState {
  pipelineId: string;
  broken: boolean;
  brokenAtMs?: number;
  measuring?: boolean;
  ratio?: number;
  savedPerDayM?: number;
}

/** Break-the-trim state for Payments API sampling. */
export function trimState(demo: DemoState | null, snapshot: Snapshot | null, pipelineId = TRIM_PIPELINE): TrimState {
  const entry = demo?.trim?.[pipelineId];
  const out: TrimState = { pipelineId, broken: Boolean(entry) };
  const at = ms(entry?.brokenAt);
  if (Number.isFinite(at)) {
    out.brokenAtMs = at;
    out.measuring = isMeasuring(at, snapshot);
  }
  const src = rigSourcesUsingPipeline(pipelineId).find((s) => s.trimPipelineId === pipelineId);
  const flow = flowForSource(snapshot, src?.key ?? 'payments_api');
  if (flow) {
    out.ratio = flow.ratio;
    out.savedPerDayM = flow.savedPerDayM;
  }
  return out;
}

export interface RateState {
  inputId: string;
  multiplier: number;
  setAtMs?: number;
}

export function rateState(demo: DemoState | null, inputId = SPIKE_INPUT): RateState {
  const entry = demo?.rates?.[inputId];
  const out: RateState = { inputId, multiplier: entry?.multiplier ?? 1 };
  const at = ms(entry?.setAt);
  if (Number.isFinite(at)) out.setAtMs = at;
  return out;
}

export interface NextAlert {
  /** ms until the alert is expected (≤ 0: due now). */
  inMs: number;
  cause: 'trim' | 'rate';
  /** When the change went live. */
  sinceMs: number;
}

/**
 * "Next alert expected in ~1:40": a broken trim (or a spiked rate) with no alert for it yet, counted from
 * the lever's deploy time plus the measured lag (demo/state.measuredLagSec, 240 s until measured).
 */
export function nextAlert(demo: DemoState | null, snapshot: Snapshot | null, nowMs: number): NextAlert | undefined {
  const lagMs = (demo?.measuredLagSec ?? DEFAULT_MEASURED_LAG_SEC) * 1000;
  const trim = trimState(demo, snapshot);
  if (trim.broken && trim.brokenAtMs !== undefined) {
    const opened = incidentsFor(snapshot, 'regression', 'payments_api', trim.brokenAtMs - 60_000).some((i) => !i.closedAt);
    if (!opened)
      return {
        inMs: trim.brokenAtMs + lagMs - nowMs,
        cause: 'trim',
        sinceMs: trim.brokenAtMs,
      };
  }
  const rate = rateState(demo);
  if (rate.multiplier > 1 && rate.setAtMs !== undefined) {
    const opened = incidentsFor(snapshot, 'spike', 'payments_api', rate.setAtMs - 60_000).some((i) => !i.closedAt);
    if (!opened)
      return {
        inMs: rate.setAtMs + lagMs - nowMs,
        cause: 'rate',
        sinceMs: rate.setAtMs,
      };
  }
  return undefined;
}

/** How long a closed incident stays on the console as the green "Recovered" card. */
export const RECOVERED_SHOW_MS = 10 * 60_000;

export interface FocusIncident {
  incident: Incident;
  recovered: boolean;
}

/**
 * The one incident the console shows: the most severe open one (newest first among equals), else a
 * regression / spike that closed in the last 10 minutes (the "closed itself" beat). Good-news alerts are
 * never the focus while a real one is open.
 */
export function focusIncident(snapshot: Snapshot | null, nowMs: number): FocusIncident | undefined {
  if (!snapshot) return undefined;
  const open = snapshot.incidents
    .filter((i) => !i.closedAt)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || ms(b.openedAt) - ms(a.openedAt));
  if (open[0]) return { incident: open[0], recovered: false };
  const closed = snapshot.incidents
    .filter((i) => i.closedAt && (i.type === 'regression' || i.type === 'spike') && nowMs - ms(i.closedAt) <= RECOVERED_SHOW_MS)
    .sort((a, b) => ms(b.closedAt) - ms(a.closedAt));
  return closed[0] ? { incident: closed[0], recovered: true } : undefined;
}

export interface RemoteLever {
  lever: string;
  sinceMs: number;
}

/** A lever another device is running (demo/state.inFlight, 90 s expiry), when this tab is not running one. */
export function remoteLever(demo: DemoState | null, nowMs: number, localBusy: boolean): RemoteLever | undefined {
  if (localBusy || !demo?.inFlight) return undefined;
  const since = ms(demo.inFlight.since);
  if (!Number.isFinite(since) || nowMs - since >= IN_FLIGHT_TTL_MS) return undefined;
  return { lever: demo.inFlight.lever, sinceMs: since };
}

/**
 * The page lever's phase (EPIC_AUDIT P2-W18: "the lever becomes the countdown"):
 *   intact   — Break the trim is armed;
 *   waiting  — broken, no alert yet: the Break slot counts down to the expected alert (`inMs`, ≤ 0 = due);
 *   open     — the regression it caused is open: the one action left is Restore;
 *   broken   — broken with nothing to count from (no deploy time) or its alert already closed.
 */
export type TrimLeverPhase = { phase: 'intact' } | { phase: 'waiting'; inMs: number } | { phase: 'open' } | { phase: 'broken' };

export function trimLever(demo: DemoState | null, snapshot: Snapshot | null, nowMs: number): TrimLeverPhase {
  const trim = trimState(demo, snapshot);
  if (!trim.broken) return { phase: 'intact' };
  if (trim.brokenAtMs === undefined) return { phase: 'broken' };
  const since = incidentsFor(snapshot, 'regression', 'payments_api', trim.brokenAtMs - 60_000);
  if (since.some((i) => !i.closedAt)) return { phase: 'open' };
  if (since.length > 0) return { phase: 'broken' };
  const lagMs = (demo?.measuredLagSec ?? DEFAULT_MEASURED_LAG_SEC) * 1000;
  return { phase: 'waiting', inMs: trim.brokenAtMs + lagMs - nowMs };
}

/**
 * Incidents open in `snapshot` that are not in `seen` (the haptic cue fires once per new one). Pure: the
 * caller keeps `seen` and adds what this returns.
 */
export function newlyOpenedIncidents(seen: ReadonlySet<string>, snapshot: Snapshot | null): Incident[] {
  if (!snapshot) return [];
  return snapshot.incidents.filter((i) => !i.closedAt && !seen.has(i.id));
}

/** What the projector shows (EPIC_AUDIT P2-W18, the phone's "Projector: $1,234,567 · no alert" strip). */
export interface ProjectorLine {
  /** The presenter hero's figure at `nowMs`, millicents (accruing periods tick like the stage's meter). */
  valueM: number;
  /** Open alerts: the stage's takeover card is up for a new one. */
  alertOpen: boolean;
}

/**
 * The presenter hero's figure as the stage computes it (src/views/Presenter: periodFigure + the Meter's targetAt over
 * settings.presenter.headlinePeriod, annualized by default), so the phone quotes the number on the wall.
 * Undefined until there is a snapshot.
 */
export function projectorLine(snapshot: Snapshot | null, period: HeadlinePeriod | undefined, nowMs: number): ProjectorLine | undefined {
  if (!snapshot) return undefined;
  const figure = periodFigure(snapshot.headline, period ?? 'annualized');
  return {
    // The stage's shared Meter (src/components/Meter): the period figure plus its accrual since the sweep.
    valueM: targetAt({ valueM: figure.valueM, ratePerSecM: figure.accrue ? snapshot.ratePerSecM : 0, anchorMs: Date.parse(snapshot.sweepAt) }, nowMs),
    alertOpen: snapshot.incidents.some((i) => !i.closedAt),
  };
}

/**
 * What the presenter's takeover shows now (EPIC_AUDIT P2-W18, the console's "On the projector" thumbnail).
 * A model of src/components/IncidentTakeover, not a probe of another tab: the stage slides the card up for a
 * new high-severity alert and keeps it TAKEOVER_MS.alert (45 s) unless a key clears it; a watched incident
 * that closes gets the green card for TAKEOVER_MS.recovery (10 s). The alert is timed from its detection (the
 * sweep that opened it; `detectedAt` on catch-up), which is when a stage polling every 5 s sees it.
 */
export interface StageTakeover {
  mode: 'alert' | 'recovery';
  incident: Incident;
  /** ms until the stage's card clears on its own. */
  leftMs: number;
}

const takeoverWorthy = (i: Incident): boolean => i.severity === 'high' && i.type !== 'goodnews';

export function stageTakeover(snapshot: Snapshot | null, nowMs: number): StageTakeover | undefined {
  if (!snapshot) return undefined;
  const alert = snapshot.incidents
    .filter((i) => !i.closedAt && takeoverWorthy(i))
    .map((i) => ({ i, at: ms(i.detectedAt ?? i.openedAt) }))
    .filter(({ at }) => Number.isFinite(at) && nowMs >= at - 5_000 && nowMs - at < TAKEOVER_MS.alert)
    .sort((a, b) => b.at - a.at)[0];
  if (alert) return { mode: 'alert', incident: alert.i, leftMs: Math.max(0, alert.at + TAKEOVER_MS.alert - nowMs) };
  const recovery = snapshot.incidents
    .filter((i) => i.closedAt && takeoverWorthy(i))
    .map((i) => ({ i, at: ms(i.closedAt) }))
    .filter(({ at }) => Number.isFinite(at) && nowMs >= at - 5_000 && nowMs - at < TAKEOVER_MS.recovery)
    .sort((a, b) => b.at - a.at)[0];
  if (recovery) return { mode: 'recovery', incident: recovery.i, leftMs: Math.max(0, recovery.at + TAKEOVER_MS.recovery - nowMs) };
  return undefined;
}
