// @vitest-environment jsdom
// Usefulness review, round 2: "did Cribl pay for itself?" was blank on a fresh install's Receipt — the $0.32/GB
// suggestion lived only inside Settings → Cribl cost, and the Report card said "no Cribl cost is set". With no cost
// set and the ingest measured, the Receipt nets a list-price estimate, always labelled as one ("≈", "at list price",
// "Estimate at Cribl's list price: …") with a link to enter the contract cost, and the Report card's check carries
// the same estimate. Nothing is stored: Settings saves only what an admin enters. One formula feeds all three
// (core/presets.ts suggestCriblCost; the Settings model re-exports the Receipt model's suggestion).

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { suggestCriblCost } from '../../core/presets.ts';
import type { FlowFigures, Snapshot } from '../../core/types.ts';
import type { ReportCard } from '../../core/report.ts';
import { ReceiptBar } from '../../src/components/ReceiptBar/ReceiptBar.tsx';
import { en } from '../../src/copy/en.ts';
import { reportChecks } from '../../src/views/Report/model.ts';
import { criblCostSuggestion, listPriceEstimate, netFigures } from '../../src/views/Receipt/model.ts';
import { estimateBasisLine, estimatePaybackWords, receiptNetLine } from '../../src/views/Receipt/text.ts';
import { criblCostSuggestion as settingsSuggestion } from '../../src/views/Settings/model.ts';

afterEach(cleanup);

const SWEEP = '2026-09-27T12:00:00.000Z';
const flow = (inputId: string, gbPerDay: number): FlowFigures => ({ key: inputId, groupId: 'default', inputId, inBPerDay: gbPerDay * 1e9 }) as FlowFigures;

function snap(flows: FlowFigures[]): Snapshot {
  return {
    flows,
    sweepAt: SWEEP,
    windowEnd: SWEEP,
    collectingSince: '2026-09-01T00:00:00.000Z',
    headline: { mtdM: 30_000_000_000, todayM: 1_000_000_000, last30dM: 30_000_000_000, annualizedM: 365_000_000_000 },
    trend: [],
  } as unknown as Snapshot;
}

describe('one Cribl-cost suggestion', () => {
  it("Settings and the Receipt share it, and it is core's formula rounded to whole dollars", () => {
    const s = snap([flow('a', 300), flow('b', 150)]);
    expect(settingsSuggestion).toBe(criblCostSuggestion);
    const core = suggestCriblCost(450e9)!;
    const ui = criblCostSuggestion(s)!;
    expect(ui.centsPerMonth).toBe(Math.round(core.centsPerMonth / 100) * 100);
    expect(ui.listMcPerGb).toBe(core.milliCentsPerGb);
    expect(ui.centsPerMonth).toBe(438_000);
  });
});

describe('the list-price estimate', () => {
  it('nets the period at the suggested cost, exactly as a set cost would', () => {
    const s = snap([flow('a', 300), flow('b', 150)]);
    const est = listPriceEstimate(s, 'annualized', 'UTC')!;
    expect(est.suggestion.centsPerMonth).toBe(438_000);
    expect(est.net).toEqual(netFigures(s, 'annualized', 438_000, 'UTC'));
    expect(est.net.paybackX).toBeCloseTo(365_000_000_000 / (438_000 * 1000 * 12), 6);
  });

  it('abstains without an exact byte figure or traffic', () => {
    expect(listPriceEstimate(snap([flow('a', 300), flow('a', 300)]), 'mtd', 'UTC')).toBeUndefined();
    expect(listPriceEstimate(snap([flow('a', 0)]), 'mtd', 'UTC')).toBeUndefined();
  });

  it('its words always say estimate: ≈, at list price, and the formula', () => {
    expect(estimatePaybackWords(6.94)).toBe('Paid for itself ≈6.9× at list price');
    expect(estimatePaybackWords(0.456)).toBe('Covered ≈45% of its cost at list price');
    expect(estimateBasisLine({ bytesInPerDay: 450e9, listMcPerGb: 32_000, centsPerMonth: 438_000 })).toBe(
      "Estimate at Cribl's list price: 450.0 GB a day × $0.32 per GB ≈ $4,380 a month.",
    );
  });

  it('the net line renders it as an estimate with a link to the contract cost', () => {
    render(
      <ReceiptBar
        whpM={6_841_200_000}
        paidM={2_718_100_000}
        savedM={4_123_100_000}
        ratio={0.6027}
        net={{ netM: 3_323_000_000, paybackX: 4.2, paybackText: estimatePaybackWords(4.2), basis: 'Estimate at list price.', estimate: { href: '/settings?section=cost' } }}
      />,
    );
    const net = screen.getByTestId('receipt-net');
    expect(net.getAttribute('data-estimate')).toBe('true');
    expect(net.textContent).toContain('Net after Cribl ≈ $33,230');
    expect(net.textContent).toContain('Paid for itself ≈4.2× at list price');
    const link = screen.getByTestId('receipt-net-estimate-link');
    expect(link.textContent).toBe('Set your contract cost');
    expect(link.getAttribute('href')).toBe('/settings?section=cost');
  });

  it('a set cost reads as before: no ≈, no estimate, no link', () => {
    render(<ReceiptBar whpM={6_841_200_000} paidM={2_718_100_000} savedM={4_123_100_000} ratio={0.6027} net={{ netM: 3_323_000_000, paybackX: 4.2 }} />);
    const net = screen.getByTestId('receipt-net');
    expect(net.getAttribute('data-estimate')).toBeNull();
    expect(net.textContent).toContain('Net after Cribl $33,230');
    expect(screen.queryByTestId('receipt-net-estimate-link')).toBeNull();
  });
});

