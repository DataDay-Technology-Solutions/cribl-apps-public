// @vitest-environment jsdom
// Receipt components in isolation: the Meter (static, reduced-motion and ticking paths, the throttled
// live region), the receipt bar, receipt lines, the trend chart's states and markers, where the money
// goes, and the how-it-works strip.

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtDollars } from '../../core/format.ts';
import type { Commit, TrendPoint } from '../../core/types.ts';
import { HowItWorks } from '../../src/components/HowItWorks/HowItWorks.tsx';
import { Meter } from '../../src/components/Meter/Meter.tsx';
import { ReceiptBar } from '../../src/components/ReceiptBar/ReceiptBar.tsx';
import { paidShare, slot } from '../../src/components/ReceiptBar/slot.tsx';
import { ReceiptList } from '../../src/components/ReceiptList/ReceiptList.tsx';
import { TrendChart } from '../../src/components/TrendChart/TrendChart.tsx';
import { collectedDays, completeDays, deployMarkers, nearestIndex, niceMax, nothingSaved } from '../../src/components/TrendChart/trendMath.ts';
import { WhereMoneyGoes, type MoneyDestination } from '../../src/components/WhereMoneyGoes/WhereMoneyGoes.tsx';
import { formatPricePerGb } from '../../src/components/WhereMoneyGoes/price.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const figure = () => document.querySelector<HTMLElement>('[data-callout="saved"]');

