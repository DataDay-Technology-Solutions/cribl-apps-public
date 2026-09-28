import { describe, expect, it } from 'vitest';
import type { CriblHttp, HttpResult } from '../../core/types.ts';
import {
  BudgetExceeded,
  createCountingHttp,
  createFetchHttp,
  DEFAULT_TIMEOUT_MS,
  networkFailure,
  RateLimited,
  type FetchInit,
  type FetchLike,
  type FetchResponseLike,
} from '../../core/http.ts';

const clock = (start = 1_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};

/** A CriblHttp that answers from a queue of statuses and records every call. */
function scripted(statuses: number[]): CriblHttp & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async request(method, path) {
      seen.push(`${method} ${path}`);
      const status = statuses.length > 0 ? (statuses.shift() as number) : 200;
      return { status, ok: status >= 200 && status < 300, json: { status } };
    },
  };
}

function response(status: number, text: string, headers: Record<string, string> = {}): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    headers: { forEach: (cb) => Object.entries(headers).forEach(([k, v]) => cb(v, k)) },
  };
}

describe('createCountingHttp', () => {
  it('counts every call and reports stats', async () => {
    const c = clock();
    const inner = scripted([200, 404, 500]);
    const http = createCountingHttp(inner, { clock: c });
    await http.request('GET', '/a');
    await http.request('GET', '/b');
    c.advance(250);
    const res = await http.request('POST', '/c', { x: 1 });
    expect(res.status).toBe(500); // statuses are returned, never thrown
    expect(http.calls()).toBe(3);
    expect(http.remaining()).toBe(Number.POSITIVE_INFINITY);
    expect(http.stats()).toEqual({ calls: 3, budget: undefined, retries: 0, rateLimitHits: 0, elapsedMs: 250 });
  });

  it('throws BudgetExceeded before a call that would exceed the budget', async () => {
    const inner = scripted([]);
    const http = createCountingHttp(inner, { budget: 2, clock: clock() });
    await http.request('GET', '/1');
    expect(http.remaining()).toBe(1);
    await http.request('GET', '/2');
    const err = await http.request('GET', '/3').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceeded);
    expect(err).toMatchObject({ budget: 2, calls: 2, method: 'GET', path: '/3' });
    expect(inner.seen).toEqual(['GET /1', 'GET /2']); // the refused call never went out
    expect(http.remaining()).toBe(0);
  });

  it('on a 429 waits 5 s and retries that call once; the retry counts as a call', async () => {
    const inner = scripted([429, 200]);
    const sleeps: number[] = [];
    const http = createCountingHttp(inner, { clock: clock(), sleep: async (ms) => void sleeps.push(ms) });
    const res = await http.request('GET', '/kvstore/meta', undefined, { raw: true });
    expect(res.status).toBe(200);
    expect(sleeps).toEqual([5_000]);
    expect(inner.seen).toEqual(['GET /kvstore/meta', 'GET /kvstore/meta']);
    expect(http.calls()).toBe(2);
    expect(http.stats()).toMatchObject({ retries: 1, rateLimitHits: 1 });
  });

  it('throws RateLimited when the retry is also 429', async () => {
    const inner = scripted([429, 429]);
    const http = createCountingHttp(inner, { clock: clock(), sleep: async () => undefined });
    await expect(http.request('GET', '/x')).rejects.toBeInstanceOf(RateLimited);
    expect(http.stats()).toMatchObject({ calls: 2, rateLimitHits: 2 });
  });

  it('throws RateLimited on a second 429 later in the same counter, without retrying', async () => {
    const inner = scripted([429, 200, 200, 429]);
    const sleeps: number[] = [];
    const http = createCountingHttp(inner, { clock: clock(), sleep: async (ms) => void sleeps.push(ms) });
    await http.request('GET', '/1');
    await http.request('GET', '/2');
    const err = await http.request('PUT', '/3').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimited);
    expect(err).toMatchObject({ method: 'PUT', path: '/3' });
    expect(sleeps).toEqual([5_000]);
    expect(http.calls()).toBe(4);
  });

  it('the retry respects the budget', async () => {
    const inner = scripted([429]);
    const http = createCountingHttp(inner, { budget: 1, clock: clock(), sleep: async () => undefined });
    await expect(http.request('GET', '/x')).rejects.toBeInstanceOf(BudgetExceeded);
  });

  it('reset() zeroes calls and forgets the 429', async () => {
    const c = clock();
    const inner = scripted([429, 200, 429, 200]);
    const http = createCountingHttp(inner, { budget: 5, clock: c, sleep: async () => undefined, retryDelayMs: 1 });
    await http.request('GET', '/1');
    c.advance(10);
    http.reset();
    expect(http.calls()).toBe(0);
    expect(http.stats()).toMatchObject({ retries: 0, rateLimitHits: 0, elapsedMs: 0 });
    const res = await http.request('GET', '/2'); // a fresh counter may retry again
    expect(res.status).toBe(200);
    expect(http.calls()).toBe(2);
  });

  it('counts a call whose transport throws', async () => {
    const http = createCountingHttp({ request: async () => Promise.reject(new Error('boom')) }, { clock: clock() });
    await expect(http.request('GET', '/x')).rejects.toThrow('boom');
    expect(http.calls()).toBe(1);
  });

  it('uses a real timer by default', async () => {
    const inner = scripted([429, 200]);
    const http = createCountingHttp(inner, { clock: clock(), retryDelayMs: 5 });
    expect((await http.request('GET', '/x')).status).toBe(200);
  });
});

