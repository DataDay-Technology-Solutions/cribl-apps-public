// @vitest-environment jsdom
// tests/unit/wave3-foot-flow-heat.test.tsx — W3-RECEIPT-1's rule carried to the last three places that printed a
// would-have-paid / paid / saved triple unfooted: the Flow map's receipt card, the Flow stage's cursor tip (same
// footMoney call) and the destination statement's hour-of-week read-out. Each rounded on its own, $100.40 / $49.60 /
// $50.80 printed $100 / $50 / $51, which does not add up; footed it prints $100 / $49 / $51.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Heatmap as HeatmapData, HeatCell } from '../../core/heatmap.ts';
import { ReceiptCard } from '../../src/components/FlowDiagram/ReceiptCard.tsx';
import { Heatmap } from '../../src/components/Heatmap/Heatmap.tsx';

const DOLLAR = 100_000; // millicents
const WHP = 100.4 * DOLLAR;
const PAID = 49.6 * DOLLAR;
const SAVED = 50.8 * DOLLAR;

afterEach(() => cleanup());

describe('the Flow receipt card foots its triple', () => {
  it('prints would have paid $100, paid $49, saved $51 (not paid $50)', () => {
    render(
      <ReceiptCard
        heading="Payments API"
        totals={{ inBPerDay: 2e9, outBPerDay: 1e9, whpPerDayM: WHP, paidPerDayM: PAID, savedPerDayM: SAVED, ratePerHourM: 0 }}
      />,
    );
    expect(screen.getByTestId('receipt-whp').textContent).toContain('$100');
    expect(screen.getByTestId('receipt-paid').textContent).toContain('$49');
    expect(screen.getByTestId('receipt-paid').textContent).not.toContain('$50');
    expect(screen.getByTestId('receipt-saved').textContent).toContain('$51');
  });

  it('keeps a real gap: a triple that does not foot prints paid as its own rounding', () => {
    // saved is 0 while would have paid − paid is $50.80 (a flow that saves nothing): paid stays $50.
    render(<ReceiptCard heading="Nowhere" totals={{ inBPerDay: 1e9, outBPerDay: 1e9, whpPerDayM: WHP, paidPerDayM: PAID, savedPerDayM: 0, ratePerHourM: 0 }} />);
    expect(screen.getByTestId('receipt-paid').textContent).toContain('$50');
  });
});

describe("the statement's hour-of-week read-out foots its triple", () => {
  it('reads saved $51 · would have paid $100 · paid $49 for the hour', () => {
    const cells: HeatCell[] = Array.from({ length: 168 }, (_, i) => ({ day: Math.floor(i / 24), hour: i % 24, savedM: 0, whpM: 0, paidM: 0, rows: 0 }));
    cells[0] = { day: 0, hour: 0, savedM: SAVED, whpM: WHP, paidM: PAID, rows: 1 };
    cells[1] = { day: 0, hour: 1, savedM: SAVED * 2, whpM: WHP * 2, paidM: PAID * 2, rows: 1 };
    const data: HeatmapData = { cells, fromMs: 0, toMs: 168 * 3_600_000, maxSavedM: SAVED * 2, totalSavedM: SAVED * 3, top: [1, 0], hoursMetered: 2 };
    render(<Heatmap data={data} label="siem-prod" />);
    // The arrow keys start from the biggest hour (cell 1); Left moves to cell 0.
    fireEvent.keyDown(screen.getByRole('img'), { key: 'ArrowLeft' });
    const text = screen.getByTestId('heat-readout').textContent ?? '';
    expect(text).toContain('saved $51');
    expect(text).toContain('would have paid $100');
    expect(text).toContain('paid $49');
  });
});
