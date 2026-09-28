// src/views/Demo/ProjectorPanel.tsx — "On the projector" (EPIC_AUDIT P2-W18, day-2 slice): a live thumbnail of
// the presenter view at the head of the laptop console's main column, so whoever holds the remote reads what
// the room reads without looking up. The phone keeps its one-line "Projector: $… · no alert" strip instead.
//
// A 16:9 miniature of the stage (src/views/Presenter, DESIGN_BRIEF 5.2), laid out in the stage's own pixels
// (1920 × 1080) and scaled to the panel's width with container units: the wordmark and live dot, "Saved by
// Cribl" with the stage's own Meter (the same figure, period and basis as the presenter), the top
// savers as receipt lines, the QR in its corner, the scene indicator, and — while the stage's takeover would be
// up — the incident card over the lower half. Text never drops below a readable size, so the miniature is a
// faithful schematic rather than a pixel copy. It is a model of the stage (src/demo/derive.ts
// `stageTakeover`), not a probe of another tab, and the caption under it says what the stage is doing.
//
// For assistive tech the frame is one image with a sentence: the figure, its basis and the stage's state.

import { useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Play } from '@capra/icons';
import type { HeadlinePeriod, Settings, Snapshot } from '../../../core/types.ts';
import { fmtDollars, fmtDuration } from '../../../core/format.ts';
import { displayAuthor } from '../../../core/humanize.ts';
import { DEFAULT_QR_URL } from '../../../core/settings.ts';
import { t } from '../../copy/en.ts';
import { formatClock } from '../../lib/format.ts';
import { Meter } from '../../components/Meter/index.ts';
import { targetAt } from '../../components/Meter/meterMath.ts';
import { figureBudget, periodFigure } from '../Presenter/heroValue.ts';
import { periodBasis } from '../Presenter/basis.ts';
import { TREND_H, TREND_W, trendPaths } from '../Presenter/trend.ts';
import { restTrendDays } from '../Presenter/trend.ts';
import { saverDrops, stageSaverLabels } from '../Presenter/savers.ts';
import { QrBlock } from '../../components/QrBlock/index.ts';
import {
  SeverityGlyph,
  impactText,
  incidentMeasure,
  incidentTitle,
  incidentTone,
  recoveryMeasure,
  recoveryText,
  shortHash,
} from '../../components/IncidentCard/index.ts';
import { sceneText } from '../../components/SceneIndicator/sceneText.ts';
import { isSceneAbandoned, type PersistedScene } from '../../demo/scenes.ts';
import type { NextAlert, StageTakeover } from '../../demo/derive.ts';
import { EtaLine, type AlertEta } from './panels.tsx';
// The odometer, the figure's type and the scene indicator's styles live with the stage (the Presenter chunk is
// lazy, so the console loads them itself).
import '../Presenter/Presenter.css';

const WIDE = '(min-width: 641px)';

