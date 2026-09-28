import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { PricesDoc, PriceVersion, TotalsDoc } from '../../core/types.ts';
import {
  MAX_PRICE_VERSIONS,
  appendPriceVersion,
  computeHeadline,
  effectivePrices,
  emptyPrices,
  gb,
  outputPriceKey,
  priceEntryAt,
  priceMinute,
  ratio,
} from '../../core/pricing.ts';
import { addDaysToKey, localDayStartMs } from '../../core/time.ts';

const T0 = Date.parse('2026-09-20T00:00:00Z');

describe('units and keys', () => {
  it('uses decimal GB and group-scoped keys', () => {
    expect(gb(1e9)).toBe(1);
    expect(gb(2.5e9)).toBe(2.5);
    expect(outputPriceKey('default', 'mrd_siem_prod')).toBe('default:mrd_siem_prod');
  });
});

describe('price versions', () => {
  const prices = (): PricesDoc => {
    let p = emptyPrices('2026-09-20T00:00:00.000Z');
    p = appendPriceVersion(p, { mrd_siem_prod: { milliCentsPerGb: 250_000, preset: 'splunk_cloud' } }, T0);
    p = appendPriceVersion(p, { 'default:mrd_archive_s3': { milliCentsPerGb: 3_000, preset: 's3' } }, T0 + 3_600_000);
    p = appendPriceVersion(p, { mrd_siem_prod: { milliCentsPerGb: 200_000 } }, T0 + 7_200_000);
    return p;
  };
  it('picks the newest version effective at t', () => {
    const p = prices();
    // D25: history older than an output's FIRST price is priced at that first price (seeded backfill)…
    expect(priceEntryAt(p, 'default', 'mrd_siem_prod', T0 - 1)?.milliCentsPerGb).toBe(250_000);
    expect(priceEntryAt(p, 'default', 'mrd_siem_prod', T0)?.milliCentsPerGb).toBe(250_000);
    expect(priceEntryAt(p, 'default', 'mrd_siem_prod', T0 + 7_200_000 - 1)?.milliCentsPerGb).toBe(250_000);
    expect(priceEntryAt(p, 'default', 'mrd_siem_prod', T0 + 7_200_000)?.milliCentsPerGb).toBe(200_000);
    // …while a later CHANGE still applies only from its own effectiveFrom (never rewrites history).
    expect(priceEntryAt(p, 'default', 'mrd_archive_s3', T0 + 1)?.milliCentsPerGb).toBe(3_000);
    expect(priceEntryAt(p, 'default', 'mrd_nope', T0 + 1)).toBeUndefined();
    expect(priceEntryAt(p, 'default', 'mrd_archive_s3', T0 + 3_600_000)?.milliCentsPerGb).toBe(3_000);
  });
  it('writes complete versions and never rewrites history', () => {
    const p = prices();
    expect(p.versions).toHaveLength(3);
    expect(Object.keys(p.versions[2].byOutputId).sort()).toEqual(['default:mrd_archive_s3', 'mrd_siem_prod']);
    expect(p.versions[0].byOutputId.mrd_siem_prod.milliCentsPerGb).toBe(250_000);
  });
  it('falls through hand-written partial versions and sorts by effectiveFrom', () => {
    const p: PricesDoc = {
      schemaVersion: 1,
      updatedAt: '',
      versions: [
        { effectiveFrom: '2026-09-21T00:00:00.000Z', byOutputId: { b: { milliCentsPerGb: 2 } } },
        { effectiveFrom: '2026-09-20T00:00:00.000Z', byOutputId: { a: { milliCentsPerGb: 1 } } },
        { effectiveFrom: 'garbage', byOutputId: { a: { milliCentsPerGb: 99 } } },
      ],
    };
    const t = Date.parse('2026-09-22T00:00:00Z');
    expect(priceEntryAt(p, 'g', 'a', t)?.milliCentsPerGb).toBe(1);
    expect(priceEntryAt(p, 'g', 'b', t)?.milliCentsPerGb).toBe(2);
    // in-place mutation is noticed
    p.versions.push({ effectiveFrom: '2026-09-21T12:00:00.000Z', byOutputId: { a: { milliCentsPerGb: 5 } } });
    expect(priceEntryAt(p, 'g', 'a', t)?.milliCentsPerGb).toBe(5);
  });
  it('compacts to at most 50 versions by dropping the oldest, keeping the newer start and every output priced', () => {
    let p = emptyPrices('x');
    for (let i = 0; i < 60; i++) p = appendPriceVersion(p, { [`o${i}`]: { milliCentsPerGb: i } }, T0 + i * 1000);
    expect(p.versions).toHaveLength(MAX_PRICE_VERSIONS);
    // P1-F08: the ten oldest versions fell away; the oldest kept version starts at ITS OWN instant.
    expect(p.versions[0].effectiveFrom).toBe(new Date(T0 + 10_000).toISOString());
    expect(priceEntryAt(p, 'g', 'o59', T0 + 59_000)?.milliCentsPerGb).toBe(59);
    expect(priceEntryAt(p, 'g', 'o0', T0 + 59_000)?.milliCentsPerGb).toBe(0);
    expect(p.updatedAt).toBe(new Date(T0 + 59_000).toISOString());
  });
  it('P1-F08: after 52 versions a minute between the two oldest never reads the newer price', () => {
    // One output repriced every day: v1 = $1.00 (Jan 1), v2 = $1.01 (Jan 2), v3 = $1.02 (Jan 3), …
    const DAY = 86_400_000;
    const JAN1 = Date.parse('2026-01-01T00:00:00Z');
    let p = emptyPrices('x');
    for (let i = 0; i < 52; i++) p = appendPriceVersion(p, { siem: { milliCentsPerGb: 100_000 + i * 1_000 } }, JAN1 + i * DAY);
    expect(p.versions).toHaveLength(MAX_PRICE_VERSIONS);
    // Jan 1 12:00 lies between v1 and v2, Jan 2 12:00 between v2 and v3. Both fell out of the history; they now
    // read the documented first-price rule (D25): the oldest price still kept, v3's $1.02 — never a price that
    // only took effect after them and was stamped with the older start (the defect read v3 at Jan 1).
    const kept = p.versions[0];
    expect(kept.effectiveFrom).toBe(new Date(JAN1 + 2 * DAY).toISOString());
    expect(priceEntryAt(p, 'default', 'siem', JAN1 + DAY / 2)?.milliCentsPerGb).toBe(102_000);
    expect(priceEntryAt(p, 'default', 'siem', JAN1 + 2 * DAY + DAY / 2)?.milliCentsPerGb).toBe(102_000);
    // Every version still in the history starts when its own price took effect.
    for (let i = 2; i < 52; i++) expect(priceEntryAt(p, 'default', 'siem', JAN1 + i * DAY)?.milliCentsPerGb).toBe(100_000 + i * 1_000);
    // No price is ever read before the instant it was set, except through the first-price rule.
    for (let i = 3; i < 52; i++) expect(priceEntryAt(p, 'default', 'siem', JAN1 + i * DAY - 1)?.milliCentsPerGb).toBe(100_000 + (i - 1) * 1_000);
  });
  it('P1-F08: an output priced only in a dropped version stays priced (merged into the newer start)', () => {
    const hand: PricesDoc = {
      schemaVersion: 1,
      updatedAt: '',
      versions: Array.from({ length: MAX_PRICE_VERSIONS }, (_, i): PriceVersion => ({
        effectiveFrom: new Date(T0 + i * 1000).toISOString(),
        byOutputId: i === 0 ? { legacy: { milliCentsPerGb: 42 } } : { siem: { milliCentsPerGb: i } },
      })),
    };
    const p = appendPriceVersion(hand, { siem: { milliCentsPerGb: 999 } }, T0 + 60_000);
    expect(p.versions).toHaveLength(MAX_PRICE_VERSIONS);
    expect(p.versions[0].effectiveFrom).toBe(new Date(T0 + 1000).toISOString());
    expect(priceEntryAt(p, 'g', 'legacy', T0 + 1000)?.milliCentsPerGb).toBe(42);
    expect(priceEntryAt(p, 'g', 'siem', T0 + 1000)?.milliCentsPerGb).toBe(1);
  });
  it('lets a plain outputId key supersede an older group-scoped key', () => {
    let p = appendPriceVersion(emptyPrices('x'), { 'default:siem': { milliCentsPerGb: 100 }, 'other:siem': { milliCentsPerGb: 7 } }, T0);
    p = appendPriceVersion(p, { siem: { milliCentsPerGb: 200 } }, T0 + 1000);
    expect(priceEntryAt(p, 'default', 'siem', T0 + 1000)?.milliCentsPerGb).toBe(200);
    expect(priceEntryAt(p, 'default', 'siem', T0)?.milliCentsPerGb).toBe(100);
    p = appendPriceVersion(p, { 'default:siem': { milliCentsPerGb: 300 } }, T0 + 2000);
    expect(priceEntryAt(p, 'default', 'siem', T0 + 2000)?.milliCentsPerGb).toBe(300);
    expect(priceEntryAt(p, 'other', 'siem', T0 + 2000)?.milliCentsPerGb).toBe(200);
  });
  it('appends to a missing document', () => {
    const p = appendPriceVersion(undefined as unknown as PricesDoc, { a: { milliCentsPerGb: 1 } }, T0);
    expect(p.versions).toHaveLength(1);
  });
});

