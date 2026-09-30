import { describe, expect, it } from 'vitest';
import type { CanonicalPayload, Incident, WeeklyReceipt } from '../../core/types.ts';
import {
  CATCH_UP_NOTE,
  canonicalPayload,
  caughtInSeconds,
  caughtLine,
  genericPayload,
  isCatchUp,
  incidentPlainText,
  ledgerLink,
  payloadFor,
  servicenowPayload,
  slackGlyph,
  slackPayload,
  testPayload,
  type SlackMessage,
} from '../../core/payloads.ts';
import { receiptText } from '../../core/receipt.ts';

const LINK_BASE = 'https://main-org.cribl.cloud/apps/a/meter-reader/';
const regression = (over: Partial<Incident> = {}): Incident => ({
  id: 'inc_7f3a00',
  type: 'regression',
  severity: 'high',
  objectKey: 'pipe:default:mrd_pay_sample',
  label: 'Payments API sampling',
  outputId: 'mrd_siem_prod',
  openedAt: '2026-09-30T16:42:03.000Z',
  cause: 'commit',
  commit: {
    hash: 'a1f3c9e0123456789',
    message: 'demo: break the trim on mrd_pay_sample',
    author: 's.koelpin',
    committedAt: '2026-09-30T16:39:00.000Z',
    deployedAt: '2026-09-30T16:39:12.000Z',
    groupId: 'default',
    match: 'files',
  },
  before: 0.75,
  after: 0.5,
  impactPerDayM: 2_500_000,
  caughtInSec: 171,
  notes: ['demo-profile'],
  deliveries: [],
  ...over,
});

const texts = (m: SlackMessage): string => JSON.stringify(m.blocks);

describe('canonicalPayload (SPEC 12.1)', () => {
  it('matches the SPEC example shape', () => {
    const p = canonicalPayload('incident.opened', { incident: regression(), workspace: 'main', linkBase: LINK_BASE, sentAt: '2026-09-30T16:44:03.000Z' });
    expect(p).toEqual({
      schemaVersion: 1,
      app: 'meter-reader',
      event: 'incident.opened',
      sentAt: '2026-09-30T16:44:03.000Z',
      workspace: 'main',
      incident: {
        id: 'inc_7f3a00',
        type: 'regression',
        severity: 'high',
        title: 'Savings dropped: Payments API sampling',
        object: { kind: 'pipeline', id: 'mrd_pay_sample', label: 'Payments API sampling', group: 'default', destination: 'mrd_siem_prod' },
        before: { ratio: 0.75 },
        after: { ratio: 0.5 },
        impact: { perDayMillicents: 2_500_000, perDay: '$25', perYear: '$9,125' },
        cause: 'commit',
        commit: { hash: 'a1f3c9e0123456789', message: 'demo: break the trim on mrd_pay_sample', author: 's.koelpin', deployedAt: '2026-09-30T16:39:12.000Z', match: 'files' },
        caughtInSeconds: 171,
        openedAt: '2026-09-30T16:42:03.000Z',
        link: 'https://main-org.cribl.cloud/apps/a/meter-reader/ledger?object=pipe:default:mrd_pay_sample',
        notes: ['demo-profile'],
      },
    });
  });
  it('maps object kinds, value-typed before/after, closures and missing optional fields', () => {
    const spike = canonicalPayload('incident.closed', {
      incident: regression({ type: 'spike', objectKey: 'in:default:mrd_payments_api', before: 1_000_000, after: 5_000_000, closedAt: '2026-09-30T17:00:00.000Z', commit: undefined, cause: undefined, caughtInSec: undefined, outputId: undefined, label: '' }),
      workspace: 'w',
      linkBase: '',
    });
    expect(spike.incident).toMatchObject({ object: { kind: 'input', id: 'mrd_payments_api', label: 'Payments API', group: 'default' }, before: { value: 1_000_000 }, after: { value: 5_000_000 }, closedAt: '2026-09-30T17:00:00.000Z' });
    expect(spike.incident?.object.destination).toBeUndefined();
    expect(spike.incident?.commit).toBeUndefined();
    expect(spike.incident?.caughtInSeconds).toBeUndefined();
    expect(spike.incident?.link).toBe('/ledger?object=in:default:mrd_payments_api');
    expect(Date.parse(spike.sentAt)).not.toBeNaN();
    const route = canonicalPayload('incident.opened', { incident: regression({ objectKey: 'route:default:r pay', commit: { ...regression().commit!, deployedAt: undefined } }), workspace: 'w', linkBase: 'x' });
    expect(route.incident?.object.kind).toBe('route');
    expect(route.incident?.link).toBe('x/ledger?object=route:default:r%20pay');
    expect(route.incident?.commit?.deployedAt).toBeUndefined();
    const out = canonicalPayload('incident.opened', { incident: regression({ type: 'budget', objectKey: 'out:default:mrd_siem_prod' }), workspace: 'w', linkBase: '' });
    expect(out.incident?.object.kind).toBe('output');
    const junk = canonicalPayload('incident.opened', { incident: regression({ objectKey: 'junk' }), workspace: 'w', linkBase: '' });
    expect(junk.incident?.object).toMatchObject({ kind: 'route', id: 'junk', group: '' });
  });
  it('builds links with or without a trailing slash', () => {
    expect(ledgerLink('https://a/b/', 'pipe:g:x')).toBe('https://a/b/ledger?object=pipe:g:x');
    expect(ledgerLink(undefined as unknown as string, 'pipe:g:x')).toBe('/ledger?object=pipe:g:x');
  });
});

