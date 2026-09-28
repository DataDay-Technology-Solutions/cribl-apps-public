// src/demo/sceneRunner.ts — runs the Demo Console's scenes (SPEC 11 `demoScene`). DEMO BUILD ONLY.
//
// The state machine is scenes.ts; this module executes it. The scene lives in `demo/state.scene` (so a
// reloaded phone picks up where it was) and is advanced from the UI's own ticks — every new snapshot the
// live poller lands, plus a coarse timer for holds and timeouts — never by a backend. Levers go through
// the client's single queue, so a scene step and a manual lever can never overlap.
//
// Ownership (two devices on stage): only the tab that STARTED a scene advances it, or the tab that ADOPTS
// it — and adopting is always a person's choice (REVIEW-3a #8): the Demo Console shows "A scene was left
// running … Resume / Abandon and restore" and calls `adopt()` only on Resume. Nothing resumes on mount. A
// scene that has not moved for SCENE_ABANDON_MS is abandoned: it can be restored (`abort`) or dismissed
// (`dismiss`, which restores nothing), never resumed. The presenter laptop never advances a scene it did not
// start.
//
// Abort (one tap) restores everything the scene changed: reverts the packs it applied, then Reset
// everything (every broken trim restored, every rate back to 1×, demo incidents closed, the scene cleared).

import type { DemoState, Snapshot } from '../../core/types.ts';
import { DEFAULT_MEASURED_LAG_SEC } from '../../core/demo/levers.ts';
import { PACK_ROUTE_KEYS } from '../../core/demo/rig-ids.ts';
import type { DemoClient, DemoJob, JobOutcome } from './client.ts';
import {
  SCENES,
  advanceScene,
  expectedAlertAt,
  isSceneAbandoned,
  newScene,
  nextStep,
  parseSceneName,
  recordChange,
  type LeverCall,
  type PackRouteKey,
  type PersistedScene,
  type SceneName,
} from './scenes.ts';

export const RUNNER_TICK_MS = 5_000;
/** How long abort waits for a busy client between attempts. */
const BUSY_RETRY_MS = 1_000;
const BUSY_ATTEMPTS = 120;

export type RunnerEvent =
  | { kind: 'started'; name: SceneName }
  | { kind: 'finished'; name: SceneName }
  | { kind: 'aborted'; name: SceneName; ok: boolean }
  | { kind: 'dismissed'; name: SceneName }
  | { kind: 'timeout'; name: SceneName }
  | { kind: 'failed'; name: SceneName; outcome: JobOutcome };

export interface RunnerState {
  /** The scene this tab is running (owned), else the persisted one it can see. */
  scene: PersistedScene | null;
  owned: boolean;
  /** A step's lever or receipt is running. */
  acting: boolean;
  aborting: boolean;
  /** The last step failed; the scene is paused until Abort. */
  failed?: JobOutcome;
}

export interface SceneRunnerDeps {
  client: DemoClient;
  getSnapshot(): Snapshot | null;
  /** The store's demo/state (polled); read for `measuredLagSec` and for adoption. */
  getDemoState(): DemoState | null;
  /** Store subscription: the runner re-evaluates whenever state changes (snapshots land). */
  subscribe(listener: () => void): () => void;
  now?: () => number;
  timers?: {
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(h: unknown): void;
    setTimeout(fn: () => void, ms: number): unknown;
  };
  tickMs?: number;
  onEvent?: (event: RunnerEvent) => void;
}

export interface SceneRunner {
  state(): RunnerState;
  subscribe(listener: () => void): () => void;
  start(name: SceneName, routeKey?: PackRouteKey): Promise<{ ok: boolean; reason?: 'busy' | 'running' | 'unsupported' }>;
  abort(): Promise<void>;
  /**
   * Take over a persisted scene no tab in this session owns — only when a person chose Resume (never on
   * mount). Refuses an abandoned scene.
   */
  adopt(): void;
  /** Forget a persisted scene this tab does not own, restoring nothing (the abandoned scene's Dismiss). */
  dismiss(): Promise<void>;
  /** Whether this tab already finished or aborted the scene that started at `startedAt`. */
  isEnded(startedAt: string): boolean;
  /** demo/state as just written by a job or a scene write (keeps an owned scene honest after Reset). */
  sync(demo: DemoState | null): void;
  /** Evaluate now (the store and the timer call this; tests call it directly). */
  evaluate(): Promise<void>;
  dispose(): void;
}

const browserTimers = {
  setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
  clearInterval: (h: unknown) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
};