/** The laptop console (not the phone, whose strip says the same in one line). */
function useWide(): boolean {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches;
  const [wide, setWide] = useState(get);
  useLayoutEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

function MiniTakeover({ takeover, labels, tz }: { takeover: StageTakeover; labels: Record<string, string>; tz?: string }) {
  const { incident, mode } = takeover;
  const recovery = mode === 'recovery';
  const tone = recovery ? 'recovered' : incidentTone(incident);
  const measure = recovery ? undefined : incidentMeasure(incident, tz);
  const back = recovery ? recoveryMeasure(incident, undefined, tz) : undefined;
  const from = measure ? measure.before : back?.from;
  const to = measure ? measure.after : back?.to;
  return (
    <div className="mr-demo-stage-takeover" data-mode={mode} data-tone={tone} data-testid="demo-stage-takeover">
      <p className="mr-demo-stage-tk-band">
        <SeverityGlyph tone={tone} size="sm" />
        <span className="mr-demo-stage-tk-title">{recovery ? recoveryText(incident) : incidentTitle(incident, labels)}</span>
      </p>
      {from || to ? (
        <p className="mr-demo-stage-tk-ratio mr-num">
          {/* Spaces between the flex items keep the text readable ("75% → 50%"); flex does not lay them out. */}
          {from ? <span>{from}</span> : null}
          {from && to ? <> <span className="mr-demo-stage-tk-arrow">→</span> </> : null}
          {to ? <span className={recovery ? 'mr-demo-stage-tk-saved' : 'mr-demo-stage-tk-worse'}>{to}</span> : null}
        </p>
      ) : null}
      {recovery ? null : <p className="mr-demo-stage-tk-money mr-num">{impactText(incident)}</p>}
      {/* The card's foot: how fast it was caught, and the commit that did it. */}
      {!recovery && (incident.caughtInSec !== undefined || incident.commit) ? (
        <p className="mr-demo-stage-tk-foot mr-num">
          {[
            incident.caughtInSec !== undefined ? t('incidents.caughtIn', { duration: fmtDuration(incident.caughtInSec) }) : undefined,
            incident.commit ? shortHash(incident.commit.hash) : undefined,
            incident.commit ? displayAuthor(incident.commit.author) : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The stage's rest band at thumbnail scale (P2-W04, review W2): the month's receipt bar (paid grey, saved green, the
 * whole bar would-have-paid) and the completed days' savings line, where the stage draws them when no card is up.
 */
function MiniRest({ snapshot, tz }: { snapshot: Snapshot; tz: string | undefined }) {
  const h = snapshot.headline;
  const paths = trendPaths(restTrendDays(snapshot, tz));
  const paidPct = h.whpMtdM > 0 ? Math.min(100, Math.max(0, (h.paidMtdM / h.whpMtdM) * 100)) : 0;
  return (
    <div className="mr-demo-stage-rest" data-testid="demo-stage-rest" aria-hidden="true">
      {h.whpMtdM > 0 ? (
        <div className="mr-demo-stage-bar">
          <span className="mr-demo-stage-bar-paid" style={{ width: `${paidPct}%` }} />
          <span className="mr-demo-stage-bar-saved" style={{ width: `${100 - paidPct}%` }} />
        </div>
      ) : null}
      {paths ? (
        <svg className="mr-demo-stage-trend" viewBox={`0 0 ${TREND_W} ${TREND_H}`} preserveAspectRatio="none">
          <path className="mr-pv-trend-area" d={paths.area} />
          <path className="mr-pv-trend-line" d={paths.line} vectorEffect="non-scaling-stroke" />
        </svg>
      ) : null}
    </div>
  );
}

export interface ProjectorPanelProps {
  snapshot: Snapshot | null;
  settings: Settings;
  scene: PersistedScene | undefined;
  takeover: StageTakeover | undefined;
  next: NextAlert | undefined;
  eta: AlertEta;
  nowMs: number;
}

export function ProjectorPanel({ snapshot, settings, scene, takeover, next, eta, nowMs }: ProjectorPanelProps) {
  const wide = useWide();
  const period: HeadlinePeriod = settings.presenter?.headlinePeriod ?? 'annualized';
  const headline = snapshot?.headline ?? null;
  const figure = useMemo(() => periodFigure(headline, period), [headline, period]);
  if (!wide) return null;

  const labels = settings.humanize ?? {};
  const tz = settings.displayTimezone;
  const basis = periodBasis(period, headline);
  const anchorMs = snapshot ? Date.parse(snapshot.sweepAt) : Number.NaN;
  const savers = (snapshot?.topSavers ?? []).filter((s) => s.savedPerDayM > 0).slice(0, 5);
  // The stage's own names (the pipeline, else the route), so the miniature reads as the stage does.
  const saverNames = stageSaverLabels(savers, labels);
  // W3-STAGE-1: the drop an open regression takes off the saver it names, as the stage shows it (beside the figure).
  const drops = saverDrops(savers, snapshot?.incidents);
  const qrUrl = settings.presenter?.qrUrl?.trim() || DEFAULT_QR_URL;
  const open = (snapshot?.incidents ?? []).some((i) => !i.closedAt);
  const sceneLine = scene && !isSceneAbandoned(scene, nowMs) ? sceneText(scene, nowMs) : undefined;

  // What the stage is doing, in one line under the frame.
  let state: ReactNode;
  let stateText: string;
  if (takeover) {
    const left = formatClock(Math.ceil(takeover.leftMs / 1000));
    stateText = takeover.mode === 'alert' ? t('demo.onStage.takeover', { left }) : t('demo.onStage.recovery', { left });
    state = stateText;
  } else if (open) {
    stateText = t('demo.onStage.alertOpen');
    state = stateText;
  } else if (next) {
    // The countdown to it is the big clock right under this panel.
    stateText = t('demo.onStage.quiet');
    state = <span className="mr-demo-stagepanel-quiet">{stateText}</span>;
  } else {
    stateText = t('demo.onStage.quiet');
    state = (
      <>
        <span className="mr-demo-stagepanel-quiet">{stateText}</span>
        <span aria-hidden="true"> · </span>
        <EtaLine eta={eta} testId="demo-stage-eta" />
      </>
    );
  }
  const amount = snapshot
    ? fmtDollars(targetAt({ valueM: figure.valueM, ratePerSecM: figure.accrue ? snapshot.ratePerSecM : 0, anchorMs }, nowMs))
    : t('presenter.emptyFigure');

  return (
    <section
      className="mr-demo-panel mr-demo-stagepanel"
      aria-labelledby="mr-demo-stage-title"
      data-testid="demo-projector-panel"
      data-takeover={takeover?.mode}
      data-alert={open ? 'true' : undefined}
    >
      <div className="mr-demo-stagepanel-head">
        <h2 className="mr-demo-group-title" id="mr-demo-stage-title">
          {t('demo.onStage.title')}
        </h2>
        <span className="mr-type-caption">{t('demo.onStage.caption')}</span>
      </div>

      {/* Dark, as the stage always is (P1-A07): Capra's `dark` class re-themes the miniature's subtree. */}
      <div
        className="mr-demo-stage dark"
        role="img"
        aria-label={t('demo.onStage.aria', { amount, basis, state: stateText })}
        data-testid="demo-stage"
      >
        <div className="mr-demo-stage-top">
          <span className="mr-demo-stage-wordmark">{t('app.name')}</span>
          <span className="mr-demo-stage-live">
            <span className="mr-demo-stage-live-dot" />
            {t('presenter.live')}
          </span>
        </div>
        <div className="mr-demo-stage-hero">
          <p className="mr-demo-stage-label">{t('meter.caption')}</p>
          {snapshot ? (
            // The stage's own figure: the shared Meter on the presenter's period, rolling to each sweep's value.
            // Hidden from assistive tech (its live region would announce twice); the frame's label says it.
            <p className="mr-pv-figure mr-num" style={{ '--mr-hero-chars': String(figureBudget(headline)) } as CSSProperties} aria-hidden="true">
              <Meter
                key={period}
                valueM={figure.valueM}
                ratePerSecM={figure.accrue ? snapshot.ratePerSecM : 0}
                anchorMs={anchorMs}
                label={t('presenter.heroMeterLabel', { period: basis })}
                size="inherit"
                rollStatic
                callout="projector"
              />
            </p>
          ) : (
            <p className="mr-pv-figure mr-pv-figure--empty">{t('presenter.emptyFigure')}</p>
          )}
          <p className="mr-demo-stage-caption">{snapshot ? basis : t('presenter.waiting')}</p>
        </div>
        <div className="mr-demo-stage-savers">
          <p className="mr-demo-stage-label">{t('presenter.topSavers')}</p>
          {savers.length > 0 ? (
            <ol className="mr-demo-stage-list">
              {savers.map((s, i) => {
                const drop = drops.get(s.objectKey);
                const perDay = drop !== undefined ? fmtDollars(drop) : '';
                return (
                  <li key={s.objectKey} className="mr-demo-stage-item" data-drop-m={drop}>
                    <span className="mr-demo-stage-item-label">{saverNames[i]}</span>
                    <span className="mr-demo-stage-leader" />
                    {drop !== undefined ? (
                      <span className="mr-demo-stage-drop mr-num" title={t('presenter.saverDropTitle', { perDay })}>
                        {t('presenter.saverDrop', { perDay })}
                      </span>
                    ) : null}
                    <span className="mr-demo-stage-item-amount mr-num">{fmtDollars(s.savedPerDayM)}</span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="mr-demo-stage-caption">{t('presenter.topSaversEmpty')}</p>
          )}
        </div>
        {snapshot && !takeover ? <MiniRest snapshot={snapshot} tz={tz} /> : null}
        <div className="mr-demo-stage-scene">
          {sceneLine ? (
            <>
              <Play size="sm" aria-hidden="true" />
              <span>{sceneLine}</span>
            </>
          ) : null}
        </div>
        <div className="mr-demo-stage-qr">
          <QrBlock url={qrUrl} showUrl={false} callout="projector-qr" />
        </div>
        {takeover ? <MiniTakeover takeover={takeover} labels={labels} {...(tz ? { tz } : {})} /> : null}
      </div>

      <p className="mr-demo-stagepanel-state mr-demo-tnum" data-testid="demo-stage-state">
        {state}
      </p>
    </section>
  );
}
