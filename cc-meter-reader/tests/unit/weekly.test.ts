import { describe, expect, it } from 'vitest';
import type { CriblHttp, HourRow, KvStore, Meta, NotificationEndpoint } from '../../core/types.ts';
import { KvHttpError } from '../../core/kv.ts';
import { LOCK_TTL_MS } from '../../core/sweep.ts';
import { WEEKLY_AUTO_WINDOW_MS, WEEKLY_ON_TIME_MS, isLateWeekly, mondayNoonUtc, runWeeklyReceipt, sendTestNotification, shouldAutoSendWeekly } from '../../core/weekly.ts';
import { receiptText } from '../../core/receipt.ts';
import { RECEIPT_STRINGS } from '../../core/strings.ts';
import { DAY, HOUR, SINK_ENDPOINT, T0, createWorld, type World } from '../integration/harness.ts';
import { defaultBellEndpoint } from '../../core/delivery.ts';
import { RELAY_SAVED_SEARCH_ID, SEARCH_NOTIFICATION_ID_PREFIX, relayNotificationId } from '../../core/adapters/cribl-notify.ts';

const PAY_FLOW = 'default|mrd_payments_api|mrd_payments_api|mrd_pay_sample|mrd_siem_prod';
const DC_FLOW = 'default|mrd_windows_dc|mrd_windows_dc|mrd_win_xml_pack|mrd_siem_prod';
const MONDAY_NOON = Date.UTC(2026, 8, 28, 12);

const SLACK: NotificationEndpoint = {
  ...SINK_ENDPOINT,
  id: 'ep_slack',
  name: 'Ops Slack',
  url: 'https://hooks.slack.com/services/T0/B0/xyz',
  host: 'hooks.slack.com',
  format: 'slack',
};
const OFF: NotificationEndpoint = {
  ...SINK_ENDPOINT,
  id: 'ep_off',
  enabled: false,
};
const NO_RECEIPT: NotificationEndpoint = {
  ...SINK_ENDPOINT,
  id: 'ep_noreceipt',
  weeklyReceipt: false,
};

function meta(overrides: Partial<Meta> = {}): Meta {
  return {
    schemaVersion: 1,
    installedAt: new Date(T0 - 30 * DAY).toISOString(),
    collectingSince: new Date(T0 - 30 * DAY).toISOString(),
    appVersion: '1.0.0',
    build: 'demo',
    metricsSource: 'metrics-query',
    sweepErrors: 0,
    consecutiveRateLimited: 0,
    sweepCount: 100,
    ...overrides,
  };
}

/** Hour rollups for 21–27 Sep (the week before Monday 28 Sep) and daily totals for the week before that. */
async function seedWeek(w: World): Promise<void> {
  for (let d = 21; d <= 27; d++) {
    const day = `2026-09-${String(d).padStart(2, '0')}`;
    const rows = (savedM: number): HourRow[] =>
      Array.from({ length: 24 }, (_, h) => ({
        t: new Date(Date.UTC(2026, 8, d, h)).toISOString(),
        inB: 1e9,
        outB: 5e8,
        whpM: savedM * 2,
        paidM: savedM,
        savedM,
        samples: 60,
      }));
    await w.docs.putRollHour(day, {
      schemaVersion: 1,
      day,
      flows: { [PAY_FLOW]: rows(1_000), [DC_FLOW]: rows(3_000) },
    });
  }
  const byDay: Record<string, { whpM: number; paidM: number; savedM: number; minutes: number }> = {};
  for (let d = 14; d <= 20; d++)
    byDay[`2026-09-${d}`] = {
      whpM: 100_000,
      paidM: 50_000,
      savedM: 50_000,
      minutes: 1440,
    };
  await w.docs.putTotals({
    schemaVersion: 1,
    updatedAt: new Date(T0).toISOString(),
    byDay,
  });
}

