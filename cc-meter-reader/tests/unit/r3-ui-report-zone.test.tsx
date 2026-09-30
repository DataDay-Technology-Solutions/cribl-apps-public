// @vitest-environment jsdom
// founder-build r3 ui-1 (FINDINGS_R3 #5, contract C3): a settings-less live workspace (a 1.1.0 upgrade, or one another
// runtime metered) reads its days in the zone its figures were bucketed in. The Receipt resolves that zone with
// receiptZone (settings → snapshot.zone → browser, r2 ui-3); the Report card resolved settings.displayTimezone ?? the
// browser, and the boot defaults always carry the browser's zone, so a Los Angeles tab on a Chicago-metered workspace
// prorated the month's Cribl cost from a different month start (MTD net $25,739 vs $25,835) and could print a different
// span. The Report (and the Ledger's dated text) now use the Receipt's resolver.
//
// Promoted from AA/r3/2/zz-r3m-report-zone.test.ts and OUT/skeptic/zz-sk1-report-zone.test.tsx.

import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import { fmtDollars } from '../../core/format.ts';
import { buildReportCard } from '../../core/report.ts';
import type { Settings, Snapshot } from '../../core/types.ts';
import { AppProviders } from '../../src/state/providers.tsx';
import { createAppServices } from '../../src/state/services.ts';
import type { AppDocs } from '../../src/state/ports.ts';
import { createAppStore, type DataSource } from '../../src/state/store.ts';
import ReportView from '../../src/views/Report/index.tsx';
import { REPORT_COPY } from '../../src/views/Report/model.ts';
import { netFigures, receiptZone } from '../../src/views/Receipt/model.ts';
import { receiptNetLine } from '../../src/views/Receipt/text.ts';
import { useViewZone } from '../../src/views/Receipt/useViewZone.ts';
import { liveWorkspace, LIVE_NOW } from './report-fixture.ts';

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const COST = 3_500_000;

const docs: AppDocs = {
  readSettings: async () => null,
  readPrices: async () => null,
  readSnapshot: async () => null,
  readMeta: async () => null,
  readDemoState: async () => null,
  readInventory: async () => null,
  writeSettings: async () => {},
  writePrices: async () => {},
};

interface World {
  snapshot: Snapshot;
  settings: Settings;
  store: ReturnType<typeof createAppStore>;
  services: ReturnType<typeof createAppServices>;
}

/** A live workspace whose boot defaults carry `browser` (runtime.ts: defaultSettings(now, browserTimeZone())), never stored. */
function world(snapZone: string | undefined, browser: string, opts: { stored?: boolean; source?: DataSource } = {}): World {
  const w = liveWorkspace({ criblCostCentsPerMonth: COST });
  const snapshot: Snapshot = { ...w.snapshot, ...(snapZone ? { zone: snapZone } : {}) };
  if (!snapZone) delete (snapshot as { zone?: string }).zone;
  const settings: Settings = { ...defaultSettings(new Date(LIVE_NOW).toISOString(), browser), criblCostCentsPerMonth: COST };
  const store = createAppStore(settings, {
    hasHydrated: true,
    source: opts.source ?? 'live',
    prices: w.prices,
    snapshot,
    settingsStored: opts.stored ?? false,
  });
  store.setState((s) => ({ status: { ...s.status, hydrate: { phase: 'done' } } }));
  const services = createAppServices({ store, docs, mergeSettings: (s) => s, engine: { runLocal: vi.fn(), invokeBackend: vi.fn() } });
  return { snapshot, settings, store, services };
}

async function renderReport(w: World): Promise<string> {
  render(
    <AppProviders services={w.services}>
      <MemoryRouter initialEntries={['/report']}>
        <ReportView />
      </MemoryRouter>
    </AppProviders>,
  );
  await waitFor(() => expect(screen.getByTestId('report-preview').getAttribute('srcdoc') ?? '').toContain('Net after Cribl'));
  return screen.getByTestId('report-preview').getAttribute('srcdoc') ?? '';
}

/** The Receipt's MTD net line, computed with the exact calls Receipt/index.tsx makes (receiptZone + netFigures + receiptNetLine). */
function receiptMtdNet(w: World, browser: string, stored = false): { tz: string; net: string } {
  const tz = receiptZone({ settingsStored: stored, displayTimezone: w.settings.displayTimezone }, w.snapshot.zone, browser);
  const nb = netFigures(w.snapshot, 'mtd', COST, tz);
  const line = receiptNetLine(nb, undefined, false);
  if (!line) throw new Error('no net line');
  return { tz, net: fmtDollars(line.netM) };
}

