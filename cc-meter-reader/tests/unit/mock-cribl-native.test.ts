// tests/unit/mock-cribl-native.test.ts — the emulator's Cribl-native integrations (P1-O01), driven through
// the product's own adapters: the bell (core/adapters/cribl-notify.ts postBell), notification targets
// (listTargets), the Search relay (relayState / ensureRelay / forwardViaTarget), the router's default bell
// (core/delivery.ts) and the What-if dry run (core/adapters/preview.ts runDryRun). Every expectation is a
// measured Leader answer from docs/NOTIFICATIONS.md §2 or the preview module's live notes.

import { beforeEach, describe, expect, it } from 'vitest';
import { createDirectHttp, createDirectWebhook, createEmulator } from '../../src/mock/direct.ts';
import type { CriblEmulator } from '../../src/mock/emulator.ts';
import { normalizeRoute, previewEvents } from '../../src/mock/emulator.ts';
import { MOCK_SLACK_TARGET_URL, MOCK_WEBHOOK_TARGET_URL, RIG_SAMPLE_CONTENT } from '../../src/mock/fixtures.ts';
import {
  RELAY_SAVED_SEARCH_ID,
  ensureRelay,
  forwardViaTarget,
  listTargets,
  pickableTargets,
  postBell,
  relayNotificationId,
  relayState,
} from '../../core/adapters/cribl-notify.ts';
import { createDeliveryRouter, defaultBellEndpoint, resolveEndpoints, sendChannelTest } from '../../core/delivery.ts';
import { runDryRun, eventBytes } from '../../core/adapters/preview.ts';
import { testPayload } from '../../core/payloads.ts';
import type { CriblHttp } from '../../core/types.ts';

const NOW = Date.UTC(2026, 8, 26, 15, 0, 0);
let emu: CriblEmulator;
let http: CriblHttp;

beforeEach(() => {
  emu = createEmulator({ clock: () => NOW, options: { notificationApis: true } });
  http = createDirectHttp(emu);
});

const MSG = { id: 'meter-reader-inc_7f3a-high', severity: 'error' as const, title: 'Savings dropped: Payments API sampling', text: '$25 a day', time: NOW };

