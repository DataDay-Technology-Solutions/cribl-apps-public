// core/commitImpacts.ts — price every commit (P2-W07, DESIGN_BRIEF 5.4 "who moved the money").
//
// The pitch is "a drop arrives with a commit ID and a username"; this module puts a dollar figure on every commit,
// in both directions, so the same mechanism that blames a bad deploy credits a good one. Pure: no React, no DOM,
// no clock (every time comes from the snapshot), so the unit tests pin each rule.
//
// What moved after a commit (movedAfter, the change timeline's "What moved"):
//   1. alerts that name the commit: their own before → after, priced at the alert's impactPerDayM (exact — the
//      figure the alert itself reported; a regression is a loss, a goodnews a gain);
//   2. flows whose per-minute sparkline covers the commit and shifted by at least a threshold (lower for flows the
//      commit touched): delta ratio × the flow's would-have-paid per day;
//   3. flows the commit touched that only exist after it (a pack applied = a new pipeline): "now N %", counted as
//      moved but not priced — there is no before to measure against.
//
// A commit's price, by the first basis that can measure it (every figure names its basis on screen):
//   alert      an alert names it                       Σ alert impacts (+ any flows that also moved)
//   flows      its flows' per-minute history covers it Σ (delta × would-have-paid per day) over the flows that moved
//   workspace  the 24 h ratio series covers it          (ratio after − ratio before) × every priced flow's
//              (5-minute buckets)                       would-have-paid per day, over up to an hour each side,
//                                                       stopping at the neighbouring commits so it measures this one
//   daily      older, inside the 7-day trend            the first whole day after the deploy day − the nearest
//                                                       earlier day of the same kind (weekday / weekend: a
//                                                       weekend's mix moves the ratio by itself), only where no
//                                                       other commit shipped between them
//   none       nothing covers it, or a neighbour sits too close to measure it alone → "not priced"
// A measured shift under one point is "no measurable change", never a dollar figure. Money is integer millicents.

import { humanize } from './humanize.ts';
import { flowObjectKeys } from './flows.ts';
import { perYear } from './format.ts';
import { incidentReadings } from './incidents.ts';
import { addDaysToKey, localDayKey, localDayStartMs } from './time.ts';
import { commitTimeMs, filesTouchObject, isGroupRouteTable, messageNamesObject, sameHash } from './timeline.ts';
import type { Commit, FlowFigures, Incident, Snapshot } from './types.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The part of a snapshot the pricing reads. */
export type ImpactSnapshot = Pick<Snapshot, 'flows' | 'incidents' | 'windowEnd' | 'sweepAt' | 'timeline' | 'ratioSeries' | 'trend'>;

// ─── What moved ──────────────────────────────────────────────────────────────

export interface MovedLine {
  /** object key (route for flows; the alert's object for alerts) */
  key: string;
  label: string;
  /** ratio before the commit; undefined when the flow only exists after it (a new pipeline) */
  before?: number;
  after: number;
  /** after − before (0 when before is unknown) */
  delta: number;
  source: 'alert' | 'flow';
  /** the commit changed this object's files or named it */
  touched: boolean;
  /** signed $/day in millicents: + savings rose, − savings fell; undefined when it can't be priced (a new flow, unpriced) */
  perDayM?: number;
  /** an alert line whose alert closed as recovered (its money no longer stands) */
  recovered?: true;
  /** the other commit of a break → revert pair: the recovering commit on the break's line, the break on the recovery's */
  pairedWith?: string;
}

export interface MovedOptions {
  humanize?: Record<string, string>;
  /** minutes one sparkline point covers (1 for the live snapshot's per-minute points) */
  minutesPerPoint?: number;
  /** smallest shift (ratio) that counts for an object the commit touched / did not touch */
  touchedThreshold?: number;
  untouchedThreshold?: number;
}

function snapshotEnd(snapshot: Pick<Snapshot, 'windowEnd' | 'sweepAt'>): number {
  const end = Date.parse(snapshot.windowEnd);
  return Number.isFinite(end) ? end : Date.parse(snapshot.sweepAt);
}

