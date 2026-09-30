// src/state/selectors.ts — derived reads shared by the router and views.

import type { Meta, NotificationEndpoint, Snapshot } from '../../core/types.ts';
import { OTHER_FLOW_KEY } from '../../core/snapshot.ts';
import { humanize } from '../../core/humanize.ts';
import { BELL_ENDPOINT_ID, channelOf } from '../../core/delivery.ts';
import { t } from '../copy/en.ts';
import { toMs } from '../lib/format.ts';
import type { AppState, InventorySummary } from './store.ts';

export type HomeTarget = 'loading' | 'first-run' | 'receipt';

/**
 * What `/` should show (PRD 8.5): the first-run card when this workspace has never been priced and has
 * never been metered, else the Receipt. Unreadable documents (403/5xx) never count as "empty" — the
 * Receipt shows the error instead of pushing the member into setup.
 *
 * This is the ONE first-run gate: `/first-run` (src/tour/selectors.ts `firstRunGate`) asks the same question
 * of the member's live documents, so the two routes can never disagree (P1-D06: saved all-$0 prices used to
 * show a $0 Receipt on `/` and the onboarding card on `/first-run`).
 */
export function homeTarget(state: AppState): HomeTarget {
  if (state.source !== 'live') return 'receipt';
  const phase = state.status.hydrate.phase;
  if (phase === 'idle' || phase === 'loading') return 'loading';
  if (!state.hasHydrated) return 'receipt';
  return isFirstRunWorkspace(state.prices, state.snapshot, state.errors) ? 'first-run' : 'receipt';
}

/**
 * Whether these live documents are a never-priced, never-metered workspace: no prices document and no
 * snapshot, both known absent (read OK or 404) rather than unreadable.
 */
export function isFirstRunWorkspace(
  prices: AppState['prices'],
  snapshot: AppState['snapshot'],
  errors: AppState['errors'] = {},
): boolean {
  const unreadable = (e: AppState['errors']['prices']) => e !== undefined && e.kind !== 'not-found';
  if (unreadable(errors.prices) || unreadable(errors.snapshot)) return false;
  return prices === null && snapshot === null;
}

/**
 * True when a prices document exists but no destination in it costs anything: every entry of every version
 * is $0 (P1-D06). Nothing can count as saved then — the Receipt says so instead of showing a quiet $0.
 */
export function everyPriceIsZero(prices: AppState['prices']): boolean {
  const versions = prices?.versions ?? [];
  let entries = 0;
  for (const v of versions) {
    for (const entry of Object.values(v.byOutputId ?? {})) {
      entries++;
      if ((entry?.milliCentsPerGb ?? 0) > 0) return false;
    }
  }
  return entries > 0;
}

/**
 * FOUNDER_PLAN row 14 (founder-build r1 ui-11): the destinations priced at $0 (a free output type once any price is
 * saved, D33, or a stored $0) that receive a pipeline's reduction, when nothing is saved anywhere — the mixed $0 case,
 * where the Receipt read only "Nothing saved yet". Their display names, largest reduction first; [] otherwise (and
 * whenever every price is $0: everyPriceIsZero has its own notice).
 */
export function zeroPricedReducers(snapshot: Snapshot | null | undefined, labels?: Record<string, string>): string[] {
  if (!snapshot) return [];
  const flows = snapshot.flows ?? [];
  if (flows.some((f) => Number.isFinite(f.savedPerDayM) && f.savedPerDayM > 0) || (snapshot.headline?.mtdM ?? 0) > 0) return [];
  const free = new Map<string, string>();
  for (const d of snapshot.destinations ?? []) {
    if (!d.unpriced && d.milliCentsPerGb === 0) free.set(`${d.groupId}:${d.outputId}`, d.outputId);
  }
  if (free.size === 0 || (snapshot.destinations ?? []).every((d) => d.unpriced || d.milliCentsPerGb === 0)) return [];
  const removed = new Map<string, number>();
  for (const f of flows) {
    const key = `${f.groupId}:${f.outputId}`;
    const cut = (f.inBPerDay ?? 0) - (f.outBPerDay ?? 0);
    if (!free.has(key) || !(cut > (f.inBPerDay ?? 0) * 0.01)) continue;
    removed.set(key, (removed.get(key) ?? 0) + cut);
  }
  return [...removed.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => humanize(free.get(key) ?? key, labels) || (free.get(key) ?? key));
}

