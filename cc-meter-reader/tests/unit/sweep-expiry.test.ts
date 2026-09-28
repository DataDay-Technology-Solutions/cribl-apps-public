// tests/unit/sweep-expiry.test.ts — what the expiry pass and a stopped timeline refresh cost (EPIC_AUDIT P1-E08).
//
// Before: every delete pre-read the key for a chunk manifest (2 calls a key), a pass with a backlog larger than its
// room was never stamped and repeated its two listings every sweep, and a timeline fetched by a sweep that then
// stopped (budget, rate limit, time budget) was thrown away and fetched again (3 calls) every sweep until one finished.
// Now the listings name every chunk key, so a delete is one call per stored key; every pass is stamped and a backlog
// continues only in a sweep with room; and a stopped sweep still writes the timeline it paid for.

import { describe, expect, it } from 'vitest';
import type { CriblHttp, KvStore, RollMinuteDoc } from '../../core/types.ts';
import { KvHttpError, chunkKey, createKvDocs, createMemoryKvStore } from '../../core/kv.ts';
import { identityCodec } from '../../core/codec.ts';
import { HOUR, MINUTE, T0, createWorld, type World } from '../integration/harness.ts';

const quiet = (s: { demo: unknown }): void => void (s.demo = { enabled: false, replayMode: false, profile: false });

interface Op {
  op: 'get' | 'put' | 'del' | 'list';
  key: string;
}

/** A world whose KV journals every call the sweep makes. */
async function journaled(): Promise<{ w: World; ops: Op[] }> {
  const ops: Op[] = [];
  const wrapKv = (inner: KvStore): KvStore => ({
    get: (k) => (ops.push({ op: 'get', key: k }), inner.get(k)),
    put: (k, v) => (ops.push({ op: 'put', key: k }), inner.put(k, v)),
    del: (k) => (ops.push({ op: 'del', key: k }), inner.del(k)),
    list: (p) => (ops.push({ op: 'list', key: p }), inner.list(p)),
  });
  const w = await createWorld({ wrapKv, settings: quiet });
  return { w, ops };
}

/** Steady state, then the hourly pass made due on the next sweep (the last one stamped two hours ago). */
async function passDueNext(w: World): Promise<void> {
  await w.sweep();
  await w.sweepMinutes(2);
  const meta = (await w.meta())!;
  delete meta.expiryBacklog;
  await w.docs.putMeta({ ...meta, lastExpiredAt: new Date(w.now() - 2 * HOUR).toISOString() });
}

/** `n` minute docs, one per hour from `fromMs` (80 h back: all past the 25 h retention), stored plain. */
async function seedStale(w: World, n: number, fromMs = T0 - 80 * HOUR): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const hour = new Date(fromMs + i * HOUR).toISOString().slice(0, 13);
    const doc: RollMinuteDoc = { schemaVersion: 1, bucketStart: `${hour}:00:00.000Z`, flows: {} };
    await w.docs.putRollMinute(hour, doc);
    keys.push(`roll/min/${hour}`);
  }
  return keys;
}

describe('P1-E08 — the expiry pass', () => {
  it('an expiry pass over 10 plain keys makes 2 lists + 10 DELETEs, with no pre-read', async () => {
    const { w, ops } = await journaled();
    await passDueNext(w);
    const stale = await seedStale(w, 10);
    ops.length = 0;
    const [r] = await w.sweepMinutes(1);
    expect(r.error).toBeUndefined();
    const lists = ops.filter((o) => o.op === 'list' && (o.key === 'roll/' || o.key === 'incidents/'));
    expect(lists.map((o) => o.key)).toEqual(['roll/', 'incidents/']);
    const dels = ops.filter((o) => o.op === 'del');
    expect(dels.map((o) => o.key).sort()).toEqual([...stale].sort());
    expect(ops.filter((o) => o.op === 'get' && stale.includes(o.key))).toEqual([]);
    for (const k of stale) expect(await w.kv.get(k)).toBeNull();
    const meta = (await w.meta())!;
    expect(meta.lastExpiredAt).toBe(new Date(w.now()).toISOString());
    expect(meta.expiryBacklog).toBeUndefined();
  });

  it('deletes a chunked key and every chunk the listing showed, still without reading it', async () => {
    const kv = createMemoryKvStore();
    const clock = { now: () => T0 };
    // Small chunks so one incidents doc spans several.
    const writer = createKvDocs({ kv, codec: identityCodec, clock, chunkThresholdBytes: 200, chunkChars: 120 });
    const items = Array.from({ length: 6 }, (_, i) => ({ id: `inc_${i}`, note: 'x'.repeat(80) }));
    await writer.putDoc('incidents/2026-07-01', { schemaVersion: 1, items });
    await writer.putDoc('incidents/2026-07-02', { schemaVersion: 1, items: [] });
    const docs = createKvDocs({ kv, codec: identityCodec, clock });
    const listed = await docs.listKeysWithChunks('incidents/');
    expect(listed.keys).toEqual(['incidents/2026-07-01', 'incidents/2026-07-02']);
    const chunks = listed.chunks['incidents/2026-07-01'];
    expect(chunks.length).toBeGreaterThan(1);
    expect(listed.chunks['incidents/2026-07-02']).toBeUndefined();
    kv.ops.length = 0;
    await docs.del('incidents/2026-07-01', { listed: chunks });
    await docs.del('incidents/2026-07-02', { listed: [] });
    expect(kv.ops.filter((o) => o.op === 'get')).toEqual([]);
    expect(kv.ops.filter((o) => o.op === 'del').map((o) => o.key)).toEqual([
      'incidents/2026-07-01',
      ...chunks.map((i) => chunkKey('incidents/2026-07-01', i)),
      'incidents/2026-07-02',
    ]);
    expect([...kv.data.keys()].filter((k) => k.startsWith('incidents/'))).toEqual([]);
  });

  it('stamps every pass; a backlog it had no room for continues in the next sweep with room, then stops listing', async () => {
    const { w, ops } = await journaled();
    await passDueNext(w);
    const stale = await seedStale(w, 40);
    ops.length = 0;
    await w.sweepMinutes(1);
    const first = (await w.meta())!;
    expect(first.lastExpiredAt).toBe(new Date(w.now()).toISOString());
    expect(first.expiryBacklog).toBeGreaterThan(0);
    const deletedFirst = ops.filter((o) => o.op === 'del').length;
    expect(deletedFirst).toBeGreaterThan(0);
    expect(deletedFirst + first.expiryBacklog!).toBe(40);

    // The backlog continues on the following sweeps (not an hour later), each deleting what its plan has room for.
    let sweeps = 0;
    while (((await w.meta())!.expiryBacklog ?? 0) > 0 && sweeps < 10) {
      await w.sweepMinutes(1);
      sweeps++;
    }
    expect(sweeps).toBeGreaterThan(0);
    expect(sweeps).toBeLessThanOrEqual(4);
    for (const k of stale) expect(await w.kv.get(k), k).toBeNull();
    // Done: within the hour the next sweep lists nothing.
    ops.length = 0;
    await w.sweepMinutes(1);
    expect(ops.filter((o) => o.op === 'list' && o.key === 'roll/')).toEqual([]);
  });
});

