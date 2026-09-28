// tests/unit/sweep-review3a.test.ts — the wave-3a review fixes in core/sweep.ts, each reproduced against the
// emulated org: #1 the settle lag and the empty-minute hold, #2 delivery bookkeeping and ownership, #3 no metering
// before prices, #5 the totals cursor (fault injection), #13 detection time on catch-up incidents.

import { describe, expect, it } from 'vitest';
import type { CriblHttp, HttpResult, Incident, KvStore, Meta, RollMinuteDoc, TotalsDoc } from '../../core/types.ts';
import {
  DELIVERY_OWNER_FRESH_MS,
  FAILED_ATTEMPT_COOLDOWN_MS,
  HOLD_EMPTY_MAX_MS,
  SETTLE_MS,
  UNDELIVERED_CLOSURE_MS,
  deliveryOwnedElsewhere,
  holdBackEnd,
  inFailedAttemptCooldown,
  undeliveredClosure,
  windowHasTraffic,
} from '../../core/sweep.ts';
import { emptyPrices } from '../../core/pricing.ts';
import { breakTrim } from '../../core/demo/levers.ts';
import { canonicalPayload, slackPayload } from '../../core/payloads.ts';
import { HOUR, MINUTE, SINK_ENDPOINT, T0, createWorld, type World } from '../integration/harness.ts';

const PAY_FLOW = 'default|mrd_payments_api|mrd_payments_api|mrd_pay_sample|mrd_siem_prod';
const PAY_ROUTE = 'route:default:mrd_payments_api';
const B = Math.floor(T0 / MINUTE) * MINUTE; // 15:00:00, the boundary T0 (15:00:20) sits 20 s after
const iso = (ms: number): string => new Date(ms).toISOString();
const minuteDoc = (w: World, ms: number): Promise<RollMinuteDoc | null> => w.docs.getRollMinute(iso(ms).slice(0, 13));
const rowAt = async (w: World, ms: number) => (await minuteDoc(w, ms))?.flows[PAY_FLOW]?.find((r) => r.t === iso(ms));

/**
 * Metrics answers with the rows of some buckets removed, as the Leader answers a minute it does not have yet.
 * `drop(bucketStartMs, nowMs)` decides per row.
 */
function withoutRows(clock: () => number, drop: (startMs: number, nowMs: number) => boolean): (inner: CriblHttp) => CriblHttp {
  return (inner) => ({
    async request(method, path, body, o): Promise<HttpResult> {
      const res = await inner.request(method, path, body, o);
      if (method !== 'POST' || !path.startsWith('/system/metrics/query') || !res.ok) return res;
      const json = res.json as { results?: Record<string, unknown>[] } | undefined;
      if (!json?.results) return res;
      const now = clock();
      return { ...res, json: { ...json, results: json.results.filter((r) => !drop(Number(r.starttime) * 1000, now)) } };
    },
  });
}

/** The Leader's measured lag: a just-ended minute has no rows for its first `lagMs` (REVIEW-3a #1: ~7 s live). */
const leaderLag = (clock: () => number, lagMs: number) => withoutRows(clock, (start, now) => start + MINUTE > now - lagMs);

async function laggedWorld(lagMs: number): Promise<World> {
  let w!: World;
  w = await createWorld({ wrapHttp: leaderLag(() => w.now(), lagMs) });
  return w;
}

/** Σ of every stored row (all flows) against the running totals: they must always agree. */
async function totalsAgree(w: World, hours: number[]): Promise<{ rows: { savedM: number; whpM: number; minutes: number }; totals: { savedM: number; whpM: number; minutes: number } }> {
  const rows = { savedM: 0, whpM: 0, minutes: 0 };
  const minutes = new Set<string>();
  for (const h of hours) {
    for (const list of Object.values((await minuteDoc(w, h))?.flows ?? {})) {
      for (const r of list) {
        rows.savedM += r.savedM;
        rows.whpM += r.whpM;
        minutes.add(r.t);
      }
    }
  }
  rows.minutes = minutes.size;
  const t = (await w.docs.getTotals()) as TotalsDoc;
  const totals = { savedM: 0, whpM: 0, minutes: 0 };
  for (const d of Object.values(t.byDay)) {
    totals.savedM += d.savedM;
    totals.whpM += d.whpM;
    totals.minutes += d.minutes;
  }
  return { rows, totals };
}

