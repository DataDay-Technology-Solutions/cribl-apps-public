// The money line on every alert channel follows the incident card's rule (D62; rules round 2, usefulness).
//
// A judge's break → restore run on the mock: the in-App card read "$22 a day above normal while it lasted · 5 min
// 36 s", but the bell said "Recovered: Savings dropped: Payments API sampling — $22 a day · $8,205 a year · commit
// 303c927 …", annualizing a five-minute blip for the leadership and on-call people who read the bell, a notification
// target, Slack or ServiceNow without logging in. Every channel now prints core/payloads.ts impactPhrase: only an open
// regression is projected to a year (as what it costs if left); a spike is a day while it lasts; a recovered incident
// is a day while it lasted, for how long and what it came to; good news keeps its year; budget pace has none.

import { describe, expect, it } from 'vitest';
import type { CanonicalPayload, Incident, IncidentType } from '../../core/types.ts';
import { canonicalPayload, impactPhrase, incidentPlainText, realizedImpactM, servicenowPayload, slackPayload } from '../../core/payloads.ts';
import { renderAlert } from '../../core/delivery.ts';

const MC = 100_000; // millicents per dollar
const OPENED = '2026-09-27T21:40:00.000Z';
const CLOSED = '2026-09-27T21:45:36.000Z'; // 5 min 36 s later

const OBJECT: Record<IncidentType, string> = {
  regression: 'pipe:default:mrd_pay_sample',
  goodnews: 'pipe:default:mrd_pay_sample',
  spike: 'in:default:mrd_payments_api',
  budget: 'out:default:mrd_siem_prod',
};

const incident = (type: IncidentType, over: Partial<Incident> = {}): Incident => ({
  id: 'inc_money',
  type,
  severity: 'high',
  objectKey: OBJECT[type],
  label: 'Payments API sampling',
  outputId: 'mrd_siem_prod',
  openedAt: OPENED,
  cause: 'commit',
  commit: { hash: '303c9270000', message: 'demo: break the trim', author: 's.koelpin', committedAt: OPENED, groupId: 'default', match: 'files' },
  before: type === 'budget' ? 90 : type === 'spike' ? 1_000_000 : 0.75,
  after: type === 'budget' ? 112 : type === 'spike' ? 5_000_000 : 0.5,
  impactPerDayM: 22 * MC,
  caughtInSec: 90,
  notes: [],
  deliveries: [],
  ...over,
});

type State = 'open' | 'recovered' | 'accepted';
const payload = (type: IncidentType, state: State): CanonicalPayload => {
  const over: Partial<Incident> =
    state === 'recovered' ? { closedAt: CLOSED, recoveredTo: type === 'budget' ? 80 : type === 'spike' ? 1_000_000 : 0.75 } : state === 'accepted' ? { closedAt: CLOSED, closedReason: 'accepted', closedBy: 'Steve Koelpin' } : {};
  return canonicalPayload(state === 'open' ? 'incident.opened' : 'incident.closed', { incident: incident(type, over), workspace: 'w', linkBase: 'https://x' });
};

/** Every surface a person reads outside the App: the bell line, the target text, Slack's fallback and fields, ServiceNow. */
const surfaces = (c: CanonicalPayload): Record<string, string> => {
  const bell = renderAlert(c);
  const slack = slackPayload(c);
  return {
    bell: bell.line,
    target: bell.text,
    plain: incidentPlainText(c.incident!),
    slackText: slack.text,
    slackFields: JSON.stringify(slack.blocks[1]),
    servicenow: servicenowPayload(c).description,
  };
};

const PHRASE: Record<IncidentType, Record<State, string>> = {
  regression: {
    open: '$22 a day · $8,030 a year if left',
    recovered: '$22 a day above normal while it lasted · 5 min 36 s · ≈ $0.09 in all',
    accepted: '$22 a day · $8,030 a year if left',
  },
  spike: {
    open: '$22 a day above normal while it lasts',
    recovered: '$22 a day above normal while it lasted · 5 min 36 s · ≈ $0.09 in all',
    accepted: '$22 a day above normal while it lasts',
  },
  goodnews: { open: '$22 a day · $8,030 a year', recovered: '$22 a day · $8,030 a year', accepted: '$22 a day · $8,030 a year' },
  budget: { open: '$22 a day over budget', recovered: '$22 a day over budget', accepted: '$22 a day over budget' },
};

describe('the alert money line, per incident type × state, on every channel', () => {
  for (const type of ['regression', 'spike', 'goodnews', 'budget'] as const) {
    for (const state of ['open', 'recovered', 'accepted'] as const) {
      it(`${type} · ${state}`, () => {
        const c = payload(type, state);
        const want = PHRASE[type][state];
        expect(impactPhrase(c.incident!)).toBe(want);
        const s = surfaces(c);
        // The phrase itself reaches the bell, the target text, the plain text and ServiceNow (budget: the bell only;
        // its plain text keeps its pace line) and the Slack fallback (Slack escapes nothing in these figures).
        expect(s.bell.startsWith(want), s.bell).toBe(true);
        if (type !== 'budget') {
          for (const k of ['target', 'plain', 'servicenow', 'slackText'] as const) expect(s[k], k).toContain(want);
        }
        // Only an open (or member-accepted) regression and good news name a year anywhere.
        const yearly = (type === 'regression' && state !== 'recovered') || type === 'goodnews';
        for (const [k, v] of Object.entries(s)) {
          if (yearly) continue;
          expect(v, `${type} ${state} ${k}`).not.toMatch(/a year|Per year|\$8,030/);
        }
        if (type === 'regression' && state === 'open') expect(s.slackFields).toContain('*Per year if left*');
      });
    }
  }

  it("the judge's recovered break reads what it came to, never a year", () => {
    const s = surfaces(payload('regression', 'recovered'));
    expect(s.bell).toBe('$22 a day above normal while it lasted · 5 min 36 s · ≈ $0.09 in all · commit 303c927 by s.koelpin · Meter Reader by Steve Koelpin');
    expect(s.slackFields).toContain('*Lost while open*\\n≈ $0.09');
  });

  it('the realized figure is the per-day rate over the time open; none past a day or out of order', () => {
    const c = payload('regression', 'recovered').incident!;
    expect(realizedImpactM(c)).toBe(Math.round((22 * MC * 336) / 86_400));
    expect(realizedImpactM({ ...c, closedAt: '2026-09-29T21:40:00.000Z' })).toBeUndefined();
    expect(realizedImpactM({ ...c, closedAt: '2026-09-27T21:00:00.000Z' })).toBeUndefined();
    expect(impactPhrase({ ...c, closedAt: '2026-09-29T21:40:00.000Z' })).toBe('$22 a day above normal while it lasted');
    // A long, costly incident reads whole dollars.
    expect(impactPhrase({ ...c, impact: { ...c.impact, perDayMillicents: 1_250 * 24 * MC, perDay: '$30,000' }, closedAt: '2026-09-27T23:40:00.000Z' })).toBe(
      '$30,000 a day above normal while it lasted · 2 h · ≈ $2,500 in all',
    );
  });
});
