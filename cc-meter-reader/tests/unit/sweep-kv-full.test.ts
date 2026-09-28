// tests/unit/sweep-kv-full.test.ts — the KV store refuses writes (EPIC_AUDIT P1-E03).
//
// A full store answers 507 (or 413, or a 5xx) to a PUT. Every sweep then failed at its first minute-doc write, the
// cursor stopped, and the hourly expiry pass that could free keys never ran: it sits after those writes. Now the
// first refused write starts a streak in meta (kvWriteFailingSince); the next sweep runs the expiry pass before its
// reads, once per streak and then hourly, and the first sweep after the store takes writes again meters the backlog.

import { describe, expect, it } from 'vitest';
import type { KvStore, RollMinuteDoc } from '../../core/types.ts';
import { KvHttpError } from '../../core/kv.ts';
import { EXPIRE_EVERY_MS } from '../../core/sweep.ts';
import { HOUR, MINUTE, createWorld, type World } from '../integration/harness.ts';

/** Two minute docs and an incidents doc far past retention (minute docs 25 h, incidents 31 days), for the pass to find. */
const STALE = ['roll/min/2026-09-20T03', 'roll/min/2026-09-20T04', 'incidents/2026-08-01'];

interface Probe {
  w: World;
  /** Listings of the dated-key prefixes (the expiry pass) per sweep, and all listings. */
  lists: string[];
  refused: number;
  set(refuse: (key: string) => boolean): void;
}

async function fullStoreWorld(): Promise<Probe> {
  let refuse: (key: string) => boolean = () => false;
  const p = { lists: [] as string[], refused: 0 } as Probe;
  const wrapKv = (inner: KvStore): KvStore => ({
    get: (k) => inner.get(k),
    put: async (k, v) => {
      if (refuse(k)) {
        p.refused++;
        throw new KvHttpError('PUT', k, 507, 'Insufficient Storage (injected: store full)');
      }
      return inner.put(k, v);
    },
    del: (k) => inner.del(k),
    list: async (prefix) => (p.lists.push(prefix), inner.list(prefix)),
  });
  p.w = await createWorld({ wrapKv, settings: (s) => void (s.demo = { enabled: false, replayMode: false, profile: false }) });
  p.set = (r) => void (refuse = r);
  return p;
}

const expiryListings = (lists: string[]): number => lists.filter((x) => x === 'roll/' || x === 'incidents/').length;
const emptyMinuteDoc = (key: string): RollMinuteDoc => ({ schemaVersion: 1, bucketStart: `${key.slice(9)}:00:00.000Z`, flows: {} });

async function seedStale(w: World): Promise<void> {
  for (const key of STALE.slice(0, 2)) await w.docs.putRollMinute(key, emptyMinuteDoc(key));
  await w.docs.putIncidents(STALE[2], { schemaVersion: 1, items: [] });
}

