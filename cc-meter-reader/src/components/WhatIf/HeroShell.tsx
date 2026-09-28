// src/components/WhatIf/HeroShell.tsx — the Receipt's hero card as the What-if uses it (P2-W08): the same frame
// and perforated edge (Receipt.css .mr-hero-frame / .mr-hero), the "Saved by Cribl …" label, the display figure
// held still (a preview or a run rate never ticks here), a caption and the receipt bar. The projection passes
// its PROJECTION pill; the applied state (Applied.tsx) passes none, since its figure is real.

import { useId, type CSSProperties, type ReactNode } from 'react';
import { figureEm } from '../Meter/meterMath.ts';
import '../Meter/Meter.css';
import '../../views/Receipt/Receipt.css';

export interface HeroShellProps {
  label: string;
  /** The display figure, formatted ("$119,593"); absent → the caption stands alone (no run rate yet). */
  figure?: string;
  pill?: string;
  caption: ReactNode;
  captionTestId?: string;
  bar?: ReactNode;
  testId: string;
  variant: 'projection' | 'live';
}

export function HeroShell({ label, figure, pill, caption, captionTestId, bar, testId, variant }: HeroShellProps) {
  const headingId = useId();
  return (
    <div className="mr-hero-frame mr-whatif-heroframe">
      <div className="mr-hero-shadow" aria-hidden="true" />
      <section className={`mr-panel mr-hero mr-hero--whatif mr-hero--${variant}`} aria-labelledby={headingId} data-testid={testId}>
        <div className="mr-hero-head">
          <div className="mr-hero-id">
            <h3 id={headingId} className="mr-hero-label">
              {label}
            </h3>
            {pill ? (
              <span className="mr-whatif-pill" data-testid="projection-pill">
                {pill}
              </span>
            ) : null}
          </div>
        </div>
        {figure !== undefined ? (
          <div className="mr-hero-number">
            <span className="mr-meter mr-meter--hero">
              <span className="mr-meter-figure" style={{ '--mr-meter-em': String(figureEm(figure, 0)) } as CSSProperties} data-testid={`${testId}-value`}>
                <span className="mr-meter-whole mr-meter-text">{figure}</span>
              </span>
            </span>
          </div>
        ) : null}
        <p className="mr-hero-caption mr-whatif-hero-caption" data-testid={captionTestId}>
          {caption}
        </p>
        {bar ? <div className="mr-hero-bar">{bar}</div> : null}
      </section>
    </div>
  );
}
