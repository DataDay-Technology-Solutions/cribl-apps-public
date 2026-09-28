// src/state/contexts.ts — the React contexts the App's store and services travel in: provided by providers.tsx, read by
// the hooks in react.tsx.

import { createContext } from 'react';
import type { AppStore } from './store.ts';
import type { AppServices } from './services.ts';

export const StoreContext = createContext<AppStore | null>(null);
export const ServicesContext = createContext<AppServices | null>(null);
