// src/components/Shell/nav.ts — which tab a pathname belongs to (TopNav, the router's preloading). A module of its own so
// TopNav.tsx exports only its component (React Fast Refresh; oxlint react/only-export-components).

export type NavKey = 'receipt' | 'flow' | 'whatif' | 'ledger' | 'settings' | 'demo';

/** Which tab a pathname belongs to (none for /first-run). */
export function navKeyForPath(pathname: string): NavKey | undefined {
  const first = pathname.split('/').filter(Boolean)[0];
  switch (first) {
    case undefined:
    case 'report':
      return 'receipt';
    case 'flow':
    case 'whatif':
    case 'ledger':
    case 'settings':
      return first;
    case 'demo':
      return import.meta.env.VITE_MR_BUILD === 'demo' ? 'demo' : undefined;
    default:
      return undefined;
  }
}
