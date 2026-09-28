// src/views/Presenter/heroValue.ts — which figure the stage shows, and the width it is sized for.
//
//   • periodFigure: the headline figure for the stage's period, and whether it accrues between sweeps (MTD,
//     today and 30 days are running totals; the annualized run rate is a rate, not a running total);
//   • figureBudget: the character count the hero is sized for — at least '$1,000,000' (10 characters), or
//     the widest of the four period figures — so the figure keeps one size as it crosses a magnitude and when
//     the period changes (P1-B03: a smaller number used to render bigger, so crossing $1M shrank the hero 17 %).
//
// The ticking, easing and rolling are the shared Meter's (src/components/Meter, SPEC 13 "Ticking").

import type { HeadlinePeriod, Headline } from '../../../core/types.ts';
import { fmtDollars } from '../../../core/format.ts';

export interface PeriodFigure {
  valueM: number;
  accrue: boolean;
}

export function periodFigure(headline: Headline | null | undefined, period: HeadlinePeriod): PeriodFigure {
  if (!headline) return { valueM: 0, accrue: false };
  switch (period) {
    case 'today':
      return { valueM: headline.todayM, accrue: true };
    case '30d':
      return { valueM: headline.d30M, accrue: true };
    case 'mtd':
      return { valueM: headline.mtdM, accrue: true };
    default:
      return { valueM: headline.annualizedM, accrue: false };
  }
}

/** The smallest budget: '$1,000,000'. Six- and seven-figure amounts share one size on stage. */
export const MIN_FIGURE_CHARS = 10;

/** Characters the stage's figure is sized for: the widest period figure, never fewer than MIN_FIGURE_CHARS. */
export function figureBudget(headline: Headline | null | undefined): number {
  if (!headline) return MIN_FIGURE_CHARS;
  const widest = Math.max(
    0,
    ...[headline.todayM, headline.mtdM, headline.d30M, headline.annualizedM].filter((m) => Number.isFinite(m)),
  );
  return Math.max(MIN_FIGURE_CHARS, fmtDollars(widest).length);
}
