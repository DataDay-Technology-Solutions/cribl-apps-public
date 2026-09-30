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

// Founder-build r1 core-9 (FINDINGS_R1 M8, #31; AA/r1/alerts/skeptic2-f31/sk2f31.test.ts). `delivered` was one flag
// across every endpoint: the default bell's 2xx moved lastNotifiedAt for all of them, so a webhook that answered 503
// once was not retried for the whole 60-minute cooldown (its card said "Retrying." the while), and in a break →
// restore it only ever heard "Recovered". Now each endpoint keeps its own state (incident.notified[endpointId]): a
// failed endpoint is retried after the 2-minute failed-attempt wait, with the opening it never got.
describe('core-9 · M8: a failed endpoint is retried even when the bell delivered', () => {
  async function run(withBell: boolean, minutes: number, restoreAfter?: number) {
    const { restoreTrim } = await import('../../core/demo/levers.ts');
    const w = await createWorld({
      options: { notificationApis: true },
      settings: (s) => {
        if (!withBell) s.notifications.push({ id: 'cribl-bell', name: 'bell', channel: 'cribl-bell', enabled: false, minSeverity: 'medium' } as never);
      },
    });
    const real = w.deps.webhook;
    let fails = 0;
    const sink: { t: number; status: number; event: string; inc?: string }[] = [];
    const sender: WebhookSender = {
      post: async (url, body, to) => {
        const j = JSON.parse(body) as { event: string; incident?: { id: string } };
        if (url === SINK_ENDPOINT.url && fails > 0 && j.incident?.id) {
          fails--;
          sink.push({ t: w.now(), status: 503, event: j.event, inc: j.incident.id });
          return { status: 503 };
        }
        const r = await real.post(url, body, to);
        sink.push({ t: w.now(), status: r.status, event: j.event, inc: j.incident?.id });
        return r;
      },
    };
    await w.sweep();
    await w.sweepMinutes(3, { webhook: sender });
    fails = 1;
    expect((await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' })).ok).toBe(true);
    let res = await w.sweepMinutes(restoreAfter ?? minutes, { webhook: sender });
    if (restoreAfter) {
      expect((await restoreTrim(w.lever, { pipelineId: 'mrd_pay_sample' })).ok).toBe(true);
      res = [...res, ...(await w.sweepMinutes(minutes - restoreAfter, { webhook: sender }))];
    }
    const openIdx = res.findIndex((r) => r.opened >= 1);
    const inc = (res[openIdx].snapshot?.incidents ?? []).find((i) => i.type === 'regression' && !i.closedAt)!;
    return { w, inc, openIdx, res, hook: sink.filter((s) => s.inc === inc.id), bell: w.em.bell().filter((m) => m.id.startsWith(`meter-reader-${inc.id}`)).map((m) => m.id) };
  }

  it('with the bell on: within 3 sweeps of the opening the webhook gets incident.opened with a 200; the bell is not sent twice', async () => {
    const { hook, bell, inc } = await run(true, 8);
    expect(bell).toEqual([`meter-reader-${inc.id}-high`]);
    expect(hook[0]).toMatchObject({ status: 503, event: 'incident.opened' });
    const retry = hook.find((h) => h.status === 200);
    expect(retry).toMatchObject({ event: 'incident.opened' });
    expect(retry!.t - hook[0].t).toBeLessThanOrEqual(3 * 60_000);
    // One retry, then the cooldown holds (no re-send in the 8 minutes).
    expect(hook.filter((h) => h.status === 200)).toHaveLength(1);
  }, 120_000);

  it('break → restore: the webhook hears the opening before the recovery', async () => {
    const { hook } = await run(true, 12, 5);
    const events = hook.filter((h) => h.status === 200).map((h) => h.event);
    expect(events[0]).toBe('incident.opened');
    expect(events).toContain('incident.closed');
    expect(events.indexOf('incident.opened')).toBeLessThan(events.indexOf('incident.closed'));
  }, 120_000);

  it('control: with the bell off the webhook was already retried at +2 min (unchanged)', async () => {
    const { hook } = await run(false, 8);
    expect(hook.map((h) => [h.status, h.event])).toEqual([
      [503, 'incident.opened'],
      [200, 'incident.opened'],
    ]);
  }, 120_000);

  it('records each endpoint on the incident: the bell delivered, the webhook failed then delivered', async () => {
    const { w, inc } = await run(true, 4);
    const doc = (await w.docs.getSnapshot())!.incidents.find((i) => i.id === inc.id)!;
    expect(doc.notified?.['cribl-bell']?.ok).toBeDefined();
    expect(doc.notified?.[SINK_ENDPOINT.id]?.status).toBe(200);
    expect(doc.notified?.[SINK_ENDPOINT.id]?.ok).toBeDefined();
  }, 120_000);
});