/** Whether saves are possible right now (hydrated, live data). Views disable Save buttons otherwise. */
export function canWrite(state: AppState): boolean {
  return state.hasHydrated && state.source === 'live';
}

// ─── Metering gate (REVIEW-3a #3) ────────────────────────────────────────────

/**
 * True only when KV is known to hold no prices document: read OK and absent (404). An unreadable prices
 * document (403, 5xx, network) is NOT "absent" — the same rule as `homeTarget`: the sweep reads prices
 * itself, so a transient read error here never stops a priced workspace from metering.
 */
export function pricesAbsent(state: AppState): boolean {
  if (state.prices !== null) return false;
  const error = state.errors.prices;
  return !error || error.kind === 'not-found';
}

/** Why this tab is not metering right now; null when it is allowed to. */
export type MeterBlocker = 'not-hydrated' | 'not-live' | 'not-ui' | 'replay' | 'no-prices' | 'runner';

/**
 * The 'ui' runtime's gate (PRD 2.6, DECISIONS D11/D12b, D25). A tab meters only when settings are
 * hydrated, live data is showing, the runtime is 'ui', replay is off — and a prices document exists.
 * Without prices, a sweep would meter the 60-minute seed and every minute after it at $0 for good
 * (metered minutes are never re-priced); with the gate, the first sweep after "Save changes" prices the
 * seed hour at the first price (D25).
 *
 * It also yields to the runner (P1-D05): while the runner swept within the last 90 s (RUNNER_FRESH_MS) it
 * meters every minute on its own, so an open tab only reads — about 12 Leader calls a minute instead of ~59
 * for the two meters racing for the lock. The moment the runner goes quiet the tab meters again (live polling
 * re-evaluates this gate every poll).
 */
export function meterBlocker(state: AppState, nowMs: number = Date.now()): MeterBlocker | null {
  if (!state.hasHydrated) return 'not-hydrated';
  if (state.source !== 'live') return 'not-live';
  if (state.settings.runtime !== 'ui') return 'not-ui';
  if (state.settings.demo.replayMode) return 'replay';
  if (pricesAbsent(state)) return 'no-prices';
  if (isRunnerFresh(runnerLastSweep(state), nowMs)) return 'runner';
  return null;
}

/** The newest runner sweep this tab knows of: the one remembered across polls, or the one in `meta` now. */
export function runnerLastSweep(state: AppState): number | undefined {
  const seen = state.status.sweep.runnerSeenAt;
  const inMeta = state.source === 'live' ? runnerSweepAt(state.meta) : undefined;
  if (seen === undefined) return inMeta;
  if (inMeta === undefined) return seen;
  return Math.max(seen, inMeta);
}

// ─── Sweep failures (P0-07) ──────────────────────────────────────────────────

/** A figure older than this reads as stale; a meter silent this long "stopped sweeping" (the meter writes every 30–60 s). */
export const STALE_AFTER_MS = 5 * 60_000;

/**
 * What a failed sweep's error code means, whoever ran it: this tab (`status.sweep.lastFailure`) or the runner /
 * backend / another tab (`meta.lastError`). The codes are core/sweep.ts's: `rate_limited`, `budget`,
 * `time_budget`, or an error message such as `metrics outputs query failed: HTTP 403 …`,
 * `KV PUT snapshot failed: HTTP 500`, `config read /master/groups failed: HTTP 401`.
 */
export type SweepErrorKind =
  | 'metrics-forbidden'
  | 'forbidden'
  | 'unauthorized'
  | 'rate-limited'
  | 'budget'
  | 'time-budget'
  | 'storage'
  | 'server'
  | 'network'
  | 'unknown';

export interface SweepErrorInfo {
  kind: SweepErrorKind;
  /** the HTTP status the code carried, when it carried one */
  status?: number;
}