describe('slackPayload', () => {
  const opened = canonicalPayload('incident.opened', { incident: regression(), workspace: 'main', linkBase: LINK_BASE, sentAt: 'x' });

  it('renders header, money first, commit second, context and one button', () => {
    const m = slackPayload(opened, { tz: 'America/Chicago' });
    expect(m.text).toBe(':red_circle: Savings dropped: Payments API sampling · $25 a day · $9,125 a year if left');
    expect(m.blocks.map((b) => b.type)).toEqual(['header', 'section', 'context', 'actions']);
    expect(m.blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: ':red_circle: Savings dropped: Payments API sampling', emoji: true } });
    const fields = (m.blocks[1] as { fields: { text: string }[] }).fields.map((f) => f.text);
    expect(fields).toEqual([
      '*Lost per day*\n$25',
      '*Per year if left*\n$9,125',
      '*Commit*\n`a1f3c9e` demo: break the trim on mrd_pay_sample',
      '*By*\ns.koelpin',
      '*Before*\n75%',
      '*After*\n50%',
    ]);
    expect(m.blocks[2]).toEqual({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Meter Reader by Steve Koelpin · SIEM (prod) · 11:42 AM · caught in 2:51 · 1-minute confirmation (demo profile). Default is 3.' }],
    });
    expect(m.blocks[3]).toEqual({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Ledger' }, url: 'https://main-org.cribl.cloud/apps/a/meter-reader/ledger?object=pipe:default:mrd_pay_sample', action_id: 'open_in_ledger' }],
    });
  });
  it('says Recovered for closed incidents, with a green glyph', () => {
    const closed = canonicalPayload('incident.closed', { incident: regression({ closedAt: '2026-09-30T16:55:00.000Z', notes: [] }), workspace: 'w', linkBase: '' });
    const m = slackPayload(closed);
    expect(m.blocks[0]).toMatchObject({ text: { text: ':large_green_circle: Recovered: Savings dropped: Payments API sampling' } });
    expect(texts(m)).toContain('Was losing per day');
    expect(texts(m)).toContain('Meter Reader by Steve Koelpin · SIEM (prod) · 4:55 PM UTC');
    expect(texts(m)).not.toContain('caught in');
  });
  it('D47: a recovered message keeps the drop and states where it recovered to; one closed before D47 states only the recovery', () => {
    const closedAt = '2026-09-30T16:55:00.000Z';
    const closed = canonicalPayload('incident.closed', { incident: regression({ closedAt, recoveredTo: 0.89, notes: [] }), workspace: 'w', linkBase: '' });
    expect(closed.incident).toMatchObject({ before: { ratio: 0.75 }, after: { ratio: 0.5 }, recoveredTo: { ratio: 0.89 } });
    const fields = (slackPayload(closed).blocks[1] as { fields: { text: string }[] }).fields.map((f) => f.text);
    expect(fields.slice(4)).toEqual(['*Before*\n75%', '*After*\n50%', '*Recovered to*\n89%', '*Open for*\n12:57']);
    expect(incidentPlainText(closed.incident!)).toContain('Savings ratio 75% → 50% · recovered to 89% · $25 a day above normal while it lasted · 12\u00a0min 57\u00a0s · ≈ $0.22 in all');
    // Closed before D47: `after` held the reading at close, so the drop is unknown and no arrow points at it.
    const legacy = canonicalPayload('incident.closed', { incident: regression({ closedAt, after: 0.89, notes: [] }), workspace: 'w', linkBase: '' });
    expect(legacy.incident).toMatchObject({ before: { ratio: 0.75 }, after: {}, recoveredTo: { ratio: 0.89 } });
    const legacyFields = (slackPayload(legacy).blocks[1] as { fields: { text: string }[] }).fields.map((f) => f.text);
    expect(legacyFields.slice(4)).toEqual(['*Before*\n75%', '*Recovered to*\n89%', '*Open for*\n12:57']);
    // A below-floor close (the flow got cheap while the ratio stayed down) records no recovery: the drop stands
    // alone in every payload, with no "Recovered to" field and no "recovered to" fragment.
    const floor = canonicalPayload('incident.closed', { incident: regression({ closedAt, before: 0.297, after: 0, notes: ['below-floor'] }), workspace: 'w', linkBase: '' });
    expect(floor.incident).toMatchObject({ before: { ratio: 0.297 }, after: { ratio: 0 } });
    expect(floor.incident!.recoveredTo).toBeUndefined();
    const floorFields = (slackPayload(floor).blocks[1] as { fields: { text: string }[] }).fields.map((f) => f.text);
    // Founder-build r1 core-10 (M9): still down, so no recovery fields and no year — the drop per day, then the rest.
    expect(floorFields[0]).toBe('*Lost per day*\n$25');
    expect(floorFields.slice(3)).toEqual(['*Before*\n30%', '*After*\n0%', '*Open for*\n12:57']);
    expect(incidentPlainText(floor.incident!)).toContain('Savings ratio 30% → 0% · fell under the $5/day floor; savings still at 0%');
    expect(incidentPlainText(floor.incident!)).not.toContain('recovered to');
    expect(incidentPlainText(legacy.incident!)).toContain('Savings ratio 75% before · recovered to 89% · $25 a day');
    expect(incidentPlainText(legacy.incident!)).not.toContain('→');
    // A spike: baseline, peak, now.
    const spike = canonicalPayload('incident.closed', {
      incident: regression({ type: 'spike', objectKey: 'in:default:mrd_payments_api', before: 1_000_000, after: 5_000_000, closedAt, recoveredTo: 1_005_000, commit: undefined }),
      workspace: 'w',
      linkBase: '',
    });
    const spikeFields = (slackPayload(spike).blocks[1] as { fields: { text: string }[] }).fields.map((f) => f.text);
    expect(spikeFields.slice(4)).toEqual(['*Baseline*\n$10/hour', '*Peak*\n$50/hour', '*Now*\n$10/hour', '*Open for*\n12:57']);
    expect(incidentPlainText(spike.incident!)).toContain('Cost $10/hour → $50/hour · recovered to $10/hour');
    // A budget: the peak projection, the threshold, now.
    const budget = canonicalPayload('incident.closed', {
      incident: regression({ type: 'budget', objectKey: 'out:default:mrd_siem_prod', before: 90, after: 112.4, closedAt, recoveredTo: 84.2, commit: undefined }),
      workspace: 'w',
      linkBase: '',
    });
    const budgetFields = (slackPayload(budget).blocks[1] as { fields: { text: string }[] }).fields.map((f) => f.text);
    // Budget pace carries no year (D62, rules round 2): the money field, then the pace.
    expect(budgetFields.slice(1)).toEqual(['*Peak projection*\n112% of budget', '*Threshold*\n90%', '*Now*\n84% of budget', '*Open for*\n12:57']);
    expect(incidentPlainText(budget.incident!)).toContain('Projected 112% of budget · recovered to 84% of budget · $25 a day over');
  });
  it('uses the orange glyph and the no-commit copy for medium regressions; flags nearby matches', () => {
    const medium = canonicalPayload('incident.opened', { incident: regression({ severity: 'medium', cause: 'unknown', commit: undefined }), workspace: 'w', linkBase: '' });
    const m = slackPayload(medium);
    expect(m.text.startsWith(':large_orange_circle:')).toBe(true);
    expect(texts(m)).toContain('No configuration change found nearby');
    expect(texts(m)).toContain('*By*\\n—');
    const nearby = canonicalPayload('incident.opened', { incident: regression({ commit: { ...regression().commit!, match: 'nearby', message: 'tune <things> & stuff' } }), workspace: 'w', linkBase: '' });
    const n = texts(slackPayload(nearby));
    expect(n).toContain('(nearby change; it may not be the cause)');
    expect(n).toContain('tune &lt;things&gt; &amp; stuff');
  });
  it('renders spikes, budgets and good news with their own fields', () => {
    const spike = slackPayload(canonicalPayload('incident.opened', { incident: regression({ type: 'spike', objectKey: 'in:default:mrd_payments_api', label: 'Payments API', before: 1_000_000, after: 5_000_000, impactPerDayM: 96_000_000 }), workspace: 'w', linkBase: '' }));
    expect(texts(spike)).toContain('*Extra per day*\\n$960');
    expect(texts(spike)).toContain('*Baseline*\\n$10/hour');
    expect(texts(spike)).toContain('*Now*\\n$50/hour');
    const spikeClosed = slackPayload(canonicalPayload('incident.closed', { incident: regression({ type: 'spike', objectKey: 'in:default:x', before: 1, after: 1, closedAt: 'y' }), workspace: 'w', linkBase: '' }));
    expect(texts(spikeClosed)).toContain('Was costing extra per day');
    const budget = slackPayload(canonicalPayload('incident.opened', { incident: regression({ type: 'budget', severity: 'medium', objectKey: 'out:default:mrd_siem_prod', label: 'siem-prod', before: 90, after: 94.6, commit: undefined }), workspace: 'w', linkBase: '' }));
    expect(budget.blocks[0]).toMatchObject({ text: { text: ':large_orange_circle: Over budget pace: siem-prod' } });
    expect(texts(budget)).toContain('*Projected*\\n95% of budget');
    expect(texts(budget)).toContain('*Threshold*\\n90%');
    expect(texts(budget)).not.toContain('Commit');
    const good = slackPayload(canonicalPayload('incident.opened', { incident: regression({ type: 'goodnews', severity: 'info', before: 0, after: 0.33, closedAt: 'z' }), workspace: 'w', linkBase: '' }));
    expect(good.blocks[0]).toMatchObject({ text: { text: ':large_green_circle: Savings improved: Payments API sampling' } });
    expect(texts(good)).toContain('*Saving per day*');
    const info = canonicalPayload('incident.opened', { incident: regression({ severity: 'info' }), workspace: 'w', linkBase: '' });
    expect(slackGlyph(info)).toBe(':large_blue_circle:');
  });
  it('renders the weekly receipt as a header and a code block', () => {
    const r: WeeklyReceipt = {
      periodStart: '2026-09-21T05:00:00.000Z',
      periodEnd: '2026-09-28T05:00:00.000Z',
      label: 'Sep 21–27, 2026',
      lines: [{ label: 'Windows event trimming', savedM: 938_000_000 }],
      savedM: 2_380_700_000,
      whpM: 3_967_800_000,
      paidM: 1_587_100_000,
      ratio: 0.6,
      trendPct: 4,
      openIncidents: [],
    };
    const m = slackPayload(canonicalPayload('receipt.weekly', { receipt: r, workspace: 'w', linkBase: '' }));
    expect(m.text).toBe(':receipt: Meter Reader weekly receipt · Sep 21–27, 2026 · Saved by Cribl $23,807');
    expect(m.blocks).toEqual([
      { type: 'header', text: { type: 'plain_text', text: ':receipt: Weekly receipt · Sep 21–27, 2026', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`\n${receiptText(r)}\n\`\`\`` } },
    ]);
  });
  it('handles test and incident-less payloads', () => {
    const t = slackPayload(testPayload('main', '2026-09-26T04:00:00.000Z'));
    expect(t.blocks[0]).toMatchObject({ text: { text: ':red_circle: Test: Savings dropped: Example pipeline' } }); // core-11 m8: the neutral sample
    const bare = slackPayload({ schemaVersion: 1, app: 'meter-reader', event: 'test', sentAt: 'x', workspace: 'w' });
    expect(bare.text).toBe(':large_blue_circle: Meter Reader test notification');
    const other = slackPayload({ schemaVersion: 1, app: 'meter-reader', event: 'incident.updated', sentAt: 'x', workspace: 'w' });
    expect(other.text).toBe(':large_blue_circle: Meter Reader incident.updated');
    const bad = slackPayload(canonicalPayload('incident.opened', { incident: regression({ openedAt: 'bad' }), workspace: 'w', linkBase: '' }));
    expect(texts(bad)).toContain('Meter Reader by Steve Koelpin · SIEM (prod) · caught in 2:51');
  });
  it('clips headers to Slack limits', () => {
    const long = slackPayload(canonicalPayload('incident.opened', { incident: regression({ label: 'x'.repeat(300) }), workspace: 'w', linkBase: '' }));
    expect((long.blocks[0] as { text: { text: string } }).text.text.length).toBe(150);
  });
});

