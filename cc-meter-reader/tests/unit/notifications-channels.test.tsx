// @vitest-environment jsdom
// Settings → Where to send alerts, the Cribl channels (DECISIONS D23): the bell row (on by default, stored only
// once changed), a Cribl notification target (typed, or listed only on "Load targets", never its URL; Connect
// is confirmed and creates exactly the relay; the test goes through Cribl), no direct webhook (D57: no build
// stores a webhook URL; the runner's are named from meta), and the weekly receipt's "Send the last 7 days now".

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { NotificationEndpoint, Settings } from '../../core/types.ts';
import SettingsView from '../../src/views/Settings/index.tsx';
import { AppProviders } from '../../src/state/providers.tsx';
import { createAppStore } from '../../src/state/store.ts';
import { createAppServices } from '../../src/state/services.ts';
import type { AppDocs, WeeklyOutcome } from '../../src/state/ports.ts';

const NOW_ISO = '2026-09-26T12:00:00.000Z';
const API = 'https://leader.example.com/api/v1';
const SLACK_SECRET = 'https://hooks.slack.com/services/T0/B0/SECRETSECRET';

beforeAll(() => {
  window.matchMedia ??= ((query: string) =>
    ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.CRIBL_API_URL = API;
});

interface Req {
  method: string;
  path: string;
  body?: unknown;
}
let requests: Req[] = [];
let routes: Record<string, { status: number; body: unknown }> = {};
const realFetch = window.fetch;

beforeEach(() => {
  requests = [];
  routes = {
    'GET /notification-targets': {
      status: 200,
      body: {
        items: [
          { id: 'system_notifications', type: 'bulletin_message', title: 'Notification' },
          { id: 'ops-slack', type: 'slack', url: SLACK_SECRET, description: 'Ops channel' },
        ],
        count: 2,
      },
    },
    'POST /system/messages': { status: 200, body: { items: [{}], count: 1 } },
    'GET /m/default_search/search/saved/meter_reader_alert_relay': { status: 404, body: { status: 'error', message: 'Item not found' } },
    'POST /m/default_search/search/saved': { status: 200, body: { items: [{ id: 'meter_reader_alert_relay' }], count: 1 } },
    'POST /m/default_search/search/saved/meter_reader_alert_relay/notifications': { status: 201, body: { items: [{}], count: 1 } },
    'POST /search/notifications': { status: 200, body: { items: [{ message: 'Search notification request forwarded.' }], count: 1 } },
  };
  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.startsWith(API) ? url.slice(API.length) : url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ method, path, body });
    const r = routes[`${method} ${path}`] ?? { status: 404, body: { status: 'error', message: 'Not Found' } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof window.fetch;
});

afterEach(() => {
  cleanup();
  window.fetch = realFetch;
});

const TARGET_EP: NotificationEndpoint = {
  id: 'ep_target',
  name: 'Ops Slack via Cribl',
  url: '',
  host: '',
  format: 'generic',
  minSeverity: 'medium',
  weeklyReceipt: false,
  enabled: true,
  channel: 'cribl-target',
  criblTargetId: 'ops-slack',
};

function setup(notifications: NotificationEndpoint[] = [], weekly?: WeeklyOutcome) {
  const settings: Settings = { ...defaultSettings(NOW_ISO, 'UTC'), notifications };
  const writes: Settings[] = [];
  const docs: AppDocs = {
    readSettings: async () => null,
    readPrices: async () => null,
    readSnapshot: async () => null,
    readMeta: async () => null,
    readDemoState: async () => null,
    readInventory: async () => null,
    writeSettings: async (doc) => {
      writes.push(doc);
    },
    writePrices: async () => undefined,
  };
  const store = createAppStore(settings, { hasHydrated: true, source: 'live', prices: null, snapshot: null });
  store.setState((s) => ({ status: { ...s.status, hydrate: { phase: 'done' } } }));
  const runWeekly = vi.fn(async () => weekly ?? { sent: 0, endpoints: 0, deliveries: [], calls: 0, skipped: 'no_endpoints' as const });
  const services = createAppServices({ store, docs, mergeSettings: (s) => s, engine: { runLocal: vi.fn(), invokeBackend: vi.fn(), runWeekly } });
  const utils = render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={['/settings/notifications']}>
        <SettingsView />
      </MemoryRouter>
    </AppProviders>,
  );
  return { ...utils, writes, store, runWeekly };
}

