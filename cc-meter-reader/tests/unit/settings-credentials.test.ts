// Hackathon rule 4.5 (D57): a member's input in the release UI can never put a credential into plain App KV.
//
// The one free-text field a member types that reaches KV is a notification target's id (Settings → Where to send
// alerts → Target id). A judge typed a Slack incoming-webhook URL there and it was stored. Three layers now close
// it: validateSettings refuses it (under the Target id field, with the webhook copy), storableSettings drops it on
// every write (the Settings screen, the runner's --setup, a backend), and mergeSettings drops it on every read.
// The same holds for an endpoint's name and id, a humanize label, and a webhook address as the presenter QR.

import { describe, expect, it } from 'vitest';
import type { NotificationEndpoint, Settings } from '../../core/types.ts';
import {
  CREDENTIAL_NOT_STORED_MESSAGE,
  CRIBL_ID_PATTERN,
  DEFAULT_QR_URL,
  UNKNOWN_TARGET_MESSAGE,
  TARGET_ID_SHAPE_MESSAGE,
  WEBHOOK_NOT_STORED_MESSAGE,
  defaultSettings,
  isStorableTargetId,
  isWebhookUrl,
  looksLikeCredentialText,
  looksLikeSecretToken,
  mergeSettings,
  normalizeEndpoint,
  storableSettings,
  unstorableSettingsCount,
  validateSettings,
} from '../../core/settings.ts';
import { createKvDocs, createMemoryKvStore } from '../../core/kv.ts';
import { identityCodec } from '../../core/codec.ts';
import { storedWebhookCount } from '../../scripts/runner.ts';
import { createEndpointId } from '../../src/components/EndpointEditor/model.ts';

const NOW = '2026-09-27T12:00:00.000Z';
// Fake, assembled at run time: shaped like a Slack incoming webhook, never a real one.
const SLACK_URL = ['https:/', 'hooks.slack.com', 'services', 'T0FAKE000', 'B0FAKE000', 'fakeTokenNotReal0000'].join('/');
const SLACK_BARE = SLACK_URL.replace('https://', '');
const BOT_TOKEN = ['xoxb', '000000000000', '000000000000', 'fakefakefakefake'].join('-');
const AWS_KEY = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');

const target = (over: Partial<NotificationEndpoint> = {}): NotificationEndpoint => ({
  id: 'ep1',
  name: 'FinOps alerts',
  url: '',
  host: '',
  format: 'generic',
  minSeverity: 'medium',
  weeklyReceipt: true,
  enabled: true,
  channel: 'cribl-target',
  criblTargetId: 'finops_slack',
  ...over,
});
const bell = (): NotificationEndpoint => ({ ...target({ id: 'bell', name: 'Cribl notifications' }), channel: 'cribl-bell', criblTargetId: undefined });
const doc = (notifications: NotificationEndpoint[], over: Partial<Settings> = {}): Settings => ({ ...defaultSettings(NOW, 'UTC'), notifications, ...over });

