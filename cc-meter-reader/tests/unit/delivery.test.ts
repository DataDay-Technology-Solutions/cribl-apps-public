// tests/unit/delivery.test.ts — core/delivery.ts: channel resolution (the bell is on by default), rendering,
// the router for each channel, the Settings test, and the sweep delivering through Cribl end to end.

import { describe, expect, it } from 'vitest';
import type { CanonicalPayload, CriblHttp, HttpResult, Incident, NotificationEndpoint, WeeklyReceipt } from '../../core/types.ts';
import {
  BELL_ALREADY_STATUS,
  BELL_ENDPOINT_ID,
  CHANNELS,
  bellMessageId,
  channelOf,
  createDeliveryRouter,
  defaultBellEndpoint,
  renderAlert,
  resolveEndpoints,
  sendChannelTest,
  wantsWeeklyReceipt,
  type DeliveryDeps,
  type ResolvedEndpoint,
} from '../../core/delivery.ts';
import { RELAY_SAVED_SEARCH_ID, relayNotificationId } from '../../core/adapters/cribl-notify.ts';
import { canonicalPayload, testPayload } from '../../core/payloads.ts';
import { breakTrim } from '../../core/demo/levers.ts';
import { SINK_ENDPOINT, createWorld } from '../integration/harness.ts';
import { defaultSettings, migrateSettings, validateSettings } from '../../core/settings.ts';
import {
  applyEndpoints,
  bellDirty,
  bellFromSettings,
  bellToEndpoint,
  describeCriblTest,
  draftFromEndpoint,
  draftToEndpoint,
  draftsFromSettings,
  newEndpointDraft,
  sendCriblTest,
  testTargetText,
} from '../../src/components/EndpointEditor/model.ts';

const T0 = Date.parse('2026-09-30T16:44:03Z');
const NOW_ISO = new Date(T0).toISOString();
const LINK = 'https://main-org.cribl.cloud/apps/a/meter-reader';

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'inc_7f3a',
    type: 'regression',
    severity: 'high',
    objectKey: 'pipe:default:mrd_pay_sample',
    label: 'Payments API sampling',
    outputId: 'mrd_siem_prod',
    openedAt: '2026-09-30T16:42:03.000Z',
    cause: 'commit',
    commit: { hash: 'a1f3c9e0', message: 'demo: break the trim', author: 's.koelpin', committedAt: '2026-09-30T16:39:12.000Z', groupId: 'default', match: 'files' },
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    caughtInSec: 171,
    notes: [],
    deliveries: [],
    ...over,
  };
}
const canonical = (event: CanonicalPayload['event'], over: Partial<Incident> = {}): CanonicalPayload =>
  canonicalPayload(event, { incident: incident(over), workspace: 'main-org', linkBase: LINK, sentAt: NOW_ISO });

const RECEIPT: WeeklyReceipt = {
  periodStart: '2026-09-21T00:00:00.000Z',
  periodEnd: '2026-09-28T00:00:00.000Z',
  label: 'Sep 21–27, 2026',
  lines: [{ label: 'Windows event trimming', savedM: 938_000_000 }],
  savedM: 2_380_700_000,
  whpM: 3_967_800_000,
  paidM: 1_587_100_000,
  ratio: 0.6,
  openIncidents: [],
};

type Answer = HttpResult | ((body: unknown) => HttpResult);
/** A CriblHttp answering `METHOD path` from a table (a queue per route, the last answer sticks); else 404. */
function fakeHttp(routes: Record<string, Answer | Answer[]>): CriblHttp & { calls: { method: string; path: string; body?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  return {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body });
      const q = queues.get(`${method} ${path}`);
      const a = q && q.length > 1 ? q.shift() : q?.[0];
      if (a === undefined) return { status: 404, ok: false, json: { message: 'Not Found' } };
      return typeof a === 'function' ? a(body) : a;
    },
  };
}
const ok = (json: unknown = {}, status = 200): HttpResult => ({ status, ok: true, json });
const err = (status: number, message = 'no'): HttpResult => ({ status, ok: false, json: { status: 'error', message } });
const RELAY_READY = ok({ items: [{ id: RELAY_SAVED_SEARCH_ID, schedule: { notifications: { items: [{ id: relayNotificationId('ops-slack') }] } } }] });
const SAVED = `GET /m/default_search/search/saved/${RELAY_SAVED_SEARCH_ID}`;

