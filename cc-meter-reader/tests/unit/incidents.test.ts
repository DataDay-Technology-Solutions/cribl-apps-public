import { describe, expect, it } from 'vitest';
import type { Incident } from '../../core/types.ts';
import {
  MAX_INCIDENTS,
  RECOVERY_POINTS,
  closeDemoIncidents,
  incidentId,
  incidentReadings,
  incidentsDocKey,
  isOpen,
  mergeIncidentUpdates,
  partitionByDocKey,
  severityRank,
  shouldNotify,
  titleFor,
} from '../../core/incidents.ts';

const inc = (over: Partial<Incident> = {}): Incident => ({
  id: 'inc_000001',
  type: 'regression',
  severity: 'high',
  objectKey: 'route:default:r_pay',
  label: 'Payments API sampling',
  openedAt: '2026-09-26T03:42:03.000Z',
  before: 0.75,
  after: 0.5,
  impactPerDayM: 2_500_000,
  notes: [],
  deliveries: [],
  ...over,
});

describe('identity', () => {
  it('makes stable short ids', () => {
    const a = incidentId('regression', 'route:default:r_pay', 1000);
    expect(a).toMatch(/^inc_[0-9a-f]{6}$/);
    expect(incidentId('regression', 'route:default:r_pay', 1000)).toBe(a);
    expect(incidentId('regression', 'route:default:r_pay', 2000)).not.toBe(a);
    expect(incidentId('spike', 'route:default:r_pay', 1000)).not.toBe(a);
  });
  it('keys docs by UTC day', () => {
    expect(incidentsDocKey(Date.parse('2026-09-26T23:59:59Z'))).toBe('incidents/2026-09-26');
  });
});

describe('titles', () => {
  it('uses the SPEC 17 copy', () => {
    expect(titleFor(inc())).toBe('Savings dropped: Payments API sampling');
    expect(titleFor(inc({ type: 'spike', label: 'Payments API' }))).toBe('Cost spike: Payments API');
    expect(titleFor(inc({ type: 'budget', label: 'siem-prod' }))).toBe('Over budget pace: siem-prod');
    expect(titleFor(inc({ type: 'goodnews', label: 'VPC Flow aggregation' }))).toBe('Savings improved: VPC Flow aggregation');
    expect(titleFor({ type: 'other' as never, label: 'x' })).toBe('x');
  });
});

describe('shouldNotify', () => {
  const ep = { enabled: true, minSeverity: 'medium' as const };
  const now = Date.parse('2026-09-26T04:00:00Z');
  it('gates on enabled and minimum severity', () => {
    expect(shouldNotify(inc(), { ...ep, enabled: false }, now, 60)).toBe(false);
    expect(shouldNotify(inc({ severity: 'info' }), ep, now, 60)).toBe(false);
    expect(shouldNotify(inc({ severity: 'info' }), { enabled: true, minSeverity: 'info' }, now, 60)).toBe(true);
    expect(shouldNotify(inc({ severity: 'medium' }), { enabled: true, minSeverity: 'high' }, now, 60)).toBe(false);
    expect(shouldNotify(inc(), { enabled: true } as never, now, 60)).toBe(true);
  });
  it('sends the first notification, recoveries, severity rises and after the cooldown', () => {
    expect(shouldNotify(inc(), ep, now, 60)).toBe(true);
    const notified = inc({ lastNotifiedAt: '2026-09-26T03:30:00.000Z' });
    expect(shouldNotify(notified, ep, now, 60)).toBe(false);
    expect(shouldNotify(notified, ep, now, 30)).toBe(true);
    expect(shouldNotify({ ...notified, closedAt: '2026-09-26T03:59:00.000Z' }, ep, now, 60)).toBe(true);
    expect(shouldNotify(notified, ep, now, 60, 'medium')).toBe(true);
    expect(shouldNotify(notified, ep, now, 60, 'high')).toBe(false);
    expect(shouldNotify(inc({ lastNotifiedAt: 'bad' }), ep, now, 60)).toBe(true);
  });
  it('ranks severities', () => {
    expect(severityRank('high')).toBeGreaterThan(severityRank('medium'));
    expect(severityRank('medium')).toBeGreaterThan(severityRank('info'));
    expect(severityRank(undefined)).toBe(-1);
  });
});

