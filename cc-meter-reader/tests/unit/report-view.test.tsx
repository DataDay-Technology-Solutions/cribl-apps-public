// @vitest-environment jsdom
// The Report card view (/report) in jsdom: the period it opens on, the preview (the sandboxed srcdoc is the
// downloadable HTML), the fields, the four actions (Blob downloads, the email copy with its text fallback), the
// unavailable states, and the view's pure helpers. Layout, real downloads and the clipboard in real engines are
// in tests/e2e/report.spec.ts.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import { fmtDollars } from '../../core/format.ts';
import type { Settings, Snapshot } from '../../core/types.ts';
import { AppProviders } from '../../src/state/providers.tsx';
import { createAppServices } from '../../src/state/services.ts';
import type { AppDocs } from '../../src/state/ports.ts';
import { createAppStore, type DataSource } from '../../src/state/store.ts';
import ReportView from '../../src/views/Report/index.tsx';
import { reportChoice, reportFileName, reportWorkspace, viewerDisplayName } from '../../src/views/Report/model.ts';
import { copyForEmail, downloadFile } from '../../src/views/Report/download.ts';
import { notify } from '../../src/components/common/notify.tsx';
import { TOUR } from './report-fixture.ts';
import { en } from '../../src/copy/en.ts';
import { escapeHtml } from '../../core/report-html.ts';

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

const created: Blob[] = [];
const clicks: { href: string; download: string }[] = [];

beforeEach(() => {
  created.length = 0;
  clicks.length = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
    created.push(b);
    return `blob:mock/${created.length}`;
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { getCriblUser?: unknown }).getCriblUser;
});

function mount(opts: { source?: DataSource; snapshot?: Snapshot | null; phase?: 'loading' | 'done'; path?: string; settings?: Partial<Settings> } = {}) {
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
  const store = createAppStore(
    { ...defaultSettings(TOUR.snapshot.sweepAt, TOUR.settings.displayTimezone), ...TOUR.settings, ...opts.settings },
    {
      hasHydrated: true,
      source: opts.source ?? 'sample',
      prices: TOUR.prices,
      snapshot: opts.snapshot === undefined ? TOUR.snapshot : opts.snapshot,
    },
  );
  store.setState((s) => ({ status: { ...s.status, hydrate: { phase: opts.phase ?? 'done' } } }));
  const services = createAppServices({ store, docs, mergeSettings: (s) => s, engine: { runLocal: vi.fn(), invokeBackend: vi.fn() } });
  mounted.store = store;
  return render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={[opts.path ?? '/report']}>
        <ReportView />
      </MemoryRouter>
    </AppProviders>,
  );
}

const mounted: { store?: ReturnType<typeof createAppStore> } = {};
const preview = () => screen.getByTestId('report-preview') as HTMLIFrameElement;
const srcdoc = () => preview().getAttribute('srcdoc') ?? '';

