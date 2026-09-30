// src/views/Settings/index.tsx — Settings (/settings/*; PRD 8.4, 6; DESIGN_BRIEF 5.5; SPEC 5, 6, 8, 12, 13, 17).
//
// Left VerticalNavigation (router-aware: each item's click is intercepted and routed, capra.md §8.2) with
// Prices · Budgets · Cribl cost · Alerts · Where to send alerts · Demo (demo build) · Runtime; on phones a
// section picker replaces the rail. Prices and Where to send alerts have routes of their own
// (/settings/prices, /settings/notifications, SPEC 13); the other sections ride /settings?section=<id>.
//
// Every write is an explicit Save through the store, gated on `hasHydrated` and live data (canWrite).
//
// Unsaved changes (EPIC_AUDIT P1-G07): each section's SaveBar reports its dirty state here. A dirty section
// stays mounted (hidden) when the member opens another one, so its edits survive the switch; the rail marks it
// with a dot (the phone picker with "· unsaved"), and the page asks before unloading while anything is dirty.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react';
import { useHref, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, SelectField, VerticalNavigation, type Key } from '@capra/core';
import { BellOutlined, ClockOutlined, CriblOutlined, Gauge, PaperPlane, Play, Tag } from '@capra/icons';
import { t } from '../../copy/en.ts';
import { ErrorNotice } from '../../components/common/ErrorNotice.tsx';
import { LoadingBlock } from '../../components/common/Loading.tsx';
import { Page } from '../../components/Shell/Page.tsx';
import { IS_DEMO_BUILD } from '../../lib/env.ts';
import { setNavGuard } from '../../lib/navGuard.ts';
import { ConfirmModal } from '../../components/common/ConfirmModal.tsx';
import { shallowEqual, useAppState } from '../../state/react.tsx';
import { resolveSection, SECTION_LABEL_KEYS, SECTION_ORDER, sectionHref, type SectionId } from './model.ts';
import { onWriteOutcome, SettingsFailuresContext, SettingsFrameContext, SettingsSlotContext, useBeforeUnloadGuard, type SettingsFrameRegistry } from './hooks.ts';
import { AlertsSection } from './AlertsSection.tsx';
import { BudgetsSection } from './BudgetsSection.tsx';
import { CostSection } from './CostSection.tsx';
import { NotificationsSection } from './NotificationsSection.tsx';
import { PricesSection } from './PricesSection.tsx';
import { RuntimeSection } from './RuntimeSection.tsx';
import './Settings.css';

// Demo build only: the inline flag lets the bundler drop this import (and core/demo/levers) from the release.
const DemoSection = import.meta.env.VITE_MR_BUILD === 'demo' ? lazy(() => import('./DemoSection.tsx')) : null;

const AVAILABLE: readonly SectionId[] = SECTION_ORDER.filter((s) => s !== 'demo' || (IS_DEMO_BUILD && DemoSection !== null));

const ICONS: Record<SectionId, () => ReactElement> = {
  prices: () => <Tag />,
  budgets: () => <Gauge />,
  cost: () => <CriblOutlined />,
  alerts: () => <BellOutlined />,
  notifications: () => <PaperPlane />,
  demo: () => <Play />,
  runtime: () => <ClockOutlined />,
};

function NavItem({ section, active, dirty }: { section: SectionId; active: boolean; dirty: boolean }) {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const to = sectionHref(section, search);
  const href = useHref(to);
  const onClick = (e: MouseEvent) => {
    // Plain clicks route in-app; modified clicks (new tab) keep the real href (basename included).
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <VerticalNavigation.Item
      icon={ICONS[section]()}
      label={t(SECTION_LABEL_KEYS[section])}
      href={href}
      isActive={active}
      // Capra's active item draws brand.default (#008280) on brand.subtle — Cribl teal 2 (#edfbfb) in BOTH
      // themes, so a near-white pill on the dark page and 4.39:1 text (PRD 8.8 wants 4.5:1). The documented
      // escape hatch restyles only the active item with themed selected-state tokens (Settings.css, F4).
      FORCE__className={active ? 'mr-settings-nav-active' : undefined}
      onClick={onClick}
      data-section={section}
      rightElement={
        dirty ? (
          <span className="mr-settings-nav-dirty-wrap" data-testid={`nav-dirty-${section}`}>
            <span className="mr-settings-nav-dirty" aria-hidden="true" />
            <span className="mr-visually-hidden">{t('settings.navUnsaved')}</span>
          </span>
        ) : undefined
      }
    />
  );
}