describe('the expiry pass is optional work', () => {
  it('a listing the store refuses is logged and left for the next pass; the sweep still writes its minutes, snapshot and meta', async () => {
    let refuse = false;
    const w = await createWorld({
      settings: quiet,
      wrapKv: (inner) => ({
        get: (k) => inner.get(k),
        put: (k, v) => inner.put(k, v),
        del: (k) => inner.del(k),
        list: (p) => (refuse && p === 'roll/' ? Promise.reject(new KvHttpError('LIST', p, 404, 'Not Found')) : inner.list(p)),
      }),
    });
    await passDueNext(w);
    const before = (await w.meta())!;
    refuse = true;
    const [r] = await w.sweepMinutes(1);
    expect(r.error).toBeUndefined();
    expect(r.minutesProcessed).toBe(1);
    const meta = (await w.meta())!;
    expect(Date.parse(meta.meteredThrough!)).toBeGreaterThan(Date.parse(before.meteredThrough!));
    expect(meta.lastExpiredAt).toBe(before.lastExpiredAt); // not stamped: the next sweep tries again
    expect(w.logs.some((l) => l.level === 'warn' && /key expiry pass failed/.test(l.msg))).toBe(true);
    refuse = false;
    await w.sweepMinutes(1);
    expect((await w.meta())!.lastExpiredAt).toBe(new Date(w.now()).toISOString());
  });
});

describe('P1-E08 — a stopped sweep keeps the timeline it fetched', () => {
  it('a deferred timeline is written in the same sweep, and the next sweep does not fetch it again', async () => {
    const w = await createWorld({ settings: quiet });
    await w.sweep();
    await w.sweepMinutes(1);
    const before = (await w.meta())!;
    // Six minutes on, the 5-minute timeline refresh is due; the metrics query then takes past the time budget.
    w.set(Math.floor(w.now() / MINUTE) * MINUTE + 6 * MINUTE + 20_000);
    const slow: CriblHttp = {
      request: async (m, p, b, o) => {
        if (m === 'POST' && p.startsWith('/system/metrics/query')) w.advance(101_000 / 3);
        return w.deps.http.request(m, p, b, o);
      },
    };
    w.em.resetCalls();
    const stopped = await w.sweep('ui', { http: slow });
    expect(stopped.error).toBe('time_budget');
    expect(w.em.calls().byRoute['GET /m/:gid/version']).toBe(1);
    const meta = (await w.meta())!;
    expect(meta.timelineRefreshedAt).not.toBe(before.timelineRefreshedAt);
    expect(Date.parse(meta.timelineRefreshedAt!)).toBeGreaterThan(Date.parse(before.timelineRefreshedAt!));
    expect(meta.meteredThrough).toBe(before.meteredThrough); // the minutes were not written…
    const timeline = await w.docs.getTimeline();
    expect(timeline?.updatedAt).toBe(meta.timelineRefreshedAt); // …the timeline was

    w.em.resetCalls();
    w.advance(MINUTE);
    const next = await w.sweep();
    expect(next.error).toBeUndefined();
    expect(w.em.calls().byRoute['GET /m/:gid/version'] ?? 0).toBe(0);
  });
});
