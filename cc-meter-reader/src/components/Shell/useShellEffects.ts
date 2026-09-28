// src/components/Shell/useShellEffects.ts — the shell's side effects: the global keyboard map, the stage
// (presenter mode) with the way back to the tab it was opened from, the presenter flag mirrored into the
// store, and "5xx → toast once" for live polling (never on the stage).
//
// The keyboard map listens on `document` in the CAPTURE phase (epic audit P0-05): Capra's links and buttons
// (react-aria) stop a keydown's propagation, so a bubble listener went deaf the moment a mouse click left a
// nav tab focused. Capturing sees the key first, so the guards in src/lib/shortcuts.ts keep keys that belong
// to a text field, an open select, a menu or a dialog out of the map. It is `document`, not `window`: the
// incident takeover's any-key dismissal listens on window in the capture phase and must run first (D35:
// the key that clears the card is consumed).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { t } from '../../copy/en.ts';
import { SEARCH_FIELD_SELECTOR, focusSearchField, isTypingTarget, isWidgetKeyTarget, prefersReducedMotion } from '../../lib/dom.ts';
import { basePath } from '../../lib/env.ts';
import { hrefWithStickyParams, type AppParams, type ParamPatch } from '../../lib/params.ts';
import { dispatchShortcut, setSingleKeyShortcuts, showShortcutChip, useShortcut } from '../../lib/shortcuts.ts';
import { useActions, useAppState, useServices, useStoreApi } from '../../state/react.tsx';
import { notify } from '../common/notify.tsx';
import { takeoverFeed } from '../IncidentTakeover/tracker.ts';

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS']);

/**
 * Keys that never leave Story mode (SPEC 13 "any key exits", WCAG 2.1.1): Tab and the arrows move focus to
 * the story's own controls (its Close button), paging keys scroll.
 */
const STORY_KEEPS = new Set(['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/** Enter / Space on a focused control is that control's (the Story's Close button, its band's button). */
function isActivation(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' && event.key !== ' ') return false;
  return event.target instanceof Element && event.target.closest('button, a[href], [role="button"], [role="link"], summary') !== null;
}

// ─── The stage and the way back ──────────────────────────────────────────────

export interface StageOrigin {
  pathname: string;
  /** '' or '?…', without `present`. */
  search: string;
}

/**
 * Where the stage was opened from, so the second P (or Escape) returns there with its params (P0-06). One
 * stage per page, so module state is enough; it is not persisted anywhere.
 */
let stageOrigin: StageOrigin | null = null;
/**
 * The stage was pushed onto the history over the tab P was pressed on (OQ-10): Back then returns to that tab, and
 * the second P goes back one entry rather than adding another. A deep-linked stage replaces its entry instead.
 */
let stagePushed = false;

export function rememberStageOrigin(origin: StageOrigin | null, pushed = false): void {
  stageOrigin = origin && origin.pathname !== '/' ? origin : null;
  stagePushed = stageOrigin !== null && pushed;
}

/** The stage's URL: '/' with the sticky params (?group, ?period, ?range) of the tab it opens from, and present=1. */
export function stageHref(search: string): string {
  const href = hrefWithStickyParams('/', new URLSearchParams(search));
  return `${href}${href.includes('?') ? '&' : '?'}present=1`;
}

/** The current URL without `present`: what the way back from a deep-linked stage returns to. */
export function originOf(pathname: string, search: string): StageOrigin {
  const params = new URLSearchParams(search);
  params.delete('present');
  const query = params.toString();
  return { pathname, search: query ? `?${query}` : '' };
}

// ─── The lights going down (P2-W22) ──────────────────────────────────────────

/** How long a view transition waits for the new view to be in the DOM before it animates anyway. */
export const VIEW_TRANSITION_WAIT_MS = 500;

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => Promise<void> | void) => {
    finished: Promise<void>;
    ready?: Promise<void>;
    updateCallbackDone?: Promise<void>;
  };
};

function nameHero(el: Element | null, name: string): HTMLElement | null {
  if (!(el instanceof HTMLElement)) return null;
  el.style.setProperty('view-transition-name', name);
  return el;
}

