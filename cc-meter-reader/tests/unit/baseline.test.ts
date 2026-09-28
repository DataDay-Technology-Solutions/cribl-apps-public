import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { alphaForMemoryMinutes, emptyBaseline, isWarm, sigma, updateBaseline } from '../../core/baseline.ts';

describe('baseline', () => {
  it('starts empty', () => {
    expect(emptyBaseline()).toEqual({ mean: 0, variance: 0, samples: 0, warm: [] });
    expect(isWarm(undefined, 10)).toBe(false);
    expect(sigma(undefined)).toBe(0);
  });
  it('maps a memory in minutes to alpha', () => {
    expect(alphaForMemoryMinutes(1440)).toBeCloseTo(0.0014, 4);
    expect(alphaForMemoryMinutes(60)).toBeCloseTo(2 / 61, 12);
  });
  it('uses the average and sample variance during warm-up', () => {
    let b = emptyBaseline();
    b = updateBaseline(b, 2, 0.1, 4);
    expect(b).toEqual({ mean: 2, variance: 0, samples: 1, warm: [2] });
    b = updateBaseline(b, 4, 0.1, 4);
    expect(b.mean).toBe(3);
    expect(b.variance).toBe(2); // ((2-3)² + (4-3)²) / (2-1)
    b = updateBaseline(b, 4, 0.1, 4);
    b = updateBaseline(b, 6, 0.1, 4);
    expect(b.samples).toBe(4);
    expect(b.mean).toBe(4);
    expect(b.variance).toBeCloseTo(8 / 3, 12);
    expect(b.warm).toEqual([]); // released once warm
    expect(isWarm(b, 4)).toBe(true);
  });
  it('applies the SPEC 9.2 EWMA after warm-up', () => {
    const warm = { mean: 10, variance: 4, samples: 10, warm: [] };
    const b = updateBaseline(warm, 20, 0.5, 10);
    // diff = 10; mean = 10 + 5 = 15; var = 0.5 × (4 + 0.5 × 100) = 27
    expect(b).toEqual({ mean: 15, variance: 27, samples: 11, warm: [] });
    expect(sigma(b)).toBeCloseTo(Math.sqrt(27), 12);
    expect(warm.mean).toBe(10); // not mutated
  });
  it('ignores non-finite samples and treats warm-up < 1 as 1', () => {
    const b = updateBaseline(undefined, Number.NaN, 0.1, 10);
    expect(b).toEqual(emptyBaseline());
    const one = updateBaseline(undefined, 7, 0.1, 0);
    expect(one).toEqual({ mean: 7, variance: 0, samples: 1, warm: [] });
    expect(updateBaseline(one, 9, 5, 0).mean).toBe(9); // alpha clamped to 1
  });
  it('converges on a constant signal and its variance decays (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.double({ min: 0.02, max: 0.5, noNaN: true }), (c, alpha) => {
        let b = { mean: c + 1000, variance: 1e6, samples: 10, warm: [] as number[] };
        for (let i = 0; i < 3000; i++) b = updateBaseline(b, c, alpha, 10);
        expect(Math.abs(b.mean - c)).toBeLessThan(1e-3 * Math.max(1, Math.abs(c)));
        expect(b.variance).toBeLessThan(1e-3);
      }),
      { numRuns: 50 },
    );
  });
  it('a 24-hour alpha moves slowly: a day of drops pulls the mean only ~87% of the way', () => {
    let b = { mean: 0.75, variance: 0, samples: 100, warm: [] as number[] };
    for (let i = 0; i < 1440; i++) b = updateBaseline(b, 0.5, 0.0014, 10);
    expect(b.mean).toBeGreaterThan(0.5);
    expect(b.mean).toBeLessThan(0.55);
  });
});