function deps(http: CriblHttp, posts: { url: string; body: string }[] = [], webhookStatus = 200): DeliveryDeps & { sleeps: number[] } {
  let now = T0;
  const sleeps: number[] = [];
  return {
    http,
    webhook: {
      async post(url, body) {
        posts.push({ url, body });
        return { status: webhookStatus };
      },
    },
    clock: { now: () => now },
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

const BELL: NotificationEndpoint = { ...defaultBellEndpoint() };
const TARGET: NotificationEndpoint = { ...defaultBellEndpoint(), id: 'ep_target', name: 'Ops Slack via Cribl', channel: 'cribl-target', criblTargetId: 'ops-slack' };

// ─── Channels ────────────────────────────────────────────────────────────────
describe('channels', () => {
  it('reads a missing or unknown channel as a direct webhook', () => {
    expect(CHANNELS).toEqual(['cribl-bell', 'cribl-target', 'webhook']);
    expect(channelOf(SINK_ENDPOINT)).toBe('webhook');
    expect(channelOf({ channel: 'webhook' })).toBe('webhook');
    expect(channelOf({ channel: 'cribl-bell' })).toBe('cribl-bell');
    expect(channelOf({ channel: 'cribl-target' })).toBe('cribl-target');
    expect(channelOf({ channel: 'pigeon' as never })).toBe('webhook');
  });

  it('turns the bell on by default, last, unless a bell endpoint is stored', () => {
    expect(resolveEndpoints(undefined)).toEqual([{ ...defaultBellEndpoint(), implicit: true }]);
    const list = resolveEndpoints([SINK_ENDPOINT]);
    expect(list.map((e) => e.id)).toEqual(['ep_sink', BELL_ENDPOINT_ID]);
    expect(list[1]).toMatchObject({ channel: 'cribl-bell', enabled: true, minSeverity: 'medium', implicit: true, url: '' });
    const off = { ...defaultBellEndpoint(), enabled: false };
    expect(resolveEndpoints([off, SINK_ENDPOINT])).toEqual([off, SINK_ENDPOINT]);
  });

  it('every channel honours its own weeklyReceipt, on unless explicitly false; the bell takes it by default (NOTIFY-3a issue 4)', () => {
    expect(defaultBellEndpoint().weeklyReceipt).toBe(true);
    expect(wantsWeeklyReceipt(defaultBellEndpoint())).toBe(true);
    expect(wantsWeeklyReceipt({ ...defaultBellEndpoint(), enabled: false })).toBe(false);
    expect(wantsWeeklyReceipt({ ...defaultBellEndpoint(), weeklyReceipt: false })).toBe(false);
    const target: NotificationEndpoint = { ...SINK_ENDPOINT, id: 't', url: '', host: '', channel: 'cribl-target', criblTargetId: 'ops' };
    expect(wantsWeeklyReceipt(target)).toBe(true);
    expect(wantsWeeklyReceipt({ ...target, weeklyReceipt: undefined as unknown as boolean })).toBe(true);
    expect(wantsWeeklyReceipt({ ...target, weeklyReceipt: false })).toBe(false);
    expect(wantsWeeklyReceipt(SINK_ENDPOINT)).toBe(true);
    expect(wantsWeeklyReceipt({ ...SINK_ENDPOINT, weeklyReceipt: false })).toBe(false);
  });
});

// ─── Rendering ───────────────────────────────────────────────────────────────
describe('renderAlert and bell ids', () => {
  it('renders an opened regression: title, one money + commit line, a plain-text body with the link', () => {
    const r = renderAlert(canonical('incident.opened'));
    expect(r.title).toBe('Savings dropped: Payments API sampling');
    // The bell names its sender at the end of the line, as Slack's context line does (CREDIT_STRINGS.signature).
    expect(r.line).toBe('$25 a day · $9,125 a year if left · commit a1f3c9e by s.koelpin · Meter Reader by Steve Koelpin');
    expect(r.text.split('\n').at(-1)).toBe('Meter Reader by Steve Koelpin');
    expect(r.severity).toBe('high');
    expect(r.text.split('\n')[0]).toBe(r.title);
    expect(r.text).toContain('Savings ratio 75% → 50%');
    expect(r.text).toContain(`Open in Ledger: ${LINK}/ledger?object=pipe:default:mrd_pay_sample`);
  });

  it('marks recoveries, tests, nearby commits, no commit, good news and budgets', () => {
    const closed = renderAlert(canonical('incident.closed', { closedAt: '2026-09-30T17:00:00.000Z' }));
    expect(closed.title).toBe('Recovered: Savings dropped: Payments API sampling');
    expect(closed.severity).toBe('info');
    // D47: the bell's body keeps the drop and states where it recovered to.
    expect(renderAlert(canonical('incident.closed', { closedAt: '2026-09-30T17:00:00.000Z', recoveredTo: 0.89 })).text).toContain('Savings ratio 75% → 50% · recovered to 89%');
    expect(renderAlert(canonical('test')).title).toBe('Test: Savings dropped: Payments API sampling');
    expect(renderAlert(canonical('incident.opened', { commit: { hash: 'b2', message: 'm', author: 'a', committedAt: NOW_ISO, groupId: 'default', match: 'nearby' } })).line).toContain('commit b2 by a (nearby change)');
    expect(renderAlert(canonical('incident.opened', { commit: undefined, cause: 'unknown' })).line).toContain('no configuration change found nearby');
    // An API credential's client id reads 'API client' in the bell and target text (NOTIFY-3a issue 8).
    const api = renderAlert(canonical('incident.opened', { commit: { hash: 'c3d4e5f6', message: 'm', author: 'Zx9QvK3m@clients', committedAt: NOW_ISO, groupId: 'default', match: 'files' } }));
    expect(api.line).toContain('commit c3d4e5f by API client');
    expect(api.text).not.toContain('@clients');
    // Caught on catch-up says so in the bell line (REVIEW-3a #13); a recovery doesn't.
    const late = renderAlert(canonical('incident.opened', { notes: ['catch-up'], detectedAt: '2026-09-30T17:42:03.000Z' }));
    expect(late.line).toMatch(/ · caught on catch-up, (62:51|1:02:51) after the change · Meter Reader by Steve Koelpin$/);
    expect(late.text).toContain('Caught on catch-up');
    expect(renderAlert(canonical('incident.closed', { notes: ['catch-up'], closedAt: '2026-09-30T18:00:00.000Z' })).line).not.toContain('catch-up');
    const good = renderAlert(canonical('incident.opened', { type: 'goodnews', severity: 'info', before: 0.5, after: 0.75 }));
    expect(good.severity).toBe('info');
    expect(good.title.startsWith('Recovered')).toBe(false);
    const budget = renderAlert(canonical('incident.opened', { type: 'budget', severity: 'medium', before: 90, after: 104, commit: undefined, objectKey: 'out:default:mrd_siem_prod' }));
    expect(budget.line).toMatch(/a day over budget · Meter Reader by Steve Koelpin$/);
    expect(budget.severity).toBe('medium');
  });

  it('renders the weekly receipt and a payload with no incident', () => {
    const r = renderAlert(canonicalPayload('receipt.weekly', { receipt: RECEIPT, workspace: 'w', linkBase: LINK, sentAt: NOW_ISO }));
    expect(r.title).toBe('Weekly receipt · Sep 21–27, 2026');
    expect(r.line).toBe('Saved by Cribl $23,807 · would have paid $39,678 · paid $15,871 · 60% saved · Meter Reader by Steve Koelpin');
    expect(r.text).toContain('Windows event trimming');
    expect(r.severity).toBe('info');
    const bare: CanonicalPayload = { schemaVersion: 1, app: 'meter-reader', event: 'test', sentAt: NOW_ISO, workspace: 'w' };
    expect(renderAlert(bare)).toEqual({ title: 'Meter Reader test notification', line: 'Meter Reader test notification', text: 'Meter Reader test notification', severity: 'info' });
    expect(renderAlert({ ...bare, event: 'incident.updated' }).title).toBe('Meter Reader incident.updated');
  });

  it('gives each alert STATE one bell id, so a cooldown re-send collides (409) instead of piling up', () => {
    expect(bellMessageId(canonical('incident.opened'))).toBe('meter-reader-inc_7f3a-high');
    expect(bellMessageId(canonical('incident.updated'))).toBe('meter-reader-inc_7f3a-high');
    expect(bellMessageId(canonical('incident.updated', { severity: 'medium' }))).toBe('meter-reader-inc_7f3a-medium');
    expect(bellMessageId(canonical('incident.closed', { closedAt: NOW_ISO }))).toBe('meter-reader-inc_7f3a-closed');
    expect(bellMessageId(canonical('test'))).toBe(`meter-reader-test-${T0}`);
    expect(bellMessageId(canonicalPayload('receipt.weekly', { receipt: RECEIPT, workspace: 'w', linkBase: '', sentAt: NOW_ISO }))).toBe('meter-reader-receipt-2026-09-21');
    expect(bellMessageId({ schemaVersion: 1, app: 'meter-reader', event: 'incident.updated', sentAt: 'not a date', workspace: 'w' })).toBe('meter-reader-incident-updated-0');
  });
});

// ─── Router: bell ────────────────────────────────────────────────────────────
describe('router — cribl-bell', () => {
  it('posts title, one-line text and mapped severity with the state id; one log entry', async () => {
    const http = fakeHttp({ 'POST /system/messages': ok({ items: [{}], count: 1 }) });
    const logs = await createDeliveryRouter(deps(http)).deliver({ endpoint: BELL, event: 'incident.opened', canonical: canonical('incident.opened'), incidentId: 'inc_7f3a' });
    expect(http.calls).toEqual([
      {
        method: 'POST',
        path: '/system/messages',
        body: { id: 'meter-reader-inc_7f3a-high', severity: 'error', title: 'Savings dropped: Payments API sampling', text: '$25 a day · $9,125 a year if left · commit a1f3c9e by s.koelpin · Meter Reader by Steve Koelpin', time: T0 },
      },
    ]);
    expect(logs).toEqual([{ endpointId: BELL_ENDPOINT_ID, event: 'incident.opened', incidentId: 'inc_7f3a', status: 200, attempt: 1, at: NOW_ISO, kind: 'notify' }]);
  });

  it('logs a 409 (same state already in the bell) as delivered, 208 with the reason', async () => {
    const http = fakeHttp({ 'POST /system/messages': err(409, 'Entity already exists.') });
    const [log] = await createDeliveryRouter(deps(http)).deliver({ endpoint: BELL, event: 'incident.updated', canonical: canonical('incident.updated') });
    expect(log).toMatchObject({ status: BELL_ALREADY_STATUS, detail: 'already in the bell (409)' });
    expect(log.error).toBeUndefined();
  });

  it('retries a 5xx with the webhook back-off (idempotent: the id is write-once), then stops on success', async () => {
    const http = fakeHttp({ 'POST /system/messages': [err(503), err(502), ok()] });
    const d = deps(http);
    const logs = await createDeliveryRouter(d).deliver({ endpoint: BELL, event: 'incident.opened', canonical: canonical('incident.opened') });
    expect(logs.map((l) => [l.attempt, l.status, l.error])).toEqual([
      [1, 503, 'http_503'],
      [2, 502, 'http_502'],
      [3, 200, undefined],
    ]);
    expect(d.sleeps).toEqual([2_000, 8_000]);
  });

  it('skips the implicit (default) bell quietly where the Leader has no bell API or refuses it, once per pass', async () => {
    const http = fakeHttp({});
    const router = createDeliveryRouter(deps(http));
    const implicit: ResolvedEndpoint = { ...BELL, implicit: true };
    expect(await router.deliver({ endpoint: implicit, event: 'incident.opened', canonical: canonical('incident.opened') })).toEqual([]);
    expect(await router.deliver({ endpoint: implicit, event: 'incident.opened', canonical: canonical('incident.opened', { id: 'inc_2' }) })).toEqual([]);
    expect(http.calls).toHaveLength(1);
    const refused = fakeHttp({ 'POST /system/messages': err(403, 'forbidden') });
    expect(await createDeliveryRouter(deps(refused)).deliver({ endpoint: implicit, event: 'incident.opened', canonical: canonical('incident.opened') })).toEqual([]);
  });

  it('reports the same refusal for a bell the member configured', async () => {
    const logs = await createDeliveryRouter(deps(fakeHttp({}))).deliver({ endpoint: BELL, event: 'incident.opened', canonical: canonical('incident.opened') });
    expect(logs).toEqual([expect.objectContaining({ status: 404, error: 'not_available', attempt: 1 })]);
  });
});

// ─── Router: target ──────────────────────────────────────────────────────────
describe('router — cribl-target', () => {
  it('checks the relay once per pass, then forwards the rendered text with the canonical payload', async () => {
    const http = fakeHttp({ [SAVED]: RELAY_READY, 'POST /search/notifications': ok({ items: [{ message: 'Search notification request forwarded.' }] }) });
    const router = createDeliveryRouter(deps(http));
    const first = await router.deliver({ endpoint: TARGET, event: 'incident.opened', canonical: canonical('incident.opened'), incidentId: 'inc_7f3a' });
    const second = await router.deliver({ endpoint: TARGET, event: 'incident.opened', canonical: canonical('incident.opened', { id: 'inc_8' }), incidentId: 'inc_8' });
    expect(first).toEqual([{ endpointId: 'ep_target', event: 'incident.opened', incidentId: 'inc_7f3a', status: 200, attempt: 1, at: NOW_ISO, kind: 'notify' }]);
    expect(second[0].status).toBe(200);
    expect(http.calls.map((c) => `${c.method} ${c.path}`)).toEqual([SAVED, 'POST /search/notifications', 'POST /search/notifications']);
    const body = http.calls[1].body as Record<string, unknown>;
    expect(body.id).toBe(`SEARCH_NOTIFICATION_meter_reader_relay_ops-slack_inc_7f3a_incident.opened_${T0}`);
    expect(body.notificationId).toBe('meter_reader_relay_ops-slack');
    expect(body.title).toBe('Savings dropped: Payments API sampling');
    expect(body.severity).toBe('error');
    expect(String(body.message)).toContain('Open in Ledger');
    expect((body.meter_reader as CanonicalPayload).incident?.id).toBe('inc_7f3a');
  });

  it('logs relay_missing (404) without forwarding — the Leader would accept and silently drop it', async () => {
    const http = fakeHttp({});
    const logs = await createDeliveryRouter(deps(http)).deliver({ endpoint: TARGET, event: 'incident.opened', canonical: canonical('incident.opened') });
    expect(logs).toEqual([expect.objectContaining({ status: 404, error: 'relay_missing', attempt: 1 })]);
    expect(http.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('logs a missing target id, an unreadable relay and a refused forward', async () => {
    const noTarget = await createDeliveryRouter(deps(fakeHttp({}))).deliver({ endpoint: { ...TARGET, criblTargetId: undefined }, event: 'test', canonical: canonical('test') });
    expect(noTarget).toEqual([expect.objectContaining({ status: 0, error: 'target_missing' })]);
    const unreadable = await createDeliveryRouter(deps(fakeHttp({ [SAVED]: err(403, 'forbidden') }))).deliver({ endpoint: TARGET, event: 'test', canonical: canonical('test') });
    expect(unreadable).toEqual([expect.objectContaining({ status: 403, error: 'not_permitted', detail: 'forbidden' })]);
    const unreadableNoDetail = await createDeliveryRouter(deps(fakeHttp({ [SAVED]: { status: 500, ok: false } }))).deliver({ endpoint: TARGET, event: 'test', canonical: canonical('test') });
    expect(unreadableNoDetail[0]).toMatchObject({ status: 500, error: 'http_500' });
    expect(unreadableNoDetail[0].detail).toBeUndefined();
    const refused = await createDeliveryRouter(deps(fakeHttp({ [SAVED]: RELAY_READY, 'POST /search/notifications': err(403, 'no') }))).deliver({ endpoint: TARGET, event: 'test', canonical: canonical('test') });
    expect(refused).toEqual([expect.objectContaining({ status: 403, error: 'not_permitted' })]);
  });
});

// ─── Router: webhook ─────────────────────────────────────────────────────────
describe('router — webhook', () => {
  it('posts the endpoint format through the webhook sender exactly as before', async () => {
    const posts: { url: string; body: string }[] = [];
    const slack: NotificationEndpoint = { ...SINK_ENDPOINT, format: 'slack', url: 'https://hooks.slack.com/services/T/B/X' };
    const logs = await createDeliveryRouter(deps(fakeHttp({}), posts)).deliver({ endpoint: slack, event: 'incident.opened', canonical: canonical('incident.opened'), incidentId: 'inc_7f3a', tz: 'UTC', labels: {} });
    expect(logs).toEqual([{ endpointId: 'ep_sink', event: 'incident.opened', incidentId: 'inc_7f3a', status: 200, attempt: 1, at: NOW_ISO, kind: 'notify' }]);
    expect(posts[0].url).toBe('https://hooks.slack.com/services/T/B/X');
    expect(JSON.parse(posts[0].body).blocks.length).toBeGreaterThan(0);
  });

  it('keeps the SPEC 12.3 policy: 403 is host_not_authorized, not retried', async () => {
    const posts: { url: string; body: string }[] = [];
    const logs = await createDeliveryRouter(deps(fakeHttp({}), posts, 403)).deliver({ endpoint: SINK_ENDPOINT, event: 'incident.opened', canonical: canonical('incident.opened') });
    expect(logs).toEqual([expect.objectContaining({ status: 403, error: 'host_not_authorized', attempt: 1 })]);
    expect(posts).toHaveLength(1);
  });

  it('never throws: an unexpected failure inside a channel becomes one status-0 log entry', async () => {
    let n = 0;
    const clock = {
      now: (): number => {
        if (n++ === 0) throw new Error('clock broke');
        return T0;
      },
    };
    const logs = await createDeliveryRouter({ ...deps(fakeHttp({})), clock }).deliver({ endpoint: SINK_ENDPOINT, event: 'test', canonical: canonical('test') });
    expect(logs).toEqual([expect.objectContaining({ status: 0, error: 'network_error', detail: 'clock broke' })]);
  });
});

// ─── Settings test ───────────────────────────────────────────────────────────
describe('sendChannelTest', () => {
  const ctx = { workspace: 'main-org', linkBase: LINK, tz: 'UTC', nowIso: NOW_ISO };

  it('sends ONE test per channel and returns the last attempt', async () => {
    const bellHttp = fakeHttp({ 'POST /system/messages': err(503) });
    const bell = await sendChannelTest(deps(bellHttp), BELL, ctx);
    expect(bell.logs).toHaveLength(1);
    expect(bell.last).toMatchObject({ event: 'test', status: 503, incidentId: testPayload('main-org', NOW_ISO).incident?.id });
    expect((bellHttp.calls[0].body as { id: string; title: string }).title).toBe('Test: Savings dropped: Payments API sampling');

    const targetHttp = fakeHttp({ [SAVED]: RELAY_READY, 'POST /search/notifications': ok() });
    expect((await sendChannelTest(deps(targetHttp), TARGET, ctx)).last?.status).toBe(200);

    const posts: { url: string; body: string }[] = [];
    const hook = await sendChannelTest(deps(fakeHttp({}), posts, 503), SINK_ENDPOINT, ctx);
    expect(hook.logs).toHaveLength(1);
    expect(JSON.parse(posts[0].body).event).toBe('test');
  });

  it('never skips a test quietly: testing the default bell shows its failure', async () => {
    const r = await sendChannelTest(deps(fakeHttp({})), { ...BELL, implicit: true } as ResolvedEndpoint, ctx);
    expect(r.last).toMatchObject({ status: 404, error: 'not_available' });
  });

});

// ─── The sweep delivers through Cribl ────────────────────────────────────────
describe('runSweep delivers through the router', () => {
  /** Adds the Cribl notification APIs to the emulator: the bell and a ready relay for `ops-slack`. */
  function withCriblNotify(bell: 'ok' | 'missing') {
    const seen: { method: string; path: string; body?: unknown }[] = [];
    const wrap = (inner: CriblHttp): CriblHttp => ({
      async request(method, path, body, opts) {
        if (path === '/system/messages' || path.startsWith('/search/') || path.includes('/search/saved/')) seen.push({ method, path, body });
        if (method === 'POST' && path === '/system/messages') return bell === 'ok' ? ok({ items: [body], count: 1 }) : err(404, 'Not Found');
        if (method === 'GET' && path === `/m/default_search/search/saved/${RELAY_SAVED_SEARCH_ID}`) return RELAY_READY;
        if (method === 'POST' && path === '/search/notifications') return ok({ items: [{ message: 'Search notification request forwarded.' }] });
        return inner.request(method, path, body, opts);
      },
    });
    return { seen, wrap };
  }

  it('sends an opened regression to a Cribl target and the default bell, recorded on the incident', async () => {
    const cribl = withCriblNotify('ok');
    const w = await createWorld({ settings: (s) => void (s.notifications = [TARGET]), wrapHttp: cribl.wrap });
    await w.sweep();
    await w.sweepMinutes(2);
    await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' });
    const results = await w.sweepMinutes(4);
    const opened = results.find((r) => r.opened > 0);
    expect(opened).toBeDefined();
    const inc = opened!.snapshot!.incidents[0];
    expect(inc.deliveries.map((d) => [d.endpointId, d.status])).toEqual([
      ['ep_target', 200],
      [BELL_ENDPOINT_ID, 200],
    ]);
    expect(opened!.notified).toBe(2);
    const bellPost = cribl.seen.find((c) => c.method === 'POST' && c.path === '/system/messages');
    expect(bellPost?.body).toMatchObject({ id: `meter-reader-${inc.id}-${inc.severity}`, title: expect.stringContaining('Savings dropped') });
    const forward = cribl.seen.find((c) => c.path === '/search/notifications');
    expect(String((forward?.body as { id?: string } | undefined)?.id).startsWith('SEARCH_NOTIFICATION_meter_reader_relay_ops-slack_')).toBe(true);
    const log = (await w.docs.getNotifyLog())!.items;
    expect(log.some((l) => l.endpointId === 'ep_target' && l.status === 200)).toBe(true);
    expect(w.em.sink()).toHaveLength(0); // nothing went out as a direct webhook
  });

  it('leaves no trace of the default bell where the Leader has no bell API', async () => {
    const cribl = withCriblNotify('missing');
    const w = await createWorld({ settings: (s) => void (s.notifications = [SINK_ENDPOINT]), wrapHttp: cribl.wrap });
    await w.sweep();
    await w.sweepMinutes(2);
    await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' });
    const results = await w.sweepMinutes(4);
    const inc = results.find((r) => r.opened > 0)!.snapshot!.incidents[0];
    expect(inc.deliveries.map((d) => d.endpointId)).toEqual(['ep_sink']);
    expect(cribl.seen.filter((c) => c.path === '/system/messages').length).toBeGreaterThanOrEqual(1);
  });

  it('honors a stored, switched-off bell', async () => {
    const cribl = withCriblNotify('ok');
    const w = await createWorld({ settings: (s) => void (s.notifications = [{ ...defaultBellEndpoint(), enabled: false }, SINK_ENDPOINT]), wrapHttp: cribl.wrap });
    await w.sweep();
    await w.sweepMinutes(2);
    await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' });
    await w.sweepMinutes(4);
    expect(cribl.seen.filter((c) => c.path === '/system/messages')).toHaveLength(0);
  });
});

// ─── Settings keep the channel; the editor model stores only what each channel needs ─────────

describe('settings keep channels (core/settings.ts)', () => {
  const base = defaultSettings(NOW_ISO, 'UTC');

  it('round-trips channel and target id through a stored document, and drops a stored direct webhook (D57)', () => {
    const stored = { ...base, notifications: [TARGET, BELL, SINK_ENDPOINT] };
    const back = migrateSettings(JSON.stringify(stored), NOW_ISO, 'UTC');
    expect(back.notifications).toEqual([
      expect.objectContaining({ id: 'ep_target', channel: 'cribl-target', criblTargetId: 'ops-slack', url: '' }),
      expect.objectContaining({ id: BELL_ENDPOINT_ID, channel: 'cribl-bell' }),
    ]);
    expect(JSON.stringify(back)).not.toContain(SINK_ENDPOINT.url);
  });

  it('drops an endpoint with an unknown channel value (it would read as a webhook, which KV never holds)', () => {
    const back = migrateSettings({ ...base, notifications: [{ ...SINK_ENDPOINT, channel: 'pigeon' }] }, NOW_ISO, 'UTC');
    expect(back.notifications).toEqual([]);
  });

  it('validates per channel: no URL for Cribl channels, a target id for targets, https for webhooks', () => {
    expect(validateSettings({ ...base, notifications: [BELL, TARGET] }).ok).toBe(true);
    const noTarget = validateSettings({ ...base, notifications: [{ ...TARGET, criblTargetId: ' ' }] });
    expect(noTarget.errors).toEqual([{ field: 'notifications[0].criblTargetId', message: "Couldn't save: choose a Cribl notification target." }]);
    const badHook = validateSettings({ ...base, notifications: [{ ...SINK_ENDPOINT, url: 'http://x' }] });
    expect(badHook.errors.map((e) => e.field)).toEqual(['notifications[0].url']);
  });
});

describe('EndpointEditor model — channels', () => {
  const settings = (notifications: NotificationEndpoint[]) => ({ ...defaultSettings(NOW_ISO, 'UTC'), notifications });

  it('keeps the bell out of the list and stores it only once changed', () => {
    expect(draftsFromSettings(settings([BELL, TARGET])).map((d) => d.id)).toEqual(['ep_target']);
    const fresh = bellFromSettings(settings([]));
    expect(fresh).toEqual({ enabled: true, minSeverity: 'medium', stored: false });
    expect(bellToEndpoint(fresh)).toBeUndefined();
    expect(bellToEndpoint({ ...fresh, minSeverity: 'high' })).toMatchObject({ channel: 'cribl-bell', minSeverity: 'high', enabled: true });
    const stored = bellFromSettings(settings([{ ...BELL, enabled: false }]));
    expect(stored).toEqual({ enabled: false, minSeverity: 'medium', stored: true });
    expect(bellToEndpoint(stored)).toMatchObject({ enabled: false });
    expect(bellDirty(stored, settings([{ ...BELL, enabled: false }]))).toBe(false);
    expect(bellDirty({ ...stored, enabled: true }, settings([{ ...BELL, enabled: false }]))).toBe(true);
  });

  it('applies list endpoints first, then the stored or changed bell', () => {
    const current = settings([BELL]);
    const hook = { ...newEndpointDraft('n1'), name: 'Hook', criblTargetId: 'ops_slack' };
    expect(applyEndpoints(current, [hook]).next.notifications.map((e) => e.id)).toEqual(['n1', BELL_ENDPOINT_ID]);
    expect(applyEndpoints(settings([]), [hook], bellFromSettings(settings([]))).next.notifications.map((e) => e.id)).toEqual(['n1']);
    const off = applyEndpoints(settings([]), [hook], { enabled: false, minSeverity: 'medium', stored: false });
    expect(off.next.notifications.map((e) => [e.id, e.enabled])).toEqual([
      ['n1', true],
      [BELL_ENDPOINT_ID, false],
    ]);
  });

  it('stores a Cribl target as its id only, and reports a missing id on the right field', () => {
    const d = draftFromEndpoint(TARGET);
    expect(d).toMatchObject({ channel: 'cribl-target', criblTargetId: 'ops-slack', savedTargetId: 'ops-slack', saved: true });
    expect(draftToEndpoint({ ...d, url: 'https://leak.example.com/x' } as typeof d)).toEqual({
      id: 'ep_target',
      name: 'Ops Slack via Cribl',
      url: '',
      host: '',
      format: 'generic',
      minSeverity: 'medium',
      weeklyReceipt: TARGET.weeklyReceipt,
      enabled: true,
      channel: 'cribl-target',
      criblTargetId: 'ops-slack',
    });
    const tested = draftFromEndpoint({ ...TARGET, lastTest: { at: NOW_ISO, status: 200, hostAuthorized: true } });
    expect(draftToEndpoint(tested).lastTest?.status).toBe(200);
    expect(draftToEndpoint({ ...tested, criblTargetId: 'other' }).lastTest).toBeUndefined();
    const { errors } = applyEndpoints(settings([]), [{ ...newEndpointDraft('n2'), name: 'X', channel: 'cribl-target' }]);
    expect(errors[0]).toEqual({ criblTargetId: "Couldn't save: choose a Cribl notification target." });
    // D57: a direct webhook is never a Settings draft (the runner's .env holds it), so none is listed.
    expect(draftsFromSettings(settings([SINK_ENDPOINT, TARGET])).map((x) => x.id)).toEqual([TARGET.id]);
  });

  it('describes Cribl-channel tests in plain words', () => {
    const at = NOW_ISO;
    const log = (status: number, error?: string) => ({ endpointId: 'e', event: 'test' as const, status, attempt: 1, at, ...(error ? { error } : {}) });
    expect(describeCriblTest('cribl-bell', log(200), '', at).message).toBe('Posted to the Cribl notification bell (200). Open the bell in the Cribl header to see it.');
    expect(describeCriblTest('cribl-bell', log(208), '', at).message).toBe('Already in the Cribl notification bell.');
    expect(describeCriblTest('cribl-target', log(200), 'ops-slack', at)).toMatchObject({ kind: 'sent', message: 'Handed to Cribl for ops-slack (200). Cribl delivers it from its notification service.' });
    expect(describeCriblTest('cribl-target', log(404, 'relay_missing'), 'x', at).message).toBe('Connect this target first, then send a test.');
    expect(describeCriblTest('cribl-target', log(0, 'target_missing'), '', at).message).toBe('Choose a target to send a test.');
    expect(describeCriblTest('cribl-target', log(403, 'not_permitted'), 'x', at).message).toContain('Cribl refused the request (403)');
    expect(describeCriblTest('cribl-bell', log(404, 'not_available'), '', at).message).toContain('no such Cribl API (404)');
    expect(describeCriblTest('cribl-bell', log(0, 'network_error'), '', at).message).toBe('Test alert failed (no response).');
    expect(describeCriblTest('cribl-bell', log(500, 'http_500'), '', at)).toMatchObject({ kind: 'failed', message: 'Test alert failed (500).' });
    expect(describeCriblTest('cribl-bell', undefined, '', at).message).toBe('Test alert failed (no response).');
  });

  it('runs a Cribl test with its own clock and previews the target text', async () => {
    const http = fakeHttp({ [SAVED]: RELAY_READY, 'POST /search/notifications': ok() });
    const ctx = { workspace: 'w', linkBase: LINK, tz: 'UTC', nowIso: NOW_ISO };
    const { result, logs } = await sendCriblTest({ ...ctx, http, sender: { post: async () => ({ status: 200 }) }, endpoint: TARGET, now: () => T0 });
    expect(result).toMatchObject({ kind: 'sent', status: 200, at: NOW_ISO });
    expect(logs).toHaveLength(1);
    const bell = await sendCriblTest({ ...ctx, http: fakeHttp({ 'POST /system/messages': ok() }), sender: { post: async () => ({ status: 200 }) }, endpoint: BELL });
    expect(bell.result.kind).toBe('sent');
    expect(testTargetText(ctx).split('\n')[0]).toBe('Test: Savings dropped: Payments API sampling');
  });
});