describe('the target id (rule 4.5: the field a judge typed a webhook URL into)', () => {
  it('validateSettings refuses a webhook URL as the target id, under the Target id field, with the webhook copy', () => {
    const r = validateSettings(doc([target({ criblTargetId: SLACK_URL })]));
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([{ field: 'notifications[0].criblTargetId', message: WEBHOOK_NOT_STORED_MESSAGE }]);
  });

  it('refuses every URL, scheme-less address, userinfo and token as the target id', () => {
    for (const bad of [SLACK_URL, SLACK_BARE, 'http://relay.example.com/x', 'https://svc:pw@relay.example.com', 'svc:pw@relay.example.com', BOT_TOKEN, 'AbCdEfGhIjKlMnOpQrSt123']) { // gitleaks:allow (synthetic token-shaped test inputs)
      const r = validateSettings(doc([target({ criblTargetId: bad })]));
      expect(r.errors, bad.slice(0, 12)).toEqual([{ field: 'notifications[0].criblTargetId', message: WEBHOOK_NOT_STORED_MESSAGE }]);
    }
  });

  it('refuses an id that is not shaped like a Cribl id with its own copy', () => {
    for (const bad of ['ops slack', 'ops.slack', 'ops/slack', 'ops@slack', 'x'.repeat(513)]) {
      const r = validateSettings(doc([target({ criblTargetId: bad })]));
      expect(r.errors, bad.slice(0, 12)).toEqual([{ field: 'notifications[0].criblTargetId', message: TARGET_ID_SHAPE_MESSAGE }]);
    }
    // A blank id is still "choose a target".
    expect(validateSettings(doc([target({ criblTargetId: '' })])).errors[0].message).toBe("Couldn't save: choose a Cribl notification target.");
  });

  it('accepts every real Cribl target id shape', () => {
    for (const ok of ['system_notifications', 'finops_slack', 'ops-slack', 'mrd_webhook_site', 't', 'OpsPager2', 'x'.repeat(512)]) {
      expect(validateSettings(doc([target({ criblTargetId: ok })])).ok, ok).toBe(true);
      expect(isStorableTargetId(ok), ok).toBe(true);
      expect(CRIBL_ID_PATTERN.test(ok), ok).toBe(true);
    }
  });

  it('normalizeEndpoint keeps what was typed, so validation can say what is wrong with it (the editor builds with it)', () => {
    expect(normalizeEndpoint({ id: 'ep1', url: '', channel: 'cribl-target', criblTargetId: SLACK_URL }).criblTargetId).toBe(SLACK_URL);
  });

  it('storableSettings drops a target whose id is not a Cribl id: nothing a writer builds stores it', () => {
    const out = storableSettings(doc([target({ id: 'a', criblTargetId: SLACK_URL }), target({ id: 'b', criblTargetId: 'ops slack' }), target({ id: 'c' }), bell()]));
    expect(out.notifications.map((e) => e.id)).toEqual(['c', 'bell']);
    expect(JSON.stringify(out)).not.toContain('hooks.slack.com');
    expect(validateSettings(out).ok).toBe(true);
  });

  it('mergeSettings drops it on read (a document an older build wrote)', () => {
    const defaults = defaultSettings(NOW, 'UTC');
    const merged = mergeSettings({ ...defaults, notifications: [target({ criblTargetId: SLACK_URL }), target({ id: 'ok' })] }, defaults);
    expect(merged.notifications.map((e) => e.id)).toEqual(['ok']);
    expect(JSON.stringify(merged)).not.toContain('hooks.slack.com');
  });

  it('end to end through the KV documents: the stored value never holds the URL', async () => {
    const kv = createMemoryKvStore();
    const docs = createKvDocs({ kv, codec: identityCodec, clock: { now: () => 0 } });
    await docs.putSettings(doc([target({ criblTargetId: SLACK_URL }), target({ id: 'ok' })]));
    expect(JSON.stringify([...kv.data.values()])).not.toContain('hooks.slack.com');
    expect((await docs.getSettings())?.notifications.map((e) => e.id)).toEqual(['ok']);
  });
});

