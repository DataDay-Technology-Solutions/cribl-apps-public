// tests/unit/r115-pricedsince.test.ts — 1.1.5: where priced traffic began (Snapshot.pricedSince), the minute the
// annualized run rate is measured from. Two first-run traps a 1.1.4 hardening pass found (HARDENING_1.1.4 A1, A2):
//
// A1. A destination whose counterfactual is "Nowhere" (archive-only data) carries paid money but never would-have-paid.
//     pricedSince looked only for would-have-paid, so under Nowhere it reset to the window's end on every sweep, the
//     basis shrank to one minute, and the Receipt's annualized "You paid" read the whole day's spend over that minute:
//     $321,851 a year and climbing about $2.75K a sweep, for about $2,717 a year of real spend. Paid money is traffic.
// A2. Start the meter before any traffic exists: the sweep that first finds the new flow also rewrites the minute before
//     its window (the late-minute rewrite), and that minute falls before the previous snapshot's pricedSince. It was
//     rejected, pricedSince fell to the window's end, and the rewritten minute's savings stayed in the rate while its
//     minute left the basis: up to 3× the true rate, still 1.19× after 13 minutes. Any priced minute at or after
//     collecting since is accepted.
//
// End-to-end runs of both are in tests/integration/r115-annualized-paid-only-and-early-start.test.ts.

import { describe, expect, it } from 'vitest';
import type { Flow, Headline, MinuteRow, Snapshot, TotalsDoc } from '../../core/types.ts';
import { buildSnapshot, type SnapshotParts } from '../../core/snapshot.ts';
import { appendPriceVersion, emptyPrices, priceMinute } from '../../core/pricing.ts';
import { addMinuteToTotals, emptyTotals } from '../../core/rollups.ts';
import { makeFlowKey } from '../../core/flows.ts';
import { defaultSettings } from '../../core/settings.ts';
import { localDayKey } from '../../core/time.ts';

const MIN = 60_000;
const TZ = 'UTC';
const PRICE = 225_000; // $2.25/GB
const IN_B = 30_000_000; // 30 MB a minute in, half dropped
const OUT_B = 15_000_000;
const MINUTES_PER_YEAR = 525_600;

const FLOW: Flow = {
  key: makeFlowKey('default', 'in_datagen', 'r_new', 'drop_half', 'devnull'),
  groupId: 'default',
  inputId: 'in_datagen',
  routeId: 'r_new',
  pipelineId: 'drop_half',
  outputId: 'devnull',
  attribution: 'route',
};

type Kind = 'same' | 'none';

function row(t: number, kind: Kind): MinuteRow {
  return { t: new Date(t).toISOString(), inB: IN_B, outB: OUT_B, inE: 100, outE: 50, ...priceMinute({ inB: IN_B, outB: OUT_B }, PRICE, PRICE, kind) };
}

interface Scene {
  /** where collecting began (the first run's reach) */
  collectingSinceMs: number;
  /** the minute this sweep ends on: [windowEnd − 1 min, windowEnd) */
  windowEndMs: number;
  /** the first minute that carried traffic, and its counterfactual */
  trafficFromMs: number;
  kind: Kind;
  /** the minute rows the sweep passes begin here (default: the traffic start) */
  rowsFromMs?: number;
  previous?: Snapshot;
}

/**
 * One sweep's parts: every minute from collecting since to the window's end is metered, each minute from the traffic
 * start carries the flow's row, and the totals are exactly the sum of those minutes (as the sweep keeps them).
 */
function scene(s: Scene): SnapshotParts {
  const rowsFrom = s.rowsFromMs ?? s.trafficFromMs;
  const rows: MinuteRow[] = [];
  let totals: TotalsDoc = emptyTotals('x');
  for (let t = s.collectingSinceMs; t < s.windowEndMs; t += MIN) {
    const r = t >= s.trafficFromMs ? row(t, s.kind) : undefined;
    totals = addMinuteToTotals(totals, localDayKey(t, TZ), r ?? { whpM: 0, paidM: 0, savedM: 0 });
    if (r && t >= rowsFrom) rows.push(r);
  }
  const prices = appendPriceVersion(emptyPrices('x'), { devnull: { milliCentsPerGb: PRICE, counterfactual: { kind: s.kind } } }, s.collectingSinceMs);
  return {
    sweepAtMs: s.windowEndMs + 20_000,
    windowStartMs: s.windowEndMs - MIN,
    windowEndMs: s.windowEndMs,
    mode: 'ui',
    settings: defaultSettings('x', TZ),
    prices,
    flows: [FLOW],
    minuteRows: { [FLOW.key]: rows },
    totals,
    collectingSinceMs: s.collectingSinceMs,
    incidents: [],
    timeline: [],
    deliveries: [],
    calls: 1,
    metricsSource: 'metrics-query',
    zone: TZ,
    rowsFromMs: s.previous ? rowsFrom : s.collectingSinceMs,
    ...(s.previous ? { previous: s.previous } : {}),
  };
}

