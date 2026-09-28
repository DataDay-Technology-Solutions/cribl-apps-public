// src/theme/index.ts — theme access for components.
//
// The host theme lives in the app store (set by the CRIBL_APP_LAYOUT bridge installed in main.tsx);
// components read it here, never from the DOM class (AGENTS.md "Theming").

import { useAppState } from '../state/react.tsx';
import type { HostTheme } from './bridge.ts';

export type { HostTheme } from './bridge.ts';
export { installThemeBridge, initialTheme, waitForHostTheme, THEMED_CLASS } from './bridge.ts';
export { usePalette, resolvePalette, destinationColorVar, MONEY_VARS, DESTINATION_VARS } from './palette.ts';
export type { ResolvedPalette, MoneyColor } from './palette.ts';

/** The Cribl shell's current theme ('light' | 'dark'). Use for EmptyState `theme`, `*Dark` images, chart themes. */
export function useTheme(): HostTheme {
  return useAppState((s) => s.theme);
}