describe('REVIEW-3a #1 — the settle lag and the empty-minute hold', () => {
  it('meters only minutes that ended at least 20 s ago: a sweep 3 s after the boundary records no zero minute', async () => {
    const w = await laggedWorld(7_000);
    expect(SETTLE_MS).toBe(20_000);
    const seed = await w.sweep('scheduled'); // 15:00:20 → through 15:00
    expect(seed.error).toBeUndefined();
    expect((await w.meta())!.meteredThrough).toBe(iso(B));

    // The probe: 15:01:03, three seconds after 15:00–15:01 ended. The Leader has no rows for it yet.
    w.set(B + MINUTE + 3_000);
    const early = await w.sweep('scheduled');
    expect(early.error).toBeUndefined();
    expect(early.minutesProcessed).toBe(0);
    expect((await w.meta())!.meteredThrough).toBe(iso(B)); // not advanced past the unsettled minute
    expect(await rowAt(w, B)).toBeUndefined(); // no zero row for it
    // A tab at the same moment stops at the cheap check (one call).
    expect((await w.sweep('ui')).skipped).toBe('current');

    // 15:01:20: settled, and metered with its real traffic.
    w.set(B + MINUTE + SETTLE_MS);
    const settled = await w.sweep('scheduled');
    expect(settled.minutesProcessed).toBe(1);
    expect(settled.heldMinutes).toBeUndefined();
    expect((await rowAt(w, B))!.inB).toBeGreaterThan(0);
    expect(settled.snapshot!.ratePerSecM).toBeGreaterThan(0);
    expect((await w.meta())!.meteredThrough).toBe(iso(B + MINUTE));
  });

  it('holds an empty minute after a minute with traffic, then meters it once the Leader has it', async () => {
    const w = await laggedWorld(30_000); // slower than the settle: the minute is still empty at +20 s
    // The seed at 15:00:20 already meets it: 14:59 is empty, 14:58 had traffic → 14:59 is held.
    const seed = await w.sweep('scheduled');
    expect(seed.heldMinutes).toBe(1);
    expect((await w.meta())!.meteredThrough).toBe(iso(B - MINUTE));
    w.set(B + 50_000); // the tab's next tick fills it
    expect((await w.sweep('ui')).minutesProcessed).toBe(1);
    expect((await w.meta())!.meteredThrough).toBe(iso(B));
    w.set(B + MINUTE + SETTLE_MS);
    const held = await w.sweep('ui');
    expect(held.error).toBeUndefined();
    expect(held.minutesProcessed).toBe(0);
    expect(held.heldMinutes).toBe(1);
    expect((await w.meta())!.meteredThrough).toBe(iso(B)); // the cursor waits
    expect(await rowAt(w, B)).toBeUndefined();
    expect(held.snapshot!.windowEnd).toBe(iso(B)); // the snapshot still shows the last metered minute
    expect(held.snapshot!.ratePerSecM).toBeGreaterThan(0); // …not a zero minute
    expect(w.logs.some((l) => l.msg.includes('holding 1 empty minute'))).toBe(true);

    // The tab's next tick (30 s later) is not 'current': it retries and finds the data.
    w.advance(30_000);
    const filled = await w.sweep('ui');
    expect(filled.skipped).toBeUndefined();
    expect(filled.minutesProcessed).toBe(1);
    expect(filled.heldMinutes).toBeUndefined();
    expect((await rowAt(w, B))!.inB).toBeGreaterThan(0);
    expect((await w.meta())!.meteredThrough).toBe(iso(B + MINUTE));
  });

  it('holds for at most 3 minutes: traffic that really stopped is metered as quiet', async () => {
    let w!: World;
    w = await createWorld({ wrapHttp: withoutRows(() => w.now(), (start) => start >= B) }); // nothing from 15:00 on
    await w.sweep('scheduled');
    for (let k = 1; k <= 3; k++) {
      w.set(B + k * MINUTE + SETTLE_MS);
      const r = await w.sweep('scheduled');
      expect(r.minutesProcessed).toBe(0);
      expect(r.heldMinutes).toBe(k);
      expect((await w.meta())!.meteredThrough).toBe(iso(B));
    }
    w.set(B + 4 * MINUTE + SETTLE_MS);
    const quiet = await w.sweep('scheduled');
    expect(quiet.heldMinutes).toBeUndefined();
    expect(quiet.minutesProcessed).toBe(4);
    expect((await w.meta())!.meteredThrough).toBe(iso(B + 4 * MINUTE));
    expect(await rowAt(w, B)).toBeUndefined(); // quiet minutes have no rows…
    const t = (await w.docs.getTotals())!;
    expect(Object.values(t.byDay).reduce((s, d) => s + d.minutes, 0)).toBe(60 + 4); // …but count as metered minutes
    expect(HOLD_EMPTY_MAX_MS).toBe(3 * MINUTE);
  });

  it('a late sweep or a held minute never skips judging the next minute (the detection cursor stays inside it)', async () => {
    const w = await createWorld();
    await w.sweep('scheduled');
    await w.sweepMinutes(1); // 15:01:20 meters 15:00
    // 15:01–15:02's metering tick (due 15:02:20) lost the lock; the next came 65 s past its end: 15:03:05.
    w.set(B + 3 * MINUTE + 5_000);
    const late = await w.sweep('scheduled');
    expect(late.minutesProcessed).toBe(1);
    const cursor = Date.parse((await w.docs.getBaselines())!.updatedAt);
    expect(cursor).toBeLessThan(B + 3 * MINUTE); // inside the next minute, not at the sweep's own time
    expect(cursor).toBe(B + 3 * MINUTE - 1_000);
    // 15:03:20 meters 15:02 — and judges it.
    w.set(B + 3 * MINUTE + SETTLE_MS);
    await w.sweep('scheduled');
    expect((await w.docs.getBaselines())!.updatedAt).toBe(iso(B + 3 * MINUTE + SETTLE_MS));

    // Same for a minute held back and filled later.
    const h = await laggedWorld(30_000);
    await h.sweep('scheduled'); // holds 14:59
    h.set(B + 50_000);
    await h.sweep('ui'); // meters 14:59
    h.set(B + MINUTE + SETTLE_MS);
    const held = await h.sweep('ui'); // holds 15:00
    expect(held.heldMinutes).toBe(1);
    h.advance(30_000);
    await h.sweep('ui'); // meters 15:00 and judges it
    expect((await h.docs.getBaselines())!.updatedAt).toBe(iso(h.now()));
  });

  it('an empty answer for the rewritten minute never erases its stored rows', async () => {
    let w!: World;
    let dropMinute = Number.NaN;
    w = await createWorld({ wrapHttp: withoutRows(() => w.now(), (start) => start === dropMinute) });
    await w.sweep('scheduled');
    await w.sweepMinutes(1); // meters 15:00
    const stored = await rowAt(w, B);
    expect(stored!.inB).toBeGreaterThan(0);
    dropMinute = B; // the next sweep's rewrite of 15:00 comes back empty
    const [next] = await w.sweepMinutes(1);
    expect(next.minutesProcessed).toBe(1);
    expect(await rowAt(w, B)).toEqual(stored);
    const { rows, totals } = await totalsAgree(w, [B - HOUR, B]);
    expect(totals.savedM).toBe(rows.savedM);
  });

  it('holdBackEnd and windowHasTraffic', () => {
    const win = (m: number) => ({ windowStart: iso(m) });
    const ws = [0, 1, 2, 3].map((k) => win(B + k * MINUTE));
    const end = B + 4 * MINUTE;
    // Traffic through minute 1: minutes 2–3 are held from minute 2.
    expect(holdBackEnd(ws, (i) => i <= 1, B, end)).toBe(B + 2 * MINUTE);
    // Never before newStart.
    expect(holdBackEnd(ws, (i) => i <= 1, B + 3 * MINUTE, end)).toBe(B + 3 * MINUTE);
    // No traffic anywhere, or traffic in the newest minute: nothing to hold.
    expect(holdBackEnd(ws, () => false, B, end)).toBe(end);
    expect(holdBackEnd(ws, (i) => i === 3, B, end)).toBe(end);
    expect(holdBackEnd([], () => true, B, end)).toBe(end);
    // Held while its first minute ended less than 3 minutes before the end; metered from 3 minutes on.
    expect(holdBackEnd(ws, (i) => i === 0, B, end)).toBe(B + MINUTE);
    const ws5 = [0, 1, 2, 3, 4].map((k) => win(B + k * MINUTE));
    expect(holdBackEnd(ws5, (i) => i === 0, B, B + 5 * MINUTE)).toBe(B + 5 * MINUTE);
    expect(holdBackEnd(ws5, (i) => i === 0, B + 6 * MINUTE, B + 5 * MINUTE)).toBe(B + 5 * MINUTE);
    expect(windowHasTraffic({ inputs: {}, outputs: {} })).toBe(false);
    expect(windowHasTraffic({ inputs: { a: { bytes: 0, events: 0 } }, outputs: { b: { bytes: 0, events: 3 } } })).toBe(true);
    expect(windowHasTraffic({ inputs: { a: { bytes: 5, events: 0 } }, outputs: {} })).toBe(true);
  });
});

