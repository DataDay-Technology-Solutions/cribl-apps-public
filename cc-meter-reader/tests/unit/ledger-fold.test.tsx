// @vitest-environment jsdom
// Usefulness review, round 2: at enterprise scale the 90 KB snapshot folds the estate to the largest flows plus one
// 'Other' flow (core/snapshot.ts compactSnapshot). The Ledger header read "101 flows", the Receipt "Watching now ·
// 91 routes · 95 sources" and "70 other flows" on a 400-flow estate, all counted from the folded list, and nothing
// said the list was short. The counts now come from the inventory the sweep walks, and the Ledger says what the
// Other row holds.

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import { OTHER_FLOW_KEY, compactSnapshot } from '../../core/snapshot.ts';
import type { FlowFigures, InventoryDoc, Snapshot } from '../../core/types.ts';
import { buildRows } from '../../src/components/LedgerTable/index.ts';
import { summarizeInventory } from '../../src/state/hydrate.ts';
import { AppProviders } from '../../src/state/providers.tsx';
import { snapshotFold } from '../../src/state/selectors.ts';
import type { AppServices } from '../../src/state/services.ts';
import { createAppStore, initialRuntimeStatus, type InventorySummary } from '../../src/state/store.ts';
import LedgerView from '../../src/views/Ledger/index.tsx';
import { saverTotals, watchCoverage } from '../../src/views/Receipt/model.ts';
import { saverTotalLines } from '../../src/views/Receipt/text.ts';

afterEach(() => cleanup());

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const N = 400;
const id = (i: number) => String(i).padStart(3, '0');

function flow(i: number): FlowFigures {
  const whp = (N - i) * 100_000;
  return {
    key: `default|in_${id(i)}|route_${id(i)}|pl_${id(i)}|out_1`,
    groupId: 'default',
    inputId: `in_${id(i)}`,
    routeId: `route_${id(i)}`,
    pipelineId: `pl_${id(i)}`,
    outputId: 'out_1',
    inB: 1,
    outB: 1,
    whpM: 1,
    paidM: 1,
    savedM: 1,
    ratio: 0.5,
    ratePerHourM: 1,
    savedPerDayM: whp / 2,
    whpPerDayM: whp,
    paidPerDayM: whp / 2,
    inBPerDay: 40e9,
    outBPerDay: 20e9,
    attribution: 'route',
    sparkline: Array.from({ length: 30 }, () => 0.5),
    state: 'ok',
  };
}

function bigSnapshot(): Snapshot {
  const flows = Array.from({ length: N }, (_, i) => flow(i));
  return {
    schemaVersion: 1,
    sweepAt: iso(NOW),
    windowStart: iso(NOW - 60_000),
    windowEnd: iso(NOW),
    mode: 'ui',
    headline: {} as Snapshot['headline'],
    ratePerSecM: 0,
    flows,
    destinations: [],
    topSavers: [],
    unpricedOutputIds: [],
    openIncidents: 0,
    incidents: [],
    trend: [],
    ratioSeries: [],
    timeline: [],
    deliveries: [],
    calls: 0,
    collectingSince: iso(NOW - 86_400_000),
    metricsSource: 'metrics-query',
    attributionSummary: 'route',
  };
}

function inventoryDoc(): InventoryDoc {
  return {
    schemaVersion: 1,
    updatedAt: iso(NOW),
    hash: 'h',
    byGroup: {
      default: {
        inputs: Array.from({ length: N }, (_, i) => ({ id: `in_${id(i)}`, type: 'splunk_hec' })),
        outputs: [{ id: 'out_1', type: 'splunk' }],
        pipelines: Array.from({ length: N }, (_, i) => ({ id: `pl_${id(i)}`, functions: [{ id: 'eval' }] })),
        routes: Array.from({ length: N }, (_, i) => ({ id: `route_${id(i)}`, filter: `__inputId=='in_${id(i)}'`, pipeline: `pl_${id(i)}`, output: 'out_1', final: true })),
      },
    },
  } as unknown as InventoryDoc;
}

const folded = compactSnapshot(bigSnapshot(), 90_000);

