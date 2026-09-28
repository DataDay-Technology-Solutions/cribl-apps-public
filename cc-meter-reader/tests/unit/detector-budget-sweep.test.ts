// tests/unit/detector-budget-sweep.test.ts — P0-17 end to end: the sweep hands the detector the minutes metered this
// month, so budget pace projects over what was actually metered (not the wall clock since the 1st), and the
// detector, the snapshot's destination figures and Settings → Budgets all read the same percentage.
// Drives runSweep() against the emulated org (tests/integration/harness.ts).

import { describe, expect, it } from 'vitest';
import type { Settings } from '../../core/types.ts';
import { meteredMinutesInMonth } from '../../core/pricing.ts';
import { minutesInMonth } from '../../core/time.ts';
import { budgetPace as settingsBudgetPace } from '../../src/views/Settings/model.ts';
import { T0, createWorld } from '../integration/harness.ts';

const SIEM = 'mrd_siem_prod';

async function firstSweepPaid(): Promise<{ paidM: number; minutes: number }> {
  const w = await createWorld();
  const r = await w.sweep();
  expect(r.error).toBeUndefined();
  const totals = (await w.docs.getTotals())!;
  return { paidM: totals.byOutputMonth!['2026-09'][`default:${SIEM}`].paidM, minutes: meteredMinutesInMonth(totals, '2026-09') };
}

describe('P0-17: the sweep projects budget pace over the minutes it metered', () => {
  it('a fresh install 27 days into the month projects its real pace (the old wall-clock basis read ~0.2 %)', async () => {
    // World 1 learns what the rig's first hour costs at siem-prod; world 2 budgets it so the real pace is 150 %.
    const { paidM, minutes } = await firstSweepPaid();
    expect(minutes).toBeGreaterThanOrEqual(60);
    const monthMin = minutesInMonth(T0, 'UTC');
    const realProjectedM = (paidM / minutes) * monthMin;
    const budgetCents = Math.round(realProjectedM / 1.5 / 1000);

    const w = await createWorld({ settings: (s: Settings) => void (s.budgets = { [SIEM]: { centsPerMonth: budgetCents } }) });
    const r = await w.sweep();
    const inc = (r.snapshot?.incidents ?? []).find((i) => i.type === 'budget');
    // The demo profile (the harness default) judges every minute of the backfilled hour, so the incident opens
    // and escalates to high as the metered pace crosses 90 % and 100 %; `after` is the reading it escalated on
    // (a minute or two before the end of the hour). The wall-clock basis read ~0.2 % and opened nothing.
    expect(inc, 'a budget incident at the metered pace').toBeDefined();
    expect(inc!).toMatchObject({ severity: 'high', before: 100 });
    expect(inc!.after).toBeGreaterThan(140);
    expect(inc!.after).toBeLessThan(160);
    const dest = r.snapshot!.destinations.find((d) => d.outputId === SIEM)!;
    expect(dest.mtdMinutes).toBe(minutes);
    expect(dest.budget!.pct).toBeCloseTo(150, 0);
    // Settings → Budgets reads the same destination figures and shows the same percentage as the snapshot.
    const settings = settingsBudgetPace(dest, budgetCents, T0, 'UTC', { budgetWarnPct: 90, budgetAlertPct: 100 })!;
    expect(Math.round(settings.ratio! * 100)).toBe(Math.round(dest.budget!.pct));
    expect(settings.level).toBe('alert');
  });

  it('outside the demo profile the same first hour opens nothing (a day of metering comes first)', async () => {
    const { paidM, minutes } = await firstSweepPaid();
    const budgetCents = Math.round((paidM / minutes) * minutesInMonth(T0, 'UTC') / 3 / 1000); // a 300 % pace
    const w = await createWorld({
      settings: (s: Settings) => {
        s.demo = { enabled: false, replayMode: false, profile: false };
        s.budgets = { [SIEM]: { centsPerMonth: budgetCents } };
      },
    });
    const r = await w.sweep();
    expect((r.snapshot?.incidents ?? []).filter((i) => i.type === 'budget')).toEqual([]);
    // The projection itself is still the real pace (shown in Settings → Budgets with its basis).
    expect(r.snapshot!.destinations.find((d) => d.outputId === SIEM)!.budget!.pct).toBeCloseTo(300, 0);
  });
});
