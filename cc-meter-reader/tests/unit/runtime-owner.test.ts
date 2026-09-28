// tests/unit/runtime-owner.test.ts — the build's default runtime (VITE_MR_RUNTIME) and "who metered this"
// (meta.lastSweepOwner → Footer / Settings "Metered by the runner on <host>" vs "Metered by this tab").

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meta } from '../../core/types.ts';
import { defaultSettings } from '../../core/settings.ts';
import { DEFAULT_RUNTIME, runtimeFromEnv } from '../../src/lib/env.ts';
import { endpointDisplayName, isRunnerFresh, RUNNER_FRESH_MS, runnerSweepAt, sweepOwner, sweepOwnerHost, sweepOwnerKind } from '../../src/state/selectors.ts';
import type { NotificationEndpoint } from '../../core/types.ts';
import { createAppState } from '../../src/state/store.ts';
import { MINUTE, T0, createWorld, faultHttp } from '../integration/harness.ts';

const meta = (lastSweepOwner?: string, lastSweepMode?: Meta['lastSweepMode']) => ({
  ...(lastSweepOwner !== undefined ? { lastSweepOwner } : {}),
  ...(lastSweepMode !== undefined ? { lastSweepMode } : {}),
});

describe('build runtime flag (VITE_MR_RUNTIME)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("maps only 'backend' to the backend runtime", () => {
    expect(runtimeFromEnv('backend')).toBe('backend');
    expect(runtimeFromEnv(' Backend ')).toBe('backend');
    expect(runtimeFromEnv('ui')).toBe('ui');
    expect(runtimeFromEnv('')).toBe('ui');
    expect(runtimeFromEnv(undefined)).toBe('ui');
    expect(runtimeFromEnv(1)).toBe('ui');
  });

  it("is 'ui' in the release, demo and test builds (flag unset)", async () => {
    expect((await import('../../src/lib/env.ts')).DEFAULT_RUNTIME).toBe('ui');
    expect(DEFAULT_RUNTIME).toBe('ui');
    expect(defaultSettings('2026-09-26T00:00:00.000Z', 'UTC', DEFAULT_RUNTIME).runtime).toBe('ui');
  });

  it("is 'backend' in a bundle built with VITE_MR_RUNTIME=backend", async () => {
    vi.stubEnv('VITE_MR_RUNTIME', 'backend');
    vi.resetModules();
    const env = await import('../../src/lib/env.ts');
    expect(env.DEFAULT_RUNTIME).toBe('backend');
    expect(defaultSettings('2026-09-26T00:00:00.000Z', 'UTC', env.DEFAULT_RUNTIME).runtime).toBe('backend');
  });
});

describe('sweepOwnerKind', () => {
  it('reads the owner prefix the sweep ran as', () => {
    expect(sweepOwnerKind(meta('ui:3f2a9c1e-7b1d-4a57-9d1e-1c2b3a4d5e6f'))).toBe('tab');
    expect(sweepOwnerKind(meta('runner:48213'))).toBe('runner');
    expect(sweepOwnerKind(meta('runner:studio.local:48213'))).toBe('runner');
    expect(sweepOwnerKind(meta('backend:0f9e8d7c'))).toBe('backend');
    // runSweep's own fallback ids (resolveDeps) for callers that left the owner out
    expect(sweepOwnerKind(meta('sweep:ui'))).toBe('tab');
    expect(sweepOwnerKind(meta('sweep:backend'))).toBe('backend');
    expect(sweepOwnerKind(meta('sweep:other'))).toBe('unknown');
    expect(sweepOwnerKind(meta('lever:s.koelpin'))).toBe('unknown');
    expect(sweepOwnerKind(meta('tab-a'))).toBe('unknown');
  });

  it('falls back to the sweep mode for a meta written before owners were recorded', () => {
    expect(sweepOwnerKind(meta(undefined, 'ui'))).toBe('tab');
    expect(sweepOwnerKind(meta(undefined, 'scheduled'))).toBe('unknown');
    expect(sweepOwnerKind(meta(undefined, 'manual'))).toBe('unknown');
    expect(sweepOwnerKind(meta('  ', 'ui'))).toBe('tab');
    expect(sweepOwnerKind(meta())).toBe('unknown');
    expect(sweepOwnerKind(null)).toBe('unknown');
    expect(sweepOwnerKind(undefined)).toBe('unknown');
    // the owner wins over the mode
    expect(sweepOwnerKind(meta('runner:studio.local:1', 'ui'))).toBe('runner');
  });
});

describe('sweepOwnerHost', () => {
  it("names the runner's host when its owner id carries one", () => {
    expect(sweepOwnerHost(meta('runner:studio.local:48213'))).toBe('studio.local');
    expect(sweepOwnerHost(meta('runner:workhorse'))).toBe('workhorse');
    expect(sweepOwnerHost(meta('runner:48213'))).toBeUndefined(); // a bare pid names no host
    expect(sweepOwnerHost(meta('runner:'))).toBeUndefined();
    expect(sweepOwnerHost(meta('runner: :1'))).toBeUndefined();
    expect(sweepOwnerHost(meta('ui:studio.local:1'))).toBeUndefined();
    expect(sweepOwnerHost(meta())).toBeUndefined();
    expect(sweepOwnerHost(null)).toBeUndefined();
  });
});

