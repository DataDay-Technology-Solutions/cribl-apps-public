// @vitest-environment jsdom
// Ledger components in jsdom: the view's designed states, the table header + sort, status chips, the alerts rail.
// (Layout-dependent behaviour — virtualized scrolling, deep-link scroll, the SVG chart — is covered by
// tests/e2e/ledger.spec.ts and ledger-scroll.spec.ts in a real browser.)

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { FlowFigures, Incident, Snapshot } from '../../core/types.ts';
import { IncidentsRail } from '../../src/components/IncidentsRail/index.ts';
import { LedgerTable, StatusChip, buildRows, DEFAULT_SORT, totals } from '../../src/components/LedgerTable/index.ts';
import { AppProviders } from '../../src/state/providers.tsx';
import type { AppServices } from '../../src/state/services.ts';
import { createAppStore, initialRuntimeStatus } from '../../src/state/store.ts';
import LedgerView from '../../src/views/Ledger/index.tsx';

afterEach(() => cleanup());

// Capra's SelectField measures its trigger; jsdom has no ResizeObserver (it never fires here — no layout).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function flow(inputId: string, pipelineId: string, over: Partial<FlowFigures> = {}): FlowFigures {
  return {
    key: `default|${inputId}|${inputId}|${pipelineId}|mrd_siem_prod`,
    groupId: 'default',
    inputId,
    routeId: inputId,
    pipelineId,
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

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'inc_a',
    type: 'regression',
    severity: 'high',
    objectKey: 'route:default:mrd_payments_api',
    label: 'Payments API sampling',
    openedAt: iso(NOW - 10 * 60_000),
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    notes: [],
    deliveries: [{ endpointId: 'ep', status: 200, at: iso(NOW - 8 * 60_000) }],
    ...over,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: 1,
    sweepAt: iso(NOW),
    windowStart: iso(NOW - 60_000),
    windowEnd: iso(NOW),
    mode: 'ui',
    headline: {} as Snapshot['headline'],
    ratePerSecM: 0,
    flows: [flow('mrd_windows_dc', 'mrd_win_xml_pack'), flow('mrd_payments_api', 'mrd_pay_sample', { state: 'regression' })],
    destinations: [],
    topSavers: [],
    unpricedOutputIds: [],
    openIncidents: 1,
    incidents: [incident()],
    trend: [],
    ratioSeries: [{ t: iso(NOW - 5 * 60_000), ratio: 0.3 }],
    timeline: [],
    deliveries: [],
    calls: 0,
    collectingSince: iso(NOW - 86_400_000),
    metricsSource: 'metrics-query',
    attributionSummary: 'route',
    ...over,
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="loc">{loc.search}</output>;
}

