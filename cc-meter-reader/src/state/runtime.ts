// src/state/runtime.ts — THE binding between the UI state layer and core I/O, in the browser.
//
// Everything in src/state codes against the small ports in ports.ts; this file implements them on top
// of core/kv.ts (chunked, validated KV documents), core/codec.ts, core/http.ts, core/settings.ts,
// core/adapters/webhook.ts and core/sweep.ts. A change in one of those signatures is fixed here only.
//
// core/sweep.ts is imported statically, so tsc validates the SweepDeps shape built in `runLocal`.
//
// Transport facts (AGENTS.md, DECISIONS D15): every call goes through `fetch` to window.CRIBL_API_URL,
// which the platform proxies with the member's auth; KV lives at `${CRIBL_API_URL}/kvstore/<key>` and
// backend endpoints at `${CRIBL_API_URL}/endpoints/<name>`.

import type { Clock, Logger, Settings } from '../../core/types.ts';
import { detectCodec } from '../../core/codec.ts';
import { browserTimeZone } from '../lib/zone.ts';
import { createFetchHttp, type FetchLike } from '../../core/http.ts';
import { createFetchKvStore, createKvDocs, type KvDocs } from '../../core/kv.ts';
import { defaultSettings, mergeSettings as mergeStoredSettings } from '../../core/settings.ts';
import { createFetchWebhookSender } from '../../core/adapters/webhook.ts';
import { APP_BUILD_INFO, DEFAULT_RUNTIME, apiBaseUrl } from '../lib/env.ts';
import type { AppDocs, MergeSettings, SweepEngine } from './ports.ts';
import { runSweep, type SweepDeps } from '../../core/sweep.ts';
import { runWeeklyReceipt, type WeeklyResult } from '../../core/weekly.ts';
import { fetchInventory, listWorkerGroups } from '../../core/adapters/config.ts';
import { linkBaseFrom, workspaceFromUrl } from '../../core/runtime.ts';
import { toSummary } from './sweepSummary.ts';

export interface BrowserRuntime {
  docs: AppDocs;
  engine: SweepEngine;
  mergeSettings: MergeSettings;
  /** SPEC 5 defaults with this browser's timezone (captured into KV at the first save). */
  defaultSettings: Settings;
  /** The typed KV layer, for views that need a document the store doesn't hold (timeline, incidents…). */
  kvDocs: KvDocs;
}

const clock: Clock = { now: () => Date.now() };

const logger: Logger = {
  info: (msg, data) => console.info(`[meter-reader] ${msg}`, data ?? ''),
  warn: (msg, data) => console.warn(`[meter-reader] ${msg}`, data ?? ''),
  error: (msg, data) => console.error(`[meter-reader] ${msg}`, data ?? ''),
};

/** Re-exported for callers that already import the runtime (src/lib/zone.ts holds the one definition). */
export { browserTimeZone };

/** The platform's fetch (locked in the App iframe). core/http calls it with the right receiver. */
function platformFetch(): FetchLike {
  return window.fetch as unknown as FetchLike;
}

/** A per-tab id for the KV sweep lock, so two open tabs never meter the same minute twice. */
function createTabId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `ui:${random}`;
}

/** A WeeklyResult from the backend endpoint's JSON, without trusting its shape. */
export function weeklyFromJson(body: unknown, httpError?: string): WeeklyResult {
  const r = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const skipped = r.skipped;
  const out: WeeklyResult = {
    sent: num(r.sent),
    endpoints: num(r.endpoints),
    deliveries: Array.isArray(r.deliveries) ? (r.deliveries as WeeklyResult['deliveries']) : [],
    calls: num(r.calls),
  };
  if (skipped === 'locked' || skipped === 'already_sent' || skipped === 'no_endpoints' || skipped === 'rate_limited' || skipped === 'unavailable' || skipped === 'not_metered') out.skipped = skipped;
  const error = typeof r.error === 'string' ? r.error : httpError;
  if (error !== undefined) out.error = error;
  return out;
}