/** Classifies a sweep's error code (never shown raw: `rate_limited` or a JSON body reads as a bug). */
export function classifySweepError(code: string | undefined, status?: number): SweepErrorInfo {
  const text = (code ?? '').trim();
  const lower = text.toLowerCase();
  if (lower === 'rate_limited' || /\brate limited\b/.test(lower)) return { kind: 'rate-limited', status: 429 };
  if (lower === 'budget' || /\bbudget of \d+ calls\b/.test(lower)) return { kind: 'budget' };
  if (lower === 'time_budget' || /\btime budget\b/.test(lower)) return { kind: 'time-budget' };
  const match = /\bHTTP (\d{1,3})\b/.exec(text);
  const code3 = status ?? (match ? Number(match[1]) : undefined);
  const withStatus = (kind: SweepErrorKind): SweepErrorInfo => (code3 !== undefined && code3 > 0 ? { kind, status: code3 } : { kind });
  if (code3 === 429) return withStatus('rate-limited');
  if (code3 === 401) return withStatus('unauthorized');
  if (code3 === 403) return withStatus(/^metrics\b/i.test(text) ? 'metrics-forbidden' : 'forbidden');
  if (code3 === 413 || /\bKV document .* chunks\b/.test(text)) return withStatus('storage');
  if (code3 !== undefined && code3 >= 500) return withStatus('server');
  if (code3 === 0 || /failed to fetch|networkerror|network error|load failed|timed? ?out|aborted/i.test(text)) return { kind: 'network' };
  return withStatus('unknown');
}

/**
 * The worker groups the metrics query covers, for "Couldn't read metrics for default": the inventory summary's,
 * else the groups the snapshot's destinations belong to (the inventory summary is read once, after hydration,
 * so a workspace whose first sweep ran in this tab has only the snapshot to go by). Sorted, never empty strings.
 */
export function meteredGroups(state: Pick<AppState, 'inventory' | 'snapshot'>): string[] {
  const fromInventory = (state.inventory?.groups ?? []).filter((g) => g.trim() !== '');
  if (fromInventory.length > 0) return [...fromInventory].sort();
  const seen = new Set<string>();
  for (const d of state.snapshot?.destinations ?? []) if (typeof d.groupId === 'string' && d.groupId.trim() !== '') seen.add(d.groupId);
  return [...seen].sort();
}

/**
 * Kinds that no retry will fix by itself (a permission, an expired session) or that the Leader asked for (a
 * 429): they show on the first failed sweep. Everything else waits for a second one in a row, so one blip
 * never flips the chip.
 */
const IMMEDIATE: ReadonlySet<SweepErrorKind> = new Set(['metrics-forbidden', 'forbidden', 'unauthorized', 'rate-limited']);

/** A metering failure the chrome shows (P0-07); null while sweeps run, or while no sweep is expected. */
export interface MeteringFailure extends SweepErrorInfo {
  /** epoch ms of the last sweep that ran (nothing metered since), else the first failure's */
  since: number;
  /** who saw it fail: this tab's own sweeps, or `meta` (the runner, the backend, another tab) */
  source: 'this-tab' | 'meta';
}

/** Past this with `meta.lastError` still set, the meter (whoever it is) has failed at least twice in a row. */
export const META_FAILING_AFTER_MS = 2 * 60_000;

/**
 * Whether metering is failing, from this tab's own sweeps or from `meta`:
 *   • this tab: its last sweeps failed — once for a permission, session or rate-limit error, twice in a row for
 *     anything else — and no sweep has completed since (another meter may have succeeded meanwhile);
 *   • meta: the last sweep attempt recorded an error (`meta.lastError`, cleared by the next completed sweep)
 *     and the last completed one is over two minutes old — the runner, the backend or another tab is failing.
 */
