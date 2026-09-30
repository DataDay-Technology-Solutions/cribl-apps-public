// Incident card family — the pure model: cause labels (SPEC 10), delivery lines (SPEC 12.3 / 17), the
// "Caught in" clock (PRD 7, 8.1), figures, recovery copy, mutes and time formatting.

import { describe, expect, it } from 'vitest';
import type { DeliveryRef, Incident, NotificationEndpoint } from '../../core/types.ts';
import {
  CAUGHT_LIVE_WINDOW_MS,
  causeInfo,
  caughtStartMs,
  caughtState,
  commitWhen,
  deliveryLine,
  deliveryLines,
  endpointName,
  expectsDelivery,
  formatClockTime,
  impactFigures,
  incidentLabel,
  incidentMeasure,
  incidentTitle,
  incidentTone,
  isBellEndpoint,
  latestDeliveries,
  ledgerHref,
  mutedMinutesLeft,
  objectKindWord,
  openSeconds,
  primaryDelivery,
  rankDeliveries,
  recoveryDeliveries,
  recoveryMeasure,
  recoveryText,
  shortHash,
} from '../../src/components/IncidentCard/model.ts';

const T = Date.parse('2026-09-30T16:42:03.000Z');
const iso = (deltaSec: number) => new Date(T + deltaSec * 1000).toISOString();
const MC = 100_000;

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'inc_7f3a01',
    type: 'regression',
    severity: 'high',
    objectKey: 'pipe:default:mrd_pay_sample',
    label: 'Payments API sampling',
    openedAt: iso(0),
    cause: 'commit',
    commit: {
      hash: 'a1f3c9e5b2',
      message: 'demo: break the trim on mrd_pay_sample',
      author: 's.koelpin',
      committedAt: iso(-180),
      deployedAt: iso(-171),
      groupId: 'default',
      match: 'message',
    },
    before: 0.75,
    after: 0.5,
    impactPerDayM: 25 * MC,
    caughtInSec: 171,
    notes: ['demo-profile'],
    deliveries: [],
    ...over,
  };
}

const SLACK: NotificationEndpoint = {
  id: 'ep_slack',
  name: 'Slack',
  url: 'https://hooks.slack.com/services/x',
  host: 'hooks.slack.com',
  format: 'slack',
  minSeverity: 'medium',
  weeklyReceipt: true,
  enabled: true,
};

describe('identity', () => {
  it('titles and labels follow SPEC 17, humanizing when the label is empty', () => {
    expect(incidentTitle(incident())).toBe('Savings dropped: Payments API sampling');
    expect(incidentTitle(incident({ type: 'spike', label: 'Payments API' }))).toBe('Cost spike: Payments API');
    expect(incidentTitle(incident({ type: 'budget', label: 'siem-prod' }))).toBe('Over budget pace: siem-prod');
    expect(incidentTitle(incident({ type: 'goodnews' }))).toBe('Savings improved: Payments API sampling');
    expect(incidentLabel(incident({ label: '' }))).toBe('Payments API sampling');
    expect(incidentLabel(incident({ label: '  ', objectKey: 'route:default:k8s_noise' }), { k8s_noise: 'K8s noise' })).toBe('K8s noise');
  });

  it('names the object kind and builds a readable Ledger link', () => {
    expect(objectKindWord('pipe:default:x')).toBe('pipeline');
    expect(objectKindWord('route:default:x')).toBe('route');
    expect(objectKindWord('in:default:x')).toBe('source');
    expect(objectKindWord('out:default:x')).toBe('destination');
    expect(objectKindWord('garbage')).toBe('pipeline');
    expect(ledgerHref('pipe:default:mrd_pay_sample')).toBe('/ledger?object=pipe:default:mrd_pay_sample');
    expect(ledgerHref('pipe:g 1:a&b')).toBe('/ledger?object=pipe:g%201:a%26b');
    expect(shortHash('a1f3c9e5b2')).toBe('a1f3c9e');
  });
});