describe('REVIEW-3a #3 — nothing is metered before the first price', () => {
  it('a prices document without versions gates like a missing one; a deleted price keeps the cursor where it was', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(2);
    const before = (await w.meta())!;
    await w.docs.putPrices(emptyPrices(iso(w.now())));
    const [gated] = await w.sweepMinutes(1);
    expect(gated.skipped).toBe('no_prices');
    expect(gated.minutesProcessed).toBe(0);
    const after = (await w.meta())!;
    expect(after.meteredThrough).toBe(before.meteredThrough);
    expect(after.collectingSince).toBe(before.collectingSince);
    expect(after.lastSweepAt).toBe(iso(w.now()));
    expect(after.sweepCount).toBe(before.sweepCount + 1);
  });
});

describe('REVIEW-3a #5 — the totals carry their own cursor', () => {
  it('a sweep that dies between the minute docs and the totals loses no minute (fault injection)', async () => {
    let failTotals = 0;
    const faulty = (kv: KvStore): KvStore => ({
      ...kv,
      put: (key, value) => {
        if (key === 'totals' && failTotals > 0) {
          failTotals--;
          return Promise.reject(new Error('injected: totals PUT failed'));
        }
        return kv.put(key, value);
      },
    });
    const w = await createWorld({ wrapKv: faulty });
    await w.sweep();
    await w.sweepMinutes(3);
    failTotals = 1;
    const [dead] = await w.sweepMinutes(1);
    expect(dead.error).toContain('injected');
    // The minute doc already holds the new minute; totals and meta do not.
    const deadMinute = Date.parse((await w.meta())!.meteredThrough!);
    expect(await rowAt(w, deadMinute)).toBeDefined();
    await w.sweepMinutes(2);
    const { rows, totals } = await totalsAgree(w, [B - HOUR, B]);
    expect(totals.savedM).toBe(rows.savedM);
    expect(totals.whpM).toBe(rows.whpM);
    expect(totals.minutes).toBe(rows.minutes);
    const t = (await w.docs.getTotals())!;
    expect(t.meteredThrough).toBe((await w.meta())!.meteredThrough);
    expect(t.meteredAt).toBe(t.updatedAt);
  });

  it('a stale cursor left by a writer that does not know it is ignored (no double count)', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(3);
    // An older build rewrote totals: updatedAt moved, the cursor (and its stamp) stayed a minute behind.
    const t = (await w.docs.getTotals())!;
    await w.docs.putTotals({ ...t, updatedAt: iso(w.now() + 1), meteredThrough: iso(Date.parse(t.meteredThrough!) - MINUTE) });
    await w.sweepMinutes(2);
    const { rows, totals } = await totalsAgree(w, [B - HOUR, B]);
    expect(totals.savedM).toBe(rows.savedM);
    expect(totals.minutes).toBe(rows.minutes);
  });

  it('writes the minutes, totals and incident before notifying: a send that dies leaves the incident recorded', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(2);
    w.advance(10_000);
    expect((await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' })).ok).toBe(true);
    let recorded: Incident | undefined;
    const webhook = {
      post: async () => {
        // At send time the incident, the totals and the baselines are already in KV.
        const docs = await w.docs.getIncidents(iso(w.now()).slice(0, 10));
        recorded = docs?.items.find((i) => i.objectKey === PAY_ROUTE);
        return { status: 200 };
      },
    };
    const results = await w.sweepMinutes(3, { webhook });
    const opened = results.find((r) => r.opened > 0)!;
    expect(recorded).toBeDefined();
    expect(recorded!.lastNotifiedAt).toBeUndefined(); // written before the send…
    const stored = (await w.docs.getIncidents(recorded!.openedAt.slice(0, 10)))!.items.find((i) => i.id === recorded!.id)!;
    expect(stored.lastNotifiedAt).toBe(opened.meta!.lastSweepAt); // …and again with what was delivered
    expect(stored.deliveries).toEqual([expect.objectContaining({ endpointId: SINK_ENDPOINT.id, status: 200 })]);
  });
});

