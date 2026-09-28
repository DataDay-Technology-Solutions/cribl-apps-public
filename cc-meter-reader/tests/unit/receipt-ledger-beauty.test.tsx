// @vitest-environment jsdom
// Wave 3b beauty fixes on the Receipt and the Ledger (docs/review/BEAUTY-3a.md), as pure rules:
//   F11  flows with no traffic fold into one summary row; Cribl's built-in objects read like product names
//   F12  the change timeline zooms to its commits when they all sit at the end of the day
//   F14  one empty-state pattern: a ghost of the real layout, a sentence, no stock illustration
//   #11  "Where the money goes" lists destinations that carry money, and every unpriced one

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowFigures, Incident, Snapshot } from '../../core/types.ts';
import { EmptyBlock } from '../../src/components/common/EmptyBlock.tsx';
import { buildSeries, canFit, fitDomain } from '../../src/components/ChangeTimeline/model.ts';
import { buildRows, isQuiet, partitionQuiet } from '../../src/components/LedgerTable/model.ts';
import { moneyDestinations, type DestinationRow } from '../../src/views/Receipt/model.ts';
import { patchLedgerParams, readLedgerParams } from '../../src/views/Ledger/params.ts';

afterEach(() => cleanup());

const MIN = 60_000;
const HOUR = 60 * MIN;
const END = Date.parse('2026-09-26T09:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function flow(inputId: string, over: Partial<FlowFigures> = {}): FlowFigures {
  const routeId = over.routeId ?? inputId;
  const pipelineId = over.pipelineId ?? 'main';
  const outputId = over.outputId ?? 'devnull';
  return {
    key: `default|${inputId}|${routeId}|${pipelineId}|${outputId}`,
    groupId: 'default',
    inputId,
    routeId,
    pipelineId,
    outputId,
    inB: 0,
    outB: 0,
    whpM: 0,
    paidM: 0,
    savedM: 0,
    ratio: 0,
    ratePerHourM: 0,
    savedPerDayM: 0,
    whpPerDayM: 0,
    paidPerDayM: 0,
    inBPerDay: 0,
    outBPerDay: 0,
    attribution: 'route',
    sparkline: [],
    state: 'learning',
    ...over,
  };
}

const busy = flow('mrd_payments_api', {
  routeId: 'mrd_payments_api',
  pipelineId: 'mrd_pay_sample',
  outputId: 'mrd_siem_prod',
  inBPerDay: 40e9,
  outBPerDay: 13e9,
  whpPerDayM: 10_000_000,
  paidPerDayM: 3_250_000,
  savedPerDayM: 6_750_000,
  state: 'ok',
});

describe('F11 · quiet flows and built-in names', () => {
  const rows = buildRows(
    {
      flows: [busy, flow('in_splunk_hec', { routeId: 'default' }), flow('in_syslog_tls', { routeId: 'default' }), flow('http', { routeId: 'default' })],
      incidents: [],
    },
    { now: END },
  );

  it("reads Cribl's default objects like product names, per kind", () => {
    const hec = rows[1];
    expect(hec.source).toBe('Splunk HEC');
    expect(hec.route).toBe('Default route');
    expect(hec.pipeline).toBe('Main (default)');
    expect(hec.destination).toBe('DevNull');
    expect(rows[2].source).toBe('Syslog (TLS)');
    expect(rows[3].source).toBe('HTTP');
    // The member's own labels still win.
    const own = buildRows({ flows: [flow('in_splunk_hec')], incidents: [] }, { now: END, humanize: { in_splunk_hec: 'Edge HEC' } });
    expect(own[0].source).toBe('Edge HEC');
  });

  it('a flow with no bytes and no money is quiet; one with traffic, an alert or a mute is not', () => {
    expect(isQuiet(rows[0])).toBe(false);
    expect(isQuiet(rows[1])).toBe(true);
    const alerting = { ...rows[1], incident: { id: 'x' } as Incident };
    expect(isQuiet(alerting)).toBe(false);
    expect(isQuiet({ ...rows[1], status: 'muted' })).toBe(false);
  });

  it('folds quiet flows by default, lists them on request or under the "No traffic" filter, and keeps a deep link', () => {
    const folded = partitionQuiet(rows);
    expect(folded.visible.map((r) => r.sourceId)).toEqual(['mrd_payments_api']);
    expect(folded.quiet).toBe(3);
    expect(partitionQuiet(rows, { show: true }).visible).toHaveLength(4);
    expect(partitionQuiet(rows, { state: 'idle' }).visible).toHaveLength(4);
    const kept = partitionQuiet(rows, { keep: new Set([rows[2].id]) });
    expect(kept.visible.map((r) => r.sourceId)).toEqual(['mrd_payments_api', 'in_syslog_tls']);
    expect(kept.quiet).toBe(2);
    expect(partitionQuiet([rows[0]])).toEqual({ visible: [rows[0]], quiet: 0 });
  });

  it('?quiet=show round-trips and is absent by default', () => {
    expect(readLedgerParams(new URLSearchParams('')).showQuiet).toBeUndefined();
    expect(readLedgerParams(new URLSearchParams('quiet=show')).showQuiet).toBe(true);
    expect(patchLedgerParams(new URLSearchParams('q=x'), { showQuiet: true }).get('quiet')).toBe('show');
    expect(patchLedgerParams(new URLSearchParams('quiet=show'), { showQuiet: false }).has('quiet')).toBe(false);
  });
});

