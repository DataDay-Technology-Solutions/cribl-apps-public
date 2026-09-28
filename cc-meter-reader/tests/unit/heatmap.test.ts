// tests/unit/heatmap.test.ts — core/heatmap.ts (P2-W25): 168 hour cells from the hour rollups.

import { describe, expect, it } from 'vitest';
import { HEATMAP_HOURS, buildHeatmap, flowsTo, heatmapWindow } from '../../core/heatmap.ts';
import { HOUR_MS } from '../../core/time.ts';
import type { RollHourDoc } from '../../core/types.ts';

const END = Date.parse('2026-09-26T20:17:00Z'); // Sat
const row = (t: number, savedM: number) => ({ t: new Date(t).toISOString(), inB: 1, outB: 1, whpM: savedM * 2, paidM: savedM, savedM, samples: 60 });

describe('heatmapWindow', () => {
  it('is the last 168 whole hours, read from at most 8 UTC-day hour documents', () => {
    const w = heatmapWindow(END);
    expect(w.toMs).toBe(Date.parse('2026-09-26T20:00:00Z'));
    expect(w.toMs - w.fromMs).toBe(HEATMAP_HOURS * HOUR_MS);
    expect(w.keys).toEqual([
      'roll/hour/2026-09-19',
      'roll/hour/2026-09-20',
      'roll/hour/2026-09-21',
      'roll/hour/2026-09-22',
      'roll/hour/2026-09-23',
      'roll/hour/2026-09-24',
      'roll/hour/2026-09-25',
      'roll/hour/2026-09-26',
    ]);
  });
});

describe('buildHeatmap', () => {
  const { fromMs, toMs } = heatmapWindow(END);
  const siem = 'default|win|r1|pack|siem';
  const s3 = 'default|vpc|r2|agg|s3';
  const doc: RollHourDoc = {
    schemaVersion: 1,
    day: '2026-09-26',
    flows: {
      [siem]: [row(Date.parse('2026-09-26T14:00:00Z'), 500), row(Date.parse('2026-09-26T15:00:00Z'), 900), row(Date.parse('2026-09-26T20:00:00Z'), 99_999)],
      [s3]: [row(Date.parse('2026-09-26T14:00:00Z'), 300), row(Date.parse('2026-09-21T09:00:00Z'), 50)],
    },
  };

  it('places each hour by local weekday and hour, sums flows, and names the top three', () => {
    const h = buildHeatmap([doc], { fromMs, toMs, tz: 'America/Chicago' });
    expect(h.cells).toHaveLength(168);
    // 14:00Z Sat = 9 AM Chicago, Saturday (day 5): siem 500 + s3 300.
    expect(h.cells[5 * 24 + 9]).toMatchObject({ day: 5, hour: 9, savedM: 800, rows: 2 });
    expect(h.cells[5 * 24 + 10].savedM).toBe(900);
    // 09:00Z Mon = 4 AM Chicago, Monday.
    expect(h.cells[4].savedM).toBe(50);
    // 20:00Z is the window's end (exclusive): not counted.
    expect(h.totalSavedM).toBe(1_750);
    expect(h.maxSavedM).toBe(900);
    expect(h.top).toEqual([5 * 24 + 10, 5 * 24 + 9, 4]);
    expect(h.hoursMetered).toBe(3);
  });

  it('filters to the flows reaching one destination', () => {
    const h = buildHeatmap([doc, null], { fromMs, toMs, tz: 'UTC', include: flowsTo('s3') });
    expect(h.totalSavedM).toBe(350);
    expect(h.cells[5 * 24 + 14].savedM).toBe(300);
    expect(h.top).toHaveLength(2);
  });
});
