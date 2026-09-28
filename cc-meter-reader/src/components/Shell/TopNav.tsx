// src/components/Shell/TopNav.tsx — the app's compact tab bar. The Cribl shell already draws the product
// header above the iframe, so there is no second title bar: just Receipt · Flow · What if · Ledger · Settings
// (· Demo in the demo build with demo mode on) and the status cluster on the right.
//
// Tabs are Capra TabNav links; the RouterProvider in router.tsx turns them into client-side navigation
// with the basename applied, and they carry the sticky ?group / ?period params.
//
// Phones (BEAUTY-3a F6): the release's five tabs fit 390 px beside the status dot, with the Ledger's count on the
// label's corner (Shell.css, leftovers); six tabs (the demo build) or a status word do not, so the row scrolls on
// its own (never the page).
// The active tab is always scrolled fully into view (the phone remote lives on Demo, the last tab), and
// the edge that hides more tabs fades out instead of cutting a label in half. The status cluster sits
// outside the scrolling row, so the live dot never scrolls away.
//
// Intent (epic audit P1-A02): hovering or focusing a tab tells the router which view is next
// (`onIntent`), so its chunk is fetched before the click. Delegated on our own wrapper from the link's
// href — nothing reads Capra's TabNav internals.

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { TabNav, type TabNavItemType } from '@capra/core';
import { t, tn } from '../../copy/en.ts';
import { basePath } from '../../lib/env.ts';
import { hrefWithStickyParams } from '../../lib/params.ts';
import { useAppState } from '../../state/react.tsx';
import { StatusPulse } from './StatusPulse.tsx';
import { navKeyForPath, type NavKey } from './nav.ts';
import { revealScrollLeft, scrollEdges } from './topnavScroll.ts';

function markEdges(el: HTMLElement): void {
  const { start, end } = scrollEdges(el);
  el.dataset.fadeStart = start ? 'true' : 'false';
  el.dataset.fadeEnd = end ? 'true' : 'false';
}

function revealActive(el: HTMLElement): void {
  const active = el.querySelector<HTMLElement>('a[aria-current="page"]');
  if (active) {
    const box = el.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    const left = tab.left - box.left + el.scrollLeft;
    const next = revealScrollLeft(el.scrollLeft, el.clientWidth, left, left + tab.width);
    if (next !== el.scrollLeft) el.scrollLeft = next;
  }
  markEdges(el);
}

/** A tab's label with its badge: a count (open alerts) or a dot (unpriced destinations); the tab's aria-label says it. */
function TabName({ label, count = 0, dot = false, tone }: { label: string; count?: number; dot?: boolean; tone: 'danger' | 'warning' }) {
  return (
    <span className="mr-tab-name">
      {label}
      {count > 0 ? (
        <span className="mr-tab-badge mr-num" data-tone={tone} aria-hidden="true" data-testid="tab-badge">
          {count}
        </span>
      ) : dot ? (
        <span className="mr-tab-dot" data-tone={tone} aria-hidden="true" data-testid="tab-dot" />
      ) : null}
    </span>
  );
}

export interface TopNavProps {
  /** A tab was hovered or focused: the view it opens is probably next. */
  onIntent?: (key: NavKey) => void;
}

/** The tab a hovered or focused element in the tab row points at, from its link's href. */
function intentKey(target: EventTarget | null): NavKey | undefined {
  if (!(target instanceof Element)) return undefined;
  const link = target.closest('a[href]');
  const href = link?.getAttribute('href');
  if (!href) return undefined;
  try {
    const { pathname } = new URL(href, window.location.href);
    const base = basePath();
    const inApp = base !== '/' && (pathname === base || pathname.startsWith(`${base}/`)) ? pathname.slice(base.length) || '/' : pathname;
    return navKeyForPath(inApp);
  } catch {
    return undefined;
  }
}

function announce(onIntent: (key: NavKey) => void, target: EventTarget | null): void {
  const key = intentKey(target);
  if (key) onIntent(key);
}

export function TopNav({ onIntent }: TopNavProps = {}) {
  const { pathname } = useLocation();
  const [search] = useSearchParams();
  const demoEnabled = useAppState((s) => s.settings.demo.enabled);
  // Tab badges (P2-W21): open alerts on the Ledger, unpriced destinations on Settings, from the snapshot on screen.
  const openAlerts = useAppState((s) => s.snapshot?.openIncidents ?? 0);
  const unpriced = useAppState((s) => s.snapshot?.unpricedOutputIds.length ?? 0);
  const tabsRef = useRef<HTMLDivElement>(null);
  const activeKey = navKeyForPath(pathname);

  const items = useMemo<TabNavItemType[]>(() => {
    const list: TabNavItemType[] = [
      { key: 'receipt', name: t('nav.receipt'), href: hrefWithStickyParams('/', search) },
      { key: 'flow', name: t('nav.flow'), href: hrefWithStickyParams('/flow', search) },
      { key: 'whatif', name: t('nav.whatif'), href: hrefWithStickyParams('/whatif', search) },
      {
        key: 'ledger',
        name: <TabName label={t('nav.ledger')} count={openAlerts} tone="danger" />,
        ...(openAlerts > 0 ? { 'aria-label': tn('nav.ledgerAlerts', openAlerts) } : {}),
        href: hrefWithStickyParams('/ledger', search),
      },
      {
        key: 'settings',
        name: <TabName label={t('nav.settings')} dot={unpriced > 0} tone="warning" />,
        ...(unpriced > 0 ? { 'aria-label': tn('nav.settingsUnpriced', unpriced) } : {}),
        href: hrefWithStickyParams('/settings', search),
      },
    ];
    // Demo build only (SPEC 13): the condition is written inline so the release bundle drops the
    // Demo tab — including its '/demo' href — at build time.
    if (import.meta.env.VITE_MR_BUILD === 'demo' && demoEnabled) {
      list.push({ key: 'demo', name: t('nav.demo'), href: hrefWithStickyParams('/demo', search) });
    }
    return list;
  }, [search, demoEnabled, openAlerts, unpriced]);

  // The active tab (or a newly added Demo tab) comes into view before paint.
  useLayoutEffect(() => {
    const el = tabsRef.current;
    if (el) revealActive(el);
  }, [activeKey, items.length]);

  // Fades follow scrolling and resizing; a resize (rotation, a wider frame) keeps the active tab in view.
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onScroll = () => markEdges(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => revealActive(el));
    observer?.observe(el);
    // The tab row itself changes width when web fonts land or a tab is added.
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
  }, []);

  return (
    <div className="mr-topnav">
      <div
        className="mr-topnav-tabs"
        ref={tabsRef}
        data-fade-start="false"
        data-fade-end="false"
        onPointerOver={onIntent ? (e) => announce(onIntent, e.target) : undefined}
        onFocus={onIntent ? (e) => announce(onIntent, e.target) : undefined}
      >
        <TabNav aria-label={t('nav.ariaLabel')} items={items} activeKey={activeKey} wrap={false} />
      </div>
      <div className="mr-topnav-status">
        <StatusPulse />
      </div>
    </div>
  );
}
