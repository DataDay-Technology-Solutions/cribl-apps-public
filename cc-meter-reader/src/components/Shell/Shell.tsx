// src/components/Shell/Shell.tsx — the app chrome inside the Cribl shell.
//
//   normal     sticky header (tab bar + status cluster, and the sample band under it while sample or replay
//              data is on screen, so it never scrolls away — P1-A06) · the routed view · footer
//   presenter  (?present=1 or P) THE stage, dark on every account (P1-A07): the presenter view on '/', no
//              chrome (PRD 8.1, 8.8 item 8). P on
//              any other tab, or a deep link `/ledger?present=1`, goes to '/' and remembers the tab for the
//              way back (P0-06); it never strips the chrome off a tab
//   story      (?story=1 or Y) the Story view full-frame; any key but a focus key exits (SPEC 13, PRD 8.9)
//
// The shell also owns the keyboard map, the shortcut sheet, the shortcut chip, the diagnostics panel (all
// mounted once, beside whichever branch is up, so switching modes never resets them) and the
// one-per-episode server-error toast, which the stage never shows (P0-09).
//
// Loading (P1-A02): the Suspense boundary sits OUTSIDE the per-route error boundary, so a tab switch — a
// router transition — keeps the current view up until the next one is ready instead of flashing a skeleton;
// the cold-load fallback sits in the one page frame, so its left edge is the view's. The router preloads
// the stage and Story chunks after hydration and a tab's chunk on hover or focus (`preloadTab`).

import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { DeepLinksContext } from '../../lib/deepLinks.ts';
import { t } from '../../copy/en.ts';
import { IS_DEMO_BUILD } from '../../lib/env.ts';
import { useAppParams } from '../../lib/params.ts';
import { useAppState, useStoreApi } from '../../state/react.tsx';
import { SampleBand } from '../common/SampleBand.tsx';
import { CommandPalette } from '../common/CommandPalette.tsx';
import { ViewSkeleton } from '../common/Loading.tsx';
import { ViewErrorBoundary } from '../common/ViewErrorBoundary.tsx';
import { DiagPanel } from './DiagPanel.tsx';
import { Footer } from './Footer.tsx';
import { Page } from './Page.tsx';
import { ShortcutChip } from './ShortcutChip.tsx';
import { StageAnnouncer } from './StageAnnouncer.tsx';
import { useRecordSweeps } from './sweepHistory.ts';
import type { NavKey } from './nav.ts';
import { TopNav } from './TopNav.tsx';
import {
  originOf,
  rememberStageOrigin,
  stageHref,
  useLiveErrorToast,
  usePresenterSync,
  useShellKeys,
  useBoothMode,
  useDocumentTitle,
  useShellTestHook,
  useSingleKeySetting,
  useTakeoverFeed,
  useToastStage,
} from './useShellEffects.ts';
import './Shell.css';

export interface ShellProps {
  /** The Story view element (lazy), rendered full-frame while ?story=1. */
  story: ReactNode;
  /** Warms a tab's view chunk when its nav tab is hovered or focused (router.tsx). */
  preloadTab?: (key: NavKey) => void;
}

/** The custom property other sticky elements can offset by: the sticky header's height (band included). */
export const SHELL_HEADER_HEIGHT_VAR = '--mr-shell-header-h';

/**
 * `/ledger?present=1` (a deep link, or an old bookmark): go to the stage on '/', remember the tab for the way
 * back. A passive effect, not a layout effect: on a cold load the router subscribes to history in its own
 * layout effect, which runs after this child's, so a navigate from a layout effect would change the URL
 * without the router ever hearing of it.
 */
function StageRedirect() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  useEffect(() => {
    rememberStageOrigin(originOf(pathname, search));
    void navigate(stageHref(search), { replace: true });
  }, [navigate, pathname, search]);
  return null;
}

