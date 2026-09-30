// tests/integration/r1-core-expiry-scale.test.ts — founder-build r1 core-7 (FINDINGS_R1 M11 #43, FINDINGS_EXTRA #43):
// expiry runs at any flow count, and the store stays under the App KV's 1,000-key cap.
//
// Before: the hourly expiry pass ran only in a sweep that had spent ≤ 30 of its 35 planned calls. At ~500 flows a
// sweep costs 36–76, so expiry never ran (lastExpiredAt null for 27 h, +11 keys an hour, the cap in ~3.5 days). At the
// 2,000-flow preset one hour's minute document is ~52 keys (its chunks), so 25 h of them alone is ~1,350 keys: the store
// hit 1,000 after 18 h, every write then failed 507, and the expiry-first pass had no room to delete one document —
// metering stopped for good (AA skeptic1-f43 keycap2). Now (1) an expiry pass that is due runs whatever the sweep has
// spent, bounded to a reserve sized by the largest expired document's chunks, and a backlog continues the same way;
// (2) the minute documents are kept only as long as ~400 keys allow (25 h up to ~15 chunks a document, never under 6 h).
//
// Bounded: sweeps are sampled (every 10 minutes, or hourly catch-ups at 2,000 flows), gzip as in production. The 500- and
// 2,000-flow cases take ~1 and ~4 minutes, so they run only when asked (the 60-flow control always runs):
//   MR_SCALE_TESTS=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/integration/r1-core-expiry-scale.test.ts
// (on the Brains: MR_E2E_HOST=studio bash scripts/remote-e2e.sh <ref> -- env MR_SCALE_TESTS=1 NODE_OPTIONS=… npx vitest run …).
// Skeptic 2's unbounded run died at 4 GB; this one stays under the 3 GB cap.

import { describe, expect, it } from 'vitest';
import type { KvStore, PriceEntry } from '../../core/types.ts';
import { detectCodec } from '../../core/codec.ts';
import { KvHttpError } from '../../core/kv.ts';
import { appendPriceVersion, emptyPrices } from '../../core/pricing.ts';
import { DAY, HOUR, MINUTE, createWorld, type World } from './harness.ts';

const MIN_DOC = /^roll\/min\/\d{4}-\d{2}-\d{2}T\d{2}$/;

/** The documented App KV cap: a PUT of a new key past 1,000 keys answers 507 (a real KvHttpError, as the Leader's). */
function capped(cap: number, refused: string[]): (inner: KvStore) => KvStore {
  return (inner) => ({
    get: (k) => inner.get(k),
    del: (k) => inner.del(k),
    list: (p) => inner.list(p),
    async put(k, v) {
      const keys = await inner.list('');
      if (!keys.includes(k) && keys.length >= cap) {
        refused.push(k);
        throw new KvHttpError('PUT', k, 507, 'key limit reached');
      }
      return inner.put(k, v);
    },
  });
}

async function scaleWorld(flows: number, wrapKv?: (kv: KvStore) => KvStore): Promise<World> {
  const w = await createWorld({ start: Date.UTC(2026, 8, 28, 0, 0, 20), preset: 'scale', flows, codec: detectCodec(), ...(wrapKv ? { wrapKv } : {}), sweep: { firstRunReachMs: HOUR } });
  await w.sweep('ui');
  const inv = await w.docs.getInventory();
  const byOutputId: Record<string, PriceEntry> = {};
  for (const [gid, g] of Object.entries(inv!.byGroup)) for (const o of g.outputs) byOutputId[`${gid}:${o.id}`] = { milliCentsPerGb: 150_000 };
  await w.docs.putPrices(appendPriceVersion(emptyPrices(''), byOutputId, w.now() - DAY));
  return w;
}

async function census(w: World): Promise<{ keys: number; minuteDocs: number; lastExpiredAt?: string; meteredThrough?: string }> {
  const keys = await w.kv.list('');
  const meta = await w.meta();
  return {
    keys: keys.length,
    minuteDocs: keys.filter((k) => MIN_DOC.test(k)).length,
    ...(meta?.lastExpiredAt ? { lastExpiredAt: meta.lastExpiredAt } : {}),
    ...(meta?.meteredThrough ? { meteredThrough: meta.meteredThrough } : {}),
  };
}

