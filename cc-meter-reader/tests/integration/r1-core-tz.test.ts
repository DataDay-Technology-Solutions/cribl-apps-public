// tests/integration/r1-core-tz.test.ts — founder-build r1 core-2 (FINDINGS_R1 B1: #1, #8, #16, #41; contract C1').
//
// A fresh install (prices only, no settings document) used to bucket Today, MTD and the trend in UTC while every
// screen labelled them in the browser's zone: a Chicago evening read a UTC "today" and a trend day that had not
// happened yet, a Los Angeles month end read "$15.71 month to date" over 90 minutes, and the first settings save
// relabelled the totals instead of re-bucketing them. Now the sweep takes `defaultTimeZone` (the tab passes the
// browser's zone; the runner and the existing tests keep 'UTC'), the totals record the zone they were bucketed in
// (`TotalsDoc.zone`, exposed as `Snapshot.zone`), and a zone change re-buckets the current month from the rollups.
// Seeded from AA/r1/resilience/zz-res.test.ts test A.

import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../core/types.ts';
import { defaultSettings } from '../../core/settings.ts';
import { localDayKey, localMidnightMs, localMonthKey, localMonthStartMs } from '../../core/time.ts';
import { buildReportCard } from '../../core/report.ts';
import { en } from '../../src/copy/en.ts';
import { DAY, HOUR, MINUTE, createWorld, rigPrices, type World } from './harness.ts';

/** Every stored minute row, as [t ms, savedM] pairs summed over flows, keyed by minute. */
async function minuteMoney(w: World): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const keys = (await w.kv.list('roll/min/')).filter((k) => !/\/c\/\d+$/.test(k));
  for (const k of keys) {
    const doc = await w.docs.getRollMinute(k);
    for (const rows of Object.values(doc?.flows ?? {}))
      for (const r of rows) {
        const t = Date.parse(r.t);
        out.set(t, (out.get(t) ?? 0) + r.savedM);
      }
  }
  return out;
}

/** Saved and minutes metered in [fromMs, toMs) by the stored minute rows (every rig minute has traffic). */
async function recompute(w: World, fromMs: number, toMs = Number.POSITIVE_INFINITY): Promise<{ savedM: number; minutes: number }> {
  let savedM = 0;
  let minutes = 0;
  for (const [t, s] of await minuteMoney(w)) {
    if (t < fromMs || t >= toMs) continue;
    savedM += s;
    minutes++;
  }
  return { savedM, minutes };
}

async function freshInstall(startMs: number, defaultTimeZone?: string): Promise<World> {
  const w = await createWorld({ start: startMs, bare: true, sweep: { firstRunReachMs: undefined, ...(defaultTimeZone ? { defaultTimeZone } : {}) } });
  // Settings → Prices → Start the meter: the prices document only (no settings document), priced from the first sweep.
  await w.docs.putPrices(rigPrices(startMs - 2 * DAY));
  return w;
}

const snap = async (w: World): Promise<Snapshot> => (await w.docs.getSnapshot()) as Snapshot;
const dayKeys = async (w: World): Promise<string[]> => Object.keys((await w.docs.getTotals())?.byDay ?? {}).sort();

