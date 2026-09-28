// tests/integration/route-history.test.ts — 'Thin ribbon after Apply' (stage-critical).
//
// Apply the pack points a demo route at its pack pipeline. The FlowKey includes the pipeline, so the route
// continues under a new key; before the fix its hourly projections restarted from a minute or two of
// history and the Flow ribbon read a few GB/day instead of the route's real volume for up to an hour.
// The end-to-end path here is the real one: emulated org, real sweep, real lever, real snapshot.

import { describe, expect, it } from 'vitest';
import type { FlowFigures, Snapshot } from '../../core/types.ts';
import { applyPack, revertPack } from '../../core/demo/levers.ts';
import { createWorld } from './harness.ts';

const RAW = 'default|mrd_windows_workstations|mrd_windows_workstations|mrd_passthrough|mrd_siem_prod';
const PACK = 'default|mrd_windows_workstations|mrd_windows_workstations|mrd_win_xml_pack|mrd_siem_prod';
const ROUTE = 'route:default:mrd_windows_workstations';

const flowOf = (s: Snapshot | undefined, key: string): FlowFigures => {
  const f = s?.flows.find((x) => x.key === key);
  if (!f) throw new Error(`flow ${key} not in the snapshot (flows: ${s?.flows.map((x) => x.key).join(', ')})`);
  return f;
};
const within = (actual: number, expected: number, tolerance: number) => {
  expect(expected).toBeGreaterThan(0);
  expect(Math.abs(actual - expected) / expected).toBeLessThan(tolerance);
};

describe('a route keeps its hour of history across Apply the pack', () => {
  it('keeps per-day volume, would-have-paid and the sparkline history right after the swap', async () => {
    const w = await createWorld();
    await w.sweep(); // seeds the last hour
    const [warm] = await w.sweepMinutes(1);
    const before = flowOf(warm.snapshot, RAW);
    expect(before.inBPerDay).toBeGreaterThan(0);

    w.advance(5_000);
    expect((await applyPack(w.lever, { routeId: 'mrd_windows_workstations' })).ok).toBe(true);
    const [first, second] = await w.sweepMinutes(2);
    for (const r of [first, second]) {
      const s = r.snapshot;
      expect(s?.flows.some((f) => f.key === RAW)).toBe(false); // the old key is history now, not a flow
      const after = flowOf(s, PACK);
      // The route's traffic did not change, only its pipeline: volume and would-have-paid per day hold.
      within(after.inBPerDay, before.inBPerDay, 0.15);
      within(after.whpPerDayM, before.whpPerDayM, 0.15);
      // The sparkline spans the route's history (the passthrough minutes are in it, not 1–2 points).
      expect(after.sparkline.length).toBe(30);
      expect(after.sparkline[0]).toBeLessThan(0.05);
    }
    // Once a whole minute ran through the pack, the last minute is the pack's own: it now saves, and the
    // route is a top saver with an hour's worth of volume behind it.
    const settled = flowOf(second.snapshot, PACK);
    expect(settled.ratio).toBeGreaterThan(0.2);
    expect(settled.sparkline[29]).toBeGreaterThan(0.2);
    expect(second.snapshot?.topSavers.some((t) => t.objectKey === ROUTE)).toBe(true);
    const siem = (s: Snapshot | undefined) => s?.destinations.find((d) => d.outputId === 'mrd_siem_prod')?.whpPerDayM ?? 0;
    within(siem(second.snapshot), siem(warm.snapshot), 0.15);
  });

  it('keeps the pack minutes in the hour after Revert', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(1);
    w.advance(5_000);
    expect((await applyPack(w.lever, { routeId: 'mrd_windows_workstations' })).ok).toBe(true);
    const packed = await w.sweepMinutes(3);
    const packFlow = flowOf(packed[2].snapshot, PACK);
    w.advance(5_000);
    expect((await revertPack(w.lever, { routeId: 'mrd_windows_workstations' })).ok).toBe(true);
    const [reverted] = await w.sweepMinutes(1);
    const raw = flowOf(reverted.snapshot, RAW);
    within(raw.inBPerDay, packFlow.inBPerDay, 0.15);
    // The pack's saving minutes stay visible in the restored route's sparkline.
    expect(raw.sparkline.some((v) => v > 0.2)).toBe(true);
    expect(raw.savedPerDayM).toBeGreaterThan(0);
  });
});
