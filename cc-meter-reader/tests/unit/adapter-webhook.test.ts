import { describe, expect, it } from 'vitest';
import type { WebhookSender } from '../../core/types.ts';
import type { FetchInit, FetchLike } from '../../core/http.ts';
import {
  classifyStatus,
  createFetchWebhookSender,
  deliver,
  lastAttempt,
  WEBHOOK_BACKOFF_MS,
  WEBHOOK_TIMEOUT_MS,
} from '../../core/adapters/webhook.ts';

const URL_OK = 'https://hooks.slack.com/services/T000/B000/XXXX';
const T0 = Date.parse('2026-09-30T16:42:03Z');

/** A sender answering from a queue (a number = status, an Error = throw); a clock the sleeps advance. */
function harness(answers: (number | Error | { status: number; error?: string })[]) {
  let now = T0;
  const posts: { url: string; body: string; timeoutMs: number }[] = [];
  const sleeps: number[] = [];
  const sender: WebhookSender = {
    async post(url, body, timeoutMs) {
      posts.push({ url, body, timeoutMs });
      now += 150; // each POST takes a moment
      const a = answers.shift() ?? 200;
      if (a instanceof Error) throw a;
      return typeof a === 'number' ? { status: a } : a;
    },
  };
  return {
    sender,
    posts,
    sleeps,
    clock: { now: () => now },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}
const base = { endpointId: 'ep_ops', event: 'incident.opened' as const, incidentId: 'inc_7f3a' };

describe('deliver', () => {
  it('delivers on the first attempt with one log entry', async () => {
    const h = harness([200]);
    const logs = await deliver({ ...h, url: URL_OK, body: { schemaVersion: 1, app: 'meter-reader' }, ...base });
    expect(logs).toEqual([{ endpointId: 'ep_ops', event: 'incident.opened', incidentId: 'inc_7f3a', status: 200, attempt: 1, at: new Date(T0).toISOString(), kind: 'notify' }]);
    expect(h.posts).toEqual([{ url: URL_OK, body: '{"schemaVersion":1,"app":"meter-reader"}', timeoutMs: 10_000 }]);
    expect(h.sleeps).toEqual([]);
    expect(lastAttempt(logs)?.status).toBe(200);
  });

  it('retries 5xx twice, after 2 s then 8 s, and logs every attempt with its own time', async () => {
    const h = harness([502, 503, 504]);
    const logs = await deliver({ ...h, url: URL_OK, body: 'raw text', ...base });
    expect(h.sleeps).toEqual([2_000, 8_000]);
    expect(logs.map((l) => [l.attempt, l.status, l.error])).toEqual([
      [1, 502, 'http_502'],
      [2, 503, 'http_503'],
      [3, 504, 'http_504'],
    ]);
    expect(logs.map((l) => l.at)).toEqual([T0, T0 + 150 + 2_000, T0 + 150 + 2_000 + 150 + 8_000].map((ms) => new Date(ms).toISOString()));
    expect(h.posts.every((p) => p.body === 'raw text')).toBe(true);
  });

  it('retries network errors (status 0, thrown or reported) and stops at the first success', async () => {
    const h = harness([new Error('socket hang up'), { status: 0, error: 'timeout after 10000 ms' }, 201]);
    const logs = await deliver({ ...h, url: URL_OK, body: '{}', ...base });
    expect(logs.map((l) => [l.status, l.error, l.detail])).toEqual([
      [0, 'network_error', 'socket hang up'],
      [0, 'network_error', 'timeout after 10000 ms'],
      [201, undefined, undefined],
    ]);
    expect(h.sleeps).toEqual([2_000, 8_000]);
  });

  it('does not retry 4xx; a 403 is a host the admin has not authorized', async () => {
    const h403 = harness([403]);
    const denied = await deliver({ ...h403, url: 'https://webhook.site/abc', body: '{}', ...base });
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ status: 403, error: 'host_not_authorized', attempt: 1 });
    const h404 = harness([404]);
    const missing = await deliver({ ...h404, url: URL_OK, body: '{}', ...base });
    expect(missing).toHaveLength(1);
    expect(missing[0].error).toBe('http_404');
    expect(h403.sleeps.concat(h404.sleeps)).toEqual([]);
  });

  it('refuses non-https URLs without sending', async () => {
    for (const url of ['http://hooks.slack.com/x', 'ftp://x', 'hooks.slack.com/x', 'https://', '']) {
      const h = harness([]);
      const logs = await deliver({ ...h, url, body: '{}', endpointId: 'ep', event: 'test' });
      expect(logs).toEqual([{ endpointId: 'ep', event: 'test', status: 0, attempt: 1, at: new Date(T0).toISOString(), kind: 'notify', error: 'invalid_url', detail: 'webhook URLs must be https://' }]);
      expect(h.posts).toHaveLength(0);
    }
  });

  it('honours kind, custom timeout and custom backoff; omits incidentId when not given', async () => {
    const h = harness([500, 200]);
    const logs = await deliver({ ...h, url: URL_OK, body: '{}', endpointId: 'demo', event: 'demo', kind: 'demo', timeoutMs: 1_234, backoffMs: [5] });
    expect(logs.map((l) => [l.kind, l.status, 'incidentId' in l])).toEqual([
      ['demo', 500, false],
      ['demo', 200, false],
    ]);
    expect(h.posts.map((p) => p.timeoutMs)).toEqual([1_234, 1_234]);
    expect(h.sleeps).toEqual([5]);
    const none = harness([500, 500]);
    expect(await deliver({ ...none, url: URL_OK, body: '{}', ...base, backoffMs: [] })).toHaveLength(1);
  });

  it('uses a real timer when no sleep is injected', async () => {
    const h = harness([500, 200]);
    const logs = await deliver({ sender: h.sender, clock: h.clock, url: URL_OK, body: '{}', ...base, backoffMs: [1] });
    expect(logs.map((l) => l.status)).toEqual([500, 200]);
  });

  it('policy constants match SPEC 12.3', () => {
    expect(WEBHOOK_TIMEOUT_MS).toBe(10_000);
    expect(WEBHOOK_BACKOFF_MS).toEqual([2_000, 8_000]);
    expect(classifyStatus(204)).toEqual({ ok: true, retry: false });
    expect(classifyStatus(429)).toEqual({ ok: false, retry: false, error: 'http_429' });
    expect(lastAttempt([])).toBeUndefined();
  });
});

