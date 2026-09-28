// Net of Cribl (core/net.ts, DECISIONS D48) and the Receipt's words for it and for an unreadable snapshot
// (src/views/Receipt/text.ts): the cost is a rate over the metered span, the payback under 1× is a share, and the
// ghost's sentence names what actually went wrong (P1-H03).

import { describe, expect, it } from 'vitest';
import { CRIBL_LIST_MC_PER_GB, criblCostCents, criblCostPerMinuteM, impliedCostPerGbM, meteredSpan, netOfCribl } from '../../core/net.ts';
import { netBasisLine, netSpanWords, paybackWords, unavailableCaption } from '../../src/views/Receipt/text.ts';

// D48: the demo org's $4,380.97 a month = 450.1 GB/day × $0.32/GB × 365 ÷ 12.
const DEMO_COST_CENTS = 438_097;
const DEMO_GB_PER_DAY = 450.1;

describe('core/net', () => {
  it('a usable monthly cost is a positive finite number of cents', () => {
    expect(criblCostCents(438_097)).toBe(438_097);
    expect(criblCostCents(undefined)).toBeUndefined();
    expect(criblCostCents(0)).toBeUndefined();
    expect(criblCostCents(-1)).toBeUndefined();
    expect(criblCostCents(Number.NaN)).toBeUndefined();
    expect(criblCostCents(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('the cost per minute is monthly × 12 ÷ 525,600 (a year of minutes), so a day is monthly × 12 ÷ 365', () => {
    expect(criblCostPerMinuteM(1_000_000) * 525_600).toBeCloseTo(1_000_000 * 1000 * 12, 3);
    const perDay = criblCostPerMinuteM(DEMO_COST_CENTS) * 1440;
    expect(perDay).toBeCloseTo((DEMO_COST_CENTS * 1000 * 12) / 365, 6);
    // D48: "Cribl ≈ $144/day".
    expect(Math.round(perDay / 100_000)).toBe(144);
  });

  it('net = saved − the cost for the same minutes; payback = saved ÷ that cost (unrounded)', () => {
    const day = 1440;
    const savedM = 27_400_000; // $274 saved in a day (D48)
    const n = netOfCribl(savedM, day, DEMO_COST_CENTS)!;
    expect(n.minutes).toBe(day);
    expect(n.costM).toBe(Math.round(criblCostPerMinuteM(DEMO_COST_CENTS) * day));
    expect(n.netM).toBe(savedM - n.costM);
    expect(n.paybackX).toBeCloseTo(savedM / (criblCostPerMinuteM(DEMO_COST_CENTS) * day), 12);
    // D48: "net ≈ $130/day, paid for itself ≈ 1.9×".
    expect(Math.round(n.netM / 100_000)).toBe(130);
    expect(n.paybackX!.toFixed(1)).toBe('1.9');
    expect(n.costPerDayM).toBeCloseTo(criblCostPerMinuteM(DEMO_COST_CENTS) * 1440, 9);
  });

  it('a net can be negative, and no cost or no span is no net', () => {
    expect(netOfCribl(0, 60, DEMO_COST_CENTS)).toMatchObject({ netM: -Math.round(criblCostPerMinuteM(DEMO_COST_CENTS) * 60), paybackX: 0 });
    expect(netOfCribl(100, 60, undefined)).toBeNull();
    expect(netOfCribl(100, 0, DEMO_COST_CENTS)).toBeNull();
    expect(netOfCribl(100, -5, DEMO_COST_CENTS)).toBeNull();
    expect(netOfCribl(Number.NaN, 60, DEMO_COST_CENTS)).toBeNull();
    expect(netOfCribl(100, Number.POSITIVE_INFINITY, DEMO_COST_CENTS)).toBeNull();
  });

  it('the metered span starts at the later of the period start and when collecting began', () => {
    const start = Date.parse('2026-09-01T00:00:00Z');
    const sweep = Date.parse('2026-09-26T12:00:00Z');
    expect(meteredSpan(start, sweep, Date.parse('2026-08-15T00:00:00Z'))).toEqual({ fromMs: start, minutes: 25.5 * 1440, sinceCollecting: false });
    const since = Date.parse('2026-09-26T06:20:00Z');
    expect(meteredSpan(start, sweep, since)).toEqual({ fromMs: since, minutes: 340, sinceCollecting: true });
    expect(meteredSpan(start, sweep, undefined).fromMs).toBe(start);
    expect(meteredSpan(start, sweep, Number.NaN).fromMs).toBe(start);
    // Collecting "after" the sweep (a clock skew) is an empty span, never a negative one.
    expect(meteredSpan(start, sweep, sweep + 60_000).minutes).toBe(0);
  });

  it("what the monthly cost comes to per GB received, beside Cribl's $0.32 list price", () => {
    expect(CRIBL_LIST_MC_PER_GB).toBe(32_000);
    const implied = impliedCostPerGbM(DEMO_COST_CENTS, DEMO_GB_PER_DAY * 1e9)!;
    // The demo org's cost was built from the list price, so it comes back to $0.32 a GB.
    expect(implied / 100_000).toBeCloseTo(0.32, 4);
    expect(impliedCostPerGbM(DEMO_COST_CENTS, 0)).toBeUndefined();
    expect(impliedCostPerGbM(undefined, 1e12)).toBeUndefined();
  });
});

describe('Receipt net words', () => {
  it('the span a cost is prorated to reads in minutes, hours or days', () => {
    expect(netSpanWords(0.4)).toBe('1 minute');
    expect(netSpanWords(38)).toBe('38 minutes');
    expect(netSpanWords(60)).toBe('1.0 hour');
    expect(netSpanWords(852)).toBe('14.2 hours');
    expect(netSpanWords(1440)).toBe('1.0 day');
    expect(netSpanWords(36_576)).toBe('25.4 days');
    expect(netSpanWords(0)).toBe('0 minutes');
  });

  it('the basis under the hero net says what the cost covers', () => {
    expect(netBasisLine({ costM: 839_041_096, minutes: 36_750, per: undefined })).toBe('Cribl cost $8,390, prorated to the 25.5 days metered');
    expect(netBasisLine({ costM: 5_257_164_000, minutes: 525_600, per: 'year' })).toBe('Cribl cost $52,572 a year');
  });

  it('a payback under 1× is a share of the cost, floored so it never reads 100% while short', () => {
    expect(paybackWords(1.9)).toBe('Paid for itself 1.9×');
    expect(paybackWords(1)).toBe('Paid for itself 1.0×');
    expect(paybackWords(0.4)).toBe('Covered 40% of its cost');
    expect(paybackWords(0.996)).toBe('Covered 99% of its cost');
    expect(paybackWords(-0.2)).toBe('Covered 0% of its cost');
  });
});

describe('Receipt ghost caption by failure (P1-H03)', () => {
  it('each failure kind has its own sentence; only a 403 talks about the role', () => {
    expect(unavailableCaption({ kind: 'forbidden' })).toBe("Figures appear here once your role can read Meter Reader's savings.");
    expect(unavailableCaption({ kind: 'rate-limited' })).toBe('Figures appear after the next sweep.');
    expect(unavailableCaption({ kind: 'unauthorized' })).toBe('Figures appear here once you sign in to Cribl again.');
    expect(unavailableCaption({ kind: 'server' })).toBe('Figures appear here once Cribl answers again.');
    expect(unavailableCaption({ kind: 'network' })).toBe('Figures appear here once Cribl answers again.');
    const others = (['rate-limited', 'unauthorized', 'server', 'network'] as const).map((kind) => unavailableCaption({ kind }));
    for (const s of others) expect(s).not.toContain('role');
  });
});
