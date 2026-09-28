// tests/unit/cribl-notify.test.ts — core/adapters/cribl-notify.ts against the measured Leader behaviour
// (docs/NOTIFICATIONS.md §2): bell ids are write-once (409), the relay routes only
// `SEARCH_NOTIFICATION_<notificationId>_…` ids, target listings are reduced to id/type/description.

import { describe, expect, it } from 'vitest';
import type { CriblHttp, HttpResult } from '../../core/types.ts';
import { BudgetExceeded, RateLimited } from '../../core/http.ts';
import {
  BELL_PATH,
  BELL_SEVERITY,
  RELAY_SAVED_SEARCH_ID,
  SAVED_SEARCHES_PATH,
  SEARCH_NOTIFICATION_ID_PREFIX,
  SEARCH_NOTIFY_PATH,
  TARGETS_PATH,
  classifyCribl,
  ensureRelay,
  errorMessage,
  forwardBody,
  forwardViaTarget,
  listTargets,
  pickableTargets,
  postBell,
  relayEventId,
  relayNotificationBody,
  relayNotificationId,
  relayNotificationsPath,
  relaySavedSearchBody,
  relayState,
  savedSearchPath,
} from '../../core/adapters/cribl-notify.ts';

type Answer = HttpResult | Error | ((body: unknown) => HttpResult);
interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** A CriblHttp answering `METHOD path` from a table (a queue per route); unknown routes answer 404. */
function fakeHttp(routes: Record<string, Answer | Answer[]>): CriblHttp & { calls: Call[] } {
  const calls: Call[] = [];
  const queues = new Map<string, Answer[]>(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  return {
    calls,
    async request(method, path, body) {
      calls.push(body === undefined ? { method, path } : { method, path, body });
      const q = queues.get(`${method} ${path}`);
      const a = q && q.length > 1 ? q.shift() : q?.[0];
      if (a === undefined) return { status: 404, ok: false, json: { status: 'error', message: 'Not Found' } };
      if (a instanceof Error) throw a;
      return typeof a === 'function' ? a(body) : a;
    },
  };
}
const ok = (json: unknown = { items: [], count: 0 }, status = 200): HttpResult => ({ status, ok: true, json });
const err = (status: number, message: string): HttpResult => ({ status, ok: false, json: { status: 'error', message } });

const MSG = { id: 'meter-reader-inc_7f3a-high', severity: 'error' as const, title: 'Savings dropped: Payments API sampling', text: '$25 a day', time: 1_790_410_000_000 };

describe('classifyCribl', () => {
  it('maps every Leader answer to an outcome and a retry decision', () => {
    expect(classifyCribl(ok())).toEqual({ status: 200, ok: true, retry: false });
    expect(classifyCribl(ok(undefined, 201))).toEqual({ status: 201, ok: true, retry: false });
    expect(classifyCribl(err(409, 'exists'), true)).toEqual({ status: 409, ok: true, retry: false, detail: 'already exists' });
    expect(classifyCribl(err(409, 'exists'))).toMatchObject({ ok: false, error: 'http_409', retry: false });
    expect(classifyCribl(err(403, 'forbidden'))).toMatchObject({ ok: false, error: 'not_permitted', retry: false, detail: 'forbidden' });
    expect(classifyCribl(err(401, 'no'))).toMatchObject({ error: 'not_permitted' });
    expect(classifyCribl(err(404, 'Not Found'))).toMatchObject({ error: 'not_available' });
    expect(classifyCribl(err(405, 'Updating messages is not supported.'))).toMatchObject({ error: 'not_available' });
    expect(classifyCribl(err(400, 'bad'))).toMatchObject({ error: 'invalid_request', retry: false });
    expect(classifyCribl(err(429, 'slow down'))).toMatchObject({ error: 'rate_limited', retry: false });
    expect(classifyCribl(err(503, 'down'))).toMatchObject({ error: 'http_503', retry: true });
    expect(classifyCribl({ status: 0, ok: false, text: 'timeout: no response' })).toMatchObject({ status: 0, error: 'network_error', retry: true, detail: 'timeout: no response' });
    expect(classifyCribl({ status: 0, ok: false, thrown: 'budget', message: 'Leader API budget' })).toEqual({ status: 0, ok: false, error: 'budget', retry: false, detail: 'Leader API budget' });
  });

  it('clips long error messages and reads text bodies', () => {
    expect(errorMessage({ status: 500, ok: false, text: 'x'.repeat(400) })?.length).toBe(160);
    expect(errorMessage({ status: 500, ok: false, text: 'plain\n  text' })).toBe('plain text');
    expect(errorMessage({ status: 500, ok: false })).toBeUndefined();
  });
});

describe('postBell', () => {
  it('posts the BulletinMessage to /system/messages', async () => {
    const http = fakeHttp({ [`POST ${BELL_PATH}`]: ok({ items: [MSG], count: 1 }) });
    expect(await postBell(http, MSG)).toEqual({ status: 200, ok: true, retry: false });
    expect(http.calls).toEqual([{ method: 'POST', path: '/system/messages', body: MSG }]);
  });

  it('reads 409 (id already exists; ids are write-once) as already in the bell', async () => {
    const http = fakeHttp({ [`POST ${BELL_PATH}`]: err(409, 'Entity with "x" ID already exists.') });
    expect(await postBell(http, MSG)).toEqual({ status: 409, ok: true, retry: false, detail: 'already in the bell' });
  });

  it('never throws: budget, rate limit and transport errors become outcomes', async () => {
    const budget = fakeHttp({ [`POST ${BELL_PATH}`]: new BudgetExceeded(35, 35, 'POST', BELL_PATH) });
    expect(await postBell(budget, MSG)).toMatchObject({ status: 0, ok: false, error: 'budget', retry: false });
    const limited = fakeHttp({ [`POST ${BELL_PATH}`]: new RateLimited('POST', BELL_PATH) });
    expect(await postBell(limited, MSG)).toMatchObject({ ok: false, error: 'rate_limited', retry: false });
    const broken = fakeHttp({ [`POST ${BELL_PATH}`]: new Error('socket hang up') });
    expect(await postBell(broken, MSG)).toMatchObject({ ok: false, error: 'network_error', retry: true, detail: 'socket hang up' });
    const thrownString = fakeHttp({ [`POST ${BELL_PATH}`]: (() => { throw 'boom'; }) as unknown as Answer });
    expect(await postBell(thrownString, MSG)).toMatchObject({ ok: false, error: 'network_error' });
  });

  it('maps severities high→error, medium→warn, info→info (never the refused `success`)', () => {
    expect(BELL_SEVERITY).toEqual({ high: 'error', medium: 'warn', info: 'info' });
  });
});

describe('listTargets', () => {
  it('keeps only id, type and description — never a URL or secret the Leader returns', async () => {
    const http = fakeHttp({
      [`GET ${TARGETS_PATH}`]: ok({
        items: [
          { id: 'system_notifications', type: 'bulletin_message', severity: 'warn', title: 'Notification' },
          { id: 'ops-slack', type: 'slack', url: 'https://hooks.slack.com/services/T/B/SECRET', description: '  Ops channel  ' },
          { id: 'pd', type: 'pagerduty', routingKey: 'r-key', description: '' },
          { id: '', type: 'webhook' },
          { type: 'webhook' },
          { id: 'odd' },
        ],
        count: 6,
      }),
    });
    const r = await listTargets(http);
    expect(r).toEqual({
      ok: true,
      status: 200,
      targets: [
        { id: 'system_notifications', type: 'bulletin_message' },
        { id: 'ops-slack', type: 'slack', description: 'Ops channel' },
        { id: 'pd', type: 'pagerduty' },
        { id: 'odd', type: 'unknown' },
      ],
    });
    expect(JSON.stringify(r)).not.toMatch(/SECRET|r-key|hooks\.slack/);
    if (r.ok) expect(pickableTargets(r.targets).map((t) => t.id)).toEqual(['ops-slack', 'pd', 'odd']);
  });

  it('reports a refused or missing listing, and tolerates a body without items', async () => {
    expect(await listTargets(fakeHttp({ [`GET ${TARGETS_PATH}`]: err(403, 'forbidden') }))).toEqual({ ok: false, status: 403, error: 'not_permitted', detail: 'forbidden' });
    expect(await listTargets(fakeHttp({}))).toMatchObject({ ok: false, status: 404, error: 'not_available' });
    expect(await listTargets(fakeHttp({ [`GET ${TARGETS_PATH}`]: ok({}) }))).toEqual({ ok: true, status: 200, targets: [] });
    expect(await listTargets(fakeHttp({ [`GET ${TARGETS_PATH}`]: new Error('offline') }))).toMatchObject({ ok: false, status: 0, error: 'network_error' });
  });
});

describe('relay ids and bodies', () => {
  it('derives stable, safe ids', () => {
    expect(relayNotificationId('ops-slack')).toBe('meter_reader_relay_ops-slack');
    expect(relayNotificationId('team.alerts/pd')).toBe('meter_reader_relay_team_alerts_pd');
    expect(relayEventId('meter_reader_relay_ops-slack', 'inc_7f3a_incident.opened_1790')).toBe('SEARCH_NOTIFICATION_meter_reader_relay_ops-slack_inc_7f3a_incident.opened_1790');
    expect(relayEventId('n', 'a b/c')).toBe(`${SEARCH_NOTIFICATION_ID_PREFIX}n_a_b_c`);
    expect(savedSearchPath()).toBe('/m/default_search/search/saved/meter_reader_alert_relay');
    expect(relayNotificationsPath()).toBe('/m/default_search/search/saved/meter_reader_alert_relay/notifications');
  });

  it('builds a never-scheduled saved search and the measured notification config', () => {
    expect(relaySavedSearchBody()).toMatchObject({ id: RELAY_SAVED_SEARCH_ID, schedule: { enabled: false }, query: 'print relay="meter-reader"' });
    expect(relayNotificationBody('ops-slack')).toEqual({
      id: 'meter_reader_relay_ops-slack',
      condition: 'search',
      conf: { savedQueryId: RELAY_SAVED_SEARCH_ID, message: 'Meter Reader alert', triggerType: 'resultsCount', triggerComparator: '>', triggerCount: 0 },
      targets: ['ops-slack'],
    });
  });

  it('forwards with the routed id prefix, the rendered text as message and _raw, and the payload riding along', () => {
    const body = forwardBody({ targetId: 'ops-slack', suffix: 's1', title: 'T', severity: 'medium', message: 'line 1\nline 2', now: 1000, payload: { schemaVersion: 1, app: 'meter-reader', event: 'test', sentAt: 'x', workspace: 'w' } });
    expect(body).toEqual({
      id: 'SEARCH_NOTIFICATION_meter_reader_relay_ops-slack_s1',
      notificationId: 'meter_reader_relay_ops-slack',
      savedQueryId: RELAY_SAVED_SEARCH_ID,
      group: 'default_search',
      title: 'T',
      severity: 'warn',
      message: 'line 1\nline 2',
      _raw: 'line 1\nline 2',
      now: 1000,
      _time: 1000,
      meter_reader: { schemaVersion: 1, app: 'meter-reader', event: 'test', sentAt: 'x', workspace: 'w' },
    });
    expect(forwardBody({ targetId: 'x', suffix: 's', title: 'T', severity: 'info', message: 'm', now: 1 })).not.toHaveProperty('meter_reader');
  });
});

describe('relayState', () => {
  const saved = (notificationIds: string[]) =>
    ok({ items: [{ id: RELAY_SAVED_SEARCH_ID, schedule: { enabled: false, notifications: { items: notificationIds.map((id) => ({ id })) } } }], count: 1 });

  it('is ready when the saved search carries this target’s notification', async () => {
    const http = fakeHttp({ [`GET ${savedSearchPath()}`]: saved(['meter_reader_relay_ops-slack']) });
    expect(await relayState(http, 'ops-slack')).toEqual({ state: 'ready', notificationId: 'meter_reader_relay_ops-slack' });
  });

  it('is missing without the saved search (404) or without the notification', async () => {
    expect(await relayState(fakeHttp({}), 'ops-slack')).toEqual({ state: 'missing', savedSearch: false, notification: false });
    expect(await relayState(fakeHttp({ [`GET ${savedSearchPath()}`]: saved(['meter_reader_relay_other']) }), 'ops-slack')).toEqual({ state: 'missing', savedSearch: true, notification: false });
    expect(await relayState(fakeHttp({ [`GET ${savedSearchPath()}`]: ok({ items: [{ id: RELAY_SAVED_SEARCH_ID }] }) }), 'x')).toEqual({ state: 'missing', savedSearch: true, notification: false });
  });

  it('reports a refused read as an error', async () => {
    expect(await relayState(fakeHttp({ [`GET ${savedSearchPath()}`]: err(403, 'forbidden') }), 'x')).toEqual({ state: 'error', status: 403, error: 'not_permitted', detail: 'forbidden' });
    expect(await relayState(fakeHttp({ [`GET ${savedSearchPath()}`]: new RateLimited('GET', 'x') }), 'x')).toMatchObject({ state: 'error', status: 0, error: 'rate_limited' });
  });
});

describe('ensureRelay (configuration writes: create-only, never replace or delete)', () => {
  it('creates the saved search and the notification when both are missing', async () => {
    const http = fakeHttp({
      [`POST ${SAVED_SEARCHES_PATH}`]: ok({ items: [{ id: RELAY_SAVED_SEARCH_ID }] }),
      [`POST ${relayNotificationsPath()}`]: ok({ items: [{ id: 'meter_reader_relay_ops-slack' }] }, 201),
    });
    const r = await ensureRelay(http, 'ops-slack');
    expect(r).toEqual({ ok: true, status: 201, created: ['saved search meter_reader_alert_relay', 'notification meter_reader_relay_ops-slack'] });
    expect(http.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /m/default_search/search/saved/meter_reader_alert_relay',
      'POST /m/default_search/search/saved',
      'POST /m/default_search/search/saved/meter_reader_alert_relay/notifications',
    ]);
    expect(http.calls[1].body).toEqual(relaySavedSearchBody());
    expect(http.calls[2].body).toEqual(relayNotificationBody('ops-slack'));
    expect(http.calls.some((c) => c.method === 'PUT' || c.method === 'PATCH' || c.method === 'DELETE')).toBe(false);
  });

  it('adds only the notification when the saved search exists; does nothing when ready', async () => {
    const withSearch = fakeHttp({
      [`GET ${savedSearchPath()}`]: ok({ items: [{ id: RELAY_SAVED_SEARCH_ID, schedule: { notifications: { items: [] } } }] }),
      [`POST ${relayNotificationsPath()}`]: ok({}, 201),
    });
    expect(await ensureRelay(withSearch, 'pd')).toEqual({ ok: true, status: 201, created: ['notification meter_reader_relay_pd'] });
    const ready = fakeHttp({ [`GET ${savedSearchPath()}`]: ok({ items: [{ schedule: { notifications: { items: [{ id: 'meter_reader_relay_pd' }] } } }] }) });
    expect(await ensureRelay(ready, 'pd')).toEqual({ ok: true, status: 200, created: [] });
    expect(ready.calls).toHaveLength(1);
  });

  it('treats a 409 (created meanwhile) as present and reports failures with what it already created', async () => {
    const raced = fakeHttp({ [`POST ${SAVED_SEARCHES_PATH}`]: err(409, 'exists'), [`POST ${relayNotificationsPath()}`]: err(409, 'exists') });
    expect(await ensureRelay(raced, 'pd')).toEqual({ ok: true, status: 409, created: [] });
    const refused = fakeHttp({ [`POST ${SAVED_SEARCHES_PATH}`]: err(403, 'forbidden') });
    expect(await ensureRelay(refused, 'pd')).toEqual({ ok: false, status: 403, created: [], error: 'not_permitted', detail: 'forbidden' });
    const half = fakeHttp({ [`POST ${SAVED_SEARCHES_PATH}`]: ok(), [`POST ${relayNotificationsPath()}`]: err(400, 'bad target') });
    expect(await ensureRelay(half, 'pd')).toEqual({ ok: false, status: 400, created: ['saved search meter_reader_alert_relay'], error: 'invalid_request', detail: 'bad target' });
    const unreadable = fakeHttp({ [`GET ${savedSearchPath()}`]: err(500, 'boom') });
    expect(await ensureRelay(unreadable, 'pd')).toEqual({ ok: false, status: 500, created: [], error: 'http_500', detail: 'boom' });
    expect(await ensureRelay(fakeHttp({}), '')).toEqual({ ok: false, status: 0, created: [], error: 'target_missing' });
  });
});

