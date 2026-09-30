// src/router.tsx — routes (SPEC 13) and the router that fits the Cribl iframe.
//
//   /                    Receipt (Presenter with ?present=1; First run on a never-priced workspace)
//   /flow                Flow
//   /whatif              What if (the Flow map in projection mode, DESIGN_BRIEF 5.9)
//   /ledger              Ledger
//   /report              Report card (from the Receipt: the savings on one page, as PDF, HTML, email or CSV)
//   /settings            Settings (+ /settings/prices, /settings/notifications, /settings/demo†), one route
//                        for every section so hopping between them never remounts the view (W3-LS-1)
//   /demo†               Demo Console
//   /first-run           First run
//   ?story=1             Story view over any route (the shell renders it)
//   † demo build only — compiled out of the release bundle (see below).
//
// Router: BrowserRouter with basename = window.CRIBL_BASE_PATH (AGENTS.md "React Router"); the platform
// syncs pushState with the parent URL. When the History API is unusable, or the document isn't under
// the base path, a MemoryRouter keeps the app working from the same initial location.
//
// Views are lazy chunks at src/views/<Name>/index.tsx with a default-exported component taking no props.
// The Settings view reads its sub-page from the URL (`useSettingsSection()` in src/lib/params.ts).
//
// Preloading (epic audit P1-A02): every view is `preloadable` — once its chunk has been fetched it renders
// synchronously, with no Suspense fallback at all (a bare `import()` beside `React.lazy` would not do that:
// lazy's own payload is still unread on its first render and suspends once). The stage and Story chunks
// are fetched when the browser is idle after the first hydration, so P and Y never flash a skeleton; a
// tab's chunk is fetched when its nav tab is hovered or focused (`preloadTab`, wired through the Shell).

import { useEffect, useState, type ReactNode } from 'react';
import {
  BrowserRouter,
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useHref,
  useLocation,
  useNavigate,
  useParams,
  type NavigateOptions,
} from 'react-router-dom';
import { RouterProvider } from '@capra/core';
import { Shell } from './components/Shell/Shell.tsx';
import type { NavKey } from './components/Shell/nav.ts';
import { basePath } from './lib/env.ts';
import { chooseRouter, memoryInitialEntry } from './lib/routerKind.ts';
import { preloadable, whenIdle } from './lib/preload.ts';
import { useAppParams } from './lib/params.ts';
import { useAppState } from './state/react.tsx';
import { homeTarget } from './state/selectors.ts';
import { TourParamSync } from './tour/TourParamSync.tsx';
import { livePathname, setHistoryBackedRouter } from './components/Shell/useShellEffects.ts';
import { guardNavigation, installPopstateGuard, targetPath } from './lib/navGuard.ts';
import { meterYoursPending } from './tour/status.ts';

declare module '@capra/core' {
  interface RouterConfig {
    routerOptions: NavigateOptions;
  }
}

const Receipt = preloadable(() => import('./views/Receipt/index.tsx'));
const Flow = preloadable(() => import('./views/Flow/index.tsx'));
const WhatIf = preloadable(() => import('./views/WhatIf/index.tsx'));
const Ledger = preloadable(() => import('./views/Ledger/index.tsx'));
const Settings = preloadable(() => import('./views/Settings/index.tsx'));
const FirstRun = preloadable(() => import('./views/FirstRun/index.tsx'));
const Presenter = preloadable(() => import('./views/Presenter/index.tsx'));
const Story = preloadable(() => import('./views/Story/index.tsx'));
const Report = preloadable(() => import('./views/Report/index.tsx'));

const ReceiptView = Receipt.Component;
const FlowView = Flow.Component;
const WhatIfView = WhatIf.Component;
const LedgerView = Ledger.Component;
const SettingsView = Settings.Component;
const FirstRunView = FirstRun.Component;
const PresenterView = Presenter.Component;
const StoryView = Story.Component;
const ReportView = Report.Component;

// The Demo Console exists only in the demo build (SPEC 13, 16 compliance: no '/demo' route string in the
// release bundle). The build flag is tested INLINE so Vite replaces it with a constant and the bundler
// drops the branch — the dynamic import, its chunk and the route strings — from the release build.
const Demo = import.meta.env.VITE_MR_BUILD === 'demo' ? preloadable(() => import('./views/Demo/index.tsx')) : null;
const DemoView = Demo ? Demo.Component : null;

/** Fetches a tab's chunk when its nav tab is hovered or focused, so the click lands on a ready view. */
function preloadTab(key: NavKey): void {
  switch (key) {
    case 'receipt':
      void Receipt.preload();
      break;
    case 'flow':
      void Flow.preload();
      break;
    case 'whatif':
      void WhatIf.preload();
      break;
    case 'ledger':
      void Ledger.preload();
      break;
    case 'settings':
      void Settings.preload();
      break;
    case 'demo':
      if (Demo) void Demo.preload();
      break;
  }
}

