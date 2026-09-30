// core/detector.ts — baselines and rules (SPEC 9.3): detect and describe, never act.
// One pass per evaluated minute. Rules count CONSECUTIVE qualifying minutes, persisted in
// baselines.rules keyed `${type}|${objectKey}`; one open incident per (type, objectKey).
//   spike      (inputs, $/hour paid)   x > mean + σ·k AND x − mean ≥ min $/hour, N minutes → high (medium under
//                                       2× the mean); σ floored, learns while open, closes as the new normal (P1-F06)
//   regression (routes/pipelines)      (frozen baseline − ratio) ≥ P points, N minutes → high with a
//                                       commit in the window, else medium / cause 'unknown'
//   budget     (outputs)               projected month ≥ warn/alert % of budget → medium/high
//   goodnews   (routes/pipelines)      ratio rises ≥ P points, N minutes, AND a commit → info (opt-in)
// Muted objects are not learned from and open nothing, but an incident already open on them can still recover.
// P1-F07: an object excluded or muted by a member closes its open incident (closedReason); acceptIncident
// (core/incidents.ts) closes one as the new normal and re-seats the baseline at the level it accepted.

import type { Baseline, BaselinesDoc, Commit, CommitRef, Incident, InventoryDoc, ISO, ObjectKey, RuleState, Settings, Severity, Thresholds } from './types.ts';
import { emptyBaseline, isWarm, sigma, updateBaseline } from './baseline.ts';
import { commitTimeMs, matchCommit } from './timeline.ts';
import { RECOVERY_POINTS, incidentId, severityRank } from './incidents.ts';
import { parseObjectKey } from './flows.ts';
import { MINUTE_MS, daysInMonth, fromIso, minuteFloor, toIso } from './time.ts';
import { budgetPace } from './pricing.ts';
import { demoSettleOn, goodNewsActive } from './settings.ts';

export const DEMO_PROFILE_NOTE = 'demo-profile';
/** Recovery band for regressions: back within this many points of the frozen baseline (defined with the readings it shapes). */
export { RECOVERY_POINTS };
/** Budget pace is re-evaluated hourly outside the demo profile. */
export const BUDGET_INTERVAL_MS = 60 * MINUTE_MS;

// ─── Cost-spike learning (P1-F06) ────────────────────────────────────────────
/** The spike rule's σ is never below this share of the mean … */
export const SPIKE_SIGMA_FLOOR_SHARE = 0.15;
/** … nor below $1/hour (millicents/hour): a flat baseline (σ = 0) never makes every wobble a spike. */
export const SPIKE_SIGMA_FLOOR_M = 100_000;
/** Qualifying and open minutes still feed the baseline, at this share of α: it learns a lasting level, slowly. */
export const SPIKE_OPEN_WEIGHT = 0.25;
/** An open spike whose readings have held one level this long closes as the new normal (note NEW_NORMAL_NOTE). */
export const SPIKE_NEW_NORMAL_MINUTES = 60;
/** A reading is "at the level" within 10 % of it (or SPIKE_SIGMA_FLOOR_M) — a ramp still climbing is not a level; this many misses in a row restart it. */
export const SPIKE_LEVEL_BAND = 0.1;
export const SPIKE_LEVEL_MISSES = 3;
/** Under this multiple of the baseline a spike is medium; at or over it, high. */
export const SPIKE_HIGH_MULTIPLE = 2;
/** Outside the demo profile a spike opens at most once per object in this window (an hourly batch pages once a day). */
export const SPIKE_REPEAT_MS = 24 * 60 * MINUTE_MS;
export const NEW_NORMAL_NOTE = 'new-normal';

/**
 * Founder-build r1 (FOUNDER_PLAN row 9, PACK_PAYOFF F1/F2): under the demo profile (1-minute confirmation), a good-news
 * minute that starts less than this long after its commit's deploy is the Worker reload's transitional minute (Sunday:
 * the deploy at 12:39:50 read 19 % on 12:40, settled at 34 % from 12:41). It does not fire: the frozen baseline is kept,
 * the streak restarts and the minute is not learned; the first qualifying minute starting at least this long after
 * the deploy fires with that minute's reading. `settings.demo.settle: false` turns it off (demoSettleOn).
 */
