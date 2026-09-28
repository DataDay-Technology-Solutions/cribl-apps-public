// src/demo/client.ts — the Demo Console's lever client (SPEC 11, PRD 8.7). DEMO BUILD ONLY.
//
// Wraps core/demo/levers.ts (and core/weekly.ts for "Weekly receipt now") with the browser's transports,
// and adds what the console needs around them:
//   • ONE job in flight at a time. Every job — and every write this module makes to demo/state (the scene
//     runner's step records) — runs on one serial queue. That matters for correctness, not just UX:
//     core `runLever` reads demo/state when it starts and writes its own copy back when it finishes, so a
//     scene write made while a lever is running would be silently overwritten.
//   • A live stage for the status line ("committing…", "deploying…"), read off the Leader calls the lever
//     makes (the version/commit POST, then the deploy PATCH).
//   • Refusals that mean "not now" (the Leader budget, another lever in flight, the sweep lock, a 429)
//     are retried automatically after max(10 s, the lever's own retryInMs) with a visible countdown the
//     member can cancel. SPEC 11 says "10 s later"; the core points budget refusals at the next minute
//     because every refused attempt still costs three reads, so the countdown honours whichever is longer.
//   • The caller: `window.getCriblUser().username` goes into every commit's timeline entry (SPEC 10).
//
// Volatile operations (AGENTS.md): nothing here runs on load, render or a timer of its own accord — a job
// starts from a click, a key press, or a scene the member started (the scene is the confirmed intent).

import type { Clock, Commit, CriblHttp, DemoState, KvStore, Logger, WebhookSender } from '../../core/types.ts';
import { detectCodec, type Codec } from '../../core/codec.ts';
import { createFetchHttp, type FetchLike } from '../../core/http.ts';
import { createFetchKvStore, createKvDocs, type KvDocs } from '../../core/kv.ts';
import { createFetchWebhookSender } from '../../core/adapters/webhook.ts';
import { createConsoleLogger, createOwnerId, linkBaseFrom, workspaceFromUrl } from '../../core/runtime.ts';
import {
  LEVER_RETRY_MS,
  applyPack,
  breakTrim,
  emptyDemoState,
  resetAll,
  resetBaselines,
  restoreTrim,
  revertPack,
  setRate,
  type LeverDeps,
  type LeverError,
  type LeverName,
  type LeverRefusal,
  type LeverResult,
} from '../../core/demo/levers.ts';
import { RIG_GROUP_ID, rigSource } from '../../core/demo/rig-ids.ts';
import { runWeeklyReceipt, type WeeklyResult } from '../../core/weekly.ts';
import { TRIM_PIPELINE, type PackRouteKey } from './scenes.ts';

// ─── Jobs ────────────────────────────────────────────────────────────────────
export type DemoJob =
  | { kind: 'applyPack'; routeKey: PackRouteKey; level: 'pack' | 'aggressive' }
  | { kind: 'revertPack'; routeKey: PackRouteKey }
  /** "Revert all" (V): every route demo/state says has a pack applied. */
  | { kind: 'revertAll' }
  | { kind: 'breakTrim'; pipelineId: string }
  /** "Restore" (R): the named trim, or every trim demo/state says is broken (default Payments API). */
  | { kind: 'restoreTrim'; pipelineId?: string }
  | { kind: 'setRate'; inputId: string; multiplier: number }
  | { kind: 'resetAll' }
  | { kind: 'resetBaselines' }
  | { kind: 'weekly' };

export type JobKind = DemoJob['kind'];

/** Where a running lever is, from the Leader calls it makes. */
export type LeverStage = 'preparing' | 'saving' | 'committing' | 'deploying' | 'recording' | 'sending';

export type JobError = LeverError | 'busy' | 'cancelled';

export interface JobOutcome {
  ok: boolean;
  job: DemoJob;
  /** Each lever call the job made (Revert all / Restore all make several). */
  results: LeverResult[];
  weekly?: WeeklyResult;
  /** Set when !ok. */
  error?: JobError;
  message?: string;
  /** The commit a single-lever job made (for toasts and tests). */
  commit?: string;
  deployedAt?: string;
}