export function createBrowserRuntime(): BrowserRuntime {
  const baseUrl = apiBaseUrl();
  const fetchFn = platformFetch();
  const codec = detectCodec();

  // UI reads/writes: plain KV over fetch (the sweep builds its own counted transport below).
  const kvDocs = createKvDocs({ kv: createFetchKvStore({ fetch: fetchFn, baseUrl }), codec, clock, logger });

  const tabId = createTabId();
  const http = createFetchHttp({ fetch: fetchFn, baseUrl });
  const kv = createFetchKvStore({ fetch: fetchFn, baseUrl });
  const webhook = createFetchWebhookSender(fetchFn);

  const docs: AppDocs = {
    readSettings: () => kvDocs.getSettings(),
    readPrices: () => kvDocs.getPrices(),
    readSnapshot: () => kvDocs.getSnapshot(),
    readMeta: () => kvDocs.getMeta(),
    readDemoState: () => kvDocs.getDemoState(),
    readInventory: () => kvDocs.getInventory(),
    writeSettings: (doc) => kvDocs.putSettings(doc),
    writePrices: (doc) => kvDocs.putPrices(doc),
    // GETs only (the same config reads the sweep's inventory step makes); nothing is written to KV.
    readLeaderInventory: async () => fetchInventory(http, await listWorkerGroups(http), { clock }),
    // The rollup history behind a custom range (reads only; core/kv.ts reassembles chunked documents).
    rollups: {
      readMinute: (key) => kvDocs.getRollMinute(key),
      readHour: (key) => kvDocs.getRollHour(key),
      readDay: (key) => kvDocs.getRollDay(key),
    },
    // A destination statement's month-by-month totals (reads only).
    readTotals: () => kvDocs.getTotals(),
  };

  const defaults = defaultSettings(new Date(clock.now()).toISOString(), browserTimeZone(), DEFAULT_RUNTIME);
  const mergeSettings: MergeSettings = (stored) => mergeStoredSettings(stored, defaults);
  const origin = { workspace: workspaceFromUrl(baseUrl), linkBase: linkBaseFrom(baseUrl, window.CRIBL_BASE_PATH) };

  const engine: SweepEngine = {
    async runLocal(mode) {
      const started = clock.now();
      // The six browser implementations the sweep is written against (core/types.ts I/O interfaces):
      //   http     CriblHttp over the platform fetch, base CRIBL_API_URL (runSweep counts/caps it)
      //   kv       KvStore over the same fetch (`/kvstore/<key>`)
      //   webhook  WebhookSender over fetch (external hosts go through the platform proxy)
      //   clock    Date.now
      //   codec    gzip via CompressionStream (identity where unavailable)
      //   logger   console
      // plus `owner` (this tab's KV lock id) and the build info the sweep records in `meta`.
      const deps: SweepDeps = {
        http, kv, webhook, clock, codec, logger, owner: tabId, ...APP_BUILD_INFO,
        runtime: 'ui',
        ...origin,
        // Founder-build r1 core-2 (C1', B1): a workspace with no settings document is metered in this tab's zone.
        defaultTimeZone: browserTimeZone(),
      };
      const result = await runSweep(deps, { mode });
      return toSummary(result, mode, clock.now() - started);
    },

    ownerId: tabId,

    async runWeekly(mode, runtime) {
      if (runtime === 'backend' && mode === 'manual') {
        // The Enterprise variant's endpoint runs the same core job on the platform (backend/weeklyReceipt.ts).
        const res = await http.request('POST', '/endpoints/weeklyReceipt', { mode: 'manual' });
        return weeklyFromJson(res.json, res.ok ? undefined : `HTTP ${res.status}`);
      }
      return runWeeklyReceipt({ http, kv, webhook, clock, codec, logger, owner: tabId, ...origin, defaultTimeZone: browserTimeZone() }, { mode });
    },

    async invokeBackend() {
      const started = clock.now();
      const res = await http.request('POST', '/endpoints/meter', { mode: 'manual' });
      const body = (res.json ?? {}) as Record<string, unknown>;
      if (!res.ok) {
        return {
          ok: false,
          mode: 'manual',
          status: res.status,
          error: typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
          durationMs: clock.now() - started,
        };
      }
      return toSummary(body, 'manual', clock.now() - started);
    },
  };

  return { docs, engine, mergeSettings, defaultSettings: defaults, kvDocs };
}