/** After the first hydration, fetch the stage and Story chunks while idle: P and Y then open instantly. */
function usePreloadStage(): void {
  const hydrated = useAppState((s) => s.hasHydrated);
  useEffect(() => {
    if (!hydrated) return;
    return whenIdle(() => {
      void Presenter.preload();
      void Story.preload();
    });
  }, [hydrated]);
}

/**
 * `/`: Presenter in presenter mode, First run on a never-priced workspace, else the Receipt. While the
 * first hydration is in flight ('loading') the Receipt renders its own layout-matched skeleton, since
 * the Receipt is where almost every visit lands.
 */
function HomeRoute() {
  const [params] = useAppParams();
  const { search } = useLocation();
  const target = useAppState(homeTarget);
  if (params.present) return <PresenterView />;
  // After the finished tour's "See your own number" the member is on the way to Prices (row 12): the sample is cleared
  // before that navigation lands, so an unpriced workspace must not be bounced to first run meanwhile.
  if (target === 'first-run' && !meterYoursPending()) return <Navigate to={{ pathname: '/first-run', search }} replace />;
  return <ReceiptView />;
}

/**
 * The sub-paths Settings answers under its one route (SPEC 13): the section rail's own routes. Anything else under
 * /settings/ goes home, as it did when each path had a route of its own; the demo path exists in the demo build only
 * (the inline flag keeps its string out of the release bundle).
 */
const SETTINGS_PATHS: ReadonlySet<string> = new Set(['', 'prices', 'notifications', ...(import.meta.env.VITE_MR_BUILD === 'demo' && DemoView ? ['demo'] : [])]);

/**
 * Settings under ONE route (W3-LS-1): /settings/prices, /settings?section=alerts and /settings/notifications are one
 * route and one mounted view, so a section left with unsaved changes stays mounted (P1-G07) whichever way the member
 * hops. The Shell keys its error boundary by view, not by path, for the same reason: keyed by path, every hop between
 * a path section and a ?section= one mounted a new SettingsView and the draft went with the old one. The view reads
 * its section from the URL itself (resolveSection).
 */
function SettingsRoute() {
  const rest = (useParams()['*'] ?? '').replace(/\/+$/, '');
  if (!SETTINGS_PATHS.has(rest)) return <Navigate to="/" replace />;
  return <SettingsView />;
}

function AppRoutes() {
  usePreloadStage();
  return (
    <Routes>
      <Route element={<Shell story={<StoryView />} preloadTab={preloadTab} />}>
        <Route index element={<HomeRoute />} />
        <Route path="flow" element={<FlowView />} />
        <Route path="whatif" element={<WhatIfView />} />
        <Route path="ledger" element={<LedgerView />} />
        <Route path="report" element={<ReportView />} />
        <Route path="settings/*" element={<SettingsRoute />} />
        {import.meta.env.VITE_MR_BUILD === 'demo' && DemoView ? <Route path="demo" element={<DemoView />} /> : null}
        <Route path="first-run" element={<FirstRunView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

/** Hands react-router's navigate + useHref to Capra links (TabNav, Link, ButtonLink) — basename included. */
function CapraRouterBridge({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  return (
    // Every Capra link (the top tabs included) asks the in-app navigation guard first (src/lib/navGuard.ts, r1 ui-5).
    <RouterProvider navigate={(to, options) => guardNavigation(targetPath(to), () => void navigate(to, options))} useHref={useHref}>
      {children}
    </RouterProvider>
  );
}

export function AppRouter() {
  // Decided once per page load: the probe touches history, and the router must never swap under React.
  const [{ base, kind }] = useState(() => {
    const b = basePath();
    const k = chooseRouter(b);
    setHistoryBackedRouter(k === 'browser'); // the stage keys' "navigation in flight" check (useShellEffects.ts)
    // Browser Back / Forward ask the in-app leave guard too (r2 ui-10, FINDINGS_R2 #12), History-backed routers only.
    // Installed here, before the BrowserRouter below mounts: popstate listeners on window run in the order they were
    // added (capture or not), so the guard's must come before the router's for it to hold a move the router never sees.
    if (k === 'browser') installPopstateGuard(livePathname);
    return { base: b, kind: k };
  });
  const content = (
    <CapraRouterBridge>
      <TourParamSync />
      <AppRoutes />
    </CapraRouterBridge>
  );
  if (kind === 'browser') return <BrowserRouter basename={base}>{content}</BrowserRouter>;
  return <MemoryRouter initialEntries={[memoryInitialEntry(base, window.location)]}>{content}</MemoryRouter>;
}
