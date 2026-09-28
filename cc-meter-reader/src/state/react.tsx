// src/state/react.tsx — React bindings for the app store and services.
//
//   const snapshot = useAppState((s) => s.snapshot);
//   const { saveSettings, sweepNow } = useActions();
//
// Selectors may return derived objects: results are memoized per store state and compared with
// `isEqual` (default Object.is; pass `shallowEqual` for small derived objects).
//
// The providers (AppProviders, StoreProvider) are in providers.tsx and the contexts in contexts.ts, so this module
// exports only hooks and the component module only components (React Fast Refresh; oxlint react/only-export-components).

import { useCallback, useContext, useRef, useSyncExternalStore } from 'react';
import { ServicesContext, StoreContext } from './contexts.ts';
import type { AppState, AppStore } from './store.ts';
import type { AppServices } from './services.ts';


export function useStoreApi(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStoreApi: no <AppProviders> / <StoreProvider> above this component.');
  return store;
}

/** The store when a provider is above the caller, else null — for components that also render standalone. */
export function useOptionalStoreApi(): AppStore | null {
  return useContext(StoreContext);
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices: no <AppProviders> above this component.');
  return services;
}

/** The services when <AppProviders> is above the caller, else null — for components that also render standalone (P1-F07). */
export function useOptionalServices(): AppServices | null {
  return useContext(ServicesContext);
}

/** The imperative actions (saveSettings, savePrices, sweepNow, enterSample, …). */
export function useActions(): AppServices['actions'] {
  return useServices().actions;
}

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** Subscribes to a slice of app state. */
export function useAppState<T>(selector: (state: AppState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const store = useStoreApi();
  const memo = useRef<{ state: AppState; selector: (state: AppState) => T; value: T } | null>(null);

  // The selector is usually an inline arrow, so this callback is re-created each render; the memo keeps
  // repeated getSnapshot calls for the same state + selector returning the same reference, and
  // `isEqual` keeps it stable across unrelated store updates.
  const getSnapshot = useCallback(() => {
    const state = store.getState();
    const previous = memo.current;
    if (previous && previous.state === state && previous.selector === selector) return previous.value;
    const next = selector(state);
    const value = previous && isEqual(previous.value, next) ? previous.value : next;
    memo.current = { state, selector, value };
    return value;
  }, [store, selector, isEqual]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
