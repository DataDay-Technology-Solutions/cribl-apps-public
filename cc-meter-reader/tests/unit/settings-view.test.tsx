// @vitest-environment jsdom
// Settings view (src/views/Settings) over fake services: destinations listed from the inventory, the hasHydrated
// gate on writes, invalid input never writes, a Save appends one price version, sample data is read-only.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { InventoryDoc, PricesDoc, Settings, Snapshot } from '../../core/types.ts';
import SettingsView from '../../src/views/Settings/index.tsx';
import { AppProviders } from '../../src/state/providers.tsx';
import { createAppStore } from '../../src/state/store.ts';
import { createAppServices } from '../../src/state/services.ts';
import type { AppDocs } from '../../src/state/ports.ts';

const NOW_ISO = '2026-09-26T12:00:00.000Z';
const DEFAULTS: Settings = defaultSettings(NOW_ISO, 'UTC');

const INVENTORY: InventoryDoc = {
  schemaVersion: 1,
  updatedAt: NOW_ISO,
  hash: 'h',
  byGroup: {
    default: {
      inputs: [],
      pipelines: [],
      routes: [],
      outputs: [
        { id: 'mrd_siem_prod', type: 'devnull' },
        { id: 'splunk_hec_out', type: 'splunk_hec' },
        { id: 'default', type: 'default' },
      ],
    },
  },
};

beforeAll(() => {
  // jsdom lacks these; Capra's overlays and our layout code touch them.
  window.matchMedia ??= ((query: string) =>
    ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.CRIBL_API_URL = 'https://leader.example.com/api/v1';
});

afterEach(() => {
  cleanup();
});

function setup(
  opts: {
    hydrated?: boolean;
    source?: 'live' | 'sample';
    inventory?: InventoryDoc | null;
    prices?: PricesDoc | null;
    path?: string;
    leaderInventory?: InventoryDoc | Error;
  } = {},
) {
  const writes: { key: string; doc: unknown }[] = [];
  const docs: AppDocs = {
    readSettings: async () => null,
    readPrices: async () => opts.prices ?? null,
    readSnapshot: async () => null,
    readMeta: async () => null,
    readDemoState: async () => null,
    readInventory: vi.fn(async () => (opts.inventory === undefined ? INVENTORY : opts.inventory)),
    writeSettings: async (doc) => {
      writes.push({ key: 'settings', doc });
    },
    writePrices: async (doc) => {
      writes.push({ key: 'prices', doc });
    },
  };
  if (opts.leaderInventory !== undefined) {
    const leader = opts.leaderInventory;
    docs.readLeaderInventory = vi.fn(async () => {
      if (leader instanceof Error) throw leader;
      return leader;
    });
  }
  const store = createAppStore(DEFAULTS, {
    hasHydrated: opts.hydrated ?? true,
    source: opts.source ?? 'live',
    prices: opts.prices ?? null,
    snapshot: opts.source === 'sample' ? ({ destinations: [{ groupId: 'default', outputId: 'mrd_siem_prod', type: 'devnull' }] } as unknown as Snapshot) : null,
  });
  store.setState((s) => ({ status: { ...s.status, hydrate: { phase: opts.hydrated === false ? 'loading' : 'done' } } }));
  const services = createAppServices({ store, docs, mergeSettings: (s) => s, engine: { runLocal: vi.fn(), invokeBackend: vi.fn() } });
  const utils = render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={[opts.path ?? '/settings/prices']}>
        <SettingsView />
      </MemoryRouter>
    </AppProviders>,
  );
  return { ...utils, store, writes, docs };
}

