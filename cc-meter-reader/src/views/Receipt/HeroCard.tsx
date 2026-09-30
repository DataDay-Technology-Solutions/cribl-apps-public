// src/views/Receipt/HeroCard.tsx — the Receipt hero (DESIGN_BRIEF 5.1 item 1): "Saved by Cribl" + the period
// toggle (MTD · Today · 30 days · Annualized · Custom, the last opening the range picker), Show the math + Copy
// receipt, the ticking Meter, its basis caption, the receipt bar, the optional net line, and the "How this number
// is made" disclosure (the four steps, then how the bytes are measured — DECISIONS D20 — and how they are priced).
// The card's bottom edge is perforated; HeroFrame gives the torn shape the app's one card elevation (a box-shadow
// can't follow the teeth).
//
// With a custom range active (core/range.ts) the big number is the range's Σ saved — a closed window, so the
// meter holds still — the label carries the window in words, the caption says how exact the sum is, a rate line
// says what a day at that pace is worth, and the number is never annualized. While the rows are being read the
// card keeps the finished layout's shape as static ghost blocks (the number, the words, the caption, the bar), so
// nothing moves when the figures land; the words are known before the read, so they show throughout. A failed
// read is an inline notice with Retry, under the words, no wider than a sentence. A 429 from the Leader (api-budget
// F2) is not a failure to retry by hand: with figures on screen they stay and the caption says when they update;
// with none yet the notice says when the range reads again, and offers no Retry into the limit.
//
// Compare with… (P2-W13, CompareStrip.tsx): with ?vs= the card also shows the baseline beside the meter (A → B and
// the signed change), the receipt bar becomes two stacked bars on one scale, and the pipelines that moved most
// follow them. The meter remounts for a comparison (its aligned window may sum less than the plain range, and a
// meter never visibly runs backwards).

import { useId, useState, type ReactNode } from 'react';
import { Button } from '@capra/core';
import { ChevronRight, CopyOutlined, FileLines } from '@capra/icons';
import type { Attribution, HeadlinePeriod } from '../../../core/types.ts';
import { formatRangeParam, type CompareSpec, type RangeFigures, type RangeSpec } from '../../../core/range.ts';
import { formatLocalTime, fromIso } from '../../../core/time.ts';
import { t, type CopyKey } from '../../copy/en.ts';
import { InlineNotice } from '../../components/common/InlineNotice.tsx';
import { HowItWorks } from '../../components/HowItWorks/HowItWorks.tsx';
import { Meter } from '../../components/Meter/Meter.tsx';
import { useReducedMotion } from '../../components/Meter/useReducedMotion.ts';
import { shallowEqual, useAppState } from '../../state/react.tsx';
import { headlineSplit } from '../../../core/snapshot.ts';
import { priceBasisSummary } from '../../../core/receipt.ts';
import { ReceiptBar, type ReceiptBarNet } from '../../components/ReceiptBar/ReceiptBar.tsx';
import { ReceiptList, type ReceiptLine } from '../../components/ReceiptList/ReceiptList.tsx';
import { formatMoney, formatMoneyNeverZero } from '../../lib/format.ts';
import { prefersReducedMotion } from '../../lib/dom.ts';
import type { GoalPace } from '../../../core/goal.ts';
import { formatLocalMonthDay } from '../../../core/time.ts';
import { asideWholeM, type PeriodFigures } from './model.ts';
import { RangeControl, type PickerCommit } from './RangePicker.tsx';
import { CompareBars, CompareFigure, CompareMovers, type HeroCompare } from './CompareStrip.tsx';

/** How the bytes behind the figures are measured, per snapshot.attributionSummary (DECISIONS D20). */
const MEASURED_KEYS: Record<Attribution, CopyKey> = {
  reconciled: 'receiptView.howMeasured.reconciled',
  route: 'receiptView.howMeasured.route',
  pipeline: 'receiptView.howMeasured.pipeline',
  proportional: 'receiptView.howMeasured.proportional',
  'route-only': 'receiptView.howMeasured.routeOnly',
};

