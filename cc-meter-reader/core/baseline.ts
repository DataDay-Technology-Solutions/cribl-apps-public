// core/baseline.ts — per-object EWMA mean and variance (SPEC 9.2).
// warm-up: the first W values → mean = average, variance = sample variance (0 if W < 2);
// after:   diff = x − mean; mean += α·diff; var = (1 − α)·(var + α·diff²).
// α = 0.0014 per one-minute sample is a 24-hour memory (α = 2/(N+1), N = 1,440).

import type { Baseline } from './types.ts';

export function emptyBaseline(): Baseline {
  return { mean: 0, variance: 0, samples: 0, warm: [] };
}

/** α for an N-minute memory: 2/(N+1). 1,440 minutes → ≈ 0.0014. */
export function alphaForMemoryMinutes(n: number): number {
  return 2 / (n + 1);
}

export function isWarm(b: Baseline | undefined, warmupSamples: number): boolean {
  return (b?.samples ?? 0) >= Math.max(1, warmupSamples);
}

export function sigma(b: Baseline | undefined): number {
  return Math.sqrt(Math.max(0, b?.variance ?? 0));
}

/**
 * Feeds one sample. During warm-up the value is buffered and mean/variance are the buffer's
 * average and sample variance; the buffer is released once warm. Non-finite samples are ignored.
 * Returns a new Baseline; the input is not mutated.
 */
export function updateBaseline(b: Baseline | undefined, x: number, alpha: number, warmupSamples: number): Baseline {
  const base = b ?? emptyBaseline();
  if (!Number.isFinite(x)) return base;
  const w = Math.max(1, Math.floor(warmupSamples));
  if (base.samples < w) {
    const warm = [...(base.warm ?? []), x];
    const n = warm.length;
    const mean = warm.reduce((s, v) => s + v, 0) / n;
    const variance = n >= 2 ? warm.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
    const samples = base.samples + 1;
    return { mean, variance, samples, warm: samples >= w ? [] : warm };
  }
  const a = Math.min(1, Math.max(0, alpha));
  const diff = x - base.mean;
  const mean = base.mean + a * diff;
  const variance = (1 - a) * (base.variance + a * diff * diff);
  return { mean, variance, samples: base.samples + 1, warm: [] };
}

/**
 * P1-F07 "Accept as the new normal": a baseline seated at `x`, already warm — the next minute at that level is
 * ordinary. The learned variance is kept (the object's wobble did not change with its level); `samples` never
 * drops below the warm-up, so the rules judge the very next minute instead of re-learning for ten.
 */
export function reseedBaseline(x: number, warmupSamples: number, prev?: Baseline): Baseline {
  const w = Math.max(1, Math.floor(warmupSamples));
  return { mean: Number.isFinite(x) ? x : (prev?.mean ?? 0), variance: Math.max(0, prev?.variance ?? 0), samples: Math.max(prev?.samples ?? 0, w), warm: [] };
}