/** The Report card's month-to-date span as core builds it in zone `tz` ("Sep 1–25, 2026"). */
function spanIn(w: World, tz: string): string {
  return buildReportCard({
    snapshot: w.snapshot,
    prices: w.store.getState().prices,
    settings: { criblCostCentsPerMonth: COST, humanize: w.settings.humanize },
    period: { kind: 'mtd' },
    nowMs: LIVE_NOW + 30_000,
    tz,
    copy: REPORT_COPY,
    source: 'live',
    appVersion: 'test',
    build: 'release',
  }).period.span;
}

describe('r3 ui-1: the Report card reads the Receipt zone', () => {
  for (const snapZone of ['America/Chicago', 'UTC']) {
    it(`settings-less, snapshot.zone ${snapZone}, a Los Angeles browser: Receipt and Report agree on the MTD net and span`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(LIVE_NOW + 30_000);
      const browser = 'America/Los_Angeles';
      const w = world(snapZone, browser);
      expect(w.store.getState().settingsStored).toBe(false);
      const doc = await renderReport(w);
      const receipt = receiptMtdNet(w, browser);
      expect(receipt.tz).toBe(snapZone);
      const reportNet = /Net after Cribl (\$\d{1,3}(?:,\d{3})*)/.exec(doc)?.[1];
      expect(reportNet).toBe(receipt.net);
      expect(doc).toContain(spanIn(w, receipt.tz));
    });
  }

  it('a browser a day ahead (Pacific/Kiritimati) on a Chicago-metered workspace prints Chicago days, not its own', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LIVE_NOW + 30_000);
    const browser = 'Pacific/Kiritimati';
    const w = world('America/Chicago', browser);
    const chicago = spanIn(w, 'America/Chicago');
    const kiritimati = spanIn(w, browser);
    // The fixture's 20:30Z is Sep 25 in Chicago and Sep 26 on Kiritimati: the two spans differ.
    expect(chicago).not.toBe(kiritimati);
    const doc = await renderReport(w);
    expect(doc).toContain(chicago);
    expect(doc).not.toContain(kiritimati);
    const reportNet = /Net after Cribl (\$\d{1,3}(?:,\d{3})*)/.exec(doc)?.[1];
    expect(reportNet).toBe(receiptMtdNet(w, browser).net);
  });

  it('a stored zone still wins over snapshot.zone (the member chose it)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LIVE_NOW + 30_000);
    const browser = 'America/Los_Angeles';
    const w = world('America/Chicago', browser, { stored: true });
    const doc = await renderReport(w);
    const receipt = receiptMtdNet(w, browser, true);
    expect(receipt.tz).toBe(browser);
    expect(/Net after Cribl (\$\d{1,3}(?:,\d{3})*)/.exec(doc)?.[1]).toBe(receipt.net);
  });
});

describe('r3 ui-1: useViewZone (the Ledger and the Report share the Receipt resolver)', () => {
  const hook = (w: World) => {
    const wrapper = ({ children }: { children: ReactNode }) => <AppProviders services={w.services}>{children}</AppProviders>;
    return renderHook(() => useViewZone(), { wrapper }).result.current;
  };

  it('settings-less live: snapshot.zone', () => {
    expect(hook(world('America/Chicago', 'America/Los_Angeles'))).toBe('America/Chicago');
  });
  it('stored settings: the stored zone', () => {
    expect(hook(world('America/Chicago', 'America/Los_Angeles', { stored: true }))).toBe('America/Los_Angeles');
  });
  it('the sample shows its own settings zone, stored or not', () => {
    expect(hook(world('America/Chicago', 'Europe/Paris', { source: 'sample' }))).toBe('Europe/Paris');
  });
  it('an explicit snapshot zone overrides the store snapshot (the Report pins its snapshot)', () => {
    const w = world('America/Chicago', 'America/Los_Angeles');
    const wrapper = ({ children }: { children: ReactNode }) => <AppProviders services={w.services}>{children}</AppProviders>;
    expect(renderHook(() => useViewZone('America/New_York'), { wrapper }).result.current).toBe('America/New_York');
  });
});
