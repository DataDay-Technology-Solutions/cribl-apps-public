import { describe, expect, it } from 'vitest';
import type { BaselinesDoc, Commit, Incident, InventoryDoc, Settings } from '../../core/types.ts';
import {
  DEMO_PROFILE_NOTE,
  detect,
  effectiveThresholds,
  emptyBaselines,
  isDemoProfile,
  objectContext,
  rematchIncidents,
  shouldEvaluateBudget,
  type DetectInput,
  type DetectOutput,
} from '../../core/detector.ts';
import { defaultSettings } from '../../core/settings.ts';
import { budgetPace } from '../../core/pricing.ts';
import { budgetPace as settingsBudgetPace } from '../../src/views/Settings/model.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-09-26T15:00:05Z'); // a sweep 5 s after a minute boundary
const ROUTE = 'route:default:r_pay';
const INPUT = 'in:default:mrd_payments_api';
const OUTPUT = 'out:default:mrd_siem_prod';

const inventory: InventoryDoc = {
  schemaVersion: 1,
  updatedAt: '',
  hash: 'h',
  byGroup: {
    default: {
      inputs: [],
      outputs: [],
      pipelines: [],
      routes: [
        { id: 'r_pay', filter: "__inputId=='datagen:mrd_payments_api'", pipeline: 'mrd_pay_sample', output: 'mrd_siem_prod' },
        { id: 'r_ws', filter: "__inputId=='datagen:mrd_windows_workstations'", pipeline: 'mrd_passthrough', output: 'mrd_siem_prod' },
      ],
    },
  },
};

const settings = (over: Partial<Settings> = {}): Settings => ({ ...defaultSettings('2026-09-26T00:00:00.000Z', 'UTC'), ...over });
const demoSettings = (): Settings => settings({ demo: { enabled: true, replayMode: false, profile: true } });

/** A warm baseline at `mean` with a small variance. */
const warmBaselines = (entries: Record<string, number>, variance = 0.0001): BaselinesDoc => ({
  ...emptyBaselines('x'),
  byObject: Object.fromEntries(Object.entries(entries).map(([k, mean]) => [k, { mean, variance, samples: 500, warm: [] }])),
});

const commit = (hash: string, deployedMs: number, over: Partial<Commit> = {}): Commit => ({
  hash,
  message: `change ${hash}`,
  author: 's.koelpin',
  committedAt: new Date(deployedMs - 10_000).toISOString(),
  deployedAt: new Date(deployedMs).toISOString(),
  groupId: 'default',
  files: [],
  source: 'demo',
  ...over,
});

const trimCommit = (ms: number) =>
  commit('trim001', ms, { message: 'demo: break the trim on mrd_pay_sample', files: ['groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml'] });
const packCommit = (ms: number) =>
  commit('pack001', ms, { message: 'demo: apply the pack on r_ws', files: ['groups/default/local/cribl/pipelines/route.yml'] });

const base = (over: Partial<DetectInput>): DetectInput => ({
  nowMs: T0,
  settings: settings(),
  baselines: emptyBaselines('x'),
  openIncidents: [],
  ratioSeries: {},
  costSeries: {},
  budgetSeries: {},
  muted: {},
  commits: [],
  inventory,
  evaluateBudget: false,
  ...over,
});

/** Runs consecutive minutes, carrying baselines and open incidents like the sweep does. */
function run(
  start: DetectInput,
  minutes: { ratio?: number | null; cost?: number; paidMtdM?: number }[],
): { outs: DetectOutput[]; open: Incident[]; baselines: BaselinesDoc } {
  let baselines = start.baselines;
  let open = [...start.openIncidents];
  const outs: DetectOutput[] = [];
  minutes.forEach((m, i) => {
    const input: DetectInput = {
      ...start,
      nowMs: start.nowMs + i * MIN,
      baselines,
      openIncidents: open,
      ratioSeries: m.ratio !== undefined ? { [ROUTE]: { x: m.ratio, whpPerDayM: 10_000_000, label: 'Payments API sampling', outputId: 'mrd_siem_prod' } } : {},
      costSeries: m.cost !== undefined ? { [INPUT]: { x: m.cost, label: 'Payments API', outputId: 'mrd_siem_prod' } } : {},
      budgetSeries: m.paidMtdM !== undefined ? { [OUTPUT]: { paidMtdM: m.paidMtdM, budgetCentsPerMonth: 1_000_000, label: 'siem-prod' } } : {},
    };
    const out = detect(input);
    outs.push(out);
    baselines = out.baselines;
    const closedIds = new Set(out.closed.map((c) => c.id));
    open = [...open.filter((o) => !closedIds.has(o.id)).map((o) => out.updated.find((u) => u.id === o.id) ?? o), ...out.opened.filter((o) => !o.closedAt)];
  });
  return { outs, open, baselines };
}

