// The incident money line (usefulness review, round 1): only an open regression is projected to a year, and then
// as its cost if left unfixed. A spike is transient and a closed incident is over, so neither is annualized: the
// same rule the report card follows (report.card.impact), so the App never contradicts itself.

import { describe, expect, it } from 'vitest';
import type { Incident } from '../../core/types.ts';
import { impactText, impactWording } from '../../src/components/IncidentCard/model.ts';

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
