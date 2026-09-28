// @vitest-environment jsdom
// tests/unit/whatif-applied.test.tsx — the What-if after "Apply for real" (EPIC_AUDIT P1-J03): compareApplied
// prices before, projected and measured on one volume and price so they differ only by the ratio, and a change
// that has not landed never reads as saved; Rich keeps the copy whole while its figures are styled.

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { compareApplied, estimateTreatment, projectRatio, type EstimateOk } from '../../core/whatif.ts';
import { Rich } from '../../src/components/WhatIf/Fig.tsx';

const $ = (dollars: number): number => dollars * 100_000;
const GB = 1_000_000_000;

// 80 GB/day into a $2.50/GB destination, nothing trimmed today: $200/day would-have-paid, $200 paid.
const FLOW = { inBPerDay: 80 * GB, outBPerDay: 80 * GB, whpPerDayM: $(200), paidPerDayM: $(200), savedPerDayM: 0 };

afterEach(cleanup);

describe('compareApplied', () => {
  it('prices every column on the same volume and price, so only the ratio differs', () => {
    const a = compareApplied(FLOW, { beforeRatio: 0, projected: { min: 0.33, max: 0.33 }, measuredRatio: 0.34 });
    expect(a.before).toEqual(projectRatio(FLOW, 0));
    expect(a.before!.savedPerDayM).toBe(0);
    expect(a.projectedLow).toEqual(a.projectedHigh);
    expect(a.projectedLow.savedPerDayM).toBe($(66));
    expect(a.measured!.ratio).toBe(0.34);
    expect(a.measured!.savedPerDayM).toBe($(68));
    for (const p of [a.before!, a.projectedLow, a.measured!]) {
      expect(p.inBPerDay).toBe(FLOW.inBPerDay);
      expect(p.whpPerDayM).toBe(FLOW.whpPerDayM);
    }
    // the yearly changes the hero names: measured and projected, each against before
    expect(a.measuredDeltaPerYearM).toBe(a.measured!.savedPerYearM - a.before!.savedPerYearM);
    expect(a.projectedDeltaPerYearM).toBe(a.projectedLow.savedPerYearM - a.before!.savedPerYearM);
    expect(a.measuredSaves).toBe(true);
  });

  it('matches the pack projection the calculator showed before the apply', () => {
    const e = estimateTreatment({ flow: FLOW, treatment: 'pack-windows', measuredSimilar: { ratio: 0.33, fromObject: 'default|mrd_windows_dc' } }) as EstimateOk;
    const a = compareApplied(FLOW, { beforeRatio: e.current.ratio, projected: { min: e.low.ratio, max: e.high.ratio }, measuredRatio: null });
    expect(a.projectedLow.savedPerDayM).toBe(e.mid.savedPerDayM);
    expect(a.projectedLow.outBPerDay).toBe(e.mid.outBPerDay);
  });

  it('a documented range keeps both ends and puts the projected yearly change at its middle', () => {
    const a = compareApplied(FLOW, { beforeRatio: 0, projected: { min: 0.3, max: 0.35 } });
    expect(a.projectedLow.ratio).toBe(0.3);
    expect(a.projectedHigh.ratio).toBe(0.35);
    expect(a.projectedDeltaPerYearM).toBe(projectRatio(FLOW, 0.325).savedPerYearM);
  });

  it('waiting for a sweep: nothing measured, no measured change, not saved', () => {
    const a = compareApplied(FLOW, { beforeRatio: 0, projected: { min: 0.33, max: 0.33 }, measuredRatio: null });
    expect(a.measured).toBeNull();
    expect(a.measuredDeltaPerYearM).toBeNull();
    expect(a.measuredSaves).toBe(false);
  });

  it('a change that has not landed (measured as before, to the printed point) is not saved', () => {
    expect(compareApplied(FLOW, { beforeRatio: 0, projected: { min: 0.33, max: 0.33 }, measuredRatio: 0 }).measuredSaves).toBe(false);
    expect(compareApplied(FLOW, { beforeRatio: 0.2, projected: { min: 0.5, max: 0.5 }, measuredRatio: 0.204 }).measuredSaves).toBe(false);
    expect(compareApplied(FLOW, { beforeRatio: 0.2, projected: { min: 0.5, max: 0.5 }, measuredRatio: 0.21 }).measuredSaves).toBe(true);
  });

  it('without a recorded before: no deltas, and saved means saving anything at all', () => {
    const a = compareApplied(FLOW, { projected: { min: 0.33, max: 0.33 }, measuredRatio: 0.33 });
    expect(a.before).toBeNull();
    expect(a.measuredDeltaPerYearM).toBeNull();
    expect(a.projectedDeltaPerYearM).toBeNull();
    expect(a.measuredSaves).toBe(true);
    expect(compareApplied(FLOW, { projected: { min: 0.33, max: 0.33 }, measuredRatio: 0 }).measuredSaves).toBe(false);
    expect(compareApplied(FLOW, { beforeRatio: Number.NaN, projected: { min: 0.33, max: 0.33 } }).before).toBeNull();
  });
});

describe('Rich', () => {
  it('keeps the sentence whole and each figure with the word before it', () => {
    const { container } = render(
      <p>
        <Rich template="Projected {projected}, measured {measured} after {minutes} min" parts={{ projected: <b>33%</b>, measured: <b>34%</b>, minutes: '3' }} />
      </p>,
    );
    const p = container.querySelector('p')!;
    expect(p.textContent).toBe('Projected 33%, measured 34% after 3 min');
    expect([...p.querySelectorAll('.mr-whatif-keep')].map((e) => e.textContent)).toEqual(['Projected 33%', 'measured 34%', 'after 3']);
  });

  it('leaves unknown placeholders as written', () => {
    const { container } = render(<Rich template="a {x} b {y}" parts={{ x: 'X' }} />);
    expect(container.textContent).toBe('a X b {y}');
  });
});
