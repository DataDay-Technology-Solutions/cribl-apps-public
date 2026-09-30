// tests/unit/r1-core-rezone.test.ts — founder-build r1 core-2: core/rezone.ts on its own (pure). Every minute is
// counted exactly once after a zone change (money to the millicent, minutes to the minute), no day or month that has
// not begun in the new zone keeps a key, a non-whole-hour offset splits an hour at its minutes, and an old day whose
// rows are missing keeps its money in its largest piece rather than losing it.

import { describe, expect, it } from 'vitest';
import type { TotalsDoc } from '../../core/types.ts';
import { meteredMinutes, rezonePlan, rezoneTotals, type MoneyBucket } from '../../core/rezone.ts';
import { localDayKey, localMonthKey } from '../../core/time.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const OUT = 'default:mrd_siem_prod';

/** One minute bucket per metered minute in [from, to): $1 would-have-paid, 40 ¢ paid, 60 ¢ saved each. */
function minutes(from: number, to: number): MoneyBucket[] {
  const out: MoneyBucket[] = [];
  for (let t = from; t < to; t += MIN) {
    const m = { whpM: 100_000, paidM: 40_000, savedM: 60_000 };
    out.push({ startMs: t, spanMs: MIN, total: { ...m }, byOutput: { [OUT]: { ...m } } });
  }
  return out;
}

/** The totals an old build kept in `zone` for those buckets (one minute each). */
function totalsIn(zone: string, buckets: MoneyBucket[]): TotalsDoc {
  const byDay: TotalsDoc['byDay'] = {};
  const byOutputMonth: NonNullable<TotalsDoc['byOutputMonth']> = {};
  for (const b of buckets) {
    const k = localDayKey(b.startMs, zone);
    const d = (byDay[k] ??= { whpM: 0, paidM: 0, savedM: 0, minutes: 0 });
    d.whpM += b.total.whpM;
    d.paidM += b.total.paidM;
    d.savedM += b.total.savedM;
    d.minutes += 1;
    const mk = localMonthKey(b.startMs, zone);
    const o = ((byOutputMonth[mk] ??= {})[OUT] ??= { whpM: 0, paidM: 0, savedM: 0 });
    o.whpM += b.total.whpM;
    o.paidM += b.total.paidM;
    o.savedM += b.total.savedM;
  }
  return { schemaVersion: 1, updatedAt: '', byDay, byOutputMonth };
}

const sum = (t: TotalsDoc) =>
  Object.values(t.byDay).reduce((a, d) => ({ savedM: a.savedM + d.savedM, whpM: a.whpM + d.whpM, paidM: a.paidM + d.paidM, minutes: a.minutes + d.minutes }), { savedM: 0, whpM: 0, paidM: 0, minutes: 0 });

