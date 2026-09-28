// P2-W04: the stage's 30-day savings line — the highest day at 90 % of the height, the area closed on the baseline.
import { describe, expect, it } from 'vitest';
import { TREND_H, TREND_W, trendPaths } from '../../src/views/Presenter/trend.ts';

describe('trendPaths (P2-W04)', () => {
  it('draws one point per day across the width, the best day at 90 % of the height', () => {
    const p = trendPaths([{ savedM: 100 }, { savedM: 200 }, { savedM: 50 }])!;
    expect(p.max).toBe(200);
    expect(p.line).toBe(`M0.0,${(TREND_H - 0.45 * TREND_H).toFixed(1)}L500.0,${(TREND_H * 0.1).toFixed(1)}L${TREND_W}.0,${(TREND_H - 0.225 * TREND_H).toFixed(1)}`);
    expect(p.area.endsWith(`L${TREND_W},${TREND_H}L0,${TREND_H}Z`)).toBe(true);
  });
  it('needs two days and some savings; a bad reading counts as $0', () => {
    expect(trendPaths([])).toBeNull();
    expect(trendPaths([{ savedM: 5 }])).toBeNull();
    expect(trendPaths([{ savedM: 0 }, { savedM: 0 }])).toBeNull();
    expect(trendPaths([{ savedM: Number.NaN }, { savedM: -3 }, { savedM: 10 }])!.line.startsWith(`M0.0,${TREND_H}.0`)).toBe(true);
  });
});
