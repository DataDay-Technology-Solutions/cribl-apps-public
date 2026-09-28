// src/demo/install.ts — wires the demo runtime (lever client, scene runner, lever keys) to the app's
// services. DEMO BUILD ONLY: nothing outside a `import.meta.env.VITE_MR_BUILD === 'demo'` branch may import
// this file, so the release bundle never contains it (SPEC 13, 16).
//
// One runtime per page, created on first use and kept for the page's lifetime:
//   • the Demo Console view calls `ensureDemoRuntime(services)` (so /demo works on its own);
//   • the presenter laptop needs the lever keys without the console mounted — the app shell mounts it with
//     one inline-gated line in src/main.tsx (the flag is tested inline so Vite drops the branch):
//
//       if (import.meta.env.VITE_MR_BUILD === 'demo') void import('./demo/install.ts').then((m) => m.installDemoRuntime(services));

import { useMemo, useSyncExternalStore } from 'react';
import { apiBaseUrl } from '../lib/env.ts';
import { notify } from '../components/common/notify.tsx';
import { t } from '../copy/en.ts';
import { useServices } from '../state/react.tsx';
import type { AppServices } from '../state/services.ts';
import { createBrowserDemoDeps, createDemoClient, criblUsername, type ClientStatus, type DemoClient, type DemoDeps } from './client.ts';
import { createSceneRunner, type RunnerEvent, type RunnerState, type SceneRunner } from './sceneRunner.ts';
import { createDemoActions, sceneTitle, type DemoActions } from './actions.tsx';
import { installLeverKeys } from './keyboard.ts';
import { resolveEndpoints, wantsWeeklyReceipt } from '../../core/delivery.ts';

export interface DemoRuntime {
  services: AppServices;
  client: DemoClient;
  runner: SceneRunner;
  actions: DemoActions;
  dispose(): void;
}

let runtime: DemoRuntime | null = null;

function toastFor(event: RunnerEvent): void {
  const scene = sceneTitle(event.name);
  switch (event.kind) {
    case 'started':
      notify.info(t('demo.sceneStarted', { scene }));
      return;
    case 'finished':
      notify.success(t('demo.sceneFinished', { scene }));
      return;
    case 'aborted':
      if (event.ok) notify.success(t('demo.sceneAborted', { scene }));
      else notify.warning(t('demo.sceneAbortFailed', { scene }));
      return;
    case 'dismissed':
      notify.info(t('demo.sceneDismissed', { scene }));
      return;
    case 'timeout':
      notify.info(t('demo.sceneTimeout'));
      return;
    case 'failed':
      notify.error(
        t('demo.sceneFailed', {
          scene,
          reason: event.outcome.message ?? event.outcome.error ?? '',
        }),
      );
      return;
  }
}

/** Builds the runtime over the app's services. `deps` overrides the browser transports (tests). */
export function createDemoRuntime(services: AppServices, deps?: DemoDeps): DemoRuntime {
  const store = services.store;
  let runner: SceneRunner | null = null;
  const client = createDemoClient({
    deps: deps ?? createBrowserDemoDeps(apiBaseUrl()),
    author: criblUsername,
    onDemoState: (demo) => {
      // Never overwrite a tour's or a replay's screen with live documents.
      if (store.getState().source === 'live') store.setState({ demoState: demo });
      runner?.sync(demo);
    },
    onSettled: () => services.actions.refresh().catch(() => undefined),
  });
  runner = createSceneRunner({
    client,
    getSnapshot: () => {
      const s = store.getState();
      return s.source === 'live' ? s.snapshot : null;
    },
    getDemoState: () => store.getState().demoState,
    subscribe: store.subscribe,
    onEvent: toastFor,
  });
  const actions = createDemoActions({
    client,
    runner,
    demoProfile: () => store.getState().settings.demo.profile,
    demoState: () => store.getState().demoState,
    // Exactly what core/weekly.ts sends to: the delivery router's endpoints (the implicit Cribl bell included)
    // that want the receipt, so the confirmation names every place it goes.
    weeklyEndpoints: () =>
      resolveEndpoints(store.getState().settings.notifications)
        .filter(wantsWeeklyReceipt)
        .map((e) => ({ id: e.id, name: e.name })),
  });
  const keysOff = installLeverKeys({
    actions,
    isEnabled: () => {
      const s = store.getState();
      return import.meta.env.VITE_MR_BUILD === 'demo' && s.hasHydrated && s.source === 'live' && s.settings.demo.enabled;
    },
    subscribe: store.subscribe,
    isBusy: () => client.status().busy,
  });
  const r = runner;
  return {
    services,
    client,
    runner: r,
    actions,
    dispose() {
      keysOff();
      r.dispose();
      client.dispose();
    },
  };
}

/** The page's demo runtime, created on first use. */
export function ensureDemoRuntime(services: AppServices): DemoRuntime {
  if (runtime && runtime.services === services) return runtime;
  runtime?.dispose();
  runtime = createDemoRuntime(services);
  return runtime;
}

/** For the app shell (see the header): installs the runtime so the lever keys work on every view. */
export function installDemoRuntime(services: AppServices): () => void {
  ensureDemoRuntime(services);
  return () => {
    runtime?.dispose();
    runtime = null;
  };
}

/** The runtime for the Demo Console (created on first render). */
export function useDemoRuntime(): DemoRuntime {
  const services = useServices();
  return useMemo(() => ensureDemoRuntime(services), [services]);
}

export function useClientStatus(client: DemoClient): ClientStatus {
  return useSyncExternalStore(client.subscribe, client.status, client.status);
}

export function useRunnerState(runner: SceneRunner): RunnerState {
  return useSyncExternalStore(runner.subscribe, runner.state, runner.state);
}