describe("core-2 · a fresh install buckets in the member's zone (C1')", () => {
  it("(a) Chicago at 7:31 PM: Today counts from Chicago's midnight, and no trend day is in the future", async () => {
    const start = Date.UTC(2026, 8, 29, 0, 31, 20); // Mon 28 Sep, 7:31 PM CDT
    const zone = 'America/Chicago';
    const w = await freshInstall(start, zone);
    const first = await w.sweep('ui');
    expect(first.error).toBeUndefined();
    await w.sweepMinutes(2);
    const s = await snap(w);
    expect(s.zone).toBe(zone);
    expect((await w.docs.getTotals())?.zone).toBe(zone);
    const today = localDayKey(w.now(), zone);
    expect(today).toBe('2026-09-28');
    for (const k of await dayKeys(w)) expect(k <= today, `byDay ${k}`).toBe(true);
    for (const p of s.trend) expect(p.day <= today, `trend ${p.day}`).toBe(true);
    const since = await recompute(w, localMidnightMs(w.now(), zone));
    expect(s.headline.todayM).toBe(since.savedM);
    expect(s.headline.minutesToday).toBe(since.minutes);
    // Never more minutes than today has held since Chicago's midnight (7:33 PM after the two extra sweeps).
    expect(s.headline.minutesToday).toBeLessThanOrEqual(Math.floor((w.now() - localMidnightMs(w.now(), zone)) / MINUTE));
  }, 120_000);

  it('(b) Sep 30, 6:30 PM PDT: month to date holds the whole metered day, not the 90 minutes since UTC midnight', async () => {
    const start = Date.UTC(2026, 9, 1, 1, 30, 20); // Wed 30 Sep, 6:30 PM PDT = 1 Oct 01:30Z
    const zone = 'America/Los_Angeles';
    const w = await freshInstall(start, zone);
    await w.sweep('ui');
    await w.sweepMinutes(1);
    const s = await snap(w);
    expect(s.zone).toBe(zone);
    expect(localMonthKey(w.now(), zone)).toBe('2026-09');
    const month = await recompute(w, localMonthStartMs(w.now(), zone));
    const all = await recompute(w, 0);
    expect(month).toEqual(all); // every metered minute is in September, Pacific time
    expect(s.headline.mtdM).toBe(all.savedM);
    expect(s.headline.minutesMtd).toBe(all.minutes);
    expect(all.minutes).toBeGreaterThan(20 * 60); // the first run reached back a day
    for (const k of await dayKeys(w)) expect(k.startsWith('2026-10'), `byDay ${k}`).toBe(false);
  }, 120_000);

  it('control: with no defaultTimeZone (the runner, the existing tests) a settings-less workspace still buckets in UTC', async () => {
    const start = Date.UTC(2026, 9, 1, 1, 30, 20);
    const w = await freshInstall(start);
    await w.sweep('ui');
    const s = await snap(w);
    expect(s.zone).toBe('UTC');
    expect(localMonthKey(w.now(), 'UTC')).toBe('2026-10');
    expect(s.headline.minutesMtd).toBe((await recompute(w, Date.UTC(2026, 9, 1))).minutes);
  }, 120_000);

  for (const how of ['the member saves settings (displayTimezone)', 'the tab passes its zone (no settings document)'] as const) {
    it(`(c) a mid-day switch from UTC to New York, when ${how}: Today and MTD match the recompute; MTD minutes never fall`, async () => {
      const zone = 'America/New_York';
      const w = await freshInstall(Date.UTC(2026, 8, 28, 15, 0, 20)); // 11:00 AM EDT, metered in UTC so far
      await w.sweep('ui');
      const utc = await w.sweepMinutes(5);
      for (const r of utc) expect(r.error).toBeUndefined();
      const before = await snap(w);
      expect(before.zone).toBe('UTC');
      const allBefore = await recompute(w, 0);
      const sumDays = async (): Promise<number> => Object.values((await w.docs.getTotals())!.byDay).reduce((a, d) => a + d.savedM, 0);
      expect(await sumDays()).toBe(allBefore.savedM);

      if (how === 'the member saves settings (displayTimezone)') {
        await w.docs.putSettings(defaultSettings(new Date(w.now()).toISOString(), zone));
      } else {
        w.deps.defaultTimeZone = zone;
      }
      let prevMinutes = before.headline.minutesMtd ?? 0;
      for (let i = 0; i < 4; i++) {
        const [r] = await w.sweepMinutes(1);
        expect(r.error).toBeUndefined();
        const s = await snap(w);
        expect(s.zone).toBe(zone);
        const today = await recompute(w, localMidnightMs(w.now(), zone));
        const mtd = await recompute(w, localMonthStartMs(w.now(), zone));
        expect(s.headline.todayM, `sweep ${i} todayM`).toBe(today.savedM);
        expect(s.headline.minutesToday, `sweep ${i} minutesToday`).toBe(today.minutes);
        expect(s.headline.mtdM, `sweep ${i} mtdM`).toBe(mtd.savedM);
        expect(s.headline.minutesMtd, `sweep ${i} minutesMtd`).toBe(mtd.minutes);
        expect(s.headline.minutesMtd!, `sweep ${i} never decreases`).toBeGreaterThanOrEqual(prevMinutes);
        prevMinutes = s.headline.minutesMtd!;
        // Every minute is counted once, in New York days only: the day keys are yesterday and today, local.
        expect(await sumDays()).toBe((await recompute(w, 0)).savedM);
        expect(await dayKeys(w)).toEqual(['2026-09-27', '2026-09-28']);
        expect(s.trend.map((p) => p.day)).toEqual(['2026-09-27', '2026-09-28']);
      }
    }, 120_000);
  }

  it('the Report method line names the zone the figures were bucketed in (snapshot.zone), not the viewer\'s', async () => {
    const w = await freshInstall(Date.UTC(2026, 8, 28, 15, 0, 20));
    await w.sweep('ui');
    const s = await snap(w);
    expect(s.zone).toBe('UTC');
    const card = buildReportCard({
      snapshot: s,
      prices: await w.docs.getPrices(),
      settings: { humanize: {} },
      period: { kind: 'mtd' },
      nowMs: w.now(),
      tz: 'America/Los_Angeles',
      copy: en.report.doc,
      source: 'live',
      appVersion: 'v1.1.1',
    });
    expect(card.methodology[0]).toContain('(UTC)');
    expect(card.methodology[0]).not.toContain('Los_Angeles');
    // A snapshot from before zones were recorded keeps the viewer's zone.
    const legacy = buildReportCard({ ...{ snapshot: { ...s, zone: undefined }, prices: null, settings: { humanize: {} }, period: { kind: 'mtd' as const }, nowMs: w.now(), tz: 'America/Los_Angeles', copy: en.report.doc, source: 'live' as const, appVersion: 'v1.1.1' } });
    expect(legacy.methodology[0]).toContain('America/Los_Angeles');
  }, 120_000);

  it('keeps HOUR and MINUTE honest (sanity for the fixture clock)', () => {
    expect(HOUR).toBe(60 * MINUTE);
  });
});
