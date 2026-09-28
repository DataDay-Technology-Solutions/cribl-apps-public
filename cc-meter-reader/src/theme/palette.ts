// src/theme/palette.ts — the money palette and destination ramp as resolved colours, for the places
// CSS `token()` can't reach (SVG pattern stops, canvas, computed gradients). Prefer CSS classes and
// `var(--mr-*)` wherever an element can take a class; use this only for values that must be strings.
//
// The values are read from the `--mr-*` custom properties declared in src/styles/palette.css (which
// alias Capra tokens), so there is still exactly one definition of every colour. They are re-read
// whenever the host theme changes.

import { useMemo } from 'react';
import { readCssVar } from '../lib/dom.ts';
import { useAppState } from '../state/react.tsx';
import type { HostTheme } from './bridge.ts';

export const MONEY_VARS = {
  saved: '--mr-color-saved',
  paid: '--mr-color-paid',
  whp: '--mr-color-whp',
  incidentHigh: '--mr-color-incident-high',
  incidentMedium: '--mr-color-incident-medium',
  info: '--mr-color-info',
  savedFill: '--mr-fill-saved',
  savedFillSubtle: '--mr-fill-saved-subtle',
  paidFill: '--mr-fill-paid',
  whpFill: '--mr-fill-whp',
  incidentHighFill: '--mr-fill-incident-high',
  incidentMediumFill: '--mr-fill-incident-medium',
  savedHatch: '--mr-hatch-saved',
  whpHatch: '--mr-hatch-whp',
  axis: '--mr-chart-axis',
  grid: '--mr-chart-grid',
  marker: '--mr-chart-marker',
  surface: '--mr-chart-surface',
} as const;

export type MoneyColor = keyof typeof MONEY_VARS;

/** Destination hues, in assignment order (at most six, PRD 8.8 item 3). */
export const DESTINATION_VARS = ['--mr-dest-1', '--mr-dest-2', '--mr-dest-3', '--mr-dest-4', '--mr-dest-5', '--mr-dest-6'] as const;

export interface ResolvedPalette {
  theme: HostTheme;
  money: Record<MoneyColor, string>;
  destinations: string[];
}

/** Resolves the palette from computed styles on <body>. */
export function resolvePalette(theme: HostTheme): ResolvedPalette {
  const money = {} as Record<MoneyColor, string>;
  for (const [name, cssVar] of Object.entries(MONEY_VARS) as [MoneyColor, string][]) {
    money[name] = readCssVar(cssVar);
  }
  return { theme, money, destinations: DESTINATION_VARS.map((v) => readCssVar(v)) };
}

/** The one neutral for a seventh destination and beyond (never a repeated hue; mirrors --mr-src-tail). */
export const DESTINATION_TAIL_VAR = '--mr-dest-tail';

/**
 * A stable colour per destination. Six hues, never repeated (App QA: wrapping gave two destinations one dot, e.g.
 * Splunk Cloud and Datadog): with six destinations or fewer each takes the hue of its place in the sorted id list,
 * so colours don't shuffle when flows reorder by value. With more, the six that carry the most money (`weightOf`,
 * e.g. would-have-paid a day; ties by id) take the hues, still in sorted-id order among themselves, and the rest
 * share one neutral, so the leadership view never greys out its biggest destinations.
 */
export function destinationColorVar(outputId: string, allOutputIds: readonly string[], weightOf?: (id: string) => number): string {
  const all = [...new Set(allOutputIds)].sort();
  // an id the list does not know keeps the first hue, as before
  if (!all.includes(outputId)) return `var(${DESTINATION_VARS[0]})`;
  let coloured = all;
  if (all.length > DESTINATION_VARS.length && weightOf) {
    const w = (id: string): number => {
      const v = weightOf(id);
      return Number.isFinite(v) ? v : 0;
    };
    const top = new Set([...all].sort((a, b) => w(b) - w(a) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, DESTINATION_VARS.length));
    coloured = all.filter((id) => top.has(id));
  }
  const index = coloured.indexOf(outputId);
  return `var(${index >= 0 && index < DESTINATION_VARS.length ? DESTINATION_VARS[index] : DESTINATION_TAIL_VAR})`;
}

/** The resolved palette for the current host theme (recomputed when the theme changes). */
export function usePalette(): ResolvedPalette {
  const theme = useAppState((s) => s.theme);
  return useMemo(() => resolvePalette(theme), [theme]);
}