const save = async () => {
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[0]);
  });
};

describe('Where to send alerts — the Cribl bell', () => {
  it('shows the bell row on by default with no setup, and calls nothing on mount', async () => {
    setup();
    const bell = await screen.findByTestId('endpoint-bell');
    expect(bell.textContent).toContain('Cribl notifications (bell)');
    expect(bell.textContent).toContain('no setup');
    expect(bell.getAttribute('data-enabled')).toBe('true');
    expect(screen.getByTestId('channels-intro').textContent).toContain('Alerts at or above the minimum severity go to the Cribl notification bell');
    // The empty list is one line under the bell that points at notification targets (EPIC_AUDIT P0-10, P1-G06);
    // the webhook storage sentence (SPEC 12.6) waits for a direct-webhook editor.
    expect(screen.getByTestId('endpoints-empty').textContent).toContain('No endpoints yet. Alerts still reach the Cribl bell.');
    expect(screen.getByTestId('endpoints-empty').textContent).toContain('Cribl notification target');
    expect(screen.queryByTestId('storage-sentence')).toBeNull();
    expect(requests).toEqual([]);
  });

  it('sends a test to the bell through POST /system/messages', async () => {
    setup();
    const bell = await screen.findByTestId('endpoint-bell');
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('endpoint-bell-test')).getByRole('button'));
    });
    await waitFor(() => expect(screen.getByTestId('endpoint-bell-result').textContent).toContain('Posted to the Cribl notification bell (200)'));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/system/messages' });
    expect(requests[0].body).toMatchObject({ severity: 'info', title: 'Test: Savings dropped: Example pipeline' });
    expect(bell.getAttribute('data-enabled')).toBe('true');
  });

  it('shows a refused bell test plainly', async () => {
    routes['POST /system/messages'] = { status: 403, body: { status: 'error', message: 'Forbidden' } };
    setup();
    await screen.findByTestId('endpoint-bell');
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('endpoint-bell-test')).getByRole('button'));
    });
    await waitFor(() => expect(screen.getByTestId('endpoint-bell-result').getAttribute('data-result')).toBe('failed'));
    expect(screen.getByTestId('endpoint-bell-result').textContent).toContain('Cribl refused the request (403)');
  });

  it('stores the bell only once it is changed: switched off, it saves as a disabled bell endpoint', async () => {
    const { writes } = setup();
    const bell = await screen.findByTestId('endpoint-bell');
    expect(screen.getByText('No unsaved changes')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(bell).getByRole('switch'));
    });
    await waitFor(() => expect(screen.getByText('1 unsaved change')).toBeTruthy());
    await save();
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].notifications).toEqual([expect.objectContaining({ id: 'cribl-bell', channel: 'cribl-bell', enabled: false, url: '' })]);
  });
});

