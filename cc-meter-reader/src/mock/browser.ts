// src/mock/browser.ts — starts the in-browser Cribl emulator (dev server, `vite preview`, Playwright).
//
// Wiring (src/main.tsx, before the first render, only when mock mode is allowed):
//
//   if (window.CRIBL_API_URL === undefined && mockModeAllowed()) {
//     const { start } = await import('./mock/browser.ts');   // dynamic: never in a release bundle
//     await start();
//   }
//
// `start()` is idempotent. It registers the MSW service worker (public/mockServiceWorker.js), then —
// only where the platform has not already set them — points `window.CRIBL_API_URL` at '/mock-api/v1'
// and installs a `window.getCriblUser()` that resolves to the mock member. Inside Cribl none of this
// runs: the platform's globals are present and the app never imports this module.
//
// State (KV, config, commits, the webhook sink) lives in localStorage under `mr-mock:*`, so it
// survives reloads and is shared by every tab — the emulated Leader's disk, not app data.

import { setupWorker } from 'msw/browser';
import { createHandlers } from './handlers.ts';
import { CriblEmulator } from './emulator.ts';
import { createBrowserStore } from './store.ts';
import { MOCK_API_BASE, MOCK_USER, type ControlAction } from './types.ts';

export interface StartOptions {
  /** URL of the MSW worker script (default '/mockServiceWorker.js', served from public/). */
  serviceWorkerUrl?: string;
  /** Print MSW's own console lines (default false). */
  verbose?: boolean;
}

export interface MockHandle {
  emulator: CriblEmulator;
  control(action: ControlAction): Record<string, unknown>;
  stop(): void;
}

interface MockWindow {
  CRIBL_API_URL?: string;
  getCriblUser?: () => Promise<typeof MOCK_USER>;
  __MR_MOCK__?: MockHandle;
}

let starting: Promise<MockHandle> | null = null;

export function start(opts: StartOptions = {}): Promise<MockHandle> {
  starting ??= boot(opts).catch((e: unknown) => {
    starting = null; // allow a retry after e.g. a failed worker registration
    throw e;
  });
  return starting;
}

async function boot(opts: StartOptions): Promise<MockHandle> {
  const emulator = new CriblEmulator({ store: createBrowserStore(), apiPrefixes: [MOCK_API_BASE] });
  const worker = setupWorker(...createHandlers(emulator));
  await worker.start({
    onUnhandledRequest: 'bypass',
    quiet: !opts.verbose,
    serviceWorker: { url: opts.serviceWorkerUrl ?? '/mockServiceWorker.js' },
  });
  const w = window as unknown as MockWindow;
  if (w.CRIBL_API_URL === undefined) w.CRIBL_API_URL = MOCK_API_BASE;
  if (w.getCriblUser === undefined) {
    const user = Promise.resolve({ ...MOCK_USER });
    w.getCriblUser = () => user; // memoized, as the platform's is
  }
  const handle: MockHandle = { emulator, control: (a) => emulator.control(a), stop: () => worker.stop() };
  w.__MR_MOCK__ = handle;
  return handle;
}

/** Aliases for src/main.tsx, which loads this module lazily and calls `startMockApi` or the default export. */
export const startMockApi = start;
export default start;
