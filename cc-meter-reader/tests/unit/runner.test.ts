// tests/unit/runner.test.ts — scripts/runner.ts pieces that decide what the runner records and when it sweeps
// (REVIEW-3a #1: 25 s after the boundary; #10: the installed App's version and build, never 'runner').

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CriblHttp, HttpResult } from '../../core/types.ts';
import { SETTLE_MS, type SweepResult } from '../../core/sweep.ts';
import {
  EXIT_ANOTHER_RUNNER,
  LOCKED_STREAK_UNHEALTHY,
  SWEEP_OFFSET_MS,
  appInfoFrom,
  clearAppInfoCache,
  deps,
  heartbeatFor,
  installedApp,
  msUntilNextSweep,
  orgVerdict,
  packageVersion,
  pidfileVerdict,
  runnerLabel,
  runnerOwner,
  setupVerdict,
} from '../../scripts/runner.ts';

const PKG_VERSION = (JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { version: string }).version;
const B = Date.UTC(2026, 8, 26, 9, 0, 0);

afterEach(() => clearAppInfoCache());

function http(answers: (HttpResult | Error)[]): CriblHttp & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request(method, path) {
      calls.push(`${method} ${path}`);
      const a = answers.length > 1 ? answers.shift()! : answers[0];
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

describe('runner timing', () => {
  it('sweeps 25 s after each minute boundary, past the 20 s settle', () => {
    expect(SWEEP_OFFSET_MS).toBe(25_000);
    expect(SWEEP_OFFSET_MS).toBeGreaterThan(SETTLE_MS);
    expect(msUntilNextSweep(B)).toBe(25_000);
    expect(msUntilNextSweep(B + 24_999)).toBe(1);
    expect(msUntilNextSweep(B + 25_000)).toBe(60_000);
    expect(msUntilNextSweep(B + 26_000)).toBe(59_000);
    expect(msUntilNextSweep(B + 59_999)).toBe(25_001);
  });
});

describe('what the runner records about the App (REVIEW-3a #10)', () => {
  it('reads the demo build from the installed displayName and the version from the install', () => {
    const demo = { items: [{ id: 'meter-reader', version: '1.0.1', displayName: 'Meter Reader (demo build)' }], count: 1 };
    expect(appInfoFrom(demo)).toEqual({ appVersion: '1.0.1', build: 'demo' });
    expect(appInfoFrom({ items: [{ id: 'meter-reader', version: '1.0.0', displayName: 'Meter Reader' }] })).toEqual({ appVersion: '1.0.0', build: 'release' });
    expect(appInfoFrom({ id: 'meter-reader', version: '2.0.0', displayName: 'Meter Reader' })).toEqual({ appVersion: '2.0.0', build: 'release' });
    // No version on the item: this repo's package.json version.
    expect(appInfoFrom({ items: [{ id: 'meter-reader', displayName: 'Meter Reader (Demo Build)' }] })).toEqual({ appVersion: PKG_VERSION, build: 'demo' });
    expect(appInfoFrom({ items: [{ id: 'other-app', version: '9.9.9' }] })).toBeNull();
    expect(appInfoFrom(null)).toBeNull();
    expect(packageVersion()).toBe(PKG_VERSION);
  });

  it('asks the Leader once per 10 minutes and keeps the last answer when the read fails', async () => {
    const warnings: string[] = [];
    const warn = (m: string) => void warnings.push(m);
    const ok: HttpResult = { status: 200, ok: true, json: { items: [{ id: 'meter-reader', version: '1.0.1', displayName: 'Meter Reader (demo build)' }] } };
    const h = http([ok, { status: 503, ok: false }]);
    expect(await installedApp(h, B, warn)).toEqual({ appVersion: '1.0.1', build: 'demo' });
    expect(await installedApp(h, B + 5 * 60_000, warn)).toEqual({ appVersion: '1.0.1', build: 'demo' });
    expect(h.calls).toEqual(['GET /apps/meter-reader']);
    expect(await installedApp(h, B + 11 * 60_000, warn)).toEqual({ appVersion: '1.0.1', build: 'demo' });
    expect(h.calls).toHaveLength(2);
    expect(warnings[0]).toContain('HTTP 503');
    expect(warnings[0]).toContain('keeping the last answer');
    // P1-E06: the failure is remembered for the TTL too — one call per 10 minutes, not one per sweep.
    expect(await installedApp(h, B + 12 * 60_000, warn)).toEqual({ appVersion: '1.0.1', build: 'demo' });
    expect(await installedApp(h, B + 20 * 60_000, warn)).toEqual({ appVersion: '1.0.1', build: 'demo' });
    expect(h.calls).toHaveLength(2);
    await installedApp(h, B + 22 * 60_000, warn);
    expect(h.calls).toHaveLength(3);
  });

  it('with no answer yet, falls back to package.json as the release build — never "runner"', async () => {
    const warnings: string[] = [];
    const info = await installedApp(http([new Error('offline')]), B, (m) => void warnings.push(m));
    expect(info).toEqual({ appVersion: PKG_VERSION, build: 'release' });
    expect(warnings[0]).toContain('offline');
    expect(warnings[0]).toContain('keeping package.json');
    expect(await installedApp(http([{ status: 200, ok: true, json: { items: [] } }]), B, () => undefined)).toEqual({ appVersion: PKG_VERSION, build: 'release' });
  });

  it('deps() carries the App info it is given; the lock owner never names the machine unless .env does', () => {
    const d = deps({ appVersion: '1.0.1', build: 'demo' });
    expect(d.owner).toMatch(new RegExp(`^runner:(?:[^:]+:)?${process.pid}$`));
    expect(d.appVersion).toBe('1.0.1');
    expect(d.build).toBe('demo');
    expect(d.runtime).toBe('backend');
    expect(deps().appVersion).toBe(PKG_VERSION);
    expect(deps().appVersion).not.toBe('runner');
  });
});

describe('runner operations (EPIC_AUDIT P1-E06)', () => {
  const NOW = Date.UTC(2026, 8, 28, 15, 0, 25);
  const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

  it('names the host only from MR_RUNNER_HOST: runner:<pid> by default', () => {
    expect(runnerOwner({}, 4242)).toBe('runner:4242');
    expect(runnerOwner({ MR_RUNNER_HOST: 'workhorse' }, 4242)).toBe('runner:workhorse:4242');
    expect(runnerOwner({ MR_RUNNER_HOST: ' work horse:1 ' }, 7)).toBe('runner:workhorse1:7');
    expect(runnerLabel('runner:workhorse:7')).toBe('workhorse');
    expect(runnerLabel('runner:7')).toBe('');
    expect(runnerLabel('ui:tab')).toBeUndefined();
  });

  it('refuses a second runner on this machine while the pidfile names a live process', () => {
    const rec = { pid: 999, startedAt: ago(600) };
    expect(pidfileVerdict(null, () => true, 1)).toEqual({ ok: true });
    expect(pidfileVerdict(rec, () => false, 1)).toEqual({ ok: true }); // stale: that runner is gone
    expect(pidfileVerdict({ ...rec, pid: 1 }, () => true, 1)).toEqual({ ok: true }); // this process
    const refused = pidfileVerdict(rec, () => true, 1);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toMatch(/another runner is already running on this machine \(pid 999/);
  });

  it("refuses to start while another named host's runner metered the org in the last 90 s", () => {
    const meta = { lastSweepOwner: 'runner:workhorse:12', lastSweepAt: ago(20) };
    const refused = orgVerdict(meta, 'runner:laptop:5', NOW);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toMatch(/the runner on workhorse \(runner:workhorse:12\) metered this org 20 s ago/);
    // A check-in counts too (the runner found a tab had metered the minute).
    expect(orgVerdict({ lastSweepOwner: 'ui:tab', lastSweepAt: ago(5), deliveryOwner: 'runner:workhorse:12', deliveryOwnerAt: ago(30) }, 'runner:laptop:5', NOW).ok).toBe(false);
    // Stale, the same host (a restart), a tab, or unnamed runners: start.
    expect(orgVerdict({ ...meta, lastSweepAt: ago(120) }, 'runner:laptop:5', NOW).ok).toBe(true);
    expect(orgVerdict(meta, 'runner:workhorse:13', NOW).ok).toBe(true);
    expect(orgVerdict({ lastSweepOwner: 'ui:abc', lastSweepAt: ago(5) }, 'runner:laptop:5', NOW).ok).toBe(true);
    expect(orgVerdict({ lastSweepOwner: 'runner:12', lastSweepAt: ago(5) }, 'runner:5', NOW).ok).toBe(true);
    expect(orgVerdict(null, 'runner:5', NOW).ok).toBe(true);
  });

  it('--setup runs only against the org named with --demo-org, which must be the one .env points at', () => {
    expect(setupVerdict(['--setup'], { CRIBL_ORG: 'example-org' })).toMatchObject({ ok: false, reason: expect.stringContaining('--demo-org') });
    expect(setupVerdict(['--setup', '--demo-org', 'other-org'], { CRIBL_ORG: 'example-org' })).toMatchObject({ ok: false, reason: expect.stringContaining('not the org') });
    expect(setupVerdict(['--setup', '--demo-org', 'x'], {})).toMatchObject({ ok: false });
    expect(setupVerdict(['--setup', '--demo-org', 'example-org'], { CRIBL_ORG: 'example-org' })).toEqual({ ok: true });
  });

  it('the heartbeat is unhealthy after 3 locked skips in a row and during a rate-limit back-off; current is healthy', () => {
    const r = (x: Partial<SweepResult>): SweepResult => ({ calls: 1, ms: 5, minutesProcessed: 0, backfilledMinutes: 0, opened: 0, closed: 0, notified: 0, snapshotBytes: 0, ...x });
    let streak = 0;
    const oks: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const hb = heartbeatFor(r({ skipped: 'locked' }), streak, NOW);
      streak = hb.lockedStreak;
      oks.push(hb.ok);
    }
    expect(LOCKED_STREAK_UNHEALTHY).toBe(3);
    expect(oks).toEqual([true, true, false, false]);
    expect(heartbeatFor(r({ skipped: 'locked' }), 2, NOW).reason).toMatch(/refused 3 sweeps in a row/);
    const back = heartbeatFor(r({ skipped: 'backoff', error: 'rate_limited', rateLimit: { since: ago(300), until: ago(-120), streak: 2 } }), 0, NOW);
    expect(back).toMatchObject({ ok: false, lockedStreak: 0 });
    expect(back.reason).toMatch(/rate limited by the Leader since .*backing off until/);
    expect(heartbeatFor(r({ skipped: 'current' }), 2, NOW)).toMatchObject({ ok: true, lockedStreak: 0 });
    expect(heartbeatFor(r({ minutesProcessed: 1 }), 5, NOW)).toMatchObject({ ok: true, lockedStreak: 0 });
    expect(heartbeatFor(r({ error: 'time_budget' }), 0, NOW)).toMatchObject({ ok: false, reason: 'time_budget' });
  });

  it('starting a second runner exits non-zero with a named reason (before any Leader call)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mr-runner-'));
    try {
      writeFileSync(join(dir, 'runner.pid'), JSON.stringify({ pid: process.pid, startedAt: '2026-09-28T15:00:00.000Z' }));
      const root = resolve(__dirname, '../..');
      const run = spawnSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'scripts/runner.ts')], {
        cwd: dir,
        env: { ...process.env, MR_RUNNER_LOG_DIR: dir },
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(run.status).toBe(EXIT_ANOTHER_RUNNER);
      expect(run.stderr).toContain(`another runner is already running on this machine (pid ${process.pid}`);
      expect(readFileSync(join(dir, 'runner.log'), 'utf8')).toContain('runner refused to start');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
