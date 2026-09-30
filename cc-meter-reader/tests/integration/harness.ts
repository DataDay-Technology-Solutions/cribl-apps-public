// tests/integration/harness.ts — an emulated Cribl org driven by one mutable clock, for sweep, lever and weekly
// scenarios (the unit suites use it too). Everything runs in-process through src/mock/direct.ts: no fetch, no MSW.
//
// Clock coherence: the emulator's wall clock, the sweep's clock and every sleep read/advance the same `now`, so
// "the last completed minute" and the metrics store's horizon always agree, and a 5 s 429 retry or a webhook
// back-off moves time forward instead of blocking.

import type {
  Build,
  CriblHttp,
  HttpResult,
  KvStore,
  Logger,
  Meta,
  NotificationEndpoint,
  PricesDoc,
  Settings,
  WebhookSender,
} from '../../core/types.ts';
import { identityCodec, type Codec } from '../../core/codec.ts';
import type { FetchLike } from '../../core/http.ts';
import { createKvDocs, type KvDocs } from '../../core/kv.ts';
import { defaultSettings, isStorableEndpoint } from '../../core/settings.ts';
import { appendPriceVersion, emptyPrices } from '../../core/pricing.ts';
import { runSweep, type SweepDeps, type SweepResult } from '../../core/sweep.ts';
import type { LeverDeps } from '../../core/demo/levers.ts';
import { createDirectHttp, createDirectKv, createDirectWebhook, createEmulator } from '../../src/mock/direct.ts';
import type { CriblEmulator } from '../../src/mock/emulator.ts';
import type { MockOptions, MockPreset } from '../../src/mock/types.ts';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** Monday 28 Sep 2026 15:00:20 UTC — 20 s into a minute, like a sweep that starts right after a boundary. */
export const T0 = Date.UTC(2026, 8, 28, 15, 0, 20);

export const PRICES_MC_PER_GB = {
  siem: 250_000,
  analytics: 150_000,
  archive: 3_000,
} as const;

/**
 * The world's direct webhook. DECISIONS D57: no build stores a webhook URL in KV, so it reaches the sweep the way the
 * runner's .env webhooks do (`deps.envWebhooks`), never through the settings document.
 */
export const SINK_ENDPOINT: NotificationEndpoint = {
  id: 'ep_sink',
  name: 'Demo sink',
  url: 'https://webhook.site/meter-reader-test',
  host: 'webhook.site',
  format: 'generic',
  minSeverity: 'medium',
  weeklyReceipt: true,
  enabled: true,
  channel: 'webhook',
};

export interface WorldOptions {
  start?: number;
  preset?: MockPreset;
  flows?: number;
  seed?: number;
  options?: Partial<MockOptions>;
  build?: Build;
  /** Adjust the stored settings (demo mode + profile on, one webhook.site endpoint by default). */
  settings?: (s: Settings) => void;
  /** Skip writing settings/prices (a truly fresh install). */
  bare?: boolean;
  /** Wrap the transports (fault injection, call hooks). */
  wrapHttp?: (http: CriblHttp) => CriblHttp;
  wrapKv?: (kv: KvStore) => KvStore;
  /** Extra SweepDeps fields (budget, timelineEveryMin, …). */
  sweep?: Partial<SweepDeps>;
  /** KV codec (identity by default; gzip for scale runs). */
  codec?: Codec;
}

export interface World {
  em: CriblEmulator;
  now(): number;
  set(ms: number): void;
  advance(ms: number): void;
  http: CriblHttp;
  kv: KvStore;
  webhook: WebhookSender;
  deps: SweepDeps;
  lever: LeverDeps;
  docs: KvDocs;
  logs: { level: string; msg: string }[];
  sweep(mode?: 'ui' | 'manual' | 'scheduled', extra?: Partial<SweepDeps>): Promise<SweepResult>;
  /** Sweep at the next minute boundary + 20 s, `n` times; returns every result. */
  sweepMinutes(n: number, extra?: Partial<SweepDeps>): Promise<SweepResult[]>;
  meta(): Promise<Meta | null>;
  settings(): Promise<Settings>;
  putSettings(update: (s: Settings) => void): Promise<void>;
}

/**
 * Founder-build r3 core-2 (D83): a world whose workspace has been metering since `ms` — not a fresh install. A world's
 * first sweep stamps meta.meteringStartedAt with its own time, and the automatic weekly receipt covers only a week that
 * ended after metering started; a scenario about a workspace that metered last week back-dates it here.
 */
export async function meteringSince(w: Pick<World, 'docs'>, ms: number): Promise<void> {
  const m = await w.docs.getMeta();
  if (!m) throw new Error('meteringSince: sweep the world first (no meta yet)');
  await w.docs.putMeta({ ...m, meteringStartedAt: new Date(ms).toISOString() });
}

