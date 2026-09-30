import { describe, expect, it } from 'vitest';
import type { NotificationEndpoint, Settings, WebhookSender } from '../../core/types.ts';
import {
  DEFAULT_QR_URL,
  DEFAULT_THRESHOLDS,
  MAX_NOTIFICATION_ENDPOINTS,
  WEBHOOK_NOT_STORED_MESSAGE,
  defaultSettings,
  hostFromUrl,
  mergeSettings,
  migrateSettings,
  normalizeEndpoint,
  storableSettings,
  urlHasCredentials,
  validateSettings,
} from '../../core/settings.ts';
import { deliver } from '../../core/adapters/webhook.ts';
import { t } from '../../src/copy/en.ts';

const NOW = '2026-09-26T04:00:00.000Z';
const TZ = 'America/Chicago';

/** A stored endpoint: a Cribl notification target (D57: the only list endpoint App KV holds; no URL). */
const endpoint = (over: Partial<NotificationEndpoint> = {}): NotificationEndpoint => ({
  id: 'ep1',
  name: 'Ops Slack',
  url: '',
  host: '',
  format: 'generic',
  minSeverity: 'medium',
  weeklyReceipt: true,
  enabled: true,
  channel: 'cribl-target',
  criblTargetId: 'ops_slack',
  ...over,
});
/** A direct webhook: the runner's, from its .env (D57); never a settings entry. */
const webhook = (over: Partial<NotificationEndpoint> = {}): NotificationEndpoint => ({
  id: 'hook1',
  name: 'Ops hook',
  url: 'https://hooks.slack.com/services/T000/B000/XXXX',
  host: 'hooks.slack.com',
  format: 'slack',
  minSeverity: 'medium',
  weeklyReceipt: true,
  enabled: true,
  ...over,
});

describe('defaultSettings', () => {
  it('matches SPEC 5 defaults plus recoveryMinutes and runtime', () => {
    const s = defaultSettings(NOW, TZ);
    expect(s.schemaVersion).toBe(1);
    expect(s.updatedAt).toBe(NOW);
    expect(s.displayTimezone).toBe(TZ);
    // Founder-build r2 ui-2 (named item (a)): a new install opens the Receipt on the annualized run rate.
    expect(s.headlinePeriodDefault).toBe('annualized');
    expect(s.presenter).toEqual({ headlinePeriod: 'annualized', qrUrl: DEFAULT_QR_URL });
    expect(s.live).toEqual({ pollSeconds: 10, presenterPollSeconds: 5 });
    expect(s.thresholds).toEqual({
      regressionPoints: 15,
      regressionMinutes: 3,
      regressionCommitWindowMin: 30,
      spikeSigma: 3,
      spikeMinutes: 2,
      spikeMinCentsPerHour: 500,
      budgetWarnPct: 90,
      budgetAlertPct: 100,
      goodNewsPoints: 15,
      cooldownMinutes: 60,
      ewmaAlpha: 0.0014,
      warmupSamples: 10,
      recoveryMinutes: 5,
      regressionMinCentsPerDay: 500,
    });
    expect(s.goodNewsEnabled).toBe(false);
    expect(s.includeInternal).toBe(false);
    expect(s.demo).toEqual({ enabled: false, replayMode: false, profile: true });
    expect(s.runtime).toBe('ui');
    expect(s.criblCostCentsPerMonth).toBeUndefined();
    expect(validateSettings(s)).toEqual({ ok: true, errors: [] });
  });
  it('falls back to UTC for an invalid zone', () => {
    expect(defaultSettings(NOW, 'Nowhere/Land').displayTimezone).toBe('UTC');
  });
  it("defaults runtime to 'backend' only when the build asks for it (VITE_MR_RUNTIME, Enterprise variant)", () => {
    expect(defaultSettings(NOW, TZ, 'backend').runtime).toBe('backend');
    expect(defaultSettings(NOW, TZ, 'ui').runtime).toBe('ui');
    expect(defaultSettings(NOW, TZ, 'cloud' as never).runtime).toBe('ui');
    // A stored document still wins over the build's default, in both directions.
    expect(mergeSettings({ runtime: 'ui' }, defaultSettings(NOW, TZ, 'backend')).runtime).toBe('ui');
    expect(mergeSettings({}, defaultSettings(NOW, TZ, 'backend')).runtime).toBe('backend');
    expect(mergeSettings({ runtime: 'backend' }, defaultSettings(NOW, TZ)).runtime).toBe('backend');
  });
  it('does not share the thresholds object', () => {
    const a = defaultSettings(NOW, TZ);
    a.thresholds.regressionPoints = 40;
    expect(defaultSettings(NOW, TZ).thresholds.regressionPoints).toBe(15);
    expect(DEFAULT_THRESHOLDS.regressionPoints).toBe(15);
  });
});

