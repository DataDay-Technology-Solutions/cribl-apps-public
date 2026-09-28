// src/components/WhatIf/LandedCard.tsx — the good-news takeover (P2-W06): "flip it on, watch it land".
//
// The stage takes over for the break; with this it also takes over, in saved green, when a change the room
// watched being applied lands. It is the incident takeover's own card (the .mr-takeover classes of
// IncidentTakeover.css, the same band, sizes and 450 ms slide-up), in the recovery's green:
//
//   ✓ Savings improved: Windows workstations                         Press any key to dismiss  ×
//   0% → 33%              +$1,340 a day · +$489,100 a year                           (callout per-day)
//   savings ratio
//                         7c2d410 "demo: apply the pack on …" · s.koelpin     (callouts commit, author)
//                         [route]  Landed 4:57:20 PM
//   ──────────────────────────────────────────────────────────────────────────────────────────────────
//   [What-if]  Projected 30%–35%, measured 33% after 3 min
//
// The forecast line comes from the What-if apply that forecast it (landing.ts forecastFor); without one the foot
// says how long it took to land after the deploy instead. Mounted by IncidentTakeover for a 'landed' event
// (tracker.ts), which only exists when landedAllowed(settings).

import { useEffect, useId, useRef } from 'react';
import { IconButton } from '@capra/core';
import { ClockOutlined, CloseOutlined, GitAlt } from '@capra/icons';
import type { Incident } from '../../../core/types.ts';
import { fmtDuration, perYear } from '../../../core/format.ts';
import { t } from '../../copy/en.ts';
import { commitAuthor } from '../../lib/author.ts';
import { prefersReducedMotion } from '../../lib/dom.ts';
import { formatMoney, formatPct } from '../../lib/format.ts';
import { renderTemplate, useIncidentContext } from '../IncidentCard/context.tsx';
import { formatClockTime, incidentMeasure, incidentTitle, objectKindWord, shortHash } from '../IncidentCard/model.ts';
import { SeverityGlyph } from '../IncidentCard/SeverityGlyph.tsx';
import { MoneyLine, TAKEOVER_ENTER_MS, TAKEOVER_FADE_MS } from '../IncidentTakeover/TakeoverCard.tsx';
import { forecastFor, minutesToLand, type AppliedForecast } from './landing.ts';
import './Landed.css';

const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';

export interface LandedCardProps {
  incident: Incident;
  /** The forecast to print; defaults to the What-if apply that matches the incident (landing.ts). */
  forecast?: AppliedForecast | null;
  onDismiss?: () => void;
  placement?: 'overlay' | 'inline';
  animate?: boolean;
  tz?: string;
  labels?: Record<string, string>;
}

/** "30–35%" or "33%": the projected ratio as the What-if showed it. */
function projectedText(p: { min: number; max: number }): string {
  const lo = formatPct(p.min);
  const hi = formatPct(p.max);
  return lo === hi ? lo : t('whatif.range', { low: lo, high: hi });
}

