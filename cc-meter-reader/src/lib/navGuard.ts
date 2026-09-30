// src/lib/navGuard.ts — one in-app navigation guard (founder-build r1 ui-5, FINDINGS_R1 M1).
//
// The App runs on a BrowserRouter / MemoryRouter (src/router.tsx), which has no blocker API, so leaving Settings with an
// unsaved draft used to throw the draft away without a word (the browser's beforeunload prompt covers only a page
// unload). The navigations a member makes go through these doors: Capra's links (the top tabs, through the RouterProvider
// bridge in router.tsx), the Go to anything palette, the P and "/" shortcuts (useShellEffects.ts) and the browser's Back
// and Forward (installPopstateGuard, founder-build r2 ui-10, FINDINGS_R2 #12). All of them ask here first. A view that holds unsaved work (Settings)
// registers a guard while it is dirty; the guard decides whether this navigation leaves that work behind and, if so,
// shows its own confirmation and calls `proceed` only when the member chooses to leave.

/** Returns true when it took over the navigation (it will call `proceed` itself, or never). */
export type NavGuard = (to: string, proceed: () => void) => boolean;

let current: NavGuard | null = null;

/** Registers the guard; the returned function removes it (only if it is still the registered one). */
export function setNavGuard(guard: NavGuard): () => void {
  current = guard;
  return () => {
    if (current === guard) current = null;
  };
}

/** Runs `proceed` unless the registered guard takes the navigation to `to` over. */
export function guardNavigation(to: string, proceed: () => void): void {
  const guard = current;
  if (guard && guard(to, proceed)) return;
  proceed();
}