/** A previous snapshot as a sweep left it: its pricedSince (and count), and its headline's traffic figures. */
function previous(pricedSinceMs: number, headline: Partial<Headline>, emptyMinutes?: number): Snapshot {
  return {
    schemaVersion: 1,
    zone: TZ,
    pricedSince: new Date(pricedSinceMs).toISOString(),
    ...(emptyMinutes !== undefined ? { pricedSinceEmptyMinutes: emptyMinutes } : {}),
    headline: { whp30dM: 0, whpMtdM: 0, paid30dM: 0, paidMtdM: 0, ...headline } as Headline,
    ratioSeries: [],
  } as unknown as Snapshot;
}

const DAY0 = Date.UTC(2026, 8, 29); // Tue 29 Sep 2026, 00:00 UTC
const at = (h: number, m = 0) => DAY0 + h * 3_600_000 + m * MIN;
/** 15 MB a minute at $2.25/GB: 3,375 m¢ a minute, paid (Nowhere) or saved (This destination). */
const PER_MIN_M = Math.round((OUT_B * PRICE) / 1e9);
const RATE_M = PER_MIN_M * MINUTES_PER_YEAR;

describe('1.1.5 A1 · a paid-only destination ("Nowhere") is traffic', () => {
  it('a first run over Nowhere traffic finds where it began and annualizes paid over those minutes only', () => {
    expect(PER_MIN_M).toBe(3_375);
    const s = buildSnapshot(scene({ collectingSinceMs: at(0), trafficFromMs: at(12), windowEndMs: at(14), kind: 'none' }));
    expect(s.pricedSince).toBe(new Date(at(12)).toISOString()); // 1.1.4: the window's end (14:00)
    expect(s.pricedSinceEmptyMinutes).toBe(12 * 60);
    expect(s.headline.annualizedM).toBe(0);
    expect(s.headline.annualizedWhpM).toBe(0);
    expect(s.headline.annualizedPaidM).toBe(RATE_M); // 1.1.4: 120 minutes of spend over 1 minute, 120× the truth
    expect(Math.round(s.headline.annualizedFromDays * 1440)).toBe(120);
  });

  it('a kept pricedSince stands once the workspace has paid traffic, after its start has left the rows', () => {
    // The previous snapshot found Nowhere traffic from 12:00; this sweep's rows (its last two hours) begin at 13:30.
    const prev = previous(at(12), { paid30dM: 1, paidMtdM: 1 }, 12 * 60);
    const s = buildSnapshot(scene({ collectingSinceMs: at(0), trafficFromMs: at(12), rowsFromMs: at(13, 30), windowEndMs: at(15, 30), kind: 'none', previous: prev }));
    expect(s.pricedSince).toBe(new Date(at(12)).toISOString()); // 1.1.4: the window's end, every sweep
    expect(s.pricedSinceEmptyMinutes).toBe(12 * 60);
    expect(s.headline.annualizedPaidM).toBe(RATE_M);
  });

  it('the annualized paid is stable from sweep to sweep: no growth', () => {
    let prev: Snapshot | undefined;
    const paid: number[] = [];
    for (let k = 0; k < 15; k++) {
      const windowEnd = at(14, k);
      const s = buildSnapshot(scene({ collectingSinceMs: at(0), trafficFromMs: at(12), rowsFromMs: prev ? windowEnd - 60 * MIN : undefined, windowEndMs: windowEnd, kind: 'none', ...(prev ? { previous: prev } : {}) }));
      expect(s.pricedSince).toBe(new Date(at(12)).toISOString());
      paid.push(s.headline.annualizedPaidM ?? Number.NaN);
      prev = s;
    }
    expect(new Set(paid)).toEqual(new Set([RATE_M])); // 1.1.4: $321,851 → $360,336 over 15 sweeps
  });
});