/**
 * The hero's frame: a static layer under the card carries the perforated card's shadow as a drop-shadow (which
 * follows the torn edge), so the ticking figure above it never re-rasterizes a filter.
 */
export function HeroFrame({ children }: { children: ReactNode }) {
  return (
    <div className="mr-hero-frame">
      <div className="mr-hero-shadow" aria-hidden="true" />
      {children}
    </div>
  );
}

/** A custom range on the hero: what to show for it right now. */
export interface HeroRange {
  spec: RangeSpec;
  status: 'loading' | 'ready' | 'error';
  /** The latest sum (kept while a refresh is in flight). */
  figures?: RangeFigures;
  /** "Sep 26, 10:00 AM–2:00 PM (4 h)" — the summed window, or the planned one while it is being read. */
  words: string;
  /** "minute-exact · collecting since 9:41 PM" */
  caption?: string;
  /** "≈ $1,240 a day at this rate" */
  rateLine?: string;
  /** The Leader answered 429: the range is read again at this instant (useRange retries by itself). */
  retryAtMs?: number;
  onRetry: () => void;
  /** ?vs= — what the range is compared with, and the comparison as it stands (P2-W13). */
  vs?: CompareSpec;
  compare?: HeroCompare;
}

export interface HeroCardProps {
  period: HeadlinePeriod;
  onPeriod: (period: HeadlinePeriod) => void;
  figures: PeriodFigures;
  /** Accessible name of the meter: "Saved by Cribl, month to date". */
  meterLabel: string;
  /** "month to date · collecting since 9:41 PM" */
  caption: string;
  /** The figure is a projection from under a day of traffic: a Projection pill leads the caption. */
  projection?: boolean;
  sweepAtMs: number;
  ratePerSecM: number;
  net: ReceiptBarNet | null;
  onShowMath: () => void;
  /** Copies the receipt; resolves true when it landed on the clipboard (the tear-off plays then). */
  onCopy: () => Promise<boolean> | void;
  copyDisabled?: boolean;
  /** What the bar's "% saved" is a share of ("of dollars, month to date"): its hover, the same words as Show the math. */
  pctBasis?: string;
  /** P1-F11: "Splunk Cloud is billed as a prepaid entitlement: …" under the bar, when such a destination carries money. */
  entitlementNote?: string | null;
  /** Opens the Report card view (/report) for the period on screen. */
  onReportCard?: () => void;
  /** snapshot.attributionSummary — picks the "where the bytes come from" line. */
  attribution?: Attribution;
  /** The active custom range, when one shows instead of the period. */
  range?: HeroRange;
  onApplyRange: (spec: RangeSpec, vs?: CompareSpec) => void;
  /** Recent commits the picker offers to compare before and after (the snapshot's change timeline). */
  commits?: readonly PickerCommit[];
  /** Display timezone (the picker's inputs, the range's words). */
  tz: string;
  /** A fixed clock for the range picker (tests); omitted, the picker reads the live one when it opens. */
  nowMs?: number;
  /** When collecting began (the picker's preview clips to it). */
  collectingSinceMs?: number;
  /** Sample data: the Custom item is disabled and the hint shows under the toggle. */
  customDisabled?: boolean;
  customHint?: string;
  /** The right column at >= 1024 px (P1-H01): every period as a receipt line, and a day at current rates. */
  aside?: HeroAside;
  /** A savings goal's pace (P2-W20): the strip under the caption on month to date, its room kept on the other periods. */
  goal?: GoalPace;
  /** Force the reduced-motion path (tests); default follows `prefers-reduced-motion`, as the Meter does. */
  reducedMotion?: boolean;
}

/**
 * The pace toward the monthly savings goal (P2-W20, core/goal.ts): a thin strip on one scale — saved so far
 * (filled), the rest of the month at the month-to-date rate (dashed: projected), a rule at the goal — and one
 * line in words, in the money green when the month clears the goal, the warning colour when it falls short.
 */