/**
 * Entering the stage or Story: a 400 ms crossfade of the chrome, and the Receipt's hero figure (data-callout
 * saved) flies to the stage's (the FLIP is the browser's, document.startViewTransition). Reduced motion, or a
 * browser without view transitions: the switch is a cut. `ready` says when the new view is in the DOM.
 */
export function withViewTransition(update: () => void, ready: () => boolean, heroTarget?: () => Element | null): void {
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    update();
    return;
  }
  const named: HTMLElement[] = [];
  const from = heroTarget ? nameHero(document.querySelector('main [data-callout="saved"]'), 'mr-hero') : null;
  if (from) named.push(from);
  document.documentElement.dataset.mrTransition = 'stage';
  const transition = doc.startViewTransition.call(
    doc,
    () =>
      new Promise<void>((resolve) => {
        update();
        const until = Date.now() + VIEW_TRANSITION_WAIT_MS;
        const wait = () => {
          if (ready() || Date.now() > until) {
            if (from && heroTarget) {
              from.style.removeProperty('view-transition-name');
              const to = nameHero(heroTarget(), 'mr-hero');
              if (to) named.push(to);
            }
            resolve();
          } else window.setTimeout(wait, 16); // not rAF: rendering is paused while the update runs
        };
        window.setTimeout(wait, 0);
      }),
  );
  const cleanup = () => {
    for (const el of named) el.style.removeProperty('view-transition-name');
    delete document.documentElement.dataset.mrTransition;
  };
  transition.ready?.catch(() => undefined); // an aborted animation is a cut, never an error
  transition.updateCallbackDone?.catch(() => undefined);
  transition.finished.then(cleanup, cleanup);
}

const stageIsUp = () => document.querySelector('.mr-shell[data-mode="presenter"] .mr-pv') !== null;
const stageHero = () => document.querySelector('.mr-shell[data-mode="presenter"] .mr-pv-figure');
const storyIsUp = () => document.querySelector('.mr-story') !== null;

/** The longest a stage key pressed mid-navigation waits for the navigation to render before it runs anyway. */
export const PENDING_KEY_MAX_MS = 600;

/** The router-relative path of the document's URL (the Cribl base path stripped). */
export function livePathname(): string {
  const base = basePath();
  const path = window.location.pathname;
  const inApp = base !== '/' && (path === base || path.startsWith(`${base}/`)) ? path.slice(base.length) : path;
  return inApp.replace(/\/+$/, '') || '/';
}

/**
 * Whether what React rendered (pathname, search) is what the address bar says: no navigation in flight. Only
 * meaningful when the router is backed by the History API; a memory router (a sandbox without it) never moves
 * the address bar, so there it is always settled.
 */
let historyBacked = true;
export function setHistoryBackedRouter(backed: boolean): void {
  historyBacked = backed;
}

export function isSettled(pathname: string, search: string): boolean {
  if (typeof window === 'undefined' || !historyBacked) return true;
  return livePathname() === (pathname.replace(/\/+$/, '') || '/') && window.location.search === search;
}

