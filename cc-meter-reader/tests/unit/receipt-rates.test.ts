// P1-F10 (the honest part) — the hero says what its dollars are priced at: 'at contract rates' once every destination
// carrying money has a price the member entered (their rate, or a stored committed rate), 'at preset prices' while any
// still sits at a preset's typical list price. The money model is unchanged: pricing paid at a committed rate and
// would-have-paid at list would book the negotiated discount as "Saved by Cribl" (see the item's open issue).

import { describe, expect, it } from 'vitest';
import type { DestinationFigures, PricesDoc, Snapshot } from '../../core/types.ts';
import { appendPriceVersion, effectivePrices, emptyPrices } from '../../core/pricing.ts';
import { priceBasisSummary, receiptBasis } from '../../core/receipt.ts';

const AT = Date.parse('2026-09-26T17:00:00Z');

function dest(outputId: string, mtdWhpM: number, over: Partial<DestinationFigures> = {}): DestinationFigures {
  return {
    groupId: 'default',
    outputId,
    type: 'splunk_hec',
    whpPerDayM: 0,
    paidPerDayM: 0,
    savedPerDayM: 0,
    mtdPaidM: Math.round(mtdWhpM / 2),
    mtdSavedM: Math.round(mtdWhpM / 2),
    mtdWhpM,
    milliCentsPerGb: 225_000,
    counterfactual: { kind: 'same' },
    unpriced: false,
    ...over,
  };
}

const snapshot = (destinations: DestinationFigures[]): Pick<Snapshot, 'destinations' | 'sweepAt'> => ({ destinations, sweepAt: new Date(AT).toISOString() });

function prices(byOutputId: PricesDoc['versions'][number]['byOutputId']): PricesDoc {
  return appendPriceVersion(emptyPrices('x'), byOutputId, Date.parse('2026-09-01T00:00:00Z'));
}

describe('P1-F10 · at preset prices ↔ at contract rates', () => {
  const dests = [dest('splunk', 900_000_00), dest('datadog', 300_000_00, { type: 'datadog' }), dest('idle', 0)];

  it('any money-carrying destination at a preset typical list price: at preset prices, with the count', () => {
    const p = prices({
      splunk: { milliCentsPerGb: 160_000, preset: 'splunk_cloud' }, // the member's rate
      datadog: { milliCentsPerGb: 180_000, preset: 'datadog' }, // still the typical list price
    });
    expect(priceBasisSummary(snapshot(dests), p)).toEqual({ kind: 'preset', custom: 1, total: 2 });
  });

  it('every money-carrying destination at the member\'s own rate: at contract rates (an idle one does not count)', () => {
    const p = prices({
      splunk: { milliCentsPerGb: 160_000, preset: 'splunk_cloud' },
      datadog: { milliCentsPerGb: 120_000 },
      idle: { milliCentsPerGb: 225_000, preset: 'splunk_cloud' },
    });
    expect(priceBasisSummary(snapshot(dests), p)).toEqual({ kind: 'contract', custom: 2, total: 2 });
  });

  it('a stored committed rate is the member\'s own, never a preset: it counts as a contract rate', () => {
    const p = prices({
      splunk: { milliCentsPerGb: 225_000, preset: 'splunk_cloud', committedMilliCentsPerGb: 150_000 },
      datadog: { milliCentsPerGb: 120_000 },
    });
    expect(priceBasisSummary(snapshot(dests), p)).toMatchObject({ kind: 'contract' });
    const basis = receiptBasis({ byOutput: { 'default:splunk': { whpM: 9, paidM: 4, savedM: 5 } }, prices: p, atMs: AT });
    expect(basis.prices[0].source).toBe('custom');
  });

  it('nothing priced carries money: no badge', () => {
    expect(priceBasisSummary(snapshot([dest('splunk', 0)]), prices({ splunk: { milliCentsPerGb: 225_000, preset: 'splunk_cloud' } }))).toBeUndefined();
    expect(priceBasisSummary(null, null)).toBeUndefined();
  });

  it('the money model is unchanged: a committed rate does not split paid from would-have-paid', () => {
    const p = prices({ splunk: { milliCentsPerGb: 225_000, preset: 'splunk_cloud', committedMilliCentsPerGb: 150_000 } });
    const eff = effectivePrices(p, 'default', 'splunk', AT);
    expect(eff.paidMcPerGb).toBe(225_000);
    expect(eff.whpMcPerGb).toBe(225_000);
  });
});
