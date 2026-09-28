// src/lib/routerKind.ts — whether the History API can back the App's router in this frame, and where a memory router
// starts (src/router.tsx). Its own module so router.tsx exports only components (React Fast Refresh; oxlint
// react/only-export-components).

export type RouterKind = 'browser' | 'memory';

/** Decides whether the History API can back the router here. Exported for tests. */
export function chooseRouter(base: string, win: Pick<Window, 'location' | 'history'> = window): RouterKind {
  try {
    const { protocol, pathname } = win.location;
    if (protocol !== 'http:' && protocol !== 'https:') return 'memory';
    if (base !== '/' && pathname !== base && !pathname.startsWith(`${base}/`)) return 'memory';
    if (typeof win.history?.pushState !== 'function') return 'memory';
    // A sandboxed document can expose the API but throw on use; probe with a same-URL replace.
    win.history.replaceState(win.history.state, '', win.location.href);
    return 'browser';
  } catch {
    return 'memory';
  }
}

/** The location a MemoryRouter should start at: the path under the base, plus the query string. */
export function memoryInitialEntry(base: string, location: Pick<Location, 'pathname' | 'search'>): string {
  let path = location.pathname;
  if (base !== '/' && (path === base || path.startsWith(`${base}/`))) path = path.slice(base.length) || '/';
  if (!path.startsWith('/')) path = `/${path}`;
  return `${path}${location.search}`;
}