function SectionBody({ section }: { section: SectionId }) {
  switch (section) {
    case 'budgets':
      return <BudgetsSection />;
    case 'cost':
      return <CostSection />;
    case 'alerts':
      return <AlertsSection />;
    case 'notifications':
      return <NotificationsSection />;
    case 'runtime':
      return <RuntimeSection />;
    case 'demo':
      return DemoSection ? (
        <Suspense fallback={<LoadingBlock loading rows={4} />}>
          <DemoSection />
        </Suspense>
      ) : (
        <PricesSection />
      );
    case 'prices':
    default:
      return <PricesSection />;
  }
}

/** Sample/replay, still hydrating, or settings unreadable: one designed notice above the sections. */
function WriteNotice() {
  const view = useAppState(
    (s) => ({ source: s.source, hydrated: s.hasHydrated, phase: s.status.hydrate.phase, settingsError: s.errors.settings }),
    shallowEqual,
  );
  if (view.source !== 'live') {
    return (
      <div className="mr-settings-notice" data-state="read-only-sample">
        <Alert appearance="info" layout="inline">
          {t('settings.readOnlySample')}
        </Alert>
      </div>
    );
  }
  if (view.settingsError && view.settingsError.kind !== 'not-found') {
    return (
      <div className="mr-settings-notice" data-state="settings-error">
        <ErrorNotice error={view.settingsError} section={t('settings.title').toLowerCase()} />
      </div>
    );
  }
  if (!view.hydrated && view.phase !== 'idle' && view.phase !== 'loading') {
    return (
      <div className="mr-settings-notice" data-state="read-only-loading">
        <Alert appearance="info" layout="inline">
          {t('settings.readOnlyLoading')}
        </Alert>
      </div>
    );
  }
  return null;
}

const isSectionId = (s: string): s is SectionId => (SECTION_ORDER as readonly string[]).includes(s);

/**
 * The frame's bookkeeping (EPIC_AUDIT P1-G07): which sections have unsaved changes, as their SaveBars report
 * them, and the failed-save line each section's bar keeps. A failure belongs to the section that asked for the
 * write (its slot, through useSaveSettings; else the bar whose Save was pressed last, e.g. Prices), even when
 * the member has opened another section before the write answered, and stays until that bar's next Save press
 * or a save that goes through.
 */