describe('the bell (POST /system/messages)', () => {
  it('posts once, answers 409 for the same id (already in the bell) and never updates in place', async () => {
    const first = await postBell(http, MSG);
    expect(first).toMatchObject({ ok: true, status: 200 });
    const again = await postBell(http, { ...MSG, text: 'changed' });
    expect(again).toMatchObject({ ok: true, status: 409, detail: 'already in the bell' });
    expect(emu.bell()).toHaveLength(1);
    expect(emu.bell()[0].text).toBe('$25 a day');
    const patch = await http.request('PATCH', `/system/messages/${MSG.id}`, { text: 'x' });
    expect(patch.status).toBe(405);
    expect((patch.json as { message: string }).message).toBe('Updating messages is not supported.');
  });

  it('refuses a severity outside info|warn|error|fatal (the spec’s success is refused live)', async () => {
    const r = await http.request('POST', '/system/messages', { ...MSG, severity: 'success' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toContain('allowedValues');
  });

  it('fills time when omitted, lists newest first, GET/DELETE by id (DELETE idempotent)', async () => {
    await http.request('POST', '/system/messages', { id: 'a', severity: 'info', title: 'A', text: 'a' });
    await http.request('POST', '/system/messages', { id: 'b', severity: 'warn', title: 'B', text: 'b' });
    const list = await http.request('GET', '/system/messages');
    expect((list.json as { items: { id: string; time: number }[] }).items.map((m) => m.id)).toEqual(['b', 'a']);
    expect((list.json as { items: { time: number }[] }).items[1].time).toBe(NOW);
    expect((await http.request('GET', '/system/messages/a')).status).toBe(200);
    expect((await http.request('DELETE', '/system/messages/a')).json).toMatchObject({ count: 1 });
    expect((await http.request('DELETE', '/system/messages/a')).json).toMatchObject({ count: 0 });
    expect((await http.request('GET', '/system/messages/a')).status).toBe(404);
  });

  it('journals bell calls under their own routes so budgets can count them', async () => {
    await postBell(http, MSG);
    await http.request('GET', `/system/messages/${MSG.id}`);
    expect(emu.calls().byRoute).toMatchObject({ 'POST /system/messages': 1, 'GET /system/messages/:id': 1 });
    expect(normalizeRoute('GET', '/m/default_search/search/saved/meter_reader_alert_relay/notifications')).toBe('GET /m/:gid/search/saved/:id/notifications');
    expect(normalizeRoute('GET', '/notification-targets/mrd_webhook_site')).toBe('GET /notification-targets/:id');
  });

  it('the default bell delivers through the router; with the bell route disabled an alert that reached nobody says why', async () => {
    const router = createDeliveryRouter({ http, webhook: createDirectWebhook(emu), clock: { now: () => NOW } });
    const canonical = testPayload('main', new Date(NOW).toISOString(), 'https://example.com');
    const [bell] = resolveEndpoints([]);
    const logs = await router.deliver({ endpoint: bell, event: 'incident.opened', canonical, incidentId: 'inc_1', backoffMs: [] });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ endpointId: 'cribl-bell', status: 200 });
    expect(emu.bell()).toHaveLength(1);

    emu.control({ action: 'fault', path: '/system/messages', status: 404, times: -1 });
    const blind = createDeliveryRouter({ http, webhook: createDirectWebhook(emu), clock: { now: () => NOW } });
    const first = await blind.deliver({ endpoint: bell, event: 'incident.opened', canonical, incidentId: 'inc_2', backoffMs: [] });
    expect(first).toEqual([expect.objectContaining({ endpointId: 'cribl-bell', status: 404, error: 'not_available', incidentId: 'inc_2' })]);
    // The rest of the pass makes no call: another alert that reached nobody gets its own line.
    const second = await blind.deliver({ endpoint: bell, event: 'incident.opened', canonical, incidentId: 'inc_3', backoffMs: [] });
    expect(second).toEqual([expect.objectContaining({ status: 404, error: 'not_available', incidentId: 'inc_3' })]);
    expect(emu.calls().byRoute['POST /system/messages']).toBe(2);
    // An alert a webhook delivered earlier in the pass, and a weekly receipt, record nothing for the bell.
    const hook = { id: 'ep_hook', name: 'Hook', url: 'https://webhook.site/x', host: 'webhook.site', format: 'generic' as const, minSeverity: 'medium' as const, enabled: true, weeklyReceipt: false };
    expect(await blind.deliver({ endpoint: hook, event: 'incident.opened', canonical, incidentId: 'inc_4', backoffMs: [] })).toEqual([expect.objectContaining({ status: 200 })]);
    expect(await blind.deliver({ endpoint: bell, event: 'incident.opened', canonical, incidentId: 'inc_4', backoffMs: [] })).toEqual([]);
    expect(await blind.deliver({ endpoint: bell, event: 'receipt.weekly', canonical, backoffMs: [] })).toEqual([]);
    expect(emu.calls().byRoute['POST /system/messages']).toBe(2);
  });

  it('a Settings bell test reports a real 200', async () => {
    const out = await sendChannelTest({ http, webhook: createDirectWebhook(emu), clock: { now: () => NOW } }, defaultBellEndpoint(), {
      workspace: 'main',
      linkBase: 'https://example.com',
      tz: 'UTC',
      nowIso: new Date(NOW).toISOString(),
    });
    expect(out.last?.status).toBe(200);
    expect(emu.bell()[0].title).toMatch(/^Test: /);
  });
});