describe('effectivePrices and the counterfactual', () => {
  let p = emptyPrices('x');
  p = appendPriceVersion(
    p,
    {
      siem: { milliCentsPerGb: 250_000, preset: 'splunk_cloud' },
      archive: { milliCentsPerGb: 3_000, preset: 's3', counterfactual: { kind: 'other', outputId: 'siem' } },
      nowhere: { milliCentsPerGb: 3_000, counterfactual: { kind: 'none' } },
      self: { milliCentsPerGb: 7, counterfactual: { kind: 'other', outputId: 'self' } },
      orphan: { milliCentsPerGb: 7, counterfactual: { kind: 'other', outputId: 'missing' } },
      toDevnull: { milliCentsPerGb: 2_300, counterfactual: { kind: 'other', outputId: 'devnull' } },
      toFree: { milliCentsPerGb: 2_300, counterfactual: { kind: 'other', outputId: 'free' } },
      free: { milliCentsPerGb: 0, preset: 'internal' },
      zero: { milliCentsPerGb: 0 },
    },
    T0,
  );
  const t = T0 + 1;
  it('same → own price', () => {
    expect(effectivePrices(p, 'default', 'siem', t)).toEqual({
      paidMcPerGb: 250_000,
      whpMcPerGb: 250_000,
      counterfactual: { kind: 'same' },
      unpriced: false,
      counterfactualUnpriced: false,
    });
  });
  it('other → the other output’s price; none → 0', () => {
    expect(effectivePrices(p, 'default', 'archive', t).whpMcPerGb).toBe(250_000);
    expect(effectivePrices(p, 'default', 'archive', t).paidMcPerGb).toBe(3_000);
    expect(effectivePrices(p, 'default', 'nowhere', t).whpMcPerGb).toBe(0);
    expect(effectivePrices(p, 'default', 'self', t).whpMcPerGb).toBe(7);
    expect(effectivePrices(p, 'default', 'orphan', t).whpMcPerGb).toBe(0);
  });
  it('flags unpriced outputs', () => {
    expect(effectivePrices(p, 'default', 'unknown', t).unpriced).toBe(true);
    expect(effectivePrices(p, 'default', 'unknown', t).paidMcPerGb).toBe(0);
    expect(effectivePrices(p, 'default', 'free', t, 'devnull').unpriced).toBe(false);
    expect(effectivePrices(p, 'default', 'free', t, 'webhook').unpriced).toBe(true);
    expect(effectivePrices(p, 'default', 'zero', t, 'devnull').unpriced).toBe(true);
  });
  it('P1-F01: a counterfactual to a destination with no price is unpriced, never a silent $0 credit', () => {
    // 'orphan' diverts to 'missing', which has no price: would-have-paid can't be known.
    expect(effectivePrices(p, 'default', 'orphan', t)).toMatchObject({ paidMcPerGb: 7, whpMcPerGb: 0, unpriced: true, counterfactualUnpriced: true });
    // A built-in devnull nobody priced counts as free for ITSELF (REVIEW-3a #11), but it is still no price to
    // credit diverted data at: the rig's DevNull 'analytics' as a target is exactly the P1-F01 probe.
    expect(effectivePrices(p, 'default', 'toDevnull', t, 's3')).toMatchObject({ whpMcPerGb: 0, unpriced: true, counterfactualUnpriced: true });
    // A target priced at $0 on purpose is a real $0 credit, not an unknown one.
    expect(effectivePrices(p, 'default', 'toFree', t)).toMatchObject({ whpMcPerGb: 0, unpriced: false, counterfactualUnpriced: false });
    // A priced target, itself, and 'same' / 'none' never raise it.
    for (const id of ['archive', 'self', 'siem', 'nowhere']) expect(effectivePrices(p, 'default', id, t).counterfactualUnpriced).toBe(false);
    // An output with no price of its own is unpriced for that reason alone.
    expect(effectivePrices(p, 'default', 'unknown', t)).toMatchObject({ unpriced: true, counterfactualUnpriced: false });
  });
  it('a free destination type with no price entry is priced at $0 once any price is set (REVIEW-3a #11)', () => {
    // The built-in devnull nobody prices: not "1 destination has no price" on every org.
    expect(effectivePrices(p, 'default', 'devnull', t, 'devnull')).toEqual({ paidMcPerGb: 0, whpMcPerGb: 0, counterfactual: { kind: 'same' }, unpriced: false, counterfactualUnpriced: false });
    for (const type of ['default', 'cribl_tcp', 'cribl_http', 'router', ' DevNull ']) expect(effectivePrices(p, 'default', 'x', t, type).unpriced).toBe(false);
    // A type that costs money, or no type at all, still asks for a price.
    expect(effectivePrices(p, 'default', 'x', t, 'splunk_hec').unpriced).toBe(true);
    expect(effectivePrices(p, 'default', 'x', t, 'cribl_lake').unpriced).toBe(true);
    expect(effectivePrices(p, 'default', 'x', t).unpriced).toBe(true);
    // Before the first price, every destination is unpriced: the first-run table asks about each (the demo rig's
    // simulated SIEMs are DevNull outputs).
    expect(effectivePrices(emptyPrices('x'), 'default', 'devnull', t, 'devnull').unpriced).toBe(true);
    expect(effectivePrices(null as unknown as PricesDoc, 'default', 'devnull', t, 'devnull').unpriced).toBe(true);
  });
});

