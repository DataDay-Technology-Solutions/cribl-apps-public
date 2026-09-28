// @vitest-environment jsdom
// W3-RECEIPT-2 (P2-W07 part c): the Receipt's 30-day trend labels the largest priced configuration change at its
// diamond, priced exactly as the Ledger's Changes list prices it (core/commitImpacts.ts). Nothing is labelled when no
// change in the window is priced ('not priced' and flat changes never get a label), and the choice is deterministic.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Commit, Snapshot } from '../../core/types.ts';
import { commitImpacts, largestImpact, type CommitImpact } from '../../core/commitImpacts.ts';
import { fmtDollars } from '../../core/format.ts';
import { fromIso, localDayKey } from '../../core/time.ts';
import { TrendCard } from '../../src/views/Receipt/Sections.tsx';
import { TrendChart } from '../../src/components/TrendChart/TrendChart.tsx';
import { annotationDomain, collectedDays } from '../../src/components/TrendChart/trendMath.ts';

afterEach(cleanup);

const TOUR = JSON.parse(readFileSync(resolve(__dirname, '../../demo/sample/tour.json'), 'utf8')) as { snapshot: Snapshot; settings: { displayTimezone?: string } };
const TZ = TOUR.settings.displayTimezone || 'America/Chicago';
const SNAP = TOUR.snapshot;
const SWEEP = fromIso(SNAP.sweepAt);
const TODAY = localDayKey(SWEEP, TZ);

function annotations(snapshot: Snapshot): Element[] {
  cleanup();
  const { container } = render(<TrendCard snapshot={snapshot} todayKey={TODAY} tz={TZ} />);
  return [...container.querySelectorAll('[data-testid="trend-annotation"]')];
}

describe('W3-RECEIPT-2: the trend names its biggest priced change', () => {
  it('the tour: exactly one annotation, the Ledger’s priced figure and hash', () => {
    const notes = annotations(SNAP);
    expect(notes).toHaveLength(1);
    const days = collectedDays(SNAP.trend ?? [], TODAY, fromIso(SNAP.collectingSince), TZ).days;
    const best = largestImpact(commitImpacts(SNAP, { days: 31, timeZone: TZ }), annotationDomain(days, TZ, SWEEP)!)!;
    expect(best.status).toBe('priced');
    const hash = best.commit.hash.slice(0, 7);
    expect(notes[0].getAttribute('data-hash')).toBe(hash);
    // The Ledger's Changes row prints signedMoney(perDayM): lib/format adds the '+', core/format the real minus.
    const amount = best.perDayM > 0 ? `+${fmtDollars(best.perDayM)}` : fmtDollars(best.perDayM);
    expect(notes[0].getAttribute('data-amount')).toBe(amount);
    expect(notes[0].getAttribute('data-tone')).toBe(best.perDayM > 0 ? 'up' : 'down');
    expect(notes[0].textContent).toMatch(new RegExp(`^${amount.replace(/[$+]/g, '\\$&')} / day · ${hash}(, today)?$`));
    // The Ledger lists the last 7 days; the annotated change is among them with the same figure.
    const ledgerRow = commitImpacts(SNAP, { timeZone: TZ }).find((i) => i.commit.hash === best.commit.hash);
    expect(ledgerRow?.perDayM).toBe(best.perDayM);
  });

  it('commits that are all unpriced or flat: no annotation', () => {
    const priced = new Set(commitImpacts(SNAP, { days: 31, timeZone: TZ }).filter((i) => i.status === 'priced').map((i) => i.commit.hash));
    expect(priced.size).toBeGreaterThan(0);
    const unpricedOnly: Snapshot = { ...SNAP, timeline: (SNAP.timeline ?? []).filter((c) => !priced.has(c.hash)) };
    expect(commitImpacts(unpricedOnly, { days: 31, timeZone: TZ }).every((i) => i.status !== 'priced')).toBe(true);
    expect(annotations(unpricedOnly)).toHaveLength(0);
    expect(annotations({ ...SNAP, timeline: [] })).toHaveLength(0);
  });

  it('a flat or zero figure never gets a label, even when passed in', () => {
    const days = collectedDays(SNAP.trend ?? [], TODAY, fromIso(SNAP.collectingSince), TZ).days;
    const commit = (SNAP.timeline ?? [])[0] as Commit;
    const { container } = render(
      <TrendChart points={SNAP.trend ?? []} todayKey={TODAY} commits={(SNAP.timeline ?? []) as Commit[]} tz={TZ} annotation={{ hash: commit.hash, t: SWEEP, perDayM: 0 }} />,
    );
    expect(days.length).toBeGreaterThan(2);
    expect(container.querySelectorAll('[data-testid="trend-annotation"]')).toHaveLength(0);
  });

  it('the choice is deterministic: the same annotation whatever the timeline’s order; ties go to the first ranked', () => {
    const forward = annotations(SNAP).map((n) => `${n.getAttribute('data-hash')} ${n.getAttribute('data-amount')}`);
    const reversed = annotations({ ...SNAP, timeline: [...(SNAP.timeline ?? [])].reverse() }).map((n) => `${n.getAttribute('data-hash')} ${n.getAttribute('data-amount')}`);
    expect(reversed).toEqual(forward);
    // Equal |$ / day|: largestImpact keeps the first of commitImpacts' ranking (newest first on ties).
    const base = commitImpacts(SNAP, { days: 31, timeZone: TZ })[0];
    const newer: CommitImpact = { ...base, commit: { ...base.commit, hash: 'aaaaaaa0000' }, t: SWEEP - 60_000, status: 'priced', perDayM: 50_000_000 };
    const older: CommitImpact = { ...base, commit: { ...base.commit, hash: 'bbbbbbb0000' }, t: SWEEP - 120_000, status: 'priced', perDayM: -50_000_000 };
    expect(largestImpact([newer, older], [0, SWEEP])?.commit.hash).toBe('aaaaaaa0000');
  });
});
