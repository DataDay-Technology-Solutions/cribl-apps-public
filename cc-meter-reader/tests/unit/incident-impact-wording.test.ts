// The incident money line (usefulness review, round 1): only an open regression is projected to a year, and then
// as its cost if left unfixed. A spike is transient and a closed incident is over, so neither is annualized: the
// same rule the report card follows (report.card.impact), so the App never contradicts itself.

import { describe, expect, it } from 'vitest';
import type { Incident } from '../../core/types.ts';
import { impactText, impactWording, incidentTone, recoveryText } from '../../src/components/IncidentCard/model.ts';

const MC = 100_000; // millicents per dollar
const base = (over: Partial<Incident>): Incident =>
  ({
    id: 'inc_1',
    type: 'regression',
    objectKey: 'pipe:default:mrd_pay_sample',
    label: 'Payments API sampling',
    severity: 'high',
    openedAt: '2026-09-27T12:00:00.000Z',
    impactPerDayM: 25 * MC,
    ...over,
  }) as Incident;

describe('impactWording', () => {
  it('an open regression: a day, and a year if left', () => {
    expect(impactText(base({}))).toBe('$25 a day · $9,125 a year if left');
  });

  it('an open spike: a day above normal while it lasts, never a year', () => {
    const text = impactText(base({ type: 'spike', impactPerDayM: 5_096 * MC }));
    expect(text).toBe('$5,096 a day above normal while it lasts');
    expect(text).not.toMatch(/year/);
  });

  it('a closed spike or regression: while it lasted, for how long, never a year', () => {
    const spike = base({ type: 'spike', impactPerDayM: 5_096 * MC, closedAt: '2026-09-27T12:03:19.000Z' });
    expect(impactText(spike)).toBe('$5,096 a day above normal while it lasted · 3 min 19 s');
    const reg = base({ closedAt: '2026-09-27T12:05:00.000Z' });
    expect(impactText(reg)).toBe('$25 a day above normal while it lasted · 5 min');
    for (const i of [spike, reg]) expect(impactText(i)).not.toMatch(/year/);
  });

  it('a close with no usable duration (over a day, or out of order) drops the duration', () => {
    expect(impactText(base({ closedAt: '2026-09-29T12:00:00.000Z' }))).toBe('$25 a day above normal while it lasted');
    expect(impactWording(base({ closedAt: '2026-09-27T11:00:00.000Z' })).duration).toBeUndefined();
  });

  it('good news and budget pace keep the day and the year', () => {
    expect(impactText(base({ type: 'goodnews' }))).toBe('$25 a day · $9,125 a year');
    expect(impactText(base({ type: 'budget' }))).toBe('$25 a day · $9,125 a year');
  });
});

// Founder-build r1 ui-6: the card words a close by why it closed.
describe('closed by a member (m15, D62): the card and the channels say the same', () => {
  it('an accepted or muted regression keeps its day and its year: nothing ended, so never "while it lasted"', () => {
    for (const closedReason of ['accepted', 'muted', 'excluded'] as const) {
      const text = impactText(base({ closedAt: '2026-09-27T12:04:12.000Z', closedReason }));
      expect(text, closedReason).toBe('$25 a day · $9,125 a year if left');
      expect(text).not.toMatch(/while it lasted/);
    }
  });

  it('a spike a member closed keeps the spike wording (a day above normal while it lasts)', () => {
    expect(impactText(base({ type: 'spike', impactPerDayM: 5_096 * MC, closedAt: '2026-09-27T12:03:19.000Z', closedReason: 'muted' }))).toBe(
      '$5,096 a day above normal while it lasts',
    );
  });
});