describe('the hero net line', () => {
  const s = snap([flow('a', 300), flow('b', 150)]);
  it('a set contract cost reads as it always did', () => {
    const line = receiptNetLine(netFigures(s, 'annualized', 500_000, 'UTC'), undefined)!;
    expect(line.estimate).toBeUndefined();
    expect(line.paybackText).toMatch(/^Paid for itself [\d.]+×$/);
  });
  it('no cost: the list-price estimate, labelled', () => {
    const line = receiptNetLine(null, listPriceEstimate(s, 'annualized', 'UTC'))!;
    expect(line.estimate).toEqual({ href: '/settings?section=cost' });
    expect(line.basis).toBe("Estimate at Cribl's list price: 450.0 GB a day × $0.32 per GB ≈ $4,380 a month.");
  });
  it('a cost saved from the estimate keeps reading as one (Settings.criblCostEstimate)', () => {
    const line = receiptNetLine(netFigures(s, 'annualized', 438_000, 'UTC'), undefined, true)!;
    expect(line.estimate).toEqual({ href: '/settings?section=cost' });
    expect(line.paybackText).toMatch(/^Paid for itself ≈[\d.]+× at list price$/);
    expect(line.basis).toBe("Cribl cost $4,380 a month, an estimate at Cribl's list price.");
  });
  it('nothing at all: no line', () => {
    expect(receiptNetLine(null, undefined)).toBeNull();
  });
});

describe('Settings → Cribl cost saves the suggestion as an estimate', () => {
  it('flags a cost saved at exactly the suggestion; any other figure is a contract cost', async () => {
    const { applyCost } = await import('../../src/views/Settings/model.ts');
    const { defaultSettings } = await import('../../core/settings.ts');
    const base = defaultSettings(SWEEP, 'UTC');
    const flagged = applyCost(base, '4,380', 438_000).next as { criblCostEstimate?: true; criblCostCentsPerMonth?: number };
    expect(flagged.criblCostCentsPerMonth).toBe(438_000);
    expect(flagged.criblCostEstimate).toBe(true);
    const contract = applyCost({ ...base, criblCostEstimate: true } as typeof base, '3,900', 438_000).next as { criblCostEstimate?: true };
    expect(contract.criblCostEstimate).toBeUndefined();
    expect((applyCost(base, '4,380').next as { criblCostEstimate?: true }).criblCostEstimate).toBeUndefined();
    expect((applyCost(base, ' ', 438_000).next as { criblCostEstimate?: true }).criblCostEstimate).toBeUndefined();
  });
});

describe("the Report card's check", () => {
  const card = (annualM: number) =>
    ({ priceMix: { list: 0 }, destinations: { unpricedLabels: [] }, runRate: { annualM, monthlyM: annualM / 12, fromDays: 1, basis: '' } }) as unknown as ReportCard;
  const suggestion = { bytesInPerDay: 450e9, listMcPerGb: 32_000, centsPerMonth: 438_000 };

  it('names the estimate and its payback at the run rate when the ingest is measured', () => {
    const [line] = reportChecks(card(36_500_000_000), suggestion); // $365,000 a year against $52,560
    expect(line).toBe(
      "No Cribl cost is set, so the report shows no return. At Cribl's list price (450.0 GB a day × $0.32 per GB ≈ $4,380 a month), Cribl pays for itself ≈6.9× at the annualized run rate. An admin can enter the contract cost in Settings → Cribl cost.",
    );
  });

  it('under 1× says what share the savings cover', () => {
    const [line] = reportChecks(card(2_000_000_000), suggestion); // $20,000 a year
    expect(line).toContain('the savings cover ≈38% of it at the annualized run rate');
  });

  it('without a suggestion it says what it always said', () => {
    expect(reportChecks(card(365_000_000_000))).toEqual([en.report.view.checkNoCost]);
  });
});
