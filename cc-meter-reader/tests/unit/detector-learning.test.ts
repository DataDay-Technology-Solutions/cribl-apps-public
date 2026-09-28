// P1-F06 — the cost-spike rule learns a new level. Replays the SRE audit's probes
// (tests/report/audit/sre-day2/probes/detector-noise.ts) minute by minute through core/detector.detect:
//   A. an hourly 5-minute batch ($80/h over a $2/h base) for 8 hours → at most 2 incidents (was 8, one per hour);
//   B. an idle Source that starts sending ($0 × 10, then a steady $30/h) → warms up on its own level, opens nothing
//      (was a HIGH spike that never closed); B′, a Source with an hour of history that jumps to a new steady level,
//      opens and closes as the new normal;
//   C. a +1 %/minute morning ramp from $20/h for 4 hours, then flat → closed within 60 minutes of settling (was open forever).

import { describe, expect, it } from 'vitest';
import {
  NEW_NORMAL_NOTE,
  SPIKE_NEW_NORMAL_MINUTES,
  SPIKE_REPEAT_MS,
  detect,
  emptyBaselines,
  spikeSigma,
} from '../../core/detector.ts';
import { defaultSettings } from '../../core/settings.ts';
import { canonicalPayload, incidentPlainText, servicenowPayload, slackPayload } from '../../core/payloads.ts';
import { renderAlert } from '../../core/delivery.ts';
import type { BaselinesDoc, Incident, Settings } from '../../core/types.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 28, 0, 0, 0); // Mon 28 Sep 2026 00:00 UTC
const $h = (dollarsPerHour: number): number => Math.round(dollarsPerHour * 100_000); // $/hour → millicents/hour

function settingsFor(profile: 'default' | 'demo'): Settings {
  const s = defaultSettings(new Date(T0).toISOString(), 'UTC');
  s.demo = profile === 'demo' ? { enabled: true, replayMode: false, profile: true } : { enabled: false, replayMode: false, profile: false };
  return s;
}

interface Replay {
  opened: { minute: number; incident: Incident }[];
  closed: { minute: number; incident: Incident }[];
  updated: { minute: number; incident: Incident }[];
  open: Incident[];
  baselines: BaselinesDoc;
}

/** Feeds one $/hour reading per minute, as the sweep does (the evaluated minute ends, the sweep runs 25 s later). */
function replay(series: number[], opts: { key?: string; profile?: 'default' | 'demo'; muted?: (minute: number) => boolean; startMs?: number } = {}): Replay {
  const key = opts.key ?? 'in:default:batch_source';
  const settings = settingsFor(opts.profile ?? 'default');
  const start = opts.startMs ?? T0;
  let baselines: BaselinesDoc = emptyBaselines(new Date(start).toISOString());
  let open: Incident[] = [];
  const out: Replay = { opened: [], closed: [], updated: [], open: [], baselines };
  for (let i = 0; i < series.length; i++) {
    const minuteStart = start + i * MIN;
    const nowMs = minuteStart + MIN + 25_000;
    const res = detect({
      nowMs,
      minuteStartMs: minuteStart,
      settings,
      baselines,
      openIncidents: open,
      ratioSeries: {},
      costSeries: { [key]: { x: series[i], label: 'batch source' } },
      budgetSeries: {},
      muted: opts.muted?.(i) ? { [key]: new Date(nowMs + MIN).toISOString() } : {},
      commits: [],
      evaluateBudget: false,
    });
    baselines = res.baselines;
    for (const inc of res.opened) {
      out.opened.push({ minute: i, incident: inc });
      open.push(inc);
    }
    for (const inc of res.updated) {
      out.updated.push({ minute: i, incident: inc });
      open = open.map((o) => (o.id === inc.id ? inc : o));
    }
    for (const inc of res.closed) {
      out.closed.push({ minute: i, incident: inc });
      open = open.filter((o) => o.id !== inc.id);
    }
  }
  out.open = open;
  out.baselines = baselines;
  return out;
}

const repeat = (value: number, minutes: number): number[] => Array.from({ length: minutes }, () => value);

describe('P1-F06 · probe A: an hourly batch pages once, then is learned', () => {
  const quiet = $h(2);
  const burst = $h(80);
  const hours = (n: number): number[] => {
    const s: number[] = [];
    for (let h = 0; h < n; h++) for (let m = 0; m < 60; m++) s.push(m >= 30 && m < 35 ? burst : quiet);
    return s;
  };

  it('opens at most 2 incidents in 8 hours (the probe opened 8, one per hour)', () => {
    const r = replay(hours(8));
    expect(r.opened.length).toBeGreaterThanOrEqual(1);
    expect(r.opened.length).toBeLessThanOrEqual(2);
    // The one it opens is real (40× the base) and closes when the burst ends.
    expect(r.opened[0].incident).toMatchObject({ type: 'spike', severity: 'high' });
    expect(r.closed.length).toBe(r.opened.length);
    expect(r.open).toEqual([]);
  });

  it('the burst minutes still teach the baseline (fed at a reduced weight, never frozen out)', () => {
    const r = replay(hours(8));
    const b = r.baselines.byObject['in:default:batch_source'];
    // Every minute fed: 480 samples, and the mean sits above the quiet $2/h because the bursts counted.
    expect(b.samples).toBe(480);
    expect(b.mean).toBeGreaterThan(quiet);
  });

  it('a repeat after the 24 h window opens again (a pattern is not muted forever)', () => {
    const day = hours(25);
    const r = replay(day);
    const minutes = r.opened.map((o) => o.minute);
    expect(minutes.length).toBe(2);
    expect((minutes[1] - minutes[0]) * MIN).toBeGreaterThanOrEqual(SPIKE_REPEAT_MS);
  });

  it('under the demo profile every repeat still opens (rehearsals fire the spike lever twice in a row)', () => {
    const r = replay(hours(3), { profile: 'demo' });
    expect(r.opened.length).toBe(3);
  });
});