describe('free text in the settings document (endpoint name and id, humanize labels, presenter QR)', () => {
  it('validateSettings refuses a URL or a token as an endpoint name or id', () => {
    expect(validateSettings(doc([target({ name: SLACK_URL })])).errors).toEqual([{ field: 'notifications[0].name', message: WEBHOOK_NOT_STORED_MESSAGE }]);
    expect(validateSettings(doc([target({ name: `Ops (${SLACK_BARE})` })])).errors).toEqual([{ field: 'notifications[0].name', message: WEBHOOK_NOT_STORED_MESSAGE }]);
    expect(validateSettings(doc([target({ id: SLACK_URL })])).errors).toEqual([{ field: 'notifications[0].id', message: WEBHOOK_NOT_STORED_MESSAGE }]);
    // Names people give are fine, slashes and dots included.
    for (const ok of ['FinOps alerts', 'Payments API / sampling', 'On-call (P1)', 'S3 us-east-1', 'Splunk Cloud v2.1', 'ops@example team']) {
      expect(validateSettings(doc([target({ name: ok })])).ok, ok).toBe(true);
    }
  });

  it('storableSettings replaces a URL name with the target id and drops an endpoint whose id is a URL', () => {
    const out = storableSettings(doc([target({ id: 'a', name: SLACK_URL }), target({ id: SLACK_URL })]));
    expect(out.notifications.map((e) => [e.id, e.name])).toEqual([['a', 'finops_slack']]);
    expect(JSON.stringify(out)).not.toContain('hooks.slack.com');
  });

  it('a URL or token as a humanize label (or its key) is refused, dropped on write and dropped on read', () => {
    const s = doc([], { humanize: { mrd_pay: 'Payments API', mrd_x: SLACK_URL, [SLACK_BARE]: 'x', mrd_t: BOT_TOKEN } });
    expect(validateSettings(s).errors).toEqual([
      { field: 'humanize', message: WEBHOOK_NOT_STORED_MESSAGE },
      { field: 'humanize', message: WEBHOOK_NOT_STORED_MESSAGE },
      { field: 'humanize', message: WEBHOOK_NOT_STORED_MESSAGE },
    ]);
    expect(storableSettings(s).humanize).toEqual({ mrd_pay: 'Payments API' });
    expect(mergeSettings(s, defaultSettings(NOW, 'UTC')).humanize).toEqual({ mrd_pay: 'Payments API' });
  });

  it('a webhook address is never the presenter QR: refused, and the default stands in on write and read', () => {
    const s = doc([], { presenter: { headlinePeriod: 'annualized', qrUrl: SLACK_URL } });
    expect(validateSettings(s).errors).toEqual([{ field: 'presenter.qrUrl', message: WEBHOOK_NOT_STORED_MESSAGE }]);
    expect(storableSettings(s).presenter.qrUrl).toBe(DEFAULT_QR_URL);
    expect(mergeSettings(s, defaultSettings(NOW, 'UTC')).presenter.qrUrl).toBe(DEFAULT_QR_URL);
    // Public links stay: the group, a repository, any page.
    for (const ok of ['https://www.linkedin.com/groups/13052739', DEFAULT_QR_URL, 'https://example.com/meter-reader?utm_source=qr']) {
      expect(isWebhookUrl(ok), ok).toBe(false);
      expect(storableSettings(doc([], { presenter: { headlinePeriod: 'mtd', qrUrl: ok } })).presenter.qrUrl).toBe(ok);
    }
  });

  it('an id the editor generates is never mistaken for a token (it would be dropped on save)', () => {
    for (let i = 0; i < 1000; i++) expect(looksLikeCredentialText(createEndpointId())).toBe(false);
    // The fallback shape, without crypto.randomUUID: 'ep-<base36 time>-<8 base36>'.
    const saved = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
      for (let i = 0; i < 1000; i++) {
        const id = createEndpointId();
        expect(id.startsWith('ep-')).toBe(true);
        expect(looksLikeCredentialText(id)).toBe(false);
      }
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: saved, configurable: true });
    }
  });

  it('a lastTest carries only its three fields', () => {
    const e = { ...target(), lastTest: { at: NOW, status: 200, hostAuthorized: true, url: SLACK_URL } } as NotificationEndpoint;
    const out = storableSettings(doc([e]));
    expect(out.notifications[0].lastTest).toEqual({ at: NOW, status: 200, hostAuthorized: true });
  });

  it('looksLikeCredentialText: URLs, scheme-less webhook addresses, userinfo and tokens, never ordinary words', () => {
    for (const bad of [SLACK_URL, SLACK_BARE, 'ftp://x', 'user:pass@host.example.com', BOT_TOKEN, 'ghp_abc', AWS_KEY, 'Bearer abc']) {
      expect(looksLikeCredentialText(bad), bad.slice(0, 8)).toBe(true);
    }
    for (const ok of ['', 'finops_slack', 'Payments API / sampling', 'route:default:mrd_pay', 'ops@example team', 'splunk_hec_2026_primary', undefined]) {
      expect(looksLikeCredentialText(ok), String(ok)).toBe(false);
    }
  });

  it('the runner counts what it must purge from a stored document (and a clean document is 0)', () => {
    const dirty = doc([target({ id: 'a', criblTargetId: SLACK_URL }), target({ id: 'b', name: SLACK_URL }), target({ id: 'c' })], {
      humanize: { a: SLACK_URL, b: 'fine' },
      presenter: { headlinePeriod: 'mtd', qrUrl: SLACK_URL },
    });
    expect(unstorableSettingsCount(dirty)).toBe(4);
    expect(storedWebhookCount(dirty)).toBe(4);
    expect(unstorableSettingsCount(storableSettings(dirty))).toBe(0);
    expect(unstorableSettingsCount(defaultSettings(NOW, 'UTC'))).toBe(0);
  });
});