describe('Where to send alerts — a Cribl notification target', () => {
  it('lists targets only on "Load targets" (with the privacy note), never shows their secrets, and offers Connect', async () => {
    setup([TARGET_EP]);
    const ep = await screen.findByTestId('endpoint-0');
    expect(ep.getAttribute('data-channel')).toBe('cribl-target');
    await waitFor(() => expect(screen.getByTestId('endpoint-0-relay').getAttribute('data-relay')).toBe('missing'), { timeout: 3_000 });
    // Typed id, no listing: only the relay check has gone out.
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /m/default_search/search/saved/meter_reader_alert_relay']);
    expect((within(screen.getByTestId('endpoint-0-target')).getByRole('textbox') as HTMLInputElement).value).toBe('ops-slack');
    const targetsLine = screen.getByTestId('endpoint-0-targets');
    expect(targetsLine.getAttribute('data-targets')).toBe('idle');
    expect(targetsLine.textContent).toContain("Cribl returns each target's full configuration to this browser, webhook URLs included");

    await act(async () => {
      fireEvent.click(within(targetsLine).getByRole('button', { name: 'Load targets' }));
    });
    await waitFor(() => expect(screen.getByTestId('endpoint-0-targets').getAttribute('data-targets')).toBe('ok'));
    expect(ep.textContent).toContain('Ops channel');
    expect(ep.textContent).toContain('via Cribl');
    expect(document.body.innerHTML).not.toContain('SECRETSECRET');
    expect(document.body.innerHTML).not.toContain('hooks.slack.com/services');
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /m/default_search/search/saved/meter_reader_alert_relay',
      'GET /notification-targets',
    ]);
  });

  it('Connect asks first, names both objects, then creates exactly those two', async () => {
    setup([TARGET_EP]);
    await waitFor(() => expect(screen.getByTestId('endpoint-0-relay').getAttribute('data-relay')).toBe('missing'));
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('endpoint-0-relay')).getByRole('button', { name: 'Connect' }));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Connect ops-slack to Meter Reader?');
    expect(dialog.textContent).toContain('meter_reader_alert_relay');
    expect(dialog.textContent).toContain('meter_reader_relay_ops-slack');
    expect(requests.filter((r) => r.method === 'POST')).toEqual([]); // nothing written before the confirmation
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    });
    await waitFor(() => expect(screen.getByTestId('endpoint-0-relay').getAttribute('data-relay')).toBe('ready'));
    expect(requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /m/default_search/search/saved',
      'POST /m/default_search/search/saved/meter_reader_alert_relay/notifications',
    ]);
    expect(requests.find((r) => r.path.endsWith('/notifications'))?.body).toMatchObject({ id: 'meter_reader_relay_ops-slack', targets: ['ops-slack'] });
  });

  it('sends the test through the relay and shows what the target receives', async () => {
    routes['GET /m/default_search/search/saved/meter_reader_alert_relay'] = {
      status: 200,
      body: { items: [{ id: 'meter_reader_alert_relay', schedule: { notifications: { items: [{ id: 'meter_reader_relay_ops-slack' }] } } }], count: 1 },
    };
    setup([TARGET_EP]);
    await waitFor(() => expect(screen.getByTestId('endpoint-0-relay').getAttribute('data-relay')).toBe('ready'));
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('endpoint-0-test')).getByRole('button'));
    });
    await waitFor(() => expect(screen.getByTestId('endpoint-0-result').textContent).toContain('Handed to Cribl for ops-slack (200)'));
    const forward = requests.find((r) => r.path === '/search/notifications');
    expect(String((forward?.body as { id?: string } | undefined)?.id).startsWith('SEARCH_NOTIFICATION_meter_reader_relay_ops-slack_')).toBe(true);
    expect(screen.getByText('What the target receives')).toBeTruthy();
  });

  it('reads unconfirmed until a member says a test arrived, then keeps the confirmation for that target (craft r2)', async () => {
    routes['GET /m/default_search/search/saved/meter_reader_alert_relay'] = {
      status: 200,
      body: { items: [{ id: 'meter_reader_alert_relay', schedule: { notifications: { items: [{ id: 'meter_reader_relay_ops-slack' }] } } }], count: 1 },
    };
    const { writes } = setup([TARGET_EP]);
    await waitFor(() => expect(screen.getByTestId('endpoint-0-relay').getAttribute('data-relay')).toBe('ready'));
    // a 200 from the relay is not proof it arrived: the target says so until a member confirms
    expect(screen.getByTestId('endpoint-0-confirmed').getAttribute('data-confirmed')).toBe('false');
    expect(screen.getByTestId('endpoint-0-confirmed').textContent).toBe('Unconfirmed: send a test and say whether it arrived.');
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('endpoint-0-test')).getByRole('button'));
    });
    await waitFor(() => expect(screen.getByTestId('endpoint-0-result').textContent).toContain('Handed to Cribl for ops-slack (200)'));
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('endpoint-0-arrive')).getByRole('button', { name: 'It arrived' }));
    });
    expect(screen.getByTestId('endpoint-0-confirmed').getAttribute('data-confirmed')).toBe('true');
    expect(screen.getByTestId('endpoint-0-confirmed').textContent).toMatch(/^Arrival confirmed /);
    expect(within(screen.getByTestId('endpoint-0-arrive')).queryByRole('button', { name: 'It arrived' })).toBeNull();
    await save();
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    const ep = writes[writes.length - 1].notifications.find((e) => e.id === 'ep_target') as NotificationEndpoint & { confirmedAt?: string; confirmedTargetId?: string };
    expect(ep.confirmedTargetId).toBe('ops-slack');
    expect(Number.isFinite(Date.parse(ep.confirmedAt ?? ''))).toBe(true);
  });

  it('falls back to typing the target id when the listing is refused', async () => {
    routes['GET /notification-targets'] = { status: 403, body: { status: 'error', message: 'Forbidden' } };
    setup([TARGET_EP]);
    await act(async () => {
      fireEvent.click(within(await screen.findByTestId('endpoint-0-targets')).getByRole('button', { name: 'Load targets' }));
    });
    await waitFor(() => expect(screen.getByText("Couldn't list notification targets (403). Type the target id instead.")).toBeTruthy());
    const field = within(screen.getByTestId('endpoint-0-target')).getByRole('textbox') as HTMLInputElement;
    expect(field.value).toBe('ops-slack');
  });

  it('starts a new endpoint as a Cribl target, requires a target, and stores only its id', async () => {
    routes['GET /notification-targets'] = { status: 403, body: { status: 'error', message: 'Forbidden' } };
    const { writes } = setup();
    await screen.findByTestId('endpoint-bell');
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Add endpoint' })[0]);
    });
    // On the front-end runtime a new endpoint starts as a Cribl notification target (EPIC_AUDIT P0-10).
    const ep = await screen.findByTestId('endpoint-0');
    expect(ep.getAttribute('data-channel')).toBe('cribl-target');
    expect(screen.queryByTestId('endpoint-0-url')).toBeNull();
    fireEvent.change(within(screen.getByTestId('endpoint-0')).getByLabelText('Name'), { target: { value: 'Pager' } });
    // No error before the field is left or Save is pressed (EPIC_AUDIT P1-G05); Save shows it and writes nothing.
    expect(screen.queryByText("Couldn't save: choose a Cribl notification target.")).toBeNull();
    await save();
    await waitFor(() => expect(screen.getByText("Couldn't save: choose a Cribl notification target.")).toBeTruthy());
    expect(writes).toHaveLength(0);
    const idField = within(screen.getByTestId('endpoint-0-target')).getByRole('textbox');
    fireEvent.change(idField, { target: { value: 'pd-oncall' } });
    await save();
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].notifications).toEqual([
      expect.objectContaining({ name: 'Pager', channel: 'cribl-target', criblTargetId: 'pd-oncall', url: '', host: '', weeklyReceipt: true }),
    ]);
  });
});

