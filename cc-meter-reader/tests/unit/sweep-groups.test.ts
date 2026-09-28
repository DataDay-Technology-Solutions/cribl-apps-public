// tests/unit/sweep-groups.test.ts — worker groups and the inventory on multi-group orgs (EPIC_AUDIT P0-02).
//
// The org below has eight Stream worker groups (the listing) and traffic only in `default`: every other group's
// config reads are answered with default's (so each one has flows) but the metrics store has rows for
// `default` alone. Before P0-02 the first sweep picked three rotated groups (wg3–wg5), never `default`, and the
// periodic refresh never fit the 35-call plan: the org metered $0 forever.

import { describe, expect, it } from 'vitest';
import type { CriblHttp } from '../../core/types.ts';
import { DEFAULT_SWEEP_BUDGET, MAX_MISSING_GROUPS_PER_SWEEP } from '../../core/sweep.ts';
import { HOUR, MINUTE, createWorld, type World } from '../integration/harness.ts';

const EIGHT = ['default', ...Array.from({ length: 7 }, (_, i) => `wg${i + 1}`)];

/** An org whose listing names `ids()`; every non-default group's config is default's (and it has no traffic). */
function groupsHttp(ids: () => string[], seen: string[] = []) {
  return (inner: CriblHttp): CriblHttp => ({
    async request(method, path, body, opts) {
      seen.push(`${method} ${path}`);
      if (method === 'GET' && /^\/products\/stream\/groups(\?|$)/.test(path)) {
        const list = ids();
        return { status: 200, ok: true, json: { items: list.map((id) => ({ id, type: 'stream' })), count: list.length } };
      }
      return inner.request(method, path.replace(/^\/m\/wg\d+\//, '/m/default/'), body, opts);
    },
  });
}

async function multiGroupWorld(ids: () => string[] = () => EIGHT, seen: string[] = []): Promise<World> {
  return createWorld({
    wrapHttp: groupsHttp(ids, seen),
    settings: (s) => void (s.demo = { enabled: false, replayMode: false, profile: false }),
  });
}

const known = async (w: World): Promise<string[]> => Object.keys((await w.docs.getInventory())?.byGroup ?? {}).sort();

describe('P0-02 — every listed worker group is metered', () => {
  it('an 8-group org with traffic only in default meters money by sweep 3 without Sweep now; meta.groupsKnown equals the listing', async () => {
    const w = await multiGroupWorld();
    const results = [await w.sweep(), ...(await w.sweepMinutes(2))];
    for (const r of results) expect(r.error).toBeUndefined();
    // Every group is in the inventory: the first run fetched the ones it lacked, regardless of the plan.
    expect(await known(w)).toEqual([...EIGHT].sort());
    const meta = (await w.meta())!;
    expect(meta.groupsKnown).toEqual(EIGHT);
    expect([...(meta.groupsMetered ?? [])].sort()).toEqual([...EIGHT].sort());
    // Money was metered on the seed hour and keeps accruing minute by minute.
    expect(results[0].snapshot!.headline.todayM).toBeGreaterThan(0);
    expect(results[2].snapshot!.headline.todayM).toBeGreaterThan(results[1].snapshot!.headline.todayM);
    expect(results[2].snapshot!.flows.some((f) => f.groupId === 'default' && f.savedPerDayM > 0)).toBe(true);
  });

  it('fetches at most MAX_MISSING_GROUPS_PER_SWEEP missing groups a sweep, default first, and the rest on the next sweeps', async () => {
    const many = ['wg1', 'wg2', 'wg3', 'wg4', 'wg5', 'wg6', 'wg7', 'wg8', 'wg9', 'wg10', 'wg11', 'default'];
    const w = await multiGroupWorld(() => many);
    const seed = await w.sweep();
    expect(seed.error).toBeUndefined();
    const first = await known(w);
    expect(first).toHaveLength(MAX_MISSING_GROUPS_PER_SWEEP);
    expect(first).toContain('default'); // listed last, fetched first: the conventional main group
    expect(seed.snapshot!.headline.todayM).toBeGreaterThan(0);
    await w.sweepMinutes(1);
    expect(await known(w)).toEqual([...many].sort());
  });

  it('adds a worker group the Leader lists later, at the next hourly listing, without Sweep now', async () => {
    let ids = ['default'];
    const w = await multiGroupWorld(() => ids);
    await w.sweep();
    expect(await known(w)).toEqual(['default']);
    ids = ['default', 'wg1'];
    await w.sweepMinutes(3); // same hour: the listing is not re-read
    expect(await known(w)).toEqual(['default']);
    w.set(Math.floor(w.now() / HOUR) * HOUR + HOUR + 20_000);
    const r = await w.sweep();
    expect(r.error).toBeUndefined();
    expect(await known(w)).toEqual(['default', 'wg1']);
    expect((await w.meta())!.groupsKnown).toEqual(['default', 'wg1']);
  });

  it('never drops a known group on a rotation or a failed listing; drops one only when a listing no longer names it', async () => {
    let ids = [...EIGHT];
    let failList = false;
    const w = await createWorld({
      wrapHttp: (inner) => {
        const g = groupsHttp(() => ids)(inner);
        return {
          request: (m, p, b, o) => (failList && /^\/products\/stream\/groups/.test(p) ? Promise.resolve({ status: 500, ok: false }) : g.request(m, p, b, o)),
        };
      },
    });
    await w.sweep();
    for (let i = 0; i < 30; i++) await w.sweepMinutes(1); // periodic refreshes rotate through the groups
    expect(await known(w)).toEqual([...EIGHT].sort());
    failList = true;
    await w.sweep('manual');
    expect(await known(w)).toEqual([...EIGHT].sort());
    failList = false;
    ids = EIGHT.filter((g) => g !== 'wg7');
    await w.sweep('manual');
    expect(await known(w)).toEqual(ids.slice().sort());
  });

  it('refreshes the least recently read groups the plan fits; a due refresh that fits nothing is logged and recorded in meta', async () => {
    const seen: string[] = [];
    const w = await multiGroupWorld(() => EIGHT, seen);
    await w.sweep();
    // Ten minutes on, the refresh is due: the 35-call plan fits one group (four reads), the oldest.
    await w.sweepMinutes(9);
    seen.length = 0;
    const [fits] = await w.sweepMinutes(1);
    expect(fits.calls).toBeLessThanOrEqual(DEFAULT_SWEEP_BUDGET);
    expect(seen.filter((s) => /\/system\/outputs$/.test(s))).toHaveLength(1);
    expect((await w.meta())!.inventorySkippedAt).toBeUndefined();
    // Ten minutes later, under a tighter hard budget, nothing fits: the refresh is skipped, said and recorded.
    await w.sweepMinutes(9);
    seen.length = 0;
    const [tight] = await w.sweepMinutes(1, { budget: fits.calls - 2 });
    expect(tight.error).toBeUndefined();
    expect(seen.filter((s) => /\/system\/outputs$/.test(s))).toHaveLength(0);
    const meta = (await w.meta())!;
    expect(meta.inventorySkippedAt).toBe(new Date(w.now()).toISOString());
    expect(w.logs.some((l) => l.level === 'info' && /inventory refresh due .*does not fit/.test(l.msg))).toBe(true);
    expect(await known(w)).toEqual([...EIGHT].sort());
  });

  it('re-reads an inventory an hour old even when a backfill leaves the plan no room (no hard budget)', async () => {
    const seen: string[] = [];
    const w = await multiGroupWorld(() => EIGHT, seen);
    await w.sweep();
    const before = (await w.docs.getInventory())!;
    seen.length = 0;
    w.set(w.now() + 70 * MINUTE); // a 70-minute gap: the catch-up sweep's mandatory calls fill the plan
    const r = await w.sweep();
    expect(r.error).toBeUndefined();
    expect(r.minutesProcessed).toBeGreaterThanOrEqual(70);
    const after = (await w.docs.getInventory())!;
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
    expect(seen.filter((s) => /\/system\/outputs$/.test(s))).toHaveLength(3); // MAX_GROUPS_PER_REFRESH, oldest first
    expect(Object.keys(after.byGroup).sort()).toEqual([...EIGHT].sort());
    expect(Object.keys(after.groupsFetchedAt ?? {}).sort()).toEqual([...EIGHT].sort());
  });

  it('a commit in one group refreshes that group, not three rotated ones', async () => {
    const seen: string[] = [];
    const w = await multiGroupWorld(() => ['default', 'wg1', 'wg2', 'wg3'], seen);
    await w.sweep();
    await w.sweepMinutes(2);
    // A commit lands in `default` (the emulator dates it now; the next sweep's timeline refresh sees it).
    w.em.control({ action: 'breakTrim', minutesAgo: 0 });
    seen.length = 0;
    for (let i = 0; i < 6; i++) await w.sweepMinutes(1);
    // Inside the 10-minute periodic interval, the commit alone forces a read, and only of the group it landed in.
    const outputsReads = seen.filter((s) => /^GET \/m\/[^/]+\/system\/outputs$/.test(s));
    expect(outputsReads).toEqual(['GET /m/default/system/outputs']);
    const inv = (await w.docs.getInventory())!;
    expect(Date.parse(inv.groupsFetchedAt!.default)).toBeGreaterThan(Date.parse(inv.groupsFetchedAt!.wg1));
  });

  it('an inventory stored before per-group read times still refreshes and records them', async () => {
    const w = await multiGroupWorld(() => ['default', 'wg1']);
    await w.sweep();
    const inv = (await w.docs.getInventory())!;
    delete inv.groupsFetchedAt;
    await w.docs.putInventory(inv);
    for (const r of await w.sweepMinutes(11)) expect(r.error).toBeUndefined(); // past the 10-minute periodic refresh
    const after = (await w.docs.getInventory())!;
    expect(Object.keys(after.byGroup).sort()).toEqual(['default', 'wg1']);
    expect(Object.keys(after.groupsFetchedAt ?? {}).length).toBeGreaterThan(0);
  });
});
