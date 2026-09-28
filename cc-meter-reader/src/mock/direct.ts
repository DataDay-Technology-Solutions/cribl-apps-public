// src/mock/direct.ts — the emulator as core I/O objects, with no fetch and no MSW.
//
// For unit/integration tests and the 2,000-flow bench: `runSweep()` gets a CriblHttp, KvStore and
// WebhookSender (core/types.ts) that answer from the same emulator the browser uses, at in-process
// speed, and every call lands in the emulator's journal so request budgets can be asserted.

import type { CriblHttp, HttpResult, KvStore, WebhookSender } from '../../core/types.ts';
import { createMemoryStore, type MockStore } from './store.ts';
import { CriblEmulator } from './emulator.ts';
import { MOCK_API_BASE, type ControlAction, type MockOptions, type MockPreset } from './types.ts';

export interface EmulatorSetup {
  /** wall clock (epoch ms) — inject a fixed or stepping clock for deterministic tests */
  clock?: () => number;
  store?: MockStore;
  preset?: MockPreset;
  seed?: number;
  /** scale preset: number of flows */
  flows?: number;
  options?: Partial<MockOptions>;
  apiPrefixes?: string[];
}

/**
 * A fresh emulator over its own memory store (a new, empty org every call). Unlike the browser emulator it
 * models a Leader WITHOUT Cribl.Cloud's notification APIs unless `options.notificationApis` is true: the sweep
 * and integration suites pin exact call and delivery counts from before the bell existed in the emulator.
 */
export function createEmulator(setup: EmulatorSetup = {}): CriblEmulator {
  const emulator = new CriblEmulator({
    store: setup.store ?? createMemoryStore(),
    ...(setup.clock ? { clock: setup.clock } : {}),
    apiPrefixes: setup.apiPrefixes ?? [MOCK_API_BASE, '/api/v1'],
  });
  const options: Partial<MockOptions> = { notificationApis: false, ...(setup.options ?? {}) };
  const reset: ControlAction = { action: 'reset', preset: setup.preset ?? 'demo', seed: setup.seed ?? 42, ...(setup.flows ? { flows: setup.flows } : {}), options };
  emulator.control(reset);
  return emulator;
}

/**
 * CriblHttp over the emulator. Mirrors core/http.ts `createFetchHttp`: `raw` string bodies go out as
 * text/plain, everything else as JSON; responses are parsed as JSON unless `raw` or empty.
 */
export function createDirectHttp(emulator: CriblEmulator, base: string = MOCK_API_BASE): CriblHttp {
  return {
    async request(method, path, body, opts) {
      const raw = opts?.raw === true;
      const headers: Record<string, string> = {};
      let payload: string | null = null;
      if (body !== undefined) {
        if (raw && typeof body === 'string') {
          headers['content-type'] = 'text/plain';
          payload = body;
        } else {
          headers['content-type'] = 'application/json';
          payload = JSON.stringify(body);
        }
      }
      const res = await emulator.handle({ method, url: base.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`), headers, body: payload });
      const text = res.body ?? '';
      const result: HttpResult = { status: res.status, ok: res.status >= 200 && res.status < 300, headers: { ...res.headers } };
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
    },
  };
}

export class DirectKvError extends Error {
  status: number;
  constructor(op: string, key: string, status: number, body: string) {
    super(`KV ${op} ${key} failed: HTTP ${status} ${body.slice(0, 120)}`);
    this.name = 'DirectKvError';
    this.status = status;
  }
}

/** App-scoped KV over the emulator, with the platform's semantics (text/plain values, 413 over 100 KB). */
export function createDirectKv(emulator: CriblEmulator, base: string = MOCK_API_BASE): KvStore {
  const http = createDirectHttp(emulator, base);
  const path = (key: string): string => `/kvstore/${key.split('/').map(encodeURIComponent).join('/')}`;
  return {
    async get(key) {
      const r = await http.request('GET', path(key), undefined, { raw: true });
      if (r.status === 404) return null;
      if (!r.ok) throw new DirectKvError('GET', key, r.status, r.text ?? '');
      return r.text ?? '';
    },
    async put(key, value) {
      const r = await http.request('PUT', path(key), value, { raw: true });
      if (!r.ok) throw new DirectKvError('PUT', key, r.status, r.text ?? '');
    },
    async del(key) {
      const r = await http.request('DELETE', path(key), undefined, { raw: true });
      if (r.status !== 404 && !r.ok) throw new DirectKvError('DELETE', key, r.status, r.text ?? '');
    },
    async list(prefix) {
      const r = await http.request('POST', '/kvstore/keys', { prefix });
      if (!r.ok) throw new DirectKvError('LIST', prefix, r.status, r.text ?? '');
      return Array.isArray(r.json) ? (r.json as string[]) : [];
    },
  };
}

/** Webhook POSTs into the emulator's sink (sink hosts answer 200; any other host 403 host_not_authorized). */
export function createDirectWebhook(emulator: CriblEmulator): WebhookSender {
  return {
    async post(url, body) {
      try {
        const res = await emulator.handle({ method: 'POST', url, headers: { 'content-type': 'application/json' }, body });
        return res.status === 403 ? { status: 403, error: 'host_not_authorized' } : { status: res.status };
      } catch (e) {
        return { status: 0, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