describe('profiles and thresholds', () => {
  it('applies the demo profile only when demo mode and the profile are on', () => {
    expect(isDemoProfile(settings())).toBe(false);
    expect(isDemoProfile(settings({ demo: { enabled: true, replayMode: false, profile: false } }))).toBe(false);
    expect(isDemoProfile(demoSettings())).toBe(true);
    expect(effectiveThresholds(demoSettings())).toMatchObject({ regressionMinutes: 1, spikeMinutes: 1, recoveryMinutes: 1 });
    const s = demoSettings();
    effectiveThresholds(s);
    expect(s.thresholds.regressionMinutes).toBe(3); // stored value untouched
    expect(effectiveThresholds(settings())).toMatchObject({ regressionMinutes: 3, spikeMinutes: 2, recoveryMinutes: 5 });
  });
  it('evaluates budget hourly, or every sweep under the demo profile', () => {
    expect(shouldEvaluateBudget(undefined, T0, settings())).toBe(true);
    expect(shouldEvaluateBudget({ budgetEvaluatedAt: new Date(T0 - 30 * MIN).toISOString() }, T0, settings())).toBe(false);
    expect(shouldEvaluateBudget({ budgetEvaluatedAt: new Date(T0 - 60 * MIN).toISOString() }, T0, settings())).toBe(true);
    expect(shouldEvaluateBudget({ budgetEvaluatedAt: new Date(T0 - MIN).toISOString() }, T0, demoSettings())).toBe(true);
  });
  it('resolves object context from the inventory', () => {
    expect(objectContext(ROUTE, inventory)).toEqual({ routeId: 'r_pay', pipelineId: 'mrd_pay_sample', routeFilter: "__inputId=='datagen:mrd_payments_api'" });
    expect(objectContext('pipe:default:mrd_pay_sample', inventory)).toEqual({ pipelineId: 'mrd_pay_sample', routeId: 'r_pay' });
    expect(objectContext(INPUT, inventory)).toEqual({});
    expect(objectContext('junk')).toEqual({});
    expect(objectContext(ROUTE)).toEqual({ routeId: 'r_pay', pipelineId: undefined });
  });
});

describe('warm-up', () => {
  it('learns for warmupSamples minutes before any rule can fire', () => {
    const r = run(base({}), [...Array(10).fill({ ratio: 0.75 }), { ratio: 0.1 }, { ratio: 0.1 }, { ratio: 0.1 }]);
    expect(r.outs.slice(0, 10).every((o) => o.opened.length === 0)).toBe(true);
    expect(r.outs[9].baselines.byObject[ROUTE].samples).toBe(10);
    expect(r.outs[12].opened).toHaveLength(1);
    expect(r.outs[12].opened[0].before).toBeCloseTo(0.75, 10);
  });

  it('learnOnly (seeded history, before the first price): baselines learn, no rule counts, nothing opens', () => {
    const warm = warmBaselines({ [ROUTE]: 0.75, [INPUT]: 1_000_000 }, 10_000 ** 2);
    // A drop and a spike that would open a regression and a cost spike on live minutes …
    const seeded = run(base({ baselines: warm, settings: demoSettings(), learnOnly: true }), [
      { ratio: 0.2, cost: 9_000_000 },
      { ratio: 0.2, cost: 9_000_000 },
      { ratio: 0.2, cost: 9_000_000 },
    ]);
    expect(seeded.outs.every((o) => o.opened.length === 0 && o.updated.length === 0 && o.closed.length === 0)).toBe(true);
    expect(seeded.baselines.rules).toEqual(warm.rules);
    // … only move the learned level, as ordinary minutes would.
    expect(seeded.baselines.byObject[ROUTE].mean).toBeLessThan(0.75);
    expect(seeded.baselines.byObject[INPUT].mean).toBeGreaterThan(1_000_000);
    const live = run(base({ baselines: warm, settings: demoSettings() }), [{ ratio: 0.2 }]);
    expect(live.outs[0].opened).toHaveLength(1);
  });
});