describe('Meter', () => {
  it('a roll-up announces the figure it rolls to, never the $0 it rolls from (P2-W19, review W2)', () => {
    render(<Meter valueM={9_557_387_760} ratePerSecM={0} anchorMs={Date.now()} label="Saved by Cribl, annualized run rate" rollIn={`test-${Math.random()}`} />);
    const live = document.querySelector('[role="status"]')!;
    expect(live.textContent).toBe('Saved by Cribl, annualized run rate: $95,574');
  });

  it('a static meter (rate 0) prints whole dollars from core/format and does not tick', () => {
    render(<Meter valueM={257_609_700_000} ratePerSecM={0} anchorMs={Date.now()} label="Saved by Cribl, annualized run rate" />);
    expect(figure()?.dataset.ticking).toBe('false');
    expect(figure()?.textContent).toBe(fmtDollars(257_609_700_000));
    expect(document.querySelector('.mr-meter-cents')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(`Saved by Cribl, annualized run rate: ${fmtDollars(257_609_700_000)}`);
  });

  it('a static figure is announced as it reads, rounded like the text, not floored like the wheels (wave 1 review)', () => {
    // $544,973.66: the plain text rounds to $544,974, and so must the words a screen reader hears.
    render(<Meter valueM={54_497_365_836} ratePerSecM={0} anchorMs={Date.now()} label="Saved by Cribl, month to date" />);
    expect(figure()?.textContent).toBe('$544,974');
    expect(screen.getByRole('status').textContent).toBe('Saved by Cribl, month to date: $544,974');
  });

  it('reduced motion: no wheels, no cents, even with a rate', () => {
    render(<Meter valueM={17_941_385_000} ratePerSecM={9_000} anchorMs={Date.now()} label="Saved" reducedMotion />);
    expect(figure()?.dataset.ticking).toBe('false');
    expect(document.querySelector('.mr-meter-wheel')).toBeNull();
    expect(figure()?.textContent).toBe('$179,414');
  });

  it('ticks: cents appear as wheels, the value accrues each frame, the live region stays throttled', () => {
    vi.useFakeTimers({ toFake: ['Date', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'setInterval'] });
    vi.setSystemTime(Date.parse('2026-09-26T12:00:00.000Z'));
    const now = Date.now();
    render(<Meter valueM={100_000_000} ratePerSecM={100_000} anchorMs={now} label="Saved by Cribl, month to date" />);
    expect(figure()?.dataset.ticking).toBe('true');
    expect(document.querySelectorAll('.mr-meter-cents .mr-meter-wheel')).toHaveLength(2);
    // $1,000.00 → four dollar wheels + two cent wheels.
    expect(document.querySelectorAll('.mr-meter-wheel')).toHaveLength(6);
    const v0 = Number(figure()?.dataset.valueM);
    expect(v0).toBe(100_000_000);
    const announced = screen.getByRole('status').textContent;
    expect(announced).toBe('Saved by Cribl, month to date: $1,000');
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const v1 = Number(figure()?.dataset.valueM);
    expect(v1).toBeGreaterThan(v0);
    expect(v1).toBeLessThanOrEqual(100_000_000 + 2 * 100_000 + 1);
    // Within 30 s the announcement does not change even though the value did.
    expect(screen.getByRole('status').textContent).toBe(announced);
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    // The next announcement lands on the 30-second mark ($1,000 + 30 s × $1 / s).
    expect(screen.getByRole('status').textContent).toBe('Saved by Cribl, month to date: $1,030');
  });

  it('a new label is announced at once with the figure it stands for, not after the 30 s throttle (1.1.4, §7.3)', () => {
    vi.useFakeTimers({ toFake: ['Date', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'setInterval'] });
    vi.setSystemTime(Date.parse('2026-09-26T12:00:00.000Z'));
    const t0 = Date.now();
    // The Receipt's one ticking meter: month to date, then a switch to Today five seconds later.
    const { rerender } = render(<Meter valueM={100_000_000} ratePerSecM={100_000} anchorMs={t0} label="Saved by Cribl, month to date" />);
    expect(screen.getByRole('status').textContent).toBe('Saved by Cribl, month to date: $1,000');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    const t1 = Date.now();
    rerender(<Meter valueM={40_000_000} ratePerSecM={100_000} anchorMs={t1} label="Saved by Cribl, today" />);
    // Never "month to date: …" on Today, and never the MTD figure the wheels are still easing down from.
    expect(screen.getByRole('status').textContent).toBe('Saved by Cribl, today: $400');
    // Back to the throttle after that: the value moves, the words wait for the next 30-second mark.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByRole('status').textContent).toBe('Saved by Cribl, today: $400');
    act(() => {
      vi.advanceTimersByTime(26_000);
    });
    expect(screen.getByRole('status').textContent).toBe('Saved by Cribl, today: $430');
  });

  it('a lower snapshot within $1 is held, never shown going backwards', () => {
    vi.useFakeTimers({ toFake: ['Date', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'setInterval'] });
    vi.setSystemTime(Date.parse('2026-09-26T12:00:00.000Z'));
    const t0 = Date.now();
    const { rerender } = render(<Meter valueM={100_000_000} ratePerSecM={1_000} anchorMs={t0} label="Saved" />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    const before = Number(figure()?.dataset.valueM);
    rerender(<Meter valueM={100_000_000 - 50_000} ratePerSecM={1_000} anchorMs={Date.now()} label="Saved" />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(Number(figure()?.dataset.valueM)).toBeGreaterThanOrEqual(before);
  });
});

describe('ReceiptBar', () => {
  it('labels the whole length, paid and the ratio; paid share clamps', () => {
    render(<ReceiptBar whpM={6_841_200_000} paidM={2_718_100_000} savedM={4_123_100_000} ratio={0.6027} net={{ netM: 3_323_000_000, paybackX: 4.2 }} />);
    expect(screen.getByText(/You would have paid/).textContent).toBe('You would have paid $68,412');
    expect(screen.getByText(/You paid/).textContent).toBe('You paid $27,181');
    expect(screen.getByText('60% saved')).toBeTruthy();
    expect(screen.getByTestId('receipt-net').textContent).toContain('Net after Cribl $33,230');
    expect(screen.getByTestId('receipt-net').textContent).toContain('Paid for itself 4.2×');
    expect(document.querySelector('[data-callout="whp"]')?.getAttribute('aria-label')).toBe('You would have paid $68,412: paid $27,181, saved $41,231');
    expect(paidShare(100, 40)).toBe(0.4);
    expect(paidShare(100, 400)).toBe(1);
    expect(paidShare(0, 5)).toBe(0);
  });

  it('slot() puts nodes into copy templates', () => {
    const { container } = render(<p>{slot('A {x} and {y} and {missing}', { x: <b>1</b>, y: 'two' })}</p>);
    expect(container.textContent).toBe('A 1 and two and {missing}');
  });
});

describe('ReceiptList', () => {
  it('renders dot-leader lines that deep-link out of the iframe', () => {
    render(
      <ReceiptList
        ariaLabel="Top savers"
        lines={[
          { id: 'a', label: 'Windows event trimming', amountM: 134_000_000, per: 'day', href: 'https://leader/stream/m/default/pipelines/p', hrefLabel: 'Open Windows event trimming in Cribl' },
          { id: 'b', label: 'No link', amountM: 5_000_000 },
        ]}
      />,
    );
    const link = screen.getByRole('link', { name: 'Open Windows event trimming in Cribl' });
    expect(link.getAttribute('target')).toBe('_top');
    expect(link.textContent).toContain('$1,340');
    expect(link.textContent).toContain('/ day');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows the empty node when there are no lines', () => {
    render(<ReceiptList ariaLabel="x" lines={[]} empty={<p>Nothing yet</p>} />);
    expect(screen.getByText('Nothing yet')).toBeTruthy();
  });
});

describe('TrendChart', () => {
  const tz = 'UTC';
  const days = (n: number): TrendPoint[] =>
    Array.from({ length: n }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, savedM: 500_000_000 + i * 1_000_000, whpM: 800_000_000, paidM: 300_000_000 - i * 1_000_000 }));
  const commit = (hash: string, at: string): Commit => ({ hash, message: 'm', author: 'a', committedAt: at, groupId: 'default', files: [], source: 'api' });

  it('learning state below two whole days', () => {
    render(<TrendChart points={days(2)} todayKey="2026-09-02" commits={[]} tz={tz} />);
    expect(document.querySelector('.mr-trend')?.getAttribute('data-state')).toBe('learning');
    expect(screen.getByText('Learning your savings')).toBeTruthy();
    expect(screen.getByText('The trend fills in as each day completes. 1 day collected so far.')).toBeTruthy();
  });

  it('draws whole days only, with a diamond per deploy inside the range', () => {
    const pts = days(10);
    render(
      <TrendChart
        points={pts}
        todayKey="2026-09-10"
        commits={[commit('aaa', '2026-09-03T10:00:00Z'), commit('bbb', '2026-09-10T01:00:00Z'), commit('ccc', '2026-08-01T00:00:00Z')]}
        tz={tz}
      />,
    );
    expect(document.querySelector('.mr-trend')?.getAttribute('data-state')).toBe('ready');
    // 'bbb' lands on today (not drawn) and 'ccc' before the range.
    expect(document.querySelectorAll('[data-callout="change-marker"]')).toHaveLength(1);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Saved per day, last 30 days · 9 days collected');
  });

  it('math: nice maxima, markers, nearest index, whole days', () => {
    // niceMax is unchanged (the report card's PDF mirrors it); the chart's empty state draws $0 / $50 / $100 itself.
    expect(niceMax(0)).toBe(100_000);
    expect(niceMax(730_000_000)).toBe(800_000_000);
    expect(niceMax(180_000)).toBe(200_000);
    expect(niceMax(210_000_000)).toBe(300_000_000); // midline $1.5k, not $1.3k
    expect(niceMax(1_000_000)).toBe(1_000_000);
    const pts = days(3);
    const m = deployMarkers(pts, [commit('x', '2026-09-02T12:00:00Z')], tz);
    expect(m).toHaveLength(1);
    expect(m[0].day).toBe(1);
    expect(m[0].x).toBeCloseTo(1.5, 3);
    expect(nearestIndex(1.6, 3)).toBe(2);
    expect(nearestIndex(-4, 3)).toBe(0);
    expect(nearestIndex(0, 0)).toBe(-1);
    expect(completeDays(pts, '2026-09-03')).toHaveLength(2);
    expect(completeDays(pts, '2026-09-09')).toHaveLength(3);
  });
});

describe('TrendChart on a young workspace (P0-18)', () => {
  const tz = 'UTC';
  // Thirty days as an older build or a seeded fixture carries them: $0 before collecting began on Sep 26.
  const withZeros = (): TrendPoint[] =>
    Array.from({ length: 30 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10); // Sep 1 … Sep 30
      const collected = day >= '2026-09-26';
      return { day, savedM: collected ? 27_400_000 + i * 100_000 : 0, whpM: collected ? 40_000_000 : 0, paidM: collected ? 12_600_000 : 0 };
    });
  const since = Date.parse('2026-09-26T06:20:00Z');

  it('collectedDays drops every day before collecting began and flags a mid-day start as partial', () => {
    const c = collectedDays(withZeros(), '2026-09-30', since, tz);
    expect(c.days.map((p) => p.day)).toEqual(['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29']);
    expect(c.days.some((p) => p.savedM === 0)).toBe(false);
    expect(c.firstPartialFromMs).toBe(since);
    expect(c.sinceKey).toBe('2026-09-26');
    // Collecting from midnight: the first day is whole.
    expect(collectedDays(withZeros(), '2026-09-30', Date.parse('2026-09-26T00:00:00Z'), tz).firstPartialFromMs).toBeUndefined();
    // Unknown start: nothing is clipped (the snapshot's own window stands).
    expect(collectedDays(withZeros(), '2026-09-30', undefined, tz).days).toHaveLength(29);
  });

  it('draws from the first collected day, with a hollow partial point and no $0 run before it', () => {
    render(<TrendChart points={withZeros()} todayKey="2026-09-30" commits={[]} tz={tz} collectingSinceMs={since} />);
    const svg = screen.getByTestId('trend-chart');
    expect(svg.getAttribute('data-first-day')).toBe('2026-09-26');
    expect(svg.getAttribute('data-days')).toBe('4');
    expect(svg.getAttribute('data-partial-first')).toBe('true');
    expect(screen.getByTestId('trend-partial')).toBeTruthy();
    expect(svg.getAttribute('aria-label')).toBe('Saved per day, last 30 days · 4 days collected');
    // The first x label is the collecting day, not Sep 1; a few days label every day.
    expect([...document.querySelectorAll('.mr-trend-xlabel')].map((n) => n.textContent)).toEqual(['Sep 26', 'Sep 27', 'Sep 28', 'Sep 29']);
  });

  it('an all-zero series is a sentence over a $0 / $50 / $100 grid, not a flat line under $1', () => {
    const zeros: TrendPoint[] = ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29'].map((day) => ({ day, savedM: 0, whpM: 5_000_000, paidM: 5_000_000 }));
    expect(nothingSaved(zeros)).toBe(true);
    render(<TrendChart points={zeros} todayKey="2026-09-30" commits={[]} tz={tz} collectingSinceMs={Date.parse('2026-09-26T00:00:00Z')} />);
    expect(screen.getByTestId('trend-empty').getAttribute('data-state')).toBe('empty');
    expect(screen.getByText('Nothing saved yet')).toBeTruthy();
    expect(screen.getByText('Savings appear once a pipeline reduces what reaches a priced destination.')).toBeTruthy();
    expect([...document.querySelectorAll('.mr-trend-ylabel')].map((n) => n.textContent)).toEqual(['$0', '$50', '$100']);
    expect(document.querySelector('.mr-trend-line')).toBeNull();
    expect(document.querySelector('.mr-trend-area')).toBeNull();
  });
});