describe('incident documents', () => {
  it('upserts opened, updated and closed incidents newest first', () => {
    const a = inc({ id: 'a', openedAt: '2026-09-26T01:00:00.000Z' });
    const b = inc({ id: 'b', openedAt: '2026-09-26T02:00:00.000Z' });
    const c = inc({ id: 'c', openedAt: '2026-09-26T03:00:00.000Z' });
    const items = mergeIncidentUpdates([a, b], [c], [{ ...b, severity: 'medium' }], [{ ...a, closedAt: '2026-09-26T03:30:00.000Z' }]);
    expect(items.map((i) => i.id)).toEqual(['c', 'b', 'a']);
    expect(items[1].severity).toBe('medium');
    expect(isOpen(items[2])).toBe(false);
    expect(mergeIncidentUpdates(undefined as unknown as Incident[], [], [], [])).toEqual([]);
  });
  it('caps at 500, dropping the oldest closed first', () => {
    const base = Date.parse('2026-09-01T00:00:00Z');
    const items = Array.from({ length: MAX_INCIDENTS }, (_, i) =>
      inc({ id: `i${i}`, openedAt: new Date(base + i * 60_000).toISOString(), closedAt: i % 2 === 0 ? new Date(base + i * 60_000 + 1).toISOString() : undefined }),
    );
    const fresh = [inc({ id: 'new1', openedAt: '2026-09-26T00:00:00.000Z' }), inc({ id: 'new2', openedAt: '2026-09-26T00:01:00.000Z' })];
    const out = mergeIncidentUpdates(items, fresh, [], []);
    expect(out).toHaveLength(MAX_INCIDENTS);
    expect(out.find((i) => i.id === 'i0')).toBeUndefined();
    expect(out.find((i) => i.id === 'i2')).toBeUndefined();
    expect(out.find((i) => i.id === 'i1')).toBeDefined();
    expect(out[0].id).toBe('new2');
  });
  it('partitions incidents by the day they opened', () => {
    const p = partitionByDocKey([inc({ id: 'a', openedAt: '2026-09-25T23:00:00Z' }), inc({ id: 'b' }), inc({ id: 'c', openedAt: 'bad' })]);
    expect(Object.keys(p).sort()).toEqual(['incidents/1970-01-01', 'incidents/2026-09-25', 'incidents/2026-09-26']);
  });
  it('closes demo-caused open incidents only', () => {
    const items = [
      inc({ id: 'd', notes: ['demo-profile'] }),
      inc({ id: 'e', notes: ['demo'] }),
      inc({ id: 's', notes: ['sample'] }),
      inc({ id: 'r', notes: [] }),
      inc({ id: 'x', notes: ['demo'], closedAt: '2026-09-26T00:00:00.000Z' }),
    ];
    const out = closeDemoIncidents(items, '2026-09-26T05:00:00.000Z');
    expect(out.map((i) => i.closedAt)).toEqual([
      '2026-09-26T05:00:00.000Z',
      '2026-09-26T05:00:00.000Z',
      '2026-09-26T05:00:00.000Z',
      undefined,
      '2026-09-26T00:00:00.000Z',
    ]);
    expect(items[0].closedAt).toBeUndefined();
  });
});

describe('incidentReadings (D47)', () => {
  const closedAt = '2026-09-26T03:50:03.000Z';
  it('an open incident is before and the worst after; a closed one adds where it recovered to', () => {
    expect(incidentReadings(inc())).toEqual({ before: 0.75, after: 0.5, legacy: false });
    expect(incidentReadings(inc({ closedAt, recoveredTo: 0.89 }))).toEqual({ before: 0.75, after: 0.5, recoveredTo: 0.89, legacy: false });
    expect(incidentReadings(inc({ type: 'spike', before: 1_000_000, after: 5_000_000, closedAt, recoveredTo: 1_005_000 }))).toEqual({
      before: 1_000_000,
      after: 5_000_000,
      recoveredTo: 1_005_000,
      legacy: false,
    });
  });
  it('an incident closed before D47 carried the reading at close in `after`: the recovery is known, the drop is not', () => {
    // The org's KV: 0.756 → 0.49 closed as 0.756 → 0.89.
    expect(incidentReadings(inc({ before: 0.756, after: 0.89, closedAt }))).toEqual({ before: 0.756, recoveredTo: 0.89, legacy: true });
    // …and one that recovered to just under its baseline, inside the recovery band (replay.json inc_f57929).
    expect(incidentReadings(inc({ before: 0.735, after: 0.688, closedAt }))).toEqual({ before: 0.735, recoveredTo: 0.688, legacy: true });
    expect((0.735 - 0.688) * 100).toBeLessThanOrEqual(RECOVERY_POINTS);
    // A spike or budget that closed under its baseline.
    expect(incidentReadings(inc({ type: 'spike', before: 15_221_153, after: 11_941_740, closedAt }))).toEqual({ before: 15_221_153, recoveredTo: 11_941_740, legacy: true });
    expect(incidentReadings(inc({ type: 'budget', before: 90, after: 84.2, closedAt }))).toEqual({ before: 90, recoveredTo: 84.2, legacy: true });
  });
  it('a closed incident still on the wrong side of its baseline keeps its drop and has no recovery reading', () => {
    // Closed by a demo reset, or below the D26 floor (replay.json inc_bb03ce: 0.297 → 0).
    expect(incidentReadings(inc({ closedAt }))).toEqual({ before: 0.75, after: 0.5, legacy: false });
    expect(incidentReadings(inc({ before: 0.297, after: 0, closedAt, notes: ['below-floor'] }))).toEqual({ before: 0.297, after: 0, legacy: false });
    // The same close through today's detector: it records no `recoveredTo` (the ratio never came back), so it
    // lands on this path too, never as "recovered to 0%".
    expect(incidentReadings(inc({ before: 0.297, after: 0, closedAt, recoveredTo: undefined, notes: ['catch-up', 'below-floor'] }))).toEqual({ before: 0.297, after: 0, legacy: false });
    expect(incidentReadings(inc({ type: 'spike', before: 1_000_000, after: 5_000_000, closedAt }))).toEqual({ before: 1_000_000, after: 5_000_000, legacy: false });
    expect(incidentReadings(inc({ type: 'budget', before: 90, after: 104.3, closedAt }))).toEqual({ before: 90, after: 104.3, legacy: false });
  });
  it('good news is one-shot: its `after` is the improvement, never a recovery', () => {
    expect(incidentReadings(inc({ type: 'goodnews', before: 0, after: 0.33, closedAt }))).toEqual({ before: 0, after: 0.33, legacy: false });
  });
});