describe('runner freshness (REVIEW-3a #2/#10)', () => {
  it('reads the runner sweep time from meta, and only from a runner-owned meta', () => {
    expect(runnerSweepAt({ lastSweepOwner: 'runner:mac:1', lastSweepAt: '2026-09-26T12:00:08.000Z' })).toBe(Date.parse('2026-09-26T12:00:08.000Z'));
    expect(runnerSweepAt({ lastSweepOwner: 'ui:tab', lastSweepAt: '2026-09-26T12:00:08.000Z' })).toBeUndefined();
    expect(runnerSweepAt({ lastSweepOwner: 'runner:1' })).toBeUndefined();
    expect(runnerSweepAt(null)).toBeUndefined();
  });

  it('counts a runner as fresh for 90 s after its sweep', () => {
    const at = Date.parse('2026-09-26T12:00:08.000Z');
    expect(RUNNER_FRESH_MS).toBe(90_000);
    expect(isRunnerFresh(at, at + 89_999)).toBe(true);
    expect(isRunnerFresh(at, at + 90_000)).toBe(false);
    expect(isRunnerFresh(undefined, at)).toBe(false);
    expect(isRunnerFresh(at, at - 5_000)).toBe(true); // a Leader clock a few seconds ahead
  });
});

describe('endpointDisplayName (IncidentCard delivery lines; NOTIFY-3a open issue 1)', () => {
  const eps: NotificationEndpoint[] = [
    { id: 'hook', name: 'Ops Slack', url: 'https://hooks.slack.com/x', host: 'hooks.slack.com', format: 'slack', minSeverity: 'medium', weeklyReceipt: true, enabled: true },
    { id: 'hook2', name: ' ', url: 'https://x.example/y', host: 'x.example', format: 'servicenow', minSeverity: 'medium', weeklyReceipt: true, enabled: true },
    { id: 'tgt', name: '', url: '', host: '', format: 'generic', minSeverity: 'medium', weeklyReceipt: false, enabled: true, channel: 'cribl-target', criblTargetId: 'pd-oncall' },
    { id: 'tgt2', name: 'Pager', url: '', host: '', format: 'generic', minSeverity: 'medium', weeklyReceipt: false, enabled: true, channel: 'cribl-target', criblTargetId: 'pd' },
  ];
  it("names the default bell 'Cribl notifications' even though it is never stored", () => {
    expect(endpointDisplayName('cribl-bell')).toBe('Cribl notifications');
    expect(endpointDisplayName('cribl-bell', eps)).toBe('Cribl notifications');
    const storedBell: NotificationEndpoint = { id: 'cribl-bell', name: 'whatever', url: '', host: '', format: 'generic', minSeverity: 'high', weeklyReceipt: false, enabled: false, channel: 'cribl-bell' };
    expect(endpointDisplayName('cribl-bell', [storedBell])).toBe('Cribl notifications');
  });
  it('names targets by their name, else their target id; webhooks by name, else format', () => {
    expect(endpointDisplayName('tgt2', eps)).toBe('Pager');
    expect(endpointDisplayName('tgt', eps)).toBe('pd-oncall');
    expect(endpointDisplayName('hook', eps)).toBe('Ops Slack');
    expect(endpointDisplayName('hook2', eps)).toBe('ServiceNow');
    expect(endpointDisplayName('gone', eps)).toBe('gone');
    expect(endpointDisplayName('', eps)).toBe('webhook');
  });
});

describe('sweepOwner (AppState)', () => {
  const defaults = defaultSettings('2026-09-26T00:00:00.000Z', 'UTC');
  const stored = { lastSweepOwner: 'runner:studio.local:7' } as Meta;
  it('reads live meta, and never claims an owner for sample or replay data', () => {
    expect(sweepOwner(createAppState(defaults, { meta: stored }))).toBe('runner');
    expect(sweepOwner(createAppState(defaults))).toBe('unknown');
    expect(sweepOwner(createAppState(defaults, { meta: stored, source: 'sample' }))).toBe('unknown');
    expect(sweepOwner(createAppState(defaults, { meta: stored, source: 'replay' }))).toBe('unknown');
  });
});

describe('runSweep records its owner in meta', () => {
  it('writes deps.owner as meta.lastSweepOwner on every completed sweep', async () => {
    const w = await createWorld({ sweep: { owner: 'ui:tab-one' } });
    expect((await w.sweep()).error).toBeUndefined();
    expect((await w.meta())?.lastSweepOwner).toBe('ui:tab-one');
    expect(sweepOwnerKind(await w.meta())).toBe('tab');
    // The runner takes over (the KV lock serializes them): the next sweep names it.
    w.set(T0 + MINUTE);
    expect((await w.sweep('scheduled', { owner: 'runner:studio.local:4242', runtime: 'backend' })).error).toBeUndefined();
    const m = await w.meta();
    expect(m?.lastSweepOwner).toBe('runner:studio.local:4242');
    expect(sweepOwnerKind(m)).toBe('runner');
    expect(sweepOwnerHost(m)).toBe('studio.local');
  });

  it('keeps the last completed sweep\'s owner when a later sweep fails', async () => {
    const w = await createWorld({ sweep: { owner: 'runner:studio.local:1' } });
    await w.sweep('scheduled');
    const denied = faultHttp(w.deps.http, (m, p) => m === 'POST' && p.startsWith('/system/metrics/query'), 403, 3);
    w.set(T0 + MINUTE);
    const failed = await w.sweep('ui', { http: denied, owner: 'ui:other-tab' });
    expect(failed.error).toMatch(/HTTP 403/);
    const m = await w.meta();
    expect(m?.sweepErrors).toBe(1);
    expect(m?.lastSweepOwner).toBe('runner:studio.local:1');
  });
});
