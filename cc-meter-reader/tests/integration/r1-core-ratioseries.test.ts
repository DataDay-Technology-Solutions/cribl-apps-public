// tests/integration/r1-core-ratioseries.test.ts — founder-build r1 core-14 (FINDINGS_R1 m3, #6). A fresh install's
// first priced sweep meters up to a day of history (D63), but the snapshot's 24 h savings-ratio series was built only
// from the 60 minutes the snapshot reads, so the Ledger's 24 h timeline started at the current UTC hour with 12–16
// points and filled in over the next day. Now the series is built from every minute the sweep processed.

import { describe, expect, it } from 'vitest';
import { HOUR, MINUTE, createWorld, rigPrices } from './harness.ts';

describe('core-14 · m3: the ratio series covers the whole first-run backfill', () => {
  it('after the first sweep the 24 h series spans ≥ 23 h, one point per 5 minutes', async () => {
    const w = await createWorld({ bare: true, sweep: { firstRunReachMs: undefined } });
    await w.docs.putPrices(rigPrices(w.now() - 2 * 86_400_000));
    const r = await w.sweep('ui');
    expect(r.error).toBeUndefined();
    expect(r.minutesProcessed).toBeGreaterThan(23 * 60);
    const s = (await w.docs.getSnapshot())!;
    const first = Date.parse(s.ratioSeries[0].t);
    const last = Date.parse(s.ratioSeries.at(-1)!.t);
    expect(last - first).toBeGreaterThanOrEqual(23 * HOUR);
    expect(s.ratioSeries.length).toBeGreaterThanOrEqual(23 * 12);
    // The next sweep keeps it (carried forward, the newest buckets recomputed).
    w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 20_000);
    await w.sweep('ui');
    const s2 = (await w.docs.getSnapshot())!;
    expect(Date.parse(s2.ratioSeries.at(-1)!.t) - Date.parse(s2.ratioSeries[0].t)).toBeGreaterThanOrEqual(23 * HOUR);
  }, 120_000);
});