/** The stage's fallback while its chunk loads (normally never: it is preloaded): the empty stage, no skeleton. */
function StageFallback() {
  return <div className="mr-stage-fallback" aria-busy="true" />;
}

/** Publishes the sticky header's height (it grows by the sample band and wraps on narrow frames). */
function useHeaderHeight() {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const header = ref.current;
    const root = document.documentElement;
    if (!header) return;
    const apply = () => root.style.setProperty(SHELL_HEADER_HEIGHT_VAR, `${Math.round(header.getBoundingClientRect().height)}px`);
    apply();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    observer?.observe(header);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(SHELL_HEADER_HEIGHT_VAR);
    };
  }, []);
  return ref;
}

/** Whether the page has scrolled under the sticky header (it then casts a shadow, P1-A05). */
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(() => typeof window !== 'undefined' && window.scrollY > 0);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 0);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return scrolled;
}

/** The first stop of the Tab order: straight to the view, past the tab row (P1-A05, WCAG 2.4.1). */
function SkipLink() {
  return (
    <a
      className="mr-skip-link"
      href="#main"
      onClick={(event) => {
        // No hash in the URL (the router would read it as a navigation): move focus, keep the address.
        event.preventDefault();
        const main = document.getElementById('main');
        main?.focus({ preventScroll: true });
        main?.scrollIntoView({ block: 'start' });
      }}
    >
      {t('nav.skipToContent')}
    </a>
  );
}

/**
 * After an in-app navigation that leaves focus nowhere (the control that navigated is gone: Enter on Report card,
 * on Tour with sample data), focus moves to the new view's main region, so the next Tab continues in the view
 * instead of restarting at the tab row (OQ-11). A navigation from a control still on screen (a nav tab) keeps it.
 */
function useFocusAfterNavigation(pathname: string): void {
  // The path last seen, not a first-render flag: StrictMode runs a mount's effects twice with the refs kept, and a
  // page load must leave focus where the browser put it (Tab from the top reaches Skip to content first).
  const seen = useRef(pathname);
  useEffect(() => {
    if (seen.current === pathname) return;
    seen.current = pathname;
    let tries = 0;
    let frame = 0;
    const settle = () => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const main = document.getElementById('main');
      // The view may still be its chunk's fallback: wait a few frames for its heading.
      const heading = main?.querySelector<HTMLElement>('h1');
      if (!heading && tries++ < 30) {
        frame = window.requestAnimationFrame(settle);
        return;
      }
      main?.focus({ preventScroll: true });
    };
    frame = window.requestAnimationFrame(settle);
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);
}

