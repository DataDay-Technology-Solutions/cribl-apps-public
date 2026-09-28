import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MC_PER_CENT,
  MC_PER_DOLLAR,
  centsToMc,
  fmtBytes,
  fmtDollars,
  fmtDollarsCents,
  fmtDollarsCompact,
  fmtDuration,
  fmtDurationShort,
  fmtGbPerDay,
  footMoney,
  roundToCentsM,
  roundToDollarsM,
  fmtPct,
  fmtPoints,
  fmtRelative,
  mcToCents,
  mcToDollarInput,
  parseDollarsToMc,
  perYear,
} from '../../core/format.ts';

describe('money', () => {
  it('has the unit constants', () => {
    expect(MC_PER_CENT).toBe(1000);
    expect(MC_PER_DOLLAR).toBe(100_000);
  });
  it('formats whole dollars, half up, with separators', () => {
    expect(fmtDollars(0)).toBe('$0');
    expect(fmtDollars(123_400_000)).toBe('$1,234');
    expect(fmtDollars(50_000)).toBe('$1');
    expect(fmtDollars(49_999)).toBe('$0');
    expect(fmtDollars(2_500_000)).toBe('$25');
    expect(fmtDollars(912_500_000)).toBe('$9,125');
    expect(fmtDollars(-1_200_000)).toBe('−$12');
    expect(fmtDollars(-10)).toBe('$0');
    expect(fmtDollars(123_456_789_000_00)).toBe('$123,456,789');
    expect(fmtDollars(Number.NaN)).toBe('$0');
  });
  it('formats cents', () => {
    expect(fmtDollarsCents(123_456_000)).toBe('$1,234.56');
    expect(fmtDollarsCents(180_000)).toBe('$1.80');
    expect(fmtDollarsCents(500)).toBe('$0.01');
    expect(fmtDollarsCents(499)).toBe('$0.00');
    expect(fmtDollarsCents(-150_000)).toBe('−$1.50');
    expect(fmtDollarsCents(Number.POSITIVE_INFINITY)).toBe('$0.00');
  });
  it('formats compact amounts', () => {
    expect(fmtDollarsCompact(95_000_000)).toBe('$950');
    expect(fmtDollarsCompact(9_560_000_000)).toBe('$95.6k');
    expect(fmtDollarsCompact(9_500_000_000)).toBe('$95k');
    expect(fmtDollarsCompact(120_000_000_000)).toBe('$1.2M');
    expect(fmtDollarsCompact(99_996_000_000)).toBe('$1M');
    expect(fmtDollarsCompact(99_960_000)).toBe('$1k');
    expect(fmtDollarsCompact(340_000_000_000_000)).toBe('$3.4B');
    expect(fmtDollarsCompact(-9_560_000_000)).toBe('−$95.6k');
    expect(fmtDollarsCompact(Number.NaN)).toBe('$0');
    expect(fmtDollarsCompact(-10)).toBe('$0');
  });
  it('converts cents and computes per-year', () => {
    expect(centsToMc(250)).toBe(250_000);
    expect(mcToCents(180_000)).toBe(180);
    expect(perYear(2_500_000)).toBe(912_500_000);
  });
  it('fmtDollars matches integer arithmetic (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e13 }), (mc) => {
        const expected = Math.floor((mc + 50_000) / 100_000);
        expect(fmtDollars(mc).replace(/[$,]/g, '')).toBe(String(expected));
      }),
    );
  });
});

describe('ratios', () => {
  it('formats percentages and points', () => {
    expect(fmtPct(0.6)).toBe('60%');
    expect(fmtPct(0.605)).toBe('61%');
    expect(fmtPct(0)).toBe('0%');
    expect(fmtPct(-0.04)).toBe('−4%');
    expect(fmtPct(Number.NaN)).toBe('0%');
    expect(fmtPoints(0.25)).toBe('25 points');
    expect(fmtPoints(0.01)).toBe('1 point');
    expect(fmtPoints(-0.25)).toBe('−25 points');
    expect(fmtPoints(Number.NaN)).toBe('0 points');
  });
});

describe('bytes and durations', () => {
  it('formats decimal bytes with one decimal', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(-5)).toBe('0 B');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1_000)).toBe('1.0 KB');
    expect(fmtBytes(12_345_678_901)).toBe('12.3 GB');
    expect(fmtBytes(999_960_000)).toBe('1.0 GB');
    expect(fmtBytes(450e9)).toBe('450.0 GB');
    expect(fmtBytes(1.25e12)).toBe('1.3 TB');
    expect(fmtBytes(5e18)).toBe('5000.0 PB');
    expect(fmtGbPerDay(12e9)).toBe('12.0 GB/day');
  });
  it('formats durations', () => {
    expect(fmtDuration(171)).toBe('2:51');
    expect(fmtDuration(3723)).toBe('1:02:03');
    expect(fmtDuration(0)).toBe('0:00');
    expect(fmtDuration(-4)).toBe('0:00');
    expect(fmtDuration(59.6)).toBe('1:00');
  });
  it('formats relative time', () => {
    expect(fmtRelative(500)).toBe('just now');
    expect(fmtRelative(12_000)).toBe('12 s ago');
    expect(fmtRelative(3 * 60_000 + 5_000)).toBe('3 min ago');
    expect(fmtRelative(5 * 3_600_000)).toBe('5 h ago');
    expect(fmtRelative(3 * 86_400_000)).toBe('3 d ago');
    expect(fmtRelative(Number.NaN)).toBe('just now');
  });
});

