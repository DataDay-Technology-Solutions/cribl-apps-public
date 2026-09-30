// tests/unit/r1-core-revert-reseed.test.ts — founder-build r1 core-5 (FINDINGS_R1 M5 #26, M6 #27).
//
// M5: "Revert the pack" only postponed the alert. While a pack is held the route's baseline learns the pack's level
// (the good news re-seats it and it re-learns); the revert mutes the route for 10 minutes, the mute stops learning, and
// when it ends the route reads its old passthrough level against the pack's baseline: a HIGH "Savings dropped" that
// credits the presenter's own revert, never closes and re-sends every hour (live: inc_ab6a09). Now Revert (and Revert
// all, which is Revert per route, and Restore) re-seat the touched objects' baselines at the level they held before
// the lever that changed them (recorded by Apply / Break), or forget them so they re-learn — like Accept does.
// M6: Reset everything closed the open demo incidents but left their baselines, so the next sweep re-opened them as
// "cause unknown" (live copies AA/r1/skeptic27a, 02:15Z). Now it re-seats every object whose incident it closes at the
// level it holds (Accept's rule). No detector change.

import { describe, expect, it } from 'vitest';
import type { BaselinesDoc, CriblHttp, Incident, Settings, Snapshot } from '../../core/types.ts';
import { applyPack, breakTrim, emptyDemoState, resetAll, restoreTrim, revertPack, type LeverDeps, type LeverResult } from '../../core/demo/levers.ts';
import { detect } from '../../core/detector.ts';
import { closeDemoIncidents, incidentsDocKey } from '../../core/incidents.ts';
import { createKvDocs, createMemoryKvStore } from '../../core/kv.ts';
import { identityCodec } from '../../core/codec.ts';
import { defaultSettings } from '../../core/settings.ts';
import { MINUTE, createWorld, type World } from '../integration/harness.ts';

const WS_ROUTE = 'route:default:mrd_windows_workstations';
const PAY_PIPE = 'pipe:default:mrd_pay_sample';
const PAY_ROUTE = 'route:default:mrd_payments_api';

const ok = (r: LeverResult): void => {
  if (!r.ok) throw new Error(`lever refused: ${r.error} ${r.message}`);
};
const regressionsOn = (key: string, results: { snapshot?: Snapshot }[], openedAfterMs: number): Incident[] => {
  const seen = new Map<string, Incident>();
  for (const r of results) for (const i of r.snapshot?.incidents ?? []) if (i.type === 'regression' && i.objectKey === key && Date.parse(i.openedAt) >= openedAfterMs) seen.set(i.id, i);
  return [...seen.values()];
};

/** Apply the pack on Windows workstations, hold it `held` minutes, revert, then watch `after` minutes. */
async function applyHoldRevert(held: number, opts: { undoReseed?: boolean; after?: number } = {}): Promise<{ w: World; opened: Incident[]; revertAt: number }> {
  const w = await createWorld();
  await w.sweep(); // the first run learns an hour of passthrough history
  await w.sweepMinutes(2);
  ok(await applyPack(w.lever, { routeId: 'mrd_windows_workstations' }));
  await w.sweepMinutes(held);
  const before = (await w.docs.getBaselines()) as BaselinesDoc;
  const revertAt = w.now();
  ok(await revertPack(w.lever, { routeId: 'mrd_windows_workstations' }));
  // The control: what a revert did before core-5 — the baselines as the pack left them.
  if (opts.undoReseed) await w.docs.putBaselines({ ...before, updatedAt: (await w.docs.getBaselines())!.updatedAt });
  const results = await w.sweepMinutes(opts.after ?? 180);
  return { w, opened: regressionsOn(WS_ROUTE, results, revertAt), revertAt };
}