// Rules round 2 (a judge's tsx and Playwright probes): common token shapes still saved into plain KV — a UUID (the
// Splunk and Cribl HEC token format) or a 32-character hex key (a PagerDuty integration or routing key, a Datadog API
// key) typed as the Target id, and a SendGrid key, a JWT or a password typed as the endpoint name. Every value below
// is fake, assembled at run time.
const UUID = ['6f0b2a1c', '3d4e', '4f5a', '8b9c', '0d1e2f3a4b5c'].join('-');
const HEX32 = ['e93facc0', '4764012d', '7bfb0025', '00d5d1a6'].join('');
const HEX32_UPPER = HEX32.toUpperCase();
const SENDGRID = ['SG', 'abcDEF123fake', 'xyzXYZ456fake'].join('.');
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJmYWtlIn0', 'ZmFrZXNpZw'].join('.');
const PASSWORD = ['P@ss', 'w0rd!', '2026'].join('');
const STRIPE = ['sk', 'live', 'fakefakefake123'].join('_');
const LOWER_KEY = ['abcdefghij', 'klmnopqrst', 'uv12'].join('');

describe('rules round 2: token shapes as a target id, a name or a label (rule 4.5)', () => {
  it('refuses a UUID, a 32-character hex key (either case) or a long lowercase key as the target id, with the credential copy', () => {
    for (const bad of [UUID, HEX32, HEX32_UPPER, LOWER_KEY, STRIPE]) {
      const r = validateSettings(doc([target({ criblTargetId: bad })]));
      expect(r.errors, bad.slice(0, 8)).toEqual([{ field: 'notifications[0].criblTargetId', message: CREDENTIAL_NOT_STORED_MESSAGE }]);
      expect(isStorableTargetId(bad), bad.slice(0, 8)).toBe(false);
    }
  });

  it('a SendGrid key or a JWT as the target id is refused too (their dots fail the id shape first)', () => {
    for (const bad of [SENDGRID, JWT]) expect(validateSettings(doc([target({ criblTargetId: bad })])).ok, bad.slice(0, 6)).toBe(false);
  });

  it('refuses a SendGrid key, a JWT, a password, a UUID or a hex key as the endpoint name, with the credential copy', () => {
    for (const bad of [SENDGRID, JWT, PASSWORD, UUID, HEX32, `PagerDuty ${HEX32}`]) {
      const r = validateSettings(doc([target({ name: bad })]));
      expect(r.errors, bad.slice(0, 8)).toEqual([{ field: 'notifications[0].name', message: CREDENTIAL_NOT_STORED_MESSAGE }]);
    }
  });

  it('storableSettings and mergeSettings drop such a target and replace such a name: none reaches KV or a reader', async () => {
    const dirty = doc([
      target({ id: 'a', criblTargetId: UUID }),
      target({ id: 'b', criblTargetId: HEX32 }),
      target({ id: 'c', name: SENDGRID }),
      target({ id: 'd', name: JWT }),
      target({ id: 'e', name: PASSWORD }),
    ]);
    const out = storableSettings(dirty);
    expect(out.notifications.map((e) => [e.id, e.name])).toEqual([
      ['c', 'finops_slack'],
      ['d', 'finops_slack'],
      ['e', 'finops_slack'],
    ]);
    expect(unstorableSettingsCount(dirty)).toBe(5);
    expect(unstorableSettingsCount(out)).toBe(0);
    const merged = mergeSettings(dirty, defaultSettings(NOW, 'UTC'));
    expect(merged.notifications.map((e) => e.id)).toEqual(['c', 'd', 'e']);
    const kv = createMemoryKvStore();
    const docs = createKvDocs({ kv, codec: identityCodec, clock: { now: () => 0 } });
    await docs.putSettings(dirty);
    const stored = JSON.stringify([...kv.data.values()]);
    for (const secret of [UUID, HEX32, SENDGRID, JWT, PASSWORD]) expect(stored, secret.slice(0, 6)).not.toContain(secret);
  });

  it('a token as a humanize label or key is refused with the credential copy and dropped on write and read', () => {
    const s = doc([], { humanize: { mrd_pay: 'Payments API', mrd_x: UUID, [HEX32]: 'x' } });
    expect(validateSettings(s).errors).toEqual([
      { field: 'humanize', message: CREDENTIAL_NOT_STORED_MESSAGE },
      { field: 'humanize', message: CREDENTIAL_NOT_STORED_MESSAGE },
    ]);
    expect(storableSettings(s).humanize).toEqual({ mrd_pay: 'Payments API' });
    expect(mergeSettings(s, defaultSettings(NOW, 'UTC')).humanize).toEqual({ mrd_pay: 'Payments API' });
  });

  it('never refuses the names and ids people give (Cribl ids, labels with spaces, symbols or a version)', () => {
    const ok = [
      'system_notifications', 'finops_slack', 'ops-slack', 'mrd_webhook_site', 'OpsPager2', 'x'.repeat(512), 'splunk_hec_2026_primary',
      'pack:cribl_splunk_forwarder_windows_xml_events_to_json', 'mrd_windows_workstations', 'cribl-palo-alto-networks', 'sk_ops', 'risk_team_2026',
      'FinOps alerts', 'Payments API / sampling', 'On-call (P1)', 'S3 us-east-1', 'Splunk Cloud v2.1', 'Slack #ops-alerts', 'Team A/B #2', 'Ops+SRE', 'SOC-Tier2',
    ];
    for (const v of ok) expect(looksLikeSecretToken(v), v.slice(0, 20)).toBe(false);
    for (const id of ok.filter((v) => CRIBL_ID_PATTERN.test(v))) expect(validateSettings(doc([target({ criblTargetId: id })])).ok, id.slice(0, 20)).toBe(true);
    for (const name of ok) expect(validateSettings(doc([target({ name })])).ok, name.slice(0, 20)).toBe(true);
  });

  it("an endpoint's own id stays a UUID (the editor generates one): only member-typed text gets the token screen", () => {
    const e = target({ id: UUID });
    expect(validateSettings(doc([e])).ok).toBe(true);
    expect(storableSettings(doc([e])).notifications.map((x) => x.id)).toEqual([UUID]);
  });

  it('when Cribl lists its targets, a typed id it does not list is refused; without the list only the shape decides', () => {
    const s = doc([target({ criblTargetId: 'ops_pager' })]);
    expect(validateSettings(s).ok).toBe(true);
    expect(validateSettings(s, { knownTargetIds: ['finops_slack', 'ops_pager'] }).ok).toBe(true);
    expect(validateSettings(s, { knownTargetIds: ['finops_slack'] }).errors).toEqual([{ field: 'notifications[0].criblTargetId', message: UNKNOWN_TARGET_MESSAGE }]);
    // An empty list (Cribl lists no target) refuses every typed id.
    expect(validateSettings(s, { knownTargetIds: [] }).ok).toBe(false);
  });
});

