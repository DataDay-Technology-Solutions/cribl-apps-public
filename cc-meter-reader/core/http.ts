// core/http.ts — the Leader API transport and the per-sweep request counter.
//
// Two layers, both implementing `CriblHttp` from core/types.ts:
//   • createFetchHttp: CriblHttp over an injected `fetch` (UI: window.fetch with CRIBL_API_URL; backend:
//     the runtime fetch with '/api/v1'). Never throws on an HTTP status or a network failure — it returns
//     `{ status, ok, json | text }`, with status 0 for network errors and timeouts.
//   • createCountingHttp: wraps any CriblHttp, counts every call (KV included, when the KV store is built on
//     the same transport — see createHttpKvStore in core/kv.ts), enforces the sweep budget and applies the
//     SPEC 7 step 13 rule: on HTTP 429 wait and retry once — the Leader's Retry-After when it sends one (at most
//     60 s; a longer one is not waited for), else 5 s; a second 429 in the same counter stops the sweep with
//     RateLimited (EPIC_AUDIT P1-E01).

import type { Clock, CriblHttp, HttpResult } from './types.ts';

export type HttpMethod = Parameters<CriblHttp['request']>[0];
export interface RequestOpts {
  timeoutMs?: number;
  /** Send a string body verbatim as text/plain and return the response as text without JSON parsing. */
  raw?: boolean;
}

// ─── Errors ──────────────────────────────────────────────────────────────────
/** Thrown before a call that would push the counter past its budget. The call is not made. */
export class BudgetExceeded extends Error {
  readonly budget: number;
  readonly calls: number;
  readonly method: HttpMethod;
  readonly path: string;
  constructor(budget: number, calls: number, method: HttpMethod, path: string) {
    super(`Leader API budget of ${budget} calls exhausted (${calls} used); refused ${method} ${path}`);
    this.name = 'BudgetExceeded';
    this.budget = budget;
    this.calls = calls;
    this.method = method;
    this.path = path;
  }
}

/** Thrown on the second HTTP 429 seen by one counter (SPEC 7 step 13): stop calling, try next minute. */
export class RateLimited extends Error {
  readonly method: HttpMethod;
  readonly path: string;
  /** How long the Leader asked to wait (its last Retry-After), when it said. */
  readonly retryAfterMs: number | undefined;
  constructor(method: HttpMethod, path: string, retryAfterMs?: number) {
    super(`Rate limited by the Leader (second 429 this sweep) on ${method} ${path}`);
    this.name = 'RateLimited';
    this.method = method;
    this.path = path;
    this.retryAfterMs = retryAfterMs;
  }
}

// ─── Retry-After ─────────────────────────────────────────────────────────────
/** The longest Retry-After a sweep waits out in place (EPIC_AUDIT P1-E01); a longer one stops it at once. */
export const RETRY_AFTER_MAX_MS = 60_000;

/**
 * A Retry-After value in ms: delta-seconds ("40") or an HTTP date, measured from `nowMs`. Undefined when absent or
 * unreadable; never negative.
 */
export function parseRetryAfter(value: string | undefined | null, nowMs: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const v = value.trim();
  if (v === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

/** Retry-After of an HTTP answer (headers are lower-cased by every transport here) or of a thrown KV error. */
export function retryAfterOf(source: unknown, nowMs: number): number | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  const s = source as { headers?: Record<string, string>; retryAfterMs?: unknown };
  if (typeof s.retryAfterMs === 'number' && Number.isFinite(s.retryAfterMs)) return Math.max(0, s.retryAfterMs);
  const h = s.headers;
  if (!h) return undefined;
  return parseRetryAfter(h['retry-after'] ?? h['Retry-After'], nowMs);
}

/**
 * How long to wait before the one 429 retry: the Leader's Retry-After (at least 1 s), else `fallbackMs`.
 * Undefined when Retry-After asks for more than RETRY_AFTER_MAX_MS: no retry then, the caller stops.
 */
export function retryWaitMs(retryAfterMs: number | undefined, fallbackMs: number): number | undefined {
  if (retryAfterMs === undefined) return fallbackMs;
  if (retryAfterMs > RETRY_AFTER_MAX_MS) return undefined;
  return Math.max(1_000, retryAfterMs);
}

// ─── Counting wrapper ────────────────────────────────────────────────────────
export interface CountingStats {
  calls: number;
  budget?: number;
  /** 429s answered with the one allowed retry. */
  retries: number;
  /** 429s seen in total (the second one also throws RateLimited). */
  rateLimitHits: number;
  /** ms since creation or the last reset(), by the injected clock. */
  elapsedMs: number;
}

export interface CountingHttp extends CriblHttp {
  /** Calls made since creation or the last reset() — retries included. */
  calls(): number;
  /** Calls still allowed before BudgetExceeded (Infinity without a budget). */
  remaining(): number;
  /** Zeroes the call count and forgets any 429 seen. */
  reset(): void;
  stats(): CountingStats;
}

export interface CountingOptions {
  /** Max calls per counter (per sweep). Omit for "count only". */
  budget?: number;
  clock: Clock;
  /** Injectable for tests; defaults to a setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Wait before the single 429 retry. SPEC 7 step 13: 5 s. */
  retryDelayMs?: number;
}

export const RATE_LIMIT_RETRY_MS = 5_000;

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCountingHttp(inner: CriblHttp, opts: CountingOptions): CountingHttp {
  const { budget, clock } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const retryDelayMs = opts.retryDelayMs ?? RATE_LIMIT_RETRY_MS;
  let calls = 0;
  let retries = 0;
  let rateLimitHits = 0;
  let startedAt = clock.now();

  async function attempt(method: HttpMethod, path: string, body?: unknown, reqOpts?: RequestOpts): Promise<HttpResult> {
    if (budget !== undefined && calls + 1 > budget) throw new BudgetExceeded(budget, calls, method, path);
    calls++;
    return inner.request(method, path, body, reqOpts);
  }

  return {
    async request(method, path, body, reqOpts) {
      const first = await attempt(method, path, body, reqOpts);
      if (first.status !== 429) return first;
      rateLimitHits++;
      const after = retryAfterOf(first, clock.now());
      if (rateLimitHits > 1) throw new RateLimited(method, path, after);
      const wait = retryWaitMs(after, retryDelayMs);
      if (wait === undefined) throw new RateLimited(method, path, after);
      retries++;
      await sleep(wait);
      const second = await attempt(method, path, body, reqOpts);
      if (second.status === 429) {
        rateLimitHits++;
        throw new RateLimited(method, path, retryAfterOf(second, clock.now()));
      }
      return second;
    },
    calls: () => calls,
    remaining: () => (budget === undefined ? Number.POSITIVE_INFINITY : Math.max(0, budget - calls)),
    reset() {
      calls = 0;
      retries = 0;
      rateLimitHits = 0;
      startedAt = clock.now();
    },
    stats: () => ({ calls, budget, retries, rateLimitHits, elapsedMs: clock.now() - startedAt }),
  };
}

// ─── Fetch transport ─────────────────────────────────────────────────────────
/** The subset of RequestInit this module sends. The platform `fetch` accepts it as-is. */
export interface FetchInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** 'error' for a direct webhook: a redirect is never followed to a URL nobody configured. */
  redirect?: 'error' | 'follow' | 'manual';
}
/** The subset of Response this module reads. */
export interface FetchResponseLike {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  headers?: { forEach(callback: (value: string, key: string) => void): void };
}
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponseLike>;