describe('servicenow, generic, dispatch and test payloads', () => {
  it('wraps incidents for ServiceNow with urgency by severity', () => {
    const p = canonicalPayload('incident.opened', { incident: regression(), workspace: 'w', linkBase: 'L' });
    const s = servicenowPayload(p);
    expect(s.short_description).toBe('Savings dropped: Payments API sampling');
    expect(s.urgency).toBe(1);
    expect(s.u_meter_reader).toBe(p.incident);
    expect(s.description.split('\n')).toEqual([
      'Savings dropped: Payments API sampling',
      'Savings ratio 75% → 50% · $25 a day · $9,125 a year if left',
      'Commit a1f3c9e "demo: break the trim on mrd_pay_sample" by s.koelpin',
      // Founder-build r1 core-11 (m16, #38): times in the display zone, as Slack prints them (UTC when none is given).
      'Caught in 2:51 · Opened 4:42 PM UTC',
      'Open in Ledger: L/ledger?object=pipe:default:mrd_pay_sample',
      // The builder's signature closes every alert message (core/strings.ts CREDIT_STRINGS).
      'Meter Reader by Steve Koelpin',
    ]);
    const med = servicenowPayload(canonicalPayload('incident.closed', { incident: regression({ severity: 'medium', closedAt: 'C', commit: undefined, caughtInSec: undefined }), workspace: 'w', linkBase: '' }));
    expect(med.urgency).toBe(2);
    expect(med.short_description).toBe('Recovered: Savings dropped: Payments API sampling');
    expect(med.description).toContain('No configuration change found nearby');
    expect(med.description).toContain('Opened 4:42 PM UTC · Recovered C');
    expect(servicenowPayload(canonicalPayload('incident.opened', { incident: regression({ severity: 'info', type: 'goodnews', closedAt: 'c' }), workspace: 'w', linkBase: '' })).urgency).toBe(3);
  });
  it('describes spikes and budgets in plain text', () => {
    const spike = canonicalPayload('incident.opened', { incident: regression({ type: 'spike', objectKey: 'in:default:x', before: 1_000_000, after: 5_000_000 }), workspace: 'w', linkBase: '' });
    expect(incidentPlainText(spike.incident!)).toContain('Cost $10/hour → $50/hour');
    const budget = canonicalPayload('incident.opened', { incident: regression({ type: 'budget', objectKey: 'out:default:x', before: 100, after: 112.4 }), workspace: 'w', linkBase: '' });
    expect(incidentPlainText(budget.incident!)).toContain('Projected 112% of budget · $25 a day over');
  });
  it('wraps the weekly receipt for ServiceNow and handles bare events', () => {
    const r = { label: 'Sep 21–27, 2026', lines: [], savedM: 0, whpM: 0, paidM: 0, ratio: 0, openIncidents: [], periodStart: '', periodEnd: '' };
    const s = servicenowPayload(canonicalPayload('receipt.weekly', { receipt: r, workspace: 'w', linkBase: '' }));
    expect(s).toMatchObject({ short_description: 'Meter Reader weekly receipt Sep 21–27, 2026', urgency: 3, u_meter_reader: r });
    expect(s.description).toBe(receiptText(r));
    const bare = servicenowPayload({ schemaVersion: 1, app: 'meter-reader', event: 'test', sentAt: 'x', workspace: 'w' });
    expect(bare).toEqual({ short_description: 'Meter Reader test', description: 'Meter Reader test', urgency: 3, u_meter_reader: { event: 'test' } });
  });
  it('dispatches by format', () => {
    const p: CanonicalPayload = testPayload('main', '2026-09-26T04:00:00.000Z', LINK_BASE);
    expect(genericPayload(p)).toBe(p);
    expect(payloadFor('generic', p)).toBe(p);
    expect(payloadFor('slack', p)).toHaveProperty('blocks');
    expect(payloadFor('servicenow', p)).toHaveProperty('short_description');
  });
  it('builds a sample-noted test payload', () => {
    const p = testPayload('main', '2026-09-26T04:00:00.000Z', LINK_BASE);
    expect(p).toMatchObject({ event: 'test', sentAt: '2026-09-26T04:00:00.000Z', workspace: 'main' });
    expect(p.incident).toMatchObject({ notes: ['sample'], caughtInSeconds: 171, impact: { perDay: '$25', perYear: '$9,125' }, commit: { deployedAt: '2026-09-26T03:57:09.000Z' } });
    expect(testPayload('main', 'bad').incident?.openedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  // Founder-build r1 core-11: m2 (#5) the bell test posts as info (README: tests post as info); m8 (#14) the release's
  // test alert names no demo-rig object and links to the Ledger root; m16 (#38) target plain text prints local times.
  it('m8: the test alert names no demo-rig object ("mrd_", "demo:") and links to the Ledger root', () => {
    const p = testPayload('main', '2026-09-26T04:00:00.000Z', LINK_BASE);
    const every = [
      JSON.stringify(p),
      JSON.stringify(slackPayload(p, { tz: 'America/New_York' })),
      JSON.stringify(servicenowPayload(p)),
      incidentPlainText(p.incident!),
    ].join('\n');
    expect(every).not.toMatch(/mrd_|demo:/);
    expect(p.incident!.link).toBe('https://main-org.cribl.cloud/apps/a/meter-reader/ledger');
    expect(p.incident!.title).toBe('Savings dropped: Example pipeline');
  });

  // Founder-build r2 core-11 (c), IC-11 verify: the bell's test is the neutral sample, posted as info (the sample's own
  // severity is high; a test never lands in the bell as an alert).
  it('IC-11: the bell renders the test payload as info, with the neutral sample names', async () => {
    const { renderAlert } = await import('../../core/delivery.ts');
    const bell = renderAlert(testPayload('main', '2026-09-26T04:00:00.000Z', LINK_BASE), 'America/New_York');
    expect(bell.severity).toBe('info');
    expect(bell.title).toBe('Test: Savings dropped: Example pipeline');
    expect(`${bell.title}\n${bell.line}\n${bell.text}`).not.toMatch(/mrd_|demo:|Payments API/);
  });

  it('m16: the plain text (target, ServiceNow, the bell body) prints times in the display zone, never raw ISO', () => {
    const closed = canonicalPayload('incident.closed', { incident: regression({ closedAt: '2026-09-30T16:55:00.000Z', recoveredTo: 0.75 }), workspace: 'w', linkBase: '' });
    const ny = incidentPlainText(closed.incident!, 'America/New_York');
    expect(ny).toContain('Opened 12:42 PM · Recovered 12:55 PM');
    for (const text of [ny, incidentPlainText(closed.incident!), servicenowPayload(closed, 'America/Chicago').description, JSON.stringify(slackPayload(closed))]) {
      expect(text).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    }
    expect(servicenowPayload(closed, 'America/Chicago').description).toContain('Opened 11:42 AM');
  });
});

describe('REVIEW-3a #13, #15 and NOTIFY-3a issue 8 in the payloads', () => {
  const API_CLIENT = { ...regression().commit!, author: 'Zx9QvK3mTt0pLr7bN2cW5yH8dJ4aF6gE@clients' };

  it('an incident caught on catch-up counts its detection delay and says so (Slack, plain text, canonical)', () => {
    // The change showed at 16:42:03 (openedAt); the sweep that caught it ran 41 minutes later.
    const inc = regression({ notes: [CATCH_UP_NOTE], detectedAt: '2026-09-30T17:23:03.000Z' });
    expect(isCatchUp(inc)).toBe(true);
    expect(caughtInSeconds(inc)).toBe(171 + 41 * 60);
    const c = canonicalPayload('incident.opened', { incident: inc, workspace: 'w', linkBase: LINK_BASE, sentAt: '2026-09-30T17:23:04.000Z' });
    expect(c.incident!.caughtInSeconds).toBe(171 + 41 * 60);
    expect(c.incident!.notes).toContain(CATCH_UP_NOTE);
    const slack = slackPayload(c);
    expect(texts(slack)).toContain('caught on catch-up, 43:51 after the change');
    expect(texts(slack)).not.toContain('caught in');
    expect(incidentPlainText(c.incident!)).toContain('Caught on catch-up, 43:51 after the change · Opened');
    // Recovered messages drop the caught line.
    expect(texts(slackPayload(canonicalPayload('incident.closed', { incident: { ...inc, closedAt: '2026-09-30T18:00:00.000Z' }, workspace: 'w', linkBase: '' })))).not.toContain('catch-up,');
  });

  it('live incidents keep caughtInSec; the helpers cover the edges', () => {
    expect(caughtInSeconds(regression())).toBe(171);
    expect(caughtInSeconds(regression({ detectedAt: '2026-09-30T16:42:03.000Z' }))).toBe(171);
    expect(caughtInSeconds(regression({ detectedAt: '2026-09-30T16:00:00.000Z' }))).toBe(171); // never earlier
    expect(caughtInSeconds(regression({ detectedAt: 'not a date' }))).toBe(171);
    expect(caughtInSeconds(regression({ caughtInSec: undefined }))).toBeUndefined();
    expect(caughtLine({ caughtInSeconds: 127, notes: [] })).toBe('caught in 2:07');
    expect(caughtLine({ notes: [CATCH_UP_NOTE] })).toBe('caught on catch-up');
    expect(caughtLine({ notes: [] })).toBe('');
    expect(isCatchUp({ notes: undefined as unknown as string[] })).toBe(false);
  });

  it("escapes &, < and > in Slack's top-level fallback text (REVIEW-3a #15)", () => {
    const inc = regression({ label: 'A&B <prod> route' });
    const slack = slackPayload(canonicalPayload('incident.opened', { incident: inc, workspace: 'w', linkBase: '' }));
    expect(slack.text).toContain('A&amp;B &lt;prod&gt; route');
    expect(slack.text).not.toMatch(/[<>]|&(?!amp;|lt;|gt;)/);
    const receipt: WeeklyReceipt = {
      periodStart: '2026-09-21T00:00:00.000Z',
      periodEnd: '2026-09-28T00:00:00.000Z',
      label: 'Sep 21–27 <test> & more',
      lines: [],
      savedM: 0,
      whpM: 0,
      paidM: 0,
      ratio: 0,
      openIncidents: [],
    };
    expect(slackPayload(canonicalPayload('receipt.weekly', { receipt, workspace: 'w', linkBase: '' })).text).toContain('&lt;test&gt; &amp; more');
  });

  it("an API client's commit reads 'API client ··F6gE' everywhere a person reads it, never the whole id", () => {
    const c = canonicalPayload('incident.opened', { incident: regression({ commit: API_CLIENT }), workspace: 'w', linkBase: '' });
    expect(c.incident!.commit!.author).toBe('API client ··F6gE');
    expect(texts(slackPayload(c))).toContain('*By*\\nAPI client ··F6gE');
    expect(incidentPlainText(c.incident!)).toContain('by API client ··F6gE');
    expect(JSON.stringify(c)).not.toContain('Zx9QvK3m');
    expect(JSON.stringify(servicenowPayload(c))).not.toContain('@clients');
    // A canonical built elsewhere with the raw author still renders the friendly name.
    const raw = { ...c, incident: { ...c.incident!, commit: { ...c.incident!.commit!, author: API_CLIENT.author } } };
    expect(texts(slackPayload(raw))).not.toContain('@clients');
    expect(incidentPlainText(raw.incident)).not.toContain('@clients');
  });
});