export interface RetryState {
  /** epoch ms of the next attempt */
  at: number;
  reason: LeverError;
  attempt: number;
}

export interface ClientStatus {
  busy: boolean;
  job?: DemoJob;
  startedAt?: number;
  stage?: LeverStage;
  retry?: RetryState;
  /**
   * The commits this tab's levers made, newest first (at most RECENT_COMMITS), as the timeline records them.
   * The lever ledger shows them at once; the snapshot's timeline only has them after the next sweep.
   */
  recent?: Commit[];
  last?: {
    job: DemoJob;
    ok: boolean;
    at: number;
    error?: JobError;
    message?: string;
  };
}

// ─── Dependencies ────────────────────────────────────────────────────────────
export interface DemoDeps {
  http: CriblHttp;
  kv: KvStore;
  webhook: WebhookSender;
  clock: Clock;
  codec: Codec;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  workspace: string;
  linkBase: string;
  owner?: string;
  groupId?: string;
  /** Leader calls a minute may reach with a lever (core default 45). */
  minuteBudget?: number;
}

export interface DemoTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DemoClientOptions {
  deps: DemoDeps;
  /** The member pulling the lever (SPEC 10: the commit's author in the timeline). */
  author: () => Promise<string>;
  timers?: DemoTimers;
  /** Called with demo/state after every job and every scene write (the view pushes it into the store). */
  onDemoState?: (state: DemoState | null) => void;
  /** Called after a job that may have changed what the next snapshot shows (re-poll now). */
  onSettled?: (outcome: JobOutcome) => void | Promise<unknown>;
  /** Minimum wait before a retriable refusal is tried again (default LEVER_RETRY_MS, 10 s). */
  retryDelayMs?: number;
  /** Attempts per lever before giving up (default 12 ≈ several minutes of budget contention). */
  maxAttempts?: number;
}

export interface DemoClient {
  /** Runs a job unless one is already in flight (then resolves `{ ok:false, error:'busy' }` at once). */
  run(job: DemoJob): Promise<JobOutcome>;
  status(): ClientStatus;
  subscribe(listener: () => void): () => void;
  /** Stops a pending automatic retry; the job resolves `cancelled`. */
  cancelRetry(): void;
  /** Reads demo/state (null when absent). */
  readDemoState(): Promise<DemoState | null>;
  /**
   * Read-modify-write of demo/state on the job queue (never concurrent with a lever). `update` returns the
   * next state, or null to leave it untouched. Resolves with what was written (or read).
   */
  updateDemoState(update: (state: DemoState) => DemoState | null): Promise<DemoState>;
  dispose(): void;
}

/** How many of this tab's own lever commits the client remembers for the lever ledger. */
export const RECENT_COMMITS = 10;

/** Refusals that mean "not now" and are retried after a countdown. */
export const RETRIABLE: ReadonlySet<LeverError> = new Set<LeverError>(['budget', 'in_flight', 'locked', 'rate_limited']);

const defaultTimers: DemoTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Maps a Leader call to the lever's stage (null = no change). Exported for tests. */
export function stageForCall(method: string, path: string): LeverStage | null {
  if (path.includes('/version/commit')) return 'committing';
  if (path.includes('/version/status')) return 'committing';
  if (path.includes('/deploy')) return 'deploying';
  if (method === 'PATCH' && (path.includes('/pipelines/') || path.includes('/routes') || path.includes('/system/inputs/'))) return 'saving';
  if (path.startsWith('/kvstore/timeline') && method === 'PUT') return 'recording';
  return null;
}

const STAGE_ORDER: readonly LeverStage[] = ['preparing', 'saving', 'committing', 'deploying', 'recording', 'sending'];