describe('validateSettings', () => {
  const base = (): Settings => ({ ...defaultSettings(NOW, TZ), notifications: [endpoint()] });

  it('accepts a valid document', () => {
    expect(validateSettings(base()).ok).toBe(true);
  });
  it('refuses any direct webhook, and any URL on a Cribl channel (D57: no build stores a webhook URL)', () => {
    const s = base();
    for (const e of [webhook(), webhook({ channel: 'webhook' }), webhook({ url: 'http://example.com/hook' }), endpoint({ url: 'https://hooks.slack.com/services/x' })]) {
      s.notifications = [e];
      const r = validateSettings(s);
      expect(r.ok).toBe(false);
      expect(r.errors).toContainEqual({ field: 'notifications[0].url', message: WEBHOOK_NOT_STORED_MESSAGE });
    }
    // The UI copy deck carries the same words (src/copy/en.ts errors.webhookNotStored).
    expect(t('errors.webhookNotStored')).toBe(WEBHOOK_NOT_STORED_MESSAGE);
  });
  it("the UI copy deck carries core's token and unknown-target refusals word for word (rules round 4)", async () => {
    const { CREDENTIAL_NOT_STORED_MESSAGE, UNKNOWN_TARGET_MESSAGE } = await import('../../core/settings.ts');
    expect(t('errors.credentialNotStored')).toBe(CREDENTIAL_NOT_STORED_MESSAGE);
    expect(t('errors.unknownTarget')).toBe(UNKNOWN_TARGET_MESSAGE);
  });
  it('storableSettings keeps only the Cribl channels, each without a URL or host (every KV write goes through it)', () => {
    const s = { ...base(), notifications: [webhook(), endpoint({ url: 'https://leak.example.com/x', host: 'leak.example.com' }), { ...endpoint({ id: 'bell' }), channel: 'cribl-bell' as const }] };
    const out = storableSettings(s);
    expect(out.notifications.map((e) => [e.id, e.url, e.host])).toEqual([
      ['ep1', '', ''],
      ['bell', '', ''],
    ]);
    expect(JSON.stringify(out.notifications)).not.toMatch(/https?:\/\//);
    expect(validateSettings(out).ok).toBe(true);
  });
  it('rejects negative and non-finite numbers with the SPEC 17 copy', () => {
    const s = base();
    s.thresholds = { ...s.thresholds, spikeSigma: -1, cooldownMinutes: Number.NaN };
    s.criblCostCentsPerMonth = -5;
    s.budgets = { mrd_siem_prod: { centsPerMonth: -1 } };
    const r = validateSettings(s);
    expect(r.errors.map((e) => e.message)).toEqual(
      expect.arrayContaining([
        "Couldn't save: spike sigma must be 0 or more.",
        "Couldn't save: cooldown minutes must be 0 or more.",
        "Couldn't save: Cribl cost must be 0 or more.",
        "Couldn't save: budget for mrd_siem_prod must be 0 or more.",
      ]),
    );
  });
  it('enforces the SPEC 5 ranges', () => {
    const s = base();
    s.thresholds = { ...s.thresholds, regressionPoints: 4, ewmaAlpha: 0.9 };
    s.live = { pollSeconds: 61, presenterPollSeconds: 2 };
    const fields = validateSettings(s).errors.map((e) => e.field);
    expect(fields).toEqual(
      expect.arrayContaining(['thresholds.regressionPoints', 'thresholds.ewmaAlpha', 'live.pollSeconds', 'live.presenterPollSeconds']),
    );
    s.thresholds = { ...s.thresholds, regressionPoints: 50, ewmaAlpha: 0.0005 };
    s.live = { pollSeconds: 5, presenterPollSeconds: 30 };
    expect(validateSettings(s).ok).toBe(true);
    s.live = { pollSeconds: -1, presenterPollSeconds: Number.NaN };
    expect(validateSettings(s).errors.map((e) => e.field)).toEqual(['live.pollSeconds', 'live.presenterPollSeconds']);
  });
  it('requires whole-number minute counts ≥ 1', () => {
    const s = base();
    s.thresholds = { ...s.thresholds, regressionMinutes: 0, spikeMinutes: 1.5 };
    const r = validateSettings(s);
    expect(r.errors).toContainEqual({
      field: 'thresholds.regressionMinutes',
      message: "Couldn't save: regression minutes must be a whole number of 1 or more.",
    });
    expect(r.errors.map((e) => e.field)).toContain('thresholds.spikeMinutes');
  });
  it('caps endpoints at 10 and checks each endpoint', () => {
    const s = base();
    s.notifications = Array.from({ length: MAX_NOTIFICATION_ENDPOINTS + 1 }, (_, i) => endpoint({ id: `e${i}` }));
    expect(validateSettings(s).errors.map((e) => e.field)).toContain('notifications');
    s.notifications = [
      endpoint({ id: 'a', name: ' ', format: 'pagerduty' as never, minSeverity: 'urgent' as never }),
      endpoint({ id: 'a' }),
    ];
    const fields = validateSettings(s).errors.map((e) => e.field);
    expect(fields).toEqual(
      expect.arrayContaining(['notifications[0].name', 'notifications[0].format', 'notifications[0].minSeverity', 'notifications[1].id']),
    );
  });
  it('checks the zone, periods and QR link', () => {
    const s = base();
    s.displayTimezone = 'Mars/Base';
    s.headlinePeriodDefault = 'week' as never;
    s.presenter = { headlinePeriod: 'forever' as never, qrUrl: 'ftp://x' };
    const fields = validateSettings(s).errors.map((e) => e.field);
    expect(fields).toEqual(['displayTimezone', 'headlinePeriodDefault', 'presenter.headlinePeriod', 'presenter.qrUrl']);
  });
  it('survives a structurally broken document', () => {
    const r = validateSettings({ displayTimezone: 'UTC', headlinePeriodDefault: 'mtd', presenter: { headlinePeriod: 'mtd' } } as unknown as Settings);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(5);
  });
});

describe('hostFromUrl', () => {
  it('extracts the hostname of https URLs only', () => {
    expect(hostFromUrl('https://hooks.slack.com/services/x')).toBe('hooks.slack.com');
    expect(hostFromUrl('https://Example.COM:8443/p?q')).toBe('example.com');
    expect(hostFromUrl('https://webhook.site')).toBe('webhook.site');
    expect(hostFromUrl('http://hooks.slack.com/')).toBeUndefined();
    expect(hostFromUrl('not a url')).toBeUndefined();
    expect(hostFromUrl(undefined as unknown as string)).toBeUndefined();
  });
  it('is not a webhook URL when it carries a user name or password (README: no password stored in plain text)', () => {
    expect(hostFromUrl('https://svc:P4ssw0rd@relay.example.com/hook')).toBeUndefined();
    expect(hostFromUrl('https://User@Example.COM:8443/p?q')).toBeUndefined();
    // An '@' after the host (a path, a query, a fragment) is not userinfo.
    expect(hostFromUrl('https://relay.example.com/hook?to=ops@example.com')).toBe('relay.example.com');
    expect(hostFromUrl('https://relay.example.com/users/@ops')).toBe('relay.example.com');
    expect(hostFromUrl('https://relay.example.com#a@b')).toBe('relay.example.com');
  });
});

describe('URL credentials (P1-G04)', () => {
  const USERINFO = 'https://svc:P4ssw0rd@relay.example.com/hook';

  it('urlHasCredentials sees userinfo before the first "/", "?" or "#" only', () => {
    expect(urlHasCredentials(USERINFO)).toBe(true);
    expect(urlHasCredentials('https://token@hooks.slack.com/services/x')).toBe(true);
    expect(urlHasCredentials('  HTTPS://a:b@c.example.com ')).toBe(true);
    expect(urlHasCredentials('https://hooks.slack.com/services/x')).toBe(false);
    expect(urlHasCredentials('https://relay.example.com/hook?to=ops@example.com')).toBe(false);
    expect(urlHasCredentials('https://relay.example.com/@ops')).toBe(false);
    expect(urlHasCredentials('')).toBe(false);
    expect(urlHasCredentials(undefined as unknown as string)).toBe(false);
  });

  it('validateSettings refuses a userinfo URL as it refuses every webhook URL (D57)', () => {
    const s: Settings = { ...defaultSettings(NOW, TZ), notifications: [webhook({ url: USERINFO, host: 'relay.example.com' })] };
    const r = validateSettings(s);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([{ field: 'notifications[0].url', message: WEBHOOK_NOT_STORED_MESSAGE }]);
  });

  it('deliver() refuses a userinfo URL without sending anything', async () => {
    const posts: string[] = [];
    const sender: WebhookSender = {
      async post(url) {
        posts.push(url);
        return { status: 200 };
      },
    };
    const logs = await deliver({ sender, url: USERINFO, body: {}, clock: { now: () => Date.parse(NOW) }, endpointId: 'ep1', event: 'test' });
    expect(posts).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ endpointId: 'ep1', status: 0, attempt: 1, error: 'invalid_url' });
    expect(logs[0].detail).toMatch(/credentials/i);
    // The log never repeats the secret.
    expect(JSON.stringify(logs)).not.toContain('P4ssw0rd');
  });
});