describe('regression', () => {
  const warm = warmBaselines({ [ROUTE]: 0.75 });

  it('fires after regressionMinutes consecutive minutes with the baseline frozen at the first qualifying minute', () => {
    const r = run(base({ baselines: warm }), [{ ratio: 0.5 }, { ratio: 0.5 }, { ratio: 0.5 }]);
    expect(r.outs[0].opened).toEqual([]);
    expect(r.outs[1].opened).toEqual([]);
    const [inc] = r.outs[2].opened;
    expect(inc).toMatchObject({
      type: 'regression',
      severity: 'medium',
      cause: 'unknown',
      objectKey: ROUTE,
      label: 'Payments API sampling',
      outputId: 'mrd_siem_prod',
      before: 0.75,
      after: 0.5,
      impactPerDayM: 2_500_000, // 25 points × $100/day
      notes: [],
      deliveries: [],
    });
    expect(inc.id).toMatch(/^inc_[0-9a-f]{6}$/);
    expect(inc.openedAt).toBe(new Date(T0 + 2 * MIN).toISOString());
    // first qualifying minute started at 14:59:00 → opened 15:02:05
    expect(inc.caughtInSec).toBe(185);
    expect(r.outs[2].unmatchedRegressions).toEqual([inc.id]);
    // the baseline never absorbed the drop
    expect(r.baselines.byObject[ROUTE].mean).toBe(0.75);
  });

  it('resets the count on a non-qualifying minute and skips no-traffic minutes', () => {
    const r = run(base({ baselines: warm }), [{ ratio: 0.5 }, { ratio: 0.74 }, { ratio: 0.5 }, { ratio: null }, { ratio: 0.5 }, { ratio: 0.5 }]);
    expect(r.outs.slice(0, 5).every((o) => o.opened.length === 0)).toBe(true);
    expect(r.outs[5].opened).toHaveLength(1);
  });

  it('does not fire on drops smaller than regressionPoints', () => {
    const r = run(base({ baselines: warm }), Array(6).fill({ ratio: 0.62 }));
    expect(r.outs.every((o) => o.opened.length === 0)).toBe(true);
    expect(r.baselines.byObject[ROUTE].mean).toBeLessThan(0.75); // normal minutes feed the EWMA
  });

  it('demo profile: fires on the first qualifying minute and says so', () => {
    const r = run(base({ baselines: warm, settings: demoSettings() }), [{ ratio: 0.5 }]);
    expect(r.outs[0].opened).toHaveLength(1);
    expect(r.outs[0].opened[0].notes).toEqual([DEMO_PROFILE_NOTE]);
    expect(r.outs[0].opened[0].caughtInSec).toBe(65);
  });

  it('S15: names the trim commit, not the pack commit on another route (either order)', () => {
    for (const packMs of [T0 - 40_000, T0 - 160_000]) {
      const commits = [packCommit(packMs), trimCommit(T0 - 120_000)];
      const r = run(base({ baselines: warm, settings: demoSettings(), commits }), [{ ratio: 0.5 }]);
      const [inc] = r.outs[0].opened;
      expect(inc.severity).toBe('high');
      expect(inc.cause).toBe('commit');
      expect(inc.commit).toMatchObject({ hash: 'trim001', match: 'files', author: 's.koelpin' });
      expect(inc.caughtInSec).toBe(120); // openedAt − deployedAt
      expect(r.outs[0].unmatchedRegressions).toEqual([]);
    }
  });

  it('ignores commits outside the commit window', () => {
    const commits = [trimCommit(T0 - 45 * MIN)];
    const r = run(base({ baselines: warm, settings: demoSettings(), commits }), [{ ratio: 0.5 }]);
    expect(r.outs[0].opened[0]).toMatchObject({ cause: 'unknown', severity: 'medium' });
  });

  it('stays open with a frozen baseline, then recovers after recoveryMinutes clean minutes', () => {
    const r = run(base({ baselines: warm }), [
      { ratio: 0.5 },
      { ratio: 0.5 },
      { ratio: 0.5 }, // opens
      { ratio: 0.5 },
      { ratio: 0.72 },
      { ratio: 0.72 },
      { ratio: 0.6 }, // not clean: resets recovery
      { ratio: 0.73 },
      { ratio: 0.73 },
      { ratio: 0.73 },
      { ratio: 0.73 },
      { ratio: 0.73 }, // 5th clean minute → closes
    ]);
    expect(r.outs[2].opened).toHaveLength(1);
    expect(r.outs.slice(3, 11).every((o) => o.opened.length === 0 && o.closed.length === 0)).toBe(true);
    expect(r.outs[11].closed).toHaveLength(1);
    // D47: the close keeps the drop and records where it recovered to.
    expect(r.outs[11].closed[0]).toMatchObject({ closedAt: new Date(T0 + 11 * MIN).toISOString(), before: 0.75, after: 0.5, recoveredTo: 0.73 });
    expect(r.outs[10].baselines.byObject[ROUTE].mean).toBe(0.75); // frozen throughout
    expect(r.outs[11].baselines.rules[`regression|${ROUTE}`]).toBeUndefined();
    expect(r.open).toEqual([]);
  });

  it('demo profile recovers after one clean minute (the incident closes itself)', () => {
    const r = run(base({ baselines: warm, settings: demoSettings() }), [{ ratio: 0.5 }, { ratio: 0.5 }, { ratio: 0.75 }]);
    expect(r.outs[2].closed).toHaveLength(1);
  });

  it('recovers from an open incident even without rule state (falls back to incident.before)', () => {
    const openInc: Incident = { id: 'inc_old', type: 'regression', severity: 'high', objectKey: ROUTE, label: 'x', openedAt: '2026-09-26T14:00:00.000Z', before: 0.75, after: 0.5, impactPerDayM: 0, notes: [], deliveries: [] };
    const r = run(base({ baselines: warm, settings: demoSettings(), openIncidents: [openInc] }), [{ ratio: 0.71 }]);
    expect(r.outs[0].closed.map((c) => c.id)).toEqual(['inc_old']);
  });

  it('S21: a muted object never opens an incident, and does once the mute expires', () => {
    const until = new Date(T0 + 10 * MIN).toISOString();
    const muted = run(base({ baselines: warm, settings: demoSettings(), muted: { [ROUTE]: until } }), Array(10).fill({ ratio: 0.5 }));
    expect(muted.outs.every((o) => o.opened.length === 0)).toBe(true);
    expect(muted.baselines.byObject[ROUTE].mean).toBe(0.75); // not even fed
    const after = run(base({ baselines: muted.baselines, settings: demoSettings(), muted: { [ROUTE]: until }, nowMs: T0 + 11 * MIN }), [{ ratio: 0.5 }]);
    expect(after.outs[0].opened).toHaveLength(1);
  });

  it('muting suppresses detection but not recovery (Restore mutes, the incident still closes itself)', () => {
    const until = new Date(T0 + 10 * MIN).toISOString();
    const opened = run(base({ baselines: warm, settings: demoSettings() }), [{ ratio: 0.5 }]);
    const [inc] = opened.outs[0].opened;
    const restored = run(
      base({ baselines: opened.baselines, settings: demoSettings(), openIncidents: [inc], muted: { [ROUTE]: until }, nowMs: T0 + MIN }),
      [{ ratio: 0.75 }],
    );
    expect(restored.outs[0].closed.map((c) => c.id)).toEqual([inc.id]);
    expect(restored.baselines.byObject[ROUTE].mean).toBe(0.75);
    // still muted, no open incident: a fresh drop opens nothing
    const again = run(base({ baselines: restored.baselines, settings: demoSettings(), muted: { [ROUTE]: until }, nowMs: T0 + 2 * MIN }), [{ ratio: 0.3 }]);
    expect(again.outs[0].opened).toEqual([]);
  });

  it('a muted input spike still recovers but a new one does not open', () => {
    const warmCost = warmBaselines({ [INPUT]: 1_000_000 }, 10_000 ** 2);
    const until = new Date(T0 + 10 * MIN).toISOString();
    const open = run(base({ baselines: warmCost, settings: demoSettings() }), [{ cost: 5_000_000 }]);
    const calm = run(base({ baselines: open.baselines, settings: demoSettings(), openIncidents: open.open, muted: { [INPUT]: until }, nowMs: T0 + MIN }), [{ cost: 1_000_000 }]);
    expect(calm.outs[0].closed).toHaveLength(1);
    const muted = run(base({ baselines: calm.baselines, settings: demoSettings(), muted: { [INPUT]: until }, nowMs: T0 + 2 * MIN }), [{ cost: 5_000_000 }]);
    expect(muted.outs[0].opened).toEqual([]);
  });

  it('skips excluded objects', () => {
    const s = demoSettings();
    s.excludedObjectKeys = [ROUTE];
    const r = run(base({ baselines: warm, settings: s }), [{ ratio: 0.1 }]);
    expect(r.outs[0].opened).toEqual([]);
  });

  it('rematches unknown regressions after a timeline refresh', () => {
    const r = run(base({ baselines: warm, settings: demoSettings() }), [{ ratio: 0.5 }]);
    const [inc] = r.outs[0].opened;
    const refreshed = [trimCommit(T0 - 90_000), packCommit(T0 - 30_000)];
    const { incidents, upgraded } = rematchIncidents([inc], refreshed, inventory, 30);
    expect(upgraded).toEqual([inc.id]);
    expect(incidents[0]).toMatchObject({ cause: 'commit', severity: 'high', commit: { hash: 'trim001', match: 'files' }, caughtInSec: 90 });
    // nothing to do for matched, closed or budget incidents, or when no commit exists
    expect(rematchIncidents([incidents[0]], refreshed, inventory, 30).upgraded).toEqual([]);
    expect(rematchIncidents([{ ...inc, closedAt: 'x' }], refreshed, inventory, 30).upgraded).toEqual([]);
    expect(rematchIncidents([{ ...inc, type: 'budget' }], refreshed, inventory, 30).upgraded).toEqual([]);
    expect(rematchIncidents([inc], [], inventory, 30).upgraded).toEqual([]);
    expect(rematchIncidents([{ ...inc, openedAt: 'bad' }], refreshed, inventory, 30).upgraded).toEqual([]);
  });
});

