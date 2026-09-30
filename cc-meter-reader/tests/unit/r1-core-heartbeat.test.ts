// tests/unit/r1-core-heartbeat.test.ts — founder-build r1 core-13 (FINDINGS_R1 M7, #28 + #32; code side only). The demo
// webhook receiver answered 429 from 20:59Z on (its free tier's 50 requests used up) while the runner's heartbeat said
// ok:true and runner-health.sh printed OK: nothing watched deliveries. Now the heartbeat carries each endpoint's
// delivery fail-streak (this sweep's final outcome per alert; a 2xx resets it) and `deliveryOk: false` once any endpoint
// has failed DELIVERY_FAIL_STREAK_UNHEALTHY (3) deliveries in a row; runner-health.sh reports FAIL on it and writes a
// state file so it can say when the state changed (OK↔FAIL) — the alert is on the transition, never per poll.
// Nothing here touches the live runner or its host.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeliveryLog } from '../../core/types.ts';
import type { SweepResult } from '../../core/sweep.ts';
import { DELIVERY_FAIL_STREAK_UNHEALTHY, DELIVERY_STREAK_AGE_OUT_REMINDERS, carryDeliveryState, deliveryStreaks, heartbeatFor, type DeliveryStreakState } from '../../scripts/runner.ts';

const NOW = Date.UTC(2026, 8, 28, 2, 0, 25);
const sweep = (attempts: DeliveryLog[] = []): SweepResult => ({ calls: 20, ms: 900, minutesProcessed: 1, backfilledMinutes: 0, opened: 0, closed: 0, notified: 0, snapshotBytes: 1, attempts });
const log = (endpointId: string, status: number, over: Partial<DeliveryLog> = {}): DeliveryLog => ({
  endpointId,
  event: 'incident.updated',
  status,
  attempt: 1,
  at: new Date(NOW).toISOString(),
  kind: 'notify',
  incidentId: 'inc_ab6a09',
  ...over,
});

describe('core-13 · M7: the heartbeat goes unhealthy on a delivery fail-streak', () => {
  it('3 × 429 in a row → deliveryOk: false, naming the endpoint; the sweep itself stays ok', () => {
    let streaks: Record<string, number> = {};
    const beats = [];
    for (let i = 0; i < 3; i++) {
      const hb = heartbeatFor(sweep([log('mrd_demo_webhook', 429), log('cribl-bell', 208)]), 0, NOW + i * 60_000, {}, streaks);
      streaks = hb.deliveryFailStreak as Record<string, number>;
      beats.push(hb);
    }
    expect(beats.map((b) => b.deliveryOk)).toEqual([true, true, false]);
    expect(beats[2]).toMatchObject({ ok: true, deliveryOk: false, deliveryFailStreak: { mrd_demo_webhook: 3, 'cribl-bell': 0 } });
    expect(String(beats[2].deliveryReason)).toMatch(/mrd_demo_webhook failed 3 deliveries in a row \(last HTTP 429\)/);
    expect(DELIVERY_FAIL_STREAK_UNHEALTHY).toBe(3);
  });

  it('a 2xx resets the streak; a sweep with no delivery keeps it; retries count once per alert (the final attempt)', () => {
    let s = deliveryStreaks({}, [log('hook', 503)]);
    expect(s).toEqual({ hook: 1 });
    s = deliveryStreaks(s, []);
    expect(s).toEqual({ hook: 1 });
    // A Cribl channel retries within a sweep: 503 then 503 then 200 is one delivered alert.
    s = deliveryStreaks(s, [log('bell', 503, { attempt: 1 }), log('bell', 503, { attempt: 2 }), log('bell', 200, { attempt: 3 })]);
    expect(s).toEqual({ hook: 1, bell: 0 });
    s = deliveryStreaks(s, [log('hook', 429), log('hook', 429, { incidentId: 'inc_c5a5ea' })]);
    expect(s).toEqual({ hook: 3, bell: 0 });
    s = deliveryStreaks(s, [log('hook', 200)]);
    expect(s.hook).toBe(0);
    // A timeout (status 0) is a failure too.
    expect(deliveryStreaks({}, [log('hook', 0, { error: 'timeout' })])).toEqual({ hook: 1 });
  });
});