describe('a below-floor close (M9): closed, not recovered', () => {
  const belowFloor = base({ before: 0.75, after: 0.25, closedAt: '2026-09-27T13:00:00.000Z', notes: ['below-floor'] });

  it('is neutral, never the recovered green', () => {
    expect(incidentTone(belowFloor)).toBe('info');
    expect(incidentTone(base({ before: 0.75, after: 0.25, closedAt: '2026-09-27T13:00:00.000Z', recoveredTo: 0.74 }))).toBe('recovered');
  });

  it('says it fell under the alert floor and where savings still are, never "Recovered"', () => {
    const text = recoveryText(belowFloor);
    expect(text).toBe('Closed · the drop fell under the alert floor · savings still at 25%.');
    expect(text).not.toMatch(/Recovered|closed itself/);
  });
});

describe('good news (row 9, PACK_PAYOFF F1): its own words, never recovery copy', () => {
  it('a closed good-news card says the improvement held, at its level', () => {
    const text = recoveryText(base({ type: 'goodnews', before: 0, after: 0.34, closedAt: '2026-09-27T13:00:00.000Z' }));
    expect(text).toBe('Improvement held · savings at 34%.');
    expect(text).not.toMatch(/Recovered|back to/);
  });
});

// Founder-build r2 ui-4 (FINDINGS_R2 #2 card half, contract C3): the money line under a below-floor close. Fixtures from
// app-assurance r2/2 (zz-r2m-belowfloor.test.ts): a 75 % → 25 % regression at $61 a day, open 4 h, closed (a) by the
// $5/day floor with notes ['below-floor'], (b) by a member ('accepted', 'muted'). Before the fix the card printed
// "$61 a day above normal while it lasted · 4 h" under its head "savings still at 25%", while the bell and Slack said
// "fell under the $5/day floor; savings still at 25%".
describe('r2 ui-4: a close that is not a recovery never reads "while it lasted"', () => {
  const r2 = (over: Partial<Incident>): Incident =>
    base({
      id: 'inc_floor1',
      label: 'Windows trim',
      objectKey: 'pipe:default:win_trim',
      openedAt: '2026-09-27T08:00:00.000Z',
      closedAt: '2026-09-27T12:00:00.000Z',
      before: 0.75,
      after: 0.25,
      impactPerDayM: 6_100_000,
      ...over,
    });
  const floor = r2({ notes: ['below-floor'] });

  it('a below-floor close reads the floor wording every channel prints, never a year, never "while it lasted"', () => {
    const text = impactText(floor);
    expect(text).toBe('fell under the $5/day floor; savings still at 25%');
    expect(text).not.toMatch(/while it lasted|year|recover/i);
    expect(impactWording(floor).duration).toBeUndefined();
    // Under its head, the card never says the drop ended while the head says the savings are still down.
    expect(recoveryText(floor)).toBe('Closed · the drop fell under the alert floor · savings still at 25%.');
  });

  it('the floor is the workspace\'s own when the card knows it', () => {
    expect(impactText(floor, { floorCentsPerDay: 1_000 })).toBe('fell under the $10/day floor; savings still at 25%');
  });

  it('a below-floor close with no reading left (a card placed directly) names the floor only', () => {
    const bare = r2({ notes: ['below-floor'], after: undefined, before: undefined });
    expect(impactText(bare)).toBe('fell under the $5/day floor');
  });

  it('accepted and muted read "a year if left" (D62): the drop did not end', () => {
    for (const closedReason of ['accepted', 'muted'] as const) {
      const text = impactText(r2({ closedReason, closedBy: 'Sam' }));
      expect(text, closedReason).toBe('$61 a day · $22,265 a year if left');
      expect(text).not.toMatch(/while it lasted/);
    }
    // A member's close wins over a below-floor note (the member acted; the channels word it the same way).
    expect(impactText(r2({ closedReason: 'accepted', notes: ['below-floor'] }))).toBe('$61 a day · $22,265 a year if left');
  });

  it('the recovered case is unchanged: a day above normal while it lasted, for how long', () => {
    // The duration keeps its no-break space ("4 h" never wraps).
    expect(impactText(r2({ recoveredTo: 0.74 }))).toBe('$61 a day above normal while it lasted · 4\u00a0h');
    expect(impactText(r2({ notes: ['catch-up'] }))).toBe('$61 a day above normal while it lasted · 4\u00a0h');
  });
});