describe('createFetchHttp', () => {
  function recorder(reply: (url: string, init?: FetchInit) => Promise<FetchResponseLike>) {
    const calls: { url: string; init?: FetchInit; self: unknown }[] = [];
    const fetch: FetchLike = function (this: unknown, url, init) {
      calls.push({ url, init, self: this });
      return reply(url, init);
    };
    return { fetch, calls };
  }

  it('joins the base URL, sends JSON bodies as application/json and parses JSON answers', async () => {
    const r = recorder(async () => response(200, '{"items":[1],"count":1}', { 'Content-Type': 'application/json' }));
    const http = createFetchHttp({ fetch: r.fetch, baseUrl: 'https://leader.example/api/v1/' });
    const res = await http.request('POST', '/system/metrics/query', { where: 'x' });
    expect(r.calls[0].url).toBe('https://leader.example/api/v1/system/metrics/query');
    expect(r.calls[0].init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"where":"x"}' });
    expect(r.calls[0].init?.signal).toBeDefined();
    expect(res).toEqual({ status: 200, ok: true, json: { items: [1], count: 1 }, headers: { 'content-type': 'application/json' } });
  });

  it('invokes fetch with globalThis as the receiver (locked iframe fetch)', async () => {
    const r = recorder(async () => response(200, ''));
    const http = createFetchHttp({ fetch: r.fetch, baseUrl: '/api/v1' });
    await http.request('GET', 'relative/path');
    expect(r.calls[0].self).toBe(globalThis);
    expect(r.calls[0].url).toBe('/api/v1/relative/path');
  });

  it('raw: sends a string verbatim as text/plain and returns text without parsing', async () => {
    const r = recorder(async () => response(201, '{"not":"parsed"}'));
    const http = createFetchHttp({ fetch: r.fetch, baseUrl: '/api/v1' });
    const res = await http.request('PUT', '/kvstore/meta', '{"a":1}', { raw: true });
    expect(r.calls[0].init).toMatchObject({ method: 'PUT', headers: { 'content-type': 'text/plain' }, body: '{"a":1}' });
    expect(res.text).toBe('{"not":"parsed"}');
    expect(res.json).toBeUndefined();
  });

  it('raw with a non-string body still JSON-encodes it; no body means no content-type', async () => {
    const r = recorder(async () => response(200, ''));
    const http = createFetchHttp({ fetch: r.fetch, baseUrl: '' });
    await http.request('POST', '/kvstore/keys', { prefix: 'roll/' }, { raw: true });
    await http.request('GET', '/x');
    expect(r.calls[0].init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(r.calls[0].init?.body).toBe('{"prefix":"roll/"}');
    expect(r.calls[1].init?.headers).toEqual({});
    expect(r.calls[1].init?.body).toBeUndefined();
  });

  it('never throws on an HTTP error status and falls back to text for non-JSON bodies', async () => {
    const r = recorder(async () => response(502, '<html>Bad gateway</html>'));
    const http = createFetchHttp({ fetch: r.fetch, baseUrl: '' });
    const res = await http.request('GET', '/x');
    expect(res).toMatchObject({ status: 502, ok: false, text: '<html>Bad gateway</html>' });
    expect(networkFailure(res)).toBeNull();
  });

  it('keeps an empty body (KV PUT 201) as empty text', async () => {
    const r = recorder(async () => response(201, ''));
    const res = await createFetchHttp({ fetch: r.fetch, baseUrl: '' }).request('PUT', '/k', { a: 1 });
    expect(res).toMatchObject({ status: 201, ok: true, text: '' });
  });

  it('tolerates responses without headers', async () => {
    const fetch: FetchLike = async () => ({ status: 200, ok: true, text: async () => '1' });
    const res = await createFetchHttp({ fetch, baseUrl: '' }).request('GET', '/x');
    expect(res).toEqual({ status: 200, ok: true, json: 1 });
  });

  it('returns status 0 with a network_error marker when fetch rejects', async () => {
    const r = recorder(async () => Promise.reject(new TypeError('Failed to fetch')));
    const res = await createFetchHttp({ fetch: r.fetch, baseUrl: '' }).request('GET', '/x');
    expect(res.status).toBe(0);
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/^network_error: Failed to fetch/);
    expect(networkFailure(res)).toBe('network');
    const odd = await createFetchHttp({ fetch: async () => Promise.reject('plain string'), baseUrl: '' }).request('GET', '/y');
    expect(odd.text).toBe('network_error: plain string');
  });

  it('times out (default 25 s, overridable per call), aborting the request', async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(25_000);
    let aborted = false;
    const r = recorder(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    );
    const http = createFetchHttp({ fetch: r.fetch, baseUrl: '', timeoutMs: 10_000 });
    const res = await http.request('GET', '/slow', undefined, { timeoutMs: 20 });
    expect(res.status).toBe(0);
    expect(res.text).toMatch(/^timeout: no response from GET \/slow within 20 ms/);
    expect(networkFailure(res)).toBe('timeout');
    expect(aborted).toBe(true);
  });

  it('times out even when fetch ignores the AbortSignal', async () => {
    const fetch: FetchLike = () => new Promise(() => undefined);
    const res = await createFetchHttp({ fetch, baseUrl: '', timeoutMs: 15 }).request('GET', '/hang');
    expect(networkFailure(res)).toBe('timeout');
  });

  it('networkFailure only flags status 0', () => {
    const ok: HttpResult = { status: 200, ok: true };
    expect(networkFailure(ok)).toBeNull();
    expect(networkFailure({ status: 0, ok: false })).toBe('network');
  });
});