describe('SettingsView', () => {
  it('renders the section rail with every release section and no Demo', async () => {
    setup();
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    const labels = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(labels).toEqual(['Prices', 'Budgets', 'Cribl cost', 'Alerts', 'Where to send alerts', 'Runtime']);
    expect(within(nav).getByRole('link', { name: 'Prices' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Alerts' }).getAttribute('href')).toBe('/settings?section=alerts');
  });

  it('lists destinations from the inventory (never the default forwarder) as unpriced', async () => {
    setup();
    const siem = await screen.findByTestId('price-row-mrd_siem_prod');
    expect(siem.textContent).toContain('SIEM (prod)');
    expect(siem.querySelector('[data-status="unpriced"]')).not.toBeNull();
    expect(screen.getByTestId('price-row-splunk_hec_out')).toBeTruthy();
    expect(screen.queryByTestId('price-row-default')).toBeNull();
    expect(screen.getByTestId('prices-counts').textContent).toContain('2 destinations');
  });

  // REVIEW-3a #3: the 'ui' runtime waits for prices, so pricing cannot wait for a sweep's inventory.
  it('before any sweep, lists destinations read straight from the Leader (nothing written)', async () => {
    const { docs, writes } = setup({ inventory: null, leaderInventory: INVENTORY });
    const siem = await screen.findByTestId('price-row-mrd_siem_prod');
    expect(siem.querySelector('[data-status="unpriced"]')).not.toBeNull();
    expect(screen.getByTestId('prices-counts').textContent).toContain('2 destinations');
    expect(docs.readLeaderInventory).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  it('prefers the sweep\'s KV inventory and never asks the Leader when it exists', async () => {
    const { docs } = setup({ leaderInventory: INVENTORY });
    await screen.findByTestId('price-row-mrd_siem_prod');
    expect(docs.readLeaderInventory).not.toHaveBeenCalled();
  });

  it('shows the inventory error when the Leader read is refused', async () => {
    setup({ inventory: null, leaderInventory: Object.assign(new Error('HTTP 403'), { status: 403 }) });
    await waitFor(() => expect(document.body.textContent).toMatch(/your destinations/));
    expect(screen.queryByTestId('price-row-mrd_siem_prod')).toBeNull();
  });

  it('shows the designed wait while the first sweep has not written the inventory', async () => {
    const { container } = setup({ inventory: null });
    await waitFor(() => expect(container.querySelector('[data-state="waiting"]')).not.toBeNull());
    expect(screen.getByText('Reading your destinations')).toBeTruthy();
  });

  it('invalid input never writes; a valid save appends one version keyed group:output', async () => {
    const { writes } = setup();
    const input = (await screen.findByTestId('price-input-splunk_hec_out')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(await screen.findByText("Enter a number, 0 or more.")).toBeTruthy();
    // A never-priced workspace's Prices save reads "Start the meter" (P2-W09).
    const save = screen.getAllByRole('button', { name: 'Start the meter' })[0];
    await act(async () => {
      fireEvent.click(save);
    });
    expect(writes).toEqual([]);

    fireEvent.change(input, { target: { value: '2.50' } });
    await waitFor(() => expect(screen.getByText('1 unsaved change')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Start the meter' })[0]);
    });
    // A fresh install's first prices save stores its settings first (r1 ui-1, B1: the display zone reaches KV
    // before the first sweep); the prices document is still one save with one version.
    await waitFor(() => expect(writes.filter((w) => w.key === 'prices')).toHaveLength(1));
    expect(writes.map((w) => w.key)).toEqual(['settings', 'prices']);
    const doc = writes.find((w) => w.key === 'prices')!.doc as PricesDoc;
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0].byOutputId).toEqual({
      'default:splunk_hec_out': { milliCentsPerGb: 250_000, preset: 'splunk_cloud', counterfactual: { kind: 'same' } },
    });
  });

  it("each row's ⓘ opens what its preset's typical price rests on, and says it is not a quote", async () => {
    setup();
    const row = await screen.findByTestId('price-row-splunk_hec_out');
    const info = within(row).getByTestId('preset-info-button');
    expect(info.getAttribute('aria-label')).toMatch(/^About the Splunk Cloud price, /);
    await act(async () => {
      fireEvent.click(info);
    });
    const panel = await screen.findByTestId('preset-info-splunk_cloud');
    expect(panel.textContent).toContain('Splunk Cloud · typical $2.25 / GB');
    expect(panel.textContent).toContain('Typical range $1.47–$4.85 per GB');
    expect(panel.textContent).toMatch(/per GB\/day of entitlement/);
    expect(within(panel).getByTestId('preset-disclaimer').textContent).toBe('Typical list pricing, not a quote. Enter your contract rate.');
    for (const a of within(panel).getAllByRole('link')) {
      expect(a.getAttribute('href')).toMatch(/^https:\/\//);
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('refuses writes until settings are hydrated (the hasHydrated gate)', async () => {
    const { writes, container } = setup({ hydrated: false });
    await waitFor(() => expect(container.querySelector('section[data-section="prices"]')).not.toBeNull());
    // Before hydration the section shows its skeleton: no field to edit, no Save to press.
    expect(screen.queryByTestId('price-input-splunk_hec_out')).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Save changes|Start the meter)$/ })).toBeNull();
    expect(writes).toEqual([]);
  });

  it('is read-only while sample data is showing', async () => {
    const { container } = setup({ source: 'sample' });
    expect(container.querySelector('[data-state="read-only-sample"]')).not.toBeNull();
    const input = (await screen.findByTestId('price-input-mrd_siem_prod')) as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('routes ?section= to its section', async () => {
    const { container } = setup({ path: '/settings?section=alerts' });
    await waitFor(() => expect(container.querySelector('section[data-section="alerts"]')).not.toBeNull());
    expect(screen.getByText('Savings regression')).toBeTruthy();
  });

  it('says where direct webhooks live instead of storing one (D57 replaces the SPEC 12.6 storage sentence)', async () => {
    setup({ path: '/settings/notifications' });
    // An added endpoint is a Cribl notification target; nothing offers a direct webhook or a URL field.
    fireEvent.click(await screen.findByRole('button', { name: 'Add endpoint' }));
    expect((await screen.findByTestId('endpoint-0')).getAttribute('data-channel')).toBe('cribl-target');
    expect(screen.queryByTestId('endpoint-0-channel')).toBeNull();
    expect(screen.queryByText('Direct webhook')).toBeNull();
    expect(
      await screen.findByText(
        "Meter Reader stores no webhook URL. Direct webhooks are sent only by the runner, from URLs in the runner's own .env file (MR_WEBHOOKS).",
      ),
    ).toBeTruthy();
  });

  it('shows the runtime sentence on Runtime', async () => {
    setup({ path: '/settings?section=runtime' });
    expect(await screen.findByText("Meters every completed minute while this app is open (it checks twice a minute); when you reopen it, it catches up from Cribl's metrics history.")).toBeTruthy();
    expect(screen.getByTestId('runtime-value').textContent).toContain('This browser tab');
  });
});
