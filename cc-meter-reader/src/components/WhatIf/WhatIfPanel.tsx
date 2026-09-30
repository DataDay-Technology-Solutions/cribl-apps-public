// src/components/WhatIf/WhatIfPanel.tsx — the What-if calculator (DESIGN_BRIEF 5.9, DECISIONS D16).
//
// Pick a stream and a treatment; see before → after ($/day, $/year, ratio, GB/day), the Receipt hero it would
// produce, and the basis the math stands on (dry run → similar stream → documented range; or the member's own
// assumption). "Dry run on sample events" (live data, pack treatments) runs the treatment's pipeline over the
// Source's own sample through the Leader's documented preview API (core/adapters/preview.ts) and, when it
// measures, becomes the basis; when it cannot, it says why and the estimate keeps its basis. It is never
// faked and never runs on its own. In the demo build, "Apply for real" (behind a confirmation) runs the real
// lever, then the panel shows projected against measured (Applied.tsx).
//
// Layout (P1-J02): the controls row repeats the results grid (2fr / 1fr): Stream + Treatment over the strip,
// and in the free column the one thing that changes the basis — the drop slider for a custom treatment, the
// dry run for a pack. Show the math is a quiet disclosure with receipt lines (label ····· value, formula under).
// Motion (P1-J04): figures roll over the map's 400 ms morph (useTween.ts); reduced motion crossfades instead.

import { lazy, Suspense, useId, useRef, useState, type CSSProperties } from 'react';
import { Button, SelectField, type Key } from '@capra/core';
import { ChevronDown, ChevronRight } from '@capra/icons';
import { humanize, humanizeObjectKey, routeLabel } from '../../../core/humanize.ts';
import { GB } from '../FlowDiagram/layout.ts';
import { TREATMENT_FITS, isPackTreatment, sourceKind, type Estimate, type EstimateOk, type HeadlinePreview, type Projection } from '../../../core/whatif.ts';
import { streamLabels } from './streamLabel.ts';
import { t, type CopyKey } from '../../copy/en.ts';
import { formatBytes, formatMoney, formatPct } from '../../lib/format.ts';
import type { GroupSample } from '../../../core/adapters/preview.ts';
import { InlineNotice } from '../common/InlineNotice.tsx';
import { ReceiptBar } from '../ReceiptBar/ReceiptBar.tsx';
import { AppliedResults } from './Applied.tsx';
import { Fig } from './Fig.tsx';
import { HeroShell } from './HeroShell.tsx';
import { TreatmentTiles } from './TreatmentTiles.tsx';
import { Unclaimed } from './Unclaimed.tsx';
import { bytesFigure, joinRange, moneyFigure, pctFigure, pointsFigure, projectBar, signedBytesFigure, signedMoneyFigure, spanOf, type Figure } from './figures.ts';
import { lerpEstimate, lerpPreview, useReducedMotionCrossfade, useTweened } from './useTween.ts';
import { type TreatmentKey, type WhatIfModel } from './useWhatIf.ts';
import './WhatIf.css';

// Demo build only: the flag is tested inline so the release bundle drops the lever code and its chunk.
const ApplyForReal = import.meta.env.VITE_MR_BUILD === 'demo' ? lazy(() => import('./ApplyForReal.tsx')) : null;

export interface WhatIfPanelProps {
  model: WhatIfModel;
  humanizeOverrides?: Record<string, string>;
  /** Heading level context: the /whatif view titles the page itself, the Flow toggle does not. */
  headingId?: string;
}

/** The slider's range: 0 % to 90 % of today's bytes, in 5 % steps. */
const DROP_MAX = 90;

const treatmentLabel = (k: TreatmentKey): string => t(`whatif.treatments.${k}` as CopyKey);

function signedMoney(mc: number): string {
  return formatMoney(mc, { signed: true });
}

/** A range as exact money ("$17,506–$27,900"), for Show the math, which never rounds to "$17.5k". */
function exactMoney(e: EstimateOk, get: (p: Projection) => number): string {
  const [lo, hi] = spanOf(e, get);
  return joinRange(formatMoney(lo), formatMoney(hi)).text;
}