describe('good news', () => {
  const warmLow = warmBaselines({ [ROUTE]: 0.0 });
  const on = (): Settings => {
    const s = demoSettings();
    s.goodNewsEnabled = true;
    return s;
  };

  it('is off by default (outside the demo profile, which turns it on: P2-W06, tests/unit/whatif-landed.test.tsx)', () => {
    const r = run(base({ baselines: warmLow, settings: settings(), commits: [packCommit(T0 - MIN)] }), [{ ratio: 0.33 }]);
    expect(r.outs[0].opened).toEqual([]);
    expect(r.baselines.byObject[ROUTE].mean).toBeGreaterThan(0); // absorbed
  });

  it('announces a commit-backed improvement once, closed, and re-learns the new level', () => {
    // Deployed 3 minutes before the sweep: under the demo profile the first evaluated minute starts ≥ 60 s after the
    // deploy, so it is settled (row 9, tests/unit/detector-goodnews-settle.test.ts covers the transitional minutes).
    const commits = [commit('packws1', T0 - 3 * MIN, { message: 'demo: apply the pack on r_pay' })];
    const r = run(base({ baselines: warmLow, settings: on(), commits }), [{ ratio: 0.33 }, { ratio: 0.33 }]);
    const [inc] = r.outs[0].opened;
    expect(inc).toMatchObject({ type: 'goodnews', severity: 'info', cause: 'commit', before: 0, after: 0.33, impactPerDayM: 3_300_000 });
    expect(inc.closedAt).toBe(inc.openedAt);
    expect(inc.commit?.match).toBe('message');
    expect(r.outs[0].baselines.byObject[ROUTE]).toEqual({ mean: 0, variance: 0, samples: 0, warm: [] });
    expect(r.outs[1].opened).toEqual([]); // warming up again
    expect(r.outs[1].baselines.byObject[ROUTE].samples).toBe(1);
  });

  it('without a commit it is drift: no incident, the baseline absorbs it', () => {
    const r = run(base({ baselines: warmLow, settings: on() }), [{ ratio: 0.33 }, { ratio: 0.33 }]);
    expect(r.outs.every((o) => o.opened.length === 0)).toBe(true);
    expect(r.baselines.byObject[ROUTE].mean).toBeGreaterThan(0);
  });

  it('counts across minutes under the default profile, and resets on a normal minute', () => {
    const s = settings({ goodNewsEnabled: true });
    const commits = [commit('packws1', T0 - MIN, { message: 'demo: apply the pack on r_pay' })];
    const r = run(base({ baselines: warmLow, settings: s, commits }), [{ ratio: 0.33 }, { ratio: 0.01 }, { ratio: 0.33 }, { ratio: 0.33 }, { ratio: 0.33 }]);
    expect(r.outs.slice(0, 4).every((o) => o.opened.length === 0)).toBe(true);
    expect(r.outs[1].baselines.rules[`goodnews|${ROUTE}`]).toBeUndefined();
    expect(r.outs[4].opened).toHaveLength(1);
  });
});