// Rules round 2 (craft, usefulness): the core halves of two Settings features. "Did it arrive?" stores when a member
// confirmed a target's test alert (the relay's 200 only says Cribl accepted it); "Use this estimate" marks a Cribl
// cost taken from the list price × measured ingest. Neither field can carry anything but what it says.
describe('confirmedAt and criblCostEstimate', () => {
  it('a target keeps its confirmation only for the id it confirmed, with an ISO time, through write and read', () => {
    const ok = target({ confirmedAt: NOW, confirmedTargetId: 'finops_slack' });
    expect(storableSettings(doc([ok])).notifications[0]).toMatchObject({ confirmedAt: NOW, confirmedTargetId: 'finops_slack' });
    expect(mergeSettings(doc([ok]), defaultSettings(NOW, 'UTC')).notifications[0].confirmedAt).toBe(NOW);
    for (const bad of [
      target({ confirmedAt: NOW, confirmedTargetId: 'other_target' }), // the target changed since
      target({ confirmedAt: 'yesterday', confirmedTargetId: 'finops_slack' }),
      target({ confirmedAt: SLACK_URL, confirmedTargetId: 'finops_slack' }),
      target({ confirmedAt: NOW }),
    ]) {
      const kept = storableSettings(doc([bad])).notifications[0];
      expect(kept.confirmedAt).toBeUndefined();
      expect(kept.confirmedTargetId).toBeUndefined();
    }
  });

  it('criblCostEstimate stays only beside a cost it describes', () => {
    const d = defaultSettings(NOW, 'UTC');
    expect(mergeSettings({ ...d, criblCostCentsPerMonth: 1_000_00, criblCostEstimate: true }, d).criblCostEstimate).toBe(true);
    expect(mergeSettings({ ...d, criblCostEstimate: true }, d).criblCostEstimate).toBeUndefined();
    expect(mergeSettings({ ...d, criblCostCentsPerMonth: 1_000_00, criblCostEstimate: 'yes' }, d).criblCostEstimate).toBeUndefined();
  });
});