describe('REVIEW-3a #2 — delivery: 2xx only, a short wait after a failure, and the runner owns it', () => {
  it('lastNotifiedAt moves only on a 2xx; a failed attempt waits 2 minutes, then retries and delivers', async () => {
    let failing = true;
    let posts = 0;
    const w = await createWorld();
    const webhook = {
      post: async () => {
        posts++;
        return failing ? { status: 503 } : { status: 200 };
      },
    };
    await w.sweep('ui', { webhook });
    await w.sweepMinutes(2, { webhook });
    w.advance(10_000);
    await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' });
    let opened: Awaited<ReturnType<World['sweep']>> | undefined;
    for (let k = 0; k < 4 && !opened; k++) {
      const [r] = await w.sweepMinutes(1, { webhook });
      if (r.opened > 0) opened = r;
    }
    expect(opened!.notified).toBe(0);
    const inc = opened!.snapshot!.incidents.find((i) => i.objectKey === PAY_ROUTE)!;
    expect(inc.lastNotifiedAt).toBeUndefined();
    expect(inc.lastAttemptAt).toBe(opened!.meta!.lastSweepAt);
    const lastTry = Date.parse(inc.lastAttemptAt!);
    const stored = async () => (await w.docs.getIncidents(inc.openedAt.slice(0, 10)))!.items.find((i) => i.id === inc.id)!;
    expect((await stored()).lastAttemptAt).toBe(inc.lastAttemptAt);

    // Inside the 2-minute wait nothing is sent.
    const before = posts;
    w.set(lastTry + 60_000);
    const inside = await w.sweep('scheduled', { webhook });
    expect(inside.notified).toBe(0);
    expect(posts).toBe(before);

    // After it, the retry goes out as the opening it still is, and the cooldown clock starts.
    failing = false;
    w.set(lastTry + FAILED_ATTEMPT_COOLDOWN_MS + 1_000);
    const retried = await w.sweep('scheduled', { webhook });
    expect(retried.notified).toBe(1);
    expect(retried.opened).toBe(0); // delivered, not re-opened
    const after = await stored();
    expect(after.lastNotifiedAt).toBe(retried.meta!.lastSweepAt);
    expect(after.lastAttemptAt).toBe(retried.meta!.lastSweepAt);
    expect((await w.docs.getNotifyLog())!.items.at(-1)).toMatchObject({ event: 'incident.opened', status: 200 });
    // Then the ordinary cooldown: the next sweep sends nothing.
    w.advance(60_000);
    expect((await w.sweep('scheduled', { webhook })).notified).toBe(0);
  });

  it('a tab leaves delivery to a runner that swept in the last 90 s; the runner delivers the opening and the recovery', async () => {
    const w = await createWorld();
    const RUNNER = { owner: 'runner:studio:4242', runtime: 'backend' as const };
    await w.sweep();
    await w.sweepMinutes(2);
    w.advance(10_000);
    await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' });
    // The runner swept 30 s ago (at :25 of the previous minute), so the tab that opens the incident defers.
    const runnerSwept = async (): Promise<void> => {
      const m = (await w.meta()) as Meta;
      await w.docs.putMeta({ ...m, lastSweepOwner: RUNNER.owner, lastSweepAt: iso(w.now() - 30_000), lastSweepMode: 'scheduled' });
    };
    let opened: Awaited<ReturnType<World['sweep']>> | undefined;
    for (let k = 0; k < 4 && !opened; k++) {
      w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 50_000); // the tab ticks at :50…
      await runnerSwept();
      const r = await w.sweep('ui');
      if (r.opened > 0) opened = r;
    }
    expect(opened).toBeDefined();
    expect(opened!.notified).toBe(0);
    expect(w.em.sink()).toHaveLength(0);
    expect(w.logs.some((l) => l.msg.includes('delivers the alerts'))).toBe(true);
    const inc = opened!.snapshot!.incidents.find((i) => i.objectKey === PAY_ROUTE)!;
    expect(inc.lastAttemptAt).toBeUndefined();

    // The runner's next sweep delivers it — as the opening nobody heard about — without counting a new incident.
    w.advance(35_000);
    const runner = await w.sweep('scheduled', RUNNER);
    expect(runner.notified).toBe(1);
    expect(runner.opened).toBe(0);
    expect(w.em.sink()[0].json).toMatchObject({ event: 'incident.opened', incident: { id: inc.id } });

    // Restore; the tab closes the incident while the runner is fresh, and the runner sends the recovery.
    w.em.control({ action: 'restore' });
    let closed: Awaited<ReturnType<World['sweep']>> | undefined;
    for (let k = 0; k < 6 && !closed; k++) {
      w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 50_000);
      await runnerSwept();
      const r = await w.sweep('ui');
      if (r.closed > 0) closed = r;
    }
    expect(closed).toBeDefined();
    expect(closed!.notified).toBe(0);
    expect(w.em.sink()).toHaveLength(1);
    w.advance(35_000);
    const recovery = await w.sweep('scheduled', RUNNER);
    expect(recovery.notified).toBe(1);
    expect(recovery.closed).toBe(0); // picked up, not closed again
    expect(w.em.sink()[0].json).toMatchObject({ event: 'incident.closed', incident: { id: inc.id } });
    // Delivered once: the next runner sweep sends nothing more.
    w.advance(60_000);
    expect((await w.sweep('scheduled', RUNNER)).notified).toBe(0);
    expect(w.em.sink()).toHaveLength(2);
  });

  it('deliveryOwnedElsewhere, inFailedAttemptCooldown, undeliveredClosure', () => {
    const now = T0;
    const at = (msAgo: number) => iso(now - msAgo);
    expect(deliveryOwnedElsewhere({ lastSweepOwner: 'runner:studio:1', lastSweepAt: at(30_000) }, 'ui:tab', now)).toBe(true);
    expect(deliveryOwnedElsewhere({ lastSweepOwner: 'backend:abc', lastSweepAt: at(30_000) }, 'ui:tab', now)).toBe(true);
    expect(deliveryOwnedElsewhere({ lastSweepOwner: 'sweep:backend', lastSweepAt: at(30_000) }, 'ui:tab', now)).toBe(true);
    expect(deliveryOwnedElsewhere({ lastSweepOwner: 'runner:studio:1', lastSweepAt: at(DELIVERY_OWNER_FRESH_MS) }, 'ui:tab', now)).toBe(false);
    expect(deliveryOwnedElsewhere({ lastSweepOwner: 'ui:other', lastSweepAt: at(1_000) }, 'ui:tab', now)).toBe(false);
    expect(deliveryOwnedElsewhere({ lastSweepOwner: 'ui:tab', lastSweepAt: at(1_000) }, 'ui:tab', now)).toBe(false);
    expect(deliveryOwnedElsewhere({ lastSweepOwner: 'runner:x:1' }, 'ui:tab', now)).toBe(false);
    expect(deliveryOwnedElsewhere(null, 'ui:tab', now)).toBe(false);

    expect(inFailedAttemptCooldown({ lastAttemptAt: at(60_000) }, now)).toBe(true);
    expect(inFailedAttemptCooldown({ lastAttemptAt: at(FAILED_ATTEMPT_COOLDOWN_MS) }, now)).toBe(false);
    expect(inFailedAttemptCooldown({ lastAttemptAt: at(60_000), lastNotifiedAt: at(60_000) }, now)).toBe(false); // it succeeded
    expect(inFailedAttemptCooldown({}, now)).toBe(false);

    const base: Incident = {
      id: 'inc_1',
      type: 'regression',
      severity: 'high',
      objectKey: PAY_ROUTE,
      label: 'Payments API sampling',
      openedAt: at(20 * MINUTE),
      before: 0.75,
      after: 0.5,
      impactPerDayM: 1,
      notes: [],
      deliveries: [],
    };
    expect(undeliveredClosure({ ...base, closedAt: at(MINUTE), lastNotifiedAt: at(10 * MINUTE) }, now)).toBe(true);
    expect(undeliveredClosure({ ...base, closedAt: at(MINUTE), lastNotifiedAt: at(30_000) }, now)).toBe(false); // told
    expect(undeliveredClosure({ ...base, closedAt: at(MINUTE) }, now)).toBe(false); // nobody heard of the opening
    expect(undeliveredClosure({ ...base, type: 'goodnews', closedAt: at(MINUTE) }, now)).toBe(true);
    expect(undeliveredClosure({ ...base, closedAt: at(UNDELIVERED_CLOSURE_MS), lastNotifiedAt: at(20 * MINUTE) }, now)).toBe(false);
    expect(undeliveredClosure(base, now)).toBe(false); // still open
  });
});