export interface FetchHttpOptions {
  fetch: FetchLike;
  /** e.g. window.CRIBL_API_URL in the UI, '/api/v1' in the backend. Paths are appended verbatim. */
  baseUrl: string;
  /** Default 25 s: the platform UI proxy drops requests at 30 s. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 25_000;
/** Prefix of `text` on a status-0 result, so callers can tell a timeout from a dropped connection. */
export const TIMEOUT_PREFIX = 'timeout:';
export const NETWORK_ERROR_PREFIX = 'network_error:';

/** 'timeout' | 'network' for a status-0 result produced by createFetchHttp, else null. */
export function networkFailure(res: HttpResult): 'timeout' | 'network' | null {
  if (res.status !== 0) return null;
  if (res.text?.startsWith(TIMEOUT_PREFIX)) return 'timeout';
  return 'network';
}

/**
 * Calls `fetch` with `this` bound to globalThis. The App iframe's fetch is a locked platform proxy; a
 * detached reference invoked with another receiver can throw "Illegal invocation".
 */
function callFetch(fetchFn: FetchLike, url: string, init: FetchInit): Promise<FetchResponseLike> {
  return Reflect.apply(fetchFn, globalThis, [url, init]) as Promise<FetchResponseLike>;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return path.startsWith('/') ? base + path : `${base}/${path}`;
}

function collectHeaders(res: FetchResponseLike): Record<string, string> | undefined {
  if (!res.headers || typeof res.headers.forEach !== 'function') return undefined;
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export function createFetchHttp(options: FetchHttpOptions): CriblHttp {
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async request(method, path, body, opts) {
      const timeoutMs = opts?.timeoutMs ?? defaultTimeout;
      const raw = opts?.raw === true;
      const init: FetchInit = { method, headers: {} };
      if (body !== undefined) {
        if (raw && typeof body === 'string') {
          init.headers = { 'content-type': 'text/plain' };
          init.body = body;
        } else {
          init.headers = { 'content-type': 'application/json' };
          init.body = JSON.stringify(body);
        }
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      if (controller) init.signal = controller.signal;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      try {
        // The race guarantees the timeout even if an intercepting fetch ignores the AbortSignal.
        const exchange = (async () => {
          const res = await callFetch(options.fetch, joinUrl(options.baseUrl, path), init);
          const text = await res.text();
          return { res, text };
        })();
        exchange.catch(() => undefined); // a late rejection after a timeout must not go unhandled
        const outcome = await Promise.race([exchange, timedOut]);
        if (outcome === 'timeout') {
          controller?.abort();
          return { status: 0, ok: false, text: `${TIMEOUT_PREFIX} no response from ${method} ${path} within ${timeoutMs} ms` };
        }
        const { res, text } = outcome;
        const headers = collectHeaders(res);
        const result: HttpResult = { status: res.status, ok: res.ok };
        if (headers) result.headers = headers;
        if (raw || text.length === 0) {
          result.text = text;
          return result;
        }
        try {
          result.json = JSON.parse(text);
        } catch {
          result.text = text;
        }
        return result;
      } catch (e) {
        return { status: 0, ok: false, text: `${NETWORK_ERROR_PREFIX} ${e instanceof Error ? e.message : String(e)}` };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