describe('F12 · the change timeline zooms to its commits', () => {
  const day: [number, number] = [END - 24 * HOUR, END];

  it('zooms when every commit is in the last quarter of the day, with context before the first', () => {
    const fit = fitDomain([END - 40 * MIN, END - 20 * MIN], day);
    expect(fit).not.toBeNull();
    const [a, b] = fit!;
    expect(b).toBe(END);
    expect(a).toBeLessThanOrEqual(END - 40 * MIN - 30 * MIN); // at least 30 min before the first commit
    expect(b - a).toBeGreaterThanOrEqual(HOUR);
  });

  it("doesn't zoom without commits, when they spread over the day, or when the gain is tiny", () => {
    expect(fitDomain([], day)).toBeNull();
    expect(fitDomain([END - 12 * HOUR, END - 10 * MIN], day)).toBeNull();
    expect(fitDomain([END - 20 * MIN], [END - 80 * MIN, END])).toBeNull(); // would trim only 20 min
  });

  it('buildSeries fits only when asked; the zoomed series keeps one sample before its window for the line', () => {
    const ratioSeries = Array.from({ length: 288 }, (_, i) => ({ t: iso(END - 24 * HOUR + (i + 1) * 5 * MIN), ratio: 0.3 }));
    const snap = {
      ratioSeries,
      trend: [],
      windowEnd: iso(END),
      sweepAt: iso(END),
      timeline: [{ hash: 'abc1234', message: 'x', author: 'a', committedAt: iso(END - 30 * MIN), groupId: 'default', files: [] }],
    } as unknown as Pick<Snapshot, 'ratioSeries' | 'trend' | 'windowEnd' | 'sweepAt' | 'timeline'>;
    const full = buildSeries('24h', snap, 'UTC');
    expect(full.domain).toEqual([END - 24 * HOUR, END]);
    expect(full.fitted).toBeUndefined();
    const fit = buildSeries('24h', snap, 'UTC', { fit: true });
    expect(fit.fitted).toBe(true);
    expect(fit.domain[0]).toBeGreaterThan(END - 2 * HOUR);
    expect(fit.points.every((p) => p.t >= fit.domain[0])).toBe(true);
    expect(fit.segments[0][0].t).toBeLessThan(fit.domain[0]);
    expect(canFit(snap, 'UTC')).toBe(true);
    expect(buildSeries('7d', snap, 'UTC', { fit: true }).fitted).toBeUndefined();
  });
});

describe('F14 · one empty-state pattern', () => {
  it('renders a ghost, the sentence and the action — and no stock illustration even when one is passed', () => {
    const { container } = render(
      <EmptyBlock title="No flows yet" description="They appear after the first sweep." illustration="EmptyFolder">
        <button type="button">Set prices</button>
      </EmptyBlock>,
    );
    expect(screen.getByText('No flows yet')).toBeTruthy();
    expect(screen.getByText('They appear after the first sweep.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set prices' })).toBeTruthy();
    expect(container.querySelector('[data-ghost="rows"][aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelector('img, [class*="EmptyState"]')).toBeNull();
    cleanup();
    const none = render(<EmptyBlock title="Nothing" ghost={false} />);
    expect(none.container.querySelector('.mr-ghost')).toBeNull();
  });
});

describe('#11 · where the money goes', () => {
  const row = (outputId: string, over: Partial<DestinationRow> = {}): DestinationRow => ({
    key: `default:${outputId}`,
    groupId: 'default',
    outputId,
    label: outputId,
    type: 'splunk_hec',
    whpPerDayM: 0,
    paidPerDayM: 0,
    savedPerDayM: 0,
    inBPerDay: 0,
    outBPerDay: 0,
    paidMcPerGb: 0,
    whpMcPerGb: 0,
    counterfactual: { kind: 'same' },
    unpriced: false,
    ratio: 0,
    ...over,
  });

  it('keeps destinations with money and every unpriced one; drops a priced $0 one such as devnull', () => {
    const rows = [row('siem', { whpPerDayM: 5, paidPerDayM: 2, savedPerDayM: 3 }), row('devnull', { type: 'devnull' }), row('edge', { unpriced: true })];
    expect(moneyDestinations(rows).map((r) => r.outputId)).toEqual(['siem', 'edge']);
  });
});