describe('mergeSettings', () => {
  const defaults = defaultSettings(NOW, TZ);
  it('keeps stored values and fills missing ones', () => {
    const stored = {
      displayTimezone: 'Europe/London',
      thresholds: { regressionPoints: 20 },
      demo: { enabled: true },
      budgets: { mrd_siem_prod: { centsPerMonth: 100_000 }, bad: { centsPerMonth: 'x' } },
      humanize: { a: 'A', b: 3 },
      criblCostCentsPerMonth: 5_000_000,
      runtime: 'backend',
      notifications: [{ id: 'e', url: 'https://webhook.site/abc', format: 'generic' }, { nope: true }],
      excludedObjectKeys: ['in:default:x', 7],
    };
    const m = mergeSettings(stored, defaults);
    expect(m.displayTimezone).toBe('Europe/London');
    expect(m.thresholds.regressionPoints).toBe(20);
    expect(m.thresholds.recoveryMinutes).toBe(5);
    expect(m.demo).toEqual({ enabled: true, replayMode: false, profile: true });
    expect(m.budgets).toEqual({ mrd_siem_prod: { centsPerMonth: 100_000 } });
    expect(m.humanize).toEqual({ a: 'A' });
    expect(m.criblCostCentsPerMonth).toBe(5_000_000);
    expect(m.runtime).toBe('backend');
    // D57: a stored direct webhook (a build before 1.0.14 could write one) is dropped on read, URL and all.
    expect(m.notifications).toEqual([]);
    const withTarget = mergeSettings({ notifications: [{ id: 't', url: 'https://leak.example.com/x', channel: 'cribl-target', criblTargetId: 'ops' }] }, defaults);
    expect(withTarget.notifications).toEqual([
      { id: 't', name: '', url: '', host: '', format: 'generic', minSeverity: 'medium', weeklyReceipt: true, enabled: true, channel: 'cribl-target', criblTargetId: 'ops' },
    ]);
    expect(m.excludedObjectKeys).toEqual(['in:default:x']);
    expect(m.live).toEqual(defaults.live);
  });
  it('replaces mistyped values with defaults', () => {
    const m = mergeSettings(
      { thresholds: { spikeSigma: 'three' }, live: { pollSeconds: null }, displayTimezone: 'Bad/Zone', headlinePeriodDefault: 'x', runtime: 'cloud' },
      defaults,
    );
    expect(m.thresholds.spikeSigma).toBe(3);
    expect(m.live.pollSeconds).toBe(10);
    expect(m.displayTimezone).toBe(TZ);
    expect(m.headlinePeriodDefault).toBe('annualized');
    expect(m.runtime).toBe('ui');
  });
  it('never migrates a stored headline period: a stored \'mtd\' stays the member\'s (r2 ui-2, ruling 5)', () => {
    expect(defaults.headlinePeriodDefault).toBe('annualized');
    expect(mergeSettings({ headlinePeriodDefault: 'mtd' }, defaults).headlinePeriodDefault).toBe('mtd');
    expect(mergeSettings({ headlinePeriodDefault: 'today' }, defaults).headlinePeriodDefault).toBe('today');
    // A settings document without the field (an older build's partial write) takes the new default.
    expect(mergeSettings({ displayTimezone: TZ }, defaults).headlinePeriodDefault).toBe('annualized');
  });
  it('returns defaults for non-objects', () => {
    expect(mergeSettings(null, defaults)).toEqual(defaults);
    expect(mergeSettings([1, 2], defaults)).toEqual(defaults);
  });
  it('is idempotent on a full document', () => {
    const full = { ...defaults, criblCostCentsPerMonth: 1, notifications: [endpoint({ lastTest: { at: NOW, status: 200, hostAuthorized: true } })] };
    expect(mergeSettings(full, defaults)).toEqual(full);
  });
});