function mean(xs: readonly number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function touches(commit: Commit, flow: FlowFigures): boolean {
  const keys = flowObjectKeys(flow);
  if (keys.pipeline && filesTouchObject(commit.files, keys.pipeline) === 'object') return true;
  if (keys.route && filesTouchObject(commit.files, keys.route, flow.pipelineId) === 'object') return true;
  return messageNamesObject(commit.message, [flow.routeId, flow.pipelineId, flow.inputId]);
}

/** A flow's would-have-paid per day, or undefined when its destination is unpriced (no dollars to move). */
function flowWhpPerDay(flow: FlowFigures): number | undefined {
  return flow.state === 'unpriced' || !(flow.whpPerDayM > 0) ? undefined : flow.whpPerDayM;
}

/** A regression that closed by recovering (D47: it kept where it recovered to), not by a member and not below the floor. */
function recoveredRegression(inc: Incident): boolean {
  return inc.type === 'regression' && !!inc.closedAt && !inc.closedReason && incidentReadings(inc).recoveredTo !== undefined;
}

/** The first line of a commit message (a revert quotes it: `Revert "<first line>"`). */
const firstLine = (message: string | undefined): string => (message ?? '').split('\n')[0].trim();

/**
 * The commit a recovered regression recovered after (rules round 2, usefulness): the latest commit between the one the
 * alert named and the close that changed the same configuration file (the group's route table, which every route edit
 * rewrites, never counts: D62) or that quotes the named commit's message (a revert). Undefined when none did: the
 * regression recovered by itself.
 */
export function recoveringCommit(inc: Incident, timeline: readonly Commit[]): Commit | undefined {
  if (!inc.commit || !recoveredRegression(inc)) return undefined;
  const named = timeline.find((c) => sameHash(c.hash, inc.commit!.hash));
  const from = commitTimeMs(named ?? inc.commit);
  const to = Date.parse(inc.closedAt!);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  const files = new Set((named?.files ?? []).filter((f) => !isGroupRouteTable(f)));
  const quote = firstLine(named?.message ?? inc.commit.message);
  let best: Commit | undefined;
  for (const c of timeline) {
    if (sameHash(c.hash, inc.commit.hash)) continue;
    const t = commitTimeMs(c);
    if (!(t > from && t <= to)) continue;
    const related = (c.files ?? []).some((f) => files.has(f)) || (quote.length >= 8 && (c.message ?? '').includes(quote));
    if (related && (!best || t > commitTimeMs(best))) best = c;
  }
  return best;
}

/**
 * Every object whose savings ratio changed after `commit`, biggest move first (alerts, then flows by |delta|, new
 * flows last), each priced where it can be. The change timeline's "What moved" is the first five of these.
 */
export function movedAfter(
  commit: Commit,
  snapshot: Pick<Snapshot, 'flows' | 'incidents' | 'windowEnd' | 'sweepAt'> & { timeline?: readonly Commit[] },
  opts: MovedOptions = {},
): MovedLine[] {
  const tc = commitTimeMs(commit);
  const end = snapshotEnd(snapshot);
  // Each side of the commit stops at its neighbours, so a flow that moved after the NEXT commit is never this one's.
  const { prev, next } = neighbours(commit, snapshot.timeline ?? [], tc);
  const perPoint = (opts.minutesPerPoint ?? 1) * MINUTE;
  const touchedMin = opts.touchedThreshold ?? 0.03;
  const untouchedMin = opts.untouchedThreshold ?? 0.1;
  const items = new Map<string, MovedLine>();

  for (const inc of snapshot.incidents ?? []) {
    if (!inc.commit || !sameHash(inc.commit.hash, commit.hash)) continue;
    if (inc.type !== 'regression' && inc.type !== 'goodnews') continue;
    // The drop the alert kept (D47); one closed before D47 kept none, and its flow's sparkline speaks instead.
    const r = incidentReadings(inc);
    if (r.after === undefined) continue;
    const impact = Math.max(0, Math.round(inc.impactPerDayM || 0));
    const line: MovedLine = {
      key: inc.objectKey,
      label: inc.label,
      before: r.before,
      after: r.after,
      delta: r.after - r.before,
      source: 'alert',
      touched: true,
      perDayM: inc.type === 'regression' ? -impact : impact,
    };
    if (recoveredRegression(inc)) {
      line.recovered = true;
      const by = recoveringCommit(inc, snapshot.timeline ?? []);
      if (by) line.pairedWith = by.hash;
    }
    items.set(inc.objectKey, line);
  }

  // Rules round 2 (usefulness): the commit a regression recovered after is priced on the alert's own basis, so the
  // break and its revert net to zero in the Changes list (the tour read −$1,250 and +$1,013, net −$237, for a drop
  // that recovered to where it was).
  for (const inc of snapshot.incidents ?? []) {
    if (!inc.commit || sameHash(inc.commit.hash, commit.hash) || items.has(inc.objectKey)) continue;
    const by = recoveringCommit(inc, snapshot.timeline ?? []);
    if (!by || !sameHash(by.hash, commit.hash)) continue;
    const r = incidentReadings(inc);
    if (r.after === undefined || r.recoveredTo === undefined) continue;
    items.set(inc.objectKey, {
      key: inc.objectKey,
      label: inc.label,
      before: r.after,
      after: r.recoveredTo,
      delta: r.recoveredTo - r.after,
      source: 'alert',
      touched: true,
      perDayM: Math.max(0, Math.round(inc.impactPerDayM || 0)),
      pairedWith: inc.commit.hash,
    });
  }

  for (const flow of snapshot.flows ?? []) {
    const keys = flowObjectKeys(flow);
    const key = keys.route ?? keys.pipeline ?? flow.key;
    if (items.has(key) || (keys.pipeline && items.has(keys.pipeline))) continue;
    const spark = flow.sparkline ?? [];
    const n = spark.length;
    if (n === 0 || !Number.isFinite(tc) || tc >= end) continue;
    const sparkStart = end - n * perPoint;
    const touched = touches(commit, flow);
    const label = humanize(flow.pipelineId !== '-' ? flow.pipelineId : flow.routeId, opts.humanize);
    if (tc <= sparkStart) {
      // The flow's history starts after the commit: a flow the commit created (e.g. a pack pipeline).
      if (touched && n < 30 && sparkStart - tc <= 30 * MINUTE) {
        items.set(key, { key, label, after: mean(spark), delta: 0, source: 'flow', touched });
      }
      continue;
    }
    const split = Math.min(n, Math.max(0, Math.ceil((tc - sparkStart) / perPoint)));
    if (split === 0 || split === n) continue;
    const lo = Number.isFinite(prev) ? Math.min(split, Math.max(0, Math.ceil((prev - sparkStart) / perPoint))) : 0;
    const hi = Number.isFinite(next) ? Math.max(split, Math.min(n, Math.floor((next - sparkStart) / perPoint))) : n;
    if (lo === split || hi === split) continue;
    const before = mean(spark.slice(lo, split));
    const after = mean(spark.slice(split, hi));
    const delta = after - before;
    if (Math.abs(delta) >= (touched ? touchedMin : untouchedMin)) {
      const whp = flowWhpPerDay(flow);
      const line: MovedLine = { key, label, before, after, delta, source: 'flow', touched };
      if (whp !== undefined) line.perDayM = Math.round(delta * whp);
      items.set(key, line);
    }
  }

  return [...items.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'alert' ? -1 : 1;
    const ka = a.before === undefined ? -1 : Math.abs(a.delta);
    const kb = b.before === undefined ? -1 : Math.abs(b.delta);
    return kb - ka || a.label.localeCompare(b.label);
  });
}