describe('cause (SPEC 10 matching → label)', () => {
  it('labels each match kind for the object kind', () => {
    expect(causeInfo(incident())).toEqual({
      kind: 'message',
      label: 'change naming this pipeline',
    });
    const files = incident({
      commit: { ...incident().commit!, match: 'files' },
    });
    expect(causeInfo(files)).toEqual({
      kind: 'files',
      label: 'change to this pipeline',
    });
    const route = incident({
      objectKey: 'route:default:r1',
      commit: { ...incident().commit!, match: 'files' },
    });
    expect(causeInfo(route).label).toBe('change to this route');
  });

  it('adds the caveat to a nearby change with the minutes since it deployed', () => {
    const nearby = incident({
      commit: {
        ...incident().commit!,
        match: 'nearby',
        deployedAt: iso(-4 * 60 - 10),
      },
    });
    expect(causeInfo(nearby)).toEqual({
      kind: 'nearby',
      label: 'nearby change',
      caveat: 'A change was deployed 4\u00a0min earlier; it may not be the cause.',
    });
    const close = incident({
      commit: { ...incident().commit!, match: 'nearby', deployedAt: iso(-5) },
    });
    expect(causeInfo(close).caveat).toContain('1\u00a0min earlier');
  });

  it('says no config change when the cause is unknown or there is no commit', () => {
    expect(causeInfo(incident({ cause: 'unknown', commit: undefined }))).toEqual({ kind: 'none', label: 'No configuration change found nearby' });
    expect(causeInfo(incident({ cause: 'unknown' })).kind).toBe('none');
  });

  it('prints the deploy time, or "committed" when no deploy is known', () => {
    expect(commitWhen(incident(), 'UTC')).toBe('deployed 4:39 PM');
    expect(commitWhen(incident(), 'UTC', true)).toBe('deployed 4:39:12 PM');
    const noDeploy = incident({
      commit: { ...incident().commit!, deployedAt: undefined },
    });
    expect(commitWhen(noDeploy, 'UTC')).toBe('committed 4:39 PM');
    expect(commitWhen(incident({ commit: undefined }), 'UTC')).toBeUndefined();
  });
});

describe('deliveries (SPEC 12.3, 17)', () => {
  const at = iso(2);
  it('writes each status the way SPEC 17 does', () => {
    expect(deliveryLine({ endpointId: 'ep_slack', status: 200, at }, { endpoints: [SLACK], tz: 'UTC' })).toMatchObject({
      tone: 'ok',
      text: 'Sent to Slack ✓ 4:42 PM',
      format: 'slack',
    });
    expect(deliveryLine({ endpointId: 'ep_slack', status: 204, at }, { endpoints: [SLACK], tz: 'UTC', withSeconds: true }).text).toBe(
      'Sent to Slack ✓ 4:42:05 PM',
    );
    expect(deliveryLine({ endpointId: 'ep_slack', status: 503, at }, { endpoints: [SLACK] })).toMatchObject({
      tone: 'retrying',
      text: 'Delivery failed (503). Retrying.',
    });
    expect(deliveryLine({ endpointId: 'ep_slack', status: 0, at, error: 'timeout' }).text).toBe('Delivery failed (no response). Retrying.');
    expect(deliveryLine({ endpointId: 'ep_slack', status: 404, at })).toMatchObject({ tone: 'failed', text: 'Delivery failed (404).' });
    expect(
      deliveryLine({
        endpointId: 'ep_slack',
        status: 403,
        at,
        error: 'host_not_authorized',
      }),
    ).toMatchObject({
      tone: 'blocked',
      text: 'Delivery blocked: host not authorized.',
    });
  });

  it('names endpoints, falling back to the preset name or the id', () => {
    expect(endpointName('ep_slack', [SLACK])).toBe('Slack');
    expect(endpointName('ep_slack', [{ ...SLACK, name: ' ' }])).toBe('Slack');
    expect(endpointName('x', [{ ...SLACK, id: 'x', name: '', format: 'generic' }])).toBe('webhook');
    expect(endpointName('x', [{ ...SLACK, id: 'x', name: '', format: 'servicenow' }])).toBe('ServiceNow');
    expect(endpointName('ep_gone', [])).toBe('ep_gone');
  });

  it('NOTIFY-3a issue 1: the bell reads "Cribl notifications" — stored or implicit (its id alone)', () => {
    const bell: NotificationEndpoint = { ...SLACK, id: 'my-bell', name: '', channel: 'cribl-bell', format: 'generic' };
    expect(endpointName('cribl-bell', [])).toBe('Cribl notifications');
    expect(endpointName('cribl-bell', undefined)).toBe('Cribl notifications');
    expect(endpointName('my-bell', [bell])).toBe('Cribl notifications');
    expect(isBellEndpoint('cribl-bell', [SLACK])).toBe(true);
    expect(isBellEndpoint('my-bell', [bell])).toBe(true);
    expect(isBellEndpoint('ep_slack', [SLACK])).toBe(false);
    const line = deliveryLine({ endpointId: 'cribl-bell', status: 208, at: iso(2) }, { endpoints: [SLACK], tz: 'UTC' });
    expect(line).toMatchObject({ tone: 'ok', bell: true, text: 'Sent to Cribl notifications ✓ 4:42 PM' });
  });

  it('one status slot: a landed webhook or target beats the bell, a landed bell beats a failure', () => {
    const lines = deliveryLines(
      [
        { endpointId: 'cribl-bell', status: 200, at: iso(4) },
        { endpointId: 'ep_hook', status: 503, at: iso(5) },
        { endpointId: 'ep_slack', status: 200, at: iso(3) },
      ],
      { endpoints: [SLACK, { ...SLACK, id: 'ep_hook', name: 'Ops webhook', format: 'generic' }], tz: 'UTC' },
    );
    // Newest first by time…
    expect(lines.map((l) => l.endpointId)).toEqual(['ep_hook', 'cribl-bell', 'ep_slack']);
    // …but the slot and the ranked list put the landed webhook first, then the bell, then the failure.
    expect(primaryDelivery(lines)?.endpointId).toBe('ep_slack');
    expect(rankDeliveries(lines).map((l) => l.endpointId)).toEqual(['ep_slack', 'cribl-bell', 'ep_hook']);
    expect(primaryDelivery(lines.filter((l) => l.endpointId !== 'ep_slack'))?.endpointId).toBe('cribl-bell');
    expect(primaryDelivery(lines.filter((l) => l.endpointId === 'ep_hook'))?.tone).toBe('retrying');
    expect(primaryDelivery([])).toBeUndefined();
  });

  it('keeps the newest attempt per endpoint, newest first', () => {
    const list: DeliveryRef[] = [
      { endpointId: 'a', status: 503, at: iso(1) },
      { endpointId: 'b', status: 200, at: iso(2) },
      { endpointId: 'a', status: 200, at: iso(9) },
    ];
    expect(latestDeliveries(list).map((d) => `${d.endpointId}:${d.status}`)).toEqual(['a:200', 'b:200']);
    expect(deliveryLines(list).map((l) => l.tone)).toEqual(['ok', 'ok']);
    expect(latestDeliveries(undefined)).toEqual([]);
  });

  it('knows whether an endpoint is owed a delivery', () => {
    expect(expectsDelivery('high', [SLACK])).toBe(true);
    expect(expectsDelivery('info', [SLACK])).toBe(false);
    expect(expectsDelivery('high', [{ ...SLACK, enabled: false }])).toBe(false);
    expect(expectsDelivery('high', [])).toBe(false);
    expect(expectsDelivery('high', undefined)).toBe(false);
  });
});

