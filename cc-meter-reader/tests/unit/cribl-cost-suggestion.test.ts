// Rules round (usefulness): "did Cribl pay for itself?" was blank by default because Cribl cost is a typed field
// with no suggestion. Two sides of the same suggestion, both tested here:
// - core/presets.ts suggestCriblCost offers the published list rate on the measured ingest (core branch);
// - Settings → Cribl cost's suggestion (usefulness review, round 1): this workspace's bytes received per day at Cribl's
//   published Enterprise Cloud Worker list price, × 365 ÷ 12 (core/net.ts's month). Only when that byte figure is exact
//   (every Source feeds one flow, as Show the math requires); otherwise nothing is suggested (UI branch).

import { describe, expect, it } from 'vitest';
import { CRIBL_COST_NOTE, CRIBL_STREAM_CLOUD_MILLICENTS_PER_GB, DAYS_PER_MONTH, suggestCriblCost } from '../../core/presets.ts';
import type { FlowFigures, Snapshot } from '../../core/types.ts';
import { CRIBL_LIST_MC_PER_GB } from '../../core/net.ts';
import { criblCostSuggestion } from '../../src/views/Settings/model.ts';

describe('suggestCriblCost', () => {
  it('prices the measured GB in per day at $0.32 a GB for an average month', () => {
    // The demo org's 450 GB/day at list: 450 × $0.32 × 30.4167 ≈ $4,380 a month (PITCH: about $4,381).
    const s = suggestCriblCost(450e9)!;
    expect(s.gbPerDay).toBe(450);
    expect(s.milliCentsPerGb).toBe(CRIBL_STREAM_CLOUD_MILLICENTS_PER_GB);
    expect(s.centsPerMonth).toBe(Math.round(450 * 32 * DAYS_PER_MONTH));
    expect(s.centsPerMonth).toBe(438_000);
    // The hybrid-worker rate is the low end.
    expect(s.lowCentsPerMonth).toBe(Math.round(450 * 26 * DAYS_PER_MONTH));
    expect(s.lowCentsPerMonth).toBeLessThan(s.centsPerMonth);
  });

  it('suggests nothing on no traffic', () => {
    for (const x of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(suggestCriblCost(x)).toBeUndefined();
  });

  it('names its basis and source, like every preset', () => {
    expect(CRIBL_COST_NOTE.confidence).toBe('published');
    expect(CRIBL_COST_NOTE.rangeUsd).toEqual([0.26, 0.32]);
    expect(CRIBL_COST_NOTE.sources.some((s) => s.quote.includes('0.32 of a Cribl Credit per GB'))).toBe(true);
    expect(CRIBL_COST_NOTE.basis).toMatch(/contract figure replaces it/);
  });

  it('agrees with the Settings suggestion on the same rate', () => {
    expect(CRIBL_STREAM_CLOUD_MILLICENTS_PER_GB).toBe(CRIBL_LIST_MC_PER_GB);
  });
});

const flow = (inputId: string, gbPerDay: number): FlowFigures => ({ key: inputId, groupId: 'default', inputId, inBPerDay: gbPerDay * 1e9 }) as FlowFigures;
const snap = (flows: FlowFigures[]): Snapshot => ({ flows }) as Snapshot;

describe('criblCostSuggestion', () => {
  it('450 GB a day at $0.32 a GB is $4,380 a month (× 365 ÷ 12)', () => {
    const s = criblCostSuggestion(snap([flow('a', 300), flow('b', 150)]))!;
    expect(s.listMcPerGb).toBe(CRIBL_LIST_MC_PER_GB);
    expect(s.bytesInPerDay).toBe(450e9);
    expect(s.centsPerMonth).toBe(438_000);
  });

  it('abstains when a Source feeds two flows (clone or split cannot be told apart), without traffic, or without a snapshot', () => {
    expect(criblCostSuggestion(snap([flow('a', 300), flow('a', 300)]))).toBeUndefined();
    expect(criblCostSuggestion(snap([flow('a', 0)]))).toBeUndefined();
    expect(criblCostSuggestion(snap([]))).toBeUndefined();
    expect(criblCostSuggestion(null)).toBeUndefined();
  });
});
