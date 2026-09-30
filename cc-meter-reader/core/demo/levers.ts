// core/demo/levers.ts — the demo build's levers (SPEC 11): apply/revert a pack, break/restore a trim, set a
// Datagen rate, reset baselines, reset everything.
//
// One module for both runtimes: the Demo Console calls these in the tab as the member (runtime 'ui'), the
// demo backend functions call them from `onRequest`. Every lever:
//   • refuses unless settings.demo.enabled ('demo_disabled', 403);
//   • refuses any Cribl object whose description lacks `[meter-reader-demo]` ('not_demo_tagged', 403);
//   • allows one lever in flight at a time (demo/state.inFlight, 90 s expiry; 'in_flight', 409);
//   • shares the Leader budget with the sweep: refuses ('budget', 429, retry in 10 s) when the minute's
//     sweep calls + lever calls + its own estimate would pass 45;
//   • read-modify-writes the WHOLE object (PATCH replaces; omitted fields are deleted);
//   • commits with an EXPLICIT file list taken from version/status for the touched objects only (the org has
//     hundreds of unrelated pending files), with the SPEC 11 message, then deploys;
//   • appends its commit to the timeline with the caller's username and the deploy's return time, so the
//     sweep can name the commit without waiting for a timeline refresh (SPEC 10, S19);
//   • records what it changed in demo/state; Revert, Restore and Reset mute the touched objects for 10 min.
// Volatile: callers confirm with the user before invoking a lever (AGENTS.md "Confirming Destructive Operations").

import type { BaselinesDoc, Clock, CriblHttp, DemoState, HttpResult, Incident, ISO, KvStore, Logger, ObjectKey, Settings } from '../types.ts';
import { stableStringify, type Codec } from '../codec.ts';
import { RateLimited } from '../http.ts';
import { KEYS, createKvDocs, type KvDocs } from '../kv.ts';
import { commitAndDeploy, pendingFiles, VersionApiError } from '../adapters/version.ts';
import * as urls from '../adapters/cribl-urls.ts';
import { mergeCommits } from '../timeline.ts';
import { acceptIntoBaselines, closeDemoIncidents, currentReading, incidentsDocKey } from '../incidents.ts';
import { isWarm, reseedBaseline } from '../baseline.ts';
import { objectKey } from '../flows.ts';
import { createMeteredTransport, LOCK_TTL_MS, minuteKey, type MeteredTransport } from '../sweep.ts';
import { DAY_MS, MINUTE_MS, fromIso, toIso } from '../time.ts';
import { RIG_GROUP_ID, TRIM_TAG, isDemoTagged, rigObjectKeys, rigSourceForRoute, rigSource, rigSourcesUsingPipeline } from './rig-ids.ts';

// ─── Constants ───────────────────────────────────────────────────────────────
/** One lever at a time; a marker older than this is stale (a lever that died mid-flight). */
export const IN_FLIGHT_TTL_MS = 90_000;
/** Leader calls per minute a lever may bring the minute's total to (SPEC 7: 45 of the 50). */
export const LEVER_MINUTE_BUDGET = 45;
/** A sweeper (tab, runner, backend) that swept this recently will sweep again this minute. */
const SWEEPER_ALIVE_MS = 3 * MINUTE_MS;
/** The console retries an in-flight or locked refusal after this long (SPEC 11); budget refusals wait for the next minute. */
export const LEVER_RETRY_MS = 10_000;
/** Revert / Restore / Reset mute detection on what they touched (SPEC 9.3, 11). */
export const MUTE_MS = 10 * MINUTE_MS;
export const MIN_RATE_MULTIPLIER = 0.1;
export const MAX_RATE_MULTIPLIER = 10;
/** Default settling estimate until measured (SPEC 11). */
export const DEFAULT_MEASURED_LAG_SEC = 240;

/**
 * Leader calls one lever makes, KV included: settings + demo/state + meta reads (3), in-flight mark (1),
 * object GET + PATCH (2), version/status + commit + deploy (3), timeline read + write (2), final demo/state (1).
 */
export const LEVER_CALLS = 12;
/** Founder-build r1 core-5 (m25): a lever that commits a shared file (route.yml, inputs.yml) first reads version/status. */
export const SHARED_CHECK_CALLS = 1;
/** Core-5 (M5): Apply and Break read the baselines once to record the levels they leave. */
export const LEVELS_READ_CALLS = 1;
/** Core-5 (M5): Revert and Restore re-seat baselines under the sweep lock: lock read + write + verify, baselines read + write, release (2). */
export const RESEED_CALLS = 7;
/** How often a re-seat tries for the sweep lock (a sweep holds it a few seconds), and how far apart. */
export const RESEED_LOCK_TRIES = 5;
export const RESEED_LOCK_RETRY_MS = 1_500;

// ─── Types ───────────────────────────────────────────────────────────────────
export interface LeverDeps {
  http: CriblHttp;
  kv: KvStore;
  clock: Clock;
  codec: Codec;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  /** The member pulling the lever: `getCriblUser().username` in the UI, the request body's user in a backend function. */
  author: string;
  /** Worker group of the demo rig (default 'default'). */
  groupId?: string;
  /** Leader calls a minute may reach with this lever (default 45). */
  minuteBudget?: number;
  /** Owner for the sweep lock that Reset baselines / Reset everything take (default `lever:<author>`). */
  owner?: string;
}

export type LeverName = 'applyPack' | 'revertPack' | 'breakTrim' | 'restoreTrim' | 'setRate' | 'resetBaselines' | 'resetAll';
export type LeverError =
  | 'demo_disabled'
  | 'not_demo_tagged'
  | 'in_flight'
  | 'locked'
  | 'budget'
  | 'not_found'
  | 'forbidden'
  | 'invalid'
  | 'no_change'
  | 'rate_limited'
  | 'commit_failed'
  | 'deploy_failed'
  /** Core-5 (m25): the shared file this lever would commit already had someone else's uncommitted change. */
  | 'shared_file_dirty'
  | 'failed';

