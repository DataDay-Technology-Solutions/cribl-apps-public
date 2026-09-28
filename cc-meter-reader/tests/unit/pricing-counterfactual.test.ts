// tests/unit/pricing-counterfactual.test.ts — P1-F01 across the layers: a counterfactual that names a destination
// with no price is flagged (core), counted by the Receipt banner (snapshot), captioned in the Prices picker and
// explained in Show the math — never a silent "$0.00 / GB = $0" credit.

import { describe, expect, it } from 'vitest';
import type { Flow, InventoryDoc, MinuteRow, PricesDoc } from '../../core/types.ts';
import { appendPriceVersion, effectivePrices, emptyPrices, priceMinute } from '../../core/pricing.ts';
import { buildSnapshot } from '../../core/snapshot.ts';
import { emptyTotals } from '../../core/rollups.ts';
import { makeFlowKey } from '../../core/flows.ts';
import { defaultSettings } from '../../core/settings.ts';
import { buildRows, counterfactualOptions, rowCounts } from '../../src/components/PriceTable/model.ts';
import { destinationRows } from '../../src/views/Receipt/model.ts';

const T = Date.parse('2026-09-26T17:00:05Z');
const WINDOW_END = Date.parse('2026-09-26T17:00:00Z');
const MIN = 60_000;

// The rig as the CFO probe found it: every output is a DevNull; archive-s3 is priced and says its data would
// otherwise go to analytics, which nobody priced.
const prices: PricesDoc = appendPriceVersion(
  emptyPrices('x'),
  {
    'default:mrd_siem_prod': { milliCentsPerGb: 225_000, preset: 'splunk_cloud' },
    'default:mrd_archive_s3': { milliCentsPerGb: 2_300, preset: 's3', counterfactual: { kind: 'other', outputId: 'mrd_analytics' } },
  },
  Date.parse('2026-09-01T00:00:00Z'),
);
const destinations = ['mrd_siem_prod', 'mrd_analytics', 'mrd_archive_s3'].map((outputId) => ({ groupId: 'default', outputId, type: 'devnull' }));

describe('P1-F01 · counterfactual to an unpriced destination', () => {
  it('core: the credit is flagged unknown, and the money is unchanged ($0 until the target has a price)', () => {
    const e = effectivePrices(prices, 'default', 'mrd_archive_s3', T, 'devnull');
    expect(e).toMatchObject({ paidMcPerGb: 2_300, whpMcPerGb: 0, unpriced: true, counterfactualUnpriced: true });
    // Pricing the target turns the flag off and the credit on, from the price's own start.
    const priced = appendPriceVersion(prices, { 'default:mrd_analytics': { milliCentsPerGb: 180_000, preset: 'datadog' } }, T);
    expect(effectivePrices(priced, 'default', 'mrd_archive_s3', T, 'devnull')).toMatchObject({ whpMcPerGb: 180_000, unpriced: false, counterfactualUnpriced: false });
  });

  it('Prices picker: a target with no price is captioned, and the row priced itself still reads priced', () => {
    const rows = buildRows(destinations, prices, T);
    const archive = rows.find((r) => r.outputId === 'mrd_archive_s3')!;
    expect(archive.unpriced).toBe(false);
    const labels = counterfactualOptions(archive, rows).map((o) => o.label);
    expect(labels).toEqual(['This destination', 'SIEM (prod)', 'Analytics (no price yet)', 'Nowhere (archive-only data)']);
    // The header's unpriced count is about rows with no price of their own: archive-s3 is not one of them.
    expect(rowCounts(rows.filter((r) => r.outputId !== 'mrd_analytics'))).toEqual({ total: 2, unpriced: 0 });
  });

  it('Receipt: the banner counts it and Show the math carries the reason', () => {
    const flow = (inputId: string, outputId: string): Flow => ({
      key: makeFlowKey('default', inputId, `r_${inputId}`, `p_${inputId}`, outputId),
      groupId: 'default',
      inputId,
      routeId: `r_${inputId}`,
      pipelineId: `p_${inputId}`,
      outputId,
      attribution: 'route',
    });
    const vpc = flow('mrd_vpc_flow', 'mrd_archive_s3');
    const rows: MinuteRow[] = Array.from({ length: 60 }, (_, i) => {
      const inB = 41_666_667; // 60 GB/day
      const outB = Math.round(inB * 0.2);
      return { t: new Date(WINDOW_END - (60 - i) * MIN).toISOString(), inB, outB, inE: 1, outE: 1, ...priceMinute({ inB, outB }, 2_300, 0, { kind: 'other', outputId: 'mrd_analytics' }) };
    });
    const inventory: InventoryDoc = {
      schemaVersion: 1,
      updatedAt: '',
      hash: 'h',
      byGroup: { default: { inputs: [], outputs: destinations.map((d) => ({ id: d.outputId, type: 'devnull' })), pipelines: [], routes: [] } },
    };
    const snapshot = buildSnapshot({
      sweepAtMs: T,
      windowStartMs: WINDOW_END - MIN,
      windowEndMs: WINDOW_END,
      mode: 'ui',
      settings: defaultSettings('x', 'UTC'),
      prices,
      inventory,
      flows: [vpc],
      minuteRows: { [vpc.key]: rows },
      totals: emptyTotals('x'),
      collectingSinceMs: Date.parse('2026-09-20T00:00:00Z'),
      incidents: [],
      timeline: [],
      deliveries: [],
      calls: 1,
      metricsSource: 'metrics-query',
    });
    // analytics is a DevNull standing in for a paid destination with no price of its own (P0-04), so it counts too.
    expect(snapshot.unpricedOutputIds).toEqual(['mrd_analytics', 'mrd_archive_s3']);
    const row = destinationRows(snapshot, prices).find((r) => r.outputId === 'mrd_archive_s3')!;
    expect(row).toMatchObject({ unpriced: true, counterfactualUnpriced: true, counterfactualLabel: 'Analytics', whpMcPerGb: 0 });
    // Without the prices document (sample data) the snapshot's own flag carries it.
    expect(destinationRows(snapshot, null).find((r) => r.outputId === 'mrd_archive_s3')!.counterfactualUnpriced).toBe(true);
    expect(destinationRows(snapshot, prices).find((r) => r.outputId === 'mrd_siem_prod')!.counterfactualUnpriced).toBe(false);
  });
});
