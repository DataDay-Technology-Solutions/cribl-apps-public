// Very large values print grouped like every other figure (OQ-13): '$250,000.00 / GB', '192,600.7×', 'ROI 19,259,968%'.
import { describe, expect, it } from 'vitest';
import { fmtPct, fmtPriceShown, mcToDollarInput } from '../../core/format.ts';
import { fmtMultiple } from '../../core/report.ts';
import { formatPricePerGb } from '../../src/components/WhereMoneyGoes/price.ts';

describe('large values are grouped', () => {
  it('prices keep their precision and group their dollars; inputs stay plain', () => {
    expect(fmtPriceShown(25_000_000_000)).toBe('$250,000.00');
    expect(fmtPriceShown(2_300)).toBe('$0.023');
    expect(fmtPriceShown(225_000)).toBe('$2.25');
    expect(formatPricePerGb(25_000_000_000)).toBe('$250,000.00');
    expect(mcToDollarInput(25_000_000_000)).toBe('250000.00');
  });
  it('percentages and multiples', () => {
    expect(fmtPct(192_599.68)).toBe('19,259,968%');
    expect(fmtPct(0.6)).toBe('60%');
    expect(fmtPct(-12.345)).toBe('−1,235%');
    expect(fmtMultiple(192_600.68)).toBe('192,600.7');
    expect(fmtMultiple(2.83)).toBe('2.8');
  });
});

describe('zone names (OQ-16)', () => {
  it('a legacy alias reads as its modern name', async () => {
    const { canonicalZoneName, isValidTimeZone } = await import('../../core/time.ts');
    expect(canonicalZoneName('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(canonicalZoneName('America/Chicago')).toBe('America/Chicago');
    expect(isValidTimeZone(canonicalZoneName('Asia/Calcutta'))).toBe(true);
  });
});
