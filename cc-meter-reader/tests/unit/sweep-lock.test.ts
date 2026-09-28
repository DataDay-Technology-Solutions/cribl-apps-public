// tests/unit/sweep-lock.test.ts — lock/meter on a slow Leader (EPIC_AUDIT P1-E02).
//
// At ~4.5 s a Leader call a sweep takes ~110 s. The old 90 s lock expired at ~95 s while that sweep was still
// writing its minute docs, totals, snapshot and meta, so a tab's 30 s tick took the lock and a second writer ran.
// Now the lock outlives the 100 s time budget by 30 s, a sweep renews it before a stage of writes when less than
// LOCK_RENEW_BELOW_MS is left, and a sweep that finds another runtime holding it abandons its writes.

import { describe, expect, it } from 'vitest';
import type { CriblHttp, KvStore } from '../../core/types.ts';
import { createKvDocs } from '../../core/kv.ts';
import { identityCodec } from '../../core/codec.ts';
import { LOCK_RENEW_BELOW_MS, LOCK_TTL_MS, SWEEP_TIME_BUDGET_MS } from '../../core/sweep.ts';
import { MINUTE, createWorld, type World } from '../integration/harness.ts';

/**
 * A world whose every Leader call (KV included) takes `latency()` ms, with a hook that runs before each one; `base`
 * is the same KV store without the slow wrapper (another runtime's view of it).
 */
async function slowWorld(latency: () => number, before: (op: string) => Promise<void> = async () => undefined) {
  let w!: World;
  let base!: KvStore;
  const hook = async (op: string): Promise<void> => {
    await before(op);
    w.advance(latency());
  };
  w = await createWorld({
    wrapHttp: (inner: CriblHttp): CriblHttp => ({ request: async (m, p, b, o) => (await hook(`${m} ${p}`), inner.request(m, p, b, o)) }),
    wrapKv: (inner: KvStore): KvStore => {
      base = inner;
      return {
        get: async (k) => (await hook(`GET ${k}`), inner.get(k)),
        put: async (k, v) => (await hook(`PUT ${k}`), inner.put(k, v)),
        del: async (k) => (await hook(`DELETE ${k}`), inner.del(k)),
        list: async (p) => (await hook(`LIST ${p}`), inner.list(p)),
      };
    },
  });
  return { w, base };
}

/** The next minute boundary + 25 s (the runner's phase), as the probe measured it. */
const nextMinute = (w: World): void => w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 25_000);
const renewals = (w: World): string[] => w.logs.filter((l) => /renewed lock\/meter/.test(l.msg)).map((l) => l.msg);