/** The pathname a navigation target names ('/settings?x=1' → '/settings'; an object `{ pathname }` too). */
export function targetPath(to: unknown): string {
  if (typeof to === 'string') return to.split(/[?#]/)[0] ?? '';
  if (to && typeof to === 'object' && typeof (to as { pathname?: unknown }).pathname === 'string') return (to as { pathname: string }).pathname;
  return '';
}

// ─── Browser Back / Forward (founder-build r2 ui-10, FINDINGS_R2 #12; directions r3 ui-2, FINDINGS_R3 #11) ──────────────

/** The key the guard stamps into every history entry's state: the entry's index in this document's session history. */
export const HISTORY_INDEX_KEY = '__mrIdx';

/** The stamped index of a history state, when it carries one. */
export function historyIndexOf(state: unknown): number | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const value = (state as Record<string, unknown>)[HISTORY_INDEX_KEY];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `state` with the index stamped in (an object state gains one field; a non-object, non-null state is left alone). */
function withHistoryIndex(state: unknown, index: number): unknown {
  if (state === null || state === undefined) return { [HISTORY_INDEX_KEY]: index };
  if (typeof state === 'object' && !Array.isArray(state)) return { ...(state as Record<string, unknown>), [HISTORY_INDEX_KEY]: index };
  return state;
}

/** How long a restoring or replaying move may take to land before the guard stops waiting for it. */
const MOVE_TIMEOUT_MS = 1_500;
/** After Leave has landed, how long every move passes while the page is on its way out; then the guard re-arms. */
const RELEASE_MS = 1_500;

/**
 * Guards the browser's history moves: while a guard is registered, a popstate that would leave the guarded work is held
 * before the router sees it (installed before the router mounts, so this listener runs first and stops the event), the
 * move is undone, and the guard's dialog decides; Leave redoes it, and that move passes to the router. `pathOf` gives
 * the router-relative path of the document's URL. Only for a History-backed router, once per page load
 * (src/router.tsx). Returns the teardown.
 *
 * Directions (r3 ui-2): every entry carries its index in `history.state` (`__mrIdx`, stamped by wrapping pushState and
 * replaceState; the router's own state fields are kept). A popstate's delta is its entry's index minus the current one:
 * Back is −1, Forward +1, `history.go(-2)` −2; Stay restores with `go(-delta)` and Leave replays `go(delta)`. A popstate
 * whose entry is already the current one is a navigation the platform forwarded (AGENTS.md "Navigation": pushState or
 * replaceState, then popstate): a push is undone by stepping back onto the entry it covered and redone by stepping
 * forward again; a replace is undone and redone by replacing. A restoring or replaying move is recognised by the index
 * it lands on (or cleared after a timeout), so a later Back is never swallowed; after Leave has landed, the guard
 * re-arms, so a draft still on screen is guarded again.
 */
let popstateGuardInstalled = false;

export function installPopstateGuard(pathOf: () => string): () => void {
  // Once per page: a second listener (React's StrictMode runs a state initializer twice) would take the replayed move.
  if (typeof window === 'undefined' || popstateGuardInstalled) return () => undefined;
  popstateGuardInstalled = true;
  const history = window.history;
  const nativePush = history.pushState;
  const nativeReplace = history.replaceState;

  /** The index of the entry the App is on (the router's view of it). */
  let index = historyIndexOf(history.state) ?? 0;
  if (historyIndexOf(history.state) === undefined) nativeReplace.call(history, withHistoryIndex(history.state, index), '');
  /** The last write to the current entry, and what the entry held before it (for a forwarded replace). */
  let lastWrite: { kind: 'push' | 'replace'; before: { state: unknown; url: string } } | null = null;

  history.pushState = function pushState(state: unknown, unused: string, url?: string | URL | null) {
    const before = { state: history.state as unknown, url: window.location.href };
    index += 1;
    nativePush.call(history, withHistoryIndex(state, index), unused, url);
    lastWrite = { kind: 'push', before };
  };
  history.replaceState = function replaceState(state: unknown, unused: string, url?: string | URL | null) {
    const before = { state: history.state as unknown, url: window.location.href };
    nativeReplace.call(history, withHistoryIndex(state, index), unused, url);
    lastWrite = { kind: 'replace', before };
  };

  /** A move of ours in flight: the entry index it lands on (undefined: the next popstate, whatever it is). */
  type Pending = { at: number | undefined; timer: ReturnType<typeof setTimeout> };
  let restoring: Pending | null = null;
  let replaying: Pending | null = null;
  /** The guard the member chose to leave: every move passes while it is still registered (the page is on its way out). */
  let released: NavGuard | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;

  const pending = (at: number | undefined, onTimeout: () => void): Pending => ({ at, timer: setTimeout(onTimeout, MOVE_TIMEOUT_MS) });
  const settle = (p: Pending | null): null => {
    if (p) clearTimeout(p.timer);
    return null;
  };
  const lands = (p: Pending | null, at: number | undefined): boolean => p !== null && (p.at === undefined || p.at === at);
  const release = (guard: NavGuard | null, ms: number): void => {
    clearTimeout(releaseTimer);
    released = guard;
    if (guard) releaseTimer = setTimeout(() => (released = null), ms);
  };

  const onPop = (event: PopStateEvent) => {
    const at = historyIndexOf(history.state);
    if (lands(restoring, at)) {
      // Our own undo, back onto the guarded entry: the router never hears of it.
      restoring = settle(restoring);
      if (at !== undefined) index = at;
      event.stopImmediatePropagation();
      return;
    }
    if (lands(replaying, at)) {
      // The member chose Leave: the router takes this one, and any echo of it for a moment; then the guard re-arms.
      replaying = settle(replaying);
      if (at !== undefined) index = at;
      if (released) release(released, RELEASE_MS);
      return;
    }
    if (released !== null && current === released) {
      if (at !== undefined) index = at;
      return;
    }

    // What kind of move this is, and the entries it goes from and to.
    let from = index;
    let to: number;
    let kind: 'traverse' | 'push' | 'replace';
    if (at === undefined) {
      // An entry with no index was written past the wrapper: it is new, one past the current one. Stamp it.
      kind = 'push';
      to = index + 1;
      nativeReplace.call(history, withHistoryIndex(history.state, to), '');
    } else if (at !== index) {
      kind = 'traverse';
      to = at;
    } else if (lastWrite?.kind === 'replace') {
      kind = 'replace';
      to = at;
    } else {
      // A forwarded pushState + popstate: the wrapper already counted the push.
      kind = 'push';
      to = at;
      from = at - 1;
    }

    // The entry as the move left it (a forwarded replace is redone from it on Leave).
    const afterReplace = { state: history.state as unknown, url: window.location.href };
    const guard = current;
    const took =
      guard !== null &&
      guard(pathOf(), () => {
        release(guard, MOVE_TIMEOUT_MS + RELEASE_MS);
        if (kind === 'replace') {
          nativeReplace.call(history, afterReplace.state, '', afterReplace.url);
          index = to;
          replaying = pending(to, () => (replaying = null));
          window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
          return;
        }
        replaying = pending(to, () => (replaying = null));
        history.go(to - from);
      });
    if (!took) {
      index = to;
      return;
    }
    event.stopImmediatePropagation();
    // Undo the move while the dialog asks.
    if (kind === 'replace' && lastWrite) {
      nativeReplace.call(history, lastWrite.before.state, '', lastWrite.before.url);
      index = from;
      return;
    }
    restoring = settle(restoring);
    restoring = pending(from, () => (restoring = null));
    history.go(from - to);
  };
  window.addEventListener('popstate', onPop);
  return () => {
    window.removeEventListener('popstate', onPop);
    history.pushState = nativePush;
    history.replaceState = nativeReplace;
    settle(restoring);
    settle(replaying);
    clearTimeout(releaseTimer);
    popstateGuardInstalled = false;
  };
}