interface CellProps {
  id: string;
  label: string;
  /** Today's value; undefined when today is nothing at all (the after value then stands alone, tagged New). */
  before?: Figure;
  after: Figure;
  /** The unit printed after the after value when it stands alone ("/ day"). */
  afterUnit?: string;
  delta?: { f: Figure; unit?: string; tone: 'saved' | 'neutral' | 'loss' };
  callout?: string;
}

/**
 * One cell of the before → after strip, always stacked on three lines (P1-J01): before, → after, and the
 * change. A stream that saves nothing today says its new figure once — tagged New, no "$0 →", no delta.
 */
function CompareCell({ id, label, before, after, afterUnit, delta, callout }: CellProps) {
  return (
    <div className="mr-whatif-cell" data-cell={id}>
      <dt className="mr-whatif-cell-label">{label}</dt>
      <dd className="mr-whatif-cell-before">
        {before ? (
          <Fig f={before} className="mr-whatif-before" />
        ) : (
          <>
            <span className="mr-whatif-new">{t('whatif.compare.new')}</span>
            <span className="mr-visually-hidden">{` ${t('whatif.compare.newAria')}`}</span>
          </>
        )}
      </dd>
      <dd className="mr-whatif-cell-after">
        {before ? (
          <span className="mr-whatif-arrow" aria-hidden="true">
            {'→ '}
          </span>
        ) : null}
        <Fig f={after} className="mr-whatif-after" callout={callout} />
        {afterUnit ? <span className="mr-whatif-unit">{` ${afterUnit}`}</span> : null}
      </dd>
      {delta ? (
        <dd className={`mr-whatif-delta mr-whatif-delta--${delta.tone}`}>
          <Fig f={delta.f} />
          {delta.unit ? <span className="mr-whatif-unit">{` ${delta.unit}`}</span> : null}
        </dd>
      ) : null}
    </div>
  );
}

/**
 * The four cells: saved per day and per year, the savings ratio, the bytes sent per day. `e` carries the
 * figures on screen (rolling to the new estimate); `shape` is the new estimate itself, which decides the
 * layout (a New tag, the delta's tone) so a roll never flips a cell's shape half-way.
 */
function CompareStrip({ e, shape }: { e: EstimateOk; shape: EstimateOk }) {
  const c = e.current;
  const perDay = t('units.perDay');
  const perYear = t('units.perYear');
  const tone = shape.mid.deltaSavedPerDayM > 0 ? 'saved' : shape.mid.deltaSavedPerDayM < 0 ? 'loss' : 'neutral';
  // Nothing saved today: the new figure IS the change, so it is said once (the hero carries the annual delta).
  const fresh = shape.current.savedPerDayM === 0;
  const money = (get: (p: Projection) => number) => moneyFigure(...spanOf(e, get));
  const change = (get: (p: Projection) => number) => signedMoneyFigure(...spanOf(e, get));
  const [ratioLo, ratioHi] = spanOf(e, (p) => p.ratio);
  const [outLo, outHi] = spanOf(e, (p) => p.outBPerDay);
  return (
    <dl className="mr-whatif-compare" data-testid="whatif-compare">
      <CompareCell
        id="saved-day"
        label={t('whatif.compare.savedDay')}
        before={fresh ? undefined : moneyFigure(c.savedPerDayM, c.savedPerDayM)}
        after={money((p) => p.savedPerDayM)}
        afterUnit={fresh ? perDay : undefined}
        delta={fresh ? undefined : { f: change((p) => p.deltaSavedPerDayM), unit: perDay, tone }}
        callout="per-day"
      />
      <CompareCell
        id="saved-year"
        label={t('whatif.compare.savedYear')}
        before={fresh ? undefined : moneyFigure(c.savedPerYearM, c.savedPerYearM)}
        after={money((p) => p.savedPerYearM)}
        afterUnit={fresh ? perYear : undefined}
        delta={fresh ? undefined : { f: change((p) => p.deltaSavedPerYearM), unit: perYear, tone }}
      />
      <CompareCell
        id="ratio"
        label={t('whatif.compare.ratio')}
        before={pctFigure(c.ratio, c.ratio)}
        after={pctFigure(ratioLo, ratioHi)}
        delta={{ f: pointsFigure(c.ratio, ratioLo, ratioHi), tone: 'neutral' }}
      />
      <CompareCell
        id="volume"
        label={t('whatif.compare.volume')}
        before={bytesFigure(c.outBPerDay, c.outBPerDay)}
        after={bytesFigure(outLo, outHi)}
        delta={{ f: signedBytesFigure(outLo - c.outBPerDay, outHi - c.outBPerDay), unit: perDay, tone: 'neutral' }}
      />
    </dl>
  );
}