describe('P1-E03 — a KV store that refuses writes', () => {
  it('with PUTs failing for 30 sweeps the expiry pass runs on the second failed sweep, and metering resumes within one sweep of recovery with the backlog metered', async () => {
    const { w, lists, set } = await fullStoreWorld();
    await w.sweep();
    await w.sweepMinutes(2); // the seed sweep ran the first hourly pass; the next is due an hour later
    await seedStale(w);
    const healthy = (await w.meta())!;
    expect(healthy.kvWriteFailingSince).toBeUndefined();

    set((k) => k.startsWith('roll/'));
    const perSweep: number[] = [];
    const failed: string[] = [];
    let firstFailureAt = '';
    for (let i = 0; i < 30; i++) {
      lists.length = 0;
      const [r] = await w.sweepMinutes(1);
      perSweep.push(expiryListings(lists));
      if (r.error) failed.push(r.error);
      if (i === 0) firstFailureAt = new Date(w.now()).toISOString();
      const meta = (await w.meta())!;
      expect(meta.kvWriteFailingSince, `sweep ${i + 1}`).toBe(firstFailureAt);
      if (i === 1) {
        // The second failed sweep: the pass ran before its reads and deleted what was past retention.
        expect(meta.lastExpiredAt).toBe(new Date(w.now()).toISOString());
        for (const key of STALE) expect(await w.docs.getDoc(key, (v): v is unknown => v !== undefined), key).toBeNull();
        expect(meta.kvDatedKeys).toBeGreaterThan(0);
        expect(w.logs.some((l) => l.level === 'warn' && /refused writes since .*expiry pass first: 3 of 3 expired key\(s\) deleted/.test(l.msg))).toBe(true);
      }
    }
    expect(failed).toHaveLength(30);
    expect(failed[0]).toMatch(/KV PUT roll\/min\/.* failed: HTTP 507/);
    // The pass: never on the first failed sweep (no streak yet), on the second, then not again inside the hour.
    expect(perSweep[0]).toBe(0);
    expect(perSweep[1]).toBe(2);
    expect(perSweep.slice(2).every((n) => n === 0)).toBe(true);
    const stuck = (await w.meta())!;
    expect(stuck.meteredThrough).toBe(healthy.meteredThrough); // the cursor stopped while the writes failed
    expect(stuck.sweepErrors).toBe(healthy.sweepErrors + 30);

    // The store takes writes again: the next sweep meters the 30-minute backlog and ends the streak.
    set(() => false);
    const [recovered] = await w.sweepMinutes(1);
    expect(recovered.error).toBeUndefined();
    expect(recovered.minutesProcessed).toBe(31);
    expect(recovered.backfilledMinutes).toBe(30);
    const meta = (await w.meta())!;
    const windowEnd = Math.floor((w.now() - 20_000) / MINUTE) * MINUTE;
    expect(meta.meteredThrough).toBe(new Date(windowEnd).toISOString());
    expect(meta.kvWriteFailingSince).toBeUndefined();
    expect(meta.sweepErrors).toBe(healthy.sweepErrors + 30); // the count stays; the streak marker does not
  });

  it('a store that is full of expired keys is unblocked by the pass: the second sweep frees them and meters the backlog itself', async () => {
    // A store with room for no new key (it answers 507), however much the stored ones change.
    let capacity = Number.POSITIVE_INFINITY;
    const keys = new Set<string>();
    const w = await createWorld({
      wrapKv: (inner) => ({
        get: (k) => inner.get(k),
        list: (prefix) => inner.list(prefix),
        del: async (k) => {
          await inner.del(k);
          keys.delete(k);
        },
        put: async (k, v) => {
          if (!keys.has(k) && keys.size >= capacity) throw new KvHttpError('PUT', k, 507, 'Insufficient Storage (store full)');
          await inner.put(k, v);
          keys.add(k);
        },
      }),
      settings: (s) => void (s.demo = { enabled: false, replayMode: false, profile: false }),
    });
    await w.sweep();
    await w.sweepMinutes(2);
    await seedStale(w);
    for (const k of await w.kv.list('')) keys.add(k);
    capacity = keys.size;
    // The first minute of the next hour needs a new minute doc: the full store refuses it.
    w.set(Math.floor(w.now() / HOUR) * HOUR + HOUR + MINUTE + 20_000);
    const first = await w.sweep();
    expect(first.error).toMatch(/KV PUT roll\/min\/.*T\d\d failed: HTTP 507/);
    expect((await w.meta())!.kvWriteFailingSince).toBe(new Date(w.now()).toISOString());
    // The next sweep expires the stale keys before its writes, so they fit, and it meters everything since.
    w.advance(MINUTE);
    const second = await w.sweep();
    expect(second.error).toBeUndefined();
    expect(second.backfilledMinutes).toBeGreaterThanOrEqual(1);
    for (const key of STALE) expect(keys.has(key), key).toBe(false);
    const meta = (await w.meta())!;
    expect(meta.kvWriteFailingSince).toBeUndefined();
    expect(meta.meteredThrough).toBe(new Date(Math.floor((w.now() - 20_000) / MINUTE) * MINUTE).toISOString());
  });

  it('while the store keeps refusing, the pass runs again an hour after the last one, not every sweep', async () => {
    const { w, lists, set } = await fullStoreWorld();
    await w.sweep();
    await w.sweepMinutes(2);
    set((k) => k.startsWith('roll/'));
    const ran: number[] = [];
    for (let i = 0; i < 75; i++) {
      lists.length = 0;
      await w.sweepMinutes(1);
      if (expiryListings(lists) > 0) ran.push(i + 1);
    }
    expect(ran).toEqual([2, 2 + EXPIRE_EVERY_MS / MINUTE]);
  });

  it('a backlog of expired keys larger than the plan continues on the next failing sweeps, each pass stamped with what is left (P1-E08)', async () => {
    const { w, lists, set } = await fullStoreWorld();
    await w.sweep();
    await w.sweepMinutes(2);
    const stale = Array.from({ length: 40 }, (_, i) => `roll/min/2026-09-1${Math.floor(i / 10)}T${String(i % 10).padStart(2, '0')}`);
    for (const key of stale) await w.docs.putRollMinute(key, emptyMinuteDoc(key));
    set((k) => k.startsWith('roll/'));
    await w.sweepMinutes(1); // the streak starts
    const left = async (): Promise<number> => (await w.kv.list('roll/min/2026-09-1')).length;
    const counts: number[] = [];
    for (let i = 0; i < 8 && (await left()) > 0; i++) {
      lists.length = 0;
      await w.sweepMinutes(1);
      expect(expiryListings(lists)).toBe(2);
      counts.push(await left());
      const meta = (await w.meta())!;
      // Every pass is stamped; what it had no room for is the backlog the next failing sweep continues.
      expect(meta.lastExpiredAt).toBe(new Date(w.now()).toISOString());
      expect(meta.expiryBacklog ?? 0).toBe(counts.at(-1));
    }
    expect(counts.at(-1)).toBe(0);
    expect(counts.length).toBeGreaterThan(1); // more than one sweep's worth: the plan bounds each pass
    // Done: the next failing sweep inside the hour lists nothing.
    lists.length = 0;
    await w.sweepMinutes(1);
    expect(expiryListings(lists)).toBe(0);
  });

  it('only a refused KV write starts the streak: a rate-limited PUT or a failed read does not', async () => {
    const { w, set } = await fullStoreWorld();
    await w.sweep();
    await w.sweepMinutes(2);
    set((k) => k.startsWith('roll/'));
    // Swap the refusal for a 429 on the same writes: the metered transport retries once, then stops the sweep.
    let armed = false;
    const limited = await createWorld({
      wrapKv: (inner) => ({
        get: (k) => inner.get(k),
        list: (p) => inner.list(p),
        del: (k) => inner.del(k),
        put: async (k, v) => {
          if (k.startsWith('roll/') && armed) throw new KvHttpError('PUT', k, 429, 'Too Many Requests');
          return inner.put(k, v);
        },
      }),
    });
    await limited.sweep();
    await limited.sweepMinutes(1);
    armed = true;
    const [r] = await limited.sweepMinutes(1);
    expect(r.skipped).toBe('rate_limited');
    expect((await limited.meta())!.kvWriteFailingSince).toBeUndefined();
    // A read the store answers 500 fails the sweep without a streak either.
    let failRead = false;
    const broken = await createWorld({
      wrapKv: (inner) => ({
        get: async (k) => {
          if (k === 'totals' && failRead) throw new KvHttpError('GET', k, 500, 'boom');
          return inner.get(k);
        },
        put: (k, v) => inner.put(k, v),
        del: (k) => inner.del(k),
        list: (p) => inner.list(p),
      }),
    });
    await broken.sweep();
    failRead = true;
    const [readFail] = await broken.sweepMinutes(1);
    expect(readFail.error).toMatch(/KV GET totals failed: HTTP 500/);
    expect((await broken.meta())!.kvWriteFailingSince).toBeUndefined();
    // And the refusing world above, for contrast, does start one.
    const [refused] = await w.sweepMinutes(1);
    expect(refused.error).toMatch(/HTTP 507/);
    expect((await w.meta())!.kvWriteFailingSince).toBe(new Date(w.now()).toISOString());
  });

  it('a completed sweep records how many dated keys the store holds after its expiry pass', async () => {
    const { w } = await fullStoreWorld();
    const seed = await w.sweep();
    expect(seed.error).toBeUndefined();
    const meta = (await w.meta())!;
    const dated = (await w.kv.list('roll/')).length + (await w.kv.list('incidents/')).length;
    expect(meta.lastExpiredAt).toBe(new Date(w.now()).toISOString());
    // Counted when the pass listed them (before this sweep's snapshot and meta; minute docs were written before it).
    expect(meta.kvDatedKeys).toBe(dated);
    // Carried by the sweeps between passes.
    await w.sweepMinutes(3);
    expect((await w.meta())!.kvDatedKeys).toBe(dated);
  });
});