export function rigPrices(effectiveFromMs: number): PricesDoc {
  return appendPriceVersion(
    emptyPrices(new Date(effectiveFromMs).toISOString()),
    {
      mrd_siem_prod: {
        milliCentsPerGb: PRICES_MC_PER_GB.siem,
        preset: 'splunk_cloud',
      },
      mrd_analytics: {
        milliCentsPerGb: PRICES_MC_PER_GB.analytics,
        preset: 'datadog',
      },
      mrd_archive_s3: {
        milliCentsPerGb: PRICES_MC_PER_GB.archive,
        preset: 's3',
      },
      devnull: { milliCentsPerGb: 0, preset: 'internal' },
    },
    effectiveFromMs,
  );
}

export async function createWorld(opts: WorldOptions = {}): Promise<World> {
  let now = opts.start ?? T0;
  const clock = { now: () => now };
  const em = createEmulator({
    clock: () => now,
    preset: opts.preset ?? 'demo',
    seed: opts.seed ?? 42,
    ...(opts.flows ? { flows: opts.flows } : {}),
    ...(opts.options ? { options: opts.options } : {}),
  });
  const logs: { level: string; msg: string }[] = [];
  const logger: Logger = {
    info: (msg) => void logs.push({ level: 'info', msg }),
    warn: (msg) => void logs.push({ level: 'warn', msg }),
    error: (msg, data) =>
      void logs.push({
        level: 'error',
        msg: `${msg} ${data instanceof Error ? data.message : ''}`,
      }),
  };
  const baseHttp = createDirectHttp(em);
  const baseKv = createDirectKv(em);
  const http = opts.wrapHttp ? opts.wrapHttp(baseHttp) : baseHttp;
  const kv = opts.wrapKv ? opts.wrapKv(baseKv) : baseKv;
  const webhook = createDirectWebhook(em);
  const sleep = async (ms: number): Promise<void> => {
    now += ms;
  };
  const codec = opts.codec ?? identityCodec;
  const deps: SweepDeps = {
    http,
    kv,
    webhook,
    clock,
    codec,
    logger,
    sleep,
    owner: 'tab-a',
    appVersion: '1.0.0',
    build: opts.build ?? 'demo',
    runtime: 'ui',
    workspace: 'main-example-org',
    linkBase: 'https://main-example-org.cribl.cloud/apps/a/meter-reader',
    envWebhooks: opts.bare ? [] : [{ ...SINK_ENDPOINT }],
    // A fresh world's first sweep reaches back the hour these scenarios were written at (the harness world stores no
    // inventory, so the default would reach a whole day: D63, rules round 2). The first-run tests pass
    // `sweep: { firstRunReachMs: undefined }` to exercise the default reach.
    firstRunReachMs: HOUR,
    ...(opts.sweep ?? {}),
  };
  // Tests pull many levers inside one mock minute; the per-minute budget is exercised explicitly (minuteBudget 45).
  const lever: LeverDeps = {
    http,
    kv,
    clock,
    codec,
    logger,
    sleep,
    author: 's.koelpin',
    minuteBudget: 10_000,
  };
  // Test-side KV access that bypasses any wrapper, so setup never trips an injected fault.
  const docs = createKvDocs({ kv: baseKv, codec, clock });

  if (!opts.bare) {
    const s = defaultSettings(new Date(now).toISOString(), 'UTC');
    s.demo = { enabled: true, replayMode: false, profile: true };
    // A test lists the world's endpoints in one place, as settings once held them all; the direct webhooks among them
    // go to the delivering runtime (deps.envWebhooks, as the runner's .env does), never into KV (D57).
    s.notifications = [{ ...SINK_ENDPOINT }];
    opts.settings?.(s);
    splitWebhooks(s, deps);
    await docs.putSettings(s);
    await docs.putPrices(rigPrices(now - 3 * DAY));
  }

  const world: World = {
    em,
    now: () => now,
    set: (ms) => {
      now = ms;
    },
    advance: (ms) => {
      now += ms;
    },
    http,
    kv,
    webhook,
    deps,
    lever,
    docs,
    logs,
    sweep: (mode = 'ui', extra = {}) => runSweep({ ...deps, ...extra }, { mode }),
    async sweepMinutes(n, extra = {}) {
      const out: SweepResult[] = [];
      for (let i = 0; i < n; i++) {
        now = Math.floor(now / MINUTE) * MINUTE + MINUTE + 20_000;
        out.push(await runSweep({ ...deps, ...extra }, { mode: 'ui' }));
      }
      return out;
    },
    meta: () => docs.getMeta(),
    async settings() {
      return (await docs.getSettings()) as Settings;
    },
    async putSettings(update) {
      const s = (await docs.getSettings()) as Settings;
      s.notifications = [...s.notifications, ...(deps.envWebhooks ?? [])];
      update(s);
      splitWebhooks(s, deps);
      await docs.putSettings(s);
    },
  };
  return world;
}