function NormalShell({ pathname, preloadTab }: { pathname: string; preloadTab?: (key: NavKey) => void }) {
  const headerRef = useHeaderHeight();
  const scrolled = useScrolled();
  useFocusAfterNavigation(pathname);
  return (
    <div className="mr-shell" data-mode="normal">
      <SkipLink />
      <header className="mr-shell-header" ref={headerRef} data-scrolled={scrolled ? 'true' : undefined}>
        <TopNav onIntent={preloadTab} />
        <SampleBand />
      </header>
      <main className="mr-shell-main" id="main" tabIndex={-1}>
        <Suspense
          fallback={
            <Page width={pathname === '/first-run' ? 'narrow' : 'default'} data-testid="view-loading">
              <ViewSkeleton />
            </Page>
          }
        >
          {/* Keyed by view (the path's first segment) so a crash in one view doesn't stick when the user navigates
              away, while a hop inside a view (Settings' sections: /settings/prices ↔ /settings?section=alerts) keeps
              it mounted, and with it a section's unsaved edits (W3-LS-1). */}
          <ViewErrorBoundary key={pathname.split('/')[1] ?? ''}>
            <Outlet />
          </ViewErrorBoundary>
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}

export function Shell({ story, preloadTab }: ShellProps) {
  const [params, setParams] = useAppParams();
  const { pathname } = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const demoLevers = useAppState((s) => IS_DEMO_BUILD && s.settings.demo.enabled);
  // No pipeline deep links into Cribl on sample data (OQ-01): the sample's pipelines are not in this workspace.
  const sample = useAppState((s) => s.source === 'sample');
  const onStage = params.present || params.story;

  // Focus goes back where it was when the sheet closes — or to the view, never to <body> (P1-A05): a sheet
  // opened by '?' from nothing focused has nothing for the dialog to restore.
  const sheetOpener = useRef<HTMLElement | null>(null);
  const openSheet = useCallback(() => {
    const active = document.activeElement;
    sheetOpener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setSheetOpen(true);
  }, []);
  const closeSheet = useCallback(() => {
    setSheetOpen(false);
    const opener = sheetOpener.current;
    sheetOpener.current = null;
    // After the dialog has gone (and made its own attempt to restore focus).
    const until = Date.now() + 1_000;
    const settle = () => {
      if (document.querySelector('[role="dialog"]') && Date.now() < until) {
        window.requestAnimationFrame(settle);
        return;
      }
      if (document.activeElement && document.activeElement !== document.body) return;
      const target = opener?.isConnected ? opener : document.getElementById('main');
      target?.focus({ preventScroll: true });
    };
    window.requestAnimationFrame(settle);
  }, []);
  useShellKeys({ params, setParams, openSheet });
  usePresenterSync(params.present);
  useTakeoverFeed(); // the takeover's baseline is the tab's first snapshot, not the stage's (P1-A01)
  useShellTestHook();
  useSingleKeySetting(); // the WCAG 2.1.4 off switch (P1-A09)
  const cursorHidden = useBoothMode(params.story && params.stage); // the booth loop (P2-W22)
  useRecordSweeps(useStoreApi()); // the live pulse's hour of sweeps (P2-W21)
  useDocumentTitle(pathname, params);
  useToastStage(onStage); // before the error toast, so leaving the stage lets it through in the same commit
  useLiveErrorToast(onStage);

  let content: ReactNode;
  if (params.story) {
    content = (
      // ?story=1&stage=1 (the booth loop, P2-W22): the dark stage whatever the account theme, full screen on the
      // first click, the cursor hidden after 2 s still.
      <div
        className={`mr-shell mr-shell--story${params.stage ? ' dark mr-shell--booth' : ''}`}
        data-mode="story"
        data-booth={params.stage ? 'true' : undefined}
        data-cursor={cursorHidden ? 'hidden' : undefined}
      >
        <ViewErrorBoundary key="story">
          <Suspense fallback={<StageFallback />}>{story}</Suspense>
        </ViewErrorBoundary>
      </div>
    );
  } else if (params.present) {
    content = (
      // Dark on every account (DESIGN_BRIEF 5.2 "Dark by default on stage", P1-A07): Capra's `dark` class on the
      // stage's own wrapper re-themes its subtree (the app aliases follow, palette.css); portalled overlays
      // (a dialog, a toast) keep following <body> and the account's theme. Not a theme switcher: nothing is
      // chosen or stored, the stage simply is dark.
      <div className="mr-shell mr-shell--presenter dark" data-mode="presenter">
        {pathname === '/' ? (
          <main className="mr-presenter-main" id="main" tabIndex={-1}>
            <ViewErrorBoundary key="present">
              <Suspense fallback={<StageFallback />}>
                <Outlet />
              </Suspense>
            </ViewErrorBoundary>
            <StageAnnouncer />
          </main>
        ) : (
          <StageRedirect />
        )}
      </div>
    );
  } else {
    content = <NormalShell pathname={pathname} preloadTab={preloadTab} />;
  }

  return (
    <DeepLinksContext.Provider value={!sample}>
      {content}
      <CommandPalette isOpen={sheetOpen} onClose={closeSheet} showDemoLevers={demoLevers} />
      <ShortcutChip />
      <DiagPanel />
    </DeepLinksContext.Provider>
  );
}