describe('1.1.5 A2 · Start the meter before traffic: the rewritten minute counts', () => {
  it('the minute before the window, rewritten by the sweep that first finds the flow, is where priced traffic began', () => {
    // Started at 00:00 with no traffic; the previous sweep ended 18:04 and kept pricedSince there (no traffic yet). This
    // sweep meters 18:04 and rewrites 18:03, the first minute the new flow is known in.
    const prev = previous(at(18, 4), {}, 18 * 60 + 4);
    const s = buildSnapshot(scene({ collectingSinceMs: at(0), trafficFromMs: at(18, 3), windowEndMs: at(18, 5), kind: 'same', previous: prev }));
    expect(s.pricedSince).toBe(new Date(at(18, 3)).toISOString()); // 1.1.4: 18:05, the window's end
    expect(s.pricedSinceEmptyMinutes).toBe(18 * 60 + 3);
    expect(s.headline.annualizedM).toBe(RATE_M); // 1.1.4: two minutes' savings over a one-minute basis, 2×
    expect(Math.round(s.headline.annualizedFromDays * 1440)).toBe(2);
  });

  it('then the rate holds at the truth and the caption counts every metered traffic minute', () => {
    let prev = previous(at(18, 4), {}, 18 * 60 + 4);
    for (let k = 5; k <= 20; k++) {
      const s = buildSnapshot(scene({ collectingSinceMs: at(0), trafficFromMs: at(18, 3), rowsFromMs: at(18, 3), windowEndMs: at(18, k), kind: 'same', previous: prev }));
      expect(s.pricedSince).toBe(new Date(at(18, 3)).toISOString());
      expect(s.headline.annualizedM).toBe(RATE_M); // 1.1.4: 3.0× at its peak, 1.19× after 13 minutes
      expect(Math.round(s.headline.annualizedFromDays * 1440)).toBe(k - 3); // 1.1.4: "last 3 minutes" when 5 were metered
      prev = s;
    }
  });

  it('a priced minute before collecting since is still not where traffic began', () => {
    const prev = previous(at(18, 4), {}, 18 * 60 + 4);
    const p = scene({ collectingSinceMs: at(18), trafficFromMs: at(18), windowEndMs: at(18, 5), kind: 'same', previous: prev });
    const early = row(at(17, 59), 'same');
    p.minuteRows = { [FLOW.key]: [early, ...p.minuteRows[FLOW.key]] };
    const s = buildSnapshot(p);
    expect(s.pricedSince).toBe(new Date(at(18, 5)).toISOString());
  });
});

describe('1.1.5 · flows that would have paid read exactly as before', () => {
  it('a first run over traffic that began before the install: the first minute with would-have-paid', () => {
    const s = buildSnapshot(scene({ collectingSinceMs: at(0), trafficFromMs: at(12), windowEndMs: at(14), kind: 'same' }));
    expect(s.pricedSince).toBe(new Date(at(12)).toISOString());
    expect(s.headline.annualizedM).toBe(RATE_M);
  });

  it('a kept pricedSince stands once the workspace has had would-have-paid traffic', () => {
    const prev = previous(at(12), { whp30dM: 1, whpMtdM: 1, paid30dM: 1, paidMtdM: 1 }, 12 * 60);
    const s = buildSnapshot(scene({ collectingSinceMs: at(0), trafficFromMs: at(12), rowsFromMs: at(13), windowEndMs: at(14), kind: 'same', previous: prev }));
    expect(s.pricedSince).toBe(new Date(at(12)).toISOString());
    expect(s.pricedSinceEmptyMinutes).toBe(12 * 60);
  });

  it('no traffic yet: pricedSince waits at the window end', () => {
    const prev = previous(at(18, 4), {}, 18 * 60 + 4);
    const s = buildSnapshot(scene({ collectingSinceMs: at(0), trafficFromMs: at(23), windowEndMs: at(18, 5), kind: 'same', previous: prev }));
    expect(s.pricedSince).toBe(new Date(at(18, 5)).toISOString());
    expect(s.headline.annualizedM).toBe(0);
  });

  it('traffic found at or after the kept minute: exactly that minute, as in 1.1.4', () => {
    const prev = previous(at(18, 4), {}, 18 * 60 + 4);
    const s = buildSnapshot(scene({ collectingSinceMs: at(0), trafficFromMs: at(18, 4), windowEndMs: at(18, 5), kind: 'same', previous: prev }));
    expect(s.pricedSince).toBe(new Date(at(18, 4)).toISOString());
    expect(s.headline.annualizedM).toBe(RATE_M);
  });

  it('a previous snapshot from before pricedSince existed keeps the collecting-since basis', () => {
    const prev = { schemaVersion: 1, headline: { whp30dM: 0, whpMtdM: 0 }, ratioSeries: [] } as unknown as Snapshot;
    const s = buildSnapshot(scene({ collectingSinceMs: at(0), trafficFromMs: at(12), windowEndMs: at(14), kind: 'none', previous: prev }));
    expect(s.pricedSince).toBeUndefined();
  });
});
