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

// Founder-build r1 core-3 (FOUNDER_PLAN row 9, PACK_PAYOFF F1): good news is a one-shot incident the detector opens and
// closes in the same minute (closedAt = openedAt), sent as `incident.opened`. Its channels used to print recovery copy
// ("Opened … · Recovered …" in the target and ServiceNow text) and hid its caught-in line in Slack as if it had closed.
describe('good news never reads as a recovery on any channel (row 9, PACK_PAYOFF F1)', () => {
  const settled = (): CanonicalPayload => {
    const opened = '2026-09-27T12:42:25.000Z';
    const inc = incident('goodnews', {
      severity: 'info',
      label: 'Palo Alto firewall',
      objectKey: 'route:default:mrd_pan_firewall',
      before: 0,
      after: 0.3418,
      impactPerDayM: 4_614_642,
      openedAt: opened,
      closedAt: opened,
      caughtInSec: 155,
      commit: { hash: 'e1e9889aa', message: 'demo: apply the pack on mrd_pan_firewall', author: 'Steve Koelpin', committedAt: '2026-09-27T12:39:46.000Z', deployedAt: '2026-09-27T12:39:50.157Z', groupId: 'default', match: 'message' },
      notes: ['demo-profile'],
    });
    return canonicalPayload('incident.opened', { incident: inc, workspace: 'w', linkBase: 'https://x' });
  };

  it('no surface says recovered, back to, or closed itself; the settled figure and its year are there', () => {
    const c = settled();
    const s = surfaces(c);
    for (const [k, v] of Object.entries(s)) {
      expect(v, k).not.toMatch(/recover|back to|closed itself|Closed:|New normal/i);
    }
    expect(s.bell).toBe('$46 a day · $16,843 a year · commit e1e9889 by Steve Koelpin · Meter Reader by Steve Koelpin');
    expect(s.target).toContain('0% → 34%');
    expect(renderAlert(c).title).toBe('Savings improved: Palo Alto firewall');
    expect(renderAlert(c).severity).toBe('info');
  });

  it('Slack keeps the caught-in line and the time it was found, like an opened alert', () => {
    const slack = slackPayload(settled());
    const context = JSON.stringify(slack.blocks[2]);
    expect(context).toContain('caught in 2:35');
    expect(slack.text).toContain('Savings improved: Palo Alto firewall');
    expect(slack.text).not.toMatch(/Recovered/);
  });
});

// Founder-build r1 core-10 (FINDINGS_R1 M9, #33): a regression the $5/day floor closed (D26) recovered nowhere — its
// ratio is still down, the flow just got cheap (D47) — yet every channel announced it as a green "Recovered:". Now it
// reads "Closed: …", a neutral glyph, severity info, and "fell under the $5/day floor; savings still at {after}".
// m15 (#36): a drop a member accepted or muted reads as open on every channel ("… a year if left"); the Slack grid's
// label now says so too ("Per year if left"), agreeing with its own fallback text.
describe('core-10 · M9: a below-floor close is never "Recovered"; m15: the Slack label follows closedReason', () => {
  const belowFloor = (): CanonicalPayload =>
    canonicalPayload('incident.closed', { incident: incident('regression', { closedAt: CLOSED, notes: ['below-floor'] }), workspace: 'w', linkBase: 'https://x' });

  it('no channel prints "Recovered" for a below-floor close; it reads Closed, neutral, info, with the floor line', () => {
    const c = belowFloor();
    const s = surfaces(c);
    for (const [k, v] of Object.entries(s)) expect(v, k).not.toMatch(/recover/i);
    const bell = renderAlert(c);
    expect(bell.title).toBe('Closed: Savings dropped: Payments API sampling');
    expect(bell.severity).toBe('info');
    expect(bell.line).toContain('fell under the $5/day floor; savings still at 50%');
    expect(impactPhrase(c.incident!)).toBe('fell under the $5/day floor; savings still at 50%');
    const slack = slackPayload(c);
    expect(JSON.stringify(slack.blocks[0])).toContain(':large_blue_circle:');
    expect(JSON.stringify(slack.blocks[0])).not.toContain(':large_green_circle:');
    expect(slack.text).toContain('Closed: Savings dropped');
    expect(servicenowPayload(c).short_description).toBe('Closed: Savings dropped: Payments API sampling');
    // Never annualized: the drop is under the floor now.
    for (const [k, v] of Object.entries(s)) expect(v, k).not.toMatch(/a year|Per year/);
  });

  it('names the floor the workspace set (carried by the sweep), $5 when none is given', () => {
    const c = canonicalPayload('incident.closed', {
      incident: incident('regression', { closedAt: CLOSED, notes: ['below-floor'] }),
      workspace: 'w',
      linkBase: '',
      regressionFloorCentsPerDay: 1_000,
    });
    expect(renderAlert(c).line).toContain('fell under the $10/day floor; savings still at 50%');
  });

  it('m15: an accepted or muted drop reads "Per year if left" in the grid, as its fallback text says "a year if left"', () => {
    for (const reason of ['accepted', 'muted'] as const) {
      const c = canonicalPayload('incident.closed', { incident: incident('regression', { closedAt: CLOSED, closedReason: reason, closedBy: 'Steve Koelpin' }), workspace: 'w', linkBase: '' });
      const slack = slackPayload(c);
      expect(slack.text, reason).toContain('a year if left');
      const fields = JSON.stringify(slack.blocks[1]);
      expect(fields, reason).toContain('*Per year if left*');
      expect(fields, reason).not.toMatch(/\*Per year\*/);
    }
    // A recovery keeps what it came to (no year at all).
    expect(JSON.stringify(slackPayload(payload('regression', 'recovered')).blocks[1])).not.toMatch(/Per year/);
  });
});