describe('Caught in m:ss', () => {
  it('starts at the deploy, else the commit, else the first qualifying minute', () => {
    expect(caughtStartMs(incident())).toBe(T - 171_000);
    expect(caughtStartMs(incident({ commit: { ...incident().commit!, deployedAt: undefined } }))).toBe(T - 180_000);
    expect(caughtStartMs(incident({ commit: undefined, caughtInSec: 120 }))).toBe(T - 120_000);
    expect(Number.isNaN(caughtStartMs(incident({ commit: undefined, caughtInSec: undefined })))).toBe(true);
  });

  // r2 ui-11 (FINDINGS_R2 #14): the figure is the measured catch throughout; `live` marks a delivery still owed.
  it('is live while a delivery is owed, at the measured number (never counting past the catch), then settles once one lands', () => {
    const now = T + 9_000;
    expect(caughtState(incident(), [], now, true)).toEqual({
      seconds: 171,
      live: true,
    });
    const failed = [{ endpointId: 'ep_slack', status: 503, at: iso(2) }];
    expect(caughtState(incident(), failed, now, false)).toEqual({
      seconds: 171,
      live: true,
    });
    const sent = [{ endpointId: 'ep_slack', status: 200, at: iso(2) }];
    expect(caughtState(incident(), sent, now, true)).toEqual({
      seconds: 171,
      live: false,
    });
  });

  it('is the measured number when nothing is owed, when closed, or long after opening', () => {
    expect(caughtState(incident(), [], T + 9_000, false)).toEqual({
      seconds: 171,
      live: false,
    });
    expect(caughtState(incident({ closedAt: iso(60) }), [], T + 90_000, true)).toEqual({ seconds: 171, live: false });
    expect(caughtState(incident(), [], T + CAUGHT_LIVE_WINDOW_MS + 1, true)).toEqual({ seconds: 171, live: false });
    // No caughtInSec: derived from the commit.
    expect(caughtState(incident({ caughtInSec: undefined }), [], T, false)).toEqual({ seconds: 171, live: false });
    // Nothing to measure from.
    expect(caughtState(incident({ caughtInSec: undefined, commit: undefined }), [], T, true)).toBeUndefined();
  });

  it('is never shown for budget pace or good news', () => {
    expect(caughtState(incident({ type: 'budget' }), [], T, true)).toBeUndefined();
    expect(caughtState(incident({ type: 'goodnews' }), [], T, true)).toBeUndefined();
  });
});