describe('normalizeEndpoint', () => {
  it('fills defaults and derives the host', () => {
    expect(normalizeEndpoint({ id: 'x', url: 'https://a.example.com/h', host: 'stale' })).toMatchObject({
      host: 'a.example.com',
      format: 'generic',
      minSeverity: 'medium',
      weeklyReceipt: true,
      enabled: true,
    });
    expect(normalizeEndpoint({ id: 'x', url: 'bad', host: 'kept' }).host).toBe('kept');
    expect(normalizeEndpoint({ id: 'x', url: 'bad' }).host).toBe('');
  });
});

describe('migrateSettings', () => {
  it('parses JSON strings and fills defaults', () => {
    const m = migrateSettings(JSON.stringify({ schemaVersion: 1, displayTimezone: 'UTC' }), NOW, TZ);
    expect(m.displayTimezone).toBe('UTC');
    expect(m.thresholds.warmupSamples).toBe(10);
  });
  it('fixes the v1.1 five-minute alpha on pre-v1 documents only', () => {
    expect(migrateSettings({ thresholds: { ewmaAlpha: 0.2 } }, NOW, TZ).thresholds.ewmaAlpha).toBe(0.0014);
    expect(migrateSettings({ schemaVersion: 0, thresholds: { ewmaAlpha: 0.01 } }, NOW, TZ).thresholds.ewmaAlpha).toBe(0.01);
    expect(migrateSettings({ schemaVersion: 1, thresholds: { ewmaAlpha: 0.2 } }, NOW, TZ).thresholds.ewmaAlpha).toBe(0.2);
    expect(migrateSettings({ schemaVersion: 0 }, NOW, TZ).thresholds.ewmaAlpha).toBe(0.0014);
  });
  it('returns defaults for garbage', () => {
    expect(migrateSettings('{not json', NOW, TZ)).toEqual(defaultSettings(NOW, TZ));
    expect(migrateSettings(42)).toEqual(defaultSettings('1970-01-01T00:00:00.000Z', 'UTC'));
  });
});