export interface LeverSuccess {
  ok: true;
  lever: LeverName;
  /** Full SHA of the commit that carried the change (absent for levers that change no Cribl config). */
  commit?: string;
  /** When the deploy call returned. */
  deployedAt?: ISO;
  message?: string;
  files?: string[];
  /** Leader calls this lever made, KV included. */
  calls: number;
}
export interface LeverRefusal {
  ok: false;
  lever: LeverName;
  error: LeverError;
  /** HTTP status a backend function answers with. */
  status: number;
  message: string;
  /** The untagged object, for 'not_demo_tagged'. */
  id?: string;
  /** When to try again ('budget', 'in_flight', 'locked', 'rate_limited'). */
  retryInMs?: number;
  /** Set on 'deploy_failed': the change is committed but not deployed. */
  commit?: string;
  calls: number;
}
export type LeverResult = LeverSuccess | LeverRefusal;

/** A refusal raised inside a lever body. */
class LeverStop extends Error {
  readonly code: LeverError;
  readonly status: number;
  readonly id?: string;
  constructor(code: LeverError, status: number, message: string, id?: string) {
    super(message);
    this.name = 'LeverStop';
    this.code = code;
    this.status = status;
    if (id !== undefined) this.id = id;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const same = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);

export function emptyDemoState(): DemoState {
  return {
    schemaVersion: 1,
    routes: {},
    measuredLagSec: DEFAULT_MEASURED_LAG_SEC,
    trim: {},
    rates: {},
    muted: {},
  };
}

// ─── Lever context and plumbing ──────────────────────────────────────────────
interface LeverCtx {
  deps: LeverDeps;
  t: MeteredTransport;
  docs: KvDocs;
  gid: string;
  demo: DemoState;
  settings: Settings;
  now(): number;
}

/** What a lever body hands back to the runner. */
interface LeverChange {
  /** Commit message; absent when no Cribl config changed. */
  message?: string;
  /** Selects the pending repo paths of the touched objects (version/status). */
  match?: (path: string) => boolean;
  /** Best-effort undo of the PATCHes when the commit cannot be made. */
  rollback?: () => Promise<void>;
  /** Applied to demo/state once the change is live. */
  update(state: DemoState): void;
  /** Objects to mute for MUTE_MS. */
  mute?: ObjectKey[];
  /**
   * Founder-build r1 core-5 (M5): baselines to re-seat once the change is live — a number seats the object's baseline
   * there, warm (Accept's rule); null forgets it, so it re-learns from the next minutes. A counting rule on the object
   * is cleared; an open incident's rule is kept (it still recovers by itself).
   */
  reseed?: Record<ObjectKey, number | null>;
}

function itemsOf(res: HttpResult): Obj[] {
  const body = res.json;
  const list: unknown = Array.isArray(body) ? body : isObj(body) ? body.items : undefined;
  return Array.isArray(list) ? list.filter(isObj) : [];
}

function httpStop(res: HttpResult, what: string): LeverStop {
  if (res.status === 404) return new LeverStop('not_found', 404, `${what} not found`);
  if (res.status === 401 || res.status === 403) return new LeverStop('forbidden', 403, `${what}: not allowed (HTTP ${res.status})`);
  const detail = res.text ?? (res.json === undefined ? '' : JSON.stringify(res.json));
  return new LeverStop('failed', res.status || 502, `${what} failed: HTTP ${res.status} ${detail.slice(0, 160)}`.trim());
}

async function getOne(ctx: LeverCtx, path: string, what: string): Promise<Obj> {
  const res = await ctx.t.http.request('GET', path);
  if (!res.ok) throw httpStop(res, what);
  const item = itemsOf(res)[0];
  if (!item) throw new LeverStop('not_found', 404, `${what} not found`);
  return item;
}

async function patch(ctx: LeverCtx, path: string, body: Obj, what: string): Promise<void> {
  const res = await ctx.t.http.request('PATCH', path, body);
  if (!res.ok) throw httpStop(res, `saving ${what}`);
}

function requireTag(description: unknown, id: string): void {
  if (!isDemoTagged(description))
    throw new LeverStop('not_demo_tagged', 403, `${id} is not a demo object (its description lacks [meter-reader-demo])`, id);
}

/**
 * Founder-build r1 core-5 (FINDINGS_R1 m25, #56): a lever commits the group's shared file whole (route.yml for the
 * route table, inputs.yml for the Sources). If that file is already pending before the lever touches anything, the
 * pending change is someone else's (an edit to a route or Source that is not the rig's) and the commit would ship it:
 * refuse, as scripts/rig/apply.mjs does (RIG.md "Commit safety"). One version/status call.
 */
async function assertSharedClean(ctx: LeverCtx, match: (path: string) => boolean, file: string): Promise<void> {
  const own = new Set(ctx.demo.leftPending ?? []);
  const pending = (await pendingFiles(ctx.t.http, ctx.gid, match)).filter((p) => !own.has(p));
  if (pending.length > 0)
    throw new LeverStop(
      'shared_file_dirty',
      409,
      `${file} in ${ctx.gid} already has uncommitted changes in Cribl (${pending.join(', ')}). Commit or discard them in Cribl first, so this lever commits only its own change.`,
    );
}

/** Core-5 (M5): the warm baseline level of each of `keys` now (a key with no warm baseline is left out). */
async function levelsOf(ctx: LeverCtx, keys: readonly ObjectKey[]): Promise<Record<ObjectKey, number>> {
  const b = await ctx.docs.getBaselines();
  const warm = ctx.settings.thresholds?.warmupSamples ?? 10;
  const out: Record<ObjectKey, number> = {};
  for (const k of new Set(keys)) {
    const x = b?.byObject?.[k];
    if (x && isWarm(x, warm) && Number.isFinite(x.mean)) out[k] = x.mean;
  }
  return out;
}

/**
 * Core-5 (M5): `baselines` with `reseed` applied — a level seats the object's baseline there, warm (reseedBaseline, as
 * Accept does); null forgets it (it re-learns). Rules still counting on those objects (streak > 0, and any good-news
 * state) are cleared; an open incident's rule (streak 0: its frozen baseline and recovery count) is kept, so a Restore's
 * regression still closes itself on the same clock.
 */
export function reseededBaselines(baselines: BaselinesDoc | null | undefined, reseed: Record<ObjectKey, number | null>, warmupSamples: number, nowIso: ISO): BaselinesDoc {
  const byObject = { ...(baselines?.byObject ?? {}) };
  const rules = { ...(baselines?.rules ?? {}) };
  for (const [key, level] of Object.entries(reseed)) {
    if (typeof level === 'number' && Number.isFinite(level)) byObject[key] = reseedBaseline(level, warmupSamples, byObject[key]);
    else delete byObject[key];
    delete rules[`goodnews|${key}`];
    for (const type of ['regression', 'spike'] as const) {
      const rs = rules[`${type}|${key}`];
      if (rs && rs.streak > 0) delete rules[`${type}|${key}`];
    }
  }
  const out: BaselinesDoc = { schemaVersion: 1, updatedAt: nowIso, byObject, rules };
  if (baselines?.budgetEvaluatedAt !== undefined) out.budgetEvaluatedAt = baselines.budgetEvaluatedAt;
  return out;
}

/** Re-seats baselines under the sweep lock (a few tries); a busy lock is logged and left (the revert itself stands). */
async function reseedUnderLock(deps: LeverDeps, docs: KvDocs, settings: Settings, reseed: Record<ObjectKey, number | null>, logger?: Logger): Promise<boolean> {
  if (Object.keys(reseed).length === 0) return true;
  const owner = deps.owner ?? `lever:${deps.author || 'unknown'}`;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < RESEED_LOCK_TRIES; i++) {
    if (await docs.acquireLock(owner, LOCK_TTL_MS)) {
      try {
        const now = toIso(deps.clock.now());
        await docs.putBaselines(reseededBaselines(await docs.getBaselines(), reseed, settings.thresholds?.warmupSamples ?? 10, now));
        return true;
      } finally {
        await docs.putDoc(KEYS.lock, { owner, expiresAt: toIso(deps.clock.now()) }).catch(() => undefined);
      }
    }
    await sleep(RESEED_LOCK_RETRY_MS);
  }
  logger?.warn('lever: a sweep held the lock; the touched baselines were not re-seated (Reset baselines does it)');
  return false;
}

