// src/components/HowItWorks/HowItWorks.tsx — the four-step "How it works" strip (PRD 8.9, SPEC 17):
// reads every flow → prices it at the destination → shows what Cribl saved → alerts in dollars.
//
//   variant 'strip'   four steps in a row joined by a hairline (Receipt disclosure, First run card);
//                     two by two under 640 px
//   variant 'stage'   the strip at presenter scale (labels ≥ 28 px at 1920): the unpriced stage still pitches
//   variant 'compact' a numbered vertical list for narrow places
//
// Story mode animates it left to right by raising `activeStep` (0-based); steps after it are dimmed and the
// hairline is drawn up to the active step. `sequence` plays the same thing once on mount, on its own: step 1
// lights, then 2, 3 and 4 at 400 ms intervals while the hairline draws ahead of them (P2-W27) — the product
// explaining itself. Under reduced motion every step is lit at once and nothing draws.
// Icons come from @capra/icons at one size and stroke (PRD 8.8 item 11).

import { useEffect, useState, type CSSProperties } from 'react';
import { t } from '../../copy/en.ts';
import { prefersReducedMotion } from '../../lib/dom.ts';
import { HOW_IT_WORKS_STEPS } from './steps.ts';
import './HowItWorks.css';

export type HowItWorksVariant = 'strip' | 'stage' | 'compact';

/** Milliseconds between two steps lighting when the strip plays its sequence. */
export const HOW_SEQUENCE_STEP_MS = 400;

export interface HowItWorksProps {
  variant?: HowItWorksVariant;
  /** Highlight steps 0..activeStep and dim the rest (Story mode beat 1). Omit to show all four. */
  activeStep?: number;
  /** Light the steps one by one on mount (ignored when `activeStep` is given; all lit under reduced motion). */
  sequence?: boolean;
  /** Accessible name for the list (defaults to the Receipt disclosure's title). */
  ariaLabel?: string;
  className?: string;
}

const LAST = HOW_IT_WORKS_STEPS.length - 1;

/** The step the mount sequence has lit (-1 before the first), or undefined when there is no sequence to play. */
function useSequence(play: boolean): number | undefined {
  const [lit, setLit] = useState<number | undefined>(() => (play && !prefersReducedMotion() ? -1 : undefined));
  useEffect(() => {
    if (lit === undefined || lit >= LAST) return;
    const timer = window.setTimeout(() => setLit(lit + 1), HOW_SEQUENCE_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [lit]);
  return lit;
}

export function HowItWorks({ variant = 'strip', activeStep, sequence = false, ariaLabel, className }: HowItWorksProps) {
  const lit = useSequence(sequence && activeStep === undefined);
  const active = activeStep ?? lit;
  // How far the hairline is drawn, 0..1 from the first icon's centre to the last's: up to the active step, and
  // one step ahead of it while the sequence plays (it arrives as the next step lights).
  const drawn = active === undefined ? 1 : Math.min(1, Math.max(0, (lit !== undefined && activeStep === undefined ? active + 1 : active) / LAST));
  return (
    <ol
      className={['mr-how', `mr-how--${variant}`, className].filter(Boolean).join(' ')}
      aria-label={ariaLabel ?? t('receiptView.howToggle')}
      data-callout="how-it-works"
      data-sequence={lit === undefined ? undefined : lit >= LAST ? 'done' : 'playing'}
      style={{ '--mr-how-drawn': String(drawn) } as CSSProperties}
    >
      {HOW_IT_WORKS_STEPS.map(({ key, Icon }, i) => {
        const dim = active !== undefined && i > active;
        return (
          <li key={key} className="mr-how-step" data-active={dim ? 'false' : 'true'} data-step={i + 1}>
            <span className="mr-how-icon" aria-hidden="true">
              <Icon size={variant === 'compact' ? 'sm' : variant === 'stage' ? 'lg' : 'md'} aria-hidden />
            </span>
            <span className="mr-how-text">
              <span className="mr-how-num mr-num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="mr-how-label">{t(key)}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