describe('priceMinute', () => {
  it('prices one minute per SPEC 8', () => {
    // 1 GB in, 0.25 GB out at $2.50/GB
    expect(priceMinute({ inB: 1e9, outB: 2.5e8 }, 250_000, 250_000, { kind: 'same' })).toEqual({
      whpM: 250_000,
      paidM: 62_500,
      savedM: 187_500,
    });
  });
  it('never saves more than would have been paid, and never negative', () => {
    expect(priceMinute({ inB: 1e9, outB: 2e9 }, 100, 100)).toEqual({ whpM: 100, paidM: 200, savedM: 0 });
  });
  it("'none' prices nothing as saved but still pays", () => {
    expect(priceMinute({ inB: 1e9, outB: 1e9 }, 3_000, 250_000, 'none')).toEqual({ whpM: 0, paidM: 3_000, savedM: 0 });
  });
  it("'other' credits diverted data", () => {
    // 1 GB to an archive at 3¢ instead of a SIEM at $2.50: saved = 250,000 − 3,000
    expect(priceMinute({ inB: 1e9, outB: 1e9 }, 3_000, 250_000, { kind: 'other', outputId: 'siem' }).savedM).toBe(247_000);
  });
  it('treats junk inputs as zero', () => {
    expect(priceMinute({ inB: Number.NaN, outB: -5 }, Number.NaN, -1)).toEqual({ whpM: 0, paidM: 0, savedM: 0 });
  });
  it('accumulates a 60 GB/day flow at 3¢/GB to $1.80 over a day (S17)', () => {
    const perMinute = 60e9 / 1440; // 41,666,666.67 bytes
    let total = 0;
    for (let i = 0; i < 1440; i++) total += priceMinute({ inB: perMinute, outB: 0 }, 3_000, 3_000).whpM;
    expect(total).toBe(180_000);
    expect(Math.abs(total - 180_000)).toBeLessThanOrEqual(1_000);
  });
  it('invariants hold for arbitrary traffic (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5e11 }),
        fc.integer({ min: 0, max: 5e11 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.constantFrom('same', 'other', 'none') as fc.Arbitrary<'same' | 'other' | 'none'>,
        (inB, outB, paid, whp, kind) => {
          const m = priceMinute({ inB, outB }, paid, whp, kind);
          expect(Number.isInteger(m.whpM) && Number.isInteger(m.paidM) && Number.isInteger(m.savedM)).toBe(true);
          expect(m.savedM).toBeLessThanOrEqual(m.whpM);
          expect(m.savedM).toBeGreaterThanOrEqual(0);
          if (m.paidM <= m.whpM) expect(m.whpM - m.paidM - m.savedM).toBe(0);
          else expect(m.savedM).toBe(0);
          const r = ratio(m.savedM, m.whpM);
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

describe('ratio', () => {
  it('is saved/whp clamped to [0,1]', () => {
    expect(ratio(75, 100)).toBe(0.75);
    expect(ratio(5, 0)).toBe(0);
    expect(ratio(200, 100)).toBe(1);
    expect(ratio(-1, 100)).toBe(0);
    expect(ratio(Number.NaN, 100)).toBe(0);
  });
});

describe('computeHeadline', () => {
  const tz = 'America/Chicago';
  const day = (savedM: number, minutes = 1440, whpM = savedM * 2, paidM = whpM - savedM) => ({ whpM, paidM, savedM, minutes });
  const totals = (byDay: TotalsDoc['byDay']): TotalsDoc => ({ schemaVersion: 1, updatedAt: '', byDay });
  const now = Date.parse('2026-09-26T17:00:00Z'); // noon CDT, Sep 26

  it('sums today, month to date and the last 30 days by local day', () => {
    const byDay: TotalsDoc['byDay'] = {};
    for (let i = 0; i < 40; i++) byDay[addDaysToKey('2026-09-26', -i)] = day(1_000 * (i + 1));
    byDay['2026-09-27'] = day(999_999); // future keys are ignored
    const h = computeHeadline(totals(byDay), now, tz, Date.parse('2026-08-01T05:00:00Z'));
    expect(h.todayM).toBe(1_000);
    // Sep 1..26 → i = 0..25 → Σ 1..26 × 1000
    expect(h.mtdM).toBe(((26 * 27) / 2) * 1_000);
    expect(h.d30M).toBe(((30 * 31) / 2) * 1_000);
    expect(h.whpMtdM).toBe(2 * h.mtdM);
    expect(h.paidMtdM).toBe(h.mtdM);
    expect(h.ratioMtd).toBe(0.5);
    expect(h.whpTodayM).toBe(2_000);
    expect(h.paidTodayM).toBe(1_000);
    expect(h.whp30dM).toBe(2 * h.d30M);
    expect(h.paid30dM).toBe(h.d30M);
    // annualized = Σ saved ÷ Σ minutes × 525,600 over the last 30 local days, today included (i = 0…29 → Σ 1..30);
    // the caption basis stays the whole days of history, capped at 30
    expect(h.annualizedFromDays).toBe(30);
    expect(h.annualizedM).toBe(Math.round((((30 * 31) / 2) * 1_000 * 525_600) / (30 * 1_440)));
    expect(h.netMtdM).toBeUndefined();
    expect(h.paybackX).toBeUndefined();
  });
  it('annualizes from fewer whole days while history is short', () => {
    // Collecting since 9:41 PM CDT on Sep 21: Sep 21 is partial; Sep 22–25 are whole (4 days).
    const since = Date.parse('2026-09-22T02:41:00Z');
    const byDay = { '2026-09-21': day(50, 139), '2026-09-22': day(100), '2026-09-23': day(200), '2026-09-24': day(300), '2026-09-25': day(400), '2026-09-26': day(10, 720) };
    const h = computeHeadline(totals(byDay), now, tz, since);
    expect(h.annualizedFromDays).toBe(4);
    // every metered minute since collecting began, the partial first day and today included
    expect(h.annualizedM).toBe(Math.round((1_060 / (139 + 4 * 1_440 + 720)) * 525_600));
  });
  it('a gap while nothing metered does not drag the rate down (REVIEW-3a #6)', () => {
    // The review's probe: 30 minutes metered on Sep 24, the tab closed for 40 h, then reopened — Sep 25 holds 989
    // of its 1,440 minutes (the 24 h backfill) and today 720. Every metered minute saved the same 181.7 mc.
    const perMin = 181.7;
    const at = (minutes: number) => day(Math.round(perMin * minutes), minutes);
    const since = Date.parse('2026-09-24T22:00:00Z');
    const h = computeHeadline(totals({ '2026-09-24': at(30), '2026-09-25': at(989), '2026-09-26': at(720) }), now, tz, since);
    const saved = Math.round(perMin * 30) + Math.round(perMin * 989) + Math.round(perMin * 720);
    expect(h.annualizedM).toBe(Math.round((saved / (30 + 989 + 720)) * 525_600));
    expect(Math.abs(h.annualizedM / (perMin * 525_600) - 1)).toBeLessThan(0.001);
    // Calendar-day averaging read the 989-minute day as a whole day: 31 % low.
    expect(Math.round(Math.round(perMin * 989) * 365)).toBeLessThan(h.annualizedM * 0.7);
    expect(h.annualizedFromDays).toBe(1); // "from the last 1 day": Sep 25 is the only whole day
  });
  it('counts the first day as whole when collecting began exactly at local midnight', () => {
    const since = localDayStartMs('2026-09-25', tz);
    const h = computeHeadline(totals({ '2026-09-25': day(700) }), now, tz, since);
    expect(h.annualizedFromDays).toBe(1);
    expect(h.annualizedM).toBe(700 * 365);
  });
  it('annualizes from minutes before the first whole day', () => {
    const since = Date.parse('2026-09-26T15:00:00Z'); // 10:00 AM CDT today
    const h = computeHeadline(totals({ '2026-09-26': day(120, 120) }), now, tz, since);
    expect(h.annualizedM).toBe(Math.round((120 / 120) * 525_600));
    expect(h.annualizedFromDays).toBeCloseTo(120 / 1440, 10);
  });
  it('is zero with no data', () => {
    const h = computeHeadline(totals({}), now, tz, now);
    expect(h).toMatchObject({ todayM: 0, mtdM: 0, d30M: 0, annualizedM: 0, annualizedFromDays: 0, ratioMtd: 0 });
    const h2 = computeHeadline(undefined as unknown as TotalsDoc, now, tz, Number.NaN);
    expect(h2.annualizedM).toBe(0);
  });
  it('computes net and payback against the Cribl cost over the minutes metered this month (D49)', () => {
    const byDay = { '2026-09-26': day(0), '2026-09-01': day(26_000_000) };
    const monthStart = Date.parse('2026-09-01T05:00:00Z'); // Sep 1, 00:00 CDT
    const h = computeHeadline(totals(byDay), now, tz, monthStart, 30_000); // $300/month
    // Sep 1 00:00 → Sep 26 noon CDT is 36,720 minutes: 30,000 × 1000 × 12 ÷ 525,600 × 36,720 ≈ 25,150,685 mc,
    // not the calendar rule's 26 of 30 days (26,000,000).
    const minutes = (now - monthStart) / 60_000;
    expect(minutes).toBe(36_720);
    const costExact = (30_000 * 1000 * 12 * minutes) / 525_600;
    expect(h.netMtdM).toBe(26_000_000 - Math.round(costExact));
    expect(h.paybackX).toBeCloseTo(26_000_000 / costExact, 12);
    // Collecting since this morning: the cost covers those three hours, not 26 days of Cribl.
    const young = computeHeadline(totals(byDay), now, tz, now - 3 * 3_600_000, 30_000);
    expect(young.netMtdM).toBe(26_000_000 - Math.round((30_000 * 1000 * 12 * 180) / 525_600));
    // No usable cost (0 is unset, as the hero reads it) or no metered minute: no net.
    const h0 = computeHeadline(totals(byDay), now, tz, monthStart, 0);
    expect(h0.netMtdM).toBeUndefined();
    expect(h0.paybackX).toBeUndefined();
    const fresh = computeHeadline(totals(byDay), now, tz, now, 30_000);
    expect(fresh.netMtdM).toBeUndefined();
  });
});