describe('ReceiptBar net line', () => {
  it('is the receipt total: net, a payback chip and what the cost covers', () => {
    render(
      <ReceiptBar
        whpM={6_841_200_000}
        paidM={2_718_100_000}
        savedM={4_123_100_000}
        ratio={0.6027}
        net={{ netM: 3_323_000_000, paybackX: 4.2, paybackText: 'Paid for itself 4.2×', basis: 'Cribl cost $8,001, prorated to the 25.4 days metered' }}
      />,
    );
    const net = screen.getByTestId('receipt-net');
    expect(net.getAttribute('data-sign')).toBe('positive');
    expect(net.querySelector('.mr-rbar-net-payback')?.getAttribute('data-full')).toBe('true');
    expect(screen.getByTestId('receipt-net-basis').textContent).toContain('Cribl cost $8,001, prorated to the 25.4 days metered');
  });

  it('a negative net is not green, and a payback under 1× is a share, not a multiple', () => {
    render(<ReceiptBar whpM={100_000_000} paidM={60_000_000} savedM={40_000_000} ratio={0.4} net={{ netM: -60_000_000, paybackX: 0.4, paybackText: 'Covered 40% of its cost' }} />);
    const net = screen.getByTestId('receipt-net');
    expect(net.getAttribute('data-sign')).toBe('negative');
    expect(net.textContent).toContain('Net after Cribl −$600');
    expect(net.textContent).toContain('Covered 40% of its cost');
    expect(net.querySelector('.mr-rbar-net-payback')?.getAttribute('data-full')).toBe('false');
  });
});

