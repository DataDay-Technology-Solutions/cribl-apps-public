// src/theme/bridge.ts — follow the Cribl shell's theme (AGENTS.md "Theming").
//
// The shell owns the theme and pushes it as a `CRIBL_APP_LAYOUT` postMessage shortly after load and
// on every toggle. We apply it as a `.dark` class on <body> (Capra portals overlays into <body>, so an
// inner wrapper would leave drawers and toasts light) and hand it to React through `onTheme`.
// There is deliberately no theme switcher and nothing persisted.
//
// Testing hook: at top level (Playwright, plain `vite`), `window.parent === window`, so a page can theme
// itself with `window.postMessage({ type: 'CRIBL_APP_LAYOUT', theme: 'dark' }, '*')` — the source check
// below passes because the message's source IS the parent.

import { isEmbedded } from '../lib/env.ts';

export type HostTheme = 'light' | 'dark';

/** Class on <html> once the real theme is applied; index.html's first-paint guess keys off its absence. */
export const THEMED_CLASS = 'mr-themed';

function applyTheme(theme: HostTheme): void {
  document.body.classList.toggle('dark', theme === 'dark');
  document.documentElement.classList.add(THEMED_CLASS);
}

/** Applies the Cribl shell's theme to this document. Returns a teardown function. */
export function installThemeBridge(onTheme?: (theme: HostTheme) => void): () => void {
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) return; // any frame can post to ours
    const data = event.data as { type?: string; theme?: HostTheme } | null;
    if (data?.type !== 'CRIBL_APP_LAYOUT') return;
    if (data.theme !== 'light' && data.theme !== 'dark') return;
    applyTheme(data.theme);
    onTheme?.(data.theme);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/**
 * The theme to start with, before any message.
 *
 * Inside Cribl this is always 'light' — the <body> without `.dark` — because AGENTS.md forbids theming
 * components off `prefers-color-scheme`; the shell's message corrects it within moments. Outside any
 * frame (plain dev server, Playwright) no host will ever post, so the OS preference is the only signal
 * there is and we apply it once.
 */
export function initialTheme(): HostTheme {
  if (isEmbedded()) return 'light';
  const dark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme: HostTheme = dark ? 'dark' : 'light';
  applyTheme(theme);
  return theme;
}

/**
 * Resolves with the first theme the shell sends, or `null` after `timeoutMs`. `main.tsx` waits on this
 * (briefly) before the first render so a dark-mode user never sees a light flash of the whole app.
 */
export function waitForHostTheme(timeoutMs: number): Promise<HostTheme | null> {
  if (!isEmbedded()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      teardown();
      // No message in time: stop guessing in index.html and let Capra's light tokens paint.
      document.documentElement.classList.add(THEMED_CLASS);
      resolve(null);
    }, timeoutMs);
    const teardown = installThemeBridge((theme) => {
      clearTimeout(timer);
      teardown();
      resolve(theme);
    });
  });
}
