// r1 ui-7 (FINDINGS_R1 M3, #17; seeded from AA/r1/money-truth/skeptic1-f17/repro17.ts): the tour's weekly receipt is
// built from the same rebased hour rows a Custom range over its week sums (core/sampleRollups.ts), so the two agree to
// the millicent on every weekday the tour is opened. The receipt used to relabel the recorded week while the history
// moved by the rebase's dayShift: they agreed only when dayShift % 7 was 0 ($177,198 against $169,768).

import { describe, expect, it } from 'vitest';
import doc from '../../demo/sample/tour.json';
import type { Snapshot } from '../../core/types.ts';
import { sampleRollups } from '../../core/sampleRollups.ts';
import { humanize } from '../../core/humanize.ts';
import type { TourFixture } from '../../src/tour/types.ts';
import { planRebase, rebaseHeadline, rebaseValue } from '../../src/tour/rebase.ts';
import { weeklyReceiptAt } from '../../src/tour/engine.ts';

const TOUR = doc as unknown as TourFixture;
const TZ = 'America/Chicago';
const DAY = 86_400_000;

function shownAt(nowMs: number): Snapshot {
  const zone = TOUR.timezone || TZ;
  const plan = planRebase(Date.parse(TOUR.anchor ?? TOUR.generatedAt), nowMs, zone);
  const moved = rebaseValue(TOUR.snapshot, plan);
  return plan.dayShift === 0 ? moved : rebaseHeadline(moved, zone, TOUR.settings.criblCostCentsPerMonth);
}

/** What a Custom range over [from, to) sums on the sample: its hour rows (the Receipt's range reader, P2-W05). */
function rangeSum(snapshot: Snapshot, fromMs: number, toMs: number) {
  const r = sampleRollups(snapshot, TZ);
  const out = { savedM: 0, whpM: 0, paidM: 0 };
  const byPipeline = new Map<string, number>();
  for (const key of r.keys().hour) {
    for (const [fk, rows] of Object.entries(r.hourDoc(key)?.flows ?? {})) {
      for (const row of rows) {
        const t = Date.parse(row.t);
        if (t < fromMs || t >= toMs) continue;
        out.savedM += row.savedM;
        out.whpM += row.whpM;
        out.paidM += row.paidM;
        const pipeline = fk.split('|')[3] ?? fk;
        byPipeline.set(pipeline, (byPipeline.get(pipeline) ?? 0) + row.savedM);
      }
    }
  }
  const top = [...byPipeline.entries()].sort((a, b) => b[1] - a[1])[0];
  return { ...out, topPipeline: top?.[0] };
}

describe('the tour weekly receipt is the range sum over its own week (M3)', () => {
  for (let dayShift = 0; dayShift <= 6; dayShift++) {
    it(`dayShift ${dayShift}: saved, would have paid, paid and the top line equal a Custom range over the same week`, () => {
      const nowMs = Date.parse('2026-09-28T15:00:00Z') + dayShift * DAY;
      const snapshot = shownAt(nowMs);
      const receipt = weeklyReceiptAt(TOUR.weeklyReceipt, nowMs, TZ, { snapshot, labels: TOUR.settings.humanize })!;
      const sum = rangeSum(snapshot, Date.parse(receipt.periodStart), Date.parse(receipt.periodEnd));
      expect(sum.whpM).toBeGreaterThan(0);
      expect(receipt.savedM).toBe(sum.savedM);
      expect(receipt.whpM).toBe(sum.whpM);
      expect(receipt.paidM).toBe(sum.paidM);
      expect(receipt.lines[0].label).toBe(humanize(sum.topPipeline!, TOUR.settings.humanize));
      // The recording's open alerts still travel with it (the tour's receipt names the open spike).
      expect(receipt.openIncidents).toEqual(TOUR.weeklyReceipt!.openIncidents);
    });
  }

  it('without a history it relabels the recording, as before', () => {
    const r = weeklyReceiptAt(TOUR.weeklyReceipt, Date.parse('2026-10-14T15:00:00Z'), TZ)!;
    expect(r.savedM).toBe(TOUR.weeklyReceipt!.savedM);
    expect(r.label).toBe('Oct 5–11, 2026');
  });
});