describe('parseDollarsToMc', () => {
  it('accepts dollars with up to three decimals', () => {
    expect(parseDollarsToMc('$2.50')).toEqual({ ok: true, value: 250_000 });
    expect(parseDollarsToMc('0.023')).toEqual({ ok: true, value: 2_300 });
    expect(parseDollarsToMc('  $ 1,234.5 ')).toEqual({ ok: true, value: 123_450_000 });
    expect(parseDollarsToMc('.5')).toEqual({ ok: true, value: 50_000 });
    expect(parseDollarsToMc('3.')).toEqual({ ok: true, value: 300_000 });
    expect(parseDollarsToMc('0')).toEqual({ ok: true, value: 0 });
  });
  it('rejects negatives, blanks, junk, bad separators and extra decimals', () => {
    for (const bad of ['', '   ', '-1', '−1', '$-2', '-$2', 'abc', '1,23', '.', '1.2.3', '+5', 'NaN', '1e3']) {
      expect(parseDollarsToMc(bad).ok, bad).toBe(false);
    }
    expect(parseDollarsToMc('0.0231')).toEqual({ ok: false, error: 'use at most 3 decimal places' });
    expect(parseDollarsToMc('99999999999999999')).toEqual({ ok: false, error: 'is too large' });
    expect(parseDollarsToMc(undefined as unknown as string).ok).toBe(false);
  });
  it('round-trips through mcToDollarInput (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (hundredthsOfCent) => {
        const mc = hundredthsOfCent * 100; // 3-decimal dollar granularity
        const r = parseDollarsToMc(mcToDollarInput(mc));
        expect(r).toEqual({ ok: true, value: mc });
      }),
    );
    expect(mcToDollarInput(250_000)).toBe('2.50');
    expect(mcToDollarInput(2_300)).toBe('0.023');
    expect(mcToDollarInput(0)).toBe('0.00');
  });
});

describe('fmtDurationShort (a duration a reader never takes for a clock time)', () => {
  // Each number is joined to its unit by a no-break space: '3 min 19' never wraps away from its 's' (rules round).
  const nb = (s: string): string => s.replace(/(\d) /g, '$1\u00a0');
  it('words, largest two units', () => {
    expect(fmtDurationShort(45)).toBe(nb('45 s'));
    expect(fmtDurationShort(120)).toBe(nb('2 min'));
    expect(fmtDurationShort(95)).toBe(nb('1 min 35 s'));
    expect(fmtDurationShort(3600)).toBe(nb('1 h'));
    expect(fmtDurationShort(3900)).toBe(nb('1 h 5 min'));
    expect(fmtDurationShort(2 * 86_400 + 3 * 3600 + 59)).toBe(nb('2 d 3 h'));
    expect(fmtDurationShort(86_400)).toBe(nb('1 d'));
  });
  it('a number never breaks from its unit; the parts may break between them', () => {
    expect(fmtDurationShort(199)).toBe('3\u00a0min 19\u00a0s');
    expect(fmtDurationShort(199).split(' ')).toEqual(['3\u00a0min', '19\u00a0s']);
  });
  it('nothing negative, NaN or fractional leaks through', () => {
    expect(fmtDurationShort(-5)).toBe(nb('0 s'));
    expect(fmtDurationShort(Number.NaN)).toBe(nb('0 s'));
    expect(fmtDurationShort(59.6)).toBe(nb('1 min'));
  });
});

describe('rounding that foots', () => {
  it('roundToDollarsM / roundToCentsM round exactly as the formatters print', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e12, max: 1e12 }), (mc) => {
        expect(fmtDollars(roundToDollarsM(mc))).toBe(fmtDollars(mc));
        expect(fmtDollarsCents(roundToCentsM(mc))).toBe(fmtDollarsCents(mc));
        expect(Math.abs(roundToDollarsM(mc)) % MC_PER_DOLLAR).toBe(0);
        expect(Math.abs(roundToCentsM(mc)) % MC_PER_CENT).toBe(0);
      }),
    );
    expect(roundToDollarsM(Number.NaN)).toBe(0);
    expect(roundToCentsM(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('footMoney: when the exact figures add up, the printed ones do too (paid is the difference)', () => {
    // $1,503,379.87 − $958,406.19 = $544,973.68: rounded separately they print $1,503,380 − $958,406 ≠ $544,974.
    const m = { whpM: 150_337_987_000, paidM: 95_840_619_000, savedM: 54_497_368_000 };
    expect(footMoney(m)).toEqual({ whpM: 150_338_000_000, paidM: 95_840_600_000, savedM: 54_497_400_000 });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e12 }), fc.integer({ min: 0, max: 1e12 }), (paid, saved) => {
        const f = footMoney({ whpM: paid + saved, paidM: paid, savedM: saved });
        expect(f.whpM - f.paidM).toBe(f.savedM);
        expect(fmtDollars(f.savedM)).toBe(fmtDollars(saved));
        expect(Math.abs(f.paidM - paid)).toBeLessThanOrEqual(MC_PER_DOLLAR);
        const c = footMoney({ whpM: paid + saved, paidM: paid, savedM: saved }, 'cents');
        expect(c.whpM - c.paidM).toBe(c.savedM);
      }),
    );
  });

  it('footMoney: a real gap (paid for, saving nothing) is not papered over', () => {
    expect(footMoney({ whpM: 0, paidM: 300_000, savedM: 0 })).toEqual({ whpM: 0, paidM: 300_000, savedM: 0 });
    expect(footMoney({ whpM: 1_000_000, paidM: 700_000, savedM: 400_000 })).toEqual({ whpM: 1_000_000, paidM: 700_000, savedM: 400_000 });
  });
});