// ─── A commit's price ────────────────────────────────────────────────────────

export type ImpactBasis = 'alert' | 'flows' | 'workspace' | 'daily';
/** priced: a dollar figure · flat: measured, under a point · unpriced: nothing covers it on its own */
export type ImpactStatus = 'priced' | 'flat' | 'unpriced';

export interface CommitImpact {
  commit: Commit;
  /** when it took effect: deploy time, else commit time (epoch ms) */
  t: number;
  status: ImpactStatus;
  /** how it was measured (priced and flat) */
  basis?: ImpactBasis;
  /** signed $/day in millicents (+ savings rose); 0 unless priced */
  perDayM: number;
  /** perDayM × 365 */
  perYearM: number;
  /** the savings-ratio shift the workspace / daily bases measured (after − before) */
  ratioDelta?: number;
  /** what moved after it (alerts and flows), priced line by line where possible */
  moved: MovedLine[];
  /**
   * Every alert that priced it closed as recovered: the money no longer stands, so it never headlines (rules round 2).
   * `revertedBy` names the later commit the recovery followed, when one did (the UI can say "reverted by 9a9a4c6").
   */
  recovered?: true;
  revertedBy?: string;
  /** It is the commit a regression recovered after, priced on that alert's basis (`reverts` = the break's hash). */
  reverts?: string;
}

export interface ImpactOptions extends MovedOptions {
  /** IANA zone the 7-day trend's day keys are in (settings.displayTimezone); the daily basis needs it */
  timeZone?: string;
  /** a measured workspace / daily shift smaller than this (ratio) is "no measurable change" (default 1 point) */
  flatBelow?: number;
}

/** Every priced flow's would-have-paid per day: what a workspace-wide ratio shift is priced against. */
export function workspaceWhpPerDayM(flows: readonly FlowFigures[]): number {
  return flows.reduce((s, f) => s + (flowWhpPerDay(f) ?? 0), 0);
}

/** The ratio series' buckets (core/snapshot.ts: 5 minutes, keyed by their start). One that holds a commit mixes before and after. */
const BUCKET = 5 * MINUTE;
const WORKSPACE_REACH = HOUR;

