// tests/integration/scenarios.test.ts — the metering scenarios of PRD 12 item 4 that live in core, and SPEC 16's
// S15–S21, driven end to end through runSweep() and the demo levers against the emulated Cribl org
// (src/mock: the live org's captured config with the demo rig merged in; metrics, version API, KV, webhooks).

import { describe, expect, it } from 'vitest';
import type { CriblHttp, KvStore } from '../../core/types.ts';
import type { SweepResult as Result } from '../../core/sweep.ts';
import { appendPriceVersion } from '../../core/pricing.ts';
import { applyPack, breakTrim, revertPack, setRate, type LeverResult } from '../../core/demo/levers.ts';
import { DAY, HOUR, MINUTE, SINK_ENDPOINT, T0, createWorld, faultHttp, lateDataHttp, rigPrices, sumRows, type World } from './harness.ts';

const PAY_FLOW = 'default|mrd_payments_api|mrd_payments_api|mrd_pay_sample|mrd_siem_prod';
const VPC_FLOW = 'default|mrd_vpc_flow|mrd_vpc_flow|mrd_passthrough|mrd_archive_s3';
const PAY_ROUTE = 'route:default:mrd_payments_api';
const WS_ROUTE = 'route:default:mrd_windows_workstations';

const hourDoc = (w: World, ms: number) => w.docs.getRollMinute(new Date(ms).toISOString().slice(0, 13));
const incidentsOf = (r: Result) => r.snapshot?.incidents ?? [];
const commitOf = (r: LeverResult): string => {
  if (!r.ok) throw new Error(`lever refused: ${r.error} ${r.message}`);
  return r.commit as string;
};