describe('mondayNoonUtc / shouldAutoSendWeekly', () => {
  it('finds the most recent Monday 12:00 UTC', () => {
    expect(mondayNoonUtc(MONDAY_NOON)).toBe(MONDAY_NOON);
    expect(mondayNoonUtc(MONDAY_NOON + 3 * HOUR)).toBe(MONDAY_NOON);
    expect(mondayNoonUtc(MONDAY_NOON - HOUR)).toBe(MONDAY_NOON - 7 * DAY);
    expect(mondayNoonUtc(MONDAY_NOON + 6 * DAY)).toBe(MONDAY_NOON);
  });

  it('sends once in the week after the crossing, when metering began before it', () => {
    const since = {
      collectingSince: new Date(MONDAY_NOON - 5 * DAY).toISOString(),
    };
    expect(shouldAutoSendWeekly(since, MONDAY_NOON + 60_000)).toBe(true);
    expect(
      shouldAutoSendWeekly(
        {
          ...since,
          lastWeeklySentAt: new Date(MONDAY_NOON + 1_000).toISOString(),
        },
        MONDAY_NOON + 60_000,
      ),
    ).toBe(false);
    expect(
      shouldAutoSendWeekly(
        {
          ...since,
          lastWeeklySentAt: new Date(MONDAY_NOON - 7 * DAY).toISOString(),
        },
        MONDAY_NOON + 60_000,
      ),
    ).toBe(true);
    // The whole week (rules round): a tab first opened on Thursday, or Sunday night, still sends last week's receipt.
    expect(WEEKLY_AUTO_WINDOW_MS).toBe(7 * DAY);
    expect(shouldAutoSendWeekly(since, MONDAY_NOON + 3 * DAY)).toBe(true);
    expect(shouldAutoSendWeekly(since, MONDAY_NOON + 7 * DAY - 1)).toBe(true);
    // … once: a send any time after the crossing settles the week.
    expect(shouldAutoSendWeekly({ ...since, lastWeeklySentAt: new Date(MONDAY_NOON + 2 * DAY).toISOString() }, MONDAY_NOON + 6 * DAY)).toBe(false);
    expect(shouldAutoSendWeekly(since, MONDAY_NOON + 3 * DAY, { windowMs: 2 * DAY })).toBe(false);
    expect(shouldAutoSendWeekly(since, MONDAY_NOON + 3 * DAY, { windowMs: 4 * DAY })).toBe(true);
    expect(shouldAutoSendWeekly({ collectingSince: new Date(MONDAY_NOON + 1).toISOString() }, MONDAY_NOON + 60_000)).toBe(false);
    expect(shouldAutoSendWeekly(null, MONDAY_NOON + 60_000)).toBe(false);
    expect(shouldAutoSendWeekly(since, MONDAY_NOON - 1)).toBe(false);
  });
});