describe('cost spike', () => {
  // baseline $10/hour ± small; the spike rule needs > mean + 3σ AND ≥ $5/hour over the mean
  const warm = warmBaselines({ [INPUT]: 1_000_000 }, 10_000 ** 2);

  it('fires after spikeMinutes when both the sigma and the dollar thresholds are crossed', () => {
    const r = run(base({ baselines: warm }), [{ cost: 5_000_000 }, { cost: 5_000_000 }]);
    expect(r.outs[0].opened).toEqual([]);
    const [inc] = r.outs[1].opened;
    expect(inc).toMatchObject({ type: 'spike', severity: 'high', cause: 'unknown', before: 1_000_000, after: 5_000_000, impactPerDayM: 96_000_000, outputId: 'mrd_siem_prod' });
    // P1-F06: qualifying minutes feed the baseline at a quarter of α — it creeps toward the new level, it does not jump.
    const mean = r.baselines.byObject[INPUT].mean;
    expect(mean).toBeGreaterThan(1_000_000);
    expect(mean).toBeLessThan(1_010_000);
  });

  it('ignores jitter below the $/hour floor even when it is many sigma', () => {
    const r = run(base({ baselines: warm, settings: demoSettings() }), [{ cost: 1_400_000 }, { cost: 1_400_000 }]);
    expect(r.outs.every((o) => o.opened.length === 0)).toBe(true);
  });

  it('attaches a commit only when it names or touches the input', () => {
    const rate = commit('rate001', T0 - 30_000, { message: 'demo: set mrd_payments_api to 5x' });
    const r = run(base({ baselines: warm, settings: demoSettings(), commits: [rate] }), [{ cost: 5_000_000 }]);
    expect(r.outs[0].opened[0]).toMatchObject({ cause: 'commit', commit: { hash: 'rate001', match: 'message' }, caughtInSec: 30 });
    const nearby = run(base({ baselines: warm, settings: demoSettings(), commits: [packCommit(T0 - 30_000)] }), [{ cost: 5_000_000 }]);
    expect(nearby.outs[0].opened[0].cause).toBe('unknown');
    expect(nearby.outs[0].opened[0].commit).toBeUndefined();
  });

  it('recovers when the rate returns within mean + σ', () => {
    const r = run(base({ baselines: warm, settings: demoSettings() }), [{ cost: 5_000_000 }, { cost: 4_000_000 }, { cost: 1_005_000 }]);
    expect(r.outs[0].opened).toHaveLength(1);
    expect(r.outs[1].closed).toEqual([]);
    expect(r.outs[2].closed).toHaveLength(1);
    // D47: the peak stays as `after`; the rate it came back to is `recoveredTo`.
    expect(r.outs[2].closed[0]).toMatchObject({ before: 1_000_000, after: 5_000_000, recoveredTo: 1_005_000 });
    // P1-F06: the object keeps only when its last spike opened (the 24 h repeat window), no streak.
    expect(r.outs[2].baselines.rules[`spike|${INPUT}`]).toEqual({ streak: 0, recoveryStreak: 0, lastOpenedAt: r.outs[0].opened[0].openedAt });
  });

  it('resets the count on a normal minute and treats a non-finite rate as zero', () => {
    const r = run(base({ baselines: warm }), [{ cost: 5_000_000 }, { cost: 1_000_000 }, { cost: 5_000_000 }, { cost: Number.NaN }]);
    expect(r.outs.every((o) => o.opened.length === 0)).toBe(true);
  });

  it('warms up input baselines on minutes with traffic only (P1-F06: an idle Source warms up on its own level)', () => {
    const r = run(base({}), [{ cost: 0 }, { cost: 100 }]);
    expect(r.baselines.byObject[INPUT]).toMatchObject({ samples: 1, mean: 100 });
  });

  it('rematches an unknown spike only with a named commit', () => {
    const r = run(base({ baselines: warm, settings: demoSettings() }), [{ cost: 5_000_000 }]);
    const [inc] = r.outs[0].opened;
    expect(rematchIncidents([inc], [packCommit(T0 - 10_000)], inventory, 30).upgraded).toEqual([]);
    const named = commit('rate002', T0 - 10_000, { message: 'demo: set mrd_payments_api to 5x' });
    expect(rematchIncidents([inc], [named], inventory, 30).incidents[0]).toMatchObject({ cause: 'commit', severity: 'high' });
  });
});

describe('budget pace', () => {
  // UTC; Sep 26 15:00 → 25 days 15 h elapsed of a 30-day month. Budget $10,000/month.
  const elapsedMin = (T0 - Date.parse('2026-09-01T00:00:00Z')) / MIN;
  const paidFor = (pct: number) => Math.round(((pct / 100) * 1_000_000_000 * elapsedMin) / (30 * 1440));

  it('opens medium at the warning pace and upgrades to high at the alert pace', () => {
    const r = run(base({ evaluateBudget: true }), [{ paidMtdM: paidFor(95) }, { paidMtdM: paidFor(96) }, { paidMtdM: paidFor(105) }]);
    const [inc] = r.outs[0].opened;
    expect(inc).toMatchObject({ type: 'budget', severity: 'medium', objectKey: OUTPUT, outputId: 'mrd_siem_prod', before: 90, label: 'siem-prod' });
    expect(inc.after).toBeCloseTo(95, 0);
    expect(inc.impactPerDayM).toBe(0);
    expect(r.outs[1].updated).toEqual([]);
    expect(r.outs[2].updated[0]).toMatchObject({ severity: 'high', before: 100 });
    expect(r.outs[2].updated[0].impactPerDayM).toBeGreaterThan(0);
    expect(r.outs[2].baselines.budgetEvaluatedAt).toBe(new Date(T0 + 2 * MIN).toISOString());
  });

  it('opens high directly and recovers below warn − 5', () => {
    const r = run(base({ evaluateBudget: true }), [{ paidMtdM: paidFor(120) }, { paidMtdM: paidFor(86) }, { paidMtdM: paidFor(84) }]);
    expect(r.outs[0].opened[0].severity).toBe('high');
    expect(r.outs[1].closed).toEqual([]);
    expect(r.outs[2].closed).toHaveLength(1);
    // D47: the projection that opened it stays as `after`; the pace at close is `recoveredTo`.
    expect(r.outs[2].closed[0].after).toBeCloseTo(120, 0);
    expect(r.outs[2].closed[0].recoveredTo).toBeCloseTo(84, 0);
  });

  it('does nothing when not evaluated, without a budget, under pace, or in the first hour', () => {
    expect(run(base({ evaluateBudget: false }), [{ paidMtdM: paidFor(200) }]).outs[0].opened).toEqual([]);
    expect(run(base({ evaluateBudget: true }), [{ paidMtdM: paidFor(50) }]).outs[0].opened).toEqual([]);
    const noBudget = detect(base({ evaluateBudget: true, budgetSeries: { [OUTPUT]: { paidMtdM: 1e12, budgetCentsPerMonth: 0, label: 'x' } } }));
    expect(noBudget.opened).toEqual([]);
    const firstHour = Date.parse('2026-10-01T00:30:00Z');
    const early = detect(base({ nowMs: firstHour, evaluateBudget: true, budgetSeries: { [OUTPUT]: { paidMtdM: 1e12, budgetCentsPerMonth: 100, label: 'x' } } }));
    expect(early.opened).toEqual([]);
    const demo = detect(base({ nowMs: firstHour, settings: demoSettings(), evaluateBudget: true, budgetSeries: { [OUTPUT]: { paidMtdM: 1e12, budgetCentsPerMonth: 100, label: 'x' } } }));
    expect(demo.opened[0].notes).toEqual([DEMO_PROFILE_NOTE]);
  });

  it('opens and escalates nothing on muted outputs, but still recovers them', () => {
    const muted = { [OUTPUT]: new Date(T0 + 10 * MIN).toISOString() };
    const r = run(base({ evaluateBudget: true, muted }), [{ paidMtdM: paidFor(200) }]);
    expect(r.outs[0].opened).toEqual([]);
    const open = run(base({ evaluateBudget: true }), [{ paidMtdM: paidFor(95) }]);
    const m = run(base({ evaluateBudget: true, muted, openIncidents: open.open, nowMs: T0 + MIN }), [{ paidMtdM: paidFor(150) }, { paidMtdM: paidFor(50) }]);
    expect(m.outs[0].updated).toEqual([]);
    expect(m.outs[1].closed).toHaveLength(1);
  });
});

