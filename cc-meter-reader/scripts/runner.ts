#!/usr/bin/env -S npx tsx
// scripts/runner.ts — the "bring your own compute" runtime (DECISIONS D24).
//
// Cribl.Cloud plans without App backend compute cannot schedule the `meter` backend function, so the
// App meters from the open tab (runtime 'ui'). This runner is the third runtime for the SAME core/
// sweep: a small Node process you run on any machine you own, with an org API credential, that sweeps
// once a minute and writes to the App's own KV store. The App UI then shows fresh numbers whether or
// not a tab is open. The KV lock (lock/meter) serializes it with any open tab, so nothing is counted
// twice. It delivers every alert itself — Cribl bell, Cribl notification targets and direct webhooks (it
// runs outside the platform proxy) — and an open tab leaves delivery to it while it is sweeping.
//
// Usage (credentials come from the git-ignored .env via scripts/cribl-api.mjs; nothing is printed):
//   npx tsx scripts/runner.ts --setup --demo-org ORG   DEMO ORG ONLY: print the plan, then seed demo prices and demo
//                                                      mode (ORG must equal CRIBL_ORG)
//
// Direct webhooks (DECISIONS D57): App KV never holds a webhook URL, so the runner reads them from its .env:
// MR_WEBHOOKS (comma-separated https URLs, optional `slack:`/`generic:`/`servicenow:` prefix) and the demo rig's
// MR_DEMO_WEBHOOK_URL (core/env-webhooks.ts). Only their names and hosts reach KV (meta.deliveryWebhooks).
//   npx tsx scripts/runner.ts --once      one sweep, print the summary
//   npx tsx scripts/runner.ts --weekly    send the weekly receipt now (the seven days before today)
//   npx tsx scripts/runner.ts             sweep every minute (25 s after the boundary), forever; sends the
//                                         weekly receipt once after Monday 12:00 UTC. One per machine (a pidfile)
//                                         and one per org (another host's runner that swept in the last 90 s
//                                         refuses the start, exit 3); --force starts anyway.
//
// It records the INSTALLED App's version and build in meta (read from `GET /apps/meter-reader`), so the
// footer shows what is installed; the demo build is recognized by its displayName. Its lock owner is
// `runner:<pid>`, or `runner:<MR_RUNNER_HOST>:<pid>` when .env names the host: the machine's own host name never
// reaches the org-visible KV (EPIC_AUDIT P1-E06).
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain ESM helper without type declarations
import { baseUrl as apiBaseUrl, loadEnv, token } from './cribl-api.mjs';
import { createFetchHttp } from '../core/http.ts';
import { createFetchKvStore, createKvDocs } from '../core/kv.ts';
import { webCodec } from '../core/codec.ts';
import { createFetchWebhookSender } from '../core/adapters/webhook.ts';
import { webhooksFromEnv, type EnvWebhookResult } from '../core/env-webhooks.ts';
import { DELIVERY_OWNER_FRESH_MS, SETTLE_MS, runSweep, type SweepDeps, type SweepResult } from '../core/sweep.ts';
import { runWeeklyReceipt, shouldAutoSendWeekly, type WeeklyResult } from '../core/weekly.ts';
import { defaultSettings, mergeSettings, unstorableSettingsCount } from '../core/settings.ts';
import { appendPriceVersion, emptyPrices, outputPriceKey } from '../core/pricing.ts';
import { presetById } from '../core/presets.ts';