describe('P1-F06 · probe B: a Source that starts sending', () => {
  it('B (10 × $0, then a steady $30/h): warms up on its own level and opens nothing — no HIGH spike that never closes', () => {
    const r = replay([...repeat(0, 10), ...repeat($h(30), 120)], { key: 'in:default:new_source' });
    expect(r.opened).toEqual([]);
    expect(r.open).toEqual([]);
    const b = r.baselines.byObject['in:default:new_source'];
    expect(b.mean).toBeCloseTo($h(30), -3);
  });

  it('B′ (an hour at $2/h, then a steady $30/h): opens once, then closes as the new normal after an hour at the level', () => {
    const r = replay([...repeat($h(2), 60), ...repeat($h(30), 180)], { key: 'in:default:new_source' });
    expect(r.opened).toHaveLength(1);
    const { minute: openedAt, incident } = r.opened[0];
    expect(incident).toMatchObject({ type: 'spike', severity: 'high' });
    expect(r.closed).toHaveLength(1);
    const { minute: closedAt, incident: closedInc } = r.closed[0];
    expect(closedInc.notes).toContain(NEW_NORMAL_NOTE);
    // Nothing recovered: no reading to come back to (D47's recoveredTo), the jump stays as the drop-in reading.
    expect(closedInc.recoveredTo).toBeUndefined();
    expect(closedInc.after).toBe($h(30));
    expect(closedAt - openedAt).toBeLessThanOrEqual(SPIKE_NEW_NORMAL_MINUTES + 1);
    expect(r.open).toEqual([]);
    // The baseline is re-seated at the new level.
    expect(r.baselines.byObject['in:default:new_source'].mean).toBeCloseTo($h(30), -3);
  });

  for (const profile of ['default', 'demo'] as const) {
    it(`after the new-normal close, 120 more minutes at the level open nothing (${profile} profile: the re-seated baseline holds on its own)`, () => {
      const r = replay([...repeat($h(2), 60), ...repeat($h(30), 300)], { key: 'in:default:new_source', profile });
      expect(r.opened).toHaveLength(1);
      expect(r.closed).toHaveLength(1);
      expect(r.closed[0].incident.notes).toContain(NEW_NORMAL_NOTE);
      expect(r.closed[0].minute).toBeLessThan(60 + SPIKE_NEW_NORMAL_MINUTES + 5);
      expect(r.open).toEqual([]);
    });
  }

  it('a new level with ordinary minute-to-minute noise (±6 %, and a stray ±25 % minute) still closes as the new normal', () => {
    const noise = [0.04, -0.06, 0.02, 0.05, -0.03, 0.06, -0.05, 0.01, -0.02, 0.03];
    const level = Array.from({ length: 180 }, (_, m) => Math.round($h(30) * (1 + (m % 37 === 20 ? 0.25 : noise[m % noise.length]))));
    const r = replay([...repeat($h(2), 60), ...level], { key: 'in:default:new_source' });
    expect(r.opened).toHaveLength(1);
    expect(r.closed).toHaveLength(1);
    expect(r.closed[0].incident.notes).toContain(NEW_NORMAL_NOTE);
    expect(r.closed[0].minute - r.opened[0].minute).toBeLessThanOrEqual(SPIKE_NEW_NORMAL_MINUTES + 2);
  });

  it('a muted object is not declared the new normal (recovery still works)', () => {
    const r = replay([...repeat($h(2), 60), ...repeat($h(30), 150), ...repeat($h(2), 10)], { key: 'in:default:new_source', muted: (m) => m >= 62 });
    expect(r.opened).toHaveLength(1);
    expect(r.closed).toHaveLength(1);
    expect(r.closed[0].incident.notes).not.toContain(NEW_NORMAL_NOTE);
    expect(r.closed[0].incident.recoveredTo).toBe($h(2));
  });
});