describe('metering scenarios (PRD 12 item 4)', () => {
  it('first run on a fresh install: nothing is metered until a price is saved, then a whole day of history is priced at the first price (REVIEW-3a #3, D25, rules round)', async () => {
    const w = await createWorld({ bare: true, sweep: { firstRunReachMs: undefined } });
    const first = await w.sweep();
    expect(first.error).toBeUndefined();
    expect(first.skipped).toBe('no_prices');
    expect(first.minutesProcessed).toBe(0);
    // No snapshot (the home page stays on the first-run card); the inventory is there for the Prices screen;
    // meta tells the tab a sweep ran and where collecting will start, with no cursor.
    expect(await w.docs.getSnapshot()).toBeNull();
    expect(await w.docs.getInventory()).not.toBeNull();
    const meta0 = (await w.meta())!;
    expect(first.meta).toEqual(meta0);
    expect(meta0.meteredThrough).toBeUndefined();
    const seedStart = Math.floor(T0 / MINUTE) * MINUTE - HOUR; // T0 = 15:00:20 → the settled minute ends 15:00
    expect(meta0.collectingSince).toBe(new Date(seedStart).toISOString());
    expect(await w.docs.getTotals()).toBeNull();

    // The judge reads for two minutes: the tab keeps sweeping, nothing is metered and neither cursor moves.
    const waiting = await w.sweepMinutes(2);
    expect(waiting.every((r) => r.skipped === 'no_prices' && r.minutesProcessed === 0 && !r.snapshot)).toBe(true);
    expect((await w.meta())!.collectingSince).toBe(meta0.collectingSince);
    expect((await w.meta())!.meteredThrough).toBeUndefined();

    // Save prices (effective now, 15:02:20): the next sweep meters a whole day of history through 15:03 at the first
    // price (a small estate: firstRunSeedMs reaches the full day in one sweep), not just the hour collectingSince seeded.
    const saveAt = w.now();
    await w.docs.putPrices(rigPrices(saveAt));
    const [priced] = await w.sweepMinutes(1);
    expect(priced.error).toBeUndefined();
    expect(priced.minutesProcessed).toBe(24 * 60);
    const dayStart = Date.UTC(2026, 8, 27, 15, 3); // the settled minute ends 15:03; a day before it
    const perGb = (r: { whpM: number; inB: number }) => Math.round(r.whpM / (r.inB / 1e9));
    for (const at of [dayStart, seedStart]) {
      const row = (await hourDoc(w, at))!.flows[PAY_FLOW].find((r) => r.t === new Date(at).toISOString())!;
      expect(row.whpM).toBeGreaterThan(0);
      expect(perGb(row)).toBeCloseTo(250_000, -2);
    }
    // Collecting starts where metering did; the time spent pricing is no gap, and the seeded history alerts nobody.
    const meta1 = (await w.meta())!;
    expect(meta1.collectingSince).toBe(new Date(dayStart).toISOString());
    expect(meta1.gaps).toBeUndefined();
    expect(priced.opened).toBe(0);
    expect(w.em.sink()).toEqual([]);
    expect(priced.snapshot!.headline.todayM).toBeGreaterThan(0);
    expect(priced.snapshot!.unpricedOutputIds).toEqual([]);

    // A later price change applies from its effective time only: nothing already metered is re-priced.
    await w.docs.putPrices(appendPriceVersion(rigPrices(saveAt), { mrd_siem_prod: { milliCentsPerGb: 500_000, preset: 'splunk_cloud' } }, saveAt + 2 * MINUTE));
    await w.sweepMinutes(3);
    const rows = (await hourDoc(w, T0))!.flows[PAY_FLOW];
    expect(perGb(rows.find((r) => r.t === '2026-09-28T15:01:00.000Z')!)).toBeCloseTo(250_000, -2);
    expect(perGb(rows.find((r) => r.t === '2026-09-28T15:05:00.000Z')!)).toBeCloseTo(500_000, -2);
  });

  it('steady state: one new minute a sweep, the headline accrues, ratePerSecM follows the last minute', async () => {
    const w = await createWorld();
    await w.sweep();
    const results = await w.sweepMinutes(10);
    let last = 0;
    for (const r of results) {
      expect(r.error).toBeUndefined();
      expect(r.minutesProcessed).toBe(1);
      expect(r.snapshot!.headline.todayM).toBeGreaterThan(last);
      last = r.snapshot!.headline.todayM;
      const savedLastMinute = r.snapshot!.flows.reduce((s, f) => s + f.savedM, 0);
      expect(r.snapshot!.ratePerSecM).toBeCloseTo(savedLastMinute / 60, 6);
    }
    expect(results.at(-1)!.snapshot!.headline.annualizedM).toBeGreaterThan(0);
  });

  it('late minute rewrite: minute N−1 settles on the next sweep and totals stay equal to the rows', async () => {
    const holder: { late?: ReturnType<typeof lateDataHttp> } = {};
    const w = await createWorld({
      wrapHttp: (h) => (holder.late = lateDataHttp(h)),
    });
    await w.sweep();
    await w.sweepMinutes(5);
    expect(holder.late!.halved.length).toBeGreaterThanOrEqual(6);
    const docs = [await hourDoc(w, T0 - HOUR), await hourDoc(w, T0)];
    const all = sumRows(docs, () => true);
    const day = (await w.docs.getTotals())!.byDay['2026-09-28'];
    expect(day).toMatchObject({
      whpM: all.whpM,
      paidM: all.paidM,
      savedM: all.savedM,
      minutes: 65,
    });
    // Only the newest minute (not yet rewritten) is still at its partial value.
    const pay = docs[1]!.flows[PAY_FLOW];
    const settled = pay.slice(0, -1).map((r) => r.inB);
    expect(Math.min(...settled)).toBeGreaterThan(pay.at(-1)!.inB * 1.5);
  });

  it('backfill after a 3-hour gap: every minute metered, catch-up alerts at their true time', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(11);
    w.em.control({ action: 'breakTrim', at: Date.UTC(2026, 8, 28, 16, 0, 30) });
    w.set(T0 + 3 * HOUR + 11 * MINUTE);
    const r = await w.sweep();
    expect(r.minutesProcessed).toBe(180);
    const reg = incidentsOf(r).find((i) => i.objectKey === PAY_ROUTE)!;
    expect(reg.notes).toEqual(expect.arrayContaining(['catch-up', 'demo-profile']));
    expect(reg.openedAt).toBe('2026-09-28T16:02:00.000Z');
    expect(w.em.sink()[0].json).toMatchObject({
      event: 'incident.opened',
      incident: { notes: expect.arrayContaining(['catch-up']) },
    });
  });

  it('break → alert → webhook → restore: the lever commit is named and the incident closes itself', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(3);
    const hash = commitOf(await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' }));
    const opened = (await w.sweepMinutes(3)).find((r) => r.opened > 0)!;
    const inc = incidentsOf(opened).find((i) => i.objectKey === PAY_ROUTE)!;
    expect(inc).toMatchObject({
      type: 'regression',
      severity: 'high',
      cause: 'commit',
      commit: {
        hash,
        author: 's.koelpin',
        message: 'demo: break the trim on mrd_pay_sample',
        match: 'files',
      },
    });
    expect(w.em.sink()[0].json).toMatchObject({
      event: 'incident.opened',
      incident: { commit: { hash }, caughtInSeconds: inc.caughtInSec },
    });
    const { restoreTrim } = await import('../../core/demo/levers.ts');
    commitOf(await restoreTrim(w.lever, { pipelineId: 'mrd_pay_sample' }));
    const closed = (await w.sweepMinutes(3)).find((r) => r.closed > 0)!;
    expect(incidentsOf(closed).find((i) => i.id === inc.id)?.closedAt).toBeDefined();
    expect(w.em.sink()[0].json).toMatchObject({
      event: 'incident.closed',
      incident: { id: inc.id },
    });
  });

  it('spike: ×5 on a Source opens a high cost-spike incident; calm closes it', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(2);
    commitOf(await setRate(w.lever, { inputId: 'mrd_windows_dc', multiplier: 5 }));
    const opened = (await w.sweepMinutes(3)).find((r) => r.opened > 0)!;
    const spike = incidentsOf(opened).find((i) => i.type === 'spike')!;
    expect(spike).toMatchObject({
      objectKey: 'in:default:mrd_windows_dc',
      severity: 'high',
      cause: 'commit',
    });
    expect(spike.after - spike.before).toBeGreaterThan(500_000); // more than $5/hour extra
    expect(spike.impactPerDayM).toBe(Math.round((spike.after - spike.before) * 24));
    commitOf(await setRate(w.lever, { inputId: 'mrd_windows_dc', multiplier: 1 }));
    const closed = (await w.sweepMinutes(3)).find((r) => r.closed > 0)!;
    expect(incidentsOf(closed).find((i) => i.id === spike.id)?.closedAt).toBeDefined();
  });

  it('budget pace: a destination on course to overspend opens a budget incident', async () => {
    const w = await createWorld({
      settings: (s) =>
        void (s.budgets = {
          mrd_archive_s3: { centsPerMonth: 1 },
          mrd_siem_prod: { centsPerMonth: 0 },
        }),
    });
    const r = await w.sweep();
    const inc = incidentsOf(r).find((i) => i.type === 'budget')!;
    expect(inc).toMatchObject({
      objectKey: 'out:default:mrd_archive_s3',
      severity: 'high',
      label: 'Archive (S3)',
    });
    expect(inc.after).toBeGreaterThan(100);
    expect(r.snapshot!.destinations.find((d) => d.outputId === 'mrd_archive_s3')?.budget?.pct).toBeGreaterThan(100);
  });

  it('good news: a pack that raises savings, with its commit, is announced once (info)', async () => {
    const w = await createWorld({
      settings: (s) => {
        s.goodNewsEnabled = true;
        s.notifications = [{ ...SINK_ENDPOINT, minSeverity: 'info' }];
      },
    });
    await w.sweep();
    await w.sweepMinutes(2);
    const hash = commitOf(await applyPack(w.lever, { routeId: 'mrd_windows_workstations' }));
    const results = await w.sweepMinutes(3);
    const good = results.flatMap(incidentsOf).find((i) => i.type === 'goodnews')!;
    expect(good).toMatchObject({
      objectKey: WS_ROUTE,
      severity: 'info',
      cause: 'commit',
      commit: { hash },
    });
    expect(good.closedAt).toBe(good.openedAt);
    expect(good.after - good.before).toBeGreaterThan(0.15);
    expect(w.em.sink().some((e) => (e.json as { incident?: { type: string } }).incident?.type === 'goodnews')).toBe(true);
  });

  it('403 on one call: a refused metrics query fails only that sweep; a refused version log only skips the refresh', async () => {
    const w = await createWorld();
    await w.sweep();
    const denied = faultHttp(w.deps.http, (m, p) => m === 'POST' && p.startsWith('/system/metrics/query'), 403, 3);
    w.set(T0 + MINUTE);
    const failed = await w.sweep('ui', { http: denied });
    expect(failed.error).toMatch(/HTTP 403/);
    expect((await w.meta())!.sweepErrors).toBe(1);
    const noLog = faultHttp(w.deps.http, (_m, p) => p.startsWith('/m/default/version'), 403, 5);
    w.set(T0 + 2 * MINUTE);
    const ok = await w.sweep('manual', { http: noLog });
    expect(ok.error).toBeUndefined();
    expect(ok.minutesProcessed).toBe(2);
    expect(noLog.hits).toBeGreaterThan(0);
  });
});