export const SETTLE_MS = 60_000;

/** The σ the spike rule uses: the learned σ, floored at 15 % of the mean and $1/hour (P1-F06). */
export function spikeSigma(b: Baseline | undefined, mean = b?.mean ?? 0): number {
  return Math.max(sigma(b), SPIKE_SIGMA_FLOOR_SHARE * Math.abs(mean), SPIKE_SIGMA_FLOOR_M);
}

/** The demo profile applies while demo mode is on and its profile switch is set (SPEC 5, 9.3). */
export function isDemoProfile(settings: Pick<Settings, 'demo'>): boolean {
  return settings.demo?.enabled === true && settings.demo?.profile === true;
}

/** Stored thresholds, with the demo profile's 1-minute confirmation and recovery overriding them (stored values untouched). */
/** DECISIONS D26 default: $5/day. */
export const DEFAULT_REGRESSION_MIN_CENTS_PER_DAY = 500;

export function effectiveThresholds(settings: Pick<Settings, 'thresholds' | 'demo'>): Thresholds {
  const t = { ...settings.thresholds };
  if (isDemoProfile(settings)) {
    t.regressionMinutes = 1;
    t.spikeMinutes = 1;
    t.recoveryMinutes = 1;
  }
  return t;
}

/** Budget pace runs every sweep under the demo profile, otherwise at most hourly. */
export function shouldEvaluateBudget(baselines: Pick<BaselinesDoc, 'budgetEvaluatedAt'> | undefined, nowMs: number, settings: Pick<Settings, 'demo'>): boolean {
  if (isDemoProfile(settings)) return true;
  const last = baselines?.budgetEvaluatedAt ? fromIso(baselines.budgetEvaluatedAt) : Number.NaN;
  return Number.isNaN(last) || nowMs - last >= BUDGET_INTERVAL_MS;
}

export function emptyBaselines(nowIso: ISO): BaselinesDoc {
  return { schemaVersion: 1, updatedAt: nowIso, byObject: {}, rules: {} };
}

export interface RatioPoint {
  /** the minute's savings ratio; null when the object had no traffic (not fed, streaks untouched) */
  x: number | null;
  /** would-have-paid per day for the object (dollar impact) */
  whpPerDayM: number;
  label: string;
  outputId?: string;
}
export interface CostPoint {
  /** paid $/hour in millicents (Σ paidM of the input's flows × 60); a silent minute is 0 */
  x: number;
  label: string;
  outputId?: string;
}
export interface BudgetPoint {
  paidMtdM: number;
  budgetCentsPerMonth: number;
  label: string;
}

export interface DetectInput {
  /** evaluation time: incidents open at this instant (for a backfilled minute, that minute's end) */
  nowMs: number;
  /** start of the minute being evaluated; defaults to the last completed minute before nowMs */
  minuteStartMs?: number;
  settings: Settings;
  baselines: BaselinesDoc;
  openIncidents: Incident[];
  /** route objects 'route:<gid>:<routeId>' (pipeline objects 'pipe:…' work the same way) */
  ratioSeries: Record<ObjectKey, RatioPoint>;
  /** input objects 'in:<gid>:<inputId>' */
  costSeries: Record<ObjectKey, CostPoint>;
  /** output objects 'out:<gid>:<outputId>' */
  budgetSeries: Record<ObjectKey, BudgetPoint>;
  /** objectKey → ISO until (demo:state.muted) */
  muted: Record<ObjectKey, ISO>;
  /** the change timeline, all groups */
  commits: Commit[];
  inventory?: InventoryDoc;
  /** evaluate budget pace this pass (see shouldEvaluateBudget) */
  evaluateBudget: boolean;
  /**
   * P0-17: minutes metered this local month (core/pricing meteredMinutesInMonth over the running totals) — the
   * minutes `paidMtdM` was paid over, so the projection is the real pace. Absent: elapsed time from the later of
   * the month's start and `collectingSinceMs`.
   */
  budgetMinutesMtd?: number;
  collectingSinceMs?: number;
  /**
   * Seeded history (core/sweep.ts: a minute before the first price was ever saved, metered by the first-run backfill):
   * the baselines learn from it, no rule counts and nothing opens. Nobody was asking for alerts yet, and a fresh
   * install should not page about two days it has only just read.
   */
  learnOnly?: boolean;
}

