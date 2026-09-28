// tests/unit/demo-stage.test.ts — "On the projector" (EPIC_AUDIT P2-W18, day-2 slice): the console's model of the
// presenter takeover — 45 s for a new high-severity alert, 10 s of green for its recovery, timed from detection.

import { describe, expect, it } from 'vitest';
import type { Incident, Snapshot } from '../../core/types.ts';
import { stageTakeover } from '../../src/demo/derive.ts';
import { TAKEOVER_MS } from '../../src/components/IncidentTakeover/tracker.ts';

const T0 = Date.UTC(2026, 8, 28, 15, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function incident(partial: Partial<Incident> = {}): Incident {
  return {
    id: 'i1',
    type: 'regression',
    severity: 'high',
    objectKey: 'pipe:default:mrd_pay_sample',
    label: 'Payments API sampling',
    openedAt: iso(T0),
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    notes: [],
    deliveries: [],
    ...partial,
  };
}

const snap = (incidents: Incident[]): Snapshot => ({ incidents }) as unknown as Snapshot;

describe('stageTakeover', () => {
  it('a new high alert is on the stage for 45 s from its detection, then the meter is back', () => {
    const s = snap([incident()]);
    expect(stageTakeover(s, T0 + 1_000)).toMatchObject({ mode: 'alert', leftMs: TAKEOVER_MS.alert - 1_000 });
    expect(stageTakeover(s, T0 + 44_000)?.mode).toBe('alert');
    expect(stageTakeover(s, T0 + 45_000)).toBeUndefined();
    // Opened on catch-up: the stage saw it when it was detected, not at the minute the change showed.
    const late = snap([incident({ openedAt: iso(T0 - 120_000), detectedAt: iso(T0) })]);
    expect(stageTakeover(late, T0 + 30_000)?.mode).toBe('alert');
  });

  it('medium alerts and good news never take the stage', () => {
    expect(stageTakeover(snap([incident({ severity: 'medium' })]), T0 + 1_000)).toBeUndefined();
    expect(stageTakeover(snap([incident({ type: 'goodnews', after: 0.9 })]), T0 + 1_000)).toBeUndefined();
  });

  it('a recovery shows green for 10 s after the close; the newest alert wins over it', () => {
    const closed = incident({ closedAt: iso(T0 + 300_000), recoveredTo: 0.75 });
    expect(stageTakeover(snap([closed]), T0 + 305_000)).toMatchObject({ mode: 'recovery', leftMs: 5_000 });
    expect(stageTakeover(snap([closed]), T0 + 310_000)).toBeUndefined();
    const fresh = incident({ id: 'i2', type: 'spike', openedAt: iso(T0 + 302_000), before: 400_000, after: 2_000_000 });
    expect(stageTakeover(snap([closed, fresh]), T0 + 305_000)).toMatchObject({ mode: 'alert', incident: { id: 'i2' } });
  });

  it('no snapshot, nothing on the stage', () => {
    expect(stageTakeover(null, T0)).toBeUndefined();
    expect(stageTakeover(snap([]), T0)).toBeUndefined();
  });
});