/** Sweeps every `everyMin` minutes for `hours` hours; the census at each whole hour. */
async function run(w: World, hours: number, everyMin: number) {
  const out: Awaited<ReturnType<typeof census>>[] = [];
  const errors: string[] = [];
  for (let m = everyMin; m <= hours * 60; m += everyMin) {
    w.set(Math.floor(w.now() / MINUTE) * MINUTE + everyMin * MINUTE + 20_000);
    const r = await w.sweep('ui');
    if (r.error) errors.push(`${new Date(w.now()).toISOString()} ${r.error}`);
    if (m % 60 === 0) out.push(await census(w));
  }
  return { hourly: out, errors };
}

describe('core-7 · expiry runs at any flow count (M11 #43)', () => {
  const scale = process.env.MR_SCALE_TESTS === '1';

  it.runIf(scale)('500 flows over 27 h: expiry runs every hour and the keys plateau', async () => {
    const w = await scaleWorld(500);
    const { hourly, errors } = await run(w, 27, 10);
    expect(errors).toEqual([]);
    // Every hour, the last expiry pass is under ~70 minutes older than what was metered.
    for (const [i, h] of hourly.entries()) {
      expect(h.lastExpiredAt, `hour ${i + 1}`).toBeDefined();
      expect(Date.parse(h.meteredThrough!) - Date.parse(h.lastExpiredAt!), `hour ${i + 1}`).toBeLessThan(70 * MINUTE);
    }
    const last = hourly.at(-1)!;
    // The minute documents stay within their retention (≤ 26 hour documents), and the key count stops growing.
    expect(Math.max(...hourly.map((h) => h.minuteDocs))).toBeLessThanOrEqual(26);
    const plateau = hourly.slice(-3).map((h) => h.keys);
    expect(Math.max(...plateau) - Math.min(...plateau)).toBeLessThanOrEqual(15);
    expect(last.keys).toBeLessThan(1000);
  }, 600_000);

  it.runIf(scale)('the 2,000-flow preset over 48 h under the 1,000-key cap: no 507, metered through within 2 minutes of now', async () => {
    const refused: string[] = [];
    const w = await scaleWorld(2000, capped(1000, refused));
    const rows: { hour: number; keys: number; minuteDocs: number; behindMs: number; error?: string }[] = [];
    for (let h = 1; h <= 48; h++) {
      w.advance(HOUR);
      const r = await w.sweep('ui');
      const c = await census(w);
      rows.push({ hour: h, keys: c.keys, minuteDocs: c.minuteDocs, behindMs: w.now() - Date.parse(c.meteredThrough ?? '1970-01-01T00:00:00Z'), ...(r.error ? { error: r.error } : {}) });
    }
    expect(refused).toEqual([]);
    expect(rows.filter((r) => r.error)).toEqual([]);
    for (const r of rows) expect(r.behindMs, `hour ${r.hour}`).toBeLessThanOrEqual(2 * MINUTE);
    expect(Math.max(...rows.map((r) => r.keys))).toBeLessThan(1000);
    // The minute documents' retention shrank to the estate (~52 keys a document → a few hours), never under 6 h.
    const lastMinuteDocs = rows.at(-1)!.minuteDocs;
    expect(lastMinuteDocs).toBeGreaterThanOrEqual(6);
    expect(lastMinuteDocs).toBeLessThanOrEqual(12);
    const retention = (await w.meta())?.minuteRetentionHours;
    expect(retention).toBeGreaterThanOrEqual(6);
    expect(retention).toBeLessThan(25);
  }, 600_000);

  it('control: 60 flows keep 25 h of minute documents and hold at about 92 keys', async () => {
    const w = await scaleWorld(60);
    const { hourly, errors } = await run(w, 27, 10);
    expect(errors).toEqual([]);
    const last = hourly.at(-1)!;
    // 25 h of minute documents (24–26 hour documents, depending on where in the hour the pass ran).
    expect(last.minuteDocs).toBeGreaterThanOrEqual(24);
    expect(last.minuteDocs).toBeLessThanOrEqual(26);
    expect(last.keys).toBeGreaterThanOrEqual(80);
    expect(last.keys).toBeLessThanOrEqual(100);
    expect((await w.meta())?.minuteRetentionHours).toBe(25);
  }, 600_000);
});
