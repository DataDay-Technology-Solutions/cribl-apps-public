// tests/unit/sweep-cheap-check.test.ts — the cheap check in every mode, without losing delivery ownership
// (EPIC_AUDIT P1-E05).
//
// The runner sweeps at :25 past each minute; an open tab ticks every 30 s at its own phase. Whenever the tab
// metered the minute first, the runner used to spend a full ~22-call sweep that metered nothing (41 of 754
// sweeps on the demo org). Now a scheduled sweep reads meta first and stops ('current') like the tab does —
// but the tab must keep leaving alerts to the runner (a tab on a Standard plan cannot post a direct webhook),
// so the runner checks in (one meta write) when a tab metered the minute, and a tab that deferred something
// to deliver says so in meta: the runner then sweeps in full and delivers it.

import { describe, expect, it } from 'vitest';
import { deliveryOwnedElsewhere } from '../../core/sweep.ts';
import { runnerSweepAt } from '../../src/state/selectors.ts';
import { MINUTE, createWorld, type World } from '../integration/harness.ts';

const RUNNER = { runtime: 'backend' as const, owner: 'runner:test-host:4242' };

/** The next minute boundary + 20 s: the tab's tick, first past the settle. */
const tabTick = (w: World): void => w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 20_000);
const deferredLogs = (w: World): number => w.logs.filter((l) => /a runner or backend swept in the last 90 s/.test(l.msg)).length;