export function meteringFailure(state: AppState, nowMs: number): MeteringFailure | null {
  if (state.source !== 'live') return null;
  const lastGood = toMs(state.meta?.lastSweepAt);
  const sweep = state.status.sweep;
  const mine = sweep.lastFailure;
  if (mine && (sweep.failures ?? 0) > 0 && !(Number.isFinite(lastGood) && lastGood > mine.at)) {
    const info = classifySweepError(mine.code, mine.status);
    if ((sweep.failures ?? 0) >= 2 || IMMEDIATE.has(info.kind)) {
      const first = sweep.failingSince ?? mine.at;
      return { ...info, since: Number.isFinite(lastGood) && lastGood < first ? lastGood : first, source: 'this-tab' };
    }
  }
  const metaError = state.meta?.lastError;
  // A tab that just started metering is about to find out for itself: an error another meter left in `meta`
  // hours ago does not flash "Not metering" in the seconds before this tab's own first sweep lands.
  const firstSweepPending = sweep.metering && sweep.lastRunAt === undefined;
  if (metaError && !firstSweepPending && Number.isFinite(lastGood) && nowMs - lastGood > META_FAILING_AFTER_MS) {
    return { ...classifySweepError(metaError), since: lastGood, source: 'meta' };
  }
  return null;
}

// ─── Who meters (Footer, Settings → Runtime) ─────────────────────────────────

/** Who ran the last sweep, for "Metered by the runner on <host>" vs "Metered by this tab" (Footer, Settings). */
export type SweepOwnerKind = 'tab' | 'runner' | 'backend' | 'unknown';

type OwnerMeta = Pick<Meta, 'lastSweepOwner' | 'lastSweepMode'> | null | undefined;

/**
 * From `meta.lastSweepOwner`, the KV-lock owner the last sweep ran as: `ui:<tab id>` an open App tab
 * (runtime 'ui'), `runner:…` the customer-run runner (scripts/runner.ts, DECISIONS D24), `backend:…` the App
 * backend's scheduled `meter` (Enterprise variant). The sweep's own fallback ids `sweep:ui` / `sweep:backend`
 * count too. A meta written before owners were recorded falls back to `lastSweepMode` 'ui' (only a tab
 * sweeps in that mode); anything else is 'unknown'.
 */
export function sweepOwnerKind(meta: OwnerMeta): SweepOwnerKind {
  const owner = meta?.lastSweepOwner;
  if (typeof owner === 'string' && owner.trim() !== '') {
    const at = owner.indexOf(':');
    const prefix = at < 0 ? owner : owner.slice(0, at);
    const rest = at < 0 ? '' : owner.slice(at + 1);
    if (prefix === 'ui') return 'tab';
    if (prefix === 'runner') return 'runner';
    if (prefix === 'backend') return 'backend';
    if (prefix === 'sweep' && rest === 'ui') return 'tab';
    if (prefix === 'sweep' && rest === 'backend') return 'backend';
    return 'unknown';
  }
  return meta?.lastSweepMode === 'ui' ? 'tab' : 'unknown';
}

/**
 * The runner's host, when its owner id carries one (`runner:<host>:<pid>`, or `runner:<host>`); undefined
 * for a bare `runner:<pid>` and for every other owner.
 */
export function sweepOwnerHost(meta: OwnerMeta): string | undefined {
  const owner = meta?.lastSweepOwner;
  if (typeof owner !== 'string' || !owner.startsWith('runner:')) return undefined;
  const parts = owner.slice('runner:'.length).split(':');
  const host = parts.length >= 2 ? parts.slice(0, -1).join(':') : /^\d+$/.test(parts[0]) ? '' : parts[0];
  return host.trim() !== '' ? host.trim() : undefined;
}

/** Who metered the live data on screen; 'unknown' while a tour or replay shows sample data. */
export function sweepOwner(state: AppState): SweepOwnerKind {
  return state.source === 'live' ? sweepOwnerKind(state.meta) : 'unknown';
}

/** A runner sweep this recent means the runner is metering (it sweeps every minute; one missed minute tolerated). */
export const RUNNER_FRESH_MS = 90_000;

/**
 * epoch ms of the last completed sweep in `meta` when the runner ran it, else undefined. The meter loop
 * folds this into `status.sweep.runnerSeenAt` so a live runner is still recognised after an open tab
 * wins the lock for one minute.
 */
