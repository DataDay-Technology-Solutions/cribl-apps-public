// @vitest-environment jsdom
// UI foundation: React bindings, shell pieces, copy, formatting, routing helpers, shortcuts.

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { Meta, Settings } from '../../core/types.ts';
import { Money, Pct, Bytes } from '../../src/components/common/Figures.tsx';
import { Footer } from '../../src/components/Shell/Footer.tsx';
import { wordCount } from '../../src/story/beats.ts';
import { Page } from '../../src/components/Shell/Page.tsx';
import { deriveDataStatus, STALE_AFTER_MS } from '../../src/components/Shell/status.ts';
import { navKeyForPath } from '../../src/components/Shell/nav.ts';
import { revealScrollLeft, scrollEdges, TAB_FADE_PX } from '../../src/components/Shell/topnavScroll.ts';
import { interpolate, t, tLines, tn } from '../../src/copy/en.ts';
import { PACKAGE_VERSION, versionLabel } from '../../src/lib/env.ts';
import { formatBytes, formatClock, formatDuration, formatMoney, formatPct, formatPoints, formatRelative } from '../../src/lib/format.ts';
import { hrefWithStickyParams, patchSearchParams, readAppParams } from '../../src/lib/params.ts';
import { dispatchShortcut, registerShortcut } from '../../src/lib/shortcuts.ts';
import { chooseRouter, memoryInitialEntry } from '../../src/lib/routerKind.ts';
import { StoreProvider } from '../../src/state/providers.tsx';
import { useAppState } from '../../src/state/react.tsx';
import { createAppStore, type RuntimeStatus } from '../../src/state/store.ts';

const DEFAULTS: Settings = defaultSettings('2026-09-26T00:00:00.000Z', 'UTC');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useAppState', () => {
  it('re-renders on the selected slice only', () => {
    const store = createAppStore(DEFAULTS);
    let renders = 0;
    function Probe() {
      renders++;
      const theme = useAppState((s) => s.theme);
      return <span data-testid="theme">{theme}</span>;
    }
    render(
      <StoreProvider store={store}>
        <Probe />
      </StoreProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('light');
    const before = renders;
    act(() => store.setState({ presenter: true })); // unrelated slice
    expect(renders).toBe(before);
    act(() => store.setState({ theme: 'dark' }));
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });
});