export interface DetectOutput {
  baselines: BaselinesDoc;
  opened: Incident[];
  updated: Incident[];
  closed: Incident[];
  /** ids of regressions just opened with cause 'unknown': refresh the timeline once and rematchIncidents */
  unmatchedRegressions: string[];
}

/**
 * The route/pipeline ids that commit matching needs for an object; for a route also its name and filter, which
 * confirm that a route-table commit changed this route's entry (core/timeline.ts routeEntryChanged).
 */
export function objectContext(
  key: ObjectKey,
  inventory?: InventoryDoc,
): { pipelineId?: string; routeId?: string; routeName?: string; routeFilter?: string } {
  const p = parseObjectKey(key);
  if (!p) return {};
  const routes = inventory?.byGroup?.[p.groupId]?.routes ?? [];
  if (p.kind === 'route') {
    const r = routes.find((x) => x.id === p.id);
    return {
      routeId: p.id,
      pipelineId: r?.pipeline,
      ...(typeof r?.name === 'string' ? { routeName: r.name } : {}),
      ...(typeof r?.filter === 'string' ? { routeFilter: r.filter } : {}),
    };
  }
  if (p.kind === 'pipe') return { pipelineId: p.id, routeId: routes.find((r) => r.pipeline === p.id)?.id };
  return {};
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const round1 = (x: number): number => Math.round(x * 10) / 10;
const secondsBetween = (fromMs: number, toMs: number): number => Math.max(0, Math.round((toMs - fromMs) / 1000));

/** Runs every rule for one evaluated minute. Pure: returns the new baselines and incident changes. */
export function detect(input: DetectInput): DetectOutput {
  const { settings, nowMs } = input;
  const th = effectiveThresholds(settings);
  const demoProfile = isDemoProfile(settings);
  const nowIso = toIso(nowMs);
  const minuteStart = input.minuteStartMs ?? minuteFloor(nowMs) - MINUTE_MS;
  const windowMs = th.regressionCommitWindowMin * MINUTE_MS;
  const notes = (): string[] => (demoProfile ? [DEMO_PROFILE_NOTE] : []);
  const commits = input.commits ?? [];

  const byObject = { ...(input.baselines?.byObject ?? {}) };
  const rules: Record<string, RuleState> = { ...(input.baselines?.rules ?? {}) };
  let budgetEvaluatedAt = input.baselines?.budgetEvaluatedAt;

  const open = new Map<string, Incident>();
  for (const i of input.openIncidents ?? []) if (!i.closedAt) open.set(`${i.type}|${i.objectKey}`, i);
  const excluded = new Set(settings.excludedObjectKeys ?? []);
  /** P1-F07: a member's mute (settings.mutes, "Mute for 24 hours"), while it lasts. */
  const memberMute = (key: ObjectKey): { until: ISO; by?: string } | undefined => {
    const m = settings.mutes?.[key];
    return m && fromIso(m.until) > nowMs ? m : undefined;
  };
  // Muting (SPEC 7 step 14, 11) suppresses learning and new detections, never recovery: Restore mutes
  // the object it fixes, and its open regression must still close itself on the next clean minute.
  const isMuted = (key: ObjectKey): boolean => {
    const until = input.muted?.[key];
    return (until !== undefined && fromIso(until) > nowMs) || memberMute(key) !== undefined;
  };

  const opened: Incident[] = [];
  const updated: Incident[] = [];
  const closed: Incident[] = [];
  const unmatchedRegressions: string[] = [];
  /** The rule state an object keeps between spikes: when its last spike opened, while that is inside the repeat window. */
  const between = (openedAt: ISO | undefined): RuleState | undefined => {
    const at = openedAt ? fromIso(openedAt) : Number.NaN;
    return Number.isFinite(at) && nowMs - at < SPIKE_REPEAT_MS ? { streak: 0, recoveryStreak: 0, lastOpenedAt: openedAt } : undefined;
  };
  const setRule = (k: string, rs: RuleState | undefined): void => {
    if (rs) rules[k] = rs;
    else if (k in rules) delete rules[k];
  };

  // P1-F07: an open incident on an object nobody wants to hear about closes here, or it would re-notify every
  // cooldown forever — an object left out in Settings → Alerts (the card's "Stop alerting on this" writes the same
  // list) or muted by a member. The card's actions close it at once; this closes one whose close met a busy lock,
  // and one excluded from Settings. A demo mute is not a member's: Restore's regression still recovers by itself.
  for (const [k, inc] of [...open]) {
    const mute = excluded.has(inc.objectKey) ? undefined : memberMute(inc.objectKey);
    if (!excluded.has(inc.objectKey) && !mute) continue;
    const reason = excluded.has(inc.objectKey) ? ('excluded' as const) : ('muted' as const);
    closed.push({ ...inc, closedAt: nowIso, closedReason: reason, ...(mute?.by ? { closedBy: mute.by } : {}) });
    open.delete(k);
    setRule(k, inc.type === 'spike' ? between(inc.openedAt) : undefined);
  }
  const feed = (key: ObjectKey, x: number): void => {
    byObject[key] = updateBaseline(byObject[key] ?? emptyBaseline(), x, th.ewmaAlpha, th.warmupSamples);
  };
  const fresh = (): RuleState => ({ streak: 0, recoveryStreak: 0 });

  if (input.learnOnly) {
    // Seeded history: learn the level every rule will judge against, count and open nothing (DetectInput.learnOnly).
    for (const [key, pt] of Object.entries(input.ratioSeries ?? {})) {
      if (excluded.has(key) || isMuted(key) || pt.x === null || !Number.isFinite(pt.x)) continue;
      feed(key, clamp01(pt.x));
    }
    for (const [key, pt] of Object.entries(input.costSeries ?? {})) {
      if (excluded.has(key) || isMuted(key)) continue;
      const x = Number.isFinite(pt.x) ? pt.x : 0;
      // As in the rule below: warm up on minutes with traffic only.
      if (x > 0 || isWarm(byObject[key], th.warmupSamples)) feed(key, x);
    }
    const learned: BaselinesDoc = { schemaVersion: 1, updatedAt: nowIso, byObject, rules };
    if (budgetEvaluatedAt !== undefined) learned.budgetEvaluatedAt = budgetEvaluatedAt;
    return { baselines: learned, opened, updated, closed, unmatchedRegressions };
  }

  // ── Ratio objects: regression, good news ──────────────────────────────────
  for (const [key, pt] of Object.entries(input.ratioSeries ?? {})) {
    if (excluded.has(key) || pt.x === null || !Number.isFinite(pt.x)) continue;
    const x = clamp01(pt.x);
    const regKey = `regression|${key}`;
    const goodKey = `goodnews|${key}`;

    const openReg = open.get(regKey);
    if (openReg) {
      // Baseline frozen while open; recovery = back within 5 points of the frozen baseline for N minutes.
      const rs = { ...(rules[regKey] ?? fresh()) };
      const baselineRatio = rs.frozenBaseline ?? openReg.before;
      // D26 applies to open incidents too: a drop that is no longer worth the alert floor (the flow got
      // cheap, or it opened before the floor existed) closes itself instead of sitting open forever.
      const floorM = (th.regressionMinCentsPerDay ?? DEFAULT_REGRESSION_MIN_CENTS_PER_DAY) * 1000;
      const whpNow = pt.whpPerDayM || 0;
      const belowFloor = whpNow > 0 && (baselineRatio - x) * whpNow < floorM;
      const inBand = (baselineRatio - x) * 100 <= RECOVERY_POINTS;
      rs.recoveryStreak = inBand || belowFloor ? rs.recoveryStreak + 1 : 0;
      if (rs.recoveryStreak >= th.recoveryMinutes) {
        // D47: the close keeps the drop (`after`, `impactPerDayM`). A recovery records where it recovered to;
        // a below-floor close (the streak's only other way in) recovered nowhere — the ratio is still far
        // under the baseline, the flow just got cheap — so it takes the note and no `recoveredTo`, and every
        // reader shows its drop with no "back to" figure.
        closed.push(inBand ? { ...openReg, closedAt: nowIso, recoveredTo: x } : { ...openReg, closedAt: nowIso, notes: [...openReg.notes, 'below-floor'] });
        delete rules[regKey];
      } else {
        rules[regKey] = rs;
        // D45: a deploy that lands mid-minute opens on a partial drop; while the ratio keeps falling the
        // open incident deepens (`after` and the $/day impact track the settled drop; `before` stays
        // frozen). Delivery is unchanged: same severity inside the cooldown means no re-notification.
        if (x < openReg.after - 0.005) {
          const impact = Math.max(openReg.impactPerDayM, Math.max(0, Math.round((baselineRatio - x) * whpNow)));
          updated.push({ ...openReg, after: x, impactPerDayM: impact });
        }
      }
      continue;
    }
    if (isMuted(key)) continue;

    const b = byObject[key];
    if (!isWarm(b, th.warmupSamples)) {
      feed(key, x);
      continue;
    }
    const mean = b!.mean;
    const ctx = objectContext(key, input.inventory);
    let counting = false;

    const rs = { ...(rules[regKey] ?? fresh()) };
    const regBase = rs.streak > 0 && rs.frozenBaseline !== undefined ? rs.frozenBaseline : mean;
    // D26: the drop must also be worth money: a 30-point drop on a $1/day archive flow never pages.
    const regMinM = (th.regressionMinCentsPerDay ?? DEFAULT_REGRESSION_MIN_CENTS_PER_DAY) * 1000;
    const whpPerDay = pt.whpPerDayM || 0; // unknown per-day figures: the dollar floor can't be judged, skip it
    const regQualifies = (regBase - x) * 100 >= th.regressionPoints && (whpPerDay <= 0 || (regBase - x) * whpPerDay >= regMinM);
    if (regQualifies) {
      counting = true;
      if (rs.streak === 0) {
        rs.frozenBaseline = mean;
        rs.firstQualifyingAt = toIso(minuteStart);
      }
      rs.streak += 1;
      if (rs.streak >= th.regressionMinutes) {
        const baselineRatio = rs.frozenBaseline ?? mean;
        const firstMs = fromIso(rs.firstQualifyingAt ?? toIso(minuteStart));
        const commit = matchCommit(commits, key, { sinceMs: firstMs - windowMs, untilMs: nowMs, ...ctx });
        const inc: Incident = {
          id: incidentId('regression', key, nowMs),
          type: 'regression',
          severity: commit ? 'high' : 'medium',
          objectKey: key,
          label: pt.label,
          openedAt: nowIso,
          cause: commit ? 'commit' : 'unknown',
          before: baselineRatio,
          after: x,
          impactPerDayM: Math.max(0, Math.round((baselineRatio - x) * (pt.whpPerDayM || 0))),
          caughtInSec: commit ? secondsBetween(commitTimeMs(commit), nowMs) : secondsBetween(firstMs, nowMs),
          notes: notes(),
          deliveries: [],
        };
        if (pt.outputId !== undefined) inc.outputId = pt.outputId;
        if (commit) inc.commit = commit;
        else unmatchedRegressions.push(inc.id);
        opened.push(inc);
        // Keep the frozen baseline for the recovery rule.
        rules[regKey] = { streak: 0, recoveryStreak: 0, frozenBaseline: baselineRatio, firstQualifyingAt: rs.firstQualifyingAt };
      } else {
        rules[regKey] = rs;
      }
    } else if (rules[regKey]) {
      delete rules[regKey];
    }

    if (goodNewsActive(settings) && !regQualifies && !open.has(goodKey)) {
      const gs = { ...(rules[goodKey] ?? fresh()) };
      const goodBase = gs.streak > 0 && gs.frozenBaseline !== undefined ? gs.frozenBaseline : mean;
      if ((x - goodBase) * 100 >= th.goodNewsPoints) {
        if (gs.streak === 0) {
          gs.frozenBaseline = mean;
          gs.firstQualifyingAt = toIso(minuteStart);
        }
        gs.streak += 1;
        counting = true;
        rules[goodKey] = gs;
        if (gs.streak >= th.regressionMinutes) {
          const firstMs = fromIso(gs.firstQualifyingAt ?? toIso(minuteStart));
          const commit = matchCommit(commits, key, { sinceMs: firstMs - windowMs, untilMs: nowMs, ...ctx });
          if (commit && demoProfile && demoSettleOn(settings) && minuteStart - commitTimeMs(commit) < SETTLE_MS) {
            // Row 9: the deploy's transitional minute. Keep the frozen baseline, restart the streak, and keep counting
            // (so the baseline never learns this minute); the first minute that starts ≥ SETTLE_MS after the deploy fires.
            rules[goodKey] = { ...gs, streak: 0 };
            continue;
          }
          delete rules[goodKey];
          if (commit) {
            // One-shot: the improvement is announced once and becomes the new normal (re-learned).
            const before = gs.frozenBaseline ?? mean;
            const inc: Incident = {
              id: incidentId('goodnews', key, nowMs),
              type: 'goodnews',
              severity: 'info',
              objectKey: key,
              label: pt.label,
              openedAt: nowIso,
              closedAt: nowIso,
              cause: 'commit',
              commit,
              before,
              after: x,
              impactPerDayM: Math.max(0, Math.round((x - before) * (pt.whpPerDayM || 0))),
              caughtInSec: secondsBetween(commitTimeMs(commit), nowMs),
              notes: notes(),
              deliveries: [],
            };
            if (pt.outputId !== undefined) inc.outputId = pt.outputId;
            opened.push(inc);
            byObject[key] = emptyBaseline();
            continue;
          }
          // No commit behind it: not good news, just drift — let the baseline absorb it.
          counting = false;
        }
      } else if (rules[goodKey]) {
        delete rules[goodKey];
      }
    }

    if (!counting) feed(key, x);
  }

  // ── Input objects: cost spike ─────────────────────────────────────────────
  // P1-F06: the rule learns. σ is floored (15 % of the mean, $1/hour) so a flat baseline never turns every wobble
  // into a spike; warm-up counts minutes with traffic only, so a Source that starts sending warms up on its own
  // level; qualifying and open minutes still feed the baseline at a quarter of α; an open spike whose readings hold
  // one level for SPIKE_NEW_NORMAL_MINUTES closes as the new normal and the baseline is re-seated there; under 2× the
  // baseline a spike is medium (escalated to high if it grows past 2×); outside the demo profile an object opens at
  // most one spike per 24 h, so an hourly batch pages once a day, not every hour.
  const minDeltaM = th.spikeMinCentsPerHour * 1000;
  const feedSlowly = (key: ObjectKey, x: number): void => {
    byObject[key] = updateBaseline(byObject[key] ?? emptyBaseline(), x, th.ewmaAlpha * SPIKE_OPEN_WEIGHT, th.warmupSamples);
  };
  for (const [key, pt] of Object.entries(input.costSeries ?? {})) {
    if (excluded.has(key)) continue;
    const x = Number.isFinite(pt.x) ? pt.x : 0;
    const spikeKey = `spike|${key}`;
    const b = byObject[key];

    const openSpike = open.get(spikeKey);
    if (openSpike) {
      const rs = { ...(rules[spikeKey] ?? fresh()) };
      const before = rs.frozenBaseline ?? openSpike.before;
      const muted = isMuted(key);
      rs.recoveryStreak = x <= before + spikeSigma(b, before) ? rs.recoveryStreak + 1 : 0;
      if (rs.recoveryStreak >= th.recoveryMinutes) {
        closed.push({ ...openSpike, closedAt: nowIso, recoveredTo: x });
        setRule(spikeKey, between(openSpike.openedAt));
        if (!muted) feedSlowly(key, x);
        continue;
      }
      // The level the readings hold: the mean of the current run of readings within ±10 % of it (a few stray
      // minutes are forgiven; SPIKE_LEVEL_MISSES in a row start a new run).
      const band = (level: number): number => Math.max(SPIKE_LEVEL_BAND * Math.abs(level), SPIKE_SIGMA_FLOOR_M);
      if (rs.level === undefined || !(rs.levelMinutes && rs.levelMinutes > 0)) {
        rs.level = x;
        rs.levelMinutes = 1;
        rs.levelMisses = 0;
      } else if (Math.abs(x - rs.level) <= band(rs.level)) {
        const n = rs.levelMinutes + 1;
        rs.level += (x - rs.level) / n;
        rs.levelMinutes = n;
        rs.levelMisses = 0;
      } else if ((rs.levelMisses ?? 0) + 1 >= SPIKE_LEVEL_MISSES) {
        rs.level = x;
        rs.levelMinutes = 1;
        rs.levelMisses = 0;
      } else {
        rs.levelMisses = (rs.levelMisses ?? 0) + 1;
      }
      if (!muted && rs.levelMinutes >= SPIKE_NEW_NORMAL_MINUTES) {
        // The new normal: nothing recovered (no `recoveredTo`); the drop-in reading stays as `after`. The baseline
        // is re-seated at the level, so the next minute at it is ordinary, not a fresh spike.
        closed.push({ ...openSpike, closedAt: nowIso, notes: [...openSpike.notes, NEW_NORMAL_NOTE] });
        byObject[key] = { mean: rs.level, variance: b?.variance ?? 0, samples: Math.max(b?.samples ?? 0, th.warmupSamples), warm: [] };
        setRule(spikeKey, between(openSpike.openedAt));
        continue;
      }
      rules[spikeKey] = rs;
      if (!muted) feedSlowly(key, x);
      if (openSpike.severity === 'medium' && before > 0 && x >= SPIKE_HIGH_MULTIPLE * before) {
        updated.push({
          ...openSpike,
          severity: 'high',
          after: Math.max(openSpike.after, x),
          impactPerDayM: Math.max(openSpike.impactPerDayM, Math.round((x - before) * 24)),
        });
      }
      continue;
    }
    if (isMuted(key)) continue;
    if (!isWarm(b, th.warmupSamples)) {
      // Warm up on minutes with traffic: an idle Source's zeros would make its first hour of real data a spike.
      if (x > 0) feed(key, x);
      continue;
    }
    const mean = b!.mean;
    const sd = spikeSigma(b);
    const prior = rules[spikeKey];
    if (x > mean + th.spikeSigma * sd && x - mean >= minDeltaM) {
      feedSlowly(key, x);
      // One spike per object per 24 h outside the demo profile: a repeat (an hourly batch) is learned, not paged.
      if (!demoProfile && between(prior?.lastOpenedAt)) continue;
      const rs = { ...(prior ?? fresh()) };
      if (rs.streak === 0) {
        rs.frozenBaseline = mean;
        rs.firstQualifyingAt = toIso(minuteStart);
      }
      rs.streak += 1;
      if (rs.streak >= th.spikeMinutes) {
        const before = rs.frozenBaseline ?? mean;
        const firstMs = fromIso(rs.firstQualifyingAt ?? toIso(minuteStart));
        const found = matchCommit(commits, key, { sinceMs: firstMs - windowMs, untilMs: nowMs });
        // Traffic spikes are usually organic: only a commit that names or touches the input counts.
        const commit: CommitRef | undefined = found && found.match !== 'nearby' ? found : undefined;
        const inc: Incident = {
          id: incidentId('spike', key, nowMs),
          type: 'spike',
          // Under twice the baseline the money moved, but not dramatically: a warning, not a page.
          severity: before > 0 && x < SPIKE_HIGH_MULTIPLE * before ? 'medium' : 'high',
          objectKey: key,
          label: pt.label,
          openedAt: nowIso,
          cause: commit ? 'commit' : 'unknown',
          before,
          after: x,
          impactPerDayM: Math.max(0, Math.round((x - before) * 24)),
          caughtInSec: commit ? secondsBetween(commitTimeMs(commit), nowMs) : secondsBetween(firstMs, nowMs),
          notes: notes(),
          deliveries: [],
        };
        if (pt.outputId !== undefined) inc.outputId = pt.outputId;
        if (commit) inc.commit = commit;
        opened.push(inc);
        rules[spikeKey] = { streak: 0, recoveryStreak: 0, frozenBaseline: before, firstQualifyingAt: rs.firstQualifyingAt, lastOpenedAt: nowIso };
      } else {
        rules[spikeKey] = rs;
      }
      continue;
    }
    setRule(spikeKey, between(prior?.lastOpenedAt));
    feed(key, x);
  }

  // ── Output objects: budget pace ───────────────────────────────────────────
  if (input.evaluateBudget) {
    budgetEvaluatedAt = nowIso;
    const tz = settings.displayTimezone || 'UTC';
    const monthDays = daysInMonth(nowMs, tz);
    for (const [key, pt] of Object.entries(input.budgetSeries ?? {})) {
      if (excluded.has(key)) continue;
      const budgetM = pt.budgetCentsPerMonth * 1000;
      if (!(budgetM > 0)) continue;
      // P0-17: the same projection Settings → Budgets and the snapshot show, over the minutes actually metered.
      const pace = budgetPace({
        paidMtdM: pt.paidMtdM,
        budgetCentsPerMonth: pt.budgetCentsPerMonth,
        nowMs,
        tz,
        meteredMinutes: input.budgetMinutesMtd,
        collectingSinceMs: input.collectingSinceMs,
      });
      if (!(pace.elapsedMin >= 1)) continue;
      const { projectedM } = pace;
      const pct = pace.pct ?? 0;
      // Outside the demo profile a projection must rest on a day of metering before it opens or escalates
      // anything, and on three days before it pages (high); recovery is always judged.
      const mayAlert = demoProfile || pace.settled;
      let severity: Severity | undefined = pct >= th.budgetAlertPct ? 'high' : pct >= th.budgetWarnPct ? 'medium' : undefined;
      if (severity === 'high' && !demoProfile && pace.early) severity = 'medium';
      const impactPerDayM = Math.max(0, Math.round((projectedM - budgetM) / monthDays));
      const threshold = severity === 'high' ? th.budgetAlertPct : th.budgetWarnPct;
      const openBudget = open.get(`budget|${key}`);
      if (openBudget) {
        if (pct < th.budgetWarnPct - 5) {
          closed.push({ ...openBudget, closedAt: nowIso, recoveredTo: round1(pct) });
        } else if (mayAlert && severity && severityRank(severity) > severityRank(openBudget.severity) && !isMuted(key)) {
          updated.push({ ...openBudget, severity, before: threshold, after: round1(pct), impactPerDayM });
        }
        continue;
      }
      if (!mayAlert || !severity || isMuted(key)) continue;
      const inc: Incident = {
        id: incidentId('budget', key, nowMs),
        type: 'budget',
        severity,
        objectKey: key,
        label: pt.label,
        openedAt: nowIso,
        before: threshold,
        after: round1(pct),
        impactPerDayM,
        notes: notes(),
        deliveries: [],
      };
      const p = parseObjectKey(key);
      if (p?.kind === 'out') inc.outputId = p.id;
      opened.push(inc);
    }
  }

  const baselines: BaselinesDoc = { schemaVersion: 1, updatedAt: nowIso, byObject, rules };
  if (budgetEvaluatedAt !== undefined) baselines.budgetEvaluatedAt = budgetEvaluatedAt;
  return { baselines, opened, updated, closed, unmatchedRegressions };
}

/**
 * After a timeline refresh: open regressions (and spikes) with cause 'unknown' get another match
 * attempt over [first qualifying minute − window, openedAt]. A match upgrades cause → 'commit',
 * severity medium → high (regressions), and recomputes caughtInSec from the deploy.
 */
export function rematchIncidents(
  incidents: Incident[],
  commits: Commit[],
  inventory: InventoryDoc | undefined,
  windowMin: number,
): { incidents: Incident[]; upgraded: string[] } {
  const upgraded: string[] = [];
  const out = incidents.map((inc) => {
    if (inc.closedAt || inc.cause === 'commit' || (inc.type !== 'regression' && inc.type !== 'spike')) return inc;
    const openedMs = fromIso(inc.openedAt);
    if (Number.isNaN(openedMs)) return inc;
    // Unmatched incidents carry caughtInSec = openedAt − first qualifying minute.
    const firstMs = openedMs - (inc.caughtInSec ?? 0) * 1000;
    const found = matchCommit(commits, inc.objectKey, { sinceMs: firstMs - windowMin * MINUTE_MS, untilMs: openedMs, ...objectContext(inc.objectKey, inventory) });
    const commit = inc.type === 'spike' && found?.match === 'nearby' ? undefined : found;
    if (!commit) return inc;
    upgraded.push(inc.id);
    return {
      ...inc,
      cause: 'commit' as const,
      commit,
      severity: inc.type === 'regression' && inc.severity === 'medium' ? ('high' as const) : inc.severity,
      caughtInSec: secondsBetween(commitTimeMs(commit), openedMs),
    };
  });
  return { incidents: out, upgraded };
}