export function runnerSweepAt(
  meta: Pick<Meta, 'lastSweepOwner' | 'lastSweepMode' | 'lastSweepAt' | 'deliveryOwner' | 'deliveryOwnerAt'> | null | undefined,
): number | undefined {
  const swept = sweepOwnerKind(meta) === 'runner' ? toMs(meta?.lastSweepAt) : Number.NaN;
  // A runner that found the minute metered by a tab only checks in (core/sweep.ts, P1-E05): it is still alive.
  const checked = sweepOwnerKind({ lastSweepOwner: meta?.deliveryOwner }) === 'runner' ? toMs(meta?.deliveryOwnerAt) : Number.NaN;
  const at = Math.max(Number.isFinite(swept) ? swept : -Infinity, Number.isFinite(checked) ? checked : -Infinity);
  return Number.isFinite(at) ? at : undefined;
}

/** Whether the runner (scripts/runner.ts) has swept within `windowMs` of `nowMs`. */
export function isRunnerFresh(runnerSeenAt: number | undefined, nowMs: number, windowMs: number = RUNNER_FRESH_MS): boolean {
  return runnerSeenAt !== undefined && Number.isFinite(runnerSeenAt) && nowMs - runnerSeenAt < windowMs && runnerSeenAt - nowMs < windowMs;
}

/**
 * Whether this tab is the one metering (P1-D03):
 *   • it ran the last completed sweep (the lock owner in `meta` is this tab's id); or
 *   • it is metering and the last sweep was an open tab's that completed BEFORE this tab started metering, and
 *     this tab was never refused the lock. That is this very tab before a reload (a new id, the minute already
 *     metered, so its sweeps come back 'current' until the next minute) — or a tab closed since.
 * Any sweep another tab completes after this one started metering, or a 'locked' refusal, proves another tab is
 * open: then only the owner in `meta` says "this tab", so two open tabs never both claim it. Skipped sweeps
 * ('current', 'locked') never count as this tab having swept.
 */
export function sweptByThisTab(state: AppState): boolean {
  const { ownerId, metering, lastResult, meteringSince } = state.status.sweep;
  const owner = state.meta?.lastSweepOwner;
  if (ownerId && owner === ownerId) return true;
  if (!metering || sweepOwnerKind(state.meta) !== 'tab') return false;
  if (lastResult?.skipped === 'locked') return false;
  const at = toMs(state.meta?.lastSweepAt);
  if (meteringSince !== undefined && Number.isFinite(at) && at >= meteringSince) return false;
  return true;
}

/**
 * Who meters this workspace, for the footer and Settings → Runtime:
 *   'runner'          the runner swept within the last 90 s (RUNNER_FRESH_MS), or up to 5 min ago
 *                     (STALE_AFTER_MS), whoever won the last minute;
 *   'runner-silent'   the runner ran the last sweep, more than 5 minutes ago ("stopped sweeping 20 min ago");
 *   'this-tab'        this tab ran the last sweep, or will: see `sweptByThisTab`;
 *   'other-tab'       another open tab (or window) ran it;
 *   'backend'         the Enterprise App backend's schedule ran it;
 *   'backend-silent'  the backend ran the last sweep, more than 5 minutes ago;
 *   'no-prices'       nobody yet: the 'ui' runtime waits for a prices document (meterBlocker);
 *   'unreadable'      nobody, as far as this tab can tell: its settings could not be read (403, 5xx, network), so it
 *                     does not meter and cannot say who does (P1-D01: never "Meters every 30 seconds" beside Offline);
 *   'unknown'         no sweep recorded yet, or sample / replay data is showing.
 */
export type MeteredBy =
  | 'runner'
  | 'runner-silent'
  | 'this-tab'
  | 'other-tab'
  | 'backend'
  | 'backend-silent'
  | 'no-prices'
  | 'unreadable'
  | 'unknown';