describe('Footer', () => {
  it('shows version · build and the last sweep line from meta', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-26T12:00:12.000Z'));
    const meta: Meta = {
      schemaVersion: 1,
      installedAt: '2026-09-25T00:00:00.000Z',
      collectingSince: '2026-09-25T00:00:00.000Z',
      appVersion: '1.0.0',
      build: 'release',
      metricsSource: 'metrics-query',
      lastSweepAt: '2026-09-26T12:00:00.000Z',
      lastSweepMs: 4100,
      lastSweepCalls: 23,
      sweepErrors: 0,
      consecutiveRateLimited: 0,
      sweepCount: 1,
    };
    const store = createAppStore(DEFAULTS, { meta });
    render(
      <StoreProvider store={store}>
        <Footer />
      </StoreProvider>,
    );
    // The footer names this build's own version (package.json), whatever meta last recorded.
    expect(screen.getByText(new RegExp(versionLabel().replace(/\./g, '\\.')))).toBeTruthy();
    expect(screen.getByTestId('footer-sweep').textContent).toBe('Last sweep 12 s ago · 23 calls · 4.1 s');
  });

  // REVIEW-3a #10: the runner wrote appVersion 'runner' and the footer read "vrunner-demo" + "while open".
  const META_BASE: Meta = {
    schemaVersion: 1,
    installedAt: '2026-09-25T00:00:00.000Z',
    collectingSince: '2026-09-25T00:00:00.000Z',
    appVersion: 'runner',
    build: 'demo',
    metricsSource: 'metrics-query',
    lastSweepAt: '2026-09-26T12:00:08.000Z',
    lastSweepMs: 1100,
    lastSweepCalls: 26,
    sweepErrors: 0,
    consecutiveRateLimited: 0,
    sweepCount: 90,
  };
  const PRICED = { schemaVersion: 1 as const, updatedAt: '2026-09-25T00:00:00.000Z', versions: [] };

  function renderFooter(meta: Meta | null, extra: Parameters<typeof createAppStore>[1] = {}) {
    const store = createAppStore(DEFAULTS, { meta, prices: PRICED, hasHydrated: true, ...extra });
    render(
      <StoreProvider store={store}>
        <Footer />
      </StoreProvider>,
    );
    return store;
  }

  it('shows the installed package version, never meta.appVersion, and names the runner when it metered', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-26T12:00:20.000Z'));
    renderFooter({ ...META_BASE, lastSweepOwner: 'runner:mac-studio:4242' });
    const build = screen.getByTestId('footer-build').textContent ?? '';
    expect(build).toBe(`v${PACKAGE_VERSION} · release`);
    expect(build).not.toContain('runner');
    expect(screen.getByTestId('footer-runtime').textContent).toBe('Metered every minute by the runner on mac-studio');
  });

  it('says who metered: this tab, another tab, the scheduled backend, or nobody until prices exist', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-26T12:00:20.000Z'));
    const ownerId = 'ui:tab-a';
    const sweep: RuntimeStatus['sweep'] = { running: false, nextManualAt: 0, metering: true, ownerId };
    const status = (s: RuntimeStatus['sweep']): RuntimeStatus => ({ hydrate: { phase: 'done' }, live: { phase: 'waiting' }, sweep: s });

    renderFooter({ ...META_BASE, lastSweepOwner: ownerId }, { status: status(sweep) });
    expect(screen.getByTestId('footer-runtime').textContent).toBe('Metered by this tab, every minute');
    cleanup();
    renderFooter({ ...META_BASE, lastSweepOwner: 'ui:tab-b' }, { status: status({ ...sweep, metering: false }) });
    expect(screen.getByTestId('footer-runtime').textContent).toBe('Metered by another open tab, every minute');
    cleanup();
    // Metering, and the last tab sweep finished before this tab started metering (P1-D03): this is the only tab
    // reloaded under a new id, so it says "this tab" until another tab's sweep proves otherwise.
    const since = Date.parse('2026-09-26T12:00:15.000Z');
    renderFooter({ ...META_BASE, lastSweepOwner: 'ui:tab-b' }, { status: status({ ...sweep, meteringSince: since }) });
    expect(screen.getByTestId('footer-runtime').textContent).toBe('Metered by this tab, every minute');
    cleanup();
    // A tab sweep that finished after this tab started metering is another open tab's.
    renderFooter({ ...META_BASE, lastSweepOwner: 'ui:tab-b' }, { status: status({ ...sweep, meteringSince: Date.parse('2026-09-26T12:00:01.000Z') }) });
    expect(screen.getByTestId('footer-runtime').textContent).toBe('Metered by another open tab, every minute');
    cleanup();
    renderFooter({ ...META_BASE, lastSweepOwner: 'backend:meter' });
    expect(screen.getByTestId('footer-runtime').textContent).toBe('Metered every minute by the scheduled backend');
    cleanup();
    renderFooter(null, { prices: null });
    expect(screen.getByTestId('footer-runtime').textContent).toBe('Set prices to start the meter');
    cleanup();
    // A runner seen 30 s ago still meters, though a tab won the last minute; after 90 s it no longer counts.
    const seen = Date.parse('2026-09-26T11:59:50.000Z');
    renderFooter({ ...META_BASE, lastSweepOwner: ownerId }, { status: status({ ...sweep, runnerSeenAt: seen }) });
    expect(screen.getByTestId('footer-runtime').textContent).toBe('Metered every minute by the runner');
    cleanup();
    // After a reload the minute was metered under this tab's previous id; this tab's own sweeps come back
    // 'current', so it is still this tab — unless its sweep was refused for another tab's lock.
    renderFooter({ ...META_BASE, lastSweepOwner: 'ui:before-reload' }, { status: status({ ...sweep, lastResult: { ok: true, mode: 'ui', skipped: 'current' } }) });
    expect(screen.getByTestId('footer-runtime').textContent).toBe('Metered by this tab, every minute');
    cleanup();
    renderFooter({ ...META_BASE, lastSweepOwner: 'ui:tab-b' }, { status: status({ ...sweep, lastResult: { ok: true, mode: 'ui', skipped: 'locked' } }) });
    expect(screen.getByTestId('footer-runtime').textContent).toBe('Metered by another open tab, every minute');
  });
});

describe('Page (the one page frame, BEAUTY-3a F7)', () => {
  it('renders one h1 with subtitle and actions, and passes data attributes and classes through', () => {
    const { container } = render(
      <Page title="Ledger" subtitle="Every flow, priced." actions={<button type="button">Export</button>} className="mr-ledger" data-testid="ledger-view" titleId="t1">
        <section>body</section>
      </Page>,
    );
    const root = screen.getByTestId('ledger-view');
    expect(root.className).toBe('mr-page mr-ledger');
    expect(root.getAttribute('data-width')).toBe('default');
    const h1 = container.querySelectorAll('h1');
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toBe('Ledger');
    expect(h1[0].id).toBe('t1');
    expect(h1[0].className).toBe('mr-page-title');
    expect(container.querySelector('.mr-page-subtitle')?.textContent).toBe('Every flow, priced.');
    expect(container.querySelector('.mr-page-actions button')?.textContent).toBe('Export');
    expect(root.querySelector(':scope > section')?.textContent).toBe('body');
  });

  it('renders no header when the content carries the h1, and a narrow frame on request', () => {
    const { container } = render(
      <Page width="narrow" data-testid="p">
        <h1>Saved by Cribl</h1>
      </Page>,
    );
    expect(container.querySelector('.mr-page-head')).toBeNull();
    expect(screen.getByTestId('p').getAttribute('data-width')).toBe('narrow');
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });
});