function renderView(state: Parameters<typeof createAppStore>[1], path = '/ledger') {
  const store = createAppStore(defaultSettings(iso(NOW), 'UTC'), state);
  // The Ledger reads the Receipt's custom range through the action surface (P2-W14); these states carry none.
  const services = { store, actions: { readRange: async () => ({ ok: false, reason: 'not-live' }) } } as unknown as AppServices;
  render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/ledger"
            element={
              <>
                <LedgerView />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
  return store;
}

const done = () => ({
  ...initialRuntimeStatus(),
  hydrate: { phase: 'done' as const },
});

describe('LedgerView states', () => {
  it('shows a skeleton while the first hydration is in flight', () => {
    renderView({
      status: { ...initialRuntimeStatus(), hydrate: { phase: 'loading' } },
    });
    expect(document.querySelector('[data-state="loading"]')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Ledger' })).toBeTruthy();
  });

  it('no snapshot yet → the designed empty state, plus empty timeline and rail', () => {
    renderView({ hasHydrated: true, status: done(), snapshot: null });
    expect(screen.getByText('No flows yet')).toBeTruthy();
    expect(screen.getByText('No open alerts')).toBeTruthy();
    expect(screen.getByText('No history yet')).toBeTruthy();
  });

  it('with a snapshot: toolbar with counts, the table, the change timeline and the alerts rail', () => {
    renderView({ hasHydrated: true, status: done(), snapshot: snapshot() });
    expect(screen.getByText('2 flows')).toBeTruthy();
    // jsdom has no layout, so the table measures 0 px wide → the narrow (card) layout: 2 rows, no header or totals row.
    expect(screen.getByRole('table', { name: 'Flows' }).getAttribute('aria-rowcount')).toBe('2');
    expect(screen.getByRole('heading', { name: 'Change timeline' })).toBeTruthy();
    expect(screen.getByTestId('incidents-rail').textContent).toContain('Savings dropped: Payments API sampling');
    expect(document.querySelector('[data-mr-search] input')).not.toBeNull();
  });

  it('search filters and is written to the URL after a short pause', () => {
    vi.useFakeTimers();
    try {
      renderView({ hasHydrated: true, status: done(), snapshot: snapshot() });
      const input = document.querySelector<HTMLInputElement>('[data-mr-search] input')!;
      fireEvent.change(input, { target: { value: 'payments' } });
      expect(screen.getByText('1 of 2 flows')).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByTestId('loc').textContent).toBe('?q=payments');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a deep link to an object that is not in the sweep says so', () => {
    renderView({ hasHydrated: true, status: done(), snapshot: snapshot() }, '/ledger?object=route:default:gone');
    expect(document.querySelector('[data-state="object-missing"]')?.textContent).toContain("isn't in the latest sweep");
  });

  it('"Show in table" on an alert selects its object in the URL', () => {
    renderView({ hasHydrated: true, status: done(), snapshot: snapshot() });
    fireEvent.click(
      within(screen.getByTestId('incidents-rail')).getByRole('button', {
        name: 'Show in table',
      }),
    );
    expect(decodeURIComponent(screen.getByTestId('loc').textContent ?? '')).toBe('?object=route:default:mrd_payments_api');
  });
});

describe('LedgerTable', () => {
  it('renders the SPEC 17 headers in the wide layout and sorts from them', () => {
    const onSortChange = vi.fn();
    const rows = buildRows(snapshot());
    const { container, unmount } = render(
      <LedgerTable rows={rows} sort={DEFAULT_SORT} onSortChange={onSortChange} layout="wide" totals={totals(rows)} />,
    );
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    // Every route here is named like its source, so Route folds into Source (P1-K01).
    expect(headers).toEqual([
      'Source',
      'Pipeline',
      'Destination',
      'In/ day',
      'Out/ day',
      'Volume reduced',
      'Would have paid/ day',
      'Paid/ day',
      'Saved/ day',
      'Trend',
      'Status',
    ]);
    expect(container.querySelector('.mr-lt')?.getAttribute('data-columns')).toBe(
      'source,pipeline,destination,in,out,reduction,whp,paid,saved,trend,status',
    );
    // The totals label spans the name columns, so the figures sit under their headers.
    expect((container.querySelector('.mr-lt-totals-label') as HTMLElement).style.gridColumn).toBe('span 3');
    const saved = screen.getAllByRole('columnheader')[8];
    expect(saved.getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(within(saved).getByRole('button'));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'saved', dir: 'asc' });
    fireEvent.click(within(screen.getAllByRole('columnheader')[0]).getByRole('button'));
    expect(onSortChange).toHaveBeenLastCalledWith({
      key: 'source',
      dir: 'asc',
    });
    unmount();

    // A route named unlike its source brings the column back, second, where SPEC 17 puts it.
    const routed = buildRows({ ...snapshot(), flows: [...snapshot().flows, flow('in_syslog', 'main', { routeId: 'default', key: 'default|in_syslog|default|main|mrd_siem_prod' })] });
    render(<LedgerTable rows={routed} sort={DEFAULT_SORT} onSortChange={onSortChange} layout="wide" />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent).slice(0, 4)).toEqual(['Source', 'Route', 'Pipeline', 'Destination']);
  });

  it('shows the designed filtered-to-zero content under the header', () => {
    render(<LedgerTable rows={[]} sort={DEFAULT_SORT} onSortChange={() => {}} layout="medium" empty={<p>nothing matches</p>} />);
    expect(screen.getByText('nothing matches')).toBeTruthy();
    expect(screen.getAllByRole('columnheader')[0].textContent).toBe('Flow');
  });
});

describe('StatusChip', () => {
  it('speaks the SPEC 17 words, coloured by severity', () => {
    const { container, rerender } = render(<StatusChip row={{ status: 'regression', severity: 'high' }} />);
    expect(container.textContent).toBe('Savings dropped');
    expect(container.querySelector('.mr-lt-chip--high')).not.toBeNull();
    rerender(<StatusChip row={{ status: 'spike', severity: 'medium' }} />);
    expect(container.querySelector('.mr-lt-chip--medium')?.textContent).toBe('Cost spike');
    rerender(<StatusChip row={{ status: 'muted', mutedMinutes: 6 }} />);
    // P1-K05: whole in sentence case, with the sentence as its title.
    expect(container.textContent).toBe('Muted · 6 min');
    expect(container.querySelector('.mr-lt-chip')?.getAttribute('title')).toBe('Muted after a demo change · 6 min left');
    rerender(<StatusChip row={{ status: 'ok' }} />);
    expect(container.querySelector('.mr-lt-chip')).toBeNull();
    expect(container.textContent).toBe('OK');
    rerender(<StatusChip row={{ status: 'idle' }} />);
    expect(container.textContent).toBe('No traffic');
  });
});

describe('IncidentsRail', () => {
  it('empty: calm copy with the number of flows watched', () => {
    render(<IncidentsRail incidents={[]} flowsWatched={17} />);
    expect(screen.getByText('No open alerts')).toBeTruthy();
    expect(screen.getByText(/watching 17 flows/)).toBeTruthy();
  });

  it('groups open and recent alerts and hands the object to "Show in table"', () => {
    const onSelect = vi.fn();
    render(
      <IncidentsRail
        incidents={[
          incident(),
          incident({
            id: 'inc_b',
            objectKey: 'route:default:mrd_k8s_prod',
            label: 'Kubernetes noise filter',
            closedAt: iso(NOW - 60_000),
          }),
        ]}
        flowsWatched={2}
        onSelectObject={onSelect}
        selectedObject="route:default:mrd_payments_api"
      />,
    );
    const groups = document.querySelectorAll('.mr-rail-group');
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toContain('Open');
    expect(groups[1].textContent).toContain('Recent');
    expect(document.querySelector('.mr-rail-item.is-selected')?.getAttribute('data-incident')).toBe('inc_a');
    fireEvent.click(
      within(groups[1] as HTMLElement).getByRole('button', {
        name: 'Show in table',
      }),
    );
    expect(onSelect).toHaveBeenCalledWith('route:default:mrd_k8s_prod');
  });
});