export function createDemoClient(options: DemoClientOptions): DemoClient {
  const { deps } = options;
  const timers = options.timers ?? defaultTimers;
  const retryDelay = options.retryDelayMs ?? LEVER_RETRY_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 12);
  const gid = deps.groupId ?? RIG_GROUP_ID;
  const docs: KvDocs = createKvDocs({
    kv: deps.kv,
    codec: deps.codec,
    clock: deps.clock,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  let state: ClientStatus = { busy: false };
  const listeners = new Set<() => void>();
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let retryTimer: unknown;
  let retryResolve: ((go: boolean) => void) | null = null;

  const emit = () => {
    for (const l of [...listeners]) l();
  };
  const setStatus = (patch: Partial<ClientStatus>, remove: (keyof ClientStatus)[] = []) => {
    const next: ClientStatus = { ...state, ...patch };
    for (const k of remove) delete next[k];
    state = next;
    emit();
  };

  /** Chains `task` after everything queued before it; failures don't break the chain. */
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  /** Stages only move forward within one job (a rollback PATCH after a failed commit is still "saving"). */
  const advanceStage = (stage: LeverStage | null) => {
    if (!stage || !state.busy || state.stage === stage) return;
    const cur = state.stage ? STAGE_ORDER.indexOf(state.stage) : -1;
    if (STAGE_ORDER.indexOf(stage) > cur) setStatus({ stage });
  };

  // The lever's calls, observed for the status line's stage.
  const observedHttp: CriblHttp = {
    request(method, path, body, opts) {
      advanceStage(stageForCall(method, path));
      return deps.http.request(method, path, body, opts);
    },
  };

  // The timeline append ("recording…") is a KV write, which does not pass through `http`.
  const observedKv: KvStore = {
    get: (key) => deps.kv.get(key),
    put(key, value) {
      advanceStage(stageForCall('PUT', `/kvstore/${key}`));
      return deps.kv.put(key, value);
    },
    del: (key) => deps.kv.del(key),
    list: (prefix) => deps.kv.list(prefix),
  };

  const leverDeps = async (): Promise<LeverDeps> => {
    const author = await options.author().catch(() => 'unknown');
    const out: LeverDeps = {
      http: observedHttp,
      kv: observedKv,
      clock: deps.clock,
      codec: deps.codec,
      author: author || 'unknown',
      groupId: gid,
    };
    if (deps.logger) out.logger = deps.logger;
    if (deps.sleep) out.sleep = deps.sleep;
    if (deps.owner) out.owner = deps.owner;
    if (deps.minuteBudget !== undefined) out.minuteBudget = deps.minuteBudget;
    return out;
  };

  /** Waits `ms` unless cancelled. Resolves true to go on, false when cancelled. */
  const waitRetry = (ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      retryResolve = resolve;
      retryTimer = timers.setTimeout(() => {
        retryTimer = undefined;
        retryResolve = null;
        resolve(true);
      }, ms);
    });

  /** A lever's commit, as core/demo/levers.ts appends it to the timeline (for the lever ledger). */
  const remember = (result: LeverResult, author: string) => {
    if (!result.ok || !result.commit) return;
    const committedAt = result.deployedAt ?? new Date(deps.clock.now()).toISOString();
    const commit: Commit = {
      hash: result.commit,
      message: result.message ?? '',
      author,
      committedAt,
      groupId: gid,
      files: result.files ?? [],
      source: 'demo',
    };
    if (result.deployedAt) commit.deployedAt = result.deployedAt;
    setStatus({ recent: [commit, ...(state.recent ?? []).filter((c) => c.hash !== commit.hash)].slice(0, RECENT_COMMITS) });
  };

  /** One core lever, retried through "not now" refusals. */
  const withRetry = async (call: (d: LeverDeps) => Promise<LeverResult>): Promise<LeverResult> => {
    const d = await leverDeps();
    for (let attempt = 1; ; attempt++) {
      setStatus({ stage: 'preparing' }, ['retry']);
      const result = await call(d);
      remember(result, d.author);
      if (result.ok || !RETRIABLE.has(result.error) || attempt >= maxAttempts || disposed) return result;
      const wait = Math.max(retryDelay, result.retryInMs ?? 0);
      setStatus(
        {
          retry: { at: deps.clock.now() + wait, reason: result.error, attempt },
        },
        ['stage'],
      );
      const go = await waitRetry(wait);
      if (!go) {
        const cancelled: LeverRefusal = {
          ...result,
          message: 'Retry cancelled',
        };
        throw new CancelledError(cancelled);
      }
    }
  };

  const leverFor = (job: DemoJob): ((d: LeverDeps) => Promise<LeverResult>)[] | 'dynamic' => {
    switch (job.kind) {
      case 'applyPack':
        return [
          (d) =>
            applyPack(d, {
              routeId: routeIdFor(job.routeKey),
              level: job.level,
            }),
        ];
      case 'revertPack':
        return [(d) => revertPack(d, { routeId: routeIdFor(job.routeKey) })];
      case 'breakTrim':
        return [(d) => breakTrim(d, { pipelineId: job.pipelineId })];
      case 'setRate':
        return [(d) => setRate(d, { inputId: job.inputId, multiplier: job.multiplier })];
      case 'resetAll':
        return [(d) => resetAll(d)];
      case 'resetBaselines':
        return [(d) => resetBaselines(d)];
      case 'restoreTrim':
        return job.pipelineId ? [(d) => restoreTrim(d, { pipelineId: job.pipelineId! })] : 'dynamic';
      case 'revertAll':
      case 'weekly':
        return 'dynamic';
    }
  };

  const execute = async (job: DemoJob): Promise<JobOutcome> => {
    const results: LeverResult[] = [];
    if (job.kind === 'weekly') {
      setStatus({ stage: 'sending' });
      const weekly = await runWeeklyReceipt(
        {
          http: observedHttp,
          kv: deps.kv,
          webhook: deps.webhook,
          clock: deps.clock,
          codec: deps.codec,
          workspace: deps.workspace,
          linkBase: deps.linkBase,
          ...(deps.logger ? { logger: deps.logger } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          ...(deps.owner ? { owner: deps.owner } : {}),
        },
        { mode: 'manual' },
      );
      const ok = !weekly.error && weekly.skipped !== 'rate_limited';
      return {
        ok,
        job,
        results,
        weekly,
        ...(ok
          ? {}
          : {
              error: 'failed' as const,
              message: weekly.error ?? weekly.skipped,
            }),
      };
    }

    let calls = leverFor(job);
    if (calls === 'dynamic') {
      const demo = (await docs.getDemoState()) ?? emptyDemoState();
      if (job.kind === 'revertAll') {
        calls = Object.keys(demo.routes ?? {}).map((routeId) => (d: LeverDeps) => revertPack(d, { routeId }));
        if (calls.length === 0) return { ok: true, job, results, message: 'nothing_applied' };
      } else {
        const broken = Object.keys(demo.trim ?? {});
        const targets = broken.length > 0 ? broken : [TRIM_PIPELINE];
        calls = targets.map((pipelineId) => (d: LeverDeps) => restoreTrim(d, { pipelineId }));
      }
    }

    for (const call of calls) {
      const result = await withRetry(call);
      results.push(result);
      // Already in that state counts as done (a re-run scene step, a double tap, a change made by hand).
      if (!result.ok && result.error !== 'no_change') {
        return {
          ok: false,
          job,
          results,
          error: result.error,
          message: result.message,
        };
      }
    }
    const last = [...results].reverse().find((r) => r.ok && r.commit);
    const outcome: JobOutcome = { ok: true, job, results };
    if (last && last.ok) {
      if (last.commit) outcome.commit = last.commit;
      if (last.deployedAt) outcome.deployedAt = last.deployedAt;
    }
    if (results.length > 0 && results.every((r) => !r.ok && r.error === 'no_change')) outcome.message = 'no_change';
    return outcome;
  };

  const pushDemoState = async (): Promise<void> => {
    if (!options.onDemoState) return;
    try {
      options.onDemoState(await docs.getDemoState());
    } catch (e) {
      deps.logger?.warn('demo: could not read demo/state after a lever', e);
    }
  };

  const client: DemoClient = {
    run(job) {
      if (state.busy) {
        return Promise.resolve({
          ok: false,
          job,
          results: [],
          error: 'busy',
          message: 'Another lever is running',
        });
      }
      setStatus({ busy: true, job, startedAt: deps.clock.now(), stage: 'preparing' }, ['retry']);
      return enqueue(async () => {
        let outcome: JobOutcome;
        try {
          outcome = await execute(job);
        } catch (e) {
          if (e instanceof CancelledError) {
            outcome = {
              ok: false,
              job,
              results: [e.refusal],
              error: 'cancelled',
              message: e.refusal.message,
            };
          } else {
            deps.logger?.error('demo: job failed', e);
            outcome = {
              ok: false,
              job,
              results: [],
              error: 'failed',
              message: e instanceof Error ? e.message : String(e),
            };
          }
        }
        await pushDemoState();
        const last: ClientStatus['last'] = {
          job,
          ok: outcome.ok,
          at: deps.clock.now(),
        };
        if (outcome.error) last.error = outcome.error;
        if (outcome.message) last.message = outcome.message;
        setStatus({ busy: false, last }, ['job', 'stage', 'retry', 'startedAt']);
        // A poll already in flight when the lever finished may land an older demo/state; re-push after it.
        if (options.onSettled) {
          await Promise.resolve(options.onSettled(outcome)).catch(() => undefined);
          await pushDemoState();
        }
        return outcome;
      });
    },
    status: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancelRetry() {
      if (retryTimer !== undefined) timers.clearTimeout(retryTimer);
      retryTimer = undefined;
      const resolve = retryResolve;
      retryResolve = null;
      resolve?.(false);
    },
    readDemoState: () => docs.getDemoState(),
    updateDemoState(update) {
      return enqueue(async () => {
        const current = (await docs.getDemoState()) ?? emptyDemoState();
        const next = update(current);
        if (next === null) return current;
        await docs.putDemoState(next);
        options.onDemoState?.(next);
        return next;
      });
    },
    dispose() {
      disposed = true;
      client.cancelRetry();
      listeners.clear();
    },
  };
  return client;
}

class CancelledError extends Error {
  readonly refusal: LeverRefusal;
  constructor(refusal: LeverRefusal) {
    super('cancelled');
    this.name = 'CancelledError';
    this.refusal = refusal;
  }
}

/**
 * The route id a lever is given for a rig stream. The core resolves any spelling (the live rig names routes
 * after their Source, the first emulator rig prefixed them), so the Source's input id is enough.
 */
export function routeIdFor(routeKey: PackRouteKey): string {
  return rigSource(routeKey)?.inputId ?? routeKey;
}

/** The lever a job starts first, for copy lookups (`shortcuts.lever.*`, `demo.job.*`). */
export function leverNameFor(job: DemoJob): LeverName | 'weekly' | 'revertAll' {
  switch (job.kind) {
    case 'revertAll':
      return 'revertAll';
    case 'weekly':
      return 'weekly';
    default:
      return job.kind;
  }
}

// ─── Browser wiring ──────────────────────────────────────────────────────────
/**
 * The transports the console uses inside Cribl (or the mock): fetch over CRIBL_API_URL, which the platform
 * proxies with the member's auth; KV at `${CRIBL_API_URL}/kvstore/<key>`; webhooks through the App proxy.
 */
export function createBrowserDemoDeps(baseUrl: string): DemoDeps {
  const fetchFn = window.fetch as unknown as FetchLike;
  return {
    http: createFetchHttp({ fetch: fetchFn, baseUrl }),
    kv: createFetchKvStore({ fetch: fetchFn, baseUrl }),
    webhook: createFetchWebhookSender(fetchFn),
    clock: { now: () => Date.now() },
    codec: detectCodec(),
    logger: createConsoleLogger('[meter-reader demo]'),
    workspace: workspaceFromUrl(baseUrl),
    linkBase: linkBaseFrom(baseUrl, window.CRIBL_BASE_PATH),
    owner: createOwnerId('lever'),
  };
}

let authorPromise: Promise<string> | null = null;

/**
 * The person pulling the lever, as the incident card and the Slack message should name them: "First Last"
 * when the profile has both, else the username (on Cribl.Cloud that is often the email address). Memoized
 * (the platform memoizes getCriblUser too).
 */
export function criblUsername(): Promise<string> {
  authorPromise ??= (async () => {
    try {
      const user = (await window.getCriblUser?.()) as { username?: string; firstName?: string; lastName?: string } | undefined;
      const full = [user?.firstName, user?.lastName].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim();
      return full || user?.username || 'unknown';
    } catch {
      return 'unknown';
    }
  })();
  return authorPromise;
}