export function LandedCard(props: LandedCardProps) {
  const { incident, onDismiss, placement = 'overlay' } = props;
  const animate = props.animate ?? placement === 'overlay';
  const ctx = useIncidentContext();
  const tz = props.tz ?? ctx.tz;
  const labels = props.labels ?? ctx.labels;
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);
  const forecast = props.forecast === undefined ? forecastFor(incident) : (props.forecast ?? undefined);

  // The takeover's own entrance: 450 ms ease-out slide up; reduced motion → a 200 ms fade.
  useEffect(() => {
    const el = ref.current;
    if (!animate || !el || typeof el.animate !== 'function') return;
    const anim = prefersReducedMotion()
      ? el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: TAKEOVER_FADE_MS, easing: 'ease-out' })
      : el.animate([{ transform: 'translateY(calc(100% + 64px))' }, { transform: 'translateY(0)' }], { duration: TAKEOVER_ENTER_MS, easing: EASE_OUT });
    return () => anim.cancel();
  }, [animate, incident.id]);

  const measure = incidentMeasure(incident, tz);
  const impact = Math.max(0, incident.impactPerDayM ?? 0);
  const openedMs = Date.parse(incident.openedAt);
  const measuredText = measure.after ?? formatPct(incident.after);

  return (
    <section
      ref={ref}
      className={`mr-takeover mr-takeover--${placement} mr-takeover--landed mr-takeover--recovered`}
      role="status"
      aria-labelledby={titleId}
      data-incident-id={incident.id}
      data-mode="landed"
      data-testid="landed-takeover"
    >
      <header className="mr-tk-head">
        <SeverityGlyph tone="recovered" size="lg" />
        <h2 id={titleId} className="mr-tk-title mr-tk-title--recovery">
          {incidentTitle(incident, labels)}
        </h2>
        {onDismiss ? (
          <div className="mr-tk-dismiss">
            <span className="mr-tk-hint">{t('incidents.dismissHint')}</span>
            <IconButton icon={CloseOutlined} aria-label={t('incidents.dismiss')} variant="tertiary" appearance="neutral" size="md" onPress={onDismiss} />
          </div>
        ) : null}
      </header>

      <div className="mr-tk-body">
        <div className="mr-tk-ratio">
          <p className="mr-tk-ratio-row mr-num" data-testid="landed-ratio">
            <span className="mr-tk-before">{measure.before}</span>
            <span className="mr-tk-arrow" aria-hidden="true">
              →
            </span>
            <span className="mr-visually-hidden"> {t('incidents.arrow')} </span>
            <span className="mr-tk-after mr-tk-after--saved">{measuredText}</span>
          </p>
          <p className="mr-tk-caption">{measure.caption}</p>
        </div>
        <div className="mr-tk-detail">
          {/* The title already names the stream (the alert card's layout, one line shorter), so the money leads. */}
          <p className="mr-tk-money mr-landed-money" data-callout="per-day" data-testid="landed-money">
            {/* The red card's own money line: whole parts, the separator hanging before each (review W2: the template's
                bare text nodes became gapped flex items, "+$1,340   a day ·   +$489,100   a year"). */}
            <MoneyLine
              template={t('incidents.perDayPerYear')}
              nodes={{
                perDay: <span className="mr-num">{formatMoney(impact, { signed: true })}</span>,
                perYear: <span className="mr-num">{formatMoney(perYear(impact), { signed: true })}</span>,
              }}
            />
          </p>
          {incident.commit ? (
            <p className="mr-tk-commit">
              <GitAlt size="md" aria-hidden="true" />
              <span className="mr-tk-commit-text">
                {renderTemplate(t('incidents.commitShort'), {
                  hash: (
                    <code className="mr-tk-hash" data-callout="commit">
                      {shortHash(incident.commit.hash)}
                    </code>
                  ),
                  message: <span className="mr-tk-message">{incident.commit.message}</span>,
                  author: (
                    <span className="mr-tk-author" data-callout="author">
                      {commitAuthor(incident.commit.author, labels)}
                    </span>
                  ),
                })}
              </span>
            </p>
          ) : null}
          <p className="mr-tk-cause">
            <span className="mr-tk-chip">{objectKindWord(incident.objectKey)}</span>
            {Number.isFinite(openedMs) ? <span className="mr-tk-when">{t('whatif.landed.at', { time: formatClockTime(openedMs, tz, true) })}</span> : null}
          </p>
        </div>
      </div>

      <footer className="mr-tk-foot">
        {forecast ? (
          <p className="mr-tk-caught mr-landed-forecast" data-testid="landed-forecast">
            <span className="mr-tk-chip mr-landed-chip">{t('whatif.landed.chip')}</span>
            <span className="mr-tk-caught-text">
              {renderTemplate(t('whatif.projectedVsActual'), {
                projected: <span className="mr-num">{projectedText(forecast.projected)}</span>,
                measured: <span className="mr-num mr-landed-measured">{measuredText}</span>,
                minutes: <span className="mr-num">{minutesToLand(forecast, incident)}</span>,
              })}
            </span>
          </p>
        ) : incident.caughtInSec !== undefined ? (
          <p className="mr-tk-caught" data-testid="landed-in">
            <ClockOutlined size="lg" aria-hidden="true" />
            <span className="mr-tk-caught-text">
              {renderTemplate(t('whatif.landed.in'), { duration: <span className="mr-num mr-tk-clock">{fmtDuration(incident.caughtInSec)}</span> })}
            </span>
          </p>
        ) : null}
      </footer>
    </section>
  );
}
