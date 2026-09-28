// Usefulness review, round 1: a commit whose only link to a route is the group's shared route table never reads
// "change to this route". The card's side is ready for core's 'table' match; 'files' and 'message' are unchanged.

import { describe, expect, it } from 'vitest';
import type { Incident } from '../../core/types.ts';
import { causeInfo } from '../../src/components/IncidentCard/model.ts';

const inc = (match: string): Pick<Incident, 'cause' | 'commit' | 'objectKey' | 'openedAt'> =>
  ({
    cause: 'commit',
    objectKey: 'route:default:mrd_windows_dc',
    openedAt: '2026-09-27T12:00:00.000Z',
    commit: { hash: 'f727f09aaaa', message: 'demo: revert the pack on mrd_windows_workstations', author: 'Steve Koelpin', committedAt: '2026-09-27T11:50:00.000Z', match },
  }) as unknown as Pick<Incident, 'cause' | 'commit' | 'objectKey' | 'openedAt'>;

describe('causeInfo and the route table', () => {
  it("a 'table' match reads 'route table edited' with a caveat, never 'change to this route'", () => {
    const c = causeInfo(inc('table'));
    expect(c.kind).toBe('table');
    expect(c.label).toBe('route table edited');
    expect(c.label).not.toMatch(/change to this route/);
    expect(c.caveat).toBe("The commit edited the route table; this route's entry is unchanged or not confirmed, so it may not be the cause.");
  });

  it("'files' and 'message' keep their wording", () => {
    expect(causeInfo(inc('files')).label).toBe('change to this route');
    expect(causeInfo(inc('message')).label).toBe('change naming this route');
  });
});