describe('core-5 · M5: Revert the pack re-seats the route, so the mute never just postpones the alert', () => {
  for (const held of [3, 12, 120]) {
    it(`pack held ${held} min → revert → 180 min at the passthrough level: no incident opens`, async () => {
      const { opened, w } = await applyHoldRevert(held);
      expect(opened).toEqual([]);
      // The route's baseline sits at its pre-pack level (passthrough ≈ 0), warm.
      const b = (await w.docs.getBaselines())!.byObject[WS_ROUTE];
      expect(b.mean).toBeLessThan(0.05);
    }, 120_000);
  }

  for (const held of [12, 120]) {
    it(`control: without the re-seat, a pack held ${held} min opens "Savings dropped" once the mute ends`, async () => {
      const { opened, revertAt } = await applyHoldRevert(held, { undoReseed: true, after: 30 });
      expect(opened.length).toBeGreaterThan(0);
      expect(Date.parse(opened[0].openedAt) - revertAt).toBeGreaterThanOrEqual(10 * MINUTE); // right after the 10-minute mute
    }, 120_000);
  }

  it('Apply records the levels it left; Revert forgets them with the applied state', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(2);
    ok(await applyPack(w.lever, { routeId: 'mrd_windows_workstations' }));
    const st = (await w.docs.getDemoState())!;
    const levels = st.routes['mrd_windows_workstations'].levelsBefore!;
    expect(levels[WS_ROUTE]).toBeLessThan(0.05);
    expect(Object.keys(levels).some((k) => k.startsWith('in:default:mrd_windows_workstations'))).toBe(true);
    ok(await revertPack(w.lever, { routeId: 'mrd_windows_workstations' }));
    expect((await w.docs.getDemoState())!.routes['mrd_windows_workstations']).toBeUndefined();
  }, 120_000);

  it('Break → Restore: the trim regression still closes itself; the pipeline is re-seated at its pre-break level; 120 quiet minutes', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(3);
    // The detector watches the rig's routes (a pipeline object only where one is keyed): the payments route here.
    const pre = (await w.docs.getBaselines())!.byObject[PAY_ROUTE].mean;
    ok(await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' }));
    const broken = await w.sweepMinutes(4);
    const opened = broken.flatMap((r) => r.snapshot?.incidents ?? []).find((i) => i.type === 'regression' && (i.objectKey === PAY_PIPE || i.objectKey === PAY_ROUTE));
    expect(opened).toBeDefined();
    ok(await restoreTrim(w.lever, { pipelineId: 'mrd_pay_sample' }));
    const after = await w.sweepMinutes(120);
    const again = after.flatMap((r) => r.snapshot?.incidents ?? []).filter((i) => i.id === opened!.id);
    expect(again.some((i) => i.closedAt)).toBe(true); // recovered as before (the open incident's rule is untouched)
    expect(regressionsOn(PAY_PIPE, after, w.now() - 120 * MINUTE).filter((i) => i.id !== opened!.id)).toEqual([]);
    expect(regressionsOn(PAY_ROUTE, after, w.now() - 120 * MINUTE).filter((i) => i.id !== opened!.id)).toEqual([]);
    expect(Math.abs((await w.docs.getBaselines())!.byObject[PAY_ROUTE].mean - pre)).toBeLessThan(0.02);
    // Break recorded the level Restore re-seated.
    expect(Object.keys((await w.docs.getDemoState())!.trim)).toEqual([]);
  }, 120_000);
});

// ─── M6: Reset everything, on the live state of 27 Sep 02:15Z (AA/r1/skeptic27a, numbers only) ─────────────────────

const T = Date.parse('2026-09-28T02:16:00Z');
const WHP = { ws: 17_992_944, pan: 13_501_824 };
const PAN_ROUTE = 'route:default:mrd_pan_firewall';

function liveSettings(): Settings {
  const s = defaultSettings('2026-09-27T00:00:00.000Z', 'America/New_York');
  s.demo = { enabled: true, replayMode: false, profile: true };
  return s;
}
function liveBaselines(): BaselinesDoc {
  return {
    schemaVersion: 1,
    updatedAt: '2026-09-28T02:15:25.000Z',
    byObject: {
      [WS_ROUTE]: { mean: 0.33895301822863805, variance: 1.1719220260984594e-5, samples: 115, warm: [] },
      'in:default:mrd_windows_workstations': { mean: 732433.97, variance: 4147861898.35, samples: 734, warm: [] },
      [PAN_ROUTE]: { mean: 0.3444080248018424, variance: 4.320300836012703e-7, samples: 115, warm: [] },
      'in:default:mrd_pan_firewall': { mean: 549219.55, variance: 2417202268.69, samples: 726, warm: [] },
    },
    rules: {
      [`regression|${PAN_ROUTE}`]: { streak: 0, recoveryStreak: 0, frozenBaseline: 0.3444080248018424, firstQualifyingAt: '2026-09-27T16:44:00.000Z' },
      [`regression|${WS_ROUTE}`]: { streak: 0, recoveryStreak: 0, frozenBaseline: 0.33895301822863805, firstQualifyingAt: '2026-09-27T16:55:00.000Z' },
    },
  };
}
function liveIncidents(): Incident[] {
  const base = { type: 'regression' as const, notes: ['demo-profile'], deliveries: [], outputId: 'mrd_siem_prod' };
  return [
    { ...base, id: 'inc_ab6a09', severity: 'high', objectKey: WS_ROUTE, label: 'Windows workstation events', openedAt: '2026-09-27T16:56:25.005Z', cause: 'commit', before: 0.33895301822863805, after: 0, impactPerDayM: 6_099_609, commit: { hash: 'f727f09d7b6e', message: 'demo: revert the pack on mrd_windows_workstations', author: 'Steve Koelpin', committedAt: '2026-09-27T16:46:06.000Z', groupId: 'default', match: 'message' } },
    { ...base, id: 'inc_c5a5ea', severity: 'medium', objectKey: PAN_ROUTE, label: 'Palo Alto firewall', openedAt: '2026-09-27T16:45:25.003Z', cause: 'unknown', before: 0.3444080248018424, after: 0, impactPerDayM: 4_650_004 },
  ];
}