/** Inputs are PATCHed without read-only provenance (config-apis.md: omit criblSourceProvenance). */
function writableInput(input: Obj): Obj {
  const out = clone(input);
  delete out.criblSourceProvenance;
  delete out.status;
  return out;
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const pipelineFileMatch = (gid: string, pipelineId: string) => (p: string) =>
  p.includes(`groups/${gid}/`) && p.includes(`/pipelines/${pipelineId}/`);
const routeTableMatch = (gid: string) => (p: string) =>
  p.includes(`groups/${gid}/`) && (basename(p) === 'route.yml' || basename(p) === 'routes.yml');
const inputsMatch = (gid: string) => (p: string) => p.includes(`groups/${gid}/`) && basename(p) === 'inputs.yml';
/** The group-wide files a lever commits whole (every route / every Source): core-5's shared-file guard watches them. */
const isSharedFile = (p: string): boolean => ['route.yml', 'routes.yml', 'inputs.yml'].includes(basename(p));
const anyOf =
  (...ms: ((p: string) => boolean)[]) =>
  (p: string): boolean =>
    ms.some((m) => m(p));

function stopFromError(e: unknown): LeverStop {
  if (e instanceof LeverStop) return e;
  if (e instanceof RateLimited) return new LeverStop('rate_limited', 429, 'Rate limited by the Leader; try again shortly');
  if (e instanceof VersionApiError) {
    if (e.code === 'nothing_to_commit' || e.code === 'invalid_files')
      return new LeverStop('no_change', 409, 'Nothing changed: the object is already in that state');
    if (e.code === 'deploy_failed') return new LeverStop('deploy_failed', e.status || 502, e.message);
    if (e.code === 'commit_failed') return new LeverStop('commit_failed', e.status || 502, e.message);
    return new LeverStop('failed', e.status || 502, e.message);
  }
  return new LeverStop('failed', 500, e instanceof Error ? e.message : String(e));
}

/**
 * When the console should try again. The Leader budget is per UTC minute, so a budget or rate-limit refusal
 * waits for the next minute (every refused attempt still costs three reads); the others retry in 10 s.
 */
function retryFor(code: LeverError, nowMs: number): number | undefined {
  if (code === 'budget' || code === 'rate_limited') return Math.max(1_000, MINUTE_MS - (nowMs % MINUTE_MS) + 1_000);
  return code === 'in_flight' || code === 'locked' ? LEVER_RETRY_MS : undefined;
}

/**
 * The shared lever protocol around a body: gate (demo mode, one in flight, budget) → mark in flight → body →
 * commit + deploy the touched files → timeline append → demo/state (changes, mutes, calls, in-flight cleared).
 */
async function runLever(
  name: LeverName,
  deps: LeverDeps,
  estimate: (demo: DemoState) => number,
  body: (ctx: LeverCtx) => Promise<LeverChange>,
): Promise<LeverResult> {
  const clock = deps.clock;
  const logger = deps.logger;
  const t = createMeteredTransport(deps.http, deps.kv, {
    clock,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  const docs = createKvDocs({
    kv: t.kv,
    codec: deps.codec,
    clock,
    ...(logger ? { logger } : {}),
  });
  const rawDocs = createKvDocs({
    kv: t.rawKv,
    codec: deps.codec,
    clock,
    ...(logger ? { logger } : {}),
  });
  const gid = deps.groupId ?? RIG_GROUP_ID;
  const refuse = (stop: LeverStop, extra: { commit?: string } = {}): LeverRefusal => {
    const r: LeverRefusal = {
      ok: false,
      lever: name,
      error: stop.code,
      status: stop.status,
      message: stop.message,
      calls: t.calls(),
      ...extra,
    };
    if (stop.id !== undefined) r.id = stop.id;
    const retry = retryFor(stop.code, clock.now());
    if (retry !== undefined) r.retryInMs = retry;
    return r;
  };

  let demo: DemoState | undefined;
  let marked = false;
  /** Core-5 (m25): shared files this lever's failed commit left pending (recorded for the shared-file guard). */
  let leftPending: string[] = [];
  try {
    const [settings, stored, meta] = await Promise.all([docs.getSettings(), docs.getDemoState(), docs.getMeta()]);
    if (!settings?.demo?.enabled) return refuse(new LeverStop('demo_disabled', 403, 'Demo mode is off. Turn it on under Settings → Demo.'));
    demo = stored ?? emptyDemoState();
    const startedAt = clock.now();
    if (demo.inFlight && startedAt - fromIso(demo.inFlight.since) < IN_FLIGHT_TTL_MS) {
      return refuse(new LeverStop('in_flight', 409, `${demo.inFlight.lever} is running. Other levers wait until it returns.`));
    }
    const minute = minuteKey(startedAt);
    const used =
      (meta?.callsThisMinute?.minute === minute ? meta.callsThisMinute.calls : 0) +
      (demo.leverCalls?.minute === minute ? demo.leverCalls.calls : 0);
    const need = estimate(demo);
    const cap = deps.minuteBudget ?? LEVER_MINUTE_BUDGET;
    // SPEC 7/11 ("meta.lastSweepCalls + its own estimate"): until this minute's sweep has run — it meters only
    // once the minute is 20 s old (core/sweep.ts SETTLE_MS) — keep its share free so a lever never starves it.
    // Only while a sweeper is alive, and never more than would refuse the minute's first lever.
    const lastSweepAt = meta?.lastSweepAt ? fromIso(meta.lastSweepAt) : Number.NaN;
    const sweepPending = meta?.callsThisMinute?.minute !== minute && startedAt - lastSweepAt < SWEEPER_ALIVE_MS;
    const reserve = sweepPending ? Math.max(0, Math.min(meta?.lastSweepCalls ?? 0, cap - need)) : 0;
    if (used + reserve + need > cap) {
      return refuse(
        new LeverStop('budget', 429, `The Leader budget for this minute is spent (${used}${reserve > 0 ? ` + ${reserve} held for the sweep` : ''} + ${need} > ${cap} calls); retrying shortly.`),
      );
    }

    demo = { ...demo, inFlight: { lever: name, since: toIso(startedAt) } };
    await docs.putDemoState(demo);
    marked = true;

    const ctx: LeverCtx = {
      deps,
      t,
      docs,
      gid,
      demo,
      settings,
      now: () => clock.now(),
    };
    const change = await body(ctx);

    let commit: string | undefined;
    let deployedAt: ISO | undefined;
    let files: string[] | undefined;
    if (change.message && change.match) {
      const committedAt = toIso(clock.now());
      try {
        files = await pendingFiles(t.http, gid, change.match);
        if (files.length === 0) throw new LeverStop('no_change', 409, 'Nothing changed: the object is already in that state');
        ({ commit, deployedAt } = await commitAndDeploy(t.http, gid, change.message, files, { clock }));
      } catch (e) {
        if (e instanceof VersionApiError && e.code === 'deploy_failed' && e.commit) {
          // Committed but not live: keep demo/state in step with the committed config so Restore still works.
          await finish(docs, rawDocs, demo, change, t, clock.now(), logger);
          marked = false;
          return refuse(stopFromError(e), { commit: e.commit });
        }
        // Nothing was committed: put the object back as it was read (best effort).
        await change.rollback?.().catch(() => undefined);
        leftPending = (files ?? []).filter((f) => isSharedFile(f));
        throw e;
      }
      const timeline = await docs.getTimeline();
      const nowIso = toIso(clock.now());
      await docs.putTimeline(
        mergeCommits(
          timeline,
          gid,
          [
            {
              hash: commit,
              message: change.message,
              author: deps.author || 'unknown',
              committedAt,
              deployedAt,
              groupId: gid,
              files,
              source: 'demo',
            },
          ],
          nowIso,
        ),
      );
    }

    // Core-5 (M5): the change is live; re-seat what it moved, so its mute is not just a postponed alert.
    if (change.reseed) await reseedUnderLock(deps, docs, settings, change.reseed, logger);
    // Core-5 (m25): a commit that carried a file this lever had left pending clears it.
    if (files && demo.leftPending?.length) {
      const committed = new Set(files);
      const rest = demo.leftPending.filter((f) => !committed.has(f));
      demo = { ...demo, ...(rest.length > 0 ? { leftPending: rest } : {}) };
      if (rest.length === 0) delete demo.leftPending;
    }
    await finish(docs, rawDocs, demo, change, t, clock.now(), logger);
    marked = false;
    const ok: LeverSuccess = { ok: true, lever: name, calls: t.calls() };
    if (commit) ok.commit = commit;
    if (deployedAt) ok.deployedAt = deployedAt;
    if (change.message && commit) ok.message = change.message;
    if (files) ok.files = files;
    return ok;
  } catch (e) {
    const stop = stopFromError(e);
    if (!(e instanceof LeverStop)) logger?.warn(`lever ${name} failed`, e);
    if (marked) await clearInFlight(rawDocs, leftPending.length > 0 ? { ...demo!, leftPending: [...new Set([...(demo!.leftPending ?? []), ...leftPending])] } : demo!, t, clock.now(), logger);
    return refuse(stop);
  }
}

/** Applies the change to demo/state, mutes, records this lever's calls and clears the in-flight marker (1 write). */
async function finish(
  docs: KvDocs,
  rawDocs: KvDocs,
  demo: DemoState,
  change: LeverChange,
  t: MeteredTransport,
  nowMs: number,
  logger?: Logger,
): Promise<void> {
  const next = clone(demo);
  change.update(next);
  const until = toIso(nowMs + MUTE_MS);
  const muted: Record<ObjectKey, ISO> = {};
  for (const [k, v] of Object.entries(next.muted ?? {})) if (fromIso(v) > nowMs) muted[k] = v;
  for (const k of change.mute ?? []) muted[k] = until;
  next.muted = muted;
  delete next.inFlight;
  const minute = minuteKey(nowMs);
  next.leverCalls = {
    minute,
    calls: (demo.leverCalls?.minute === minute ? demo.leverCalls.calls : 0) + t.calls() + 1,
  };
  try {
    await docs.putDemoState(next);
  } catch (e) {
    logger?.warn('lever: could not record demo/state; retrying without the rate-limit guard', e);
    await rawDocs.putDemoState(next);
  }
}

/** Clears a failed lever's in-flight marker (best effort, outside the 429 guard). */
async function clearInFlight(rawDocs: KvDocs, current: DemoState, t: MeteredTransport, nowMs: number, logger?: Logger): Promise<void> {
  try {
    const next = { ...current };
    delete next.inFlight;
    const minute = minuteKey(nowMs);
    next.leverCalls = {
      minute,
      calls: (current.leverCalls?.minute === minute ? current.leverCalls.calls : 0) + t.calls() + 1,
    };
    await rawDocs.putDemoState(next);
  } catch (e) {
    logger?.warn('lever: could not clear the in-flight marker (it expires in 90 s)', e);
  }
}

// ─── Route table helpers ─────────────────────────────────────────────────────
interface RouteTable {
  table: Obj;
  tableId: string;
  routes: Obj[];
}

async function getRouteTable(ctx: LeverCtx): Promise<RouteTable> {
  const res = await ctx.t.http.request('GET', urls.routes(ctx.gid));
  if (!res.ok) throw httpStop(res, `routes of ${ctx.gid}`);
  const tables = itemsOf(res);
  const table = tables.find((x) => x.id === 'default') ?? tables[0];
  if (!table || !Array.isArray(table.routes)) throw new LeverStop('not_found', 404, `routing table of ${ctx.gid} not found`);
  return {
    table,
    tableId: typeof table.id === 'string' && table.id ? table.id : 'default',
    routes: (table.routes as unknown[]).filter(isObj),
  };
}

/**
 * Finds a route by id; failing that, a rig key / input id / other route-id spelling resolves to the route whose
 * id is one of the rig Source's route ids or whose filter selects its input (live and emulated rigs differ).
 */
function findRoute(rt: RouteTable, routeId: string): { route: Obj; index: number; id: string } {
  let index = rt.routes.findIndex((r) => r.id === routeId);
  if (index < 0) {
    const src = rigSource(routeId);
    if (src) {
      index = rt.routes.findIndex((r) => {
        const id = typeof r.id === 'string' ? r.id : '';
        return (
          src.routeIds.includes(id) ||
          rigSourceForRoute({
            id,
            filter: typeof r.filter === 'string' ? r.filter : undefined,
          }) === src
        );
      });
    }
  }
  if (index < 0) throw new LeverStop('not_found', 404, `route ${routeId} not found`);
  return { route: rt.routes[index], index, id: String(rt.routes[index].id) };
}

async function setRoutePipeline(ctx: LeverCtx, rt: RouteTable, index: number, pipelineId: string): Promise<() => Promise<void>> {
  const next = clone(rt.table);
  const routes = (next.routes as Obj[]).filter(isObj);
  routes[index] = { ...routes[index], pipeline: pipelineId };
  next.routes = routes;
  await patch(ctx, urls.route(ctx.gid, rt.tableId), next, `route table ${rt.tableId}`);
  return () => patch(ctx, urls.route(ctx.gid, rt.tableId), rt.table, `route table ${rt.tableId}`);
}

// ─── Levers ──────────────────────────────────────────────────────────────────
/** "Apply the pack" (keys 1/2/3; `aggressive` = G): point a demo route at its pack pipeline. */
export function applyPack(deps: LeverDeps, args: { routeId: string; level?: 'pack' | 'aggressive' }): Promise<LeverResult> {
  return runLever(
    'applyPack',
    deps,
    () => LEVER_CALLS + SHARED_CHECK_CALLS + LEVELS_READ_CALLS,
    async (ctx) => {
      const rt = await getRouteTable(ctx);
      const { route, index, id: routeId } = findRoute(rt, args.routeId);
      requireTag(route.description, routeId);
      const src = rigSourceForRoute({
        id: routeId,
        filter: typeof route.filter === 'string' ? route.filter : undefined,
      });
      if (!src?.packPipelineId) throw new LeverStop('invalid', 400, `route ${routeId} has no pack to apply`);
      const level = args.level ?? 'pack';
      const target = level === 'aggressive' && src.aggressivePipelineId ? src.aggressivePipelineId : src.packPipelineId;
      const current = typeof route.pipeline === 'string' ? route.pipeline : '';
      if (current === target) throw new LeverStop('no_change', 409, `route ${routeId} already runs ${target}`);
      await assertSharedClean(ctx, routeTableMatch(ctx.gid), 'pipelines/route.yml');
      const prior = ctx.demo.routes[routeId];
      // Core-5 (M5): the levels this route's objects hold before the (first) apply, for Revert to re-seat.
      const levelsBefore =
        prior?.levelsBefore ?? (await levelsOf(ctx, [objectKey('route', ctx.gid, routeId), ...(current ? [objectKey('pipe', ctx.gid, current)] : []), ...rigObjectKeys(src, ctx.gid, [current])]));
      const undo = await setRoutePipeline(ctx, rt, index, target);
      return {
        message: `demo: apply the pack on ${routeId}`,
        match: routeTableMatch(ctx.gid),
        rollback: undo,
        update(state) {
          state.routes[routeId] = {
            previousPipelineId: prior?.previousPipelineId ?? current,
            appliedAt: toIso(ctx.now()),
            level,
            levelsBefore,
          };
        },
      };
    },
  );
}

/** "Revert the pack" (V): back to the route's previous pipeline; mutes the route's objects for 10 minutes. */
export function revertPack(deps: LeverDeps, args: { routeId: string }): Promise<LeverResult> {
  return runLever(
    'revertPack',
    deps,
    () => LEVER_CALLS + SHARED_CHECK_CALLS + RESEED_CALLS,
    async (ctx) => {
      const rt = await getRouteTable(ctx);
      const { route, index, id: routeId } = findRoute(rt, args.routeId);
      requireTag(route.description, routeId);
      const src = rigSourceForRoute({
        id: routeId,
        filter: typeof route.filter === 'string' ? route.filter : undefined,
      });
      const state = ctx.demo.routes[routeId];
      const previous = state?.previousPipelineId ?? src?.pipelineId;
      if (!previous) throw new LeverStop('invalid', 400, `no previous pipeline is known for route ${routeId}`);
      const current = typeof route.pipeline === 'string' ? route.pipeline : '';
      const mute = new Set<ObjectKey>([objectKey('route', ctx.gid, routeId), objectKey('pipe', ctx.gid, previous)]);
      if (current) mute.add(objectKey('pipe', ctx.gid, current));
      if (src) for (const k of rigObjectKeys(src, ctx.gid, [previous, current])) mute.add(k);
      // Core-5 (M5): back to the levels before the apply (unknown: forgotten, re-learned after the mute).
      const reseed: Record<ObjectKey, number | null> = {};
      for (const k of mute) reseed[k] = state?.levelsBefore?.[k] ?? null;
      if (current === previous) {
        // Already reverted (e.g. by hand in the Cribl UI): forget the applied state, or say there is nothing to do.
        if (!state) throw new LeverStop('no_change', 409, `route ${routeId} already runs ${previous}`);
        return { update: (s) => void delete s.routes[routeId], reseed };
      }
      await assertSharedClean(ctx, routeTableMatch(ctx.gid), 'pipelines/route.yml');
      const undo = await setRoutePipeline(ctx, rt, index, previous);
      return {
        message: `demo: revert the pack on ${routeId}`,
        match: routeTableMatch(ctx.gid),
        rollback: undo,
        update(s) {
          delete s.routes[routeId];
        },
        mute: [...mute],
        reseed,
      };
    },
  );
}

/** Finds the `[mr-trim]` function of a demo pipeline (after checking the pipeline's own tag). */
function trimFunction(pipeline: Obj, pipelineId: string): { functions: Obj[]; index: number } {
  const conf = isObj(pipeline.conf) ? pipeline.conf : {};
  requireTag(conf.description ?? pipeline.description, pipelineId);
  const functions = Array.isArray(conf.functions) ? (conf.functions as unknown[]).filter(isObj) : [];
  const index = functions.findIndex((f) => typeof f.description === 'string' && f.description.includes(TRIM_TAG));
  if (index < 0) throw new LeverStop('invalid', 400, `pipeline ${pipelineId} has no ${TRIM_TAG} function`);
  return { functions, index };
}

function withFunction(pipeline: Obj, functions: Obj[], index: number, fn: Obj): Obj {
  const next = clone(pipeline);
  const conf = isObj(next.conf) ? next.conf : {};
  const list = functions.map((f) => clone(f));
  list[index] = fn;
  next.conf = { ...conf, functions: list };
  return next;
}

/** "Break the trim" (B): disables the pipeline's `[mr-trim]` function. */
export function breakTrim(deps: LeverDeps, args: { pipelineId: string }): Promise<LeverResult> {
  return runLever(
    'breakTrim',
    deps,
    () => LEVER_CALLS + LEVELS_READ_CALLS,
    async (ctx) => {
      const path = urls.pipeline(ctx.gid, args.pipelineId);
      const pipeline = await getOne(ctx, path, `pipeline ${args.pipelineId}`);
      const { functions, index } = trimFunction(pipeline, args.pipelineId);
      const fn = functions[index];
      if (fn.disabled === true) throw new LeverStop('no_change', 409, `the trim on ${args.pipelineId} is already broken`);
      const prior = ctx.demo.trim[args.pipelineId];
      // Core-5 (M5): the levels this pipeline's objects hold before the break, for Restore to re-seat.
      const levelsBefore = prior?.levelsBefore ?? (await levelsOf(ctx, pipelineMuteKeys(ctx.gid, args.pipelineId)));
      await patch(
        ctx,
        path,
        withFunction(pipeline, functions, index, {
          ...clone(fn),
          disabled: true,
        }),
        `pipeline ${args.pipelineId}`,
      );
      return {
        message: `demo: break the trim on ${args.pipelineId}`,
        match: pipelineFileMatch(ctx.gid, args.pipelineId),
        rollback: () => patch(ctx, path, pipeline, `pipeline ${args.pipelineId}`),
        update(s) {
          s.trim[args.pipelineId] = {
            functionIndex: index,
            previous: prior?.previous ?? clone(fn),
            brokenAt: toIso(ctx.now()),
            levelsBefore,
          };
        },
      };
    },
  );
}

/** "Restore" (R): puts the `[mr-trim]` function back exactly as it was; mutes the pipeline's objects. */
export function restoreTrim(deps: LeverDeps, args: { pipelineId: string }): Promise<LeverResult> {
  return runLever(
    'restoreTrim',
    deps,
    () => LEVER_CALLS + RESEED_CALLS,
    async (ctx) => {
      const path = urls.pipeline(ctx.gid, args.pipelineId);
      const pipeline = await getOne(ctx, path, `pipeline ${args.pipelineId}`);
      const change = restoreTrimOn(ctx, pipeline, args.pipelineId);
      const reseed = trimReseed(ctx, args.pipelineId);
      if (!change) {
        // Already restored (e.g. by hand): forget the broken state, or say there is nothing to do.
        if (!ctx.demo.trim[args.pipelineId]) throw new LeverStop('no_change', 409, `the trim on ${args.pipelineId} is not broken`);
        return { update: (s) => void delete s.trim[args.pipelineId], reseed };
      }
      await patch(ctx, path, change.next, `pipeline ${args.pipelineId}`);
      return {
        message: `demo: restore the trim on ${args.pipelineId}`,
        match: pipelineFileMatch(ctx.gid, args.pipelineId),
        rollback: () => patch(ctx, path, pipeline, `pipeline ${args.pipelineId}`),
        update(s) {
          delete s.trim[args.pipelineId];
        },
        mute: pipelineMuteKeys(ctx.gid, args.pipelineId),
        reseed,
      };
    },
  );
}

/** The restored pipeline, or undefined when the trim is already as it was. */
function restoreTrimOn(ctx: LeverCtx, pipeline: Obj, pipelineId: string): { next: Obj } | undefined {
  const { functions, index } = trimFunction(pipeline, pipelineId);
  const stored = ctx.demo.trim[pipelineId];
  const at =
    stored && functions[stored.functionIndex] && String(functions[stored.functionIndex].description ?? '').includes(TRIM_TAG)
      ? stored.functionIndex
      : index;
  const current = functions[at];
  // Trust the recorded function only if it is the trim function; otherwise just re-enable what is there.
  const recorded =
    isObj(stored?.previous) && String(stored.previous.description ?? '').includes(TRIM_TAG) ? (stored.previous as Obj) : undefined;
  const restored: Obj = recorded ? clone(recorded) : { ...clone(current), disabled: false };
  if (same(current, restored)) return undefined;
  return { next: withFunction(pipeline, functions, at, restored) };
}

/** Core-5 (M5): Restore's re-seat — the levels before the break (unknown: forgotten, re-learned). */
function trimReseed(ctx: LeverCtx, pipelineId: string): Record<ObjectKey, number | null> {
  const before = ctx.demo.trim[pipelineId]?.levelsBefore;
  const out: Record<ObjectKey, number | null> = {};
  for (const k of pipelineMuteKeys(ctx.gid, pipelineId)) out[k] = before?.[k] ?? null;
  return out;
}

function pipelineMuteKeys(gid: string, pipelineId: string): ObjectKey[] {
  const keys = new Set<ObjectKey>([objectKey('pipe', gid, pipelineId)]);
  for (const src of rigSourcesUsingPipeline(pipelineId)) for (const k of rigObjectKeys(src, gid, [pipelineId])) keys.add(k);
  return [...keys];
}

/** "Spike" / "Calm" (S / C): sets a demo Datagen Source to its baseline rate × multiplier (0.1–10). */
export function setRate(deps: LeverDeps, args: { inputId: string; multiplier: number }): Promise<LeverResult> {
  return runLever(
    'setRate',
    deps,
    () => LEVER_CALLS + SHARED_CHECK_CALLS,
    async (ctx) => {
      const m = args.multiplier;
      if (!(Number.isFinite(m) && m >= MIN_RATE_MULTIPLIER && m <= MAX_RATE_MULTIPLIER)) {
        throw new LeverStop('invalid', 400, `multiplier must be between ${MIN_RATE_MULTIPLIER} and ${MAX_RATE_MULTIPLIER}`);
      }
      const path = urls.input(ctx.gid, args.inputId);
      const input = await getOne(ctx, path, `source ${args.inputId}`);
      requireTag(input.description, args.inputId);
      const samples = Array.isArray(input.samples) ? (input.samples as unknown[]).filter(isObj) : [];
      const current = Number(samples[0]?.eventsPerSec);
      if (input.type !== 'datagen' || samples.length === 0 || !Number.isFinite(current)) {
        throw new LeverStop('invalid', 400, `${args.inputId} is not a Datagen source with a rate`);
      }
      const baseline = ctx.demo.rates[args.inputId]?.baselineEps ?? current;
      const eps = Math.max(1, Math.round(baseline * m));
      if (eps === current) throw new LeverStop('no_change', 409, `${args.inputId} already runs at ${eps} events/s`);
      await assertSharedClean(ctx, inputsMatch(ctx.gid), 'inputs.yml');
      const next = writableInput(input);
      next.samples = samples.map((s, i) => (i === 0 ? { ...clone(s), eventsPerSec: eps } : clone(s)));
      await patch(ctx, path, next, `source ${args.inputId}`);
      return {
        message: `demo: set ${args.inputId} to ${m}x`,
        match: inputsMatch(ctx.gid),
        rollback: () => patch(ctx, path, writableInput(input), `source ${args.inputId}`),
        update(s) {
          if (m === 1) delete s.rates[args.inputId];
          else
            s.rates[args.inputId] = {
              baselineEps: baseline,
              multiplier: m,
              setAt: toIso(ctx.now()),
            };
        },
      };
    },
  );
}

/** Runs `fn` while holding the sweep lock, so a sweep in progress can't write back what the lever resets. */
async function withSweepLock<T>(ctx: LeverCtx, fn: () => Promise<T>): Promise<T> {
  const owner = ctx.deps.owner ?? `lever:${ctx.deps.author || 'unknown'}`;
  if (!(await ctx.docs.acquireLock(owner, LOCK_TTL_MS)))
    throw new LeverStop('locked', 409, 'A sweep is writing right now; retrying shortly.');
  try {
    return await fn();
  } finally {
    await ctx.docs.putDoc(KEYS.lock, { owner, expiresAt: toIso(ctx.now()) }).catch(() => undefined);
  }
}

/** "Reset baselines" (Tier 1): deletes `baselines` so the EWMA re-learns from the next samples (SPEC 9.2, 11). */
export function resetBaselines(deps: LeverDeps): Promise<LeverResult> {
  return runLever(
    'resetBaselines',
    deps,
    () => 11,
    async (ctx) => {
      await withSweepLock(ctx, () => ctx.docs.del('baselines'));
      return { update: () => undefined };
    },
  );
}

/**
 * "Reset everything" (0): restores every broken trim, every Datagen rate to 1× and every budget override,
 * closes demo-caused incidents, clears the scene and mutes everything it touched for 10 minutes. One commit
 * (`demo: reset everything`) carries the config changes. Applied packs are left alone ("Revert all" is V).
 */
export function resetAll(deps: LeverDeps): Promise<LeverResult> {
  // Core-5: + version/status when a rate is reset (inputs.yml), + the snapshot and baselines read and the baselines write.
  const estimate = (demo: DemoState): number => 20 + 3 + SHARED_CHECK_CALLS + 2 * (Object.keys(demo.trim ?? {}).length + Object.keys(demo.rates ?? {}).length);
  return runLever('resetAll', deps, estimate, (ctx) =>
    withSweepLock(ctx, async () => {
      // 1. Read and check everything first, so a refusal (untagged, missing) leaves the org untouched.
      const writes: {
        path: string;
        next: Obj;
        original: Obj;
        what: string;
        match: (p: string) => boolean;
      }[] = [];
      const mute = new Set<ObjectKey>();
      for (const pipelineId of Object.keys(ctx.demo.trim ?? {})) {
        const path = urls.pipeline(ctx.gid, pipelineId);
        const pipeline = await getOne(ctx, path, `pipeline ${pipelineId}`);
        const change = restoreTrimOn(ctx, pipeline, pipelineId);
        for (const k of pipelineMuteKeys(ctx.gid, pipelineId)) mute.add(k);
        if (change)
          writes.push({
            path,
            next: change.next,
            original: pipeline,
            what: `pipeline ${pipelineId}`,
            match: pipelineFileMatch(ctx.gid, pipelineId),
          });
      }
      for (const [inputId, rate] of Object.entries(ctx.demo.rates ?? {})) {
        const path = urls.input(ctx.gid, inputId);
        const input = await getOne(ctx, path, `source ${inputId}`);
        requireTag(input.description, inputId);
        const src = rigSource(inputId);
        if (src) for (const k of rigObjectKeys(src, ctx.gid)) mute.add(k);
        else mute.add(objectKey('in', ctx.gid, inputId));
        const samples = Array.isArray(input.samples) ? (input.samples as unknown[]).filter(isObj) : [];
        if (samples.length === 0 || Number(samples[0].eventsPerSec) === rate.baselineEps) continue;
        const next = writableInput(input);
        next.samples = samples.map((s, i) => (i === 0 ? { ...clone(s), eventsPerSec: rate.baselineEps } : clone(s)));
        writes.push({
          path,
          next,
          original: writableInput(input),
          what: `source ${inputId}`,
          match: inputsMatch(ctx.gid),
        });
      }

      // Core-5 (m25): a Source's rate is committed through the shared inputs.yml — never with someone else's edit in it.
      if (writes.some((wr) => wr.what.startsWith('source '))) await assertSharedClean(ctx, inputsMatch(ctx.gid), 'inputs.yml');

      // 2. Apply; a failed PATCH puts back the ones already made.
      const undo: (() => Promise<void>)[] = [];
      const rollback = async (): Promise<void> => {
        for (const u of [...undo].reverse()) await u().catch(() => undefined);
      };
      try {
        for (const wr of writes) {
          await patch(ctx, wr.path, wr.next, wr.what);
          undo.push(() => patch(ctx, wr.path, wr.original, wr.what));
        }
      } catch (e) {
        await rollback();
        throw e;
      }

      // Budgets a scene overrode.
      const overrides = Object.entries(ctx.demo.budgetsOverride ?? {});
      if (overrides.length > 0) {
        const budgets = { ...(ctx.settings.budgets ?? {}) };
        for (const [outputId, o] of overrides) {
          if (o.previousCentsPerMonth === undefined) delete budgets[outputId];
          else budgets[outputId] = { centsPerMonth: o.previousCentsPerMonth };
          mute.add(objectKey('out', ctx.gid, outputId));
        }
        await ctx.docs.putSettings({
          ...ctx.settings,
          budgets,
          updatedAt: toIso(ctx.now()),
        });
      }

      // Close open incidents a demo caused (today's and yesterday's docs hold every open one in a demo).
      const nowMs = ctx.now();
      const closedNow: Incident[] = [];
      for (const key of [incidentsDocKey(nowMs), incidentsDocKey(nowMs - DAY_MS)]) {
        const doc = await ctx.docs.getIncidents(key);
        if (!doc) continue;
        const items = closeDemoIncidents(doc.items, toIso(nowMs));
        items.forEach((it, i) => {
          if (it.closedAt && !doc.items[i]?.closedAt) closedNow.push(it);
        });
        if (!same(items, doc.items)) await ctx.docs.putIncidents(key, { schemaVersion: 1, items });
      }

      // Core-5 (M6, #27): re-seat what the reset touched, under the lock it already holds, or the next sweep re-opens
      // what it just closed ("cause unknown"): every object whose incident closed, at the level it holds now (Accept's
      // rule); every restored trim's objects at their level before the break; every reset Source forgotten (re-learned).
      const warm = ctx.settings.thresholds?.warmupSamples ?? 10;
      const nowIso = toIso(nowMs);
      if (closedNow.length > 0 || writes.length > 0) {
        const snapshot = closedNow.length > 0 ? await ctx.docs.getSnapshot() : null;
        let next: BaselinesDoc = (await ctx.docs.getBaselines()) ?? { schemaVersion: 1, updatedAt: nowIso, byObject: {}, rules: {} };
        for (const inc of closedNow) next = acceptIntoBaselines(next, inc, currentReading(snapshot, inc), warm, nowIso);
        const reseed: Record<ObjectKey, number | null> = {};
        for (const pipelineId of Object.keys(ctx.demo.trim ?? {})) Object.assign(reseed, trimReseed(ctx, pipelineId));
        for (const inputId of Object.keys(ctx.demo.rates ?? {})) reseed[objectKey('in', ctx.gid, inputId)] = null;
        await ctx.docs.putBaselines(reseededBaselines(next, reseed, warm, nowIso));
      }

      const change: LeverChange = {
        update(s) {
          s.trim = {};
          s.rates = {};
          delete s.scene;
          delete s.budgetsOverride;
        },
        mute: [...mute],
      };
      if (writes.length > 0) {
        change.message = 'demo: reset everything';
        change.match = anyOf(...writes.map((wr) => wr.match));
        change.rollback = rollback;
      }
      return change;
    }),
  );
}