describe('core/rezone.ts', () => {
  it('UTC → New York at 10:02 PM on Sep 30 (Oct 1 02:02Z): no October key survives; September holds every minute', () => {
    const since = Date.UTC(2026, 8, 29, 12, 0);
    const end = Date.UTC(2026, 9, 1, 2, 2);
    const buckets = minutes(since, end);
    const old = totalsIn('UTC', buckets);
    expect(Object.keys(old.byDay)).toContain('2026-10-01');
    const plan = rezonePlan('UTC', 'America/New_York', end + 20_000, end, since)!;
    const t = rezoneTotals(old, plan, { buckets, collectingSinceMs: since });
    expect(t.zone).toBe('America/New_York');
    expect(Object.keys(t.byDay).sort()).toEqual(['2026-09-29', '2026-09-30']);
    expect(sum(t)).toEqual(sum(old));
    // Each New York day holds exactly its own minutes.
    const ny = totalsIn('America/New_York', buckets);
    expect(t.byDay).toEqual(ny.byDay);
    expect(Object.keys(t.byOutputMonth!)).toEqual(['2026-09']);
    expect(t.byOutputMonth!['2026-09'][OUT]).toEqual(ny.byOutputMonth!['2026-09'][OUT]);
  });

  it('New York → UTC on the same night: the day and month that began in UTC get their minutes', () => {
    const since = Date.UTC(2026, 8, 29, 12, 0);
    const end = Date.UTC(2026, 9, 1, 2, 2);
    const buckets = minutes(since, end);
    const old = totalsIn('America/New_York', buckets);
    const plan = rezonePlan('America/New_York', 'UTC', end + 20_000, end, since)!;
    const t = rezoneTotals(old, plan, { buckets, collectingSinceMs: since });
    const utc = totalsIn('UTC', buckets);
    expect(t.byDay).toEqual(utc.byDay);
    expect(t.byOutputMonth!['2026-10'][OUT]).toEqual(utc.byOutputMonth!['2026-10'][OUT]);
    expect(t.byOutputMonth!['2026-09']).toEqual(old.byOutputMonth!['2026-09']); // an earlier month is kept as it was
  });

  it('a non-whole-hour offset (UTC → Asia/Kolkata, +5:30) splits the hour at its minutes', () => {
    const since = Date.UTC(2026, 8, 27, 10, 0);
    const end = Date.UTC(2026, 8, 28, 20, 45);
    const buckets = minutes(since, end);
    const old = totalsIn('UTC', buckets);
    const plan = rezonePlan('UTC', 'Asia/Kolkata', end + 20_000, end, since)!;
    const t = rezoneTotals(old, plan, { buckets, collectingSinceMs: since });
    expect(t.byDay).toEqual(totalsIn('Asia/Kolkata', buckets).byDay);
  });

  it('hour rows split by time where no minute rows are held; the old day stays exact', () => {
    const since = Date.UTC(2026, 8, 27, 10, 0);
    const end = Date.UTC(2026, 8, 28, 20, 45);
    const fine = minutes(since, end);
    const old = totalsIn('UTC', fine);
    // Fold everything into hour buckets (as roll/hour holds it).
    const hours = new Map<number, MoneyBucket>();
    for (const b of fine) {
      const h = Math.floor(b.startMs / HOUR) * HOUR;
      const acc = hours.get(h) ?? { startMs: h, spanMs: HOUR, total: { whpM: 0, paidM: 0, savedM: 0 }, byOutput: { [OUT]: { whpM: 0, paidM: 0, savedM: 0 } } };
      for (const f of ['whpM', 'paidM', 'savedM'] as const) {
        acc.total[f] += b.total[f];
        acc.byOutput[OUT][f] += b.total[f];
      }
      hours.set(h, acc);
    }
    const plan = rezonePlan('UTC', 'Asia/Kolkata', end + 20_000, end, since)!;
    const t = rezoneTotals(old, plan, { buckets: [...hours.values()], collectingSinceMs: since });
    expect(sum(t)).toEqual(sum(old)); // conserved
    expect(t.byDay).toEqual(totalsIn('Asia/Kolkata', fine).byDay); // uniform traffic: the time split is exact too
  });

  it('an old day whose rows are gone keeps its money and minutes, in its largest piece', () => {
    const since = Date.UTC(2026, 8, 20, 0, 0);
    const end = Date.UTC(2026, 8, 28, 15, 0);
    const buckets = minutes(since, end);
    const old = totalsIn('UTC', buckets);
    const lost = buckets.filter((b) => localDayKey(b.startMs, 'UTC') !== '2026-09-24'); // that day's rollups expired
    const plan = rezonePlan('UTC', 'America/Chicago', end + 20_000, end, since)!;
    const t = rezoneTotals(old, plan, { buckets: lost, collectingSinceMs: since });
    expect(sum(t)).toEqual(sum(old));
    // Sep 24 UTC is [Sep 23 19:00, Sep 24 19:00) Chicago: its 19 h piece (Sep 24 local) carries the money it lost.
    expect(t.byDay['2026-09-24'].savedM).toBeGreaterThan(totalsIn('America/Chicago', buckets).byDay['2026-09-24'].savedM);
  });

  it("keeps day keys before the re-bucketing start whole (the month and the trend's 30 days are re-bucketed), and never re-buckets the same zone", () => {
    const since = Date.UTC(2026, 6, 1, 0, 0); // since July: Aug 5 on (the trend's first day, 29 days before Sep 3) is re-bucketed
    const end = Date.UTC(2026, 8, 3, 12, 0);
    const buckets = minutes(since, end);
    const old = totalsIn('UTC', buckets);
    const plan = rezonePlan('UTC', 'America/New_York', end + 20_000, end, since)!;
    expect(new Date(plan.startMs).toISOString()).toBe('2026-08-05T00:00:00.000Z');
    const t = rezoneTotals(old, plan, { buckets, collectingSinceMs: since });
    expect(t.byDay['2026-07-20']).toEqual(old.byDay['2026-07-20']);
    // Aug 4 (UTC) is kept and gains the four hours of Aug 5 before New York's midnight: counted once, nowhere else.
    expect(t.byDay['2026-08-04'].minutes).toBe(old.byDay['2026-08-04'].minutes + 4 * 60);
    const ny = totalsIn('America/New_York', buckets);
    for (const k of ['2026-08-05', '2026-08-31', '2026-09-01', '2026-09-03']) expect(t.byDay[k], k).toEqual(ny.byDay[k]);
    expect(sum(t)).toEqual(sum(old));
    expect(rezonePlan('UTC', 'UTC', end, end, since)).toBeUndefined();
  });

  it('meteredMinutes counts the metered span less the recorded gaps', () => {
    const a = Date.UTC(2026, 8, 28, 0, 0);
    expect(meteredMinutes(a, a + 2 * HOUR, a + 30 * MIN, a + 2 * HOUR)).toBe(90);
    expect(meteredMinutes(a, a + 2 * HOUR, a, a + 2 * HOUR, [{ from: new Date(a + HOUR).toISOString(), to: new Date(a + HOUR + 15 * MIN).toISOString() }])).toBe(105);
    expect(meteredMinutes(a, a + HOUR, a + 2 * HOUR, a + 3 * HOUR)).toBe(0);
  });
});
