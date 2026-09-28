// W3-LS-2 (P1-K01 remainder): the wide Ledger's names wrap to two lines instead of ending in an ellipsis, and the
// columns are planned from each column's widest name so that none is cut short; where the room allows, a column keeps
// its names on one line.

import { describe, expect, it } from 'vitest';
import { estimateLabelPx, estimateTwoLinePx, planColumns } from '../../src/components/LedgerTable/layout.ts';

/** The template's name tracks' floors (px), in order. */
const floors = (template: string): number[] => [...template.matchAll(/minmax\((\d+)px, [^)]+fr\)/g)].map((m) => Number(m[1]));
/** Every track's floor plus the gaps, padding and scrollbar headroom: what the plan needs of the table's width. */
const needOf = (template: string): number => {
  const all = [...template.matchAll(/minmax\((\d+)px, [^)]+\)|(\d+)px/g)].map((m) => Number(m[1] ?? m[2]));
  return all.reduce((s, n) => s + n, 0) + 8 * (all.length - 1) + 32 + 16;
};

describe('estimateTwoLinePx', () => {
  it("is the best word split's longer line", () => {
    expect(estimateTwoLinePx('Palo Alto firewall east')).toBe(Math.max(estimateLabelPx('Palo Alto'), estimateLabelPx('firewall east')));
    expect(estimateTwoLinePx('CrowdStrike FDR duplicate suppression')).toBe(estimateLabelPx('duplicate suppression'));
  });
  it('is the whole width for one word, and never wider than one line', () => {
    expect(estimateTwoLinePx('Datadog')).toBe(estimateLabelPx('Datadog'));
    expect(estimateTwoLinePx('')).toBe(0);
    for (const s of ['Microsoft Sentinel', 'Everything else to New Relic', 'a b c d e f'])
      expect(estimateTwoLinePx(s)).toBeLessThanOrEqual(estimateLabelPx(s));
  });
});

describe('planColumns: every name whole (W3-LS-2)', () => {
  const tour = {
    source: [114, 99, 92],
    route: [122, 60],
    pipeline: [180, 160, 140],
    destination: [69, 50, 46],
  };
  const tourOneLine = {
    source: [175, 130, 110],
    route: [213, 70],
    pipeline: [302, 200, 170],
    destination: [137, 92, 99],
  };

  it("where each column's widest two-line name fits, that is the column's floor", () => {
    const p = planColumns(1438, { route: true, groups: false, labels: tour });
    expect(p.layout).toBe('wide');
    const [source, route, pipeline, destination] = floors(p.template);
    expect(source).toBeGreaterThanOrEqual(Math.ceil(114 * 1.05));
    expect(route).toBeGreaterThanOrEqual(Math.ceil(122 * 1.05));
    expect(pipeline).toBeGreaterThanOrEqual(Math.ceil(180 * 1.05));
    expect(destination).toBeGreaterThanOrEqual(Math.ceil(72 * 1.05) - 4);
    expect(needOf(p.template)).toBeLessThanOrEqual(1438);
  });

  it('with room to spare, the cheapest columns keep their names on one line, and the plan still fits', () => {
    const p = planColumns(1438, { route: true, groups: false, labels: tour, oneLine: tourOneLine });
    const [source, , , destination] = floors(p.template);
    // The destination (137 → 144 px) and the source (175 → 184 px) are the cheapest to keep on one line.
    expect(destination).toBe(Math.ceil(137 * 1.05));
    expect(source).toBe(Math.ceil(175 * 1.05));
    expect(needOf(p.template)).toBeLessThanOrEqual(1438);
  });

  it('where the asks do not fit, the room is shared in proportion to them, never under a floor, and the layout does not move', () => {
    const p = planColumns(1278, { route: true, groups: false, labels: tour, oneLine: tourOneLine });
    expect(p.layout).toBe('wide');
    expect(p.template.startsWith('minmax(128px, 1.28fr) minmax(128px, 1.28fr) minmax(160px, 1.8fr) minmax(72px, 0.72fr)')).toBe(true);
    expect(needOf(p.template)).toBeLessThanOrEqual(1278);
  });

  it('never moves the wide → medium breakpoint, whatever the labels ask', () => {
    const huge = { source: [900], route: [900], pipeline: [900], destination: [900] };
    for (let w = 900; w <= 1600; w += 13) {
      const plain = planColumns(w, { route: true, groups: false });
      const asked = planColumns(w, { route: true, groups: false, labels: huge, oneLine: huge });
      expect(asked.layout, String(w)).toBe(plain.layout);
      if (asked.layout !== 'narrow') expect(needOf(asked.template), String(w)).toBeLessThanOrEqual(Math.max(w, plain.minWidth));
    }
  });

  it('the medium layout ignores the name widths (its flow line keeps one line over the path)', () => {
    const p = planColumns(976, { route: true, groups: false, labels: tour, oneLine: tourOneLine });
    expect(p.layout).toBe('medium');
    expect(p.template.startsWith('minmax(280px, 1fr)')).toBe(true);
  });
});
