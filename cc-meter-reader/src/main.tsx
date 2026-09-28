// src/main.tsx — boot sequence.
//
//   1. Capra CSS, then the app's global styles (tokens → our aliases → utilities).
//   2. Theme: install the CRIBL_APP_LAYOUT bridge (AGENTS.md "Theming") feeding the store.
//   3. Mock mode (dev / Playwright only): with no CRIBL_API_URL, point it at the in-browser Cribl
//      emulator and start MSW BEFORE anything reads KV. Compiled out of release builds.
//   4. Runtime → services → hydrate (meta, settings, snapshot, prices in one batch) → live polling and,
//      in the 'ui' runtime, the 30-second meter loop.
//   4b. Demo build only: the demo runtime (lever client, scene runner, lever keys) so the presenter's keys
//      work on every view, not only on /demo. Compiled out of the release bundle.
//   5. Render — after the host theme arrives or a short timeout, so dark-mode users never see a light
//      flash of the whole app.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@capra/theme/base.css';
import '@capra/core/styles.css';
import '@capra/icons/styles.css';
import './styles/index.css';
import App from './App.tsx';
import { BootError } from './components/Shell/BootError.tsx';
import { MOCK_API_BASE } from './lib/env.ts';
import { createAppStore } from './state/store.ts';
import { createBrowserRuntime } from './state/runtime.ts';
import { createAppServices } from './state/services.ts';
import { initialTheme, installThemeBridge, waitForHostTheme } from './theme/bridge.ts';

/** How long the first render waits for the shell's theme message before painting light. */
const THEME_WAIT_MS = 400;

/**
 * Starts the MSW Cribl emulator when running outside Cribl in a dev or explicitly mock-enabled build.
 * The condition is written inline so a release build (no DEV, VITE_MR_MOCK unset or '0') drops the lazy
 * import — and every mock handler — at build time, and never assigns CRIBL_API_URL (a platform global).
 */
async function startMockApiIfNeeded(): Promise<void> {
  if (window.CRIBL_API_URL) return;
  if (import.meta.env.DEV || import.meta.env.VITE_MR_MOCK === '1') {
    window.CRIBL_API_URL = MOCK_API_BASE;
    const { startMockApi } = await import('./mock/browser.ts');
    await startMockApi();
  }
}

async function boot(): Promise<void> {
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('index.html is missing #root');
  const root = createRoot(rootElement);

  const theme = initialTheme();
  const themeReady = waitForHostTheme(THEME_WAIT_MS);

  try {
    await startMockApiIfNeeded();
    const runtime = createBrowserRuntime();
    const store = createAppStore(runtime.defaultSettings, { theme });
    const services = createAppServices({
      store,
      docs: runtime.docs,
      engine: runtime.engine,
      mergeSettings: runtime.mergeSettings,
    });
    installThemeBridge((next) => services.actions.setTheme(next));

    // DOM contract for tests and tooling: <html data-mr-hydrated="true"> once the first KV hydration
    // (meta, settings, snapshot) has landed. Pure attribute; nothing in the app reads it back.
    const markHydrated = () => {
      if (store.getState().hasHydrated) document.documentElement.dataset.mrHydrated = 'true';
    };
    markHydrated();
    store.subscribe(markHydrated);

    // Hydration starts now and overlaps the theme wait; the views render skeletons until it lands.
    void services.start().catch((error: unknown) => console.error('[meter-reader] start failed', error));

    // Demo build only (4b above). The flag is tested inline so Vite drops the branch and its chunk from
    // the release bundle. One runtime per page: the Demo Console reuses this one (ensureDemoRuntime).
    if (import.meta.env.VITE_MR_BUILD === 'demo') {
      void import('./demo/install.ts')
        .then((m) => m.installDemoRuntime(services))
        .catch((error: unknown) => console.error('[meter-reader] demo runtime failed', error));
    }

    const hostTheme = await themeReady;
    if (hostTheme) services.actions.setTheme(hostTheme);

    root.render(
      <StrictMode>
        <App services={services} />
      </StrictMode>,
    );
  } catch (error) {
    console.error('[meter-reader] boot failed', error);
    await themeReady;
    root.render(
      <StrictMode>
        <BootError error={error} />
      </StrictMode>,
    );
  }
}

void boot();