describe('forwardViaTarget', () => {
  const m = { targetId: 'ops-slack', suffix: 'inc_1_incident.opened_5', title: 'T', severity: 'high' as const, message: 'm', now: 5 };

  it('posts the SearchNotification to the Leader-level path; 200 = accepted by the notification service', async () => {
    const http = fakeHttp({ [`POST ${SEARCH_NOTIFY_PATH}`]: ok({ items: [{ message: 'Search notification request forwarded.' }], count: 1 }) });
    expect(await forwardViaTarget(http, m)).toEqual({ status: 200, ok: true, retry: false });
    expect(http.calls[0].path).toBe('/search/notifications');
    expect((http.calls[0].body as { id: string }).id).toBe('SEARCH_NOTIFICATION_meter_reader_relay_ops-slack_inc_1_incident.opened_5');
  });

  it('reads 500 "Failed to process" as a missing relay, and never retries (no de-duplication upstream)', async () => {
    expect(await forwardViaTarget(fakeHttp({ [`POST ${SEARCH_NOTIFY_PATH}`]: err(500, 'Failed to process search notification.') }), m)).toEqual({
      status: 500,
      ok: false,
      error: 'relay_missing',
      retry: false,
      detail: 'Failed to process search notification.',
    });
    expect(await forwardViaTarget(fakeHttp({ [`POST ${SEARCH_NOTIFY_PATH}`]: new Error('reset') }), m)).toMatchObject({ status: 0, error: 'network_error', retry: false });
    expect(await forwardViaTarget(fakeHttp({ [`POST ${SEARCH_NOTIFY_PATH}`]: err(403, 'no') }), m)).toMatchObject({ error: 'not_permitted', retry: false });
  });
});
