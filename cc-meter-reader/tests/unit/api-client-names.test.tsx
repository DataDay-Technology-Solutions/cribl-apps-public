// @vitest-environment jsdom
// Usefulness review, round 2: GitOps or CI-managed Cribl commits through the API, so an alert's author is an OAuth
// client id. Settings → Alerts → API clients lists the clients the snapshot's commits name and lets a member give
// each one a name, kept in settings.humanize under "client:<last four>" (never the id; a label core/settings.ts
// screens like every other). The cards, the timeline and the Changes list then show that name.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { Commit, Settings, Snapshot } from '../../core/types.ts';
import { AppProviders } from '../../src/state/providers.tsx';
import type { AppDocs } from '../../src/state/ports.ts';
import { createAppServices } from '../../src/state/services.ts';
import { createAppStore } from '../../src/state/store.ts';
import SettingsView from '../../src/views/Settings/index.tsx';
import { alertsDirtyFields, alertsDraftFrom, apiClientKeys, applyAlerts, clientNamesFrom } from '../../src/views/Settings/model.ts';

const NOW_ISO = '2026-09-27T12:00:00.000Z';
const CLIENT = 'k3xq9Zt0aBcDeF7w1r2s@clients';

beforeAll(() => {
  window.matchMedia ??= ((query: string) =>
    ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.CRIBL_API_URL = 'https://leader.example.com/api/v1';
});
afterEach(cleanup);

const commit = (hash: string, author: string): Commit => ({ hash, message: 'sync', author, committedAt: NOW_ISO, groupId: 'default', files: [], source: 'version' }) as unknown as Commit;
const snap = (authors: string[]): Pick<Snapshot, 'timeline' | 'incidents'> => ({ timeline: authors.map((a, i) => commit(`abc${i}def0000`, a)), incidents: [] });

describe('the model', () => {
  it('lists each API client once, by label key, beside those already named; people are not listed', () => {
    expect(apiClientKeys(snap([CLIENT, 'Steve Koelpin', CLIENT, 'zz99@clients']), {})).toEqual(['client:1r2s', 'client:zz99']);
    expect(apiClientKeys(snap([]), { 'client:aaaa': 'Old pipeline' })).toEqual(['client:aaaa']);
  });

  it('reads and writes the names in settings.humanize, leaving every other label alone', () => {
    const current: Settings = { ...defaultSettings(NOW_ISO, 'UTC'), humanize: { mrd_pay_sample: 'Payments API sampling', 'client:zz99': 'Old' } };
    const draft = alertsDraftFrom(current);
    expect(draft.clientNames).toEqual({ 'client:zz99': 'Old' });
    expect(clientNamesFrom(current.humanize)).toEqual({ 'client:zz99': 'Old' });
    const edited = { ...draft, clientNames: { 'client:zz99': '  ', 'client:1r2s': ' GitOps pipeline ' } };
    expect(alertsDirtyFields(edited, draft)).toEqual(['clientNames']);
    const { next, errors } = applyAlerts(current, edited);
    expect(errors).toEqual({});
    expect(next.humanize).toEqual({ mrd_pay_sample: 'Payments API sampling', 'client:1r2s': 'GitOps pipeline' });
  });

  it('a name that looks like a web address is refused, as every label is', () => {
    const current = defaultSettings(NOW_ISO, 'UTC');
    const { errors } = applyAlerts(current, { ...alertsDraftFrom(current), clientNames: { 'client:1r2s': 'https://hooks.example.com/x' } });
    expect(errors.humanize).toBeDefined();
  });
});

describe('Settings → Alerts → API clients', () => {
  it('names the client the snapshot’s commits carry and saves the name as a label', async () => {
    const writes: { key: string; doc: unknown }[] = [];
    const docs: AppDocs = {
      readSettings: async () => null,
      readPrices: async () => null,
      readSnapshot: async () => null,
      readMeta: async () => null,
      readDemoState: async () => null,
      readInventory: vi.fn(async () => null),
      writeSettings: async (doc: unknown) => {
        writes.push({ key: 'settings', doc });
      },
    } as unknown as AppDocs;
    const store = createAppStore(defaultSettings(NOW_ISO, 'UTC'), {
      hasHydrated: true,
      source: 'live',
      snapshot: { flows: [], destinations: [], ...snap([CLIENT, 'Steve Koelpin']) } as unknown as Snapshot,
    });
    store.setState((s) => ({ status: { ...s.status, hydrate: { phase: 'done' } } }));
    const services = createAppServices({ store, docs, mergeSettings: (s) => s, engine: { runLocal: vi.fn(), invokeBackend: vi.fn() } });
    render(
      <AppProviders services={services}>
        <MemoryRouter initialEntries={['/settings?section=alerts']}>
          <SettingsView />
        </MemoryRouter>
      </AppProviders>,
    );
    const group = await screen.findByRole('group', { name: 'API clients' });
    expect(group.textContent).toContain('API client ··1r2s');
    expect(group.textContent).not.toContain('k3xq9Zt0');
    const input = screen.getByTestId('alerts-client-1r2s').querySelector('input') ?? (screen.getByTestId('alerts-client-1r2s') as HTMLInputElement);
    fireEvent.change(input, { target: { value: 'GitOps pipeline' } });
    const save = await screen.findByRole('button', { name: /^Save/ });
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    const saved = writes[writes.length - 1].doc as Settings;
    expect(saved.humanize['client:1r2s']).toBe('GitOps pipeline');
  });
});
