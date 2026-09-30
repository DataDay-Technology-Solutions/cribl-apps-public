// @vitest-environment jsdom
// tests/unit/wave3-foot-ledger.test.tsx — W3-RECEIPT-1's rule carried to the places the wave-3 review still found
// printing a would-have-paid / paid / saved triple rounded one figure at a time: the Ledger's money strip, the
// Settings → Prices "At these prices" card and its destination lines, and the Receipt's Top savers. The rule is the
// Receipt's own (core/format.ts footMoney): would have paid and saved rounded on their own, paid the difference; so
// $916.40 / $654.60 / $261.80 prints $916 / $654 / $262 on every view, never $916 / $655 / $262.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { footColumn } from '../../core/format.ts';
import type { TopSaver } from '../../core/types.ts';
import { MoneyStrip } from '../../src/views/Ledger/MoneyStrip.tsx';
import { ReceiptTotals } from '../../src/components/PriceTable/LiveReceipt.tsx';
import type { DraftReceipt } from '../../src/components/PriceTable/receiptModel.ts';
import { footedSavers, saverTotalLines, topSaverLines } from '../../src/views/Receipt/text.ts';

const DOLLAR = 100_000; // millicents
const WHP = 916.4 * DOLLAR;
const PAID = 654.6 * DOLLAR;
const SAVED = 261.8 * DOLLAR;
const dollars = (s: string): number => Number(s.replace(/[^0-9]/g, ''));

afterEach(() => cleanup());

describe('footColumn: lines under a total add up to the total as printed', () => {
  it('the review case: $123.50 + $74.50 + $62.50 print $124 + $75 + $62 under a $261 total', () => {
    const lines = footColumn([123.5 * DOLLAR, 74.5 * DOLLAR, 62.5 * DOLLAR], 260.5 * DOLLAR);
    expect(lines.reduce((a, b) => a + b, 0)).toBe(261 * DOLLAR);
    expect(lines.every((v) => v % DOLLAR === 0)).toBe(true);
    // Each line moves at most a dollar from its own rounding.
    expect(lines.map((v) => v / DOLLAR)).toEqual([124, 75, 62]);
  });

  it('adds the dollar rounding lost to the line closest to rounding up', () => {
    expect(footColumn([10.4 * DOLLAR, 20.45 * DOLLAR, 30.1 * DOLLAR], 60.95 * DOLLAR).map((v) => v / DOLLAR)).toEqual([10, 21, 30]);
  });

  it('leaves lines alone when they already add up, and never hides a gap bigger than a dollar a line', () => {
    expect(footColumn([1 * DOLLAR, 2 * DOLLAR], 3 * DOLLAR)).toEqual([1 * DOLLAR, 2 * DOLLAR]);
    expect(footColumn([1 * DOLLAR, 2 * DOLLAR], 30 * DOLLAR)).toEqual([1 * DOLLAR, 2 * DOLLAR]);
    expect(footColumn([], 5 * DOLLAR)).toEqual([]);
  });

  it('never takes a line below zero', () => {
    const lines = footColumn([0.4 * DOLLAR, 0, 5.4 * DOLLAR], 4.6 * DOLLAR);
    expect(lines.every((v) => v >= 0)).toBe(true);
    // Founder-build r3 core-7 (FINDINGS_R3 #10): the $0.40 line keeps its exact amount ('< $1'), never "$0"; the dollar
    // lines foot to the total as printed.
    expect(lines).toEqual([0.4 * DOLLAR, 0, 5 * DOLLAR]);
    expect(lines.filter((v) => v % DOLLAR === 0).reduce((a, b) => a + b, 0)).toBe(5 * DOLLAR);
  });
});

describe('the Ledger money strip foots its triple', () => {
  it('prints would have paid $916, paid $654, saved $262 (not paid $655), keeping the exact figures in data-value', () => {
    render(
      <MoneyStrip
        totals={{ flows: 6, inBPerDay: 2e9, outBPerDay: 1e9, whpPerDayM: WHP, paidPerDayM: PAID, savedPerDayM: SAVED, reduction: 0.5 }}
        countText="6 flows"
      />,
    );
    const strip = screen.getByTestId('ledger-strip');
    const figure = (key: string) => strip.querySelector(`[data-tile="${key}"] .mr-ledger-tile-figure`) as HTMLElement;
    const printed = (key: string) => dollars(figure(key).querySelector('.mr-num')?.textContent ?? '');
    expect(printed('whp')).toBe(916);
    expect(printed('paid')).toBe(654);
    expect(printed('saved')).toBe(262);
    expect(printed('whp') - printed('paid')).toBe(printed('saved'));
    expect(Number(figure('paid').getAttribute('data-value'))).toBe(PAID);
  });
});

describe('Settings → Prices "At these prices" prints the same footed triple', () => {
  it('reads ~ $916 / ~ $654 / ~ $262 from the receipt model’s footed figures', () => {
    const receipt: DraftReceipt = {
      rows: {},
      total: { whpPerDayM: WHP, paidPerDayM: PAID, savedPerDayM: SAVED, destinations: 3 },
      shown: { whpM: 916 * DOLLAR, paidM: 654 * DOLLAR, savedM: 262 * DOLLAR },
    };
    render(<ReceiptTotals receipt={receipt} />);
    const amount = (key: string) => dollars(screen.getByTestId(`prices-receipt-${key}`).querySelector('.mr-pt-totals-amount')?.textContent ?? '');
    expect(amount('whp')).toBe(916);
    expect(amount('paid')).toBe(654);
    expect(amount('saved')).toBe(262);
  });
});

describe('the Top savers add up to their "All flows" line', () => {
  const saver = (label: string, dollarsPerDay: number): TopSaver => ({
    objectKey: `pipe:default:${label}` as TopSaver['objectKey'],
    label,
    savedPerDayM: dollarsPerDay * DOLLAR,
    ratio: 0.5,
    groupId: 'default',
    pipelineId: label,
  });

  it('every flow listed: the lines print $124 + $75 + $62 under All flows $261, the workspace figure', () => {
    const savers = [saver('Windows XML pack', 123.5), saver('Payments API sampling', 74.5), saver('Kubernetes noise filter', 62.5)];
    const totals = { allM: 260.5 * DOLLAR, count: 3 };
    const lines = topSaverLines(savers, null, totals);
    const [total] = saverTotalLines(savers, totals);
    expect(total.id).toBe('total');
    expect(total.amountM).toBe(260.5 * DOLLAR); // prints $261, the hero's figure
    const printed = lines.map((l) => l.amountM / DOLLAR);
    expect(printed.every(Number.isInteger)).toBe(true);
    expect(printed.reduce((a, b) => a + b, 0)).toBe(261);
  });

  it('with an "N other flows" line, the savers and the others add up to the total', () => {
    const savers = [saver('A', 100.5), saver('B', 50.5)];
    const totals = { allM: 200.4 * DOLLAR, count: 5 };
    const { saversM, othersM, hasOthers } = footedSavers(savers, totals);
    expect(hasOthers).toBe(true);
    expect([...saversM, othersM].reduce((a, b) => a + b, 0)).toBe(200 * DOLLAR);
    const rest = saverTotalLines(savers, totals);
    expect(rest.map((l) => l.id)).toEqual(['others', 'total']);
    expect(rest[0].amountM).toBe(othersM);
  });

  it('without totals, a line prints its own figure (the list alone)', () => {
    expect(topSaverLines([saver('A', 10.6)], null).map((l) => l.amountM)).toEqual([10.6 * DOLLAR]);
  });
});