const WEBHOOK_EP: NotificationEndpoint = {
  id: 'ep_hook',
  name: 'Ops Slack',
  url: SLACK_SECRET,
  host: 'hooks.slack.com',
  format: 'slack',
  minSeverity: 'medium',
  weeklyReceipt: true,
  enabled: true,
};

describe('Where to send alerts — no direct webhook in the App (D57, hackathon rule 4.5)', () => {
  it('a stored direct webhook (an older build) is never shown, offered or re-saved, and its URL never reaches the page', async () => {
    const { writes } = setup([WEBHOOK_EP, TARGET_EP]);
    await screen.findByTestId('endpoint-bell');
    // Only the Cribl target is an endpoint card; nothing offers "Direct webhook".
    expect(screen.getByTestId('endpoint-0').getAttribute('data-channel')).toBe('cribl-target');
    expect(screen.queryByTestId('endpoint-1')).toBeNull();
    expect(document.body.textContent).not.toContain('Direct webhook ·');
    expect(document.body.textContent).not.toContain(SLACK_SECRET);
    expect(document.body.textContent).not.toContain('hooks.slack.com');
    expect(screen.getByTestId('runner-webhooks').textContent).toContain('Meter Reader stores no webhook URL');
    // A save writes the Cribl channels only.
    fireEvent.change(within(screen.getByTestId('endpoint-0')).getByLabelText('Name'), { target: { value: 'Renamed' } });
    await save();
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].notifications.map((e) => e.id)).toEqual(['ep_target']);
    expect(JSON.stringify(writes[0])).not.toContain('SECRETSECRET');
  });

  it("names the runner's .env webhooks from meta: name and host, never a URL", async () => {
    const { store } = setup();
    await screen.findByTestId('endpoint-bell');
    act(() => {
      store.setState({ meta: { deliveryWebhooks: [{ id: 'demo-webhook-site', name: 'Demo receiver (webhook.site)', host: 'webhook.site', format: 'slack' }] } as never });
    });
    await waitFor(() => expect(screen.getAllByTestId('runner-webhook').map((li) => li.textContent)).toEqual(['Demo receiver (webhook.site) · webhook.site']));
    expect(screen.getByTestId('runner-webhooks').textContent).toContain('The runner also sends alerts to these direct webhooks');
  });
});