describe('figures and recovery', () => {
  it('shows before → after per incident type', () => {
    expect(incidentMeasure(incident(), 'UTC')).toMatchObject({
      before: '75%',
      after: '50%',
      caption: 'savings ratio',
      sentence: 'Ratio fell from 75% to 50% at 4:42 PM',
      worse: true,
    });
    expect(incidentMeasure(incident({ type: 'spike', before: 412 * MC, after: 1_904 * MC }), 'UTC')).toMatchObject({
      before: '$412',
      after: '$1,904',
      per: 'hour',
      sentence: 'Cost rose from $412 to $1,904 an hour at 4:42 PM',
    });
    expect(incidentMeasure(incident({ type: 'budget', before: 90, after: 104.3 }), 'UTC')).toMatchObject({
      before: '90%',
      after: '104%',
      sentence: 'Projected at 104% of budget at 4:42 PM',
    });
    expect(incidentMeasure(incident({ type: 'goodnews', before: 0.4, after: 0.62 }), 'UTC')).toMatchObject({
      sentence: 'Ratio rose from 40% to 62% at 4:42 PM',
      worse: false,
    });
  });

  it('prices the impact per day and per year (× 365), never negative', () => {
    expect(impactFigures(incident())).toEqual({
      perDay: '$25',
      perYear: '$9,125',
    });
    expect(impactFigures(incident({ impactPerDayM: -5 }))).toEqual({
      perDay: '$0',
      perYear: '$0',
    });
  });

  it('D47: a closed incident keeps its drop and adds where it recovered to; one closed before D47 shows only the recovery', () => {
    expect(incidentMeasure(incident({ closedAt: iso(480), recoveredTo: 0.89 }), 'UTC')).toMatchObject({
      before: '75%',
      after: '50%',
      recoveredTo: '89%',
      sentence: 'Ratio fell from 75% to 50% at 4:42 PM',
    });
    // Closed before D47: `after` held the reading at close, so there is no drop to print and the sentence names the close.
    const legacy = incidentMeasure(incident({ closedAt: iso(480), after: 0.89 }), 'UTC');
    expect(legacy).toMatchObject({ before: '75%', recoveredTo: '89%', sentence: 'Recovered to 89% at 4:50 PM' });
    expect(legacy.after).toBeUndefined();
    // A regression that closed within the recovery band but under its baseline is a recovery too, not a 5-point drop.
    expect(incidentMeasure(incident({ before: 0.735, closedAt: iso(480), after: 0.688 }), 'UTC')).toMatchObject({ before: '74%', recoveredTo: '69%' });
    // Closed with no reading at all (a demo reset): the drop, no recovery.
    const reset = incidentMeasure(incident({ closedAt: iso(480) }), 'UTC');
    expect(reset).toMatchObject({ before: '75%', after: '50%' });
    expect(reset.recoveredTo).toBeUndefined();
    expect(incidentMeasure(incident({ type: 'spike', before: 412 * MC, after: 1_904 * MC, closedAt: iso(60), recoveredTo: 410 * MC }), 'UTC')).toMatchObject({
      before: '$412',
      after: '$1,904',
      recoveredTo: '$410',
      per: 'hour',
    });
    expect(incidentMeasure(incident({ type: 'budget', before: 90, after: 104.3, closedAt: iso(60), recoveredTo: 84 }), 'UTC')).toMatchObject({
      before: '90%',
      after: '104%',
      recoveredTo: '84%',
    });
  });

  it('writes the recovery sentence per type from the reading at close (D47), never the low', () => {
    expect(recoveryText(incident({ closedAt: iso(300), recoveredTo: 0.75 }))).toBe('Recovered · savings back to 75% · closed itself.');
    expect(recoveryText(incident({ type: 'spike', before: 400 * MC, after: 1_904 * MC, closedAt: iso(300), recoveredTo: 410 * MC }))).toBe(
      'Recovered · cost back to $410 an hour · closed itself.',
    );
    expect(recoveryText(incident({ type: 'budget', closedAt: iso(300) }))).toBe('Recovered · back under budget pace · closed itself.');
    // Closed before D47: `after` held the reading at close.
    expect(recoveryText(incident({ closedAt: iso(300), after: 0.75 }))).toBe('Recovered · savings back to 75% · closed itself.');
    // Closed with no reading at all (a demo reset): never "back to" the low.
    expect(recoveryText(incident({ closedAt: iso(300) }))).toBe('Recovered · closed itself.');
    // Good news closes as it opens: its `after` is the new level, in its own words, never recovery copy (founder-build
    // r1 ui-6, row 9 / PACK_PAYOFF F1).
    expect(recoveryText(incident({ type: 'goodnews', before: 0.4, after: 0.62, closedAt: iso(0) }))).toBe('Improvement held · savings at 62%.');
  });

  it('tones by severity; closed and good news are the recovery green', () => {
    expect(incidentTone(incident())).toBe('high');
    expect(incidentTone(incident({ severity: 'medium' }))).toBe('medium');
    expect(incidentTone(incident({ severity: 'info', type: 'spike' }))).toBe('info');
    expect(incidentTone(incident({ closedAt: iso(1) }))).toBe('recovered');
    expect(incidentTone(incident({ type: 'goodnews', severity: 'info' }))).toBe('recovered');
  });

  it('counts whole minutes left on a mute', () => {
    expect(mutedMinutesLeft(iso(6 * 60), T)).toBe(6);
    expect(mutedMinutesLeft(iso(10), T)).toBe(1);
    expect(mutedMinutesLeft(iso(-1), T)).toBe(0);
    expect(mutedMinutesLeft(undefined, T)).toBe(0);
  });
});

