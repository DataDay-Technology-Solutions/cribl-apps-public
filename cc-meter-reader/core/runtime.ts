// core/runtime.ts — the two runtimes' dependency builders (DECISIONS D11, D12b, D15).
//
//   createBrowserDeps(env, opts)  the App tab (runtime 'ui'): every call is a fetch to window.CRIBL_API_URL,
//                                 which the platform proxies with the member's auth; KV at
//                                 `${CRIBL_API_URL}/kvstore/<key>`; webhooks are full-URL fetches the platform
//                                 routes through the App's proxy.
//   createBackendDeps(opts)       an App backend function (runtime 'backend'): relative `/api/v1` fetches,
//                                 KV at `/api/v1/kvstore/<key>`.
//
// Still pure: no DOM or Node types. The environment is passed in (or read from globalThis at CALL time, never
// at module load — `apps build` evaluates backend bundles' top level during the build).

import type { Build, Logger } from './types.ts';
import { detectCodec } from './codec.ts';
import { createFetchHttp, type FetchLike } from './http.ts';
import { createFetchKvStore } from './kv.ts';
import { createFetchWebhookSender } from './adapters/webhook.ts';
import type { SweepDeps } from './sweep.ts';
import type { LeverDeps } from './demo/levers.ts';

/** The App id (package name); the platform mounts the UI under it. */
export const APP_ID = 'meter-reader';
/** Backend functions reach the Cribl API (and their app-scoped KV) at this relative base (D15). */
export const BACKEND_API_BASE = '/api/v1';

/** The slice of `window` the browser runtime reads. */
export interface BrowserEnv {
  CRIBL_API_URL?: string;
  CRIBL_BASE_PATH?: string;
  fetch?: FetchLike;
  crypto?: { randomUUID?: () => string };
}

export interface RuntimeOptions {
  appVersion: string;
  build: Build;
  /** lock/meter owner; default a fresh per-tab / per-invocation id. */
  owner?: string;
  /** Payload `workspace`; default derived from the Leader host. */
  workspace?: string;
  /** Ledger deep-link base; default the Leader origin + the App's base path. */
  linkBase?: string;
  logger?: Logger;
  budget?: number;
}

export interface BackendOptions extends Partial<RuntimeOptions> {
  /** Defaults to globalThis.fetch, looked up when this is called. */
  fetch?: FetchLike;
  /** The request URL, used to derive workspace and linkBase when they are not given. */
  requestUrl?: string;
}

/** Console-backed logger with a prefix (the backend's console goes to app-backend.log). */
export function createConsoleLogger(prefix = '[meter-reader]'): Logger {
  const c = (
    globalThis as {
      console?: {
        info(...a: unknown[]): void;
        warn(...a: unknown[]): void;
        error(...a: unknown[]): void;
      };
    }
  ).console;
  const emit = (level: 'info' | 'warn' | 'error') => (msg: string, data?: unknown) => {
    if (!c) return;
    if (data === undefined) c[level](`${prefix} ${msg}`);
    else c[level](`${prefix} ${msg}`, data);
  };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** A random id for the KV lock (`ui:…` per tab, `backend:…` per invocation). */
export function createOwnerId(
  prefix: string,
  env: { crypto?: { randomUUID?: () => string } } = globalThis as {
    crypto?: { randomUUID?: () => string };
  },
): string {
  const uuid = env.crypto?.randomUUID?.();
  return `${prefix}:${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}

/** Parses an absolute URL's origin and host without the URL API (portable). */
function originOf(url: string | undefined): { origin: string; host: string } | undefined {
  const m = /^(https?):\/\/([^/?#]+)/i.exec((url ?? '').trim());
  if (!m) return undefined;
  const host = m[2]
    .replace(/^[^@]*@/, '')
    .replace(/:\d+$/, '')
    .toLowerCase();
  return {
    origin: `${m[1].toLowerCase()}://${m[2].replace(/^[^@]*@/, '')}`,
    host,
  };
}

/**
 * The workspace a Leader host serves: `main-example-org.cribl.cloud` → `main-example-org`
 * (workspace + org, which is how Cribl.Cloud names it in the UI). Other hosts are returned as-is.
 */
