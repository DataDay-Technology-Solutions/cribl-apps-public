// src/views/Presenter/basis.ts — the words under the presenter's hero number (SPEC 8, SPEC 17).
//
// The annualized basis is tested on the RAW `annualizedFromDays` (REVIEW-3a #12). Rounding first made 12–24 h
// of data read "from the last 1 day" while the Receipt said something else. A whole day or more names the
// days (the Receipt's `meter.annualizedFrom`); less than a day names the hours, and under an hour the
// minutes, so the first minutes after pricing never claim an hour or a day they do not have.

import type { Headline, HeadlinePeriod } from '../../../core/types.ts';
import { t, tn } from '../../copy/en.ts';

export function annualizedBasis(annualizedFromDays: number | null | undefined): string {
  const days = typeof annualizedFromDays === 'number' && Number.isFinite(annualizedFromDays) ? Math.max(0, annualizedFromDays) : 0;
  if (days >= 1) return tn('meter.annualizedFrom', Math.round(days));
  const minutes = Math.round(days * 1440);
  if (minutes <= 0) return t('presenter.captionToday');
  if (minutes < 60) return tn('presenter.annualizedFromMinutes', minutes);
  return tn('presenter.annualizedFromHours', Math.round(minutes / 60));
}

export function periodBasis(period: HeadlinePeriod, headline: Headline | null | undefined): string {
  if (period === 'annualized') return annualizedBasis(headline?.annualizedFromDays);
  return t(period === 'mtd' ? 'meter.period.mtd' : period === 'today' ? 'meter.period.today' : 'meter.period.30d');
}