describe('P0-17: budget pace projects over the minutes actually metered', () => {
  const DAY = 1_440;
  const budgetPoint = (paidMtdM: number, budgetCentsPerMonth: number) => ({ [OUTPUT]: { paidMtdM, budgetCentsPerMonth, label: 'siem-prod' } });
  const $ = (dollars: number) => dollars * 100_000;

  it('a day-25 install paying $100/day against a $3,000 budget projects ~$3,000 (100%), not 4%', () => {
    // Installed Sep 25 00:00 UTC; evaluated Sep 26 00:30 — 1,470 minutes metered, $100/day paid.
    const nowMs = Date.parse('2026-09-26T00:30:00Z');
    const metered = DAY + 30;
    const paid = Math.round(($(100) * metered) / DAY);
    const out = detect(base({ nowMs, evaluateBudget: true, budgetSeries: budgetPoint(paid, 300_000), budgetMinutesMtd: metered }));
    const [inc] = out.opened;
    expect(inc.after).toBeCloseTo(100, 0);
    // Under three days behind the projection it warns rather than pages.
    expect(inc.severity).toBe('medium');
    // Without the metered minutes, collecting-since bounds the elapsed time the same way.
    const bySince = detect(
      base({ nowMs, evaluateBudget: true, budgetSeries: budgetPoint(paid, 300_000), collectingSinceMs: Date.parse('2026-09-25T00:00:00Z') }),
    );
    expect(bySince.opened[0].after).toBeCloseTo(100, 0);
    // The shared core function says the same: ~$3,000 on pace.
    const pace = budgetPace({ paidMtdM: paid, budgetCentsPerMonth: 300_000, nowMs, tz: 'UTC', meteredMinutes: metered });
    expect(pace.projectedM / 100_000).toBeCloseTo(3_000, 0);
    expect(pace).toMatchObject({ basis: 'metered', elapsedMin: metered, settled: true, early: true });
  });

  it('$40 paid in the first hour of a $1,000 budget opens nothing until a day is behind the projection', () => {
    const monthStart = Date.parse('2026-10-01T00:00:00Z');
    for (const minutes of [61, 120, 360, DAY - 1]) {
      const out = detect(base({ nowMs: monthStart + minutes * MIN, evaluateBudget: true, budgetSeries: budgetPoint($(40), 100_000), budgetMinutesMtd: minutes }));
      expect(out.opened, `+${minutes} min`).toEqual([]);
    }
    // A day in, the same $40 is a real pace: $40 × 31 = $1,240 (124 %) — a warning while under three days.
    const day = detect(base({ nowMs: monthStart + DAY * MIN, evaluateBudget: true, budgetSeries: budgetPoint($(40), 100_000), budgetMinutesMtd: DAY }));
    expect(day.opened[0]).toMatchObject({ type: 'budget', severity: 'medium', before: 90 });
    expect(day.opened[0].after).toBeCloseTo(124, 0);
    // From day three the alert pace pages.
    const later = detect(base({ nowMs: monthStart + 3 * DAY * MIN, evaluateBudget: true, budgetSeries: budgetPoint($(120), 100_000), budgetMinutesMtd: 3 * DAY }));
    expect(later.opened[0]).toMatchObject({ severity: 'high', before: 100 });
  });

  it('the demo profile keeps its one-minute projection (the budget scene still fires on stage)', () => {
    const monthStart = Date.parse('2026-10-01T00:00:00Z');
    const out = detect(base({ nowMs: monthStart + 5 * MIN, settings: demoSettings(), evaluateBudget: true, budgetSeries: budgetPoint($(40), 100_000), budgetMinutesMtd: 5 }));
    expect(out.opened[0]).toMatchObject({ severity: 'high', notes: [DEMO_PROFILE_NOTE] });
  });

  it('an open budget incident still recovers while the projection is young', () => {
    const monthStart = Date.parse('2026-10-01T00:00:00Z');
    const open: Incident = { id: 'b', type: 'budget', severity: 'medium', objectKey: OUTPUT, label: 'siem-prod', openedAt: 'x', before: 90, after: 95, impactPerDayM: 0, notes: [], deliveries: [] };
    const out = detect(base({ nowMs: monthStart + 30 * MIN, evaluateBudget: true, openIncidents: [open], budgetSeries: budgetPoint($(0.01), 100_000), budgetMinutesMtd: 30 }));
    expect(out.closed.map((c) => c.id)).toEqual(['b']);
  });

  it('Settings → Budgets and the incident (the Ledger chip) show the same percentage', () => {
    const nowMs = Date.parse('2026-09-26T15:00:05Z');
    const metered = 5 * DAY + 900;
    const paidMtdM = $(1_234.56);
    const inc = detect(base({ nowMs, evaluateBudget: true, budgetSeries: budgetPoint(paidMtdM, 150_000), budgetMinutesMtd: metered })).opened[0];
    const settings = settingsBudgetPace({ mtdPaidM: paidMtdM, mtdMinutes: metered }, 150_000, nowMs, 'UTC', { budgetWarnPct: 90, budgetAlertPct: 100 })!;
    expect(settings.ratio! * 100).toBeCloseTo(inc.after, 1);
    expect(Math.round(settings.ratio! * 100)).toBe(Math.round(inc.after));
    expect(settings.level).toBe('alert');
  });
});

