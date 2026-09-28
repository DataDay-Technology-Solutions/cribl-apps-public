// src/state/providers.tsx — the providers for the App's store and services (the hooks that read them are in react.tsx).

import type { ReactNode } from 'react';
import { ServicesContext, StoreContext } from './contexts.ts';
import type { AppStore } from './store.ts';
import type { AppServices } from './services.ts';

export function AppProviders({ services, children }: { services: AppServices; children: ReactNode }) {
  return (
    <ServicesContext value={services}>
      <StoreContext value={services.store}>{children}</StoreContext>
    </ServicesContext>
  );
}

/** For tests and stories that need a store without the runtime services. */
export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreContext value={store}>{children}</StoreContext>;
}
