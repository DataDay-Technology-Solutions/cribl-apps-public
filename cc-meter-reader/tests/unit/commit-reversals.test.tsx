// @vitest-environment jsdom
// Usefulness review, round 2: the first tour every judge sees printed a commit ledger that did not add up. The break
// (22d0a5e) is priced −$1,250 a day from its alert and its revert (9a9a4c6) +$1,013 from the flows that moved, so
// "Net of the priced changes" read −$237 a day while the alert said "recovered to 75%", and the Receipt's trend and
// the Ledger's timeline still headlined −$1,250 a day after the recovery.
//
// A drop priced from its alert whose alert closed by recovering, and the later change that moved the same flows back,
// are listed with what happened, never headlined, and never summed into the net.

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import tour from '../../demo/sample/tour.json' with { type: 'json' };
import { commitImpacts, type CommitImpact } from '../../core/commitImpacts.ts';
import type { Incident, Snapshot } from '../../core/types.ts';
import { ChangesList } from '../../src/components/ChangeTimeline/ChangesList.tsx';
import { isSettled, largestAttributed, reversals } from '../../src/components/ChangeTimeline/money.ts';
import { applyStepToSnapshot } from '../../src/tour/engine.ts';

afterEach(cleanup);

type Step = Parameters<typeof applyStepToSnapshot>[1] & { at: number; payload: unknown };
const TOUR = tour as unknown as { snapshot: Snapshot; script: Step[]; timezone: string };

/** The tour's snapshot after `until` seconds of its script (every step at or before it applied). */
function tourAt(until: number): Snapshot {
  let s = TOUR.snapshot;
  for (const step of TOUR.script) {
    if (step.at > until || (step.action as string) === 'caption') continue;
    s = applyStepToSnapshot(s, step, step.payload);
  }
  return s;
}

const ALL: [number, number] = [0, Number.MAX_SAFE_INTEGER];
const short = (i: CommitImpact | undefined) => i?.commit.hash.slice(0, 7);

describe('reversals on the tour', () => {
  it('while the alert is open, the break is the largest priced change and nothing is settled', () => {
    const snap = tourAt(60);
    const impacts = commitImpacts(snap, { timeZone: TOUR.timezone });
    const rev = reversals(impacts, snap);
    expect(rev.undone.size).toBe(0);
    expect(short(largestAttributed(impacts, ALL, rev))).toBe('22d0a5e');
  });

  it('after the recovery the break is undone by its revert, and neither is headlined', () => {
    const snap = tourAt(200);
    const impacts = commitImpacts(snap, { timeZone: TOUR.timezone });
    const rev = reversals(impacts, snap);
    const brk = impacts.find((i) => short(i) === '22d0a5e')!;
    const revert = impacts.find((i) => short(i) === '9a9a4c6')!;
    expect(rev.undone.get(brk.commit.hash)?.by).toBe(revert.commit.hash);
    expect(rev.undoes.get(revert.commit.hash)).toBe(brk.commit.hash);
    expect(isSettled(brk, rev) && isSettled(revert, rev)).toBe(true);
    const named = largestAttributed(impacts, ALL, rev);
    expect(['22d0a5e', '9a9a4c6']).not.toContain(short(named));
  });

  it('the Changes list says what happened and its net leaves the pair out', () => {
    const snap = tourAt(200);
    const impacts = commitImpacts(snap, { timeZone: TOUR.timezone });
    const { container } = render(<ChangesList impacts={impacts} timeZone="UTC" reversals={reversals(impacts, snap)} />);
    const brk = container.querySelector('[data-commit="22d0a5e"]')!;
    expect(brk.getAttribute('data-settled')).toBe('true');
    expect(brk.querySelector('.mr-changes-amount')!.className).toContain('is-flat');
    expect(brk.querySelector('[data-testid="changes-settled"]')!.textContent).toMatch(/^ · Recovered \w{3} \d{1,2}:\d\d\s[AP]M, reverted by 9a9a4c6$/);
    expect(brk.getAttribute('aria-label')).toContain('reverted by 9a9a4c6');
    const revert = container.querySelector('[data-commit="9a9a4c6"]')!;
    expect(revert.querySelector('[data-testid="changes-settled"]')!.textContent).toBe(' · Undid 22d0a5e');
    expect(revert.querySelector('.mr-changes-amount')!.className).toContain('is-flat');
    const net = container.querySelector('[data-testid="changes-net"]')!;
    expect(net.querySelector('.mr-changes-amount')!.textContent).toBe('$0');
    expect(container.querySelector('[data-testid="changes-net-settled"]')!.textContent).toBe(
      'A drop that recovered, and the change that undid it, are not in the net.',
    );
  });
});