describe('defaults and fallbacks', () => {
  it('works without output ids, per-day figures, a zone or rule state', () => {
    const s = demoSettings();
    s.displayTimezone = '';
    const warm = warmBaselines({ [ROUTE]: 0.75, [INPUT]: 1_000_000 });
    const out = detect(
      base({
        settings: s,
        baselines: warm,
        ratioSeries: { [ROUTE]: { x: 0.4, whpPerDayM: undefined as unknown as number, label: 'p' } },
        costSeries: { [INPUT]: { x: 9_000_000, label: 'c' } },
        budgetSeries: { 'pipe:default:odd': { paidMtdM: 1e12, budgetCentsPerMonth: 1, label: 'odd' } },
        evaluateBudget: true,
      }),
    );
    const reg = out.opened.find((i) => i.type === 'regression')!;
    expect(reg.outputId).toBeUndefined();
    expect(reg.impactPerDayM).toBe(0);
    expect(out.opened.find((i) => i.type === 'spike')!.outputId).toBeUndefined();
    expect(out.opened.find((i) => i.type === 'budget')!.outputId).toBeUndefined();
  });
  it('recovers an open spike without rule state from the baseline mean', () => {
    const warm = warmBaselines({ [INPUT]: 1_000_000 }, 0);
    const openSpike: Incident = { id: 's', type: 'spike', severity: 'high', objectKey: INPUT, label: 'x', openedAt: 'x', before: 1_000_000, after: 9e6, impactPerDayM: 0, notes: [], deliveries: [] };
    const out = detect(base({ settings: demoSettings(), baselines: warm, openIncidents: [openSpike], costSeries: { [INPUT]: { x: 1_000_000, label: 'x' } } }));
    expect(out.closed.map((c) => c.id)).toEqual(['s']);
    const noBaseline = detect(base({ settings: demoSettings(), openIncidents: [openSpike], costSeries: { [INPUT]: { x: 2_000_000, label: 'x' } } }));
    expect(noBaseline.closed).toEqual([]);
  });
  it('skips excluded inputs', () => {
    const s = demoSettings();
    s.excludedObjectKeys = [INPUT];
    const out = detect(base({ settings: s, baselines: warmBaselines({ [INPUT]: 1 }), costSeries: { [INPUT]: { x: 9e9, label: 'x' } } }));
    expect(out.opened).toEqual([]);
    expect(out.baselines.byObject[INPUT].samples).toBe(500);
  });
});

describe('robustness', () => {
  it('handles an empty input and missing documents', () => {
    const out = detect({ ...base({}), baselines: undefined as unknown as BaselinesDoc, openIncidents: undefined as unknown as Incident[], commits: undefined as unknown as Commit[] });
    expect(out).toMatchObject({ opened: [], updated: [], closed: [], unmatchedRegressions: [] });
    expect(out.baselines.byObject).toEqual({});
    expect(out.baselines.budgetEvaluatedAt).toBeUndefined();
  });
  it('clamps ratios and ignores closed incidents in the open list', () => {
    const warm = warmBaselines({ [ROUTE]: 0.75 });
    const closedInc: Incident = { id: 'c', type: 'regression', severity: 'high', objectKey: ROUTE, label: 'x', openedAt: 'x', closedAt: 'y', before: 0.75, after: 0.5, impactPerDayM: 0, notes: [], deliveries: [] };
    const r = run(base({ baselines: warm, settings: demoSettings(), openIncidents: [closedInc] }), [{ ratio: -3 }]);
    expect(r.outs[0].opened[0].after).toBe(0);
  });
});