/** The detector, minute by minute on the live ratios (both routes at passthrough, 0), from the stored state. */
function watch(settings: Settings, baselines: BaselinesDoc, open: Incident[], minutes: number): Incident[] {
  let b = baselines;
  let o = open.filter((i) => !i.closedAt);
  const opened: Incident[] = [];
  for (let m = 0; m < minutes; m++) {
    const minuteStartMs = T + m * MINUTE;
    const out = detect({
      nowMs: minuteStartMs + 85_000,
      minuteStartMs,
      settings,
      baselines: b,
      openIncidents: o,
      ratioSeries: {
        [WS_ROUTE]: { x: 0, whpPerDayM: WHP.ws, label: 'Windows workstation events', outputId: 'mrd_siem_prod' },
        [PAN_ROUTE]: { x: 0, whpPerDayM: WHP.pan, label: 'Palo Alto firewall', outputId: 'mrd_siem_prod' },
      },
      costSeries: {},
      budgetSeries: {},
      muted: {},
      commits: [],
      evaluateBudget: false,
    });
    b = out.baselines;
    opened.push(...out.opened);
    const closed = new Set(out.closed.map((c) => c.id));
    o = [...o.filter((i) => !closed.has(i.id)), ...out.opened.filter((i) => !i.closedAt)];
  }
  return opened;
}

describe('core-5 · M6: Reset everything leaves nothing to re-open (live copies, skeptic27a)', () => {
  const noHttp: CriblHttp = { request: async () => ({ ok: false, status: 599, text: 'no Leader call expected' }) };

  it('resetAll closes both stale incidents and re-seats their routes: 120 minutes open nothing', async () => {
    const kv = createMemoryKvStore();
    const clock = { now: () => T };
    const docs = createKvDocs({ kv, codec: identityCodec, clock });
    await docs.putSettings(liveSettings());
    await docs.putBaselines(liveBaselines());
    await docs.putIncidents(incidentsDocKey(Date.parse('2026-09-27T16:56:25Z')), { schemaVersion: 1, items: liveIncidents() });
    await docs.putDemoState(emptyDemoState());
    const deps: LeverDeps = { http: noHttp, kv, clock, codec: identityCodec, author: 'Steve Koelpin', minuteBudget: 10_000, sleep: async () => undefined };
    // resetAll reads today's and yesterday's incident docs: put the live doc under today's key too (2026-09-28 is empty live).
    await docs.putIncidents(incidentsDocKey(T - 86_400_000), { schemaVersion: 1, items: liveIncidents() });
    const r = await resetAll(deps);
    expect(r.ok).toBe(true);
    const items = (await docs.getIncidents(incidentsDocKey(T - 86_400_000)))!.items;
    expect(items.every((i) => i.closedAt)).toBe(true);
    const b = (await docs.getBaselines())!;
    expect(b.byObject[WS_ROUTE].mean).toBe(0);
    expect(b.byObject[PAN_ROUTE].mean).toBe(0);
    expect(b.rules[`regression|${WS_ROUTE}`]).toBeUndefined();
    expect(watch(liveSettings(), b, items, 120)).toEqual([]);
  });

  it('control: closing the incidents alone (the old Reset everything) re-opens both as "cause unknown" at once', () => {
    const closed = closeDemoIncidents(liveIncidents(), new Date(T).toISOString());
    const opened = watch(liveSettings(), liveBaselines(), closed, 10);
    expect(opened.map((i) => [i.objectKey, i.cause])).toEqual([
      [WS_ROUTE, 'unknown'],
      [PAN_ROUTE, 'unknown'],
    ]);
  });
});