function GoalStrip({ pace, tz, reserved }: { pace: GoalPace; tz: string; reserved?: boolean }) {
  const end = pace.projectedM ?? pace.savedM;
  const scale = Math.max(pace.goalM, end, 1) * 1.08;
  const pct = (m: number) => `${Math.min(100, Math.max(0, (m / scale) * 100)).toFixed(2)}%`;
  const state = pace.onPace === undefined ? 'early' : pace.onPace ? 'ahead' : 'behind';
  // r3 ui-4 (H6): never "$0" for a real figure on a sub-dollar workspace ("< $1", D82).
  const money = (m: number) => formatMoneyNeverZero(m);
  const words =
    state === 'early'
      ? t('receiptView.goal.early', { goal: money(pace.goalM) })
      : t(`receiptView.goal.${state}`, {
          projected: money(pace.projectedM ?? 0),
          date: formatLocalMonthDay(pace.lastDayMs, tz),
          goal: money(pace.goalM),
          gap: money(Math.abs(pace.gapM ?? 0)),
        });
  return (
    <div
      className="mr-hero-goal"
      data-testid="goal-pace"
      data-state={state}
      data-reserved={reserved ? 'true' : undefined}
      role={reserved ? undefined : 'group'}
      aria-label={reserved ? undefined : t('receiptView.goal.label')}
      aria-hidden={reserved ? true : undefined}
    >
      <div className="mr-hero-goal-track" aria-hidden="true">
        <span className="mr-hero-goal-saved" style={{ width: pct(pace.savedM) }} />
        {pace.projectedM !== undefined && pace.projectedM > pace.savedM ? (
          <span className="mr-hero-goal-proj" style={{ left: pct(pace.savedM), width: pct(pace.projectedM - pace.savedM) }} />
        ) : null}
        <span className="mr-hero-goal-rule" style={{ left: pct(pace.goalM) }}>
          <span className="mr-hero-goal-tick">{t('receiptView.goal.tick')}</span>
        </span>
      </div>
      <p className="mr-hero-goal-words">{words}</p>
    </div>
  );
}

export interface HeroAside {
  periods: { period: HeadlinePeriod; savedM: number }[];
  /** Saved per day at current rates (the Top savers' basis). */
  perDayNowM: number;
}

const ASIDE_LABEL: Record<HeadlinePeriod, CopyKey> = {
  mtd: 'receiptView.aside.mtd',
  today: 'receiptView.aside.today',
  '30d': 'receiptView.aside.30d',
  annualized: 'receiptView.aside.annualized',
};

/**
 * The hero's right column (P1-H01): the OTHER periods beside the big number (all four while a custom range
 * shows), so the toggle reads as focus and the card's right half holds figures instead of air. Each is a receipt
 * line that switches to it, in whole dollars as the Meter's wheels show them (floored, so the line never reads a
 * dollar ahead of the number it becomes). Under a dotted rule, what a day saves at current rates. Hidden under
 * 1024 px, where the toggle is the control.
 */