function useSettingsFrame(open: SectionId): { dirty: ReadonlySet<SectionId>; failures: Readonly<Record<string, string>>; registry: SettingsFrameRegistry } {
  const [dirty, setDirtySet] = useState<ReadonlySet<SectionId>>(() => new Set());
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const openRef = useRef(open);
  const pressedRef = useRef<string | null>(null);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const setDirty = useCallback((section: string, isDirty: boolean) => {
    if (!isSectionId(section)) return;
    setDirtySet((prev) => {
      if (prev.has(section) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(section);
      else next.delete(section);
      return next;
    });
  }, []);
  const setFailure = useCallback((section: string, line: string | null) => {
    setFailures((prev) => {
      if ((prev[section] ?? null) === line) return prev;
      const next = { ...prev };
      if (line) next[section] = line;
      else delete next[section];
      return next;
    });
  }, []);
  const savePressed = useCallback(
    (section: string) => {
      pressedRef.current = section;
      setFailure(section, null);
    },
    [setFailure],
  );
  useEffect(() => onWriteOutcome((line, section) => setFailure(section ?? pressedRef.current ?? openRef.current, line)), [setFailure]);

  const registry = useMemo(() => ({ setDirty, savePressed }), [setDirty, savePressed]);
  return { dirty, failures, registry };
}

export default function SettingsView() {
  const { pathname } = useLocation();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const section = resolveSection(pathname, search, AVAILABLE);
  const { dirty, failures, registry } = useSettingsFrame(section);
  useBeforeUnloadGuard(dirty.size > 0);
  const leaving = useLeaveGuard(dirty);
  // The open section, plus every section left with unsaved changes (kept mounted, hidden, so its draft lives).
  const mounted = AVAILABLE.filter((s) => s === section || dirty.has(s));
  const label = (s: SectionId) => (dirty.has(s) ? t('settings.sectionUnsaved', { section: t(SECTION_LABEL_KEYS[s]) }) : t(SECTION_LABEL_KEYS[s]));

  return (
    <Page className="mr-settings" data-section={section} title={t('settings.title')} subtitle={t('settings.subtitle')}>
      <WriteNotice />

      <div className="mr-settings-layout">
        <aside className="mr-settings-rail">
          <VerticalNavigation aria-label={t('settings.navLabel')}>
            <VerticalNavigation.ItemList>
              {AVAILABLE.filter((s) => s !== 'runtime').map((s) => (
                <NavItem key={s} section={s} active={s === section} dirty={dirty.has(s)} />
              ))}
            </VerticalNavigation.ItemList>
            <VerticalNavigation.Footer>
              <NavItem section="runtime" active={section === 'runtime'} dirty={dirty.has('runtime')} />
            </VerticalNavigation.Footer>
          </VerticalNavigation>
        </aside>

        <div className="mr-settings-picker">
          <SelectField
            label={t('settings.sectionPicker')}
            items={AVAILABLE.map((s) => ({ id: s, label: label(s) }))}
            value={section}
            onChange={(key: Key | null) => {
              if (key !== null) navigate(sectionHref(String(key) as SectionId, search));
            }}
          />
        </div>

        <SettingsFrameContext.Provider value={registry}>
          <SettingsFailuresContext.Provider value={failures}>
            <div className="mr-settings-content" id="mr-settings-content">
              {mounted.map((s) => (
                <div key={s} className="mr-settings-slot" data-slot={s} hidden={s !== section}>
                  <SettingsSlotContext.Provider value={s}>
                    <SectionBody section={s} />
                  </SettingsSlotContext.Provider>
                </div>
              ))}
            </div>
          </SettingsFailuresContext.Provider>
        </SettingsFrameContext.Provider>
      </div>

      <ConfirmModal
        isOpen={leaving.pending}
        title={t('settings.leaveGuard.title')}
        body={t('settings.leaveGuard.body')}
        affects={AVAILABLE.filter((s) => dirty.has(s)).map((s) => ({ label: t(SECTION_LABEL_KEYS[s]), action: t('settings.leaveGuard.action') }))}
        irreversible={false}
        confirmText={t('settings.leaveGuard.leave')}
        cancelText={t('settings.leaveGuard.stay')}
        onConfirm={leaving.leave}
        onClose={leaving.stay}
      />
    </Page>
  );
}

/**
 * The in-app leave guard (founder-build r1 ui-5, FINDINGS_R1 M1): while a section is dirty, a navigation that leaves
 * Settings (a top tab, the palette: src/lib/navGuard.ts) waits for the member's answer. Moving between sections never
 * asks: a dirty section stays mounted, so its draft survives (P1-G07).
 */
function useLeaveGuard(dirty: ReadonlySet<SectionId>): { pending: boolean; leave: () => void; stay: () => void } {
  const [proceed, setProceed] = useState<(() => void) | null>(null);
  const isDirty = dirty.size > 0;
  useEffect(() => {
    if (!isDirty) return;
    return setNavGuard((to, go) => {
      if (to === '') return false;
      const path = to.replace(/\/+$/, '') || '/';
      if (path === '/settings' || path.startsWith('/settings/')) return false;
      setProceed(() => go);
      return true;
    });
  }, [isDirty]);
  // Final 1.1.4 (hunt r3 #0): a save that was in flight when the member clicked away (Start the meter, then a tab) can
  // land while the dialog is open. Nothing is left to discard then, so the dialog closes and the navigation the member
  // asked for goes ahead, as Leave would. It never stays open over an empty list saying "nothing has been written".
  // Deferred a tick and cancelled if the member answers first (Stay) or the section turns dirty again.
  useEffect(() => {
    if (isDirty || proceed === null) return;
    const id = window.setTimeout(() => {
      setProceed(null);
      proceed();
    }, 0);
    return () => window.clearTimeout(id);
  }, [isDirty, proceed]);
  const leave = useCallback(() => {
    const go = proceed;
    setProceed(null);
    // After the dialog has closed, so the next page opens clean.
    if (go) window.setTimeout(go, 0);
  }, [proceed]);
  const stay = useCallback(() => setProceed(null), []);
  return { pending: proceed !== null, leave, stay };
}