export function workspaceFromUrl(url: string | undefined): string {
  const o = originOf(url);
  if (!o) return '';
  const cloud = /^([^.]+)\.cribl(?:-staging)?\.cloud$/.exec(o.host);
  return cloud ? cloud[1] : o.host;
}

/** `https://<leader>` + the App's base path (e.g. `/app-ui/meter-reader`), the Ledger deep-link base. */
export function linkBaseFrom(apiUrl: string | undefined, basePath: string | undefined): string {
  const o = originOf(apiUrl);
  if (!o) return (basePath ?? '').replace(/\/+$/, '');
  const path = (basePath && basePath.trim() !== '' ? basePath : `/app-ui/${APP_ID}`).replace(/\/+$/, '');
  return `${o.origin}${path.startsWith('/') ? path : `/${path}`}`;
}

function globalFetch(): FetchLike | undefined {
  const f = (globalThis as { fetch?: unknown }).fetch;
  return typeof f === 'function' ? (f as FetchLike) : undefined;
}

/** SweepDeps for the App tab (runtime 'ui'). Throws when CRIBL_API_URL is not set (outside Cribl / mock mode). */
export function createBrowserDeps(env: BrowserEnv, opts: RuntimeOptions): SweepDeps {
  const baseUrl = (env.CRIBL_API_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('CRIBL_API_URL is not set: the ui runtime runs only inside Cribl (or in mock mode).');
  const fetchFn = env.fetch ?? globalFetch();
  if (!fetchFn) throw new Error('fetch is not available in this environment');
  const deps: SweepDeps = {
    http: createFetchHttp({ fetch: fetchFn, baseUrl }),
    kv: createFetchKvStore({ fetch: fetchFn, baseUrl }),
    webhook: createFetchWebhookSender(fetchFn),
    clock: { now: () => Date.now() },
    codec: detectCodec(),
    logger: opts.logger ?? createConsoleLogger(),
    owner: opts.owner ?? createOwnerId('ui', env),
    appVersion: opts.appVersion,
    build: opts.build,
    runtime: 'ui',
    workspace: opts.workspace ?? workspaceFromUrl(baseUrl),
    linkBase: opts.linkBase ?? linkBaseFrom(baseUrl, env.CRIBL_BASE_PATH),
  };
  if (opts.budget !== undefined) deps.budget = opts.budget;
  return deps;
}

/** SweepDeps for an App backend function (runtime 'backend'). Call inside `onRequest`, never at module scope. */
export function createBackendDeps(opts: BackendOptions = {}): SweepDeps {
  const fetchFn = opts.fetch ?? globalFetch();
  if (!fetchFn) throw new Error('fetch is not available in this environment');
  const deps: SweepDeps = {
    http: createFetchHttp({ fetch: fetchFn, baseUrl: BACKEND_API_BASE }),
    kv: createFetchKvStore({ fetch: fetchFn, baseUrl: BACKEND_API_BASE }),
    webhook: createFetchWebhookSender(fetchFn),
    clock: { now: () => Date.now() },
    codec: detectCodec(),
    logger: opts.logger ?? createConsoleLogger(),
    owner: opts.owner ?? createOwnerId('backend'),
    appVersion: opts.appVersion ?? '0.0.0',
    build: opts.build ?? 'release',
    runtime: 'backend',
    workspace: opts.workspace ?? workspaceFromUrl(opts.requestUrl),
    linkBase: opts.linkBase ?? linkBaseFrom(opts.requestUrl, undefined),
  };
  if (opts.budget !== undefined) deps.budget = opts.budget;
  return deps;
}

/** LeverDeps from a runtime's SweepDeps plus the member pulling the lever. */
export function leverDepsFrom(
  deps: SweepDeps,
  author: string,
  extra: Partial<Pick<LeverDeps, 'groupId' | 'minuteBudget'>> = {},
): LeverDeps {
  const out: LeverDeps = {
    http: deps.http,
    kv: deps.kv,
    clock: deps.clock,
    codec: deps.codec,
    logger: deps.logger,
    author,
    owner: deps.owner,
    ...extra,
  };
  if (deps.sleep) out.sleep = deps.sleep;
  return out;
}