/** A preset's typical millicents per GB (the presets table is static, so a missing id is a programming error). */
function presetMc(id: Parameters<typeof presetById>[0]): number {
  const p = presetById(id);
  if (!p) throw new Error(`unknown preset ${String(id)}`);
  return p.milliCentsPerGb;
}
import type { Build, CriblHttp, Meta, Settings } from '../core/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_ID = 'meter-reader';
/** logs/ of this checkout; MR_RUNNER_LOG_DIR (process environment) moves it — the tests use a scratch directory. */
const LOG_DIR = process.env.MR_RUNNER_LOG_DIR || join(ROOT, 'logs');
const LOG = join(LOG_DIR, 'runner.log');
const HEARTBEAT = join(LOG_DIR, 'runner.heartbeat.json');
const PIDFILE = join(LOG_DIR, 'runner.pid');
/** runner.log rolls over to runner.log.1 past this size (one generation kept). */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Exit code for a refused second instance: the supervisor stops instead of restarting it. */
export const EXIT_ANOTHER_RUNNER = 3;
/** The heartbeat reports ok=false after this many 'locked' skips in a row: something else holds the meter. */
export const LOCKED_STREAK_UNHEALTHY = 3;
const TZ = 'America/New_York';
/** Seconds after each minute boundary the runner sweeps: past the sweep's 20 s settle (REVIEW-3a #1). */
export const SWEEP_OFFSET_MS = SETTLE_MS + 5_000;
/** How often the installed App's version and build are re-read. */
const APP_INFO_TTL_MS = 10 * 60_000;

type FetchInit = { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal };

/** fetch with the org bearer token (refreshed by cribl-api.mjs before it expires). */
async function authedFetch(url: string, init: FetchInit = {}): Promise<Response> {
  const t: string = await token();
  return fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${t}` } } as RequestInit);
}

/**
 * One log: logs/runner.log, rolled over to runner.log.1 at LOG_MAX_BYTES. Echoed to the terminal only when stdout is
 * one — under nohup or launchd stdout is a file (runner.out), and echoing there wrote every line twice.
 */
function log(line: string): void {
  mkdirSync(dirname(LOG), { recursive: true });
  const stamped = `${new Date().toISOString()} ${line}`;
  try {
    if (statSync(LOG).size > LOG_MAX_BYTES) renameSync(LOG, `${LOG}.1`);
  } catch {
    /* no log yet */
  }
  appendFileSync(LOG, `${stamped}\n`);
  if (process.stdout.isTTY) console.log(stamped);
}

/** This repo's version (package.json): what the runner reports when the installed App can't be read. */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface AppInfo {
  appVersion: string;
  build: Build;
}

/**
 * The installed App's version and build from a `GET /apps/<id>` answer (`{ items: [{ id, version, displayName }] }`
 * or the item itself). The demo package is the one whose displayName says "(demo build)" (DECISIONS D22);
 * anything else installed is the release. Null when the answer names no such App.
 */
export function appInfoFrom(json: unknown, appId: string = APP_ID): AppInfo | null {
  const body = json as { items?: unknown } | null | undefined;
  const list = Array.isArray(body?.items) ? (body.items as unknown[]) : [json];
  const item = list.find((x) => (x as { id?: unknown } | null)?.id === appId) as { version?: unknown; displayName?: unknown } | undefined;
  if (!item) return null;
  const version = typeof item.version === 'string' && item.version.trim() ? item.version.trim() : packageVersion();
  const name = typeof item.displayName === 'string' ? item.displayName : '';
  return { appVersion: version, build: /\(demo build\)/i.test(name) ? 'demo' : 'release' };
}

/** The last answer (or, with none, the package.json fallback), when it was read, and whether it came from the Leader. */
let appInfoCache: { at: number; info: AppInfo; installed: boolean } | undefined;

/** Forgets the last answer (tests). */
export function clearAppInfoCache(): void {
  appInfoCache = undefined;
}

/**
 * What meta should say about the App (REVIEW-3a #10): the installed version and build, re-read every 10
 * minutes. If it can't be read, the last answer stands (with none yet, package.json's version as 'release'), and
 * the failure is remembered for the same 10 minutes: a credential without the Apps read costs one call per TTL,
 * not one per sweep (P1-E06).
 */
export async function installedApp(http: CriblHttp, nowMs = Date.now(), warn: (m: string) => void = (m) => log(`warn ${m}`)): Promise<AppInfo> {
  if (appInfoCache && nowMs - appInfoCache.at < APP_INFO_TTL_MS) return appInfoCache.info;
  const known = appInfoCache?.installed ? appInfoCache.info : undefined;
  const keeping = known ? 'the last answer' : 'package.json';
  const fallback = (): AppInfo => {
    const info = known ?? { appVersion: packageVersion(), build: 'release' };
    appInfoCache = { at: nowMs, info, installed: !!known };
    return info;
  };
  try {
    const res = await http.request('GET', `/apps/${APP_ID}`);
    const info = res.ok ? appInfoFrom(res.json) : null;
    if (info) {
      appInfoCache = { at: nowMs, info, installed: true };
      return info;
    }
    warn(`could not read the installed App (HTTP ${res.status}); keeping ${keeping} for ${APP_INFO_TTL_MS / 60_000} min`);
  } catch (e) {
    warn(`could not read the installed App (${e instanceof Error ? e.message : String(e)}); keeping ${keeping} for ${APP_INFO_TTL_MS / 60_000} min`);
  }
  return fallback();
}

// ─── Identity and single-instance guards (EPIC_AUDIT P1-E06) ──────────────────
/**
 * The lock owner: `runner:<MR_RUNNER_HOST>:<pid>` when .env names the host, else `runner:<pid>`. The machine's own
 * host name is never used — lock/meter and meta are readable by every member the App is shared with.
 */
export function runnerOwner(env: Record<string, string | undefined>, pid: number = process.pid): string {
  const host = (env.MR_RUNNER_HOST ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '');
  return host ? `runner:${host}:${pid}` : `runner:${pid}`;
}

/** The host label of a `runner:` owner (`runner:<host>:<pid>`), '' for a bare `runner:<pid>`, undefined otherwise. */
export function runnerLabel(owner: string | undefined): string | undefined {
  if (!owner?.startsWith('runner:')) return undefined;
  const parts = owner.slice('runner:'.length).split(':');
  return parts.length >= 2 ? parts[0] : '';
}

export interface PidRecord {
  pid: number;
  startedAt: string;
  owner?: string;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** A second runner on this machine: the pidfile names a live process that is not this one. */
export function pidfileVerdict(existing: PidRecord | null, alive: (pid: number) => boolean, selfPid: number = process.pid): Verdict {
  if (!existing || !Number.isInteger(existing.pid) || existing.pid === selfPid) return { ok: true };
  if (!alive(existing.pid)) return { ok: true }; // a stale pidfile: that runner is gone
  return { ok: false, reason: `another runner is already running on this machine (pid ${existing.pid}, since ${existing.startedAt}); stop it first (RUNBOOK section 6.2)` };
}

/**
 * A runner on ANOTHER host metering this org: meta names a `runner:<host>:…` owner whose host differs from this one's,
 * that swept or checked in less than 90 s ago. Two runners serialize on lock/meter but double the Leader calls. Runners
 * without MR_RUNNER_HOST cannot be told apart here (a restart of this one looks the same), so only named hosts are
 * compared; the pidfile covers this machine.
 */
export function orgVerdict(meta: Pick<Meta, 'lastSweepOwner' | 'lastSweepAt' | 'deliveryOwner' | 'deliveryOwnerAt'> | null, selfOwner: string, nowMs: number): Verdict {
  const mine = runnerLabel(selfOwner);
  for (const [owner, at] of [
    [meta?.lastSweepOwner, meta?.lastSweepAt],
    [meta?.deliveryOwner, meta?.deliveryOwnerAt],
  ] as const) {
    const theirs = runnerLabel(owner);
    if (!theirs || !mine || theirs === mine) continue;
    const age = nowMs - Date.parse(at ?? '');
    if (age < DELIVERY_OWNER_FRESH_MS) {
      return { ok: false, reason: `the runner on ${theirs} (${owner}) metered this org ${Math.max(0, Math.round(age / 1000))} s ago; stop it first, or start with --force` };
    }
  }
  return { ok: true };
}

/** The --setup guard: it writes demo settings and prices, so it runs only against the org named on the command line. */
export function setupVerdict(args: readonly string[], env: Record<string, string | undefined>): Verdict {
  const i = args.indexOf('--demo-org');
  const named = i >= 0 ? (args[i + 1] ?? '') : '';
  if (!named) return { ok: false, reason: '--setup writes demo settings and prices: name the org with --demo-org ORG (the CRIBL_ORG in .env)' };
  if (!env.CRIBL_ORG) return { ok: false, reason: '.env has no CRIBL_ORG to compare --demo-org with' };
  if (named !== env.CRIBL_ORG) return { ok: false, reason: `--demo-org ${named} is not the org .env points at; nothing written` };
  return { ok: true };
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────
export interface Heartbeat {
  at: string;
  ok: boolean;
  reason?: string;
  lockedStreak: number;
  [k: string]: unknown;
}

/**
 * The heartbeat after one sweep. ok is false on any error (a rate-limited back-off included) and after
 * LOCKED_STREAK_UNHEALTHY 'locked' skips in a row: a runner refused the lock every minute meters nothing, however
 * error-free its sweeps look (P1-E06). 'current' is healthy: a tab metered the minute and the runner checked in.
 */
export function heartbeatFor(r: SweepResult, prevLockedStreak: number, nowMs: number, extra: Record<string, unknown> = {}): Heartbeat {
  const lockedStreak = r.skipped === 'locked' && !r.error ? prevLockedStreak + 1 : 0;
  const hb: Heartbeat = { at: new Date(nowMs).toISOString(), ok: true, lockedStreak, ...extra };
  if (r.error) {
    hb.ok = false;
    hb.reason = r.skipped === 'backoff' ? `rate limited by the Leader since ${r.rateLimit?.since ?? '?'}; backing off until ${r.rateLimit?.until ?? '?'}` : r.error;
  } else if (lockedStreak >= LOCKED_STREAK_UNHEALTHY) {
    hb.ok = false;
    hb.reason = `lock/meter refused ${lockedStreak} sweeps in a row: another runtime holds the meter`;
  }
  return hb;
}

/** MR_WEBHOOK_HOSTS as a host list ('hooks.slack.com, webhook.site'); undefined when unset or empty (no narrowing). */
export function webhookHosts(value: string | undefined): string[] | undefined {
  const hosts = (value ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}

/** The runner's direct webhooks (D57): MR_WEBHOOKS and MR_DEMO_WEBHOOK_URL, process environment first, then .env. */
export function runnerWebhooks(env: Record<string, string>): EnvWebhookResult {
  return webhooksFromEnv({
    MR_WEBHOOKS: process.env.MR_WEBHOOKS ?? env.MR_WEBHOOKS,
    MR_DEMO_WEBHOOK_URL: process.env.MR_DEMO_WEBHOOK_URL ?? env.MR_DEMO_WEBHOOK_URL,
  });
}

/** The start-up line naming the .env webhooks (names and hosts; never a URL). */
export function webhooksLine(r: EnvWebhookResult): string {
  const named = r.endpoints.map((e) => `${e.name} (${e.host})`).join(', ');
  const base = r.endpoints.length === 0 ? 'direct webhooks: none in .env (alerts go to the Cribl bell and targets)' : `direct webhooks from .env: ${r.endpoints.length} (${named})`;
  return r.skipped.length > 0 ? `${base}; skipped: ${r.skipped.join('; ')}` : base;
}

/** Transports and identity for the sweep, the weekly receipt and the levers (scripts/lever.ts). */
export function deps(app: AppInfo = { appVersion: packageVersion(), build: 'release' }): SweepDeps {
  const api: string = apiBaseUrl();
  const env = loadEnv() as Record<string, string>;
  const leader = api.replace(/\/api\/v1$/, '');
  return {
    http: createFetchHttp({ fetch: authedFetch as never, baseUrl: api }),
    kv: createFetchKvStore({ fetch: authedFetch as never, baseUrl: `${api}/a/${APP_ID}` }),
    // Direct webhooks go only to https URLs on public hosts, never through a redirect; MR_WEBHOOK_HOSTS (a
    // comma-separated host list, process environment or .env) narrows them to the hosts the runner's owner names.
    webhook: createFetchWebhookSender(fetch as never, { allowHosts: webhookHosts(process.env.MR_WEBHOOK_HOSTS ?? env.MR_WEBHOOK_HOSTS) }),
    // D57: direct webhook URLs come from this environment only, never from App KV.
    envWebhooks: runnerWebhooks(env).endpoints,
    clock: { now: () => Date.now() },
    codec: webCodec,
    logger: { info: (m) => log(`info ${m}`), warn: (m) => log(`warn ${m}`), error: (m) => log(`error ${m}`) },
    // `runner:<MR_RUNNER_HOST>:<pid>` (the UI says "Metered by the runner on <host>"), else `runner:<pid>` (P1-E06).
    owner: runnerOwner(env),
    appVersion: app.appVersion,
    build: app.build,
    runtime: 'backend',
    workspace: env.CRIBL_WORKSPACE || 'main',
    linkBase: `${leader}/apps/a/${APP_ID}`,
  };
}

/**
 * One set of transports for the process: the sweep keeps its rate-limit back-off per KV store object (EPIC_AUDIT
 * P1-E01), so a runner that rebuilt them every minute would forget a back-off the Leader refused to let it record.
 */
let processDeps: SweepDeps | undefined;

/** deps() with the installed App's version and build. */
async function liveDeps(): Promise<SweepDeps> {
  processDeps ??= deps();
  return { ...processDeps, ...(await installedApp(processDeps.http)) };
}

async function setup(args: readonly string[]): Promise<void> {
  const env = loadEnv() as Record<string, string>;
  const verdict = setupVerdict(args, env);
  if (!verdict.ok) {
    console.error(`runner --setup refused: ${verdict.reason}`);
    process.exit(2);
  }
  console.log(
    [
      `runner --setup will write to org ${env.CRIBL_ORG}, workspace ${env.CRIBL_WORKSPACE || 'main'}, App ${APP_ID}:`,
      '  settings: demo mode on, profile on (the demo webhook stays in .env: MR_DEMO_WEBHOOK_URL, D57)',
      '  prices: a new price version for mrd_siem_prod, mrd_siem_apps (Splunk Cloud), mrd_analytics (Datadog), mrd_archive_s3 (S3)',
    ].join('\n'),
  );
  const d = await liveDeps();
  const docs = createKvDocs({ kv: d.kv, codec: d.codec, clock: d.clock });
  const nowIso = new Date().toISOString();

  const stored = await docs.getSettings();
  const base: Settings = mergeSettings(stored, defaultSettings(nowIso, TZ));
  // D57: mergeSettings already dropped any webhook endpoint an older build stored (URL and all); putSettings writes none.
  const endpoints = base.notifications;
  const settings: Settings = {
    ...base,
    updatedAt: nowIso,
    displayTimezone: base.displayTimezone || TZ,
    notifications: endpoints,
    demo: { ...base.demo, enabled: true, profile: true },
  };
  await docs.putSettings(settings);

  // Illustrative demo prices (PRD 9.1): siem-prod = Splunk Cloud $2.50/GB, analytics = Datadog $1.50/GB,
  // archive-s3 = S3 $0.03/GB, siem-apps (the payments destination, D21) = Splunk Cloud $2.50/GB.
  const prices = (await docs.getPrices()) ?? emptyPrices(nowIso);
  const next = appendPriceVersion(
    prices,
    {
      // The presets' typical list prices (D41): Splunk Cloud $2.25, Datadog $1.80, S3 $0.023 per GB.
      [outputPriceKey('default', 'mrd_siem_prod')]: { milliCentsPerGb: presetMc('splunk_cloud'), preset: 'splunk_cloud', counterfactual: { kind: 'same' } },
      [outputPriceKey('default', 'mrd_siem_apps')]: { milliCentsPerGb: presetMc('splunk_cloud'), preset: 'splunk_cloud', counterfactual: { kind: 'same' } },
      [outputPriceKey('default', 'mrd_analytics')]: { milliCentsPerGb: presetMc('datadog'), preset: 'datadog', counterfactual: { kind: 'same' } },
      [outputPriceKey('default', 'mrd_archive_s3')]: { milliCentsPerGb: presetMc('s3'), preset: 's3', counterfactual: { kind: 'same' } },
    },
    Date.now(),
  );
  await docs.putPrices(next);
  log(`setup: settings (demo on, profile on, ${endpoints.length} endpoint[s]) and ${next.versions.length} price version(s) written`);
}

function weeklySummary(w: WeeklyResult): Record<string, unknown> {
  return { skipped: w.skipped, sent: w.sent, endpoints: w.endpoints, calls: w.calls, error: w.error, label: w.receipt?.label };
}

/** "Weekly receipt now" from the runner: the seven days before today, to every endpoint that takes it. */
async function weeklyNow(): Promise<void> {
  const w = await runWeeklyReceipt(await liveDeps(), { mode: 'manual' });
  log(`weekly ${JSON.stringify(weeklySummary(w))}`);
  if (w.text) console.log(w.text);
}

/** 'locked' skips in a row (the heartbeat turns unhealthy at LOCKED_STREAK_UNHEALTHY). */
let lockedStreak = 0;

async function sweepOnce(): Promise<SweepResult | undefined> {
  const started = Date.now();
  try {
    const d = await liveDeps();
    const r = await runSweep(d, { mode: 'scheduled' });
    const summary = {
      skipped: r.skipped,
      calls: r.calls,
      ms: r.ms,
      minutes: r.minutesProcessed,
      backfilled: r.backfilledMinutes,
      held: r.heldMinutes,
      opened: r.opened,
      closed: r.closed,
      notified: r.notified,
      snapshotBytes: r.snapshotBytes,
      error: r.error,
      ...(r.rateLimit ? { rateLimit: r.rateLimit } : {}),
    };
    log(`sweep ${JSON.stringify(summary)}`);
    const hb = heartbeatFor(r, lockedStreak, Date.now(), { appVersion: d.appVersion, build: d.build, ...summary });
    lockedStreak = hb.lockedStreak;
    writeFileSync(HEARTBEAT, JSON.stringify(hb));
    // The runner is the always-on runtime, so it sends the Monday receipt (once; meta.lastWeeklySentAt).
    if (r.meta && shouldAutoSendWeekly(r.meta, Date.now())) {
      const w = await runWeeklyReceipt(d, { mode: 'scheduled' });
      log(`weekly ${JSON.stringify(weeklySummary(w))}`);
    }
    return r;
  } catch (e) {
    log(`sweep threw after ${Date.now() - started} ms: ${e instanceof Error ? e.stack : String(e)}`);
    writeFileSync(HEARTBEAT, JSON.stringify({ at: new Date().toISOString(), ok: false, error: String(e), reason: String(e), lockedStreak }));
    return undefined;
  }
}

/** ms from `now` to the next sweep: SWEEP_OFFSET_MS past the next minute boundary (or this one, if still ahead). */
export function msUntilNextSweep(now: number): number {
  const thisMinute = Math.floor(now / 60_000) * 60_000;
  const next = thisMinute + SWEEP_OFFSET_MS > now ? thisMinute + SWEEP_OFFSET_MS : thisMinute + 60_000 + SWEEP_OFFSET_MS;
  return next - now;
}

function readPidfile(): PidRecord | null {
  try {
    return JSON.parse(readFileSync(PIDFILE, 'utf8')) as PidRecord;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Refuses a second instance (this machine: the pidfile; the org: another named host's fresh sweep), then claims it. */
async function claimInstance(force: boolean): Promise<void> {
  const refuse = (reason: string): never => {
    log(`runner refused to start: ${reason}`);
    console.error(`runner refused to start: ${reason}`);
    process.exit(EXIT_ANOTHER_RUNNER);
  };
  const local = pidfileVerdict(readPidfile(), processAlive);
  if (!local.ok) refuse(local.reason);
  const d = await liveDeps();
  if (!force) {
    try {
      const meta = await createKvDocs({ kv: d.kv, codec: d.codec, clock: d.clock }).getMeta();
      const org = orgVerdict(meta, d.owner, Date.now());
      if (!org.ok) refuse(org.reason);
    } catch (e) {
      log(`warn could not read meta for the single-runner check (${e instanceof Error ? e.message : String(e)}); starting`);
    }
  }
  mkdirSync(dirname(PIDFILE), { recursive: true });
  writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: d.owner } satisfies PidRecord));
  const release = (): void => {
    try {
      if (readPidfile()?.pid === process.pid) unlinkSync(PIDFILE);
    } catch {
      /* already gone */
    }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log(`runner stopping (${sig})`);
      release();
      process.exit(0);
    });
  }
}

/**
 * D57: a build before 1.0.14 / 1.1.0 could store a direct webhook's URL in the settings document, and one before the
 * rule 4.5 fix a URL typed as a notification target's id. Every reader now drops them (mergeSettings), and this
 * removes them from KV once, at start-up: the stored document is rewritten through putSettings (storableSettings),
 * everything else in it unchanged. Prints counts only, never a URL.
 */
export async function purgeStoredWebhooks(): Promise<void> {
  try {
    const d = await liveDeps();
    const docs = createKvDocs({ kv: d.kv, codec: d.codec, clock: d.clock });
    const stored = await docs.getSettings();
    if (!stored) return;
    const count = storedWebhookCount(stored);
    if (count === 0) return;
    await docs.putSettings(stored);
    const after = await docs.getSettings();
    log(`settings: removed ${count} stored webhook endpoint(s) or URL(s) from App KV (D57); ${after ? storedWebhookCount(after) : 0} left`);
  } catch (e) {
    log(`warn could not check the settings for stored webhook URLs (${e instanceof Error ? e.message : String(e)}); the next start tries again`);
  }
}

/**
 * Things in a stored settings document that App KV must not hold (core/settings.ts unstorableSettingsCount): a direct
 * webhook, any endpoint with a URL, a target id that is not a Cribl id, a URL or token as an endpoint's name or a
 * label, a webhook-address presenter QR.
 */
export function storedWebhookCount(s: Partial<Pick<Settings, 'notifications' | 'humanize' | 'presenter'>>): number {
  return unstorableSettingsCount(s);
}

async function loop(force: boolean): Promise<never> {
  await claimInstance(force);
  log(`runner started (pid ${process.pid}, owner ${processDeps?.owner}); sweeping every minute at :${String(SWEEP_OFFSET_MS / 1000).padStart(2, '0')}`);
  log(webhooksLine(runnerWebhooks(loadEnv() as Record<string, string>)));
  await purgeStoredWebhooks();
  for (;;) {
    await sweepOnce();
    await new Promise((r) => setTimeout(r, msUntilNextSweep(Date.now())));
  }
}

// Run only when executed directly (scripts/lever.ts imports deps()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const arg = args[0];
  if (arg === '--setup') await setup(args);
  else if (arg === '--once') await sweepOnce();
  else if (arg === '--weekly') await weeklyNow();
  else await loop(args.includes('--force'));
}