function neighbours(commit: Commit, all: readonly Commit[], tc: number): { prev: number; next: number } {
  let prev = -Infinity;
  let next = Infinity;
  for (const c of all) {
    if (sameHash(c.hash, commit.hash)) continue;
    const t = commitTimeMs(c);
    if (!Number.isFinite(t)) continue;
    if (t <= tc && t > prev) prev = t;
    if (t > tc && t < next) next = t;
  }
  return { prev, next };
}

/**
 * Ratio after − before from the 24 h series: whole 5-minute buckets up to an hour each side, none holding the commit
 * or reaching past a neighbouring commit; undefined when a side has none.
 */
function workspaceShift(series: Snapshot['ratioSeries'], tc: number, prev: number, next: number, end: number): number | undefined {
  const lo = Math.max(tc - WORKSPACE_REACH, prev);
  const hi = Math.min(tc + WORKSPACE_REACH, next, end);
  const before: number[] = [];
  const after: number[] = [];
  for (const p of series ?? []) {
    const t = Date.parse(p.t);
    if (!Number.isFinite(t) || !Number.isFinite(p.ratio)) continue;
    if (t >= lo && t + BUCKET <= tc) before.push(p.ratio);
    else if (t >= tc && t + BUCKET <= hi) after.push(p.ratio);
  }
  if (before.length === 0 || after.length === 0) return undefined;
  return mean(after) - mean(before);
}

function isWeekend(key: string, tz: string): boolean {
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(localDayStartMs(key, tz) + 12 * HOUR);
  return day === 'Sat' || day === 'Sun';
}

/**
 * The first whole day after the deploy day − the nearest earlier whole day of the same kind (7-day trend). Same
 * kind, because a weekend's traffic mix moves the ratio on its own: Friday → Saturday is not a commit's doing. Only
 * where no other commit shipped between the two days' edges, so the shift is this commit's alone.
 */
function dailyShift(trend: Snapshot['trend'], tc: number, others: readonly number[], tz: string): number | undefined {
  const day = localDayKey(tc, tz);
  const afterKey = addDaysToKey(day, 1);
  const weekend = isWeekend(afterKey, tz);
  let beforeKey: string | undefined;
  for (let k = 1; k <= 3 && !beforeKey; k++) {
    const key = addDaysToKey(day, -k);
    if (isWeekend(key, tz) === weekend) beforeKey = key;
  }
  if (!beforeKey) return undefined;
  const from = localDayStartMs(beforeKey, tz);
  const to = localDayStartMs(addDaysToKey(afterKey, 1), tz);
  if (others.some((t) => t >= from && t < to)) return undefined;
  const pick = (key: string) => (trend ?? []).find((d) => d.day === key && d.whpM > 0);
  const b = pick(beforeKey);
  const a = pick(afterKey);
  if (!a || !b) return undefined;
  return a.savedM / a.whpM - b.savedM / b.whpM;
}

/** Prices one commit (see the header for the bases, in order). */
export function priceCommit(commit: Commit, snapshot: ImpactSnapshot, opts: ImpactOptions = {}): CommitImpact {
  const t = commitTimeMs(commit);
  const end = snapshotEnd(snapshot);
  const moved = movedAfter(commit, snapshot, opts);
  const out = (status: ImpactStatus, perDayM = 0, extra: Partial<CommitImpact> = {}): CommitImpact => ({
    commit,
    t,
    status,
    perDayM,
    perYearM: perYear(perDayM),
    moved,
    ...extra,
  });

  const priced = moved.filter((m) => m.perDayM !== undefined);
  if (priced.length > 0) {
    const sum = priced.reduce((s, m) => s + (m.perDayM ?? 0), 0);
    const alerts = moved.filter((m) => m.source === 'alert');
    const pair: Partial<CommitImpact> = {};
    // Its own alerts (never the recovery lines it earns for a break it reverted) all closed as recovered.
    const own = alerts.filter((m) => m.recovered || m.pairedWith === undefined);
    if (own.length > 0 && own.every((m) => m.recovered)) {
      pair.recovered = true;
      const by = own.find((m) => m.pairedWith)?.pairedWith;
      if (by) pair.revertedBy = by;
    }
    const reverted = alerts.find((m) => !m.recovered && m.pairedWith !== undefined);
    if (reverted?.pairedWith) pair.reverts = reverted.pairedWith;
    return out('priced', sum, { basis: alerts.length > 0 ? 'alert' : 'flows', ...pair });
  }
  if (!Number.isFinite(t) || t >= end) return out('unpriced');

  // The flows' per-minute history covers the commit and nothing moved past the thresholds: measured, flat.
  const perPointHistory = Math.max(0, ...(snapshot.flows ?? []).map((f) => f.sparkline?.length ?? 0)) * (opts.minutesPerPoint ?? 1) * MINUTE;
  if (perPointHistory > 0 && t > end - perPointHistory && moved.length === 0) return out('flat', 0, { basis: 'flows' });

  const whp = workspaceWhpPerDayM(snapshot.flows ?? []);
  const flatBelow = opts.flatBelow ?? 0.01;
  const { prev, next } = neighbours(commit, snapshot.timeline ?? [], t);
  const price = (basis: ImpactBasis, delta: number | undefined): CommitImpact | undefined => {
    if (delta === undefined || !Number.isFinite(delta)) return undefined;
    if (Math.abs(delta) < flatBelow || whp <= 0) return out('flat', 0, { basis, ratioDelta: delta });
    return out('priced', Math.round(delta * whp), { basis, ratioDelta: delta });
  };

  if (t >= end - DAY) {
    const ws = price('workspace', workspaceShift(snapshot.ratioSeries ?? [], t, prev, next, end));
    if (ws) return ws;
  }
  if (t >= end - 7 * DAY && opts.timeZone) {
    const others = (snapshot.timeline ?? []).filter((c) => !sameHash(c.hash, commit.hash)).map(commitTimeMs);
    const daily = price('daily', dailyShift(snapshot.trend ?? [], t, others, opts.timeZone));
    if (daily) return daily;
  }
  return out('unpriced');
}