describe('P1-F06 · probe C: a morning ramp', () => {
  // +1 %/minute from $20/h for 4 hours (the probe), then flat at the top for 2 hours.
  const RAMP = 240;
  const ramp = Array.from({ length: RAMP }, (_, m) => Math.round($h(20) * (1 + m * 0.01)));
  const series = [...ramp, ...repeat(ramp[RAMP - 1], 120)];

  it('opens a warning while it climbs, then closes within 60 minutes of the ramp settling', () => {
    const r = replay(series, { key: 'in:default:ramp_source' });
    expect(r.opened.length).toBeGreaterThanOrEqual(1);
    // The first reading over the floored band is well under 2× the baseline: medium, not a page.
    expect(r.opened[0].incident.severity).toBe('medium');
    expect(r.open).toEqual([]);
    const last = r.closed.at(-1)!;
    expect(last.minute).toBeLessThanOrEqual(RAMP + 60);
    expect(last.incident.notes).toContain(NEW_NORMAL_NOTE);
  });

  it('escalates to high once the reading passes twice the baseline, and says so once', () => {
    const r = replay(series, { key: 'in:default:ramp_source' });
    const firstOpen = r.opened[0];
    const before = firstOpen.incident.before;
    const escalations = r.updated.filter((u) => u.incident.id === firstOpen.incident.id && u.incident.severity === 'high');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].incident.after).toBeGreaterThanOrEqual(2 * before);
    // Still climbing when it escalated: the incident stays open through the ramp and closes only after it settles.
    expect(escalations[0].minute).toBeLessThan(RAMP);
    expect(r.closed.at(-1)!.minute).toBeGreaterThanOrEqual(RAMP);
  });

  it('a ramp that never settles is never "the new normal" (the level band is ±10 %, not the whole climb)', () => {
    const r = replay(ramp, { key: 'in:default:ramp_source' });
    expect(r.opened).toHaveLength(1);
    expect(r.closed).toEqual([]);
    expect(r.open).toHaveLength(1);
  });
});

describe('P1-F06 · the σ floor and the medium tier', () => {
  it('σ is floored at 15 % of the mean and $1/hour', () => {
    expect(spikeSigma({ mean: $h(100), variance: 0, samples: 20, warm: [] })).toBe($h(15));
    expect(spikeSigma({ mean: $h(2), variance: 0, samples: 20, warm: [] })).toBe($h(1));
    expect(spikeSigma({ mean: $h(100), variance: $h(30) ** 2, samples: 20, warm: [] })).toBe($h(30));
    expect(spikeSigma(undefined)).toBe($h(1));
  });

  it('a flat $100/h baseline (σ = 0) does not page on a $6/h wobble (it did: any Δ ≥ $5/h was "3σ")', () => {
    const r = replay([...repeat($h(100), 30), ...repeat($h(106), 10)]);
    expect(r.opened).toEqual([]);
  });

  it('a rise past the floored band but under 2× opens medium; 2× and over opens high', () => {
    const medium = replay([...repeat($h(100), 30), ...repeat($h(160), 3)]);
    expect(medium.opened[0]?.incident.severity).toBe('medium');
    const high = replay([...repeat($h(100), 30), ...repeat($h(210), 3)]);
    expect(high.opened[0]?.incident.severity).toBe('high');
  });

  it('an open medium spike that grows past 2× is escalated to high (one update)', () => {
    const r = replay([...repeat($h(100), 30), ...repeat($h(160), 5), ...repeat($h(250), 5)]);
    expect(r.opened).toHaveLength(1);
    expect(r.opened[0].incident.severity).toBe('medium');
    expect(r.updated).toHaveLength(1);
    expect(r.updated[0].incident).toMatchObject({ severity: 'high', after: $h(250) });
    expect(r.updated[0].incident.impactPerDayM).toBe(($h(250) - r.opened[0].incident.before) * 24);
  });
});

describe('P1-F06 · a new-normal close never says "Recovered"', () => {
  const r = replay([...repeat($h(2), 60), ...repeat($h(30), 180)], { key: 'in:default:new_source' });
  const closed = r.closed[0].incident;
  const canonical = canonicalPayload('incident.closed', { incident: closed, workspace: 'w', linkBase: 'https://x/apps/a/meter-reader', sentAt: closed.closedAt });
  const recovered = replay([...repeat($h(2), 60), ...repeat($h(30), 20), ...repeat($h(2), 10)], { key: 'in:default:new_source' }).closed[0].incident;
  const back = canonicalPayload('incident.closed', { incident: recovered, workspace: 'w', linkBase: 'https://x/apps/a/meter-reader', sentAt: recovered.closedAt });

  it('the bell, Slack, ServiceNow and the plain text say "New normal", with a neutral glyph', () => {
    expect(renderAlert(canonical).title).toMatch(/^New normal: /);
    const slack = slackPayload(canonical);
    expect(slack.text).toMatch(/^:large_blue_circle: New normal: /);
    expect(servicenowPayload(canonical).short_description).toMatch(/^New normal: /);
    expect(incidentPlainText(canonical.incident!)).toContain('Closed as the new normal');
    expect(incidentPlainText(canonical.incident!)).not.toContain('recovered to');
  });

  it('a real recovery still reads "Recovered" in green', () => {
    expect(renderAlert(back).title).toMatch(/^Recovered: /);
    expect(slackPayload(back).text).toMatch(/^:large_green_circle: Recovered: /);
  });
});
