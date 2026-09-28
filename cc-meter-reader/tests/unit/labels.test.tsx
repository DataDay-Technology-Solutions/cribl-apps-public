// @vitest-environment jsdom
// Every percentage names its basis, and the other labels from the owner's critique (STATE.md, 9/26 4:12 PM):
//   • the Ledger's column is "Volume reduced" (a share of bytes) and each figure's hover says so;
//   • the Receipt hero keeps "60% saved" but its hover and Show the math say "of dollars, <period>";
//   • the Flow map's card reads "… saved at current rates" and "Paying now $… / hour";
//   • "Where the money goes" rows say "priced as <preset>" in place of the output type when a preset priced them;
//   • "What's saving the most" counts what it shows ("Top 3 …"), naming the basis alone with one line or none;
//   • a top saver's tooltip is "60% saved at current rates" (its ratio is dollars), not "60% reduced".
// The in-browser check (both themes, 1440 and 390, screenshots) is tests/e2e/labels.spec.ts.

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowFigures, Snapshot, TopSaver } from '../../core/types.ts';
import { ReceiptCard } from '../../src/components/FlowDiagram/ReceiptCard.tsx';
import { LedgerTable, buildRows, DEFAULT_SORT } from '../../src/components/LedgerTable/index.ts';
import { MathDrawer } from '../../src/components/MathDrawer/MathDrawer.tsx';
import { ReceiptBar } from '../../src/components/ReceiptBar/ReceiptBar.tsx';
import { WhereMoneyGoes, type MoneyDestination } from '../../src/components/WhereMoneyGoes/WhereMoneyGoes.tsx';
import { TopSaversCard } from '../../src/views/Receipt/Sections.tsx';
import { topSaverLines } from '../../src/views/Receipt/text.ts';

afterEach(() => cleanup());

// Capra's Drawer measures itself; jsdom has no ResizeObserver (it never fires here — no layout).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

// ─── Ledger: a share of bytes ─────────────────────────────────────────────────

function flow(inputId: string, over: Partial<FlowFigures> = {}): FlowFigures {
  return {
    key: `default|${inputId}|${inputId}|mrd_pipe|mrd_siem_prod`,
    groupId: 'default',
    inputId,
    routeId: inputId,
    pipelineId: 'mrd_pipe',
    outputId: 'mrd_siem_prod',
    inB: 1,
    outB: 1,
    whpM: 1,
    paidM: 1,
    savedM: 1,
    ratio: 0.5,
    ratePerHourM: 1,
    savedPerDayM: 5_000_000,
    whpPerDayM: 10_000_000,
    paidPerDayM: 5_000_000,
    inBPerDay: 40e9,
    outBPerDay: 20e9,
    attribution: 'route',
    sparkline: [0.5, 0.5],
    state: 'ok',
    ...over,
  };
}

function snapshot(flows: FlowFigures[]): Snapshot {
  return {
    schemaVersion: 1,
    sweepAt: iso(NOW),
    sweepStartedAt: iso(NOW - 800),
    collectingSince: iso(NOW - 3_600_000),
    ratePerSecM: 0,
    headline: {
      todayM: 0,
      mtdM: 0,
      d30M: 0,
      annualizedM: 0,
      annualizedFromDays: 0,
      whpMtdM: 0,
      paidMtdM: 0,
      ratioMtd: 0,
      whpTodayM: 0,
      paidTodayM: 0,
      whp30dM: 0,
      paid30dM: 0,
    },
    topSavers: [],
    flows,
    destinations: [],
    incidents: [],
    timeline: [],
    trend: [],
    unpricedOutputIds: [],
    attributionSummary: 'route',
    deliveries: [],
  } as unknown as Snapshot;
}

