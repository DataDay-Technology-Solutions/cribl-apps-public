// tests/unit/sweep-dead-webhook.test.ts — one direct-webhook endpoint that never answers (EPIC_AUDIT P1-E07).
//
// Before: each incident waited ~40 s on the dead host (three 10 s timeouts and the 2 s + 8 s back-off), so two
// incidents took 80 s — near the lock's life — the notification budget tripped, and the healthy endpoint heard about
// the second incident a sweep late. Now a direct webhook gets one attempt a sweep, an endpoint that timed out is down
// for the rest of the sweep, and the Cribl channels go first.

import { describe, expect, it } from 'vitest';
import type { NotificationEndpoint, WebhookSender } from '../../core/types.ts';
import { WEBHOOK_TIMEOUT_MS, isTimeoutAttempt } from '../../core/adapters/webhook.ts';
import { deliveryOrder, resolveEndpoints } from '../../core/delivery.ts';
import { breakTrim, setRate } from '../../core/demo/levers.ts';
import { SINK_ENDPOINT, createWorld } from '../integration/harness.ts';

const DEAD_URL = 'https://hooks.slack.com/services/dead/endpoint';
const DEAD: NotificationEndpoint = { ...SINK_ENDPOINT, id: 'ep_dead', name: 'Dead Slack', url: DEAD_URL, host: 'hooks.slack.com', format: 'slack' };

describe('P1-E07 — a dead webhook endpoint', () => {
  it('with one dead endpoint and two incidents the sweep takes < 30 s and the healthy endpoint receives both in the same sweep', async () => {
    const w = await createWorld({ settings: (s) => void (s.notifications = [{ ...DEAD }, { ...SINK_ENDPOINT }]) });
    const dead: string[] = [];
    const real = w.deps.webhook;
    const sender: WebhookSender = {
      post: async (url, body, timeoutMs) => {
        if (url !== DEAD_URL) return real.post(url, body, timeoutMs);
        dead.push(body);
        w.advance(timeoutMs ?? WEBHOOK_TIMEOUT_MS);
        return { status: 0, error: `timeout after ${timeoutMs ?? WEBHOOK_TIMEOUT_MS} ms` };
      },
    };
    await w.sweep();
    await w.sweepMinutes(3);
    expect((await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' })).ok).toBe(true);
    expect((await setRate(w.lever, { inputId: 'mrd_windows_dc', multiplier: 5 })).ok).toBe(true);

    const results = await w.sweepMinutes(4, { webhook: sender });
    const opening = results.find((r) => r.opened >= 2);
    expect(opening, 'both incidents open in one sweep').toBeDefined();
    const incidents = (opening!.snapshot?.incidents ?? []).filter((i) => !i.closedAt && (i.type === 'regression' || i.type === 'spike'));
    expect(incidents.length).toBeGreaterThanOrEqual(2);

    // < 30 s: one 10 s timeout, then the dead endpoint is skipped.
    expect(opening!.ms).toBeLessThan(30_000);
    expect(opening!.ms).toBeGreaterThanOrEqual(WEBHOOK_TIMEOUT_MS);
    // The healthy endpoint heard about both, in this sweep.
    expect(opening!.notified).toBe(incidents.length);
    for (const inc of incidents) {
      const sink = (inc.deliveries ?? []).filter((d) => d.endpointId === SINK_ENDPOINT.id);
      expect(sink.map((d) => d.status), inc.id).toEqual([200]);
    }
    // The dead endpoint: one attempt in that sweep (not three, not one per incident), logged as a timeout.
    const deadLogs = (opening!.snapshot?.deliveries ?? []).filter((l) => l.endpointId === 'ep_dead');
    expect(deadLogs).toHaveLength(1);
    expect(isTimeoutAttempt(deadLogs[0])).toBe(true);
    expect(w.logs.some((l) => l.level === 'warn' && /Dead Slack did not answer within 10 s; skipped for the rest of this sweep/.test(l.msg))).toBe(true);
    expect(w.logs.some((l) => /notification time budget spent/.test(l.msg))).toBe(false);
  });

  it('delivers through Cribl channels first, then direct webhooks, and the implicit bell last', () => {
    const target: NotificationEndpoint = { ...SINK_ENDPOINT, id: 'ep_target', channel: 'cribl-target', criblTargetId: 't1' };
    const hook2: NotificationEndpoint = { ...SINK_ENDPOINT, id: 'ep_hook2' };
    const ordered = deliveryOrder(resolveEndpoints([{ ...DEAD }, target, hook2]));
    expect(ordered.map((e) => e.id)).toEqual(['ep_target', 'ep_dead', 'ep_hook2', 'cribl-bell']);
    expect(ordered.at(-1)?.implicit).toBe(true);
    const storedBell: NotificationEndpoint = { ...SINK_ENDPOINT, id: 'cribl-bell', channel: 'cribl-bell', url: '', host: '' };
    expect(deliveryOrder(resolveEndpoints([{ ...DEAD }, storedBell])).map((e) => e.id)).toEqual(['cribl-bell', 'ep_dead']);
  });

  it('tells a timeout from a fast failure', () => {
    expect(isTimeoutAttempt({ status: 0, detail: 'timeout after 10000 ms' })).toBe(true);
    expect(isTimeoutAttempt({ status: 0, detail: 'connect ECONNREFUSED' })).toBe(false);
    expect(isTimeoutAttempt({ status: 503 })).toBe(false);
  });
});
