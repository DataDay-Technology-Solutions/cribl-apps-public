// tests/unit/detector-goodnews-settle.test.ts — founder-build r1 core-3 (FOUNDER_PLAN row 9, "The rule (re-specified)";
// PACK_PAYOFF F1/F2). Under the demo profile's 1-minute confirmation, good news used to fire on the deploy's
// transitional minute: on Sunday the Palo Alto pack deployed at 12:39:50, minute 12:40 read 19 % while the Worker
// reload landed mid-minute, and the green card printed "0 % → 19 %, $26 a day" although the settled figure was 34 %
// from 12:41 on. The rule now: in the demo profile, while settings.demo.settle !== false, a qualifying good-news minute
// that STARTS less than 60 s after the commit's deploy (commitTimeMs, which prefers deployedAt) does not fire; the
// frozen baseline is kept, the streak resets, the minute is not learned; the first qualifying minute that starts
// ≥ 60 s after the deploy fires with `after` = that minute. The release (3-minute streak) is unchanged.

import { describe, expect, it } from 'vitest';
import type { BaselinesDoc, Commit, Incident, InventoryDoc, Settings, Snapshot } from '../../core/types.ts';
import { detect, emptyBaselines, type DetectInput, type DetectOutput } from '../../core/detector.ts';
import { defaultSettings, demoSettleOn, mergeSettings } from '../../core/settings.ts';
import { priceCommit } from '../../core/commitImpacts.ts';

const MIN = 60_000;
const ROUTE = 'route:default:mrd_pan_firewall';
const WHP_PER_DAY_M = 13_501_000; // the Palo Alto row's would-have-paid, $135.01 a day

const inventory: InventoryDoc = {
  schemaVersion: 1,
  updatedAt: '',
  hash: 'h',
  byGroup: {
    default: {
      inputs: [],
      outputs: [],
      pipelines: [],
      routes: [{ id: 'mrd_pan_firewall', filter: "__inputId=='datagen:mrd_pan_firewall'", pipeline: 'mrd_pan_pack', output: 'mrd_siem_prod' }],
    },
  },
};

const at = (hhmmss: string): number => Date.parse(`2026-09-27T${hhmmss}Z`);

/** The pack apply: "demo: apply the pack on mrd_pan_firewall", touching the group's route.yml. */
const packCommit = (deployedMs: number): Commit => ({
  hash: 'e1e9889aa',
  message: 'demo: apply the pack on mrd_pan_firewall',
  author: 'Steve Koelpin',
  committedAt: new Date(deployedMs - 4_000).toISOString(),
  deployedAt: new Date(deployedMs).toISOString(),
  groupId: 'default',
  files: ['groups/default/local/cribl/pipelines/route.yml'],
  source: 'demo',
});

const demoProfile = (over: Partial<Settings['demo']> = {}): Settings => {
  const s = defaultSettings('2026-09-27T00:00:00.000Z', 'UTC');
  s.demo = { enabled: true, replayMode: false, profile: true, ...over };
  return s;
};
const releaseProfile = (over: Partial<Settings['demo']> = {}): Settings => {
  const s = defaultSettings('2026-09-27T00:00:00.000Z', 'UTC');
  s.goodNewsEnabled = true;
  s.demo = { enabled: false, replayMode: false, profile: true, ...over };
  return s;
};

/** The route on passthrough: a warm baseline at 0 %. */
const passthrough = (): BaselinesDoc => ({ ...emptyBaselines('x'), byObject: { [ROUTE]: { mean: 0, variance: 0.0001, samples: 500, warm: [] } } });

interface Minute {
  /** the minute's start, 'HH:MM' UTC */
  start: string;
  ratio: number;
}

/** One sweep per minute, 25 s after the minute ends (the live runner's cadence), carrying baselines and open incidents. */
function sweep(settings: Settings, commits: Commit[], minutes: Minute[]): { outs: (DetectOutput & { minute: string })[]; baselines: BaselinesDoc } {
  let baselines = passthrough();
  let open: Incident[] = [];
  const outs: (DetectOutput & { minute: string })[] = [];
  for (const m of minutes) {
    const minuteStartMs = at(`${m.start}:00`);
    const input: DetectInput = {
      nowMs: minuteStartMs + MIN + 25_000,
      minuteStartMs,
      settings,
      baselines,
      openIncidents: open,
      ratioSeries: { [ROUTE]: { x: m.ratio, whpPerDayM: WHP_PER_DAY_M, label: 'Palo Alto firewall', outputId: 'mrd_siem_prod' } },
      costSeries: {},
      budgetSeries: {},
      muted: {},
      commits,
      inventory,
      evaluateBudget: false,
    };
    const out = detect(input);
    outs.push({ ...out, minute: m.start });
    baselines = out.baselines;
    const closedIds = new Set(out.closed.map((c) => c.id));
    open = [...open.filter((o) => !closedIds.has(o.id)), ...out.opened.filter((o) => !o.closedAt)];
  }
  return { outs, baselines };
}

