// The Ledger's Changes list says "Every commit of the last 7 days", but the snapshot keeps only the newest 30 commits
// (10, then 5, once compacted). When the 7 days held more, the snapshot says so (timelineTruncated) and the list's
// caption names the latest N instead (review W2, truth lens).

import { describe, expect, it } from 'vitest';
import { buildSnapshot, droppedRecentCommit, MAX_SNAPSHOT_TIMELINE } from '../../core/snapshot.ts';
import { commitImpacts } from '../../core/commitImpacts.ts';
import { defaultSettings } from '../../core/settings.ts';
import type { Commit } from '../../core/types.ts';

const NOW = Date.parse('2026-09-27T12:00:30Z');
const END = Date.parse('2026-09-27T12:00:00Z');
const commits = (n: number, everyH: number): Commit[] =>
  Array.from({ length: n }, (_, i) => {
    const at = new Date(END - (i + 1) * everyH * 3_600_000).toISOString();
    return { hash: i.toString(16).padStart(7, '0') + 'a'.repeat(33), message: `change ${i}`, author: 'someone', committedAt: at, deployedAt: at, groupId: 'default', files: [], source: 'api' } as Commit;
  });
function snapshotWith(timeline: Commit[]) {
  return buildSnapshot({
    sweepAtMs: NOW,
    windowStartMs: END - 60_000,
    windowEndMs: END,
    mode: 'ui' as never,
    settings: defaultSettings('2026-09-27T12:00:00.000Z', 'UTC'),
    prices: { schemaVersion: 1, updatedAt: new Date(0).toISOString(), versions: [] } as never,
    flows: [],
    minuteRows: {},
    totals: { schemaVersion: 1 } as never,
    collectingSinceMs: END - 8 * 86_400_000,
    incidents: [],
    timeline,
    deliveries: [],
    calls: 0,
    metricsSource: 'metrics' as never,
  } as never);
}

describe('the Changes list is told when the snapshot kept only the newest commits', () => {
  it('45 commits inside 7 days: 30 kept, flagged', () => {
    const snap = snapshotWith(commits(45, 3));
    expect(snap.timeline).toHaveLength(MAX_SNAPSHOT_TIMELINE);
    expect(snap.timelineTruncated).toBe(true);
    expect(commitImpacts(snap, { timeZone: 'UTC' }).length).toBe(30);
  });

  it('45 commits, one a day: the dropped ones are older than 7 days, so nothing is flagged', () => {
    expect(snapshotWith(commits(45, 24)).timelineTruncated).toBeUndefined();
    expect(snapshotWith(commits(10, 3)).timelineTruncated).toBeUndefined();
  });

  it('droppedRecentCommit looks only at the first commit left out', () => {
    const list = commits(12, 3);
    expect(droppedRecentCommit(list, 10, NOW)).toBe(true);
    expect(droppedRecentCommit(list, 12, NOW)).toBe(false);
    expect(droppedRecentCommit(commits(12, 24), 10, NOW)).toBe(false);
  });
});