describe('D26 floor on open regressions', () => {
  it('closes an open regression whose impact is below the dollar floor, noting it', async () => {
    const { detect, emptyBaselines } = await import('../../core/detector.ts');
    const { defaultSettings } = await import('../../core/settings.ts');
    const settings = defaultSettings('2026-09-26T00:00:00.000Z', 'UTC');
    const key = 'route:default:mrd_vpc_flow';
    const open = {
      id: 'inc_x', type: 'regression' as const, severity: 'high' as const, objectKey: key, label: 'VPC', openedAt: '2026-09-26T06:42:00.000Z',
      before: 0.297, after: 0, impactPerDayM: 60_000, notes: ['catch-up'], deliveries: [],
    };
    let baselines = emptyBaselines('2026-09-26T06:42:00.000Z');
    let closed: Incident | undefined;
    for (let m = 0; m < 6 && !closed; m++) {
      const out = detect({
        nowMs: Date.parse('2026-09-26T08:00:00.000Z') + m * 60_000, settings, baselines, openIncidents: [open],
        ratioSeries: { [key]: { x: 0, whpPerDayM: 180_000, label: 'VPC' } }, costSeries: {}, budgetSeries: {}, muted: {}, commits: [], evaluateBudget: false,
      });
      baselines = out.baselines;
      if (out.closed.length) closed = out.closed[0];
    }
    expect(closed?.notes).toContain('below-floor');
    // D47: the ratio never came back (still 0 against 0.297), so the close keeps its drop and records no
    // recovery — a `recoveredTo` here would tell every reader the savings were "back to 0%".
    expect(closed).toMatchObject({ before: 0.297, after: 0, impactPerDayM: 60_000 });
    expect(closed?.recoveredTo).toBeUndefined();
  });

  it('a ratio back within the band closes as a recovery even when the flow is under the floor', async () => {
    const { detect, emptyBaselines } = await import('../../core/detector.ts');
    const { defaultSettings } = await import('../../core/settings.ts');
    const settings = defaultSettings('2026-09-26T00:00:00.000Z', 'UTC');
    settings.demo = { enabled: true, replayMode: false, profile: true }; // 1-minute recovery
    const key = 'route:default:mrd_vpc_flow';
    const open = {
      id: 'inc_x', type: 'regression' as const, severity: 'high' as const, objectKey: key, label: 'VPC', openedAt: '2026-09-26T06:42:00.000Z',
      before: 0.297, after: 0, impactPerDayM: 60_000, notes: [] as string[], deliveries: [],
    };
    const out = detect({
      nowMs: Date.parse('2026-09-26T08:00:00.000Z'), settings, baselines: emptyBaselines('2026-09-26T06:42:00.000Z'), openIncidents: [open],
      ratioSeries: { [key]: { x: 0.28, whpPerDayM: 180_000, label: 'VPC' } }, costSeries: {}, budgetSeries: {}, muted: {}, commits: [], evaluateBudget: false,
    });
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0]).toMatchObject({ before: 0.297, after: 0, recoveredTo: 0.28, notes: [] });
  });
});


describe('D45: an open regression deepens while the drop continues', () => {
  it('updates after/impact when the ratio keeps falling, and not when it eases', async () => {
    const { detect, emptyBaselines } = await import('../../core/detector.ts');
    const { defaultSettings } = await import('../../core/settings.ts');
    const settings = defaultSettings('2026-09-26T00:00:00.000Z', 'UTC');
    const key = 'route:default:mrd_payments_api';
    const open = {
      id: 'inc_y', type: 'regression' as const, severity: 'high' as const, objectKey: key, label: 'Payments', openedAt: '2026-09-26T15:40:00.000Z',
      before: 0.756, after: 0.586, impactPerDayM: 1_500_000, notes: [], deliveries: [],
    };
    const base = { settings, baselines: emptyBaselines('2026-09-26T15:40:00.000Z'), openIncidents: [open], costSeries: {}, budgetSeries: {}, muted: {}, commits: [], evaluateBudget: false };
    const deeper = detect({ ...base, nowMs: Date.parse('2026-09-26T15:41:00.000Z'), ratioSeries: { [key]: { x: 0.5, whpPerDayM: 9_000_000, label: 'Payments' } } });
    expect(deeper.updated).toHaveLength(1);
    expect(deeper.updated[0].after).toBeCloseTo(0.5, 3);
    expect(deeper.updated[0].impactPerDayM).toBe(Math.round((0.756 - 0.5) * 9_000_000));
    expect(deeper.updated[0].before).toBe(0.756);
    const easing = detect({ ...base, openIncidents: deeper.updated, baselines: deeper.baselines, nowMs: Date.parse('2026-09-26T15:42:00.000Z'), ratioSeries: { [key]: { x: 0.55, whpPerDayM: 9_000_000, label: 'Payments' } } });
    expect(easing.updated).toHaveLength(0);
    expect(easing.closed).toHaveLength(0);
  });

  it('D47: the close keeps the deepest `after` and the impact, and records the recovered ratio', async () => {
    const { detect, emptyBaselines } = await import('../../core/detector.ts');
    const { defaultSettings } = await import('../../core/settings.ts');
    const settings = defaultSettings('2026-09-26T00:00:00.000Z', 'UTC');
    settings.demo = { enabled: true, replayMode: false, profile: true }; // 1-minute recovery
    const key = 'route:default:mrd_payments_api';
    const open = {
      id: 'inc_z', type: 'regression' as const, severity: 'high' as const, objectKey: key, label: 'Payments', openedAt: '2026-09-26T15:40:00.000Z',
      before: 0.756, after: 0.586, impactPerDayM: 1_500_000, notes: [], deliveries: [],
    };
    const base = { settings, baselines: emptyBaselines('2026-09-26T15:40:00.000Z'), openIncidents: [open], costSeries: {}, budgetSeries: {}, muted: {}, commits: [], evaluateBudget: false };
    const deeper = detect({ ...base, nowMs: Date.parse('2026-09-26T15:41:00.000Z'), ratioSeries: { [key]: { x: 0.49, whpPerDayM: 9_000_000, label: 'Payments' } } });
    expect(deeper.updated[0]).toMatchObject({ after: 0.49, impactPerDayM: Math.round((0.756 - 0.49) * 9_000_000) });
    expect(deeper.updated[0].recoveredTo).toBeUndefined();
    const back = detect({ ...base, openIncidents: deeper.updated, baselines: deeper.baselines, nowMs: Date.parse('2026-09-26T15:42:00.000Z'), ratioSeries: { [key]: { x: 0.89, whpPerDayM: 9_000_000, label: 'Payments' } } });
    expect(back.closed).toHaveLength(1);
    expect(back.closed[0]).toMatchObject({ closedAt: '2026-09-26T15:42:00.000Z', before: 0.756, after: 0.49, recoveredTo: 0.89, impactPerDayM: Math.round((0.756 - 0.49) * 9_000_000) });
  });
});