describe('formatClockTime', () => {
  it('formats minutes or seconds in the display timezone with a plain space before AM/PM', () => {
    expect(formatClockTime(T, 'UTC')).toBe('4:42 PM');
    expect(formatClockTime(T, 'America/Chicago', true)).toBe('11:42:03 AM');
    expect(formatClockTime(T, 'Not/AZone')).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
    expect(formatClockTime(Number.NaN)).toBe('—');
  });
});

describe('the green recovery card (BEAUTY F3)', () => {
  it('pairs the drop the incident kept with where it recovered to (D47); before D47 the last open figure stands in', () => {
    const closed = incident({ closedAt: iso(96), recoveredTo: 0.75 });
    expect(recoveryMeasure(closed, undefined, 'UTC')).toEqual({ from: '50%', to: '75%', caption: 'savings ratio' });
    // Closed before D47: the low comes from the last open version the presenter saw; without it, only where it is now.
    const legacy = incident({ closedAt: iso(96), after: 0.75 });
    expect(recoveryMeasure(legacy, { after: 0.5 }, 'UTC')).toEqual({ from: '50%', to: '75%', caption: 'savings ratio' });
    expect(recoveryMeasure(legacy, undefined, 'UTC')).toEqual({ to: '75%', caption: 'savings ratio' });
    // Nothing moved (or garbage): no pair.
    expect(recoveryMeasure(legacy, { after: 0.75 }).from).toBeUndefined();
    expect(recoveryMeasure(legacy, { after: Number.NaN }).from).toBeUndefined();
    // Closed with no reading at all (a demo reset): no figures, never the low alone in green.
    expect(recoveryMeasure(incident({ closedAt: iso(96) }), undefined, 'UTC')).toEqual({ caption: 'savings ratio' });
    // A spike recovers in dollars an hour, from its peak.
    const spike = incident({ type: 'spike', before: 410 * MC, after: 1_904 * MC, closedAt: iso(60), recoveredTo: 412 * MC });
    expect(recoveryMeasure(spike)).toEqual({ from: '$1,904', to: '$412', per: 'hour', caption: 'cost per hour' });
  });

  it('times the alert and keeps only the recovery message’s own deliveries', () => {
    expect(openSeconds(incident({ openedAt: iso(0), closedAt: iso(96) }))).toBe(96);
    expect(openSeconds(incident({ closedAt: undefined }))).toBeUndefined();
    expect(openSeconds(incident({ openedAt: iso(10), closedAt: iso(0) }))).toBeUndefined();
    expect(openSeconds(incident({ openedAt: iso(0), closedAt: iso(2 * 86_400) }))).toBeUndefined();
    const deliveries: DeliveryRef[] = [
      { endpointId: 'ep_slack', status: 200, at: iso(2) },
      { endpointId: 'ep_slack', status: 200, at: iso(97) },
    ];
    expect(recoveryDeliveries(incident({ closedAt: iso(96) }), deliveries).map((d) => d.at)).toEqual([iso(97)]);
    expect(recoveryDeliveries(incident({ closedAt: undefined }), deliveries)).toEqual([]);
    expect(recoveryDeliveries(incident({ closedAt: iso(96) }), undefined)).toEqual([]);
  });
});