/**
 * D57: the direct webhooks among a test's endpoints become the delivering runtime's own (`deps.envWebhooks`, like the
 * runner's .env), in order; the settings document keeps only the Cribl channels.
 */
function splitWebhooks(s: Settings, deps: SweepDeps): void {
  const all = s.notifications ?? [];
  deps.envWebhooks = all.filter((e) => !isStorableEndpoint(e)).map((e) => ({ ...e, channel: 'webhook' as const }));
  s.notifications = all.filter((e) => isStorableEndpoint(e));
}

/** An http wrapper that answers `status` for requests matching `when`, `times` times (then passes through). */
export function faultHttp(
  inner: CriblHttp,
  when: (method: string, path: string) => boolean,
  status: number,
  times = 1,
): CriblHttp & { hits: number } {
  const w = {
    hits: 0,
    async request(
      method: Parameters<CriblHttp['request']>[0],
      path: string,
      body?: unknown,
      o?: { timeoutMs?: number; raw?: boolean },
    ): Promise<HttpResult> {
      if (w.hits < times && when(method, path)) {
        w.hits++;
        return {
          status,
          ok: false,
          json: { status: 'error', message: `injected ${status}` },
        };
      }
      return inner.request(method, path, body, o);
    },
  };
  return w;
}

/** Sum of a flow's stored minute rows over the given minute docs. */
export function sumRows(
  docs: ({
    flows: Record<string, { whpM: number; paidM: number; savedM: number; t: string }[]>;
  } | null)[],
  match: (flowKey: string) => boolean,
) {
  const acc = { whpM: 0, paidM: 0, savedM: 0, rows: 0 };
  for (const d of docs) {
    for (const [key, rows] of Object.entries(d?.flows ?? {})) {
      if (!match(key)) continue;
      for (const r of rows) {
        acc.whpM += r.whpM;
        acc.paidM += r.paidM;
        acc.savedM += r.savedM;
        acc.rows++;
      }
    }
  }
  return acc;
}

/**
 * A `fetch` answered by the emulator (the platform fetch as the App would see it): relative `/api/v1/…` URLs
 * (backend runtime), `http://cribl.mock/mock-api/v1/…` (ui runtime) and full external URLs (webhooks).
 */
export function emulatorFetch(em: CriblEmulator): FetchLike {
  return async (url, init) => {
    const res = await em.handle({
      method: init?.method ?? 'GET',
      url,
      headers: { ...(init?.headers ?? {}) },
      body: init?.body ?? null,
    });
    const body = res.body ?? '';
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      text: async () => body,
      headers: {
        forEach: (cb: (value: string, key: string) => void) => Object.entries(res.headers).forEach(([k, v]) => cb(v, k)),
      },
    };
  };
}

/** Wraps metrics answers so the newest bucket of each range reads at half its value the first time it is seen (late data). */
export function lateDataHttp(inner: CriblHttp): CriblHttp & { halved: number[] } {
  const seen = new Set<number>();
  const w = {
    halved: [] as number[],
    async request(
      method: Parameters<CriblHttp['request']>[0],
      path: string,
      body?: unknown,
      o?: { timeoutMs?: number; raw?: boolean },
    ): Promise<HttpResult> {
      const res = await inner.request(method, path, body, o);
      if (method !== 'POST' || !path.startsWith('/system/metrics/query') || !res.ok) return res;
      const rows = ((res.json as { results?: Record<string, unknown>[] })?.results ?? []) as Record<string, unknown>[];
      const latest = Math.max(...rows.map((r) => Number(r.starttime ?? -1)));
      if (!Number.isFinite(latest) || latest < 0) return res;
      const latestMs = latest * 1000;
      const tag = `${latestMs}|${JSON.stringify((body as { aggs?: { splitBys?: string[] } })?.aggs?.splitBys ?? [])}`;
      if (seen.has(hashTag(tag))) return res;
      seen.add(hashTag(tag));
      if (!w.halved.includes(latestMs)) w.halved.push(latestMs);
      for (const r of rows) {
        if (Number(r.starttime) !== latest) continue;
        for (const k of ['inB', 'outB', 'inE', 'outE']) if (typeof r[k] === 'number') r[k] = Math.floor((r[k] as number) / 2);
      }
      return res;
    },
  };
  return w;
}

function hashTag(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