describe('P1-E02 — lock/meter on a slow Leader', () => {
  it('the lock outlives the sweep time budget by at least 30 s', () => {
    expect(LOCK_TTL_MS).toBeGreaterThanOrEqual(SWEEP_TIME_BUDGET_MS + 30_000);
    // A renewal leaves each stage of writes at least LOCK_RENEW_BELOW_MS, and it can only happen inside the lock's life.
    expect(LOCK_RENEW_BELOW_MS).toBeLessThan(LOCK_TTL_MS);
  });

  it('at 4.5 s a call, a second acquireLock at every call during the writes fails and the first sweep completes its writes', async () => {
    let latency = 0;
    let writing = false;
    const attempts: { op: string; at: number; got: boolean }[] = [];
    let other: ReturnType<typeof createKvDocs> | undefined;
    let startedAt = 0;
    const { w, base } = await slowWorld(
      () => latency,
      async (op) => {
        if (latency === 0) return;
        if (op.startsWith('PUT roll/min/')) writing = true; // step 8: the first durable write
        if (writing && other) attempts.push({ op, at: w.now() - startedAt, got: await other.acquireLock('tab-b', LOCK_TTL_MS) });
      },
    );
    // A second runtime (a tab at its 30 s tick) on the same store, outside the slow transport.
    other = createKvDocs({ kv: base, codec: identityCodec, clock: { now: () => w.now() } });
    await w.sweep();
    await w.sweepMinutes(3);
    const before = (await w.meta())!;
    nextMinute(w);
    latency = 4_500;
    startedAt = w.now();
    const r = await w.sweep('ui');
    latency = 0;

    expect(r.error).toBeUndefined();
    expect(r.skipped).toBeUndefined();
    expect(r.minutesProcessed).toBe(1);
    expect(r.ms).toBeGreaterThan(LOCK_TTL_MS - 40_000); // a genuinely slow sweep: ~2 minutes
    // The other runtime tried at every write, from the minute docs to the lock release, and never got the lock.
    expect(attempts.length).toBeGreaterThanOrEqual(6);
    expect(attempts.some((x) => x.at >= 95_000)).toBe(true); // the old lock had expired by then
    expect(attempts.filter((x) => x.got)).toEqual([]);
    // Every write landed: the cursor moved one minute and the meta is this sweep's.
    const after = (await w.meta())!;
    expect(Date.parse(after.meteredThrough!) - Date.parse(before.meteredThrough!)).toBe(MINUTE);
    expect(after.lastSweepOwner).toBe('tab-a');
    expect(after.sweepErrors).toBe(before.sweepErrors);
    expect((await w.docs.getSnapshot())!.sweepAt).toBe(new Date(startedAt).toISOString());
    // One renewal, before step 10 (the durable writes started with more than LOCK_RENEW_BELOW_MS left).
    expect(renewals(w)).toHaveLength(1);
    expect(renewals(w)[0]).toMatch(/before the snapshot and meta writes/);
    // Released at the end: the other runtime gets it now.
    expect(await other.acquireLock('tab-b', LOCK_TTL_MS)).toBe(true);
  });

  it('a normal sweep never renews: the lock is read twice and written twice (acquire, release)', async () => {
    const lockOps: string[] = [];
    let on = false;
    const { w } = await slowWorld(
      () => 0,
      async (op) => {
        if (on && op.endsWith(' lock/meter')) lockOps.push(op.split(' ')[0]);
      },
    );
    await w.sweep();
    await w.sweepMinutes(2);
    on = true;
    const [r] = await w.sweepMinutes(1);
    expect(r.error).toBeUndefined();
    expect(lockOps.sort()).toEqual(['GET', 'GET', 'PUT', 'PUT']);
    expect(renewals(w)).toEqual([]);
  });

  it('a sweep whose lock another runtime took (its clock runs ahead) abandons its writes, writes no meta and leaves that lock alone', async () => {
    let stall = false;
    let taken = false;
    const SKEW = 45_000;
    const w = await createWorld({
      wrapHttp: (inner: CriblHttp): CriblHttp => ({
        async request(m, p, b, o) {
          if (stall && p.startsWith('/system/metrics/query')) {
            // The metrics queries (three, in parallel) take 88 s. A runtime whose clock is 45 s ahead sees the lock
            // expired meanwhile and takes it.
            stall = false;
            w.advance(88_000);
            const ahead = createKvDocs({ kv: w.kv, codec: identityCodec, clock: { now: () => w.now() + SKEW } });
            taken = await ahead.acquireLock('runner:skewed:1', LOCK_TTL_MS);
          }
          return inner.request(m, p, b, o);
        },
      }),
    });
    await w.sweep();
    await w.sweepMinutes(2);
    const metaBefore = await w.meta();
    const totalsBefore = await w.docs.getTotals();
    nextMinute(w);
    const minuteT = new Date(Math.floor((w.now() - 20_000) / MINUTE) * MINUTE - MINUTE).toISOString();
    stall = true;
    const r = await w.sweep('ui');

    expect(taken).toBe(true);
    expect(r.skipped).toBe('locked');
    expect(r.error).toBe('lock_lost');
    expect(r.minutesProcessed).toBe(0);
    expect(w.logs.some((l) => l.level === 'warn' && /lock\/meter was taken by runner:skewed:1 88 s into the sweep/.test(l.msg))).toBe(true);
    // Nothing was written: no minute row, no totals, no meta (not even sweepErrors, which would race the new owner's).
    expect(await w.meta()).toEqual(metaBefore);
    expect(await w.docs.getTotals()).toEqual(totalsBefore);
    const hour = await w.docs.getRollMinute(`roll/min/${minuteT.slice(0, 13)}`);
    expect(Object.values(hour?.flows ?? {}).some((rows) => rows.some((row) => row.t === minuteT))).toBe(false);
    // The new owner's lock is intact.
    expect((await w.docs.getLock())?.owner).toBe('runner:skewed:1');
  });
});

describe('P1-E02 — KvDocs.renewLock', () => {
  const setup = async () => {
    const w = await createWorld({ bare: true });
    let now = w.now();
    const docs = createKvDocs({ kv: w.kv, codec: identityCodec, clock: { now: () => now } });
    return { docs, tick: (ms: number) => void (now += ms), now: () => now };
  };

  it("extends the owner's lock to a full TTL from now", async () => {
    const { docs, tick, now } = await setup();
    expect(await docs.acquireLock('tab-a', LOCK_TTL_MS)).toBe(true);
    tick(100_000);
    expect(await docs.renewLock('tab-a', LOCK_TTL_MS)).toBe(true);
    expect((await docs.getLock())!.expiresAt).toBe(new Date(now() + LOCK_TTL_MS).toISOString());
  });

  it('refuses, writing nothing, when the lock names another owner or is gone', async () => {
    const { docs } = await setup();
    expect(await docs.renewLock('tab-a', LOCK_TTL_MS)).toBe(false);
    expect(await docs.getLock()).toBeNull();
    expect(await docs.acquireLock('tab-b', LOCK_TTL_MS)).toBe(true);
    const held = await docs.getLock();
    expect(await docs.renewLock('tab-a', LOCK_TTL_MS)).toBe(false);
    expect(await docs.getLock()).toEqual(held);
    await expect(docs.renewLock('', LOCK_TTL_MS)).rejects.toThrow(/non-empty owner/);
  });

  it('renews a lock that expired but still names the owner, and confirms it by reading it back', async () => {
    const { docs, tick, now } = await setup();
    expect(await docs.acquireLock('tab-a', 1_000)).toBe(true);
    tick(5_000);
    expect(await docs.renewLock('tab-a', LOCK_TTL_MS)).toBe(true);
    expect(await docs.getLock()).toEqual({ owner: 'tab-a', expiresAt: new Date(now() + LOCK_TTL_MS).toISOString() });
    expect(await docs.acquireLock('tab-b', LOCK_TTL_MS)).toBe(false);
  });
});