describe('notification targets and the Search relay', () => {
  it('lists the org’s targets in full; the adapter keeps only id, type and description', async () => {
    const raw = await http.request('GET', '/notification-targets');
    expect(JSON.stringify(raw.json)).toContain(MOCK_WEBHOOK_TARGET_URL); // the Leader answers every field
    const res = await listTargets(http);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.targets.map((t) => t.id)).toEqual(['system_notifications', 'mrd_webhook_site', 'mrd_slack_finops']);
    expect(JSON.stringify(res.targets)).not.toContain('webhook.site/');
    expect(JSON.stringify(res.targets)).not.toContain(MOCK_SLACK_TARGET_URL);
    expect(pickableTargets(res.targets).map((t) => t.id)).toEqual(['mrd_webhook_site', 'mrd_slack_finops']);
    const test = await http.request('POST', '/notification-targets/mrd_webhook_site/test', {});
    expect(test.status).toBe(405);
  });

  it('forwarding before any search notification exists answers 500 (relay_missing)', async () => {
    const out = await forwardViaTarget(http, { targetId: 'mrd_webhook_site', suffix: 's1', title: 'T', severity: 'high', message: 'm', now: NOW });
    expect(out).toMatchObject({ ok: false, status: 500, error: 'relay_missing' });
  });

  it('ensureRelay creates the saved search and the notification once; relayState then reads ready', async () => {
    expect(await relayState(http, 'mrd_webhook_site')).toEqual({ state: 'missing', savedSearch: false, notification: false });
    const made = await ensureRelay(http, 'mrd_webhook_site');
    expect(made).toMatchObject({ ok: true, status: 201, created: [`saved search ${RELAY_SAVED_SEARCH_ID}`, `notification ${relayNotificationId('mrd_webhook_site')}`] });
    expect(await ensureRelay(http, 'mrd_webhook_site')).toMatchObject({ ok: true, status: 200, created: [] });
    expect(await relayState(http, 'mrd_webhook_site')).toEqual({ state: 'ready', notificationId: 'meter_reader_relay_mrd_webhook_site' });
    // Another target on the same saved search: only its notification is new.
    expect(await ensureRelay(http, 'mrd_slack_finops')).toMatchObject({ ok: true, created: [`notification ${relayNotificationId('mrd_slack_finops')}`] });
    // The group-scoped forward has no route (measured Express 404).
    expect((await http.request('POST', '/m/default_search/search/notifications', {})).status).toBe(404);
  });

  it('delivers a forward to the target only with the SEARCH_NOTIFICATION_<id>_ prefix; anything else is accepted and dropped', async () => {
    await ensureRelay(http, 'mrd_webhook_site');
    const dropped = await http.request('POST', '/search/notifications', { id: 'mrd_inc_abc_1', notificationId: 'meter_reader_relay_mrd_webhook_site', message: 'x' });
    expect(dropped.status).toBe(200);
    expect(emu.sink()).toHaveLength(0);
    const unknown = await http.request('POST', '/search/notifications', { id: 'SEARCH_NOTIFICATION_nope_1', notificationId: 'nope', message: 'x' });
    expect(unknown.status).toBe(200);
    expect(emu.sink()).toHaveLength(0);

    const payload = testPayload('main', new Date(NOW).toISOString(), 'https://example.com');
    const out = await forwardViaTarget(http, { targetId: 'mrd_webhook_site', suffix: 'inc_1_test_1', title: 'Test', severity: 'high', message: 'Line one\nLine two', now: NOW, payload });
    expect(out).toMatchObject({ ok: true, status: 200 });
    const [hit] = emu.sink();
    expect(hit).toMatchObject({ via: 'cribl-target', url: MOCK_WEBHOOK_TARGET_URL, host: 'webhook.site' });
    expect((hit.json as { id: string }).id).toMatch(/^SEARCH_NOTIFICATION_meter_reader_relay_mrd_webhook_site_/);
    expect((hit.json as { meter_reader: unknown }).meter_reader).toEqual(payload);
    // The measured side effect: one bell entry per notification, replaced on each send.
    await forwardViaTarget(http, { targetId: 'mrd_webhook_site', suffix: 'inc_1_test_2', title: 'Test', severity: 'high', message: 'again', now: NOW });
    const relayEntries = emu.bell().filter((m) => m.id === 'meter_reader_relay_mrd_webhook_site');
    expect(relayEntries).toHaveLength(1);
    expect(relayEntries[0]).toMatchObject({ title: 'Notification', text: 'again' });
  });

  it('a Slack target gets the plain-text message', async () => {
    await ensureRelay(http, 'mrd_slack_finops');
    await forwardViaTarget(http, { targetId: 'mrd_slack_finops', suffix: 's', title: 'T', severity: 'medium', message: 'Savings dropped', now: NOW });
    expect(emu.sink()[0]).toMatchObject({ host: 'hooks.slack.com', via: 'cribl-target', json: { text: 'Savings dropped' } });
  });

  it('a reset clears the bell and the relay', async () => {
    await ensureRelay(http, 'mrd_webhook_site');
    await postBell(http, MSG);
    emu.control({ action: 'reset' });
    expect(emu.bell()).toEqual([]);
    expect(await relayState(http, 'mrd_webhook_site')).toMatchObject({ state: 'missing' });
  });
});