function HeroAsideList({
  aside,
  period,
  rangeActive,
  onPeriod,
  ticking,
}: {
  aside: HeroAside;
  period: HeadlinePeriod;
  rangeActive: boolean;
  onPeriod: (p: HeadlinePeriod) => void;
  /** Whether a meter showing an accruing period would tick (motion allowed, a rate): the aside floors only then. */
  ticking: boolean;
}) {
  const lines: ReceiptLine[] = aside.periods
    .filter(({ period: p }) => rangeActive || p !== period)
    .map(({ period: p, savedM }) => {
      const words = t(ASIDE_LABEL[p]);
      // Founder-build r2 ui-8 (BO-7): what the meter prints for that period — floored like its wheels while it ticks,
      // half up when it is static (reduced motion, a rate of 0, the run rate: r1 ui-8 m12).
      // r2 core-10 (IC-4, handoff): real savings under a dollar print '< $1' (fmtDollars), never "$0".
      const roundedM = asideWholeM(p, savedM, ticking);
      const wholeM = roundedM === 0 && savedM > 0 ? savedM : roundedM;
      const amount = formatMoney(wholeM) + (p === 'annualized' ? ` ${t('units.perYear')}` : '');
      return {
        id: p,
        label: words,
        amountM: wholeM,
        per: p === 'annualized' ? 'year' : undefined,
        onPress: () => onPeriod(p),
        hrefLabel: t('receiptView.aside.show', { period: words, amount }),
        testId: `hero-aside-${p}`,
      };
    });
  return (
    <div className="mr-hero-aside" data-testid="hero-aside" role="group" aria-label={t('receiptView.aside.label')}>
      <ReceiptList lines={lines} ariaLabel={t('receiptView.aside.label')} />
      <ReceiptList
        className="mr-hero-aside-now"
        lines={[{ id: 'now', label: t('receiptView.aside.now'), amountM: aside.perDayNowM, per: 'day', muted: true, testId: 'hero-aside-now' }]}
        ariaLabel={t('receiptView.aside.nowLabel')}
      />
    </div>
  );
}

/*
 * While a range's rows are read, each slot of the finished layout (number, caption, bar) shows a static ghost of
 * the same height in the same DOM order, so nothing moves when the figures land (DESIGN_BRIEF §6).
 */
function NumberSkeleton() {
  return (
    <div className="mr-hero-number" aria-busy="true">
      <span className="mr-skel mr-skel--range mr-skel--hero" data-testid="range-loading" aria-label={t('meter.range.loading')} role="status" />
    </div>
  );
}
function CaptionSkeleton() {
  return (
    <p className="mr-hero-caption mr-hero-caption--skel" aria-hidden="true">
      <span className="mr-skel mr-skel--range mr-skel--line" style={{ width: 260 }} />
      {/* On a phone the rate takes a second line (Receipt.css), so the ghost does too. */}
      <span className="mr-skel mr-skel--range mr-skel--line mr-skel--rate" style={{ width: 180 }} />
    </p>
  );
}
function BarSkeleton() {
  return (
    <div className="mr-hero-bar mr-hero-bar--skel" aria-hidden="true">
      <span className="mr-skel mr-skel--range mr-skel--line mr-skel--whp" style={{ width: 200 }} />
      <span className="mr-skel mr-skel--range mr-skel--track" />
      <span className="mr-skel mr-skel--range mr-skel--line" style={{ width: '40%' }} />
    </div>
  );
}

