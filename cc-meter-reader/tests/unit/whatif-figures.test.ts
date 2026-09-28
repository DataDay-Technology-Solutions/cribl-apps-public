// tests/unit/whatif-figures.test.ts — the What-if strip's figures (P1-J01): a range breaks only after its dash,
// big money ranges are compact, a byte range names its unit once, a signed range carries one sign.

import { describe, expect, it } from 'vitest';
import { bytesFigure, COMPACT_RANGE_FROM_M, joinRange, moneyFigure, pctFigure, pointsFigure, signedBytesFigure, signedMoneyFigure, spanOf } from '../../src/components/WhatIf/figures.ts';
import { estimateTreatment, type EstimateOk } from '../../core/whatif.ts';

const $ = (dollars: number): number => dollars * 100_000;
const GB = 1_000_000_000;

describe('What-if figures', () => {
  it('a point is one piece; a range is two, split right after the dash', () => {
    expect(joinRange('$66', '$66')).toEqual({ parts: ['$66'], text: '$66' });
    expect(joinRange('$68', '$140')).toEqual({ parts: ['$68–', '$140'], text: '$68–$140' });
  });

  it('money: exact below $10,000, compact once the larger end reaches it', () => {
    expect(moneyFigure($(66), $(66)).text).toBe('$66');
    expect(moneyFigure($(68), $(140)).parts).toEqual(['$68–', '$140']);
    expect(moneyFigure($(24_798), $(51_054)).text).toBe('$24.8k–$51.1k');
    expect(moneyFigure($(9_000), $(9_999)).text).toBe('$9,000–$9,999');
    // both compact ends print to the tenth
    expect(moneyFigure($(24_798), $(51_020)).text).toBe('$24.8k–$51.0k');
    expect(moneyFigure($(24_000), $(51_020)).text).toBe('$24k–$51k');
    expect(signedMoneyFigure($(-51_020), $(-24_798)).text).toBe('−$24.8k–$51.0k');
    expect(COMPACT_RANGE_FROM_M).toBe($(10_000));
    // a point never goes compact, however large
    expect(moneyFigure($(24_109), $(24_109)).text).toBe('$24,109');
  });

  it('signed money carries one sign when both ends share it', () => {
    expect(signedMoneyFigure($(66), $(66)).text).toBe('+$66');
    expect(signedMoneyFigure($(68), $(140)).text).toBe('+$68–$140');
    expect(signedMoneyFigure($(-12), $(-5)).text).toBe('−$5–$12');
    expect(signedMoneyFigure($(-3), $(9)).text).toBe('−$3–+$9');
    expect(signedMoneyFigure($(24_798), $(51_054)).parts).toEqual(['+$24.8k–', '$51.1k']);
  });

  it('percentages and points', () => {
    expect(pctFigure(0.33, 0.33).text).toBe('33%');
    expect(pctFigure(0.34, 0.7).parts).toEqual(['34%–', '70%']);
    expect(pointsFigure(0, 0.33, 0.33).text).toBe('+33 points');
    expect(pointsFigure(0, 0.34, 0.7).text).toBe('+34–70 points');
    expect(pointsFigure(0.4, 0.38, 0.38).text).toBe('−2 points');
    expect(pointsFigure(0.4, 0.3, 0.38).text).toBe('−2–10 points');
    expect(pointsFigure(0.33, 0.33, 0.33).text).toBe('0 points');
    expect(pointsFigure(0.33, 0.34, 0.34).text).toBe('+1 point');
  });

  it('bytes name their unit once, never break inside "24.0 GB"', () => {
    expect(bytesFigure(53.5 * GB, 53.5 * GB)).toEqual({ parts: ['53.5 GB'], text: '53.5 GB' });
    expect(bytesFigure(24 * GB, 52.8 * GB)).toEqual({ parts: ['24.0–', '52.8 GB'], text: '24.0–52.8 GB' });
    expect(bytesFigure(900_000_000, 1.2 * GB).text).toBe('900.0 MB–1.2 GB');
    expect(signedBytesFigure(-26.4 * GB, -26.4 * GB).text).toBe('−26.4 GB');
    expect(signedBytesFigure(-55.9 * GB, -27.2 * GB).text).toBe('−27.2–55.9 GB');
    expect(signedBytesFigure(1.2 * GB, 1.2 * GB).text).toBe('+1.2 GB');
    expect(signedBytesFigure(-1 * GB, 2 * GB).text).toBe('−1.0 GB–+2.0 GB');
  });

  it('spanOf orders a range by value, whichever end produced it', () => {
    const e = estimateTreatment({
      flow: { inBPerDay: 80 * GB, outBPerDay: 80 * GB, whpPerDayM: $(200), paidPerDayM: $(200), savedPerDayM: 0 },
      treatment: 'aggressive-windows',
    }) as EstimateOk;
    expect(e.range).toBe(true);
    const [lo, hi] = spanOf(e, (p) => p.outBPerDay);
    expect(lo).toBeLessThan(hi);
    const [slo, shi] = spanOf(e, (p) => p.savedPerDayM);
    expect(slo).toBeLessThan(shi);
    const point = estimateTreatment({ flow: { inBPerDay: GB, outBPerDay: GB, whpPerDayM: $(2), paidPerDayM: $(2), savedPerDayM: 0 }, treatment: { dropPct: 50 } }) as EstimateOk;
    const [a, b] = spanOf(point, (p) => p.outBPerDay);
    expect(a).toBe(b);
  });
});