/** The lever client job for a scene step. */
export function jobForCall(call: LeverCall): DemoJob {
  switch (call.kind) {
    case 'applyPack':
      return { kind: 'applyPack', routeKey: call.routeKey, level: call.level };
    case 'revertPack':
      return { kind: 'revertPack', routeKey: call.routeKey };
    case 'breakTrim':
      return { kind: 'breakTrim', pipelineId: call.pipelineId };
    case 'restoreTrim':
      return { kind: 'restoreTrim', pipelineId: call.pipelineId };
    case 'setRate':
      return {
        kind: 'setRate',
        inputId: call.inputId,
        multiplier: call.multiplier,
      };
  }
}

export function createSceneRunner(deps: SceneRunnerDeps): SceneRunner {
  const now = deps.now ?? (() => Date.now());
  const timers = deps.timers ?? browserTimers;
  const listeners = new Set<() => void>();
  let st: RunnerState = {
    scene: null,
    owned: false,
    acting: false,
    aborting: false,
  };
  let evaluating: Promise<void> | null = null;
  let disposed = false;
  /** startedAt of scenes this tab finished or aborted: a stale poll may briefly show one again. */
  const ended = new Set<string>();

  const emit = () => {
    for (const l of [...listeners]) l();
  };
  const set = (patch: Partial<RunnerState>, remove: (keyof RunnerState)[] = []) => {
    const next = { ...st, ...patch };
    for (const k of remove) delete next[k];
    st = next;
    emit();
  };
  const sceneName = (scene: PersistedScene | null): SceneName => parseSceneName(scene?.name ?? '')?.name ?? 'savings';
  const lag = (): number => deps.getDemoState()?.measuredLagSec ?? DEFAULT_MEASURED_LAG_SEC;
  const sleep = (ms: number) => new Promise<void>((r) => void timers.setTimeout(r, ms));

  /** Persists the scene (or clears it with null) on the client queue. */
  const persist = async (scene: PersistedScene | null): Promise<void> => {
    await deps.client.updateDemoState((cur) => {
      const next: DemoState = { ...cur };
      if (scene) next.scene = scene;
      else delete next.scene;
      return next;
    });
  };

  /** Runs a job, waiting while a manual lever holds the client. */
  const runWhenFree = async (job: DemoJob): Promise<JobOutcome> => {
    for (let i = 0; ; i++) {
      const outcome = await deps.client.run(job);
      if (outcome.error !== 'busy' || i >= BUSY_ATTEMPTS || disposed) return outcome;
      await sleep(BUSY_RETRY_MS);
    }
  };

  const finish = async (scene: PersistedScene) => {
    ended.add(scene.startedAt);
    await persist(null);
    set({ scene: null, owned: false, acting: false }, ['failed']);
    deps.onEvent?.({ kind: 'finished', name: sceneName(scene) });
  };

  const step = async (): Promise<void> => {
    // Each pass performs at most one action; it loops while steps complete immediately.
    for (let guard = 0; guard < 32; guard++) {
      const scene = st.scene;
      if (disposed || !st.owned || !scene || st.aborting || st.failed) return;
      const action = advanceScene(scene, deps.getSnapshot(), now());
      switch (action.kind) {
        case 'idle':
          return;
        case 'finish':
          await finish(scene);
          return;
        case 'advance': {
          if (action.reason === 'timeout') deps.onEvent?.({ kind: 'timeout', name: sceneName(scene) });
          const { scene: next, done } = nextStep(scene, now());
          set({ scene: next });
          await persist(next);
          if (done) {
            await finish(next);
            return;
          }
          continue;
        }
        case 'receipt': {
          set({ acting: true });
          await runWhenFree({ kind: 'weekly' });
          if (st.aborting || !st.owned) return set({ acting: false });
          const { scene: next, done } = nextStep(scene, now());
          set({ scene: next, acting: false });
          await persist(next);
          if (done) {
            await finish(next);
            return;
          }
          continue;
        }
        case 'lever': {
          set({ acting: true });
          const outcome = await runWhenFree(jobForCall(action.call));
          // Record what changed first, even when an abort arrived meanwhile, so the abort undoes it.
          if (outcome.ok && st.scene) set({ scene: recordChange(st.scene, action.call) });
          if (st.aborting || !st.owned || !st.scene) return set({ acting: false });
          if (!outcome.ok) {
            // Paused: the member sees why, and Abort cleans up whatever the scene already changed.
            set({ acting: false, failed: outcome });
            deps.onEvent?.({ kind: 'failed', name: sceneName(scene), outcome });
            return;
          }
          let recorded = st.scene;
          const alertCause = action.call.kind === 'breakTrim' || (action.call.kind === 'setRate' && action.call.multiplier > 1);
          if (alertCause) {
            const liveAt = outcome.deployedAt ? Date.parse(outcome.deployedAt) : now();
            recorded = {
              ...recorded,
              expectedAlertAt: expectedAlertAt(Number.isFinite(liveAt) ? liveAt : now(), lag()),
            };
          }
          const { scene: next, done } = nextStep(recorded, now());
          set({ scene: next, acting: false });
          await persist(next);
          if (done) {
            await finish(next);
            return;
          }
          continue;
        }
      }
    }
  };

  const runner: SceneRunner = {
    state: () => st,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async start(name, routeKey) {
      const def = SCENES[name];
      if (!def.supported) return { ok: false, reason: 'unsupported' };
      if (st.scene || deps.getDemoState()?.scene) return { ok: false, reason: 'running' };
      if (deps.client.status().busy) return { ok: false, reason: 'busy' };
      const scene = newScene(name, now(), routeKey);
      set({ scene, owned: true, acting: false, aborting: false }, ['failed']);
      await persist(scene);
      deps.onEvent?.({ kind: 'started', name });
      void runner.evaluate();
      return { ok: true };
    },

    async abort() {
      const scene = st.scene ?? deps.getDemoState()?.scene ?? null;
      if (!scene || st.aborting) return;
      set({ scene, owned: true, aborting: true });
      deps.client.cancelRetry();
      // Let a step that is mid-lever land first; its change is then recorded and undone below.
      if (evaluating) await evaluating.catch(() => undefined);
      const changed = (st.scene ?? scene).changed;
      let ok = true;
      for (const routeKey of [...(changed.routes ?? [])].reverse()) {
        if (!(PACK_ROUTE_KEYS as readonly string[]).includes(routeKey)) continue;
        const r = await runWhenFree({
          kind: 'revertPack',
          routeKey: routeKey as PackRouteKey,
        });
        ok &&= r.ok;
      }
      if (changed.trims.length > 0 || changed.rates.length > 0 || changed.budgets.length > 0) {
        const r = await runWhenFree({ kind: 'resetAll' });
        ok &&= r.ok;
      }
      ended.add(scene.startedAt);
      await persist(null).catch(() => {
        ok = false;
      });
      set({ scene: null, owned: false, acting: false, aborting: false }, ['failed']);
      deps.onEvent?.({ kind: 'aborted', name: sceneName(scene), ok });
    },

    adopt() {
      if (st.owned || st.aborting) return;
      const persisted = deps.getDemoState()?.scene;
      if (!persisted || !parseSceneName(persisted.name) || ended.has(persisted.startedAt)) return;
      if (isSceneAbandoned(persisted, now())) return;
      set({ scene: persisted, owned: true }, ['failed']);
      void runner.evaluate();
    },

    async dismiss() {
      if (st.owned || st.aborting) return;
      const persisted = deps.getDemoState()?.scene;
      if (!persisted) return;
      ended.add(persisted.startedAt);
      emit();
      // Only the scene that was asked about: another device may have started a new one since.
      await deps.client.updateDemoState((cur) => {
        if (cur.scene?.startedAt !== persisted.startedAt) return null;
        const next: DemoState = { ...cur };
        delete next.scene;
        return next;
      });
      deps.onEvent?.({ kind: 'dismissed', name: sceneName(persisted) });
    },

    isEnded: (startedAt) => ended.has(startedAt),

    sync(demo) {
      // Reset everything (from this tab or another) clears the scene; stop driving a scene that is gone.
      if (st.owned && !st.acting && !st.aborting && st.scene && demo && !demo.scene) {
        set({ scene: null, owned: false }, ['failed']);
      }
    },

    evaluate() {
      if (evaluating) return evaluating;
      evaluating = step()
        .catch((e: unknown) => {
          console.warn('[meter-reader demo] scene step failed', e);
          set({ acting: false });
        })
        .finally(() => {
          evaluating = null;
        });
      return evaluating;
    },

    dispose() {
      disposed = true;
      timers.clearInterval(interval);
      unsubscribe();
      listeners.clear();
    },
  };

  // Snapshots landing (and demo/state polls) re-evaluate; the timer covers holds and timeouts.
  let lastSnapshot = deps.getSnapshot();
  const unsubscribe = deps.subscribe(() => {
    const snap = deps.getSnapshot();
    if (snap !== lastSnapshot) {
      lastSnapshot = snap;
      if (st.owned) void runner.evaluate();
    }
  });
  const interval = timers.setInterval(() => {
    if (st.owned) void runner.evaluate();
  }, deps.tickMs ?? RUNNER_TICK_MS);

  return runner;
}