describe('a late automatic send (rules round: the week nobody opened the App on Monday)', () => {
  it('is late only past a day after the crossing', () => {
    expect(WEEKLY_ON_TIME_MS).toBe(DAY);
    expect(isLateWeekly(MONDAY_NOON + HOUR)).toBe(false);
    expect(isLateWeekly(MONDAY_NOON + DAY)).toBe(false);
    expect(isLateWeekly(MONDAY_NOON + DAY + 1)).toBe(true);
    expect(isLateWeekly(MONDAY_NOON + 6 * DAY)).toBe(true);
    expect(isLateWeekly(MONDAY_NOON + 7 * DAY)).toBe(false); // the next Monday's own send
  });

  it("reports the same week the Monday send would have, and says it was sent late", async () => {
    const onTime = await createWorld();
    await seedWeek(onTime);
    await onTime.docs.putMeta(meta());
    const monday = await runWeeklyReceipt(onTime.deps, { mode: 'ui' });
    expect(monday.receipt?.sentLate).toBeUndefined();
    expect(monday.text).not.toContain(RECEIPT_STRINGS.sentLate.slice(0, 20));

    const thursday = await createWorld();
    await seedWeek(thursday);
    await thursday.docs.putMeta(meta());
    thursday.advance(3 * DAY);
    const late = await runWeeklyReceipt(thursday.deps, { mode: 'ui' });
    expect(late.sent).toBe(1);
    expect(late.receipt?.sentLate).toBe(true);
    // The same local week (21–27 Sep), the same dollars.
    expect(late.receipt?.periodStart).toBe(monday.receipt?.periodStart);
    expect(late.receipt?.periodEnd).toBe(monday.receipt?.periodEnd);
    expect(late.receipt?.savedM).toBe(monday.receipt?.savedM);
    // Every channel's text carries the line (the bell, Slack and ServiceNow all print receiptText).
    expect(receiptText(late.receipt!).replace(/\s+/g, ' ')).toContain(RECEIPT_STRINGS.sentLate);
    expect((await thursday.meta())!.lastWeeklySentAt).toBe(new Date(thursday.now()).toISOString());
    // Manual sends are never marked late.
    const manual = await runWeeklyReceipt(thursday.deps, { mode: 'manual' });
    expect(manual.receipt?.sentLate).toBeUndefined();
  });
});

describe('runWeeklyReceipt', () => {
  it("'Weekly receipt now' posts the trailing seven days to every enabled receipt endpoint in its format", async () => {
    const w = await createWorld({
      settings: (s) => void (s.notifications = [SINK_ENDPOINT, SLACK, OFF, NO_RECEIPT]),
    });
    await seedWeek(w);
    await w.docs.putMeta(meta());
    const r = await runWeeklyReceipt(w.deps, { mode: 'manual' });
    expect(r.error).toBeUndefined();
    expect(r.endpoints).toBe(2);
    expect(r.sent).toBe(2);
    expect(r.receipt).toMatchObject({
      label: 'Sep 21–27, 2026',
      savedM: 7 * 24 * 4_000,
      whpM: 7 * 24 * 8_000,
      paidM: 7 * 24 * 4_000,
      ratio: 0.5,
      priorSavedM: 350_000,
    });
    expect(r.receipt!.lines.map((l) => l.label)).toEqual(['Windows XML pack', 'Payments API sampling']);
    expect(r.receipt!.trendPct).toBe(Math.round(((672_000 - 350_000) / 350_000) * 100));
    expect(r.text).toContain('Meter Reader — weekly receipt');
    const sink = w.em.sink();
    const generic = sink.find((e) => e.host === 'webhook.site')!.json as {
      event: string;
      receipt: unknown;
    };
    expect(generic.event).toBe('receipt.weekly');
    expect(generic.receipt).toEqual(r.receipt);
    const slack = sink.find((e) => e.host === 'hooks.slack.com')!.json as {
      blocks: { type: string }[];
    };
    // P0-23: the receipt links to its week on the Receipt (the button under the text).
    expect(slack.blocks.map((b) => b.type)).toEqual(['header', 'section', 'actions']);
    expect((await w.docs.getNotifyLog())!.items.map((i) => i.event)).toEqual(['receipt.weekly', 'receipt.weekly']);
    // Manual sends never suppress the Monday automatic one.
    expect((await w.meta())!.lastWeeklySentAt).toBeUndefined();
  });

  it('the automatic send holds the sweep lock, records the week and sends once', async () => {
    const w = await createWorld();
    await seedWeek(w);
    await w.docs.putMeta(meta());
    await w.docs.acquireLock('tab-b', LOCK_TTL_MS);
    expect((await runWeeklyReceipt(w.deps, { mode: 'ui' })).skipped).toBe('locked');
    w.advance(LOCK_TTL_MS + 1_000);
    const r = await runWeeklyReceipt(w.deps, { mode: 'ui' });
    expect(r.sent).toBe(1);
    expect((await w.meta())!.lastWeeklySentAt).toBe(new Date(w.now()).toISOString());
    const lock = await w.docs.getLock();
    expect(Date.parse(lock!.expiresAt)).toBeLessThanOrEqual(w.now());
    const again = await runWeeklyReceipt(w.deps, { mode: 'scheduled' });
    expect(again.skipped).toBe('already_sent');
    expect(w.em.sink()).toHaveLength(1);
  });

  it('skips without endpoints, stops on a rate limit, and reports other failures', async () => {
    // The bell takes the receipt by default, so "no endpoints" means the bell was switched off too.
    const w = await createWorld({
      settings: (s) => void (s.notifications = [NO_RECEIPT, { ...defaultBellEndpoint(), enabled: false }]),
    });
    expect((await runWeeklyReceipt(w.deps, { mode: 'manual' })).skipped).toBe('no_endpoints');
    const limited: KvStore = {
      ...w.kv,
      get: () => Promise.reject(new KvHttpError('GET', 'settings', 429)),
    };
    expect(await runWeeklyReceipt({ ...w.deps, kv: limited }, { mode: 'manual' })).toMatchObject({
      skipped: 'rate_limited',
      error: 'rate_limited',
    });
    const broken: KvStore = {
      ...w.kv,
      get: () => Promise.reject(new Error('kv down')),
    };
    expect(await runWeeklyReceipt({ ...w.deps, kv: broken }, { mode: 'manual' })).toMatchObject({ error: 'kv down', sent: 0 });
  });

  it('builds an empty receipt when nothing was metered and a logging failure does not fail the send', async () => {
    const w = await createWorld();
    let logReads = 0;
    const kv: KvStore = {
      ...w.kv,
      get: (k) => (k === 'notify/log' && ++logReads === 1 ? Promise.reject(new Error('log unreadable')) : w.kv.get(k)),
    };
    const r = await runWeeklyReceipt({ ...w.deps, kv }, { mode: 'manual' });
    expect(r.sent).toBe(1);
    expect(r.receipt).toMatchObject({
      savedM: 0,
      lines: [],
      openIncidents: [],
    });
    expect(r.receipt!.priorSavedM).toBeUndefined();
    expect(w.logs.some((l) => l.msg.includes('notify/log could not be updated'))).toBe(true);
  });
});