describe('Report card view', () => {
  it('previews the downloadable document in a sandboxed frame, for the sample', async () => {
    mount();
    const view = screen.getByTestId('report-view');
    expect(within(view).getByRole('heading', { level: 1, name: 'Report card' })).toBeTruthy();
    expect(view.getAttribute('data-source')).toBe('sample');
    expect(preview().getAttribute('sandbox')).toBe('');
    expect(srcdoc()).toContain(`data-figure="saved">${fmtDollars(TOUR.snapshot.headline.mtdM)}<`);
    expect(srcdoc()).toContain('data-sample="true"');
    expect(screen.getByTestId('report-sample-note').textContent).toContain('marked as a sample');
    // MTD · Today · 30 days; no custom range on sample data.
    const group = screen.getByRole('radiogroup', { name: 'Period' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Month to date', 'Today', '30 days']);
  });

  it('opens on the Receipt period and switches without touching it', async () => {
    mount({ path: '/report?period=30d' });
    expect(screen.getByTestId('report-view').getAttribute('data-period')).toBe('30d');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Period' })).getByRole('radio', { name: 'Today' }));
    await waitFor(() => expect(screen.getByTestId('report-view').getAttribute('data-period')).toBe('today'));
    expect(srcdoc()).toContain('Saved by Cribl, today');
  });

  it('puts Prepared for and the note into the document after typing settles', async () => {
    mount();
    fireEvent.change(within(screen.getByTestId('report-prepared-for')).getByRole('textbox'), { target: { value: 'Finance <leadership>' } });
    fireEvent.change(within(screen.getByTestId('report-note')).getByRole('textbox'), { target: { value: 'For the Q3 renewal.' } });
    // Each field settles on its own 300 ms timer, so wait for both.
    await waitFor(
      () => {
        expect(srcdoc()).toContain('Prepared for Finance &lt;leadership&gt;');
        expect(srcdoc()).toContain('For the Q3 renewal.');
      },
      { timeout: 10_000 },
    );
  });

  it('names the viewer from getCriblUser', async () => {
    (window as { getCriblUser?: () => Promise<CriblUser> }).getCriblUser = () => Promise.resolve({ id: '1', username: 'jlee', firstName: 'Jordan', lastName: 'Lee' });
    mount();
    await waitFor(() => expect(srcdoc()).toContain('Prepared by Jordan Lee'));
  });

  it('downloads the PDF, the HTML (the preview itself) and the CSV with their file names', async () => {
    const success = vi.spyOn(notify, 'success').mockImplementation(() => '');
    mount();
    const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
    click('Download PDF');
    click('Download HTML');
    click('Download CSV');
    expect(clicks.map((c) => c.download)).toEqual(
      ['pdf', 'html', 'csv'].map((ext) => expect.stringMatching(new RegExp(`^meter-reader-report-sample-enterprise-mtd-\\d{4}-\\d{2}-\\d{2}\\.${ext}$`))),
    );
    expect(created.map((b) => b.type)).toEqual(['application/pdf', 'text/html;charset=utf-8', 'text/csv;charset=utf-8']);
    const pdf = new Uint8Array(await created[0].arrayBuffer());
    expect(String.fromCharCode(...pdf.slice(0, 8))).toBe('%PDF-1.4');
    expect(await created[1].text()).toBe(srcdoc());
    expect((await created[2].text()).replace(/^﻿/, '').split('\r\n')[0]).toMatch(/^Record,Name,/);
    expect(success.mock.calls.map((c) => c[0])).toEqual(clicks.map((c) => `Downloaded ${c.download}.`));
  });

  it('copies for email as HTML + text, or as text when ClipboardItem is missing', async () => {
    const write = vi.fn(async () => {});
    class FakeItem {
      readonly items: Record<string, Blob>;
      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    }
    Object.assign(globalThis, { ClipboardItem: FakeItem });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write, writeText: vi.fn(async () => {}) } });
    const success = vi.spyOn(notify, 'success').mockImplementation(() => '');
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy for email' }));
    });
    expect(write).toHaveBeenCalledTimes(1);
    const item = (write.mock.calls[0] as unknown as [FakeItem[]])[0][0];
    expect(Object.keys(item.items)).toEqual(['text/html', 'text/plain']);
    expect(await item.items['text/plain'].text()).toContain('METER READER');
    expect(success).toHaveBeenCalledWith('Report copied. Paste it into an email.');
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  });

  it('keeps the figures it opened with until the reader takes the newer ones', async () => {
    mount();
    const before = srcdoc();
    const later: Snapshot = { ...TOUR.snapshot, sweepAt: new Date(Date.parse(TOUR.snapshot.sweepAt) + 60_000).toISOString(), headline: { ...TOUR.snapshot.headline, mtdM: 12_345_600_000 } };
    act(() => mounted.store?.setState({ snapshot: later }));
    expect(await screen.findByTestId('report-newer')).toBeTruthy();
    expect(srcdoc()).toBe(before);
    expect(screen.getByTestId('report-view').getAttribute('data-swept')).toBe(TOUR.snapshot.sweepAt);
    fireEvent.click(within(screen.getByTestId('report-newer')).getByRole('button', { name: 'Update figures' }));
    await waitFor(() => expect(srcdoc()).toContain(`data-figure="saved">${fmtDollars(12_345_600_000)}<`));
    expect(screen.queryByTestId('report-newer')).toBeNull();
    expect(screen.getByTestId('report-view').getAttribute('data-swept')).toBe(later.sweepAt);
  });

  it('says what to know before sending, beside the actions, and never on the document', async () => {
    mount();
    const checks = screen.getByTestId('report-checks');
    expect(within(checks).getByText('Before you send it')).toBeTruthy();
    // The sample: typical list prices and a Cribl cost, every destination priced.
    expect(within(checks).getAllByRole('listitem').map((li) => li.textContent)).toEqual([en.report.view.checkListPrices]);
    expect(srcdoc()).not.toContain('Settings');
    cleanup();
    mount({ settings: { criblCostCentsPerMonth: undefined } });
    expect(within(screen.getByTestId('report-checks')).getAllByRole('listitem').map((li) => li.textContent)).toEqual([en.report.view.checkListPrices, en.report.view.checkNoCost]);
    expect(srcdoc()).toContain(escapeHtml(en.report.doc.kpi.roiUnsetHint));
    expect(srcdoc()).not.toContain('Settings');
    // The checks come before the actions, so they are read before the download.
    const order = screen.getByTestId('report-checks').compareDocumentPosition(screen.getByRole('button', { name: 'Download PDF' }));
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('before the first snapshot the actions are off and say why', () => {
    mount({ snapshot: null, source: 'live' });
    expect(screen.getByTestId('report-unavailable').textContent).toContain('needs the first sweep');
    for (const name of ['Download PDF', 'Download HTML', 'Copy for email', 'Download CSV']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    mount({ snapshot: null, source: 'live', phase: 'loading' });
    expect(screen.getByTestId('report-unavailable').textContent).toContain('until the figures load');
  });
});

describe('Report card helpers', () => {
  it('reportChoice: an explicit choice, the Receipt range (live and the tour, OQ-03), its period, the default', () => {
    const range = { kind: 'relative' as const, hours: 24 };
    expect(reportChoice({ report: 'today' }, 'live', 'mtd')).toBe('today');
    expect(reportChoice({ report: 'range', range }, 'live', 'mtd')).toBe('range');
    // The tour sums a custom range on its synthesized history (P2-W05), so the report keeps it too (OQ-03).
    expect(reportChoice({ report: 'range', range }, 'sample', 'mtd')).toBe('range');
    expect(reportChoice({ range, period: '30d' }, 'sample', 'mtd')).toBe('range');
    expect(reportChoice({ report: 'range', range }, 'replay', 'mtd')).toBe('mtd');
    expect(reportChoice({ range, period: '30d' }, 'replay', 'mtd')).toBe('30d');
    expect(reportChoice({ range }, 'live', 'mtd')).toBe('range');
    expect(reportChoice({ period: 'annualized' }, 'live', 'today')).toBe('today');
    expect(reportChoice({}, 'live', 'annualized')).toBe('mtd');
    expect(reportChoice({ report: 'nonsense' }, 'live', undefined)).toBe('mtd');
  });

  it('viewerDisplayName: full name, else the username', () => {
    expect(viewerDisplayName({ username: 'jlee', firstName: 'Jordan', lastName: 'Lee' })).toBe('Jordan Lee');
    expect(viewerDisplayName({ username: 'jlee', firstName: ' ' })).toBe('jlee');
    expect(viewerDisplayName({ username: ' ' })).toBeUndefined();
    expect(viewerDisplayName(null)).toBeUndefined();
  });

  it('reportWorkspace and file names', () => {
    expect(reportWorkspace('sample', undefined)).toBe('sample-enterprise');
    expect(reportWorkspace('live', 'https://main-example-org.cribl.cloud/api/v1')).toBe('main-example-org');
    expect(reportWorkspace('live', '/mock-api/v1')).toBe('');
    expect(reportFileName('meter-reader-report-acme-mtd-2026-09-26', 'pdf')).toBe('meter-reader-report-acme-mtd-2026-09-26.pdf');
  });

  it('downloadFile reports a refusal', () => {
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => {
      throw new Error('blocked');
    };
    expect(downloadFile('x', 'x.txt', 'text/plain')).toBe(false);
  });

  it('copyForEmail falls back to text, and reports failure when nothing works', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
    expect(await copyForEmail('<b>x</b>', 'x')).toBe('text');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
    expect(await copyForEmail('<b>x</b>', 'x')).toBe('failed');
  });
});