export function HeroCard(props: HeroCardProps) {
  const { period, onPeriod, figures, meterLabel, caption, projection, sweepAtMs, ratePerSecM, net, onShowMath, onCopy, copyDisabled, pctBasis, onReportCard, attribution = 'route' } = props;
  const { range, onApplyRange, commits, tz, nowMs, collectingSinceMs, customDisabled, customHint, aside, goal } = props;
  const reduced = useReducedMotion(props.reducedMotion);
  const [howOpen, setHowOpen] = useState(false);
  // The period the page landed on: only its figure rolls up on first paint (P2-W19).
  const [landedPeriod] = useState(period);
  // Copy receipt tears a strip off along the perforation (P2-W25): a keyed element, so every copy plays it afresh.
  const [tear, setTear] = useState(0);
  const copy = async () => {
    const ok = await onCopy();
    if (ok && !prefersReducedMotion()) setTear((n) => n + 1);
  };
  const howId = useId();
  const headingId = useId();
  const hintId = useId();

  const rangeFigures = range?.figures;
  const showRange = range !== undefined;
  const rangeLoading = showRange && !rangeFigures && range.status === 'loading';
  const rangeFailed = showRange && !rangeFigures && range.status === 'error';
  const retryAt = showRange && range.retryAtMs !== undefined && Number.isFinite(range.retryAtMs) ? range.retryAtMs : undefined;
  // The sweep's cursor: the picker plans the same hybrid read the reader will (core/range.ts planRangeReads).
  const meteredThrough = useAppState((s) => s.meta?.meteredThrough);
  const meteredThroughMs = meteredThrough ? fromIso(meteredThrough) : undefined;
  // r3 ui-5 (H9): the sweep's minute retention, so the picker plans the read the reader will make.
  const minuteRetentionHours = useAppState((s) => s.meta?.minuteRetentionHours);
  const barFigures = showRange ? rangeFigures : figures;
  // P1-F02 (loaned from WP-H): month to date splits bytes dropped from diversion credits exactly (per-destination
  // month totals); the other periods and a range have no exact split, so their bar keeps one saved segment.
  const split = useAppState((s) => headlineSplit(s.snapshot), shallowEqual);
  const hasSplit = split !== undefined && split.divertedM > 0;
  // P1-F10 (loaned from WP-H): whether the dollars rest on the member's own rates or on typical list prices.
  const priced = useAppState((s) => priceBasisSummary(s.snapshot, s.prices), shallowEqual);
  const shownCaption = showRange ? (range.caption ?? '') : caption;
  const showHint = Boolean(customDisabled && customHint);
  const compare = showRange ? range.compare : undefined;
  const compareKey = showRange && range.vs ? (range.vs.kind === 'commit' ? range.vs.hash : range.vs.kind) : undefined;
  const cmp = compare?.comparison;
  // Two stacked bars once the comparison has figures on a basis; the single receipt bar otherwise.
  const stacked = compare?.status === 'ready' && cmp !== undefined && cmp.basis !== 'none';

  return (
    <HeroFrame>
      <section
        className="mr-panel mr-hero"
        aria-labelledby={headingId}
        data-testid="receipt-hero"
        data-range={showRange ? formatRangeParam(range.spec) : undefined}
        data-range-status={showRange ? range.status : undefined}
        data-range-from={rangeFigures ? new Date(rangeFigures.fromMs).toISOString() : undefined}
        data-range-to={rangeFigures ? new Date(rangeFigures.toMs).toISOString() : undefined}
        data-range-granularity={rangeFigures?.granularity}
        data-range-retry-at={retryAt}
        data-compare={compare ? compareKey : undefined}
        data-compare-status={compare?.status}
        data-compare-basis={cmp?.basis}
        data-compare-from={cmp ? new Date(cmp.baseline.fromMs).toISOString() : undefined}
        data-compare-to={cmp ? new Date(cmp.baseline.toMs).toISOString() : undefined}
        data-compare-granularity={cmp?.baseline.granularity}
      >
        <div className="mr-hero-head">
          <div className="mr-hero-id">
            <h1 id={headingId} className="mr-hero-label">
              {t('receiptView.heroLabel')}
            </h1>
            {priced ? (
              <span
                className="mr-hero-price-basis"
                data-testid="hero-price-basis"
                data-basis={priced.kind}
                title={
                  priced.kind === 'contract'
                    ? t('receiptView.priceBasis.contractHint')
                    : t('receiptView.priceBasis.presetHint', { custom: priced.custom, total: priced.total })
                }
              >
                {t(priced.kind === 'contract' ? 'receiptView.priceBasis.contract' : 'receiptView.priceBasis.preset')}
              </span>
            ) : null}
            <RangeControl
              period={period}
              range={range?.spec}
              onPeriod={onPeriod}
              onApplyRange={onApplyRange}
              vs={range?.vs}
              commits={commits}
              tz={tz}
              nowMs={nowMs}
              collectingSinceMs={collectingSinceMs}
              meteredThroughMs={meteredThroughMs !== undefined && Number.isFinite(meteredThroughMs) ? meteredThroughMs : undefined}
              minuteRetentionHours={minuteRetentionHours}
              customDisabled={customDisabled}
              customHintId={showHint ? hintId : undefined}
            />
          </div>
          {showHint ? (
            <p id={hintId} className="mr-hero-toggle-hint" data-testid="range-hint">
              {customHint}
            </p>
          ) : null}
        </div>

        <div className="mr-hero-actions">
          <Button variant="tertiary" size="sm" onPress={onShowMath}>
            {t('sections.math')}
          </Button>
          <Button variant="secondary" size="sm" leadingIcon={CopyOutlined} onPress={() => void copy()} disabled={copyDisabled || rangeLoading || rangeFailed || compare?.status === 'loading'}>
            {t('receipt.copy')}
          </Button>
          {onReportCard ? (
            <Button variant="secondary" size="sm" leadingIcon={FileLines} onPress={onReportCard}>
              {t('receipt.reportCard')}
            </Button>
          ) : null}
        </div>

        {rangeLoading ? (
          <NumberSkeleton />
        ) : (
          <div className="mr-hero-number">
            {rangeFailed ? (
              <span className="mr-hero-dash" aria-hidden="true">
                ${t('common.dash')}
              </span>
            ) : showRange && rangeFigures ? (
              <Meter
                key={`${formatRangeParam(range.spec)}|${compareKey ?? ''}`}
                valueM={rangeFigures.savedM}
                ratePerSecM={0}
                anchorMs={sweepAtMs}
                label={`${t('meter.caption')}, ${range.words}`}
                size="hero"
              />
            ) : (
              // One meter across the ticking periods (P1-H09): switching MTD → Today rolls the digits from one figure
              // to the other instead of cutting in one frame. The run rate is a static meter (whole dollars, no
              // cents), so it gets its own.
              <Meter
                key={figures.accrues ? 'accrues' : 'static'}
                valueM={figures.savedM}
                ratePerSecM={figures.accrues ? ratePerSecM : 0}
                anchorMs={sweepAtMs}
                label={meterLabel}
                size="hero"
                // First paint rolls up from $0, once per page (P2-W19), for the period the page landed on only: a
                // period switch eases from wherever the wheels are. data-value-m says the figure from frame one.
                rollIn={period === landedPeriod ? 'receipt-hero' : undefined}
                rollInValue="target"
                reducedMotion={props.reducedMotion}
              />
            )}
          </div>
        )}

        {aside ? <HeroAsideList aside={aside} period={period} rangeActive={showRange} onPeriod={onPeriod} ticking={!reduced && ratePerSecM > 0} /> : null}

        {showRange ? (
          <p className="mr-hero-range-words" data-testid="hero-range-words">
            {range.words}
          </p>
        ) : null}

        {rangeFailed && retryAt !== undefined ? (
          <div className="mr-hero-caption" data-testid="hero-caption" data-state="range-rate-limited">
            <InlineNotice variant="inline" data-testid="range-rate-limited">
              {t('meter.range.rateLimited', { time: formatLocalTime(retryAt, tz) })}
            </InlineNotice>
          </div>
        ) : rangeFailed ? (
          <div className="mr-hero-caption" data-testid="hero-caption" data-state="range-error">
            <InlineNotice variant="inline" action={{ label: t('meter.range.retry'), onClick: range.onRetry }} data-testid="range-error">
              {t('meter.range.failed')}
            </InlineNotice>
          </div>
        ) : rangeLoading ? (
          <CaptionSkeleton />
        ) : (
          // The caption, then which prices the figures use as a quiet pill beside it (P2-W20). The caption's words are
          // keyed by what they describe, so a period switch crossfades them in while the digits roll (P1-H09).
          <div className="mr-hero-caption-row">
            {projection && !showRange ? (
              <span className="mr-hero-projection" data-testid="hero-projection">
                {t('receiptView.projectionPill')}
              </span>
            ) : null}
            <p className="mr-hero-caption" data-testid="hero-caption" key={showRange ? 'range' : period}>
              {shownCaption}
              {showRange && range.rateLine ? (
                <span className="mr-hero-rate-wrap">
                  <span className="mr-hero-rate-sep" aria-hidden="true">
                    {' · '}
                  </span>
                  <span className="mr-hero-rate" data-testid="hero-rate">
                    {range.rateLine}
                  </span>
                </span>
              ) : null}
              {showRange && retryAt !== undefined ? (
                <span className="mr-hero-held" data-testid="range-held">
                  <span className="mr-hero-held-sep" aria-hidden="true">
                    {' · '}
                  </span>
                  {t('meter.range.held', { time: formatLocalTime(retryAt, tz) })}
                </span>
              ) : null}
            </p>
          </div>
        )}

        {/* Month to date only; on the other periods its room is kept (unseen), so the hero's height never changes as
            the periods toggle (the P1-F12 rule). */}
        {goal && !showRange ? <GoalStrip pace={goal} tz={tz} reserved={period !== 'mtd'} /> : null}
        {compare ? <CompareFigure compare={compare} tz={tz} /> : null}

        {rangeLoading ? (
          <BarSkeleton />
        ) : stacked && compare ? (
          <div className="mr-hero-bar">
            <CompareBars compare={compare} />
            <CompareMovers compare={compare} />
          </div>
        ) : (
          <div className="mr-hero-bar">
            {barFigures ? (
              <ReceiptBar
                whpM={barFigures.whpM}
                paidM={barFigures.paidM}
                savedM={barFigures.savedM}
                ratio={barFigures.ratio}
                net={showRange ? null : net}
                basis={pctBasis}
                divertedM={showRange || period !== 'mtd' ? undefined : split?.divertedM}
                reserveSplit={!showRange && hasSplit}
              />
            ) : (
              <span className="mr-hero-ghostbar" aria-hidden="true" />
            )}
            {barFigures && props.entitlementNote ? (
              <p className="mr-hero-entitlement" data-testid="entitlement-note">
                {props.entitlementNote}
              </p>
            ) : null}
          </div>
        )}

        <div className="mr-hero-how">
          <button
            type="button"
            className="mr-hero-how-toggle"
            aria-expanded={howOpen}
            aria-controls={howId}
            onClick={() => setHowOpen((o) => !o)}
          >
            <span className="mr-hero-how-chevron" data-open={howOpen ? 'true' : 'false'} aria-hidden="true">
              <ChevronRight size="sm" />
            </span>
            {t('receiptView.howToggle')}
          </button>
          {/* The panel reveals rather than pops (P1-H09): its row eases from 0fr to 1fr with a fade, and while shut it
              is inert, so nothing inside it takes focus. Show the math lives once, in the hero's actions (P1-H04). */}
          <div id={howId} className="mr-hero-how-panel" data-open={howOpen ? 'true' : 'false'} inert={!howOpen} data-testid="how-panel">
            <div className="mr-hero-how-clip">
              <div className="mr-hero-how-content">
                <HowItWorks variant="strip" />
                <div className="mr-hero-how-notes" data-testid="how-measured">
                  <p className="mr-hero-how-note">
                    <span className="mr-hero-how-note-title">{t('receiptView.howMeasuredTitle')}</span>{' '}
                    {t(MEASURED_KEYS[attribution] ?? MEASURED_KEYS.route)}
                  </p>
                  <p className="mr-hero-how-note">{t('receiptView.howPriced')}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      {tear > 0 ? (
        <div className="mr-hero-tear" key={tear} data-testid="hero-tear" aria-hidden="true" onAnimationEnd={() => setTear(0)}>
          <span className="mr-hero-tear-label">{showRange ? `${t('meter.caption')}, ${range.words}` : meterLabel}</span>
          <span className="mr-hero-tear-leader" />
          <span className="mr-hero-tear-amount mr-num">{formatMoney((showRange ? rangeFigures?.savedM : figures.savedM) ?? 0)}</span>
        </div>
      ) : null}
    </HeroFrame>
  );
}