/** Opens and leaves the stage. The stage is always the presenter view on '/', whichever tab P was pressed on. */
export function useStage(params: AppParams, setParams: (patch: ParamPatch) => void) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();

  const enter = useCallback(() => {
    withViewTransition(
      () => {
        if (pathname === '/') {
          rememberStageOrigin(null);
          setParams({ present: true });
        } else {
          // Pushed, not replaced: Back from the stage returns to the Report card (or whichever tab), which a
          // replace dropped from the history (OQ-10).
          rememberStageOrigin(originOf(pathname, search), true);
          void navigate(stageHref(search));
        }
      },
      stageIsUp,
      stageHero,
    );
    showShortcutChip(t('shortcuts.chipPresenterOn'));
  }, [navigate, pathname, search, setParams]);

  const leave = useCallback(() => {
    const origin = stageOrigin;
    const pushed = stagePushed;
    stageOrigin = null;
    stagePushed = false;
    if (origin && pathname === '/') {
      // Back to the entry the stage was pushed over (it is the origin, with its params), else replace the stage's.
      if (pushed) void navigate(-1);
      else void navigate(`${origin.pathname}${origin.search}`, { replace: true });
    } else setParams({ present: false });
    showShortcutChip(t('shortcuts.chipPresenterOff'));
  }, [navigate, pathname, setParams]);

  // A key that lands while a navigation is still committing (the URL has moved, the tab switch is a React
  // transition that has not rendered yet) would act on the old location — P right after P, or right after a
  // tab click, toggled the wrong way. Such a press waits for the commit and runs then, once.
  // (Whatever happens, a deferred press runs within PENDING_KEY_MAX_MS: a key is never lost.)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const present = params.present;
  const act = useCallback(() => {
    if (present) leave();
    else enter();
  }, [present, leave, enter]);
  const latest = useRef(act);
  useEffect(() => {
    latest.current = act;
  });
  const runPending = useCallback(() => {
    if (pending.current === null) return;
    clearTimeout(pending.current);
    pending.current = null;
    latest.current();
  }, []);
  const toggle = useCallback(() => {
    if (pending.current !== null) return; // one press at a time
    if (isSettled(pathname, search)) {
      act();
      return;
    }
    pending.current = setTimeout(runPending, PENDING_KEY_MAX_MS);
  }, [pathname, search, act, runPending]);
  useEffect(() => {
    if (pending.current !== null && isSettled(pathname, search)) runPending();
  }, [pathname, search, runPending]);
  useEffect(() => () => {
    if (pending.current !== null) clearTimeout(pending.current);
  }, []);

  return { enter, leave, toggle };
}

// ─── The keyboard map ────────────────────────────────────────────────────────

/**
 * How long '/' waits for the Ledger's search field after navigating there: its chunk may still load, and on a
 * workspace whose first sweep has not written a snapshot yet the Ledger is its skeleton (P1-K06) for a few seconds.
 */
export const SEARCH_FOCUS_WAIT_MS = 10_000;

/**
 * Focuses the view's search field as soon as it renders (after a navigation), giving up after `timeoutMs` — or as
 * soon as the member is typing in another field meanwhile, so a late search field never takes the keys from them.
 */
