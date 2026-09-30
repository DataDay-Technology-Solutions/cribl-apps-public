// tests/integration/backend.test.ts — the backend variant's HTTP shells (backend/meter.ts, weeklyReceipt.ts,
// sendTest.ts) against the emulated org, through the platform-style relative `/api/v1` fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequest as meter } from '../../backend/meter.ts';
import { onRequest as weeklyReceipt } from '../../backend/weeklyReceipt.ts';
import { onRequest as sendTest } from '../../backend/sendTest.ts';
import { readJsonBody } from '../../backend/lib/http.ts';
import { APP_VERSION, BUILD } from '../../backend/lib/build-info.ts';
import { SINK_ENDPOINT, createWorld, emulatorFetch, type World } from './harness.ts';

const URL_BASE = 'https://main-example-org.cribl.cloud/api/v1/a/meter-reader/endpoints';
const post = (name: string, body?: unknown): Request =>
  new Request(`${URL_BASE}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
const ctx = { appId: 'meter-reader', invocationId: 'inv-1' };

describe('backend endpoints (backend variant)', () => {
  let w: World;
  beforeEach(async () => {
    // Backend deps use the real clock, so the emulated org is created at the real "now".
    w = await createWorld({ start: Date.now() });
    vi.stubGlobal('fetch', emulatorFetch(w.em));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('meter runs the sweep: Sweep now answers with the snapshot, the schedule without it', async () => {
    const manual = await meter(post('meter', { mode: 'manual' }), ctx);
    expect(manual.status).toBe(200);
    const body = (await manual.json()) as Record<string, unknown>;
    // A fresh install (no stored inventory): the first sweep walks the configuration and, for this small estate,
    // reaches back a whole day (D63; the cold path, rules round 2).
    expect(body).toMatchObject({ ok: true, minutesProcessed: 24 * 60 });
    expect(body.snapshot).toBeDefined();
    const meta = await w.meta();
    expect(meta).toMatchObject({
      appVersion: APP_VERSION,
      build: BUILD,
      lastSweepMode: 'manual',
    });
    const scheduled = await meter(
      post('meter', {
        scheduleId: 'meter-every-minute',
        scheduledFor: new Date().toISOString(),
        mode: 'scheduled',
      }),
      { appId: 'meter-reader' },
    );
    const sb = (await scheduled.json()) as Record<string, unknown>;
    expect(scheduled.status).toBe(200);
    expect(sb.snapshot).toBeUndefined();
  });

  it('meter answers 422 when the sweep fails', async () => {
    const inner = emulatorFetch(w.em);
    vi.stubGlobal('fetch', (url: string, init?: { method?: string }) =>
      url.includes('/system/metrics/query')
        ? Promise.resolve({ status: 500, ok: false, text: async () => 'boom' })
        : inner(url, init as never),
    );
    const res = await meter(post('meter', 'not json'), ctx);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { ok: boolean; error: string }).error).toMatch(/HTTP 500/);
  });

  it('weeklyReceipt posts the receipt to the Cribl bell; sendTest checks its input and tests a stored endpoint (D57: no stored webhook)', async () => {
    // The Enterprise backend reads its endpoints from KV like every build: the Cribl channels only (D57), so the
    // world's direct webhook (the runner's .env) is not the backend's, and the receipt goes to the bell.
    w.em.control({ action: 'config', options: { notificationApis: true } });
    await w.putSettings((s) => {
      s.notifications = [{ id: 'cribl-bell', name: 'Cribl notifications', url: '', host: '', format: 'generic', minSeverity: 'medium', weeklyReceipt: true, enabled: true, channel: 'cribl-bell' }];
    });
    const weekly = await weeklyReceipt(post('weeklyReceipt', { mode: 'manual' }), ctx);
    expect(weekly.status).toBe(200);
    expect(await weekly.json()).toMatchObject({
      ok: true,
      sent: 1,
      endpoints: 1,
    });
    expect(w.em.sink().some((d) => d.host === 'webhook.site')).toBe(false);
    const scheduled = await weeklyReceipt(post('weeklyReceipt'), ctx);
    expect(scheduled.status).toBe(200);

    expect((await sendTest(post('sendTest', {}), ctx)).status).toBe(400);
    expect((await sendTest(post('sendTest', { endpointId: 'nope' }), ctx)).status).toBe(404);
    // A direct webhook's id is unknown to the backend: its URL was never stored (D57).
    expect((await sendTest(post('sendTest', { endpointId: SINK_ENDPOINT.id }), ctx)).status).toBe(404);
    const ok = await sendTest(
      post('sendTest', {
        endpointId: 'cribl-bell',
        workspace: 'main',
        linkBase: 'https://x/apps/a/meter-reader',
      }),
      ctx,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      status: 200,
      hostAuthorized: true,
    });
    expect(w.em.bell().some((m) => /test/i.test(JSON.stringify(m)))).toBe(true);
  });

  it('reads odd request bodies as {}', async () => {
    expect(await readJsonBody(new Request('https://x/', { method: 'POST', body: '[1,2]' }))).toEqual({});
    expect(await readJsonBody(new Request('https://x/', { method: 'POST', body: '   ' }))).toEqual({});
    const consumed = new Request('https://x/', {
      method: 'POST',
      body: '{"a":1}',
    });
    await consumed.text();
    expect(await readJsonBody(consumed)).toEqual({});
  });
});