describe('the What-if dry run (sample content + preview)', () => {
  it('serves every rig sample the Datagen sources name', async () => {
    expect(Object.keys(RIG_SAMPLE_CONTENT).sort()).toEqual(['mrd_api_access', 'mrd_k8s_container', 'mrd_pan_traffic', 'mrd_vpc_flow_v2', 'mrd_windows_security_xml']);
    const r = await http.request('GET', '/m/default/system/samples/mrd_windows_security_xml/content');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json)).toBe(true);
    expect((r.json as unknown[]).length).toBe(33);
    expect((await http.request('GET', '/m/default/system/samples/nope/content')).status).toBe(404);
  });

  it('refuses any preview mode but pipe, and an unknown pipeline', async () => {
    expect((await http.request('POST', '/m/default/preview', { mode: 'route', pipelineId: 'mrd_win_xml_pack', events: [] })).status).toBe(400);
    expect((await http.request('POST', '/m/default/preview', { mode: 'pipe', pipelineId: 'nope', events: [] })).status).toBe(404);
  });

  it('runs the product dry run end to end: Windows workstations through the Windows XML pack measure ≈ 33%', async () => {
    const out = await runDryRun(http, { groupId: 'default', inputId: 'mrd_windows_workstations', treatment: 'pack-windows' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out).toMatchObject({ pipelineId: 'mrd_win_xml_pack', sampleId: 'mrd_windows_security_xml', events: 33, eventsOut: 33 });
    expect(out.ratio).toBeCloseTo(0.33, 2);
    expect(out.inBytes).toBeGreaterThan(80_000);
  });

  it('models an aggregation: VPC flow through the VPC pack keeps 2% of events and 12% of bytes', async () => {
    const out = await runDryRun(http, { groupId: 'default', inputId: 'mrd_vpc_flow', treatment: 'pack-vpc' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ratio).toBeCloseTo(0.88, 2);
    expect(out.eventsOut).toBeLessThan(out.events / 10);
  });

  it('previewEvents is exact on bytes and deterministic', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ _raw: 'x'.repeat(100 + i), _time: i }));
    const a = previewEvents(events, { bytes: 0.5, events: 0.5 }, 'p');
    const b = previewEvents(events, { bytes: 0.5, events: 0.5 }, 'p');
    expect(a).toEqual(b);
    expect(a).toHaveLength(5);
    const inBytes = events.reduce((n, e) => n + eventBytes(e), 0);
    expect(a.reduce((n, e) => n + eventBytes(e), 0)).toBe(Math.round(inBytes * 0.5));
    expect(previewEvents(events, { bytes: 0, events: 0 }, 'p')).toEqual([]);
  });
});

describe('harness actions for the call-budget tests (tests/e2e/budget.spec.ts, P1-O02)', () => {
  it('seedInventory stores the inventory a sweep would write for the org as it stands, without a journaled call', async () => {
    const r = emu.control({ action: 'seedInventory', at: NOW });
    expect(r).toMatchObject({ ok: true, groups: expect.any(Number) });
    const stored = JSON.parse(emu.kvDump('inventory').inventory) as { schemaVersion: number; updatedAt: string; byGroup: Record<string, unknown> };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.updatedAt).toBe(new Date(NOW).toISOString());
    expect(Object.keys(stored.byGroup)).toContain('default');
    expect(emu.calls().total).toBe(0);
  });

  it('runnerSweep stamps meta and the snapshot as a runner sweep leaves them, and makes no call', async () => {
    expect(() => emu.control({ action: 'runnerSweep' })).toThrow();
    const meta = { schemaVersion: 1, lastSweepAt: '2026-09-26T14:00:00.000Z', lastSweepOwner: 'ui:tab', sweepCount: 7, meteredThrough: '2026-09-26T14:00:00.000Z', collectingSince: '2026-08-01T00:00:00.000Z' };
    await http.request('PUT', '/kvstore/meta', JSON.stringify(meta), { raw: true });
    await http.request('PUT', '/kvstore/snapshot', JSON.stringify({ schemaVersion: 1, sweepAt: '2026-09-26T14:00:00.000Z', flows: [] }), { raw: true });
    emu.resetCalls();
    const at = NOW + 25_000;
    expect(emu.control({ action: 'runnerSweep', at })).toMatchObject({ ok: true, owner: 'runner:workhorse:1', meteredThrough: new Date(NOW).toISOString() });
    const kv = emu.kvDump();
    expect(JSON.parse(kv.meta)).toMatchObject({ lastSweepAt: new Date(at).toISOString(), lastSweepOwner: 'runner:workhorse:1', lastSweepMode: 'scheduled', sweepCount: 8, collectingSince: meta.collectingSince });
    expect(JSON.parse(kv.snapshot)).toMatchObject({ sweepAt: new Date(at).toISOString(), windowEnd: new Date(NOW).toISOString(), flows: [] });
    // A cursor already ahead of the clock is never moved back; another owner can be named.
    emu.control({ action: 'runnerSweep', at: NOW - 10 * 60_000, owner: 'runner:mini:9' });
    expect(JSON.parse(emu.kvDump('meta').meta)).toMatchObject({ lastSweepOwner: 'runner:mini:9', meteredThrough: new Date(NOW).toISOString() });
    expect(emu.calls().total).toBe(0);
  });
});