export function focusSearchWhenReady(timeoutMs = SEARCH_FOCUS_WAIT_MS): void {
  const start = Date.now();
  const until = start + timeoutMs;
  const attempt = () => {
    // (After a moment: the ⌘K palette that asked for the search is still closing on the first frames.)
    const typingElsewhere =
      Date.now() - start > 300 && isTypingTarget(document.activeElement) && !document.activeElement?.closest(SEARCH_FIELD_SELECTOR);
    if (typingElsewhere || focusSearchField() || Date.now() > until) return;
    window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(attempt);
}

interface KeyDeps {
  params: AppParams;
  setParams: (patch: ParamPatch) => void;
  openSheet: () => void;
}

/** One document keydown listener (capture phase) for the whole app; P / Y / ? / '/' / Escape are registered here. */
export function useShellKeys({ params, setParams, openSheet }: KeyDeps): void {
  const { story, present } = params;
  const stage = useStage(params, setParams);
  const navigate = useNavigate();
  const { pathname, search } = useLocation();

  // Y, like P, waits for a navigation still committing (a tab clicked a moment before): the Story's param is
  // patched onto the location React renders, and until the tab switch commits that is still the old tab, so
  // leaving the Story would land there instead of on the tab the member chose (OQ-02).
  const openStory = useCallback(() => {
    withViewTransition(() => setParams({ story: true }), storyIsUp);
    showShortcutChip(t('shortcuts.chipStoryOn'));
  }, [setParams]);
  const latestOpenStory = useRef(openStory);
  useEffect(() => {
    latestOpenStory.current = openStory;
  });
  const storyPending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runStory = useCallback(() => {
    if (storyPending.current === null) return;
    clearTimeout(storyPending.current);
    storyPending.current = null;
    latestOpenStory.current();
  }, []);
  useEffect(() => {
    if (storyPending.current !== null && isSettled(pathname, search)) runStory();
  }, [pathname, search, runStory]);
  useEffect(() => () => {
    if (storyPending.current !== null) clearTimeout(storyPending.current);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ⌘K / Ctrl+K opens the palette from anywhere — a text field, the stage, Story, with single-key
      // shortcuts off (a modifier chord is not a single-key shortcut, WCAG 2.1.4). P2-W22.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !event.repeat && event.key.toLowerCase() === 'k') {
        if (isWidgetKeyTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        openSheet();
        return;
      }
      if (story) {
        // Story mode: any key exits (SPEC 13) — but never a focus key, a chord, a key for a focused field,
        // select or dialog, or Enter/Space on a focused control.
        if (event.defaultPrevented || event.repeat) return;
        if (MODIFIER_KEYS.has(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
        if (STORY_KEEPS.has(event.key)) return;
        if (isTypingTarget(event.target) || isWidgetKeyTarget(event.target) || isActivation(event)) return;
        if (dispatchShortcut(event, { chordsOnly: true })) return; // Shift+D still toggles the diagnostics
        event.preventDefault();
        event.stopPropagation();
        setParams({ story: false });
        return;
      }
      dispatchShortcut(event);
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [story, setParams, openSheet]);

  useShortcut('P', stage.toggle);
  useShortcut('Y', () => {
    if (storyPending.current !== null) return; // one press at a time
    if (isSettled(pathname, search)) openStory();
    else storyPending.current = setTimeout(runStory, PENDING_KEY_MAX_MS);
  });
  useShortcut('?', openSheet);
  // '/' focuses the view's search; on a view without one it goes to the Ledger's (P1-A05), never silently
  // nothing. Not on the stage or in Story: there it would pull the presenter off the frame.
  useShortcut(
    '/',
    () => {
      if (focusSearchField()) return;
      void navigate(hrefWithStickyParams('/ledger', new URLSearchParams(search)));
      focusSearchWhenReady();
    },
    !present && !story,
  );
  // Escape leaves the stage — registered only there, so everywhere else Escape stays with the view (a pinned
  // Flow card, the Ledger search, a popover).
  useShortcut('Escape', stage.leave, present && !story);
}

/** Keeps `state.presenter` equal to ?present=1 so live polling can use the 5 s presenter cadence. */
export function usePresenterSync(present: boolean): void {
  const { setPresenter } = useActions();
  useEffect(() => {
    setPresenter(present);
  }, [present, setPresenter]);
}

/**
 * On the stage (presenter or Story) no toast appears: the frame the audience sees carries its own status
 * line and the takeover card (epic audit P0-09). Entering it clears any toast already up; leaving it lets
 * toasts through again.
 */
export function useToastStage(onStage: boolean): void {
  useEffect(() => {
    notify.setStage(onStage);
    return () => notify.setStage(false);
  }, [onStage]);
}

const LIVE_ERROR_TOAST = 'live-server-error';

/**
 * SPEC 13: a 5xx while polling toasts once and keeps the last good data; recovery closes the toast. With no
 * snapshot on screen there is no "last good data" to keep, and the view already says "Nothing to show yet"
 * inline, so no toast repeats it (P1-D02). Never on the stage (P0-09): an error still standing when the stage
 * closes toasts then.
 */
export function useLiveErrorToast(onStage: boolean): void {
  const lastError = useAppState((s) => s.status.live.lastError);
  const hasData = useAppState((s) => s.snapshot !== null);
  useEffect(() => {
    if (onStage) return;
    if (lastError && (lastError.kind === 'server' || lastError.kind === 'network') && hasData) {
      notify.once(LIVE_ERROR_TOAST, 'error', t('errors.serverToast', { status: lastError.status || t('errors.networkTitle') }));
    } else if (!lastError || !hasData) {
      notify.dismiss(LIVE_ERROR_TOAST);
    }
  }, [lastError, hasData, onStage]);
}

/**
 * Starts the tab's takeover feed at shell mount (P1-A01): the baseline is the first snapshot this tab sees,
 * not the first one the stage sees, so an incident that opened while the laptop was on Flow still lands on
 * the stage when P is pressed within 45 s. The stage (IncidentTakeover) subscribes to the same feed.
 */
export function useTakeoverFeed(): void {
  const store = useStoreApi();
  useEffect(() => {
    takeoverFeed(store);
  }, [store]);
}

interface ShellTestWindow {
  __MR_SHELL__?: { store: unknown; actions: unknown; stop: () => void };
}

/**
 * Lets the Playwright shell specs drive the store on any tab (pause polling, put a snapshot up) — the
 * presenter's hook exists only on the stage. Mock/dev builds ONLY: the flag is tested inline, so a release
 * build folds the condition to `false` and drops the body (the Presenter test hook's pattern).
 */
export function useShellTestHook(): void {
  const services = useServices();
  useEffect(() => {
    if (!(import.meta.env.DEV || import.meta.env.VITE_MR_MOCK === '1')) return;
    const w = window as unknown as ShellTestWindow;
    w.__MR_SHELL__ = { store: services.store, actions: services.actions, stop: () => services.stop() };
    return () => {
      if (w.__MR_SHELL__?.store === services.store) delete w.__MR_SHELL__;
    };
  }, [services]);
}

/** Mirrors the workspace's "Single-key shortcuts" setting into the keyboard map (P1-A09; absent = on). */
export function useSingleKeySetting(): void {
  const enabled = useAppState((s) => s.settings.keyboard?.singleKeyShortcuts !== false);
  useEffect(() => {
    setSingleKeyShortcuts(enabled);
  }, [enabled]);
}

/** The view's name for the browser tab: the tab it belongs to, the stage, Story, First run, the report card. */
export function viewTitle(pathname: string, params: Pick<AppParams, 'present' | 'story'>): string | null {
  if (params.story) return t('shortcuts.story');
  if (params.present) return t('shortcuts.presenter');
  const first = pathname.split('/').filter(Boolean)[0];
  switch (first) {
    case undefined:
      return t('nav.receipt');
    case 'first-run':
      return t('nav.firstRun');
    case 'report':
      return t('nav.report');
    case 'flow':
    case 'whatif':
    case 'ledger':
    case 'settings':
      return t(`nav.${first}`);
    case 'demo':
      return import.meta.env.VITE_MR_BUILD === 'demo' ? t('nav.demo') : null;
    default:
      return null;
  }
}

/**
 * document.title follows the view ("Ledger – Meter Reader", P1-A09) — outside Cribl only: inside the App
 * iframe the Cribl shell owns the browser tab's title.
 */
export function useDocumentTitle(pathname: string, params: Pick<AppParams, 'present' | 'story'>): void {
  const { present, story } = params;
  useEffect(() => {
    if (window.parent !== window) return;
    const view = viewTitle(pathname, { present, story });
    document.title = view ? t('nav.documentTitle', { view }) : t('app.name');
  }, [pathname, present, story]);
}

/**
 * Story on a booth screen (?story=1&stage=1, P2-W22): the first click or tap asks for full screen (a browser
 * grants it only inside a gesture), and the cursor hides after 2 s without moving. Leaving Story leaves full
 * screen if this asked for it.
 */
export const BOOTH_CURSOR_MS = 2_000;

export function useBoothMode(active: boolean): boolean {
  const [cursorHidden, setCursorHidden] = useState(false);
  useEffect(() => {
    if (!active) return;
    let asked = false;
    const onFirst = () => {
      if (asked) return;
      asked = true;
      const el = document.documentElement as HTMLElement & { requestFullscreen?: () => Promise<void> };
      if (!document.fullscreenElement && typeof el.requestFullscreen === 'function') {
        el.requestFullscreen().catch(() => {
          // Refused (an iframe without allowfullscreen): the loop still plays, windowed.
        });
      }
    };
    let timer = window.setTimeout(() => setCursorHidden(true), BOOTH_CURSOR_MS);
    const onMove = () => {
      setCursorHidden(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setCursorHidden(true), BOOTH_CURSOR_MS);
    };
    document.addEventListener('pointerdown', onFirst, { capture: true });
    document.addEventListener('mousemove', onMove, { passive: true });
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onFirst, { capture: true });
      document.removeEventListener('mousemove', onMove);
      if (asked && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      setCursorHidden(false);
    };
  }, [active]);
  return active && cursorHidden;
}