/**
 * The similar stream as the Ledger names it: its route's own name in Cribl ("Windows member servers"), else the
 * object key humanized.
 */
function similarName(fromObject: string, model: WhatIfModel, overrides?: Record<string, string>): string {
  const similar = model.similar?.fromObject === fromObject ? model.similar : null;
  if (similar && fromObject.startsWith('route:')) return routeLabel(similar.routeId, similar.routeName, overrides);
  return humanizeObjectKey(fromObject, overrides);
}

function basisSentence(e: EstimateOk, model: WhatIfModel, overrides?: Record<string, string>): string {
  const pct = typeof e.ratio === 'number' ? formatPct(e.ratio) : '';
  switch (e.basis) {
    case 'dry-run':
      return t(e.detail.dryRun?.picked ? 'whatif.basis.dry-run-sample' : 'whatif.basis.dry-run', {
        sample: e.detail.dryRun?.sampleId ?? '',
        events: e.detail.dryRun?.events ?? '—',
        inBytes: formatBytes(e.detail.dryRun?.inBytes ?? 0),
        outBytes: formatBytes(e.detail.dryRun?.outBytes ?? 0),
        pipeline: humanize(e.detail.dryRun?.pipelineId ?? '', overrides) || (e.detail.dryRun?.pipelineId ?? ''),
      });
    case 'similar':
      return t('whatif.basis.similar', { object: similarName(e.detail.fromObject ?? '', model, overrides), pct });
    case 'documented': {
      const r = e.ratio;
      const range = typeof r === 'number' ? formatPct(r) : t('whatif.range', { low: formatPct(r.min), high: formatPct(r.max) });
      return t('whatif.basis.documented', { range, source: e.detail.source ?? '' });
    }
    case 'custom':
      return t('whatif.basis.custom', { pct: formatPct((e.detail.dropPct ?? 0) / 100) });
  }
}

/** A receipt line of the math: label ····· value (and unit), the formula under it in the quiet tone. */
function MathLine({ label, formula, value, unit, saved }: { label: string; formula?: string; value: string; unit?: string; saved?: boolean }) {
  return (
    <div className={`mr-whatif-math-line${saved ? ' mr-whatif-math-line--saved' : ''}`}>
      <dt className="mr-whatif-math-label">{label}</dt>
      <dd className="mr-whatif-math-value">
        <span className="mr-num">{value}</span>
        {unit ? <span className="mr-whatif-math-unit">{unit}</span> : null}
      </dd>
      {formula ? <dd className="mr-whatif-math-formula">{formula}</dd> : null}
    </div>
  );
}

function ShowTheMath({ e, custom }: { e: EstimateOk; custom: boolean }) {
  const c = e.current;
  const perGb = (mc: number, bytes: number) => (bytes > 0 ? formatMoney((mc / bytes) * GB, { cents: true }) : formatMoney(0, { cents: true }));
  const price = c.outBPerDay > 0 ? perGb(c.paidPerDayM, c.outBPerDay) : perGb(c.whpPerDayM, c.inBPerDay);
  const whpPrice = perGb(c.whpPerDayM, c.inBPerDay);
  const shrink = custom ? formatPct((e.detail.dropPct ?? 0) / 100) : typeof e.ratio === 'number' ? formatPct(e.ratio) : t('whatif.range', { low: formatPct(e.ratio.min), high: formatPct(e.ratio.max) });
  const outText = bytesFigure(...spanOf(e, (p) => p.outBPerDay)).text;
  const savedDay = exactMoney(e, (p) => p.savedPerDayM);
  const perDay = t('units.perDay');
  return (
    <dl className="mr-whatif-math">
      <MathLine label={t('whatif.math.whp')} formula={t('whatif.math.whpLine', { volume: formatBytes(c.inBPerDay), price: whpPrice })} value={formatMoney(c.whpPerDayM)} unit={perDay} />
      <MathLine
        label={t('whatif.math.out')}
        formula={t(custom ? 'whatif.math.outDropLine' : 'whatif.math.outLine', { volume: formatBytes(custom ? c.outBPerDay : c.inBPerDay), pct: shrink })}
        value={outText}
        unit={perDay}
      />
      <MathLine label={t('whatif.math.paid')} formula={t('whatif.math.paidLine', { volume: outText, price })} value={exactMoney(e, (p) => p.paidPerDayM)} unit={perDay} />
      <MathLine label={t('whatif.math.saved')} value={savedDay} unit={perDay} saved />
      <MathLine label={t('whatif.math.perYear')} formula={t('whatif.math.perYearLine', { amount: savedDay })} value={exactMoney(e, (p) => p.savedPerYearM)} unit={t('units.perYear')} saved />
    </dl>
  );
}