describe('SPEC 16 scenarios', () => {
  it('S15 two-commit attribution: an apply-the-pack commit 40 s earlier does not steal the trim regression', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(3);
    const pack = commitOf(await applyPack(w.lever, { routeId: 'mrd_windows_workstations' }));
    w.advance(40_000);
    const trim = commitOf(await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' }));
    const deployedAt = w.now();
    const opened = (await w.sweepMinutes(3)).find((r) => incidentsOf(r).some((i) => i.objectKey === PAY_ROUTE))!;
    const inc = incidentsOf(opened).find((i) => i.objectKey === PAY_ROUTE)!;
    expect(inc.commit?.hash).toBe(trim);
    expect(inc.commit?.hash).not.toBe(pack);
    expect(inc.commit?.match).toBe('files');
    expect(inc.caughtInSec).toBe(Math.round((Date.parse(inc.openedAt) - deployedAt) / 1000));
    expect(inc.caughtInSec).toBeLessThan(180);
  });

  it('S16 request budget: every steady-state sweep ≤ 35 Leader calls (KV included); no /endpoints/meter calls', async () => {
    const w = await createWorld({ sweep: { budget: 35 } });
    await w.sweep('ui', { budget: undefined });
    let worst = 0;
    for (let i = 0; i < 25; i++) {
      if (i === 8) commitOf(await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' }));
      w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 20_000);
      w.em.resetCalls();
      const r = await w.sweep();
      const api = w.em.calls().recent.filter((e) => e.kind === 'api').length;
      expect(r.error).toBeUndefined();
      expect(r.calls).toBe(api);
      expect(r.calls).toBeLessThanOrEqual(35);
      expect(w.em.calls().endpointCalls).toBe(0);
      worst = Math.max(worst, r.calls);
      expect((await w.meta())!.lastSweepCalls).toBe(r.calls);
    }
    expect(worst).toBeGreaterThanOrEqual(23);
  });

  it('S17 sub-cent precision: 60 GB/day at 3¢/GB accrues $1.80 ± $0.01 over 1,440 minutes (cent rounding would say $0)', async () => {
    const w = await createWorld();
    await w.sweep();
    w.set(T0 + DAY);
    const r = await w.sweep();
    expect(r.minutesProcessed).toBe(1440);
    const docs = [];
    for (let h = 0; h < 24; h++) docs.push(await hourDoc(w, T0 + h * HOUR));
    const vpc = sumRows(docs, (k) => k === VPC_FLOW);
    expect(vpc.rows).toBe(1440);
    expect(Math.abs(vpc.paidM - 180_000)).toBeLessThanOrEqual(1_000);
    // Every minute is ~125 mc: rounding each minute to whole cents would have zeroed all of them.
    const minuteValues = (docs[5]!.flows[VPC_FLOW] ?? []).map((row) => row.paidM);
    expect(Math.max(...minuteValues)).toBeLessThan(500);
    expect(Math.min(...minuteValues)).toBeGreaterThan(0);
  });

  it('S19 timeline freshness: with the periodic refresh off, the lever’s own timeline write names the commit', async () => {
    const w = await createWorld({ sweep: { timelineEveryMin: 0 } });
    await w.sweep();
    await w.sweepMinutes(2); // the one-time first refresh
    w.em.resetCalls();
    const hash = commitOf(await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' }));
    const opened = (await w.sweepMinutes(3)).find((r) => r.opened > 0)!;
    expect(incidentsOf(opened).find((i) => i.objectKey === PAY_ROUTE)?.commit?.hash).toBe(hash);
    expect(w.em.calls().byRoute['GET /m/:gid/version'] ?? 0).toBe(0);
  });

  it('S19 timeline freshness: a commit made outside the app is found by the refresh before the regression opens', async () => {
    const w = await createWorld({ sweep: { timelineEveryMin: 0 } });
    await w.sweep();
    await w.sweepMinutes(2);
    const { commits } = w.em.control({ action: 'breakTrim' }) as {
      commits: { hash: string }[];
    };
    w.em.resetCalls();
    const opened = (await w.sweepMinutes(3)).find((r) => r.opened > 0)!;
    const inc = incidentsOf(opened).find((i) => i.objectKey === PAY_ROUTE)!;
    expect(inc).toMatchObject({
      cause: 'commit',
      severity: 'high',
      commit: { hash: commits[0].hash },
    });
    expect(w.em.calls().byRoute['GET /m/:gid/version']).toBe(1);
  });

  it('S20 lever burst: three pack applies and a break within 70 s at a 50-a-minute limit — no sweep skipped, ≤ 1 retry', async () => {
    let limited = 0;
    const count429Http = (h: CriblHttp): CriblHttp => ({
      async request(m, p, b, o) {
        const r = await h.request(m, p, b, o);
        if (r.status === 429) limited++;
        return r;
      },
    });
    const count429Kv = (kv: KvStore): KvStore => {
      const wrap =
        <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
        async (...a: A): Promise<R> => {
          try {
            return await fn(...a);
          } catch (e) {
            if ((e as { status?: number }).status === 429) limited++;
            throw e;
          }
        };
      return {
        get: wrap(kv.get),
        put: wrap(kv.put),
        del: wrap(kv.del),
        list: wrap(kv.list),
      };
    };
    // The tab's metering tick lands SETTLE_MS (20 s) after the boundary (REVIEW-3a #1), so its ticks sit at
    // :20/:50 (the first sweep is one of them) and the burst lands BEFORE the minute's sweep: the levers keep
    // the sweep's share of the minute free (core/demo/levers.ts) instead of starving it.
    const w = await createWorld({
      start: Date.UTC(2026, 8, 28, 15, 0, 20),
      options: { rateLimitPerMinute: 50 },
      wrapHttp: count429Http,
      wrapKv: count429Kv,
    });
    const lever = { ...w.lever, minuteBudget: undefined };
    const first = Date.UTC(2026, 8, 28, 15, 1, 10);
    const queue: {
      at: number;
      name: string;
      run: () => Promise<LeverResult>;
    }[] = [
      {
        at: first,
        name: 'pack windows',
        run: () => applyPack(lever, { routeId: 'mrd_windows_workstations' }),
      },
      {
        at: first + 15_000,
        name: 'pack pan',
        run: () => applyPack(lever, { routeId: 'mrd_pan_firewall' }),
      },
      {
        at: first + 30_000,
        name: 'pack vpc',
        run: () => applyPack(lever, { routeId: 'mrd_vpc_flow' }),
      },
      {
        at: first + 70_000,
        name: 'break',
        run: () => breakTrim(lever, { pipelineId: 'mrd_pay_sample' }),
      },
    ];
    const sweeps: Result[] = [await w.sweep()];
    let nextTry = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const done: string[] = [];
    let trimCommit = '';
    for (
      let t = Date.UTC(2026, 8, 28, 15, 0, 10);
      t <= Date.UTC(2026, 8, 28, 15, 12, 0) && (queue.length > 0 || sweeps.length < 20);
      t += 5_000
    ) {
      w.set(Math.max(t, w.now()));
      if (Math.floor(t / 1000) % 30 === 20) sweeps.push(await w.sweep());
      const head = queue[0];
      if (head && head.at <= w.now() && nextTry <= w.now()) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const r = await head.run();
        inFlight--;
        if (r.ok) {
          done.push(head.name);
          if (head.name === 'break') trimCommit = r.commit ?? '';
          queue.shift();
        } else {
          expect(['budget', 'in_flight', 'rate_limited', 'locked']).toContain(r.error);
          nextTry = w.now() + (r.retryInMs ?? 10_000);
        }
      }
    }
    expect(done).toEqual(['pack windows', 'pack pan', 'pack vpc', 'break']);
    expect(maxInFlight).toBe(1);
    for (const s of sweeps) {
      expect(s.skipped === undefined || s.skipped === 'current').toBe(true);
      expect(s.error).toBeUndefined();
    }
    expect(limited).toBeLessThanOrEqual(1);
    const reg = sweeps.flatMap(incidentsOf).find((i) => i.objectKey === PAY_ROUTE);
    expect(reg?.commit?.hash).toBe(trimCommit);
  });

  it('S21 muting: a Revert opens no incident for 10 minutes; a break after the mute expires does', async () => {
    // A fast baseline (5-minute memory) makes the reverted route a real savings drop against its baseline.
    const w = await createWorld({
      settings: (s) => void (s.thresholds.ewmaAlpha = 0.2),
    });
    await w.sweep();
    commitOf(await applyPack(w.lever, { routeId: 'mrd_windows_workstations' }));
    await w.sweepMinutes(15);
    commitOf(await revertPack(w.lever, { routeId: 'mrd_windows_workstations' }));
    const muted = await w.sweepMinutes(9);
    expect(muted.flatMap(incidentsOf).filter((i) => i.objectKey === WS_ROUTE && i.type === 'regression')).toEqual([]);
    expect(muted.at(-1)!.snapshot!.flows.find((f) => f.routeId === 'mrd_windows_workstations' && f.inB > 0)?.muted).toBe(true);
    w.advance(2 * MINUTE);
    const hash = commitOf(await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' }));
    const after = await w.sweepMinutes(3);
    const pay = after.flatMap(incidentsOf).find((i) => i.objectKey === PAY_ROUTE);
    expect(pay?.commit?.hash).toBe(hash);
  });
});
