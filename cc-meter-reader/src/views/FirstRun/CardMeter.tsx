// src/views/FirstRun/CardMeter.tsx — the first-run card's meter (P2-W27, DESIGN_BRIEF §1 "the meter" and
// "the receipt"): a small, flat copy of the Receipt's hero with its perforated bottom edge, so the card carries
// both identity motifs before there is any money to show.
//
//   idle    "Saved by Cribl" over a dimmed "$–––,–––" (never a display-size zero, BEAUTY F2) and the line
//           "Your number, once prices are set"
//   rolled  while "Tour with sample data" is hovered or focused (or the tour is starting), every digit wheel
//           rolls from its dash to the sample workspace's month to date — the figure the tour's Receipt opens on
//           (src/tour/controller.ts sampleOpeningMtdM, read from the tour chunk the card prefetches; until that
//           chunk is in, the meter stays on its dashes)
//
// The wheels are CSS: each is a strip of cells (a dash, then 0–9) moved by one transform per state, staggered
// from the left, 900 ms like the Meter's ease (DESIGN_BRIEF §4). Under reduced motion the figure swaps without
// rolling. No timers, no rAF; what the eye reads is aria-hidden, and one visually hidden sentence says it instead.

import type { CSSProperties } from 'react';
import { fmtDollars } from '../../../core/format.ts';
import { t } from '../../copy/en.ts';

/** The cells of one wheel: position 0 is the idle dash, position d + 1 is digit d. */
const CELLS = ['–', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** Milliseconds between one wheel starting to roll and the next (left to right). */
const STAGGER_MS = 45;

/** The idle shape before the sample's figure is known: six digit wheels, "$–––,–––". */
const IDLE_SHAPE = '$000,000';

export interface CardMeterProps {
  /** The sample's month to date (integer millicents), or null until the tour chunk has answered. */
  valueM: number | null;
  /** Show the figure (hover / focus on the tour button); ignored while `valueM` is null. */
  rolled: boolean;
}

export function CardMeter({ valueM, rolled: wantsRoll }: CardMeterProps) {
  const known = valueM !== null && Number.isFinite(valueM);
  const rolled = wantsRoll && known;
  const figure = known ? fmtDollars(valueM) : IDLE_SHAPE;
  let wheel = 0;
  return (
    <div className="mr-fr-meter" data-testid="first-run-meter" data-rolled={rolled ? 'true' : 'false'}>
      <p className="mr-fr-meter-label" aria-hidden="true">
        {t('meter.caption')}
      </p>
      <p className="mr-fr-meter-figure mr-num" aria-hidden="true" data-value={rolled ? figure : ''}>
        {[...figure].map((ch, i) => {
          if (!/\d/.test(ch)) {
            return (
              <span key={i} className="mr-fr-meter-static">
                {ch}
              </span>
            );
          }
          const style = {
            '--mr-fr-cell': String(rolled ? Number(ch) + 1 : 0),
            '--mr-fr-delay': `${wheel++ * STAGGER_MS}ms`,
          } as CSSProperties;
          return (
            <span key={i} className="mr-fr-meter-wheel" data-digit={ch}>
              <span className="mr-fr-meter-strip" style={style}>
                {CELLS.map((c, j) => (
                  <span key={j} className="mr-fr-meter-cell">
                    {c}
                  </span>
                ))}
              </span>
            </span>
          );
        })}
      </p>
      <p className="mr-fr-meter-caption" aria-hidden="true">
        {rolled ? t('firstRun.meterSample') : t('firstRun.meterIdle')}
      </p>
      <span className="mr-visually-hidden">
        {rolled ? t('firstRun.meterSampleLabel', { amount: figure }) : t('firstRun.meterIdleLabel')}
      </span>
    </div>
  );
}