export function meteredBy(state: AppState, nowMs: number): MeteredBy {
  if (state.source !== 'live') return 'unknown';
  if (isRunnerFresh(state.status.sweep.runnerSeenAt, nowMs)) return 'runner';
  const lastAt = toMs(state.meta?.lastSweepAt);
  const silent = Number.isFinite(lastAt) && nowMs - lastAt > STALE_AFTER_MS;
  switch (sweepOwnerKind(state.meta)) {
    case 'runner':
      return silent ? 'runner-silent' : 'runner';
    case 'backend':
      return silent ? 'backend-silent' : 'backend';
    case 'tab':
      if (sweptByThisTab(state)) return 'this-tab';
      // A tab that swept over five minutes ago is not "another open tab" any more: say nothing about who.
      return silent ? 'unknown' : 'other-tab';
    default:
      if (!state.hasHydrated && state.status.hydrate.phase === 'error') return 'unreadable';
      return meterBlocker(state, nowMs) === 'no-prices' ? 'no-prices' : 'unknown';
  }
}

// ─── Endpoint names (IncidentCard delivery lines, Settings results) ──────────

/**
 * The human name of a notification endpoint for delivery lines ("Sent to Cribl notifications ✓"):
 *   • the Cribl bell — 'Cribl notifications', also for the implicit default bell, which is never stored
 *     (its id `cribl-bell` alone resolves);
 *   • a Cribl notification target — the name the member gave it, else its target id;
 *   • a direct webhook — its name, else the format ('Slack', 'ServiceNow', 'webhook').
 * An id that is not in `endpoints` falls back to the id itself (a removed endpoint still reads as something).
 * Same call shape as IncidentCard `endpointName(endpointId, endpoints)`, so it swaps in place.
 */
export function endpointDisplayName(endpointId: string, endpoints?: readonly NotificationEndpoint[] | null): string {
  const ep = endpoints?.find((e) => e.id === endpointId);
  if (ep ? channelOf(ep) === 'cribl-bell' : endpointId === BELL_ENDPOINT_ID) return t('settings.notify.channels.bell.name');
  const name = ep?.name?.trim();
  if (name) return name;
  if (ep && channelOf(ep) === 'cribl-target') return ep.criblTargetId?.trim() || t('settings.notify.channels.channelTarget');
  if (ep?.format === 'slack') return t('incidents.endpointFallback.slack');
  if (ep?.format === 'servicenow') return t('incidents.endpointFallback.servicenow');
  if (ep) return t('incidents.endpointFallback.generic');
  return endpointId || t('incidents.endpointFallback.generic');
}

// ─── A folded snapshot (usefulness review, round 2) ──────────────────────────

/**
 * A snapshot over its size cap keeps the largest flows and sums the rest into one 'Other' flow (core/snapshot.ts
 * compactSnapshot: 500, 250, 100 or 50 of them). The sweep still meters and watches every flow; only the list is
 * short. `total` and `inOther` come from the sweep's own count before the fold (Snapshot.flowCounts) when the snapshot
 * carries one, else from the inventory the sweep walks (InventorySummary.metered), when it is read.
 */
export interface SnapshotFold {
  /** flows listed one by one (the Other flow not counted) */
  shown: number;
  /** every flow the sweep meters, when the inventory says and it is more than the listed ones */
  total?: number;
  /** total − shown */
  inOther?: number;
  /** routes and sources the detector watches, from the same inventory */
  routes?: number;
  sources?: number;
}

/** The estate a sweep counted before the fold, on snapshots that carry it (core's Snapshot.flowCounts, rules round 2). */
type Counted = { flowCounts?: { flows: number; routes: number; sources: number } };

export function snapshotFold(snapshot: Pick<Snapshot, 'flows'> | null | undefined, inventory: InventorySummary | null | undefined): SnapshotFold | undefined {
  const flows = snapshot?.flows ?? [];
  if (!flows.some((f) => f.key === OTHER_FLOW_KEY)) return undefined;
  const shown = flows.length - 1;
  // The sweep's own count before it folded is the authority; the inventory walk stands in on snapshots without one.
  const metered = (snapshot as Counted | null | undefined)?.flowCounts ?? inventory?.metered;
  if (!metered || !(metered.flows > shown)) return { shown };
  return { shown, total: metered.flows, inOther: metered.flows - shown, routes: metered.routes, sources: metered.sources };
}

/** Whether a flow is the folded 'Other' flow. */
export function isOtherFlow(f: { key: string }): boolean {
  return f.key === OTHER_FLOW_KEY;
}