describe('core-13 · runner-health.sh against a fixture (dry run: no process, no Leader)', () => {
  const script = resolve(__dirname, '../../scripts/runner-health.sh');
  function run(dir: string, hb: Record<string, unknown>) {
    writeFileSync(join(dir, 'logs/runner.heartbeat.json'), JSON.stringify(hb));
    return spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { ...process.env, MR_HEALTH_ROOT: dir, MR_HEALTH_SKIP_PROCESS: '1', MR_HEALTH_SKIP_LEADER: '1' },
      timeout: 30_000,
    });
  }

  it('FAILs on deliveryOk: false and says when the state changed, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mr-health-'));
    try {
      mkdirSync(join(dir, 'logs'));
      const at = new Date().toISOString();
      const ok = run(dir, { at, ok: true, lockedStreak: 0, deliveryOk: true, deliveryFailStreak: { hook: 0 } });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toMatch(/^OK runner heartbeat/m);
      const bad = run(dir, { at, ok: true, lockedStreak: 0, deliveryOk: false, deliveryReason: 'mrd_demo_webhook failed 3 deliveries in a row (last HTTP 429)' });
      expect(bad.status).toBe(1);
      expect(bad.stdout).toMatch(/^FAIL deliveries: mrd_demo_webhook failed 3 deliveries in a row \(last HTTP 429\)/m);
      expect(bad.stdout).toMatch(/^STATE OK -> FAIL/m);
      const again = run(dir, { at, ok: true, lockedStreak: 0, deliveryOk: false, deliveryReason: 'mrd_demo_webhook failed 4 deliveries in a row (last HTTP 429)' });
      expect(again.status).toBe(1);
      expect(again.stdout).not.toMatch(/^STATE /m); // still FAIL: no new transition
      const back = run(dir, { at, ok: true, lockedStreak: 0, deliveryOk: true });
      expect(back.status).toBe(0);
      expect(back.stdout).toMatch(/^STATE FAIL -> OK/m);
      expect(readFileSync(join(dir, 'logs/runner-health.state'), 'utf8').trim()).toBe('OK');
      // A heartbeat from before core-13 (no deliveryOk) is not a delivery failure.
      expect(run(dir, { at, ok: true, lockedStreak: 0 }).status).toBe(0);
      expect(existsSync(join(dir, 'logs/runner-health.state'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Founder-build r2 core-3 (FINDINGS_R2 #16; AA/r2/4 zz-f4-heartbeat-sticky.test.ts): the streak changed only on a
// delivery, so after three 429s and then a fixed receiver (nothing more to send) or a removed endpoint, `deliveryOk`
// stayed false for hours ({demo-webhook: 3} at minute 179). Now a streak ages out once its endpoint has had no new
// failure for DELIVERY_STREAK_AGE_OUT_REMINDERS reminder cadences (a final 4xx is re-tried once per cadence, so an
// endpoint that keeps failing never ages out), and a streak for an endpoint the sweep no longer delivers to (removed or
// disabled) is dropped.
describe('r2 core-3 · the heartbeat’s deliveryOk recovers', () => {
  const base = sweep();
  const fail = (at: string, endpointId = 'demo-webhook') =>
    ({ ...base, attempts: [{ endpointId, incidentId: 'inc_x', event: 'incident.updated', status: 429, at, attempt: 1, kind: 'notify' }] }) as SweepResult;

  function threeFailures() {
    let prev: Record<string, number> = {};
    let lastFailAt: Record<string, string> = {};
    for (const at of ['2026-09-28T20:00:00Z', '2026-09-28T21:00:00Z', '2026-09-28T22:00:00Z']) {
      const hb = heartbeatFor(fail(at), 0, Date.parse(at), {}, prev, { lastFailAt });
      prev = hb.deliveryFailStreak as Record<string, number>;
      lastFailAt = hb.deliveryLastFailAt as Record<string, string>;
      expect(hb.deliveryLastFailAt).toMatchObject({ 'demo-webhook': new Date(at).toISOString() });
    }
    return { prev, lastFailAt };
  }

  it('the AA probe: three healthy hours after the last failure, deliveryOk is true again (and not before one reminder cadence)', () => {
    let { prev, lastFailAt } = threeFailures();
    const beats: { minute: number; deliveryOk: unknown }[] = [];
    for (let i = 0; i < 180; i++) {
      const hb = heartbeatFor(base, 0, Date.parse('2026-09-28T23:00:00Z') + i * 60_000, {}, prev, { lastFailAt });
      prev = hb.deliveryFailStreak as Record<string, number>;
      lastFailAt = hb.deliveryLastFailAt as Record<string, string>;
      beats.push({ minute: i, deliveryOk: hb.deliveryOk });
    }
    expect(beats[0].deliveryOk).toBe(false); // one hour after the last failure: a final 4xx's reminder may still be due
    expect(beats[179].deliveryOk).toBe(true);
    // It flips once (FAIL → OK), never back.
    const flips = beats.filter((b, k) => k > 0 && b.deliveryOk !== beats[k - 1].deliveryOk);
    expect(flips).toHaveLength(1);
    expect(prev['demo-webhook']).toBeUndefined();
  });

  it('an endpoint that keeps failing once per reminder cadence stays unhealthy (no OK↔FAIL flapping)', () => {
    let prev: Record<string, number> = {};
    let lastFailAt: Record<string, string> = {};
    const t0 = Date.parse('2026-09-28T20:00:25Z');
    const states: unknown[] = [];
    for (let m = 0; m <= 8 * 61; m++) {
      const now = t0 + m * 60_000;
      const r = m % 61 === 0 ? fail(new Date(now).toISOString()) : base;
      const hb = heartbeatFor(r, 0, now, {}, prev, { lastFailAt });
      prev = hb.deliveryFailStreak as Record<string, number>;
      lastFailAt = hb.deliveryLastFailAt as Record<string, string>;
      if (m >= 2 * 61) states.push(hb.deliveryOk);
    }
    expect(states.every((s) => s === false)).toBe(true);
  });

  it('removing (or disabling) the endpoint drops its streak at once; the heartbeat is healthy on the next sweep', () => {
    const { prev, lastFailAt } = threeFailures();
    expect(heartbeatFor(base, 0, Date.parse('2026-09-28T22:01:00Z'), {}, prev, { lastFailAt }).deliveryOk).toBe(false);
    const hb = heartbeatFor({ ...base, deliveryEndpoints: ['cribl-bell'] }, 0, Date.parse('2026-09-28T22:01:00Z'), {}, prev, { lastFailAt });
    expect(hb.deliveryOk).toBe(true);
    expect(hb.deliveryFailStreak).toEqual({});
    expect(hb.deliveryLastFailAt).toEqual({});
    // A sweep that did not reach delivery (skipped, deferred) says nothing about the endpoints: the streak stays.
    expect(heartbeatFor({ ...base, skipped: 'current' }, 0, Date.parse('2026-09-28T22:01:00Z'), {}, prev, { lastFailAt }).deliveryOk).toBe(false);
  });

  it('a streak restored from an older heartbeat file without deliveryLastFailAt ages from that heartbeat’s time', () => {
    const hb = heartbeatFor(base, 0, Date.parse('2026-09-29T02:00:00Z'), {}, { 'demo-webhook': 3 }, { lastFailAt: {}, since: '2026-09-28T22:00:00Z' });
    expect(hb.deliveryOk).toBe(true);
    const fresh = heartbeatFor(base, 0, Date.parse('2026-09-28T22:30:00Z'), {}, { 'demo-webhook': 3 }, { lastFailAt: {}, since: '2026-09-28T22:00:00Z' });
    expect(fresh.deliveryOk).toBe(false);
  });

  it('the age-out is two reminder cadences (the default cooldown) and follows a workspace’s own cadence', () => {
    expect(DELIVERY_STREAK_AGE_OUT_REMINDERS).toBe(2);
    const { prev, lastFailAt } = threeFailures();
    const at = (min: number) => Date.parse('2026-09-28T22:00:00Z') + min * 60_000;
    expect(heartbeatFor(base, 0, at(119), {}, prev, { lastFailAt }).deliveryOk).toBe(false);
    expect(heartbeatFor(base, 0, at(120), {}, prev, { lastFailAt }).deliveryOk).toBe(true);
    expect(heartbeatFor(base, 0, at(29), {}, prev, { lastFailAt, reminderMinutes: 15 }).deliveryOk).toBe(false);
    expect(heartbeatFor(base, 0, at(30), {}, prev, { lastFailAt, reminderMinutes: 15 }).deliveryOk).toBe(true);
  });

  it('a workspace with a longer cooldown (4 h): an endpoint failing once per cadence keeps its streak (the sweep reports the cadence)', () => {
    let prev: Record<string, number> = {};
    let state: { lastFailAt?: Record<string, string>; reminderMinutes?: number } = {};
    const t0 = Date.parse('2026-09-28T00:00:25Z');
    const states: unknown[] = [];
    for (let m = 0; m <= 16 * 60; m += 10) {
      const now = t0 + m * 60_000;
      const failing = m % 240 === 0;
      const r = { ...(failing ? fail(new Date(now).toISOString()) : base), deliveryEndpoints: ['demo-webhook'], deliveryReminderMinutes: 240 } as SweepResult;
      const hb = heartbeatFor(r, 0, now, {}, prev, state);
      prev = hb.deliveryFailStreak as Record<string, number>;
      state = { lastFailAt: hb.deliveryLastFailAt as Record<string, string>, reminderMinutes: hb.deliveryReminderMinutes as number };
      if (m >= 8 * 60) states.push(hb.deliveryOk);
    }
    expect(states.every((s) => s === false)).toBe(true);
    // With the default cadence assumed instead, the same endpoint would age out between failures.
    expect(heartbeatFor(base, 0, t0 + 3 * 3_600_000, {}, { 'demo-webhook': 3 }, { lastFailAt: { 'demo-webhook': new Date(t0).toISOString() } }).deliveryOk).toBe(true);
  });
});

// Founder-build r3 core-4 (FINDINGS_R3 #6): a final-4xx streak is sticky (it clears on a 2xx, a removal or a
// disablement, never on silence), and runner-health.sh, fed the runner's own heartbeats, prints exactly one line per
// OK↔FAIL change: OK → FAIL at the third failed post (across incidents), nothing through the idle hours after it, and
// FAIL → OK at the next 2xx.
describe('r3 core-4 · runner-health.sh over a final-4xx streak: one line per OK↔FAIL change', () => {
  const script = resolve(__dirname, '../../scripts/runner-health.sh');
  const base = { ...sweep(), deliveryEndpoints: ['hook', 'cribl-bell'], deliveryReminderMinutes: 60 } as SweepResult;
  const post = (status: number, at: string, incidentId: string) =>
    ({ ...base, attempts: [log('hook', status, { at, incidentId, event: 'incident.opened' })] }) as SweepResult;

  it('OK, OK, FAIL at the 3rd 404 (two incidents apart), FAIL through 6 idle hours with no new STATE line, OK at a 2xx', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mr-health-r3-'));
    try {
      mkdirSync(join(dir, 'logs'));
      let streaks: Record<string, number> = {};
      let state: DeliveryStreakState = {};
      const beat = (r: SweepResult, at: string) => {
        const hb = heartbeatFor(r, 0, Date.parse(at), {}, streaks, state);
        streaks = hb.deliveryFailStreak as Record<string, number>;
        state = carryDeliveryState(hb);
        // The script checks freshness against its own clock: write the beat as just written.
        writeFileSync(join(dir, 'logs/runner.heartbeat.json'), JSON.stringify({ ...hb, at: new Date().toISOString() }));
        const out = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, MR_HEALTH_ROOT: dir, MR_HEALTH_SKIP_PROCESS: '1', MR_HEALTH_SKIP_LEADER: '1' }, timeout: 30_000 });
        return { ok: hb.deliveryOk, status: out.status, state: (out.stdout.match(/^STATE .*$/m) ?? [''])[0] };
      };
      const seen = [
        beat(post(404, '2026-09-28T15:05:00Z', 'inc_a'), '2026-09-28T15:05:00Z'), // incident 1 opens
        beat(post(404, '2026-09-28T15:30:00Z', 'inc_a'), '2026-09-28T15:30:00Z'), // incident 1 closes
        beat(base, '2026-09-28T18:30:00Z'), // three idle hours: r2 aged the streak out here
        beat(post(404, '2026-09-28T19:00:00Z', 'inc_b'), '2026-09-28T19:00:00Z'), // incident 2 opens: the 3rd failure
        beat(base, '2026-09-28T21:00:00Z'),
        beat(base, '2026-09-29T01:00:00Z'),
        beat(post(200, '2026-09-29T02:00:00Z', 'inc_c'), '2026-09-29T02:00:00Z'), // the hook is fixed: a 2xx
      ];
      expect(seen.map((b) => b.ok)).toEqual([true, true, true, false, false, false, true]);
      expect(seen.map((b) => b.status)).toEqual([0, 0, 0, 1, 1, 1, 0]);
      expect(seen.map((b) => b.state).filter(Boolean)).toEqual(['STATE OK -> FAIL', 'STATE FAIL -> OK']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