describe('WhereMoneyGoes', () => {
  const row = (over: Partial<MoneyDestination>): MoneyDestination => ({
    key: over.outputId ?? 'k',
    outputId: 'o',
    label: 'o',
    type: 'splunk_hec',
    whpPerDayM: 600_000_000,
    paidPerDayM: 255_000_000,
    savedPerDayM: 345_000_000,
    paidMcPerGb: 250_000,
    counterfactual: { kind: 'same' },
    unpriced: false,
    ratio: 0.575,
    ...over,
  });

  it("colours each destination by its place among the workspace's destinations, not among the rows shown (review W2)", () => {
    // The ramp index is the destination's place in every destination of the snapshot, sorted (the order FlowScreen's
    // colorOrder uses); the Receipt lists only some. (D55: the Flow map itself draws destinations in ink.)
    render(<WhereMoneyGoes rows={[row({ outputId: 'splunk', label: 'Splunk' }), row({ outputId: 'datadog', label: 'Datadog' })]} colorIds={['s3', 'splunk', 'datadog', 'cribl_lake']} />);
    const dots = [...document.querySelectorAll<HTMLElement>('.mr-wmg-dot')].map((d) => d.style.background);
    // sorted: cribl_lake, datadog, s3, splunk → splunk is the 4th colour, datadog the 2nd
    expect(dots).toEqual(['var(--mr-dest-4)', 'var(--mr-dest-2)']);
  });

  it('bars, paid per day, counterfactual and unpriced chips', () => {
    render(
      <WhereMoneyGoes
        rows={[
          row({ outputId: 'siem', label: 'siem-prod' }),
          row({ outputId: 'arch', label: 'archive-s3', type: 's3', paidMcPerGb: 3_000, counterfactual: { kind: 'other', outputId: 'siem' }, counterfactualLabel: 'siem-prod' }),
          row({ outputId: 'none', label: 'lake', counterfactual: { kind: 'none' } }),
          row({ outputId: 'edge', label: 'edge', unpriced: true, whpPerDayM: 0, paidPerDayM: 0, savedPerDayM: 0 }),
        ]}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('Without Cribl → siem-prod')).toBeTruthy();
    expect(screen.getByText('Without Cribl → nowhere')).toBeTruthy();
    expect(screen.getByText('unpriced')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Set a price' })).toBeTruthy();
    expect(screen.getByText('$0.03 / GB')).toBeTruthy();
    expect(formatPricePerGb(2_300)).toBe('$0.023');
    expect(formatPricePerGb(250_000)).toBe('$2.50');
  });
});

describe('HowItWorks', () => {
  it('four steps with the SPEC 17 wording; activeStep dims the rest', () => {
    render(<HowItWorks activeStep={1} />);
    const steps = screen.getAllByRole('listitem');
    expect(steps.map((s) => s.textContent?.replace(/^\d/, ''))).toEqual([
      'Reads every flow, every minute',
      'Prices it at the destination',
      'Shows what Cribl saved',
      'Alerts in dollars',
    ]);
    expect(steps.map((s) => s.getAttribute('data-active'))).toEqual(['true', 'true', 'false', 'false']);
  });
});
