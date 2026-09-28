// @vitest-environment jsdom
// Usefulness review, round 1: a 'workspace' or 'daily' commit price is the whole workspace's shift around a deploy,
// not the change's own. It is never promoted to the Receipt's or the timeline's "largest priced change", never summed
// into the Changes list's net, and never shown as a gain or a loss of that commit.

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommitImpact } from '../../core/commitImpacts.ts';
import { isAttributed, isUnattributedShift, largestAttributed } from '../../src/components/ChangeTimeline/money.ts';
import { ChangesList } from '../../src/components/ChangeTimeline/ChangesList.tsx';
import { t } from '../../src/copy/en.ts';

afterEach(cleanup);

const MC = 100_000;
const T = Date.parse('2026-09-27T12:00:00.000Z');

function impact(hash: string, basis: CommitImpact['basis'], dollars: number, over: Partial<CommitImpact> = {}): CommitImpact {
  return {
    commit: { hash: `${hash}000000000`, message: `commit ${hash}`, author: 'Dana Kim', committedAt: new Date(T).toISOString(), deployedAt: new Date(T).toISOString(), files: [] },
    t: T,
    status: 'priced',
    perDayM: dollars * MC,
    perYearM: dollars * MC * 365,
    moved: [],
    ...(basis ? { basis } : {}),
    ...over,
  } as CommitImpact;
}

describe('isAttributed', () => {
  it('alert and flows are the change’s own; workspace and daily are shifts', () => {
    expect(isAttributed(impact('a', 'alert', 1))).toBe(true);
    expect(isAttributed(impact('b', 'flows', 1))).toBe(true);
    expect(isUnattributedShift(impact('c', 'workspace', 1))).toBe(true);
    expect(isUnattributedShift(impact('d', 'daily', 1))).toBe(true);
    expect(isAttributed(impact('e', 'flows', 0, { status: 'flat' }))).toBe(false);
    expect(isUnattributedShift(impact('f', 'daily', 0, { status: 'flat' }))).toBe(false);
  });
});

describe('largestAttributed', () => {
  it('names the largest change priced on its own flows, however big a daily shift is', () => {
    const daily = impact('ab935f7', 'daily', -2_208);
    const flows = impact('22d0a5e', 'flows', -1_219);
    expect(largestAttributed([daily, flows], [0, T])?.commit.hash.slice(0, 7)).toBe('22d0a5e');
  });

  it('names nothing when only shifts are priced', () => {
    expect(largestAttributed([impact('a', 'daily', 500), impact('b', 'workspace', -300)], [0, T])).toBeUndefined();
  });
});

describe('<ChangesList> with an unattributed shift', () => {
  it('lists the shift in neutral ink, says why, and leaves it out of the net', () => {
    const rows = [impact('ab935f7', 'daily', -2_208), impact('22d0a5e', 'flows', -1_219), impact('d2f54cd', 'alert', 66)];
    const { container } = render(<ChangesList impacts={rows} timeZone="UTC" />);
    const shift = container.querySelector('[data-commit="ab935f7"]')!;
    expect(shift.getAttribute('data-attributed')).toBe('false');
    expect(shift.querySelector('.mr-changes-amount')!.className).toContain('is-flat');
    expect(shift.textContent).toContain(t('ledger.timeline.unattributed'));
    expect(shift.getAttribute('aria-label')).toContain('The whole workspace moved');
    const own = container.querySelector('[data-commit="22d0a5e"]')!;
    expect(own.getAttribute('data-attributed')).toBe('true');
    expect(own.querySelector('.mr-changes-amount')!.className).toContain('is-down');
    // Net: −1,219 + 66 = −1,153, not −3,361.
    const net = container.querySelector('[data-testid="changes-net"]')!;
    expect(net.querySelector('.mr-changes-amount')!.textContent).toBe('−$1,153');
    expect(container.querySelector('[data-testid="changes-net-note"]')!.textContent).toBe(t('ledger.timeline.changes.netNote'));
  });

  it('no note when every priced row is the change’s own', () => {
    const { container } = render(<ChangesList impacts={[impact('a1', 'flows', -10), impact('b1', 'alert', 20)]} timeZone="UTC" />);
    expect(container.querySelector('[data-testid="changes-net-note"]')).toBeNull();
  });
});
