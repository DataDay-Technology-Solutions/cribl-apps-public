// tests/e2e/helpers/theme.ts — switch the app's theme the way the Cribl shell does.
//
// The shell owns the theme and pushes it with a `CRIBL_APP_LAYOUT` postMessage (AGENTS.md "Theming").
// Outside an iframe `window.parent === window`, so a message the page posts to itself passes the
// bridge's `event.source === window.parent` check exactly like the shell's would. The media emulation
// keeps `prefers-color-scheme` (the first-paint hint) consistent with the posted theme.

import type { Page } from '@playwright/test';

export type Theme = 'light' | 'dark';

export async function setTheme(page: Page, theme: Theme, timeoutMs = 5_000): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((t) => window.postMessage({ type: 'CRIBL_APP_LAYOUT', theme: t }, '*'), theme);
  await page.waitForFunction((t) => document.body.classList.contains('dark') === (t === 'dark'), theme, { timeout: timeoutMs });
}

/** The body's computed text and background colors — what actually changes between themes. */
export function themeColors(page: Page): Promise<{ color: string; background: string }> {
  return page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const html = getComputedStyle(document.documentElement);
    const bg = body.backgroundColor === 'rgba(0, 0, 0, 0)' ? html.backgroundColor : body.backgroundColor;
    return { color: body.color, background: bg };
  });
}