describe('TopNav scrolling (BEAUTY-3a F6)', () => {
  it('knows which edges hide tabs', () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 400, clientWidth: 400 })).toEqual({ start: false, end: false });
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 520, clientWidth: 330 })).toEqual({ start: false, end: true });
    expect(scrollEdges({ scrollLeft: 100, scrollWidth: 520, clientWidth: 330 })).toEqual({ start: true, end: true });
    expect(scrollEdges({ scrollLeft: 190, scrollWidth: 520, clientWidth: 330 })).toEqual({ start: true, end: false });
  });

  it('scrolls just enough to show the active tab clear of the fade, and leaves a visible tab alone', () => {
    // A 330 px row; the Demo tab spans 470–520 at scrollLeft 0 ("Der…" before the fix).
    expect(revealScrollLeft(0, 330, 470, 520)).toBe(520 + TAB_FADE_PX - 330);
    // Already visible: unchanged.
    expect(revealScrollLeft(0, 330, 100, 160)).toBe(0);
    // Scrolled right, then the first tab is chosen again: back to the start.
    expect(revealScrollLeft(214, 330, 0, 60)).toBe(0);
    // A tab under the left fade is pulled clear of it.
    expect(revealScrollLeft(200, 330, 210, 260)).toBe(210 - TAB_FADE_PX);
  });
});

describe('figures', () => {
  it('render money in whole dollars with tabular numerals and unit suffixes', () => {
    const { container } = render(
      <div>
        <Money value={2_500_000} per="day" tone="saved" />
        <Pct value={0.604} />
        <Bytes value={12e9} per="day" />
        <Money value={null} />
      </div>,
    );
    const nums = [...container.querySelectorAll('.mr-num')].map((n) => n.textContent);
    expect(nums).toEqual(['$25', '60%', '12.0 GB', '—']);
    expect(container.querySelector('.mr-saved')).not.toBeNull();
    expect(container.textContent).toContain('/ day');
  });
});