describe('P1-E05 — the cheap check runs in every mode', () => {
  it("a scheduled runner sweep after a tab metered the same minute makes <= 2 calls and returns 'current'", async () => {
    const w = await createWorld();
    await w.sweep(); // the tab seeds and meters through the last settled minute
    tabTick(w);
    const tab = await w.sweep('ui');
    expect(tab.minutesProcessed).toBe(1);
    const before = (await w.meta())!;
    w.advance(5_000); // the runner's :25
    const r = await w.sweep('scheduled', RUNNER);
    expect(r.skipped).toBe('current');
    expect(r.calls).toBeLessThanOrEqual(2);
    expect(r.error).toBeUndefined();
    const after = (await w.meta())!;
    // The runner checked in; who metered the minute, and the cursor, are untouched.
    expect(after.deliveryOwner).toBe(RUNNER.owner);
    expect(after.deliveryOwnerAt).toBe(new Date(w.now()).toISOString());
    expect(after.lastSweepOwner).toBe('tab-a');
    expect(after.meteredThrough).toBe(before.meteredThrough);
    expect(after.sweepCount).toBe(before.sweepCount);
    // The result carries meta, so the runner can still decide the Monday receipt on a skipped minute.
    expect(r.meta?.meteredThrough).toBe(before.meteredThrough);
  });

  it('a runner that metered the minute itself skips a repeat with one call and writes nothing', async () => {
    const w = await createWorld();
    await w.sweep('scheduled', RUNNER);
    const before = (await w.meta())!;
    w.advance(10_000);
    const r = await w.sweep('scheduled', RUNNER);
    expect(r.skipped).toBe('current');
    expect(r.calls).toBe(1);
    expect(await w.meta()).toEqual(before);
  });

  it('a tab keeps leaving delivery to a runner that only checks in, minute after minute', async () => {
    const w = await createWorld();
    await w.sweep('scheduled', RUNNER); // the runner meters first: it owns delivery
    for (let i = 0; i < 6; i++) {
      tabTick(w);
      const logsBefore = deferredLogs(w);
      const tab = await w.sweep('ui');
      expect(tab.minutesProcessed).toBe(1);
      expect(deferredLogs(w), `tab sweep ${i} deferred`).toBe(logsBefore + 1);
      const meta = (await w.meta())!;
      expect(deliveryOwnedElsewhere(meta, 'tab-a', w.now())).toBe(true);
      w.advance(5_000);
      const runner = await w.sweep('scheduled', RUNNER);
      expect(runner.skipped).toBe('current');
      expect(runner.calls).toBeLessThanOrEqual(2);
    }
  });

  it('when the tab deferred an alert, the runner sweeps in full the same minute and delivers it', async () => {
    const w = await createWorld();
    await w.sweep('scheduled', RUNNER);
    w.em.control({ action: 'breakTrim', minutesAgo: 1 });
    let delivered = false;
    for (let i = 0; i < 10 && !delivered; i++) {
      tabTick(w);
      const tab = await w.sweep('ui');
      expect(tab.notified).toBe(0); // the tab never sends while the runner owns delivery
      const meta = (await w.meta())!;
      const open = (tab.snapshot?.incidents ?? []).filter((x) => !x.closedAt);
      if (open.length === 0) {
        expect(meta.deliveryDeferredAt).toBeUndefined();
        continue;
      }
      // Something to deliver was left to the runner: meta says so, and the runner does not skip.
      expect(meta.deliveryDeferredAt).toBe(new Date(w.now()).toISOString());
      w.advance(5_000);
      const runner = await w.sweep('scheduled', RUNNER);
      expect(runner.skipped).toBeUndefined();
      expect(runner.minutesProcessed).toBe(0);
      expect(runner.notified).toBeGreaterThanOrEqual(1);
      const incident = runner.snapshot!.incidents.find((x) => x.id === open[0].id)!;
      expect(incident.lastNotifiedAt).toBeDefined();
      expect(incident.deliveries?.some((d) => d.endpointId === 'ep_sink' && d.status >= 200 && d.status < 300)).toBe(true);
      // The runner's own sweep clears the flag.
      expect((await w.meta())!.deliveryDeferredAt).toBeUndefined();
      delivered = true;
    }
    expect(delivered).toBe(true);
  });

  it("Sweep now never takes the cheap exit, in any runtime", async () => {
    const w = await createWorld();
    await w.sweep('scheduled', RUNNER);
    w.advance(10_000);
    const manual = await w.sweep('manual', RUNNER);
    expect(manual.skipped).toBeUndefined();
    expect(manual.calls).toBeGreaterThan(2);
    expect((await w.meta())!.lastSweepMode).toBe('manual');
  });

  it('a tab stops deferring once the runner neither sweeps nor checks in for 90 s', async () => {
    const w = await createWorld();
    await w.sweep('scheduled', RUNNER);
    tabTick(w);
    await w.sweep('ui'); // deferred: the runner swept 60 s ago
    w.advance(5_000);
    await w.sweep('scheduled', RUNNER); // checks in
    tabTick(w);
    tabTick(w); // the runner missed a minute: its check-in is 115 s old
    const logsBefore = deferredLogs(w);
    await w.sweep('ui');
    expect(deferredLogs(w)).toBe(logsBefore);
    expect(deliveryOwnedElsewhere((await w.meta())!, 'tab-a', w.now())).toBe(false);
  });

  it("the App counts a runner's check-in as a live runner (selectors.runnerSweepAt), whoever metered the minute", () => {
    const swept = '2026-09-28T15:00:25.000Z';
    const checked = '2026-09-28T15:01:25.000Z';
    expect(runnerSweepAt({ lastSweepOwner: 'ui:tab-a', lastSweepAt: '2026-09-28T15:01:21.000Z', deliveryOwner: 'runner:mac:1', deliveryOwnerAt: checked })).toBe(Date.parse(checked));
    expect(runnerSweepAt({ lastSweepOwner: 'runner:mac:1', lastSweepAt: swept, deliveryOwner: 'runner:mac:1', deliveryOwnerAt: checked })).toBe(Date.parse(checked));
    expect(runnerSweepAt({ lastSweepOwner: 'runner:mac:1', lastSweepAt: checked, deliveryOwner: 'runner:mac:1', deliveryOwnerAt: swept })).toBe(Date.parse(checked));
    // The App backend delivers too, but it is not "the runner" on screen.
    expect(runnerSweepAt({ lastSweepOwner: 'ui:tab-a', lastSweepAt: swept, deliveryOwner: 'backend:meter', deliveryOwnerAt: checked })).toBeUndefined();
    expect(runnerSweepAt({ deliveryOwner: 'runner:mac:1' })).toBeUndefined();
  });
});