const goodNews = (outs: (DetectOutput & { minute: string })[]) =>
  outs.flatMap((o) => o.opened.filter((i) => i.type === 'goodnews').map((i) => ({ minute: o.minute, inc: i })));

// Sunday's real series (PACK_PAYOFF §2): the deploy minute reads 0 % (out above in, clamped), then 19 %, then 34 %.
const SUNDAY: Minute[] = [
  { start: '12:38', ratio: 0 },
  { start: '12:39', ratio: 0 },
  { start: '12:40', ratio: 0.19 },
  { start: '12:41', ratio: 0.3418 },
  { start: '12:42', ratio: 0.3418 },
  { start: '12:43', ratio: 0.3418 },
];

describe('core-3 · the green card prints the settled figure (settings.demo.settle, FOUNDER_PLAN row 9)', () => {
  it('(i) Sunday: deploy 12:39:50, 12:40 = 19 %, 12:41 = 34 %, 12:42 = 34 % → fires once, on 12:41, after = 34 %', () => {
    const deploy = at('12:39:50.157');
    const { outs } = sweep(demoProfile(), [packCommit(deploy)], SUNDAY);
    const fired = goodNews(outs);
    expect(fired).toHaveLength(1);
    const [{ minute, inc }] = fired;
    expect(minute).toBe('12:41');
    expect(inc).toMatchObject({ type: 'goodnews', severity: 'info', cause: 'commit', before: 0, after: 0.3418 });
    expect(inc.commit?.hash).toBe('e1e9889aa');
    // $135.01 × 34.18 % ≈ $46.15 a day (never the transitional $26).
    expect(inc.impactPerDayM).toBe(Math.round(0.3418 * WHP_PER_DAY_M));
    // Swept at 12:42:25 = deploy + 2:35 (the general window is A+2:25 to A+3:25).
    expect(inc.openedAt).toBe('2026-09-27T12:42:25.000Z');
    expect(inc.caughtInSec).toBe(155);
    // The transitional minute: nothing opened, the baseline did not learn it, the streak restarted, the frozen baseline kept.
    const deployMinute = outs.find((o) => o.minute === '12:39')!;
    const transitional = outs.find((o) => o.minute === '12:40')!;
    expect(transitional.opened).toEqual([]);
    expect(transitional.baselines.byObject[ROUTE].mean).toBe(0);
    expect(transitional.baselines.byObject[ROUTE].samples).toBe(deployMinute.baselines.byObject[ROUTE].samples);
    const rule = transitional.baselines.rules[`goodnews|${ROUTE}`];
    expect(rule?.streak).toBe(0);
    expect(rule?.frozenBaseline).toBe(0);
  });

  it('(ii) a late-minute deploy (hh:mm:55): the next minute (starts 5 s after) is skipped, the one after fires', () => {
    const deploy = at('12:39:55');
    const series: Minute[] = [
      { start: '12:40', ratio: 0.34 },
      { start: '12:41', ratio: 0.34 },
      { start: '12:42', ratio: 0.34 },
    ];
    const fired = goodNews(sweep(demoProfile(), [packCommit(deploy)], series).outs);
    expect(fired.map((f) => f.minute)).toEqual(['12:41']);
    expect(fired[0].inc.after).toBe(0.34);
  });

  it('(iii) an early deploy (hh:mm:05): the minute starting 55 s after is skipped (and the one the deploy landed in)', () => {
    const deploy = at('12:40:05');
    const series: Minute[] = [
      { start: '12:40', ratio: 0.2 },
      { start: '12:41', ratio: 0.34 },
      { start: '12:42', ratio: 0.34 },
      { start: '12:43', ratio: 0.34 },
    ];
    const fired = goodNews(sweep(demoProfile(), [packCommit(deploy)], series).outs);
    expect(fired.map((f) => f.minute)).toEqual(['12:42']);
    expect(fired[0].inc.after).toBe(0.34);
  });

  it('a minute that starts exactly 60 s after the deploy fires', () => {
    const deploy = at('12:40:00');
    const fired = goodNews(sweep(demoProfile(), [packCommit(deploy)], [{ start: '12:40', ratio: 0.34 }, { start: '12:41', ratio: 0.34 }]).outs);
    expect(fired.map((f) => f.minute)).toEqual(['12:41']);
  });

  it('prefers deployedAt over committedAt (commitTimeMs): a commit made long before its deploy is still settled', () => {
    const c = { ...packCommit(at('12:39:50')), committedAt: '2026-09-27T12:30:00.000Z' };
    const fired = goodNews(sweep(demoProfile(), [c], SUNDAY).outs);
    expect(fired.map((f) => f.minute)).toEqual(['12:41']);
  });

  it('(iv) settle: false restores the old behaviour: Sunday fires on the transitional 12:40 at 19 %', () => {
    const { outs } = sweep(demoProfile({ settle: false }), [packCommit(at('12:39:50.157'))], SUNDAY);
    const fired = goodNews(outs);
    expect(fired.map((f) => f.minute)).toEqual(['12:40']);
    expect(fired[0].inc.after).toBe(0.19);
    expect(fired[0].inc.impactPerDayM).toBe(Math.round(0.19 * WHP_PER_DAY_M));
  });

  it('(v) the release profile is unchanged: its 3-minute streak fires on the third qualifying minute, settle or not', () => {
    const deploy = at('12:39:50');
    const series: Minute[] = [
      { start: '12:40', ratio: 0.34 },
      { start: '12:41', ratio: 0.34 },
      { start: '12:42', ratio: 0.34 },
      { start: '12:43', ratio: 0.34 },
    ];
    const on = goodNews(sweep(releaseProfile(), [packCommit(deploy)], series).outs);
    const off = goodNews(sweep(releaseProfile({ settle: false }), [packCommit(deploy)], series).outs);
    expect(on.map((f) => f.minute)).toEqual(['12:42']);
    expect(off).toEqual(on);
    // Demo mode on with the profile switched off is the release's rule too.
    const s = releaseProfile();
    s.demo = { enabled: true, replayMode: false, profile: false };
    expect(goodNews(sweep(s, [packCommit(deploy)], series).outs).map((f) => f.minute)).toEqual(['12:42']);
  });

  it('good news with no commit behind it is still drift under the demo profile: nothing opens, the baseline absorbs it', () => {
    const { outs, baselines } = sweep(demoProfile(), [], SUNDAY);
    expect(goodNews(outs)).toEqual([]);
    expect(baselines.byObject[ROUTE].mean).toBeGreaterThan(0);
  });

  it('F2: the pack commit is priced from the settled alert (+$46 a day), never the transitional $26', () => {
    const deploy = at('12:39:50.157');
    const c = packCommit(deploy);
    const fired = goodNews(sweep(demoProfile(), [c], SUNDAY).outs);
    const snapshot = {
      sweepAt: '2026-09-27T12:44:25.000Z',
      windowEnd: '2026-09-27T12:44:00.000Z',
      flows: [],
      incidents: fired.map((f) => f.inc),
      timeline: [c],
    } as unknown as Snapshot;
    const impact = priceCommit(c, snapshot);
    expect(impact.status).toBe('priced');
    expect(impact.basis).toBe('alert');
    expect(impact.perDayM).toBe(Math.round(0.3418 * WHP_PER_DAY_M));
  });

  it('the setting: absent means on; only a stored boolean is kept; the defaults document is unchanged', () => {
    const d = defaultSettings('2026-09-27T00:00:00.000Z', 'UTC');
    expect(d.demo).toEqual({ enabled: false, replayMode: false, profile: true });
    expect(demoSettleOn(d)).toBe(true);
    expect(demoSettleOn({ demo: { enabled: true, replayMode: false, profile: true, settle: false } })).toBe(false);
    expect(demoSettleOn({ demo: { enabled: true, replayMode: false, profile: true, settle: true } })).toBe(true);
    expect(mergeSettings({ demo: { enabled: true, settle: false } }, d).demo).toEqual({ enabled: true, replayMode: false, profile: true, settle: false });
    expect(mergeSettings({ demo: { enabled: true, settle: 'no' } }, d).demo).toEqual({ enabled: true, replayMode: false, profile: true });
    expect(mergeSettings({ demo: { settle: true } }, d).demo.settle).toBe(true);
  });
});