describe('REVIEW-3a #13 — catch-up incidents are timed from their detection', () => {
  it('an incident caught on catch-up records when it was detected; the payload counts it and says so', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(12);
    w.em.control({ action: 'breakTrim', at: Date.UTC(2026, 8, 28, 16, 30, 10) });
    w.set(Date.UTC(2026, 8, 28, 18, 12, 20));
    const r = await w.sweep();
    const reg = r.snapshot!.incidents.find((i) => i.type === 'regression' && i.objectKey === PAY_ROUTE)!;
    expect(reg.openedAt).toBe('2026-09-28T16:32:00.000Z'); // the minute it showed (D11)
    expect(reg.detectedAt).toBe('2026-09-28T18:12:20.000Z'); // the sweep that caught it
    const lateSec = (Date.parse(reg.detectedAt!) - Date.parse(reg.openedAt)) / 1000;
    const canonical = canonicalPayload('incident.opened', { incident: reg, workspace: 'w', linkBase: '', sentAt: iso(w.now()) });
    expect(canonical.incident!.caughtInSeconds).toBe(Math.round(reg.caughtInSec! + lateSec));
    expect(JSON.stringify(slackPayload(canonical).blocks)).toContain('caught on catch-up');
    // The webhook the sweep sent carries the same detection-based figure.
    const sent = w.em.sink().find((s) => (s.json as { incident?: { id?: string } }).incident?.id === reg.id);
    expect((sent!.json as { incident: { caughtInSeconds: number; notes: string[] } }).incident).toMatchObject({
      caughtInSeconds: Math.round(reg.caughtInSec! + lateSec),
      notes: expect.arrayContaining(['catch-up']),
    });
  });
});