export interface ImpactsOptions extends ImpactOptions {
  /** how far back to list commits, in days (the Ledger's "Changes" list: 7) */
  days?: number;
}

/**
 * Every commit of the last `days` (default 7) priced, for the Ledger's "Changes" list: priced commits by |$/day|
 * (biggest first), then the measured-but-flat ones, then those nothing could price — each group newest first
 * on ties.
 */
export function commitImpacts(snapshot: ImpactSnapshot | null | undefined, opts: ImpactsOptions = {}): CommitImpact[] {
  if (!snapshot) return [];
  const end = snapshotEnd(snapshot);
  const from = end - (opts.days ?? 7) * DAY;
  const seen = new Set<string>();
  const rank: Record<ImpactStatus, number> = { priced: 0, flat: 1, unpriced: 2 };
  return (snapshot.timeline ?? [])
    .filter((c) => {
      const t = commitTimeMs(c);
      if (!Number.isFinite(t) || t < from || t > end) return false;
      const id = c.hash.slice(0, 7);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((c) => priceCommit(c, snapshot, opts))
    .sort((a, b) => rank[a.status] - rank[b.status] || Math.abs(b.perDayM) - Math.abs(a.perDayM) || b.t - a.t);
}

/**
 * Bases that tie the dollars to the commit itself: an alert that names it, or flows whose own per-minute history
 * moved after it. 'workspace' and 'daily' measure the whole workspace's shift around the commit's time: an honest
 * "unattributed shift" line in the Changes list, never a headline that credits or blames the commit's author.
 */
export const ATTRIBUTED_BASES: readonly ImpactBasis[] = ['alert', 'flows'];

/** Whether a priced impact is the commit's own (ATTRIBUTED_BASES), not a workspace-wide shift near it. */
export function isAttributedImpact(i: Pick<CommitImpact, 'status' | 'basis'>): boolean {
  return i.status === 'priced' && i.basis !== undefined && ATTRIBUTED_BASES.includes(i.basis);
}

/**
 * The priced commit with the largest |$/day| whose effect time falls inside `domain`: the headline the Receipt's
 * 30-day trend and the Ledger's change timeline print beside the commit's hash and author. Only an attributed
 * price qualifies (isAttributedImpact): a 'daily' or 'workspace' figure gives one commit the whole workspace's
 * day-over-day shift (a destination batch-size change cannot move billed GB), so it never headlines. Nor does a break
 * whose alert recovered, or the revert it recovered after: the pair nets to zero (rules round 2).
 */
export function largestImpact(impacts: readonly CommitImpact[], domain: [number, number]): CommitImpact | undefined {
  let best: CommitImpact | undefined;
  for (const i of impacts) {
    if (!isAttributedImpact(i) || i.perDayM === 0 || i.t < domain[0] || i.t > domain[1]) continue;
    // A break whose alert recovered, and the revert it recovered after, net out: neither is the headline (rules round 2).
    if (i.recovered || i.reverts) continue;
    if (!best || Math.abs(i.perDayM) > Math.abs(best.perDayM)) best = i;
  }
  return best;
}