// ─── The rule, case by case ──────────────────────────────────────────────────

const MC = 100_000;
const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const MIN = 60_000;
const KEY = 'route:default:r_pay';

function impact(hash: string, basis: CommitImpact['basis'], dollars: number, at: number, moved: CommitImpact['moved'] = []): CommitImpact {
  return {
    commit: { hash: `${hash}000000000`, message: `commit ${hash}`, author: 'Dana Kim', committedAt: new Date(at).toISOString(), deployedAt: new Date(at).toISOString(), files: [] },
    t: at,
    status: 'priced',
    basis,
    perDayM: dollars * MC,
    perYearM: dollars * MC * 365,
    moved,
  } as unknown as CommitImpact;
}

function regression(hash: string, over: Partial<Incident> = {}): Incident {
  return {
    id: `inc-${hash}`,
    type: 'regression',
    severity: 'high',
    objectKey: KEY,
    label: 'Payments API',
    openedAt: new Date(T0 + 2 * MIN).toISOString(),
    commit: { hash: `${hash}000000000`, message: 'break', author: 'Dana Kim', committedAt: new Date(T0).toISOString(), groupId: 'default', match: 'files' },
    before: 0.75,
    after: 0.5,
    impactPerDayM: 1_250 * MC,
    notes: [],
    deliveries: [],
    ...over,
  };
}

const up = (dollars: number) => [{ key: KEY, label: 'Payments API', before: 0.5, after: 0.75, delta: 0.25, source: 'flow' as const, touched: true, perDayM: dollars * MC }];

describe('reversals, case by case', () => {
  const brk = impact('aaaaaaa', 'alert', -1_250, T0);
  const fix = impact('bbbbbbb', 'flows', 1_013, T0 + 5 * MIN, up(1_013));
  const other = impact('ccccccc', 'flows', 300, T0 + 6 * MIN);

  it('an alert still open: nothing settled, the drop is headlined and in the net', () => {
    const rev = reversals([brk, fix, other], { incidents: [regression('aaaaaaa')] });
    expect(rev.undone.size).toBe(0);
    expect(short(largestAttributed([brk, fix, other], ALL, rev))).toBe('aaaaaaa');
  });

  it('an alert a member accepted as the new normal is not a recovery: the drop stands', () => {
    const rev = reversals([brk, fix], { incidents: [regression('aaaaaaa', { closedAt: new Date(T0 + 9 * MIN).toISOString(), closedReason: 'accepted' })] });
    expect(rev.undone.size).toBe(0);
  });

  it('recovered with no change moving the flows back: the drop alone is settled', () => {
    const rev = reversals([brk, other], { incidents: [regression('aaaaaaa', { closedAt: new Date(T0 + 9 * MIN).toISOString() })] });
    expect(rev.undone.get(brk.commit.hash)).toEqual({ recoveredAt: T0 + 9 * MIN });
    expect(rev.undoes.size).toBe(0);
    const { container } = render(<ChangesList impacts={[brk, other]} timeZone="UTC" reversals={rev} />);
    expect(container.querySelector('[data-commit="aaaaaaa"] [data-testid="changes-settled"]')!.textContent).toBe(' · Recovered Sun 12:09 PM');
    expect(container.querySelector('[data-testid="changes-net"] .mr-changes-amount')!.textContent).toBe('+$300');
  });

  it('a change after the alert closed is not the one that undid it', () => {
    const late = impact('ddddddd', 'flows', 1_013, T0 + 20 * MIN, up(1_013));
    const rev = reversals([brk, late], { incidents: [regression('aaaaaaa', { closedAt: new Date(T0 + 9 * MIN).toISOString() })] });
    expect(rev.undone.get(brk.commit.hash)?.by).toBeUndefined();
    expect(isSettled(late, rev)).toBe(false);
  });

  it('the undoing change is the first one after the drop whose own flows on the alert’s object moved back up', () => {
    const rev = reversals([other, fix, brk], { incidents: [regression('aaaaaaa', { closedAt: new Date(T0 + 9 * MIN).toISOString() })] });
    expect(rev.undone.get(brk.commit.hash)?.by).toBe(fix.commit.hash);
    expect(isSettled(other, rev)).toBe(false);
    expect(short(largestAttributed([brk, fix, other], ALL, rev))).toBe('ccccccc');
  });
});