describe('Where to send alerts — Send the last 7 days now', () => {
  it('sends on press and reports each endpoint exactly', async () => {
    const outcome: WeeklyOutcome = {
      sent: 1,
      endpoints: 2,
      calls: 7,
      deliveries: [
        { endpointId: 'ep_hook', event: 'receipt.weekly', status: 0, attempt: 1, at: NOW_ISO, kind: 'notify' },
        { endpointId: 'ep_hook', event: 'receipt.weekly', status: 403, attempt: 2, at: NOW_ISO, kind: 'notify' },
        { endpointId: 'cribl-bell', event: 'receipt.weekly', status: 200, attempt: 1, at: NOW_ISO, kind: 'notify' },
      ],
    };
    const { runWeekly } = setup([{ ...TARGET_EP, id: 'ep_hook', name: 'Ops Slack', weeklyReceipt: true }], outcome);
    const block = await screen.findByTestId('weekly-receipt');
    expect(block.textContent).toContain('automatically the first time the App meters after Monday 12:00 UTC, any day that week (marked late after the first 24 hours)');
    expect(runWeekly).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(block).getByRole('button', { name: 'Send the last 7 days now' }));
    });
    await waitFor(() => expect(screen.getByTestId('weekly-result').getAttribute('data-tone')).toBe('warn'));
    expect(runWeekly).toHaveBeenCalledWith('manual', 'ui');
    const result = screen.getByTestId('weekly-result');
    expect(result.textContent).toContain('Sent to 1 of 2 endpoints.');
    expect(result.textContent).toContain('Ops Slack: failed (403)');
    expect(result.textContent).toContain('Cribl notifications: sent (200)');
    expect(result.textContent).not.toContain('Enterprise plan');
  });

  it('says plainly when no endpoint has the weekly receipt on', async () => {
    setup();
    const block = await screen.findByTestId('weekly-receipt');
    await act(async () => {
      fireEvent.click(within(block).getByRole('button', { name: 'Send the last 7 days now' }));
    });
    await waitFor(() =>
      expect(screen.getByTestId('weekly-result').textContent).toContain('No enabled endpoint has Weekly receipt on. Turn it on for an endpoint above and save, then send.'),
    );
  });
});
