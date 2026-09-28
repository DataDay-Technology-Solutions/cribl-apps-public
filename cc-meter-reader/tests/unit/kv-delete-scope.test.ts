// tests/unit/kv-delete-scope.test.ts — the only KV DELETE core issues on its own is retention of its own dated rollups
// and incident days (rules round 2, craft).
//
// AGENTS.md "Confirming Destructive Operations" lists DELETE (KV keys included) as volatile and says never to trigger
// one from a background timer. Meter Reader's writes are DELETE-free (core/kv.ts: a shorter write leaves its old chunks
// unreferenced, bounded by the manifest). What remains is the hourly expiry of the App's OWN derived, dated documents
// past their retention (roll/min 25 h, roll/hour 32 days, roll/day 13 months, incidents/<day> 31 days: core/rollups.ts
// expiredKeys), which keeps the store under its key cap. This test pins that: over a sweeping world with chunked and
// plain dated documents past retention, every DELETE the store receives is such a key or one of its chunks, and never
// settings, prices, the inventory, the snapshot, meta, the lock, baselines or a document inside retention.
//
// It also pins, by reading the sources, that no other module of the release build calls a KV delete.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { KvStore, RollMinuteDoc } from '../../core/types.ts';
import { expiredKeys } from '../../core/rollups.ts';
import { HOUR, MINUTE, T0, createWorld } from '../integration/harness.ts';

const DATED = /^(?:roll\/(?:min|hour|day)\/[^/]+|incidents\/\d{4}-\d{2}-\d{2})$/;
const baseKey = (k: string): string => k.replace(/\/c\/\d+$/, '');

describe('KV DELETE scope: expiry of the App’s own dated documents, nothing else', () => {
  it('a sweeping world deletes only roll/* and incidents/* keys past retention (and their chunks)', async () => {
    const deletes: { key: string; at: number }[] = [];
    let now = T0;
    const wrapKv = (inner: KvStore): KvStore => ({ ...inner, del: (k) => (deletes.push({ key: k, at: now }), inner.del(k)) });
    const w = await createWorld({ wrapKv, settings: (s) => void (s.demo = { enabled: false, replayMode: false, profile: false }) });
    const tick = (): number => (now = w.now());

    await w.sweep();
    tick();
    // Past retention: a chunked minute doc (80 h old), plain ones, an old hour doc and an old incident day.
    const bigFlows: RollMinuteDoc['flows'] = {};
    for (let i = 0; i < 400; i++) bigFlows[`default|in${i}|r${i}|p${i}|o`] = [{ t: '2026-09-25T07:00:00.000Z', inB: i, outB: i, inE: 1, outE: 1, whpM: 1, paidM: 1, savedM: 0 }];
    await w.docs.putRollMinute('2026-09-25T07', { schemaVersion: 1, bucketStart: '2026-09-25T07:00:00.000Z', flows: bigFlows });
    await w.docs.putRollMinute('2026-09-25T08', { schemaVersion: 1, bucketStart: '2026-09-25T08:00:00.000Z', flows: {} });
    await w.docs.putDoc('roll/hour/2026-08-01', { schemaVersion: 1, day: '2026-08-01', flows: {} });
    await w.docs.putDoc('incidents/2026-08-01', { schemaVersion: 1, items: [] });
    // Inside retention: never deleted.
    await w.docs.putRollMinute('2026-09-28T10', { schemaVersion: 1, bucketStart: '2026-09-28T10:00:00.000Z', flows: {} });
    // Make the hourly pass due, then sweep for three hours: the pass runs, the shorter snapshot/settings writes too.
    const meta = (await w.meta())!;
    await w.docs.putMeta({ ...meta, lastExpiredAt: new Date(w.now() - 2 * HOUR).toISOString() });
    for (let i = 0; i < 3; i++) {
      await w.sweepMinutes(1);
      tick();
      w.set(w.now() + HOUR - MINUTE);
    }

    expect(deletes.length).toBeGreaterThan(0);
    const keys = new Set(deletes.map((d) => baseKey(d.key)));
    for (const k of ['roll/min/2026-09-25T07', 'roll/min/2026-09-25T08', 'roll/hour/2026-08-01', 'incidents/2026-08-01']) expect(keys.has(k), k).toBe(true);
    for (const d of deletes) {
      const base = baseKey(d.key);
      expect(base, d.key).toMatch(DATED);
      expect(expiredKeys([base], d.at), d.key).toEqual([base]);
    }
    expect(keys.has('roll/min/2026-09-28T10')).toBe(false);
  });

  it('no release module but the expiry pass (core/sweep.ts) and the KV layer it calls issues a KV delete', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    for (const dir of ['core', 'src', 'backend']) walk(join(root, dir));
    const callers = files
      .map((p) => relative(root, p))
      .filter((p) => !p.startsWith('src/mock/'))
      .filter((p) => /\.del\(|\bdocs\.del\b|'DELETE'/.test(readFileSync(join(root, p), 'utf8')))
      .sort();
    // core/kv.ts: the KV layer (HTTP DELETE, the dated-document delete the expiry pass calls, the error type);
    // core/sweep.ts: the metered transport's pass-through and expireKeys; core/types.ts: the CriblHttp method union;
    // core/demo/levers.ts and src/demo/client.ts (the KV port it hands the levers): the demo build's "reset the
    // baselines" lever, a member's confirmed action, compiled out of the release by VITE_MR_BUILD.
    expect(callers).toEqual(['core/demo/levers.ts', 'core/kv.ts', 'core/sweep.ts', 'core/types.ts', 'src/demo/client.ts']);
  });
});