describe('sendTestNotification', () => {
  it('posts the SPEC 12.5 test payload to a saved endpoint and reports the host as authorized', async () => {
    const w = await createWorld();
    const r = await sendTestNotification(w.deps, {
      endpointId: SINK_ENDPOINT.id,
    });
    expect(r).toMatchObject({ status: 200, hostAuthorized: true, attempts: 1 });
    const body = w.em.sink()[0].json as {
      event: string;
      incident: { notes: string[] };
    };
    expect(body.event).toBe('test');
    expect(body.incident.notes).toEqual(['sample']);
    expect((await w.docs.getNotifyLog())!.items[0]).toMatchObject({
      endpointId: SINK_ENDPOINT.id,
      event: 'test',
      status: 200,
    });
  });

  it('tests an unsaved endpoint, flags a host the proxy refuses, and answers not_found for unknown ids', async () => {
    const w = await createWorld();
    const denied = await sendTestNotification(w.deps, {
      endpoint: {
        ...SINK_ENDPOINT,
        id: 'new',
        url: 'https://relay.example.com/in',
        host: 'relay.example.com',
      },
    });
    expect(denied).toMatchObject({
      status: 403,
      hostAuthorized: false,
      attempts: 1,
      error: 'host_not_authorized',
    });
    const slack = await sendTestNotification(w.deps, { endpoint: SLACK });
    expect(slack.status).toBe(200);
    expect((w.em.sink()[0].json as { blocks: unknown[] }).blocks.length).toBeGreaterThan(0);
    expect(await sendTestNotification(w.deps, { endpointId: 'missing' })).toMatchObject({
      status: 0,
      hostAuthorized: false,
      error: 'not_found',
    });
    const broken: KvStore = {
      ...w.kv,
      get: () => Promise.reject(new Error('kv down')),
    };
    expect(await sendTestNotification({ ...w.deps, kv: broken }, { endpointId: SINK_ENDPOINT.id })).toMatchObject({
      status: 0,
      error: 'kv down',
    });
  });

  it('the receipt goes through the delivery router: the Cribl bell and Cribl targets get it too (NOTIFY-3a issue 4)', async () => {
    const TARGET: NotificationEndpoint = {
      id: 'ep_target',
      name: 'Ops Slack (Cribl target)',
      url: '',
      host: '',
      format: 'generic',
      minSeverity: 'medium',
      weeklyReceipt: true,
      enabled: true,
      channel: 'cribl-target',
      criblTargetId: 'ops_slack',
    };
    const TARGET_OFF: NotificationEndpoint = { ...TARGET, id: 'ep_target_off', criblTargetId: 'quiet', weeklyReceipt: false };
    const posts: { path: string; body: unknown }[] = [];
    const leader = (inner: CriblHttp): CriblHttp => ({
      async request(method, path, body, o) {
        if (method === 'POST' && path === '/system/messages') {
          posts.push({ path, body });
          return { status: 200, ok: true, json: {} };
        }
        if (method === 'GET' && path.endsWith(`/search/saved/${RELAY_SAVED_SEARCH_ID}`))
          return {
            status: 200,
            ok: true,
            json: { items: [{ id: RELAY_SAVED_SEARCH_ID, schedule: { notifications: { items: [{ id: relayNotificationId('ops_slack') }] } } }] },
          };
        if (method === 'POST' && path === '/search/notifications') {
          posts.push({ path, body });
          return { status: 200, ok: true, json: {} };
        }
        return inner.request(method, path, body, o);
      },
    });
    const w = await createWorld({ wrapHttp: leader, settings: (s) => void (s.notifications = [SLACK, TARGET, TARGET_OFF]) });
    const r = await runWeeklyReceipt(w.deps, { mode: 'manual' });
    expect(r.error).toBeUndefined();
    // Webhook + target + the default bell; the target that opted out gets nothing.
    expect(r.endpoints).toBe(3);
    expect(r.sent).toBe(3);
    expect(new Set(r.deliveries.map((d) => d.endpointId))).toEqual(new Set(['ep_slack', 'ep_target', 'cribl-bell']));
    const bell = posts.find((p) => p.path === '/system/messages')!.body as { id: string; title: string; severity: string };
    expect(bell.id).toBe(`meter-reader-receipt-${r.receipt!.periodStart.slice(0, 10)}`);
    expect(bell.title).toContain('Weekly receipt');
    expect(bell.severity).toBe('info');
    const forwarded = posts.filter((p) => p.path === '/search/notifications');
    expect(forwarded).toHaveLength(1);
    expect(String((forwarded[0].body as { id: string }).id).startsWith(`${SEARCH_NOTIFICATION_ID_PREFIX}${relayNotificationId('ops_slack')}_`)).toBe(true);
  });

  it('the test send goes through the router, so a Cribl bell endpoint is tested on its own channel', async () => {
    const posts: string[] = [];
    const bellHttp = (inner: CriblHttp): CriblHttp => ({
      async request(method, path, body, o) {
        if (method === 'POST' && path === '/system/messages') {
          posts.push(path);
          return { status: 200, ok: true, json: {} };
        }
        return inner.request(method, path, body, o);
      },
    });
    const w = await createWorld({ wrapHttp: bellHttp });
    const r = await sendTestNotification(w.deps, { endpoint: defaultBellEndpoint() });
    expect(r).toMatchObject({ status: 200, hostAuthorized: true, attempts: 1 });
    expect(r.error).toBeUndefined();
    expect(posts).toEqual(['/system/messages']);
  });
});
