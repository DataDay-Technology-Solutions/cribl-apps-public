// src/components/common/Figures.tsx — Money, Pct, Bytes: every number on screen goes through these so
// the figures share one typographic treatment (tabular numerals, PRD 8.8 item 1) and one formatter
// (src/lib/format.ts → core/format.ts). Units ("/ day") render as a secondary-text suffix, never inside
// the big number (PRD 8.8 item 2).

import type { ReactNode } from 'react';
import { t } from '../../copy/en.ts';
import { formatBytes, formatMoney, formatPct } from '../../lib/format.ts';
import './common.css';

export type MoneyTone = 'saved' | 'paid' | 'whp' | 'incident-high' | 'incident-medium' | 'inherit';
export type Per = 'day' | 'year' | 'hour';

const PER_COPY: Record<Per, string> = {
  day: t('units.perDay'),
  year: t('units.perYear'),
  hour: t('units.perHour'),
};

function cx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

function Suffix({ per }: { per?: Per }): ReactNode {
  return per ? <span className="mr-figure-unit">{PER_COPY[per]}</span> : null;
}

interface FigureBaseProps {
  /** Unit suffix in secondary text: "/ day", "/ year", "/ hour". */
  per?: Per;
  className?: string;
  /** Story-mode / video callout target id (SPEC 15). */
  callout?: string;
  title?: string;
}

export interface MoneyProps extends FigureBaseProps {
  /** Integer millicents. null/undefined renders an em dash. */
  value: number | null | undefined;
  /** Cents — the ticking counter only. */
  cents?: boolean;
  compact?: boolean;
  signed?: boolean;
  tone?: MoneyTone;
}

/** A money figure: whole dollars by default, tabular numerals, optional semantic tone. */
export function Money({ value, cents, compact, signed, tone = 'inherit', per, className, callout, title }: MoneyProps) {
  const text = value === null || value === undefined ? t('common.dash') : formatMoney(value, { cents, compact, signed });
  return (
    <span className={cx('mr-figure', tone !== 'inherit' && `mr-${tone}`, className)} data-callout={callout} title={title}>
      <span className="mr-num">{text}</span>
      <Suffix per={per} />
    </span>
  );
}

export interface PctProps extends Omit<FigureBaseProps, 'per'> {
  /** Ratio in [0, 1]. */
  value: number | null | undefined;
  signed?: boolean;
  tone?: MoneyTone;
}

/** An integer percentage from a ratio. */
export function Pct({ value, signed, tone = 'inherit', className, callout, title }: PctProps) {
  const text = value === null || value === undefined ? t('common.dash') : formatPct(value, { signed });
  return (
    <span className={cx('mr-figure', tone !== 'inherit' && `mr-${tone}`, className)} data-callout={callout} title={title}>
      <span className="mr-num">{text}</span>
    </span>
  );
}

export interface BytesProps extends FigureBaseProps {
  /** Bytes (decimal units). */
  value: number | null | undefined;
}

/** A byte volume in GB/TB with one decimal. */
export function Bytes({ value, per, className, callout, title }: BytesProps) {
  const text = value === null || value === undefined ? t('common.dash') : formatBytes(value);
  return (
    <span className={cx('mr-figure', className)} data-callout={callout} title={title}>
      <span className="mr-num">{text}</span>
      <Suffix per={per} />
    </span>
  );
}
