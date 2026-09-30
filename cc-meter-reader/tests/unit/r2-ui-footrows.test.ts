// r2 ui-8 (FINDINGS_R2 #9 / #10): one footed-rows selector for Show the math and each destination's statement. The
// drawer footed its month-to-date rows to the sentence under them (r1 ui-8, m10) while the statement footed each row on
// its own, so one destination printed "$287,573 − $200,861" in the drawer and "$287,572 − $200,860" in its statement
// (app-assurance r2/2 zz-r2m-footrows.test.ts, footrows.txt). receipt.spec.ts:944 asserted the per-row footing against
// the footed drawer and failed in 309 of 1,440 minutes (r2/5/foot).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fmtDollars, footMoney, roundToDollarsM } from '../../core/format.ts';
import { destinationRows, footedMonth, footedMtdRows, mathDestinations, mtdReconciliation, periodFigures } from '../../src/views/Receipt/model.ts';
import { LIVE_TZ, TOUR, TOUR_TZ, liveInput } from './report-fixture.ts';

const fixtures = [
  ['tour', TOUR.snapshot, TOUR.prices, TOUR_TZ],
  ['live', liveInput().snapshot, liveInput().prices, LIVE_TZ],
] as const;

describe('r2 ui-8: the drawer and the statement print one month to date per destination', () => {
  for (const [name, snapshot, prices, tz] of fixtures) {
    it(`${name}: every priced destination's statement month equals its Show the math row, and the rows foot`, () => {
      const rows = mathDestinations(destinationRows(snapshot, prices), 'mtd');
      const rec = mtdReconciliation(rows, periodFigures(snapshot, 'mtd', tz).savedM);
      // The tour's rows add up to its hero (footed together, m10); the live fixture's do not (a destination marked as
      // going nowhere): each row is footed on its own, and the statement still reads what the drawer reads.
      expect(rec.matches, `${name} rows add up to the hero`).toBe(name === 'tour');
      const footed = footedMtdRows(rows, rec);
      const priced = rows.filter((r) => !r.unpriced);
      expect(footed.size).toBe(priced.length);
      let whp = 0;
      let paid = 0;
      let saved = 0;
      for (const r of priced) {
        const f = footed.get(r.key)!;
        const month = { whpM: r.mtdWhpM ?? 0, paidM: r.mtdPaidM ?? 0, savedM: r.mtdSavedM ?? 0 };
        // The statement's "This month" from the snapshot's own month: exactly the drawer's row.
        expect(footedMonth(month, month, f), `${name} ${r.label}`).toEqual({ ...month, ...f });
        // Every row of a month that foots reads would have paid − paid = saved, in whole dollars.
        if (rec.matches) expect(f.whpM - f.paidM).toBe(f.savedM);
        whp += f.whpM;
        paid += f.paidM;
        saved += f.savedM;
      }
      if (!rec.matches) {
        for (const r of priced) expect(footed.get(r.key)).toEqual(footMoney({ whpM: r.mtdWhpM ?? 0, paidM: r.mtdPaidM ?? 0, savedM: r.mtdSavedM ?? 0 }));
        return;
      }
      // The columns add up to the sentence under them as printed.
      const total = footMoney({ whpM: rec.whpM, paidM: rec.paidM, savedM: rec.savedM });
      expect(fmtDollars(whp)).toBe(fmtDollars(total.whpM));
      expect(fmtDollars(saved)).toBe(fmtDollars(total.savedM));
      expect(fmtDollars(paid)).toBe(fmtDollars(total.whpM - total.savedM));
    });
  }

  it('a month the statement read from the running totals that differs from the snapshot foots on its own', () => {
    const snap = { whpM: 28_757_249_000, paidM: 20_086_049_000, savedM: 8_671_200_000 };
    const drawer = { whpM: 28_757_300_000, paidM: 20_086_100_000, savedM: 8_671_200_000 };
    const later = { whpM: 28_800_000_000, paidM: 20_100_000_000, savedM: 8_700_000_000 };
    expect(footedMonth(snap, snap, drawer)).toEqual({ ...snap, ...drawer });
    expect(footedMonth(later, snap, drawer)).toEqual({ ...later, ...footMoney(later) });
    expect(footedMonth(undefined, snap, drawer)).toBeUndefined();
    // No drawer figure (the rows don't add up to the hero): footMoney on its own.
    expect(footedMonth(snap, snap, undefined)).toEqual({ ...snap, ...footMoney(snap) });
  });

  it('property: footed rows keep each column\'s printed total and never pay below $0', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ whp: fc.integer({ min: 0, max: 5e10 }), share: fc.double({ min: 0, max: 1, noNaN: true }) }), { minLength: 1, maxLength: 8 }), (raw) => {
        const rows = raw.map((r, i) => {
          const savedM = Math.round(r.whp * r.share);
          return { key: `g:o${i}`, label: `o${i}`, unpriced: false, mtdWhpM: r.whp, mtdPaidM: r.whp - savedM, mtdSavedM: savedM };
        });
        const rec = { whpM: rows.reduce((a, r) => a + r.mtdWhpM, 0), paidM: rows.reduce((a, r) => a + r.mtdPaidM, 0), savedM: rows.reduce((a, r) => a + r.mtdSavedM, 0), gapM: 0, matches: true };
        const footed = [...footedMtdRows(rows, rec).values()];
        // Founder-build r3 core-7 (FINDINGS_R3 #10): a line under a dollar keeps its exact amount ('< $1', never "$0"), so
        // only columns of whole-dollar lines foot to the dollar.
        if (rows.every((r) => [r.mtdWhpM, r.mtdSavedM].every((v) => v === 0 || v >= 100_000))) {
          expect(footed.reduce((a, f) => a + f.whpM, 0)).toBe(roundToDollarsM(rec.whpM));
          expect(footed.reduce((a, f) => a + f.savedM, 0)).toBe(roundToDollarsM(rec.savedM));
        }
        for (const f of footed) expect(f.paidM).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300, seed: 928 },
    );
  });
});