describe('copy', () => {
  it('interpolates placeholders and leaves unknown ones visible', () => {
    expect(t('receipt.wouldHavePaid', { amount: '$68,412' })).toBe('You would have paid $68,412');
    expect(interpolate('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    expect(tn('unpriced.banner', 3)).toBe('3 destinations are unpriced. Set prices to include them.');
    expect(tn('unpriced.banner', 1)).toBe('1 destination is unpriced. Set prices to include it.');
    expect(tLines('story.captions.meter', { whp: '$1', paid: '$2', saved: '$3' })).toEqual([
      'You would have paid $1. You paid $2.',
      'Saved by Cribl: $3.',
    ]);
  });

  it('keeps every story caption line at 12 words or fewer (SPEC 15)', () => {
    const keys = ['hook', 'howItWorks', 'meter', 'change', 'watching', 'alert', 'slack', 'restore', 'receipt', 'ask'] as const;
    for (const key of keys) {
      for (const line of tLines(`story.captions.${key}`)) {
        // Words as SPEC 15 counts them (src/story/beats.ts wordCount): a lone '·' separator is not a word.
        expect(wordCount(line), line).toBeLessThanOrEqual(12);
      }
    }
  });
});

describe('format', () => {
  it('formats at the edge', () => {
    expect(formatMoney(-150_000)).toBe('−$2');
    expect(formatMoney(123_456, { cents: true })).toBe('$1.23');
    expect(formatMoney(2_500_000, { signed: true })).toBe('+$25');
    expect(formatPct(0.75)).toBe('75%');
    expect(formatPoints(0.75, 0.5)).toBe('25 points');
    // The difference of the printed percentages: 76% → 49% is 27 points, and 37.56% → 40.35% is 2.
    expect(formatPoints(0.756, 0.49)).toBe('27 points');
    expect(formatPoints(0.3756, 0.4035)).toBe('2 points');
    expect(formatBytes(1.5e12)).toBe('1.5 TB');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(4100)).toBe('4.1 s');
    expect(formatClock(171)).toBe('2:51');
    const now = Date.parse('2026-09-26T12:00:00Z');
    expect(formatRelative(now - 12_000, now)).toBe('12 s ago');
    expect(formatRelative(now - 3 * 60_000, now)).toBe('3 min ago');
    expect(formatRelative(now, now)).toBe('just now');
  });

  it('labels the version as the plain package version (D22: demo builds are numeric, no -demo suffix)', () => {
    expect(versionLabel('1.0.0')).toBe('v1.0.0');
    expect(versionLabel('1.0.1')).toBe('v1.0.1');
    expect(versionLabel('v1.0.1-demo')).toBe('v1.0.1');
    expect(versionLabel()).toBe(`v${PACKAGE_VERSION}`);
  });
});

describe('routing helpers', () => {
  it('maps paths to tabs and keeps demo out of the release build', () => {
    expect(navKeyForPath('/')).toBe('receipt');
    expect(navKeyForPath('/settings/prices')).toBe('settings');
    expect(navKeyForPath('/first-run')).toBeUndefined();
    expect(navKeyForPath('/demo')).toBeUndefined(); // VITE_MR_BUILD unset in tests = release
  });

  it('carries sticky params and patches flags', () => {
    const current = new URLSearchParams('group=default&period=30d&object=pipe:default:x&present=1');
    expect(hrefWithStickyParams('/flow', current)).toBe('/flow?group=default&period=30d');
    const next = patchSearchParams(current, { present: false, story: true });
    expect(readAppParams(next)).toMatchObject({ present: false, story: true, period: '30d', group: 'default' });
    expect(readAppParams(new URLSearchParams('period=bogus')).period).toBeUndefined();
  });

  it('falls back to a MemoryRouter outside the base path or without history', () => {
    const history = { state: null, pushState: vi.fn(), replaceState: vi.fn() } as unknown as History;
    const loc = (pathname: string, protocol = 'https:') => ({ pathname, protocol, href: `${protocol}//x${pathname}`, search: '' }) as Location;
    expect(chooseRouter('/app-ui/meter-reader', { location: loc('/app-ui/meter-reader/flow'), history })).toBe('browser');
    expect(chooseRouter('/app-ui/meter-reader', { location: loc('/elsewhere'), history })).toBe('memory');
    expect(chooseRouter('/', { location: loc('/', 'about:'), history })).toBe('memory');
    const throwing = { state: null, pushState: vi.fn(), replaceState: () => { throw new Error('SecurityError'); } } as unknown as History;
    expect(chooseRouter('/', { location: loc('/'), history: throwing })).toBe('memory');
    expect(memoryInitialEntry('/app-ui/meter-reader', { pathname: '/app-ui/meter-reader/ledger', search: '?object=x' })).toBe('/ledger?object=x');
    expect(memoryInitialEntry('/app-ui/meter-reader', { pathname: '/app-ui/meter-reader', search: '' })).toBe('/');
  });
});

describe('data status', () => {
  it('derives live / stale / rate-limited / sample', () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    const store = createAppStore(DEFAULTS, { hasHydrated: true });
    store.setState((s) => ({ status: { ...s.status, hydrate: { phase: 'done' } } }));
    // No prices document: nothing can sweep, so not "waiting" for one (P1-D01).
    expect(deriveDataStatus(store.getState(), now)).toBe('not-metering');
    store.setState({ prices: { schemaVersion: 1, updatedAt: '2026-09-25T00:00:00.000Z', versions: [] } });
    expect(deriveDataStatus(store.getState(), now)).toBe('waiting');
    store.setState({ snapshot: { sweepAt: new Date(now - 10_000).toISOString() } as never });
    expect(deriveDataStatus(store.getState(), now)).toBe('live');
    expect(deriveDataStatus(store.getState(), now + STALE_AFTER_MS + 10_001)).toBe('stale');
    store.setState((s) => ({ status: { ...s.status, live: { ...s.status.live, backoffUntil: now + 1000 } } }));
    expect(deriveDataStatus(store.getState(), now)).toBe('rate-limited');
    store.setState({ source: 'sample' });
    expect(deriveDataStatus(store.getState(), now)).toBe('sample');
  });
});

describe('shortcuts', () => {
  it('dispatch to the latest handler and stay quiet in text fields', () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = registerShortcut('p', first);
    const offSecond = registerShortcut('P', second);
    const press = (target: EventTarget, init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(event, 'target', { value: target });
      return dispatchShortcut(event);
    };
    expect(press(document.body, { key: 'p' })).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    const input = document.createElement('input');
    expect(press(input, { key: 'p' })).toBe(false);
    expect(press(document.body, { key: 'p', metaKey: true })).toBe(false);

    offSecond();
    expect(press(document.body, { key: 'P', shiftKey: true })).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    offFirst();
    expect(press(document.body, { key: 'p' })).toBe(false);
  });
});
