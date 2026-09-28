// @vitest-environment jsdom
// tests/unit/wave3-projector-drops.test.tsx — the Demo Console's "On the projector" miniature shows what the stage
// shows (W3-STAGE-1 carried to the miniature): the saver an open regression names carries its drop as a red pill
// beside its own figure, the figure itself unchanged; a closed incident leaves every line plain.

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Incident, Snapshot, TopSaver } from '../../core/types.ts';
import { defaultSettings } from '../../core/settings.ts';
import { fmtDollars } from '../../core/format.ts';
import { ProjectorPanel } from '../../src/views/Demo/ProjectorPanel.tsx';

const T0 = Date.UTC(2026, 8, 28, 15, 0, 20);
const iso = (ms: number) => new Date(ms).toISOString();

const savers: TopSaver[] = [
  { objectKey: 'route:default:mrd_payments_api', label: 'Payments API · Payments API sampling', savedPerDayM: 376_400_000, ratio: 0.75, groupId: 'default', pipelineId: 'mrd_pay_sample' },
  { objectKey: 'route:default:mrd_windows', label: 'Windows DC security events · Windows XML pack', savedPerDayM: 250_000_000, ratio: 0.6, groupId: 'default', pipelineId: 'mrd_win_xml' },
];

function incident(partial: Partial<Incident> = {}): Incident {
  return {
    id: 'i1',
    type: 'regression',
    severity: 'high',
    objectKey: 'route:default:mrd_payments_api',
    label: 'Payments API sampling',
    openedAt: iso(T0 - 60_000),
    before: 0.75,
    after: 0.5,
    impactPerDayM: 125_000_000,
    notes: [],
    deliveries: [],
    ...partial,
  };
}

function snapshot(incidents: Incident[]): Snapshot {
  return {
    schemaVersion: 1,
    sweepAt: iso(T0),
    windowStart: iso(T0 - 60_000),
    windowEnd: iso(T0),
    mode: 'ui',
    headline: {
      todayM: 1_000_000,
      mtdM: 50_000_000,
      d30M: 60_000_000,
      annualizedM: 811_234_500_000,
      annualizedFromDays: 5,
      whpMtdM: 0,
      paidMtdM: 0,
      ratioMtd: 0,
      whpTodayM: 0,
      paidTodayM: 0,
      whp30dM: 0,
      paid30dM: 0,
    },
    ratePerSecM: 1_000,
    flows: [],
    destinations: [],
    topSavers: savers,
    unpricedOutputIds: [],
    openIncidents: incidents.filter((i) => !i.closedAt).length,
    incidents,
    trend: [],
    ratioSeries: [],
    timeline: [],
    deliveries: [],
    calls: 0,
    collectingSince: iso(T0 - 86_400_000),
    metricsSource: 'metrics-query',
    attributionSummary: 'route',
  } as Snapshot;
}

function renderPanel(incidents: Incident[]) {
  const settings = defaultSettings(iso(T0), 'UTC');
  return render(
    <ProjectorPanel snapshot={snapshot(incidents)} settings={settings} scene={undefined} takeover={undefined} next={undefined} eta={{ eta: '~1:05', measured: true }} nowMs={T0} />,
  );
}

describe('the projector miniature carries the stage drop chip (W3-STAGE-1)', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('puts the open regression drop on the saver it names, and keeps that saver figure', () => {
    const { container } = renderPanel([incident()]);
    const items = [...container.querySelectorAll('.mr-demo-stage-item')];
    expect(items).toHaveLength(2);
    const [pay, win] = items;
    expect(pay.getAttribute('data-drop-m')).toBe('125000000');
    expect(pay.querySelector('.mr-demo-stage-drop')?.textContent).toBe(`−${fmtDollars(125_000_000)}`);
    expect(pay.querySelector('.mr-demo-stage-item-amount')?.textContent).toBe(fmtDollars(376_400_000));
    expect(win.getAttribute('data-drop-m')).toBeNull();
    expect(win.querySelector('.mr-demo-stage-drop')).toBeNull();
  });

  it('leaves every line plain once the incident closed', () => {
    const { container } = renderPanel([incident({ closedAt: iso(T0) })]);
    expect(container.querySelectorAll('.mr-demo-stage-drop')).toHaveLength(0);
    expect(container.querySelectorAll('[data-drop-m]')).toHaveLength(0);
  });
});
