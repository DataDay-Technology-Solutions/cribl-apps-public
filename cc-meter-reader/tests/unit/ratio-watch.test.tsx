// @vitest-environment jsdom
// P2-W15: the drop, drawn, on the incident cards — which series, where the parts go, and that the cards render it.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowFigures, Incident } from '../../core/types.ts';
import { ratioGeometry } from '../../src/components/RatioWatch/geometry.ts';
import { RatioWatchCard } from '../../src/components/RatioWatch/RatioWatch.tsx';
import { incidentSeries } from '../../src/components/RatioWatch/series.ts';
import { TakeoverCard } from '../../src/components/IncidentTakeover/TakeoverCard.tsx';

afterEach(cleanup);

const MIN = 60_000;
const END = Date.parse('2026-09-30T16:30:00.000Z');
const DEPLOY = END - 6 * MIN + 20_000; // 20 s into the minute that starts six minutes before the end
const values = Array.from({ length: 30 }, (_, i) => (i < 24 ? 0.75 : 0.5));

function flow(over: Partial<FlowFigures> = {}): FlowFigures {
  return {
    key: 'default|mrd_payments_api|mrd_payments_api|mrd_pay_sample|mrd_siem_prod',
    groupId: 'default',
    inputId: 'mrd_payments_api',
    routeId: 'mrd_payments_api',
    pipelineId: 'mrd_pay_sample',
    outputId: 'mrd_siem_prod',
    inB: 0,
    outB: 0,
    whpM: 0,
    paidM: 0,
    savedM: 0,
    ratio: 0.5,
    ratePerHourM: 0,
    savedPerDayM: 0,
    whpPerDayM: 1_000,
    paidPerDayM: 0,
    inBPerDay: 0,
    outBPerDay: 0,
    attribution: 'route',
    sparkline: values,
    state: 'regression',
    ...over,
  } as FlowFigures;
}

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'inc_1',
    type: 'regression',
    severity: 'high',
    objectKey: 'pipe:default:mrd_pay_sample',
    label: 'Payments API sampling',
    openedAt: new Date(DEPLOY + 170_000).toISOString(),
    cause: 'commit',
    commit: { hash: 'a1f3c9e5b2', message: 'demo: break', author: 's.koelpin', committedAt: new Date(DEPLOY - 9_000).toISOString(), deployedAt: new Date(DEPLOY).toISOString(), groupId: 'default', match: 'message' },
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    caughtInSec: 170,
    notes: [],
    deliveries: [],
    ...over,
  };
}

const snapshot = { flows: [flow()], windowEnd: new Date(END).toISOString() };

describe('incidentSeries (P2-W15)', () => {
  it("draws the incident's flow: its minutes, the deploy, the baseline", () => {
    const s = incidentSeries(snapshot, incident())!;
    expect(s.values).toHaveLength(30);
    expect(s.endMs).toBe(END);
    expect(s.changeMs).toBe(DEPLOY);
    expect(s.baseline).toBe(0.75);
    expect(s.closedMs).toBeUndefined();
    expect(incidentSeries(snapshot, incident({ closedAt: new Date(END - MIN).toISOString() }))!.closedMs).toBe(END - MIN);
  });
  it('has nothing to draw for another kind, another object, too few minutes or no snapshot', () => {
    expect(incidentSeries(snapshot, incident({ type: 'spike' }))).toBeNull();
    expect(incidentSeries(snapshot, incident({ objectKey: 'pipe:default:other' }))).toBeNull();
    expect(incidentSeries({ ...snapshot, flows: [flow({ sparkline: [0.7, 0.7] })] }, incident())).toBeNull();
    expect(incidentSeries(null, incident())).toBeNull();
  });
});

describe('ratioGeometry (P2-W15)', () => {
  const plot = { width: 400, height: 80, margin: { top: 0, right: 0, bottom: 0, left: 0 } };
  it('puts the diamond at the deploy second, the drop no earlier than it, and shades the loss under the baseline', () => {
    const g = ratioGeometry({ values, endMs: END, changeMs: DEPLOY, baseline: 0.75 }, plot)!;
    const frac = (DEPLOY - g.startMs) / (END - g.startMs);
    expect(g.changeX).toBeCloseTo(frac * 400, 6);
    expect(g.closeX).toBe(g.endX);
    expect(g.lost.startsWith(`M${g.changeX.toFixed(2)},${g.baselineY.toFixed(2)}`)).toBe(true);
    expect(g.lowest).toBe(0.5);
    // The after-part (≥ a third of the width) and the steady part before it.
    expect((g.endX - g.changeX) / 400).toBeGreaterThanOrEqual(1 / 3 - 1e-9);
  });
  it('ends the loss at the close of a recovered incident', () => {
    const closed = END - 2 * MIN;
    const g = ratioGeometry({ values, endMs: END, changeMs: DEPLOY, closedMs: closed, baseline: 0.75 }, plot)!;
    expect(g.closeX).toBeLessThan(g.endX);
    expect(g.closeX).toBeGreaterThan(g.changeX);
  });
  it('draws nothing when the change is not in the series', () => {
    expect(ratioGeometry({ values, endMs: END, changeMs: END + MIN, baseline: 0.75 }, plot)).toBeNull();
    expect(ratioGeometry({ values: [0.7, 0.7], endMs: END, changeMs: DEPLOY, baseline: 0.75 }, plot)).toBeNull();
  });
});

describe('the cards draw it (P2-W15)', () => {
  it('RatioWatchCard: an svg with the diamond at the deploy and the loss', () => {
    const { container } = render(<RatioWatchCard series={incidentSeries(snapshot, incident())!} tz="UTC" />);
    const svg = container.querySelector('.mr-rw svg')!;
    expect(svg.getAttribute('aria-label')).toContain('Savings ratio by minute: at 75% until the change at');
    expect(container.querySelector('.mr-rw-diamond')).not.toBeNull();
    expect(container.querySelector('.mr-rw-lost')).not.toBeNull();
    expect(container.querySelector('.mr-rw-line--after')).not.toBeNull();
  });
  it('a card outside the app (no store) draws no chart and never throws', () => {
    const { container } = render(<TakeoverCard incident={incident()} mode="alert" tz="UTC" placement="inline" />);
    expect(container.querySelector('.mr-rw')).toBeNull();
  });
});