describe('the Ledger names its percentage as volume', () => {
  it('heads the column "Volume reduced" and says on hover that it is bytes, not dollars', () => {
    // 40 GB in, 20 GB out on both flows: 50% less volume on each row and in the totals.
    const rows = buildRows(snapshot([flow('a'), flow('b', { key: 'default|b|b|mrd_pipe|mrd_siem_prod' })]));
    render(<LedgerTable rows={rows} sort={DEFAULT_SORT} onSortChange={() => {}} layout="wide" totals={{ flows: 2, inBPerDay: 80e9, outBPerDay: 40e9, whpPerDayM: 20_000_000, paidPerDayM: 10_000_000, savedPerDayM: 10_000_000, reduction: 0.5 }} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toContain('Volume reduced');
    expect(headers).not.toContain('Reduction');
    // The totals row carries the hint (jsdom has no layout, so the virtualizer draws no flow rows here; the rows'
    // own hints are checked in the browser by tests/e2e/labels.spec.ts).
    expect(document.querySelector('.mr-lt-totals .mr-figure[title]')?.getAttribute('title')).toBe('50% less volume: bytes out against bytes in, not dollars');
    const hints = [...document.querySelectorAll('[role="cell"] .mr-figure[title]')].map((el) => el.getAttribute('title'));
    expect(hints.length).toBeGreaterThanOrEqual(1);
    for (const hint of hints) expect(hint).toBe('50% less volume: bytes out against bytes in, not dollars');
  });

  it('a flow with nothing in has no reduction and no hint (an em dash, never a title with a dash in it)', () => {
    const rows = buildRows(snapshot([flow('quiet', { inBPerDay: 0, outBPerDay: 0, whpPerDayM: 0, paidPerDayM: 0, savedPerDayM: 0 })]));
    render(<LedgerTable rows={rows} sort={DEFAULT_SORT} onSortChange={() => {}} layout="wide" />);
    expect(document.querySelectorAll('[role="cell"] .mr-figure[title]')).toHaveLength(0);
  });
});

// ─── Receipt hero: a share of dollars for the period ─────────────────────────

describe('the Receipt hero keeps "% saved" and says what it is a share of', () => {
  it('hover and a visually hidden suffix carry the basis; the visible figure is unchanged', () => {
    render(<ReceiptBar whpM={6_841_200_000} paidM={2_718_100_000} savedM={4_123_100_000} ratio={0.6027} basis="of dollars, month to date" />);
    const pct = screen.getByTestId('receipt-saved-pct');
    expect(pct.getAttribute('title')).toBe('of dollars, month to date');
    expect(screen.getByText('60% saved')).toBeTruthy();
    expect(pct.textContent).toBe('60% saved of dollars, month to date');
    expect(pct.querySelector('.mr-visually-hidden')?.textContent).toBe(' of dollars, month to date');
  });

  it('a bare bar (the Story stage) carries no basis', () => {
    render(<ReceiptBar whpM={100} paidM={40} savedM={60} ratio={0.6} />);
    const pct = screen.getByTestId('receipt-saved-pct');
    expect(pct.hasAttribute('title')).toBe(false);
    expect(pct.textContent).toBe('60% saved');
  });

  it('Show the math says the same basis under the ratio, and why the Ledger and the Flow map differ', () => {
    render(
      <MathDrawer
        isOpen
        onClose={() => {}}
        periodCaption="month to date"
        figures={{ period: 'mtd', savedM: 4_123_100_000, whpM: 6_841_200_000, paidM: 2_718_100_000, ratio: 0.6027, accrues: true }}
        destinations={[]}
        attribution="route"
        sweepAtMs={NOW}
        ratePerSecM={0}
        tz="UTC"
      />,
    );
    expect(screen.getByTestId('math-ratio-basis').textContent).toBe(
      "60% is a share of dollars, month to date. The Ledger's volume reduced is a share of bytes, and the Flow map prices one day at current rates.",
    );
  });
});

// ─── Flow map: dollars at current rates, with a verb on the rate ─────────────

describe('the Flow map card', () => {
  const totals = { inBPerDay: 40e9, outBPerDay: 20e9, whpPerDayM: 10_000_000, paidPerDayM: 5_000_000, savedPerDayM: 5_000_000, ratePerHourM: 208_333 };

  it('reads "50% saved at current rates" and "Paying now $2 / hour", in the lines and in the summary', () => {
    render(<ReceiptCard heading="All flows in default" totals={totals} />);
    expect(screen.getByText('50% saved at current rates')).toBeTruthy();
    expect(screen.queryByText(/of would-have-paid/)).toBeNull();
    const now = screen.getByTestId('receipt-now');
    expect(within(now).getByText('Paying now')).toBeTruthy();
    expect(now.textContent).toBe('Paying now$2/ hour');
    const card = screen.getByTestId('flow-receipt');
    expect(card.getAttribute('aria-label')).toContain('Paying now $2 / hour, 1.0× baseline');
    expect(card.getAttribute('aria-label')).not.toMatch(/\bNow \$/);
  });
});

// ─── Where the money goes: "priced as <preset>" in place of the type ─────────

describe('Where the money goes rows', () => {
  const row = (over: Partial<MoneyDestination>): MoneyDestination => ({
    key: 'default:siem',
    outputId: 'siem',
    label: 'siem-prod',
    type: 'devnull',
    whpPerDayM: 60_000_000,
    paidPerDayM: 25_500_000,
    savedPerDayM: 34_500_000,
    paidMcPerGb: 225_000,
    counterfactual: { kind: 'same' },
    unpriced: false,
    ratio: 0.575,
    ...over,
  });

  it('say "priced as Splunk Cloud · $2.25 / GB" when a preset priced the destination', () => {
    render(<WhereMoneyGoes rows={[row({ presetLabel: 'Splunk Cloud' })]} />);
    const basis = document.querySelector('.mr-wmg-type');
    expect(basis?.textContent).toBe('priced as Splunk Cloud');
    expect(basis?.getAttribute('data-basis')).toBe('preset');
    expect(screen.queryByText('devnull')).toBeNull();
    expect(screen.getByText('$2.25 / GB')).toBeTruthy();
  });

  it('keep the output type without a preset, and for an unpriced destination whatever its entry says', () => {
    render(
      <WhereMoneyGoes
        rows={[
          row({ key: 'default:custom', outputId: 'custom', label: 'custom-priced', type: 'splunk_hec' }),
          row({ key: 'default:edge', outputId: 'edge', label: 'edge', type: 'webhook', presetLabel: 'Splunk Cloud', unpriced: true, whpPerDayM: 0, paidPerDayM: 0, savedPerDayM: 0 }),
        ]}
      />,
    );
    const bases = [...document.querySelectorAll('.mr-wmg-type')].map((el) => [el.textContent, el.getAttribute('data-basis')]);
    expect(bases).toEqual([
      ['splunk_hec', 'type'],
      ['webhook', 'type'],
    ]);
  });
});

// ─── What's saving the most: the caption counts what it shows ────────────────

describe("What's saving the most", () => {
  const saver = (n: number): TopSaver => ({
    objectKey: `route:default:r${n}`,
    label: `Flow ${n}`,
    savedPerDayM: 100_000_000 - n,
    ratio: 0.6,
    groupId: 'default',
    pipelineId: `p${n}`,
  });
  const caption = () => document.querySelector('.mr-receipt-card-caption')?.textContent;

  it('"Top 3" over three lines, "Top 5" over five', () => {
    const { unmount } = render(<TopSaversCard savers={[saver(1), saver(2), saver(3)]} />);
    expect(caption()).toBe('Top 3 by savings per day, at current rates');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    unmount();
    render(<TopSaversCard savers={[1, 2, 3, 4, 5].map(saver)} />);
    expect(caption()).toBe('Top 5 by savings per day, at current rates');
  });

  it('names the basis alone over one line, and over the empty state', () => {
    const { unmount } = render(<TopSaversCard savers={[saver(1)]} />);
    expect(caption()).toBe('Savings per day, at current rates');
    unmount();
    render(<TopSaversCard savers={[]} />);
    expect(caption()).toBe('Savings per day, at current rates');
    expect(screen.getByText('No savings yet')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it("a saver's tooltip is its saved share in dollars, never 'reduced'", () => {
    const [line] = topSaverLines([saver(1)], 'https://leader.example.com');
    expect(line.title).toBe('Flow 1 · 60% saved at current rates');
    expect(line.title).not.toContain('reduced');
  });
});