/**
 * Show the math (P1-J02): the Receipt's own control — a tertiary "Show the math" button — under one rule, no
 * box inside the card; it discloses the receipt lines in place and, only where a dry run is offered or
 * measured this estimate, how a dry run works.
 */
function MathSection({ e, custom, dryRunNote }: { e: EstimateOk; custom: boolean; dryRunNote: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="mr-whatif-mathbox" data-testid="whatif-math" data-open={open ? 'true' : 'false'}>
      <Button variant="tertiary" size="sm" leadingIcon={open ? ChevronDown : ChevronRight} aria-expanded={open} aria-controls={panelId} onPress={() => setOpen((o) => !o)}>
        {t('whatif.math.title')}
      </Button>
      <div id={panelId} className="mr-whatif-mathpanel" hidden={!open}>
        {open ? (
          <>
            <ShowTheMath e={e} custom={custom} />
            {dryRunNote ? <p className="mr-whatif-note">{t('whatif.math.dryRunNote')}</p> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Dry run on sample events" as the controls row's third field (P1-J02): one secondary button — "again" once it
 * measured — and, when it is running or could not measure, a neutral inline notice across the row saying why
 * and which basis the estimate keeps (P1-J04). A measurement shows up as the basis line itself.
 */
function DryRunField({ model, keeps }: { model: WhatIfModel; keeps: 'similar' | 'documented' | 'none' }) {
  if (!model.dryRunAvailable) return null;
  const d = model.dryRun;
  const running = d.status === 'running';
  const measured = d.status === 'done' && d.result.ok;
  let note: string | null = null;
  let status: string = d.status;
  const samples = d.status === 'done' && !d.result.ok && d.result.reason === 'no-sample' ? (d.result.samples ?? []) : [];
  if (running) note = t('whatif.dryRun.running');
  else if (d.status === 'done') {
    if (d.result.ok) status = 'measured';
    else {
      status = d.result.reason;
      const r = d.result;
      const key = r.reason === 'failed' && !r.status ? 'failedNoStatus' : r.reason;
      const why = t(`whatif.dryRun.reason.${key}` as CopyKey, { status: r.status ?? t('common.dash') });
      const fallback = t(`whatif.dryRun.fallback.${keeps}` as CopyKey);
      note = fallback ? `${why} ${fallback}` : why;
    }
  }
  return (
    <div className="mr-whatif-dryrun" data-testid="whatif-dryrun" data-status={status}>
      <div className="mr-whatif-field mr-whatif-field--dryrun">
        <span className="mr-whatif-field-label">{t('whatif.dryRun.label')}</span>
        <Button variant="secondary" pending={running} disabled={running} onPress={model.runDryRun}>
          {measured ? t('whatif.dryRun.again') : t('whatif.dryRun.button')}
        </Button>
      </div>
      {note ? (
        <div className="mr-whatif-dryrun-note">
          <InlineNotice variant="inline">{note}</InlineNotice>
          {samples.length > 0 ? <SamplePicker samples={samples} model={model} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * P2-W26: a Source with no sample of its own (HEC, syslog, S3 …) — the group's samples (those its Datagen Sources
 * generate from), the ones for this kind of source first; picking one runs the dry run on it.
 */
function SamplePicker({ samples, model }: { samples: readonly GroupSample[]; model: WhatIfModel }) {
  const kind = model.stream ? sourceKind(model.stream.flow) : 'other';
  const fits = (g: GroupSample): boolean => kind !== 'other' && (sourceKind({ inputId: g.id }) === kind || g.usedBy.some((u) => sourceKind({ inputId: u }) === kind));
  const ordered = [...samples].sort((a, b) => Number(fits(b)) - Number(fits(a)));
  const items = ordered.map((g) => ({ id: g.id, label: t('whatif.dryRun.pick.item', { sample: g.id, source: humanize(g.usedBy[0] ?? '') || (g.usedBy[0] ?? '') }) }));
  return (
    <div className="mr-whatif-samplepick" data-testid="whatif-sample-picker">
      <SelectField label={t('whatif.dryRun.pick.label')} placeholder={t('whatif.dryRun.pick.placeholder')} items={items} value={null} onChange={(k: Key | null) => k !== null && model.runDryRunOn(String(k))} />
    </div>
  );
}

/**
 * The custom treatment's drop, 0–90 % of today's bytes (P1-J02). Capra has no Slider (docs/platform/capra.md
 * §2), so it is drawn from Capra's track and indicator tokens — a 4 px track filled to the value and a round
 * thumb — the same in every browser, with the native range input laid over it, transparent, for keyboard,
 * pointer and screen readers. Its ends are captioned so the scale reads without dragging.
 */
function DropSlider({ model }: { model: WhatIfModel }) {
  const pct = model.dropPct;
  const fill = Math.min(1, Math.max(0, pct / DROP_MAX));
  return (
    <div className="mr-whatif-field mr-whatif-field--drop">
      <label className="mr-whatif-drop-label" htmlFor="mr-whatif-drop">
        {t('whatif.drop', { pct: formatPct(pct / 100) })}
      </label>
      <div className="mr-whatif-range" style={{ '--mr-range-fill': String(fill) } as CSSProperties}>
        <input
          id="mr-whatif-drop"
          className="mr-whatif-range-input"
          type="range"
          min={0}
          max={DROP_MAX}
          step={5}
          value={pct}
          aria-label={t('whatif.dropAria')}
          aria-valuetext={formatPct(pct / 100)}
          onChange={(e) => model.setDrop(Number(e.target.value))}
          data-testid="whatif-drop"
        />
        <span className="mr-whatif-range-track" aria-hidden="true" data-testid="whatif-drop-track">
          <span className="mr-whatif-range-indicator" />
        </span>
        <span className="mr-whatif-range-thumb" aria-hidden="true" data-testid="whatif-drop-thumb" />
      </div>
      <div className="mr-whatif-range-ends" aria-hidden="true">
        <span>{formatPct(0)}</span>
        <span>{formatPct(DROP_MAX / 100)}</span>
      </div>
    </div>
  );
}

/**
 * The Receipt hero this change would produce (P2-W08): the Receipt's own hero card — perforated edge, "Saved by
 * Cribl" label, the display figure — marked PROJECTION, held still (a preview never ticks), and its receipt bar
 * extended: grey paid, green saved today, and the part the change would add hatched and dashed at the end of
 * the green. Its caption is one phrase per line (P1-J04).
 */
function Hero({ preview, range, noRunRateM, bar }: { preview: HeadlinePreview; range: boolean; noRunRateM: number; bar: WhatIfModel['heroBar'] }) {
  const p = useTweened(preview, lerpPreview);
  // The bar takes the new figures at once (its segments ease by CSS): a legend whose amounts rolled would change
  // length mid-roll, wrap, and move the page — and the Flow map fitted under it — while the figure rolls.
  // Founder-build r2 ui-7 (IC-2): the bar rests on the figure's own basis — today's rates, the strip's — so the hero,
  // its bar and the strip read one saved share; the Receipt's run rate only when nothing is priced at current rates.
  const base = preview.basis === 'current' ? preview.bar : bar;
  const projected = base && preview.hasBasis ? projectBar(base, preview.deltaM) : null;
  return (
    <HeroShell
      variant="projection"
      testId="whatif-hero"
      label={t('whatif.hero.label')}
      pill={t('flow.projectionChip')}
      {...(p.hasBasis ? { figure: formatMoney(p.afterM) } : {})}
      captionTestId={p.hasBasis ? 'whatif-hero-caption' : undefined}
      caption={
        p.hasBasis ? (
          <>
            <span className="mr-whatif-hero-line">{t(p.basis === 'current' ? 'whatif.hero.captionCurrent' : 'whatif.hero.caption', { delta: signedMoney(p.deltaM) })}</span>{' '}
            <span className="mr-whatif-hero-line mr-whatif-hero-from">{t('whatif.hero.from', { amount: formatMoney(p.beforeM) })}</span>
            {range ? (
              <>
                {' '}
                <span className="mr-whatif-hero-line mr-whatif-hero-from">{t('whatif.hero.midpoint')}</span>
              </>
            ) : null}
          </>
        ) : (
          t('whatif.hero.noRunRate', { amount: formatMoney(noRunRateM) })
        )
      }
      bar={
        projected ? (
          <ReceiptBar whpM={projected.whpM} paidM={projected.paidM} savedM={projected.savedM} ratio={projected.ratio} projection={{ deltaM: projected.addM }} />
        ) : undefined
      }
    />
  );
}

function Results({ e, model, overrides }: { e: EstimateOk; model: WhatIfModel; overrides?: Record<string, string> }) {
  const shown = useTweened(e, lerpEstimate);
  const ref = useRef<HTMLDivElement>(null);
  // Reduced motion: a new stream, treatment, drop or basis crossfades the strip and the hero instead of rolling.
  useReducedMotionCrossfade(ref, `${model.stream?.key ?? ''}|${model.treatmentKey}|${model.dropPct}|${e.basis}`);
  return (
    <div className="mr-whatif-results" data-testid="whatif-results" ref={ref}>
      <div className="mr-whatif-compare-wrap">
        <h2 className="mr-whatif-subhead">{t('whatif.compare.title')}</h2>
        <CompareStrip e={shown} shape={e} />
        {e.mid.deltaSavedPerDayM < 0 ? <p className="mr-whatif-note">{t('whatif.savesLess')}</p> : null}
        <p className="mr-whatif-basis" data-testid="whatif-basis" data-basis={e.basis}>
          <span className="mr-whatif-basis-tag">{t(`whatif.basisLabel.${e.basis}` as CopyKey)}</span>
          <span>{basisSentence(e, model, overrides)}</span>
        </p>
      </div>
      {model.preview ? <Hero preview={model.preview} range={e.range} noRunRateM={e.mid.savedPerYearM} bar={model.heroBar} /> : null}
    </div>
  );
}

/** "Windows event sources": what a pack is written for (P1-F13). */
function fitsText(k: TreatmentKey): string {
  return isPackTreatment(k) ? t(`whatif.fits.${TREATMENT_FITS[k]}` as CopyKey) : '';
}

/**
 * A pack on a source it is not written for (P1-F13): says so, projects nothing, and offers the treatment that
 * does fit this source (when one does) or a custom drop.
 */
function NotApplicable({ model, streamName }: { model: WhatIfModel; streamName: string }) {
  const suggested = model.stream?.suggested;
  return (
    <div className="mr-whatif-empty mr-whatif-notfit" data-testid="whatif-not-applicable">
      <p className="mr-whatif-empty-title">{t('whatif.notApplicable.title', { treatment: treatmentLabel(model.treatmentKey), stream: streamName })}</p>
      <p>{t('whatif.notApplicable.body', { fits: fitsText(model.treatmentKey) })}</p>
      <div className="mr-whatif-notfit-actions">
        {suggested && suggested !== model.treatmentKey ? (
          <Button variant="secondary" size="sm" onPress={() => model.setTreatment(suggested)}>
            {t('whatif.notApplicable.trySuggested', { treatment: treatmentLabel(suggested) })}
          </Button>
        ) : null}
        <Button variant="tertiary" size="sm" onPress={() => model.setTreatment('custom')}>
          {t('whatif.notApplicable.tryCustom')}
        </Button>
      </div>
    </div>
  );
}

function NoEstimate({ e, model, streamName }: { e: Estimate; model: WhatIfModel; streamName: string }) {
  if (e.ok) return null;
  if (e.reason === 'not-applicable') return <NotApplicable model={model} streamName={streamName} />;
  if (e.reason === 'no-traffic') return <p className="mr-whatif-empty">{t('whatif.noTraffic')}</p>;
  return (
    <div className="mr-whatif-empty" data-testid="whatif-no-basis">
      <p className="mr-whatif-empty-title">{t('whatif.noBasisTitle', { treatment: treatmentLabel(model.treatmentKey) })}</p>
      <p>{t('whatif.noBasisBody')}</p>
    </div>
  );
}

export function WhatIfPanel({ model, humanizeOverrides, headingId }: WhatIfPanelProps) {
  const { streams, stream, estimate } = model;
  if (!stream) {
    return (
      <section className="mr-whatif" aria-labelledby={headingId}>
        <p className="mr-whatif-empty">{t('whatif.noStreams')}</p>
      </section>
    );
  }
  const labels = streamLabels(streams, humanizeOverrides);
  const streamItems = streams.map((s) => ({ id: s.key, label: labels.get(s.key) ?? s.flow.inputId }));
  const custom = model.treatmentKey === 'custom';
  const applied = model.appliedAt !== undefined;
  const ok = estimate && estimate.ok ? estimate : null;
  const keeps = ok && (ok.basis === 'similar' || ok.basis === 'documented') ? ok.basis : 'none';

  return (
    <section className="mr-whatif" aria-labelledby={headingId} data-testid="whatif-panel" data-state={applied ? 'applied' : 'projection'}>
      <Unclaimed model={model} humanizeOverrides={humanizeOverrides} />
      {/* Same 2fr / 1fr grid as the results below: Stream + Treatment span the before/after strip; the free
          column holds the drop slider (custom) or the dry run (a pack), over the hero preview (F25, P1-J02).
          The treatment's help sits under the fields, and a dry run's outcome under that (grid areas). */}
      <div className="mr-whatif-controls">
        <div className="mr-whatif-controls-main">
          <div className="mr-whatif-field mr-whatif-field--stream" data-testid="whatif-stream">
            <SelectField label={t('whatif.stream')} items={streamItems} value={stream.key} onChange={(k: Key | null) => k !== null && model.setStream(String(k))} />
          </div>
        </div>
        {custom ? <DropSlider model={model} /> : <DryRunField model={model} keeps={keeps} />}
        {/* P2-W23: the treatment as tiles — each with its range, what it does, and whether it fits this stream. */}
        <TreatmentTiles model={model} />
      </div>

      {applied ? (
        <AppliedResults model={model} />
      ) : model.alreadyRuns ? (
        // Row 2b: a Pack attached alone that is only part of the treatment says which pack it runs, never "this treatment".
        <p className="mr-whatif-empty" data-testid="whatif-already" data-runs={model.runsPackId ? 'pack' : 'treatment'}>
          {model.runsPackId
            ? t('whatif.alreadyRunsPack', {
                pack: humanize(`pack:${model.runsPackId}`, humanizeOverrides).replace(/ pack$/, ''),
                pct: formatPct(stream.flow.inBPerDay > 0 ? 1 - stream.flow.outBPerDay / stream.flow.inBPerDay : 0),
              })
            : t('whatif.alreadyRuns', { pct: formatPct(stream.flow.inBPerDay > 0 ? 1 - stream.flow.outBPerDay / stream.flow.inBPerDay : 0) })}
        </p>
      ) : ok ? (
        <>
          <Results e={ok} model={model} overrides={humanizeOverrides} />
          <div className="mr-whatif-foot">
            <p className="mr-whatif-note">{t('whatif.projectionNote')}</p>
            {ApplyForReal && !custom ? (
              <Suspense fallback={null}>
                <ApplyForReal model={model} />
              </Suspense>
            ) : null}
          </div>
          <MathSection e={ok} custom={custom} dryRunNote={model.dryRunAvailable || ok.basis === 'dry-run'} />
        </>
      ) : estimate ? (
        <NoEstimate e={estimate} model={model} streamName={streamItems.find((i) => i.id === stream.key)?.label ?? stream.flow.inputId} />
      ) : null}
    </section>
  );
}