describe('createFetchWebhookSender', () => {
  function recorder(reply: (init?: FetchInit) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>) {
    const calls: { url: string; init?: FetchInit; self: unknown }[] = [];
    const fetch: FetchLike = function (this: unknown, url, init) {
      calls.push({ url, init, self: this });
      return reply(init);
    };
    return { fetch, calls };
  }

  it('POSTs JSON with only a content-type header, bound to globalThis', async () => {
    const r = recorder(async () => ({ status: 200, ok: true, text: async () => 'ok' }));
    const res = await createFetchWebhookSender(r.fetch).post(URL_OK, '{"a":1}', 10_000);
    expect(res).toEqual({ status: 200 });
    expect(r.calls[0].url).toBe(URL_OK);
    expect(r.calls[0].init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(Object.keys(r.calls[0].init?.headers ?? {})).toEqual(['content-type']); // never an auth header
    expect(r.calls[0].self).toBe(globalThis);
  });

  it('returns HTTP errors as statuses and ignores an unreadable body', async () => {
    const r = recorder(async () => ({ status: 403, ok: false, text: async () => Promise.reject(new Error('stream closed')) }));
    expect(await createFetchWebhookSender(r.fetch).post(URL_OK, '{}', 10_000)).toEqual({ status: 403 });
  });

  it('maps a rejected fetch to status 0 with the error', async () => {
    const r = recorder(async () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await createFetchWebhookSender(r.fetch).post(URL_OK, '{}', 10_000)).toEqual({ status: 0, error: 'Failed to fetch' });
    const s = recorder(async () => Promise.reject('weird'));
    expect(await createFetchWebhookSender(s.fetch).post(URL_OK, '{}', 10_000)).toEqual({ status: 0, error: 'weird' });
  });

  it('times out, aborting the request, even if fetch ignores the signal', async () => {
    let aborted = false;
    const r = recorder(
      (init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    );
    expect(await createFetchWebhookSender(r.fetch).post(URL_OK, '{}', 20)).toEqual({ status: 0, error: 'timeout after 20 ms' });
    expect(aborted).toBe(true);
    const deaf: FetchLike = () => new Promise(() => undefined);
    expect(await createFetchWebhookSender(deaf).post(URL_OK, '{}', 15)).toEqual({ status: 0, error: 'timeout after 15 ms' });
  });

  it('drives deliver() end to end', async () => {
    const statuses = [503, 200];
    const r = recorder(async () => {
      const status = statuses.shift() as number;
      return { status, ok: status < 300, text: async () => '' };
    });
    const logs = await deliver({
      sender: createFetchWebhookSender(r.fetch),
      url: URL_OK,
      body: { event: 'test' },
      clock: { now: () => T0 },
      sleep: async () => undefined,
      endpointId: 'ep',
      event: 'test',
    });
    expect(logs.map((l) => l.status)).toEqual([503, 200]);
    expect(r.calls).toHaveLength(2);
  });
});