describe('the fold, counted from the inventory', () => {
  it('the fixture folds: the largest flows plus one Other flow', () => {
    expect(folded.flows.some((f) => f.key === OTHER_FLOW_KEY)).toBe(true);
    expect(folded.flows.length).toBeLessThan(N);
  });

  it('summarizeInventory with settings counts every flow the sweep meters, and its routes and sources', () => {
    const summary = summarizeInventory(inventoryDoc(), defaultSettings(iso(NOW), 'UTC'));
    expect(summary.metered).toEqual({ flows: N, routes: N, sources: N });
    // without settings, the chrome summary alone (unchanged)
    expect(summarizeInventory(inventoryDoc()).metered).toBeUndefined();
  });

  it('snapshotFold: how many are listed, how many the Other row holds', () => {
    const inv = summarizeInventory(inventoryDoc(), defaultSettings(iso(NOW), 'UTC'));
    const shown = folded.flows.length - 1;
    expect(snapshotFold(folded, inv)).toEqual({ shown, total: N, inOther: N - shown, routes: N, sources: N });
    expect(snapshotFold(folded, null)).toEqual({ shown });
    expect(snapshotFold(bigSnapshot(), inv)).toBeUndefined();
  });

  it("prefers the sweep's own count before the fold (Snapshot.flowCounts) to the inventory's", () => {
    const inv = summarizeInventory(inventoryDoc(), defaultSettings(iso(NOW), 'UTC'));
    const shown = folded.flows.length - 1;
    const counted = { ...folded, flowCounts: { flows: 420, routes: 410, sources: 405 } } as Snapshot;
    expect(snapshotFold(counted, inv)).toEqual({ shown, total: 420, inOther: 420 - shown, routes: 410, sources: 405 });
    expect(snapshotFold(counted, null)).toEqual({ shown, total: 420, inOther: 420 - shown, routes: 410, sources: 405 });
  });

  it('with every saver outside the fold listed, the line is the folded flows alone', () => {
    const lines = saverTotalLines(
      [{ label: 'a', savedPerDayM: 1_000_000 }] as unknown as Parameters<typeof saverTotalLines>[0],
      { allM: 3_000_000, count: 1, folded: { flows: 300 } },
    );
    expect(lines.find((l) => l.id === 'others')?.label).toBe('300 smaller flows');
    const noCount = saverTotalLines([{ label: 'a', savedPerDayM: 1_000_000 }] as unknown as Parameters<typeof saverTotalLines>[0], { allM: 3_000_000, count: 1, folded: {} });
    expect(noCount.find((l) => l.id === 'others')?.label).toBe('The smaller flows');
  });

  it('the Other row is named for what it holds', () => {
    const rows = buildRows(folded, { otherLabel: 'Other · 300 smaller flows' });
    const other = rows.find((r) => r.flow.key === OTHER_FLOW_KEY)!;
    expect(other.source).toBe('Other · 300 smaller flows');
  });

  it("the Receipt's coverage and 'other flows' count every metered flow, not the folded list", () => {
    const inv = summarizeInventory(inventoryDoc(), defaultSettings(iso(NOW), 'UTC'));
    const fold = snapshotFold(folded, inv);
    expect(watchCoverage(folded, {}, fold)).toEqual({ routes: N, sources: N, budgets: 0 });
    const shown = folded.flows.length - 1;
    const totals = saverTotals(folded, fold);
    expect(totals.count).toBe(shown);
    expect(totals.folded).toEqual({ flows: N - shown });
    const savers = folded.flows.slice(0, 5).map((f) => ({ label: f.inputId, savedPerDayM: f.savedPerDayM })) as unknown as Parameters<typeof saverTotalLines>[0];
    const others = saverTotalLines(savers, totals).find((l) => l.id === 'others')!;
    expect(others.label).toBe(`${shown - 5} other flows and ${N - shown} smaller ones`);
  });
});

function renderLedger(inventory: InventorySummary | null) {
  const store = createAppStore(defaultSettings(iso(NOW), 'UTC'), {
    hasHydrated: true,
    status: { ...initialRuntimeStatus(), hydrate: { phase: 'done' } },
    snapshot: folded,
    inventory,
  });
  const services = { store, actions: { readRange: async () => ({ ok: false, reason: 'not-live' }) } } as unknown as AppServices;
  render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={['/ledger']}>
        <Routes>
          <Route path="/ledger" element={<LedgerView />} />
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('the Ledger on a folded snapshot', () => {
  it('counts every metered flow and says the list is the largest ones', () => {
    renderLedger(summarizeInventory(inventoryDoc(), defaultSettings(iso(NOW), 'UTC')));
    const shown = folded.flows.length - 1;
    expect(screen.getAllByText('400 flows').length).toBeGreaterThan(0);
    const note = screen.getByTestId('ledger-fold');
    expect(note.textContent).toContain(`The ${shown} largest of 400 flows are listed; the other ${N - shown} are summed on the “Other” row.`);
    expect(note.textContent).toContain('Every flow is metered and watched.');
  });

  it('without the inventory it still says the list is short', () => {
    renderLedger(null);
    const shown = folded.flows.length - 1;
    expect(screen.getByTestId('ledger-fold').textContent).toContain(`The ${shown} largest flows are listed; the rest are summed on the “Other” row.`);
  });
});
