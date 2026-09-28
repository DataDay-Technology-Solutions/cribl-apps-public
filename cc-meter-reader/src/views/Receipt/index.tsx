// src/views/Receipt/index.tsx — the Receipt view (`/`, the default landing; PRD 8.1, DESIGN_BRIEF 5.1).
//
//   1. Hero (12 col): Saved by Cribl + MTD · Today · 30 days · Annualized · Custom (?period= / ?range=), the
//      ticking Meter, its basis caption, the receipt bar, net / payback, How this number is made, Show the math,
//      Copy receipt, Report card (/report, carrying ?period / ?range)
//   2. Unpriced notice (when any destination has no price)
//   3. Saved over the last 30 days (8) · What's saving the most (4)
//   4. Where the money goes (8) · Alerts (4)
//   390 px: one column in the same order.
//
// A custom range (core/range.ts) replaces the hero's figures with Σ saved over the rollup rows in the window, read
// through the action surface (useRange.ts); the trend, the cards and the Ledger keep their own periods. Sample
// data has no rollup history: a ?range= in the URL then falls back to the period, and Custom is disabled.
// ?vs= (P2-W13) compares the range with the previous period, the same window a week earlier or the time before a
// commit in the snapshot's change timeline: planned in core (planComparison), read second, shown beside the meter
// (CompareStrip.tsx), and copied as a receipt of both windows.
//
// States: skeleton while hydrating; "waiting for the first sweep" once hydrated with no snapshot — a ghost of
// this very layout with one sentence in the hero (BEAUTY F14); a 401 / 403 / 429 / 5xx on the snapshot shows
// inline above the same ghost (everything on this page comes from the snapshot, so the 403 copy claims nothing
// else works), with the ghost's sentence chosen by the failure and a 429 counting down to the next sweep;
// sample data renders the same view under the shell's sample band.
//
// Landing period: ?period= wins; else a workspace metering for under a day opens on the annualized run rate
// (P1-H08), then the settings default (MTD). Net after Cribl (core/net.ts) shows on every period when a Cribl
// cost is set, prorated to the span the period's savings were metered in.
//
// Frame (BEAUTY F7): the view renders in the Shell's <Page> (the app's one page width), with no page title of
// its own — the hero's "Saved by Cribl" is the page's h1 (DESIGN_BRIEF 5.1).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { HeadlinePeriod, Snapshot } from '../../../core/types.ts';
import { CRIBL_LIST_MC_PER_GB, impliedCostPerGbM } from '../../../core/net.ts';
import {
  commitAtMs,
  compareRanges,
  findCommit,
  formatCompareParam,
  formatRangeParam,
  planComparison,
  rangeSpanLabel,
  type CompareSpec,
  type RangeSpec,
} from '../../../core/range.ts';
import { comparisonLines, receiptTextForComparison, receiptTextForPeriod, receiptTextForRange } from '../../../core/receipt.ts';
import { DAY_MS, fromIso, isValidTimeZone, localDayKey } from '../../../core/time.ts';
import { t } from '../../copy/en.ts';
import { ErrorNotice, MeteringNotice } from '../../components/common/ErrorNotice.tsx';
import { notify } from '../../components/common/notify.tsx';
import { MathDrawer, type MathNet } from '../../components/MathDrawer/MathDrawer.tsx';
import { Page } from '../../components/Shell/Page.tsx';
import { copyText } from '../../lib/dom.ts';
import { hrefWithStickyParams, useAppParams } from '../../lib/params.ts';
import { useNowWhile } from './clock.ts';
import { shallowEqual, useActions, useAppState } from '../../state/react.tsx';
import { meteringFailure, snapshotFold } from '../../state/selectors.ts';
import { useNow } from '../../lib/ticker.ts';
import type { DataSource } from '../../state/store.ts';
import { HeroCard, type HeroRange } from './HeroCard.tsx';
import {
  bytesInPerDay,
  destinationRows,
  landingPeriod,
  mathDestinations,
  moneyDestinations,
  mtdReconciliation,
  listPriceEstimate,
  netFigures,
  openIncidents,
  periodFigures,
  PERIOD_ORDER,
  recentlyClosed,
  savedPerDayNowM,
  saverTotals,
  watchCoverage,
  weekFromRange,
  weekFromSnapshotTrend,
  statementMonths,
  statementPrices,
  type DestinationRow,
  type WeekCardData,
} from './model.ts';
import { buildHeatmap, flowsTo, heatmapWindow } from '../../../core/heatmap.ts';
import { DestinationStatement, type StatementHistory } from '../../components/DestinationStatement/index.ts';
import { goalPace, weekWindow } from '../../../core/goal.ts';
import {
  PERIOD_CAPTION,
  heroCaption,
  heroIsProjection,
  netSpanWords,
  receiptNetLine,
  rangeCaption,
  rangePreview,
  rangeRateLine,
  rangeWords,
  unavailableCaption,
} from './text.ts';
import { AlertsCard, DestinationsCard, ReceiptGhost, ReceiptSkeleton, TopSaversCard, TrendCard, UnpricedNotice, WeekCard } from './Sections.tsx';
import { useRange, type CompareRequest } from './useRange.ts';
import { entitlementLine } from '../../components/PriceTable/entitlement.ts';
import type { HeroCompare } from './CompareStrip.tsx';
import type { PickerCommit } from './RangePicker.tsx';
import { compareNames, compareNotes, refusalText } from './compareText.ts';

/** Commits the picker offers: deployed after collecting began and before the last whole minute, newest first. */
const PICKER_COMMITS = 8;
import './Receipt.css';

/**
 * This week so far (P2-W20). Live: the range reader sums Monday 00:00 → the sweep (the current bucket re-read each
 * sweep, the rest cached), then the same span a week earlier; sample data has no rollups, so the snapshot's daily
 * totals give the total and a whole-day comparison.
 */
function useWeek(
  snapshot: Snapshot,
  ranged: boolean,
  live: boolean,
  tz: string,
  collectingSinceMs: number | undefined,
  labels: Record<string, string> | undefined,
  /** The range reader exists for this source (live or the tour's sample), even before the card is seen. */
  canRange = ranged,
): WeekCardData {
  const sweepMs = fromIso(snapshot.sweepAt);
  const w = Number.isFinite(sweepMs) ? weekWindow(sweepMs, tz) : undefined;
  const fromMs = w?.startMs;
  const toMs = w?.endMs;
  const spec = useMemo<RangeSpec | undefined>(
    () => (ranged && fromMs !== undefined && toMs !== undefined ? { kind: 'absolute', fromMs, toMs } : undefined),
    [ranged, fromMs, toMs],
  );
  const cur = useRange(spec, spec !== undefined, snapshot.sweepAt);
  const figures = cur.result?.figures;
  const summedFrom = figures?.fromMs;
  const summedTo = figures?.toMs;
  const priorSpec = useMemo<RangeSpec | undefined>(
    () => (summedFrom !== undefined && summedTo !== undefined ? { kind: 'absolute', fromMs: summedFrom - 7 * DAY_MS, toMs: summedTo - 7 * DAY_MS } : undefined),
    [summedFrom, summedTo],
  );
  const prior = useRange(priorSpec, priorSpec !== undefined, undefined);
  const priorFigures = prior.result?.figures;
  const status = cur.state.status;
  // The loading line's span names today relative to now: read from the Receipt's clock, never ticking on its own.
  const nowMs = useNowWhile(false);
  return useMemo<WeekCardData>(() => {
    // The comparison waits for its own read; until then the card shows without it. The tour's sample reads the
    // rollups synthesized from its snapshot (P2-W05) and says so; without a reader, the daily totals.
    if (figures) return { ...weekFromRange(figures, priorFigures, { tz, labels, collectingSinceMs, incidents: snapshot.incidents ?? [] }), sample: !live };
    if (!canRange || (!live && status === 'error')) return weekFromSnapshotTrend(snapshot, tz, !live);
    const span = fromMs !== undefined && toMs !== undefined ? rangeSpanLabel(fromMs, toMs, tz, nowMs) : '';
    return { status: status === 'error' ? 'error' : 'loading', span, savedM: 0, sample: false };
  }, [canRange, live, snapshot, tz, figures, priorFigures, labels, collectingSinceMs, status, fromMs, toMs, nowMs]);
}

/** The statement's history: read once per opened destination (live; the tour's sample synthesizes its hours). */
function useStatementHistory(row: DestinationRow | null, ranged: boolean, sweepMs: number, tz: string): StatementHistory {
  const { readHistory } = useActions();
  const [state, setState] = useState<{ key: string; history: StatementHistory } | null>(null);
  const key = row?.key;
  useEffect(() => {
    if (!row || !ranged || !Number.isFinite(sweepMs)) return;
    let alive = true;
    const w = heatmapWindow(sweepMs);
    const months = statementMonths(sweepMs, tz);
    void readHistory(w.keys).then((r) => {
      if (!alive) return;
      if (!r.ok) {
        setState({ key: row.key, history: { status: 'error' } });
        return;
      }
      const byMonth = r.totals?.byOutputMonth ?? {};
      setState({
        key: row.key,
        history: {
          status: r.sample ? 'sample' : 'ready',
          thisMonth: byMonth[months.thisKey]?.[row.key],
          lastMonth: byMonth[months.lastKey]?.[row.key],
          heatmap: buildHeatmap(r.hours, { fromMs: w.fromMs, toMs: w.toMs, tz, include: flowsTo(row.outputId, row.groupId) }),
        },
      });
    });
    return () => {
      alive = false;
    };
    // Read once per opened destination: a sweep landing while it is open doesn't re-read.
  }, [key, ranged]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!row) return { status: 'loading' };
  if (!ranged) return { status: 'sample' };
  return state && state.key === row.key ? state.history : { status: 'loading' };
}

function ReceiptContent({ snapshot, source }: { snapshot: Snapshot; source: DataSource }) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const [params, setParams] = useAppParams();
  const view = useAppState(
    (s) => ({
      prices: s.prices,
      defaultPeriod: s.settings.headlinePeriodDefault,
      tzSetting: s.settings.displayTimezone,
      criblCost: s.settings.criblCostCentsPerMonth,
      // A cost saved from "Use this estimate" (core's Settings.criblCostEstimate, rules round 2) still reads as one.
      costIsEstimate: (s.settings as { criblCostEstimate?: true }).criblCostEstimate === true,
      labels: s.settings.humanize,
      budgets: s.settings.budgets,
      goalCents: s.settings.savingsGoalCentsPerMonth,
    }),
    shallowEqual,
  );
  const [mathOpen, setMathOpen] = useState(false);

  const tz = view.tzSetting && isValidTimeZone(view.tzSetting) ? view.tzSetting : 'UTC';
  const period: HeadlinePeriod = params.period ?? landingPeriod(snapshot, view.defaultPeriod);
  const sweepAtMs = fromIso(snapshot.sweepAt);
  const todayKey = Number.isFinite(sweepAtMs) ? localDayKey(sweepAtMs, tz) : undefined;
  const collectingSinceMs = fromIso(snapshot.collectingSince);
  const since = Number.isFinite(collectingSinceMs) ? collectingSinceMs : undefined;

  // The custom range reads live rollup history, or the tour's history synthesized from its snapshot
  // (core/sampleRollups.ts, P2-W05); a replay has none, so ?range= is ignored there.
  const live = source === 'live';
  const ranged = live || source === 'sample';
  const rangeSpec = ranged ? params.range : undefined;
  // The clock ticks the view only while a custom range shows (its planned words, a comparison's refusal read it); the
  // Receipt otherwise re-renders once a sweep, and the leaves that print the time tick themselves (P1-B05).
  const nowMs = useNowWhile(rangeSpec !== undefined);
  // Compare with… (P2-W13): only beside a range. A commit is found in the snapshot's change timeline.
  const vs: CompareSpec | undefined = rangeSpec ? params.vs : undefined;
  const meteredThrough = useAppState((s) => s.meta?.meteredThrough);
  const meteredThroughMs = meteredThrough ? fromIso(meteredThrough) : Number.NaN;
  const through = Number.isFinite(meteredThroughMs) ? meteredThroughMs : undefined;
  const timeline = snapshot.timeline;
  const vsCommit = vs?.kind === 'commit' ? findCommit(timeline ?? [], vs.hash) : undefined;
  const vsCommitAt = vsCommit ? commitAtMs(vsCommit) : undefined;
  const compareRequest: CompareRequest | undefined = useMemo(() => {
    if (!rangeSpec || !vs) return undefined;
    const commit = vsCommit && vsCommitAt !== undefined && Number.isFinite(vsCommitAt) ? { hash: vsCommit.hash, atMs: vsCommitAt } : undefined;
    return {
      key: `${formatCompareParam(vs)}@${commit?.atMs ?? ''}`,
      plan: (at: number) => planComparison(rangeSpec, vs, { nowMs: at, collectingSinceMs: since, foldedThroughMs: through, ...(commit ? { commit } : {}) }),
    };
  }, [rangeSpec, vs, vsCommit, vsCommitAt, since, through]);
  const { state: rangeState, result: rangeResult, compare: compareView, retry: retryRange } = useRange(rangeSpec, rangeSpec !== undefined, snapshot.sweepAt, compareRequest);
  const pickerCommits: PickerCommit[] = useMemo(() => {
    const out: PickerCommit[] = [];
    const seen = new Set<string>();
    for (const c of timeline ?? []) {
      const atMs = commitAtMs(c);
      if (!Number.isFinite(atMs) || seen.has(c.hash) || (since !== undefined && atMs <= since) || atMs >= sweepAtMs) continue;
      seen.add(c.hash);
      out.push({ hash: c.hash, message: c.message, atMs });
    }
    return out.sort((a, b) => b.atMs - a.atMs).slice(0, PICKER_COMMITS);
  }, [timeline, since, sweepAtMs]);

  const figures = useMemo(() => periodFigures(snapshot, period, tz), [snapshot, period, tz]);
  const allRows = useMemo(() => destinationRows(snapshot, view.prices, view.labels), [snapshot, view.prices, view.labels]);
  const rows = useMemo(() => moneyDestinations(allRows), [allRows]);
  const incidents = useMemo(() => openIncidents(snapshot), [snapshot]);
  const closed = useMemo(() => recentlyClosed(snapshot), [snapshot]);
  const inventory = useAppState((s) => s.inventory);
  const fold = useMemo(() => snapshotFold(snapshot, inventory), [snapshot, inventory]);
  const coverage = useMemo(() => watchCoverage(snapshot, view.budgets, fold), [snapshot, view.budgets, fold]);
  const caption = heroCaption(snapshot, period, tz);
  const projection = heroIsProjection(snapshot, period);
  // The hero's right column (P1-H01): every period's figure, and a day at current rates.
  const aside = useMemo(
    () => ({ periods: PERIOD_ORDER.map((p) => ({ period: p, savedM: periodFigures(snapshot, p, tz).savedM })), perDayNowM: savedPerDayNowM(snapshot) }),
    [snapshot, tz],
  );
  const totals = useMemo(() => saverTotals(snapshot, fold), [snapshot, fold]);
  // P2-W20: the goal's pace (month to date only), which prices the figures use, and this week so far.
  const goal = useMemo(
    () => goalPace({ savedMtdM: snapshot.headline.mtdM, goalCentsPerMonth: view.goalCents, sweepMs: sweepAtMs, collectingSinceMs: since, tz }),
    [snapshot.headline.mtdM, view.goalCents, sweepAtMs, since, tz],
  );
  // The week's reads wait until its card nears the viewport (WeekCard's observer).
  const [weekSeen, setWeekSeen] = useState(false);
  const onWeekVisible = useCallback(() => setWeekSeen(true), []);
  // One history read plan at a time: while the hero reads a custom range the week waits, then reads its own rows, so
  // the card has one data path whatever the hero shows (review W2: with a range or a comparison on screen it fell
  // back to the daily totals and read $1,586 "to 1:22 AM" beside $1,581 "through the last whole hour" on /). Only a
  // failed hero read leaves the week on the daily totals.
  const heroReading = rangeSpec !== undefined && rangeState.status !== 'ready';
  const weekReads = ranged && weekSeen && !heroReading;
  const week = useWeek(snapshot, weekReads, live, tz, since, view.labels, ranged && !(rangeSpec !== undefined && rangeState.status === 'error'));
  const netBreakdown = useMemo(() => netFigures(snapshot, period, view.criblCost, tz), [snapshot, period, view.criblCost, tz]);
  // No Cribl cost set: the same line at Cribl's list price on the measured ingest, labelled as an estimate, with the
  // link to enter the contract cost (usefulness review, round 2). Never stored: Settings saves only what an admin enters.
  const estimate = useMemo(
    () => (netBreakdown || view.criblCost !== undefined ? undefined : listPriceEstimate(snapshot, period, tz)),
    [netBreakdown, view.criblCost, snapshot, period, tz],
  );
  const net = useMemo(() => receiptNetLine(netBreakdown, estimate, view.costIsEstimate), [netBreakdown, estimate, view.costIsEstimate]);
  const periodWords = PERIOD_CAPTION[period]();
  // P1-F11: entitlement-billed destinations realize their share at renewal; one line says so when one carries money.
  const entitlementNote = useMemo(() => entitlementLine(snapshot, view.prices), [snapshot, view.prices]);

  // The words are known before the read (the same pure rules the reader applies), so the card can show them
  // throughout; once the rows are in, the summed window's words take over. A comparison plans its windows the
  // same way (the current one aligned when it must be), so its words show while both are read.
  const plannedCompare = rangeSpec && vs ? planComparison(rangeSpec, vs, { nowMs, collectingSinceMs: since, foldedThroughMs: through, ...(vsCommit && vsCommitAt !== undefined ? { commit: { hash: vsCommit.hash, atMs: vsCommitAt } } : {}) }) : undefined;
  const plannedSpec: RangeSpec | undefined = plannedCompare?.ok ? { kind: 'absolute', ...plannedCompare.current } : rangeSpec;
  const plannedWords = plannedSpec && !rangeResult ? rangePreview(plannedSpec, nowMs, since, tz).words : undefined;
  // A 429 (api-budget F2): when the range reads again; useRange retries by itself then.
  const rangeRetryAt = rangeState.status === 'ready' || rangeState.status === 'error' ? rangeState.retryAtMs : undefined;
  const range: HeroRange | undefined = useMemo(() => {
    if (!rangeSpec || rangeState.status === 'idle') return undefined;
    const figures = rangeResult?.figures;
    return {
      spec: rangeSpec,
      status: rangeState.status,
      figures,
      words: figures ? rangeWords(figures, tz) : (plannedWords ?? ''),
      caption: rangeResult ? rangeCaption(rangeResult.figures, rangeResult.resolved, rangeSpec, snapshot, tz) : undefined,
      rateLine: figures ? rangeRateLine(figures) : undefined,
      retryAtMs: rangeRetryAt,
      onRetry: retryRange,
      ...(vs ? { vs } : {}),
    };
  }, [rangeSpec, rangeState.status, rangeRetryAt, rangeResult, snapshot, tz, retryRange, plannedWords, vs]);

  // The comparison as the hero shows it: the baseline beside the meter, the stacked bars, what moved.
  const comparison = useMemo(
    () => (compareView?.status === 'ready' && rangeResult ? compareRanges(rangeResult.figures, compareView.baseline.figures) : undefined),
    [compareView, rangeResult],
  );
  const heroCompare: HeroCompare | undefined = (() => {
    if (!vs || !range || !compareView) return undefined;
    const plan = compareView.status === 'ready' || compareView.status === 'error' ? compareView.plan : plannedCompare?.ok ? plannedCompare : undefined;
    // The windows' length names the baseline ("the previous 7 days"): the planned windows, else the range as read,
    // else the range as it will be read (a refused comparison before its read lands has neither of the others).
    const namesWindow = plan?.current ?? rangeResult?.figures ?? (rangeSpec ? rangePreview(rangeSpec, nowMs, since, tz) : { fromMs: 0, toMs: 0 });
    const names = compareNames(vs, namesWindow);
    if (compareView.status === 'refused') return { status: 'refused', names, notice: refusalText(compareView.refusal, tz, since, nowMs) };
    if (compareView.status === 'error') {
      return {
        status: 'error',
        names,
        baselineWords: rangeWords(compareView.plan.baseline, tz),
        notice: t('meter.range.compare.failed', { name: names.name }),
        ...(compareView.retryAtMs !== undefined ? { retryAtMs: compareView.retryAtMs } : {}),
        onRetry: retryRange,
      };
    }
    if (compareView.status === 'loading' || !comparison) return { status: 'loading', names, ...(plan ? { baselineWords: rangeWords(plan.baseline, tz) } : {}) };
    return {
      status: 'ready',
      names,
      baselineWords: rangeWords(comparison.baseline, tz),
      currentWords: rangeWords(comparison.current, tz),
      comparison,
      notes: compareNotes(compareView.plan, comparison, tz),
      lines: comparisonLines(comparison, view.labels),
      ...(comparison.basis === 'none' ? { notice: t('meter.range.compare.empty', { name: names.name }) } : {}),
      ...(compareView.retryAtMs !== undefined ? { retryAtMs: compareView.retryAtMs } : {}),
    };
  })();
  const heroRange: HeroRange | undefined = range && heroCompare ? { ...range, compare: heroCompare } : range;

  // The period the bar's percentage and Show the math are a share of: the range's words while one shows, the
  // annualized caption (it names its days), else the period's own words — the same string in both places.
  const basisPeriod = range?.words ?? (period === 'annualized' ? caption : periodWords);

  // Show the math: month to date its destination rows are the month's own totals and add up to the hero (P1-F09).
  const mathPeriod = range ? 'custom' : period;
  const mathRows = useMemo(() => mathDestinations(allRows, mathPeriod), [allRows, mathPeriod]);
  const reconciliation = mathPeriod === 'mtd' ? mtdReconciliation(mathRows, figures.savedM) : undefined;
  const mathNet: MathNet | undefined = useMemo(() => {
    if (!netBreakdown) return undefined;
    const received = bytesInPerDay(snapshot);
    return {
      ...netBreakdown,
      savedM: figures.savedM,
      spanWords: netSpanWords(netBreakdown.minutes),
      impliedMcPerGb: received !== undefined ? impliedCostPerGbM(netBreakdown.monthlyCostCents, received) : undefined,
      bytesInPerDay: received,
      listMcPerGb: CRIBL_LIST_MC_PER_GB,
    };
  }, [netBreakdown, snapshot, figures.savedM]);

  // A destination's statement (P2-W25): opened from its name; on open it reads the running totals and the last
  // seven days of hour rollups once (live only).
  const [statementKey, setStatementKey] = useState<string | null>(null);
  const statementRow = statementKey ? (allRows.find((r) => r.key === statementKey) ?? null) : null;
  const statementHistory = useStatementHistory(statementRow, ranged, sweepAtMs, tz);
  const statementMonthNames = useMemo<[string, string]>(() => {
    const m = statementMonths(sweepAtMs, tz);
    const fmt = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: tz });
    return [fmt.format(new Date(m.thisStartMs)), fmt.format(new Date(m.lastStartMs))];
  }, [sweepAtMs, tz]);

  // A period clears the range and what it was compared with (or the next Custom would compare silently).
  const onPeriod = useCallback((next: HeadlinePeriod) => setParams({ period: next, range: undefined, vs: undefined }), [setParams]);
  const onApplyRange = useCallback((spec: RangeSpec, next?: CompareSpec) => setParams({ range: formatRangeParam(spec), vs: next ? formatCompareParam(next) : undefined }), [setParams]);

  const onCopy = useCallback(async () => {
    const note = entitlementNote ?? undefined;
    const text =
      heroCompare?.status === 'ready' && heroCompare.comparison
        ? receiptTextForComparison(heroCompare.comparison, {
            tz,
            nowMs: Date.now(),
            labels: view.labels,
            openIncidents: snapshot.incidents ?? [],
            baselineName: heroCompare.names.baselineRow,
            currentName: heroCompare.names.currentRow,
          })
        : range?.figures !== undefined
          ? receiptTextForRange(range.figures, { tz, nowMs: Date.now(), labels: view.labels, openIncidents: snapshot.incidents ?? [], destinations: snapshot.destinations, prices: view.prices, note })
          : receiptTextForPeriod(periodWords, snapshot, { period, tz, prices: view.prices, labels: view.labels, criblCostCentsPerMonth: view.criblCost, note });
    const ok = await copyText(text);
    if (ok) notify.success(t('receipt.copied'));
    else notify.error(t('receipt.copyFailed'));
    return ok;
  }, [heroCompare, range, periodWords, snapshot, period, tz, view.labels, view.prices, view.criblCost, entitlementNote]);

  return (
    <Page className="mr-receipt-view" data-period={range ? 'custom' : period}>
      <HeroCard
        period={period}
        onPeriod={onPeriod}
        figures={figures}
        meterLabel={`${t('meter.caption')}, ${periodWords}`}
        caption={caption}
        projection={projection}
        sweepAtMs={sweepAtMs}
        ratePerSecM={snapshot.ratePerSecM}
        net={net}
        onShowMath={() => setMathOpen(true)}
        onCopy={onCopy}
        pctBasis={t('receipt.savedPctBasis', { period: basisPeriod })}
        entitlementNote={entitlementNote}
        onReportCard={() => navigate(hrefWithStickyParams('/report', new URLSearchParams(search)))}
        attribution={snapshot.attributionSummary ?? 'route'}
        range={heroRange}
        onApplyRange={onApplyRange}
        commits={pickerCommits}
        tz={tz}
        collectingSinceMs={since}
        customDisabled={!ranged}
        customHint={ranged ? undefined : t('meter.range.sampleHint')}
        aside={aside}
        goal={range ? undefined : goal}
      />

      {live ? <MeteringNotice /> : null}

      <UnpricedNotice count={(snapshot.unpricedOutputIds ?? []).length} onSetPrices={() => navigate('/settings/prices')} />

      <div className="mr-grid mr-receipt-grid">
        <TrendCard snapshot={snapshot} todayKey={todayKey} tz={tz} />
        <TopSaversCard savers={snapshot.topSavers ?? []} totals={totals} />
        <DestinationsCard rows={rows} read={(snapshot.destinations ?? []).length} onOpen={setStatementKey} colorIds={(snapshot.destinations ?? []).map((d) => d.outputId)} />
        <AlertsCard incidents={incidents} closed={closed} coverage={coverage} tz={tz} />
        <WeekCard data={week} tz={tz} labels={view.labels} onVisible={onWeekVisible} />
      </div>

      {statementRow ? (
        <DestinationStatement
          isOpen
          onClose={() => setStatementKey(null)}
          destination={statementRow}
          months={statementMonthNames}
          budget={snapshot.destinations?.find((d) => `${d.groupId}:${d.outputId}` === statementRow.key)?.budget}
          prices={statementPrices(view.prices, statementRow.groupId, statementRow.outputId)}
          history={statementHistory}
          tz={tz}
        />
      ) : null}

      <MathDrawer
        isOpen={mathOpen}
        onClose={() => setMathOpen(false)}
        periodCaption={basisPeriod}
        figures={figures}
        destinations={mathRows}
        reconciliation={range ? undefined : reconciliation}
        net={range ? undefined : mathNet}
        criblCostSet={view.criblCost !== undefined && view.criblCost > 0}
        attribution={snapshot.attributionSummary ?? 'route'}
        sweepAtMs={sweepAtMs}
        ratePerSecM={snapshot.ratePerSecM}
        tz={tz}
        range={
          range?.figures
            ? {
                figures: range.figures,
                words: range.words,
                ...(heroCompare?.status === 'ready' && heroCompare.comparison
                  ? { compare: { comparison: heroCompare.comparison, name: heroCompare.names.name, words: heroCompare.baselineWords ?? '', notes: heroCompare.notes ?? [] } }
                  : {}),
              }
            : undefined
        }
      />
    </Page>
  );
}

export default function ReceiptView() {
  const view = useAppState(
    (s) => ({
      snapshot: s.snapshot,
      phase: s.status.hydrate.phase,
      hasHydrated: s.hasHydrated,
      error: s.errors.snapshot,
      lastOkAt: s.status.live.lastOkAt,
      // A 429 counts down to the next read (DESIGN_BRIEF §6: "Rate limited by the Leader. Next sweep in 0:42.").
      // (read only while rate limited, so the view doesn't re-render on every poll's schedule)
      nextPollAt: s.errors.snapshot?.kind === 'rate-limited' ? s.status.live.nextPollAt : undefined,
      backoffUntil: s.errors.snapshot?.kind === 'rate-limited' ? s.status.live.backoffUntil : undefined,
      source: s.source,
    }),
    shallowEqual,
  );

  // While rate limited the tab reads again every minute (src/state/live.ts), so the countdown is to that read —
  // when figures can next appear — not to the end of the five-minute backoff window.
  const nextSweepAt = view.nextPollAt !== undefined && Number.isFinite(view.nextPollAt) ? view.nextPollAt : view.backoffUntil;

  if (view.snapshot) {
    return (
      <>
        {view.error && view.error.kind !== 'not-found' && view.error.kind !== 'server' && view.error.kind !== 'network' ? (
          <Page className="mr-receipt-notice--top">
            <ErrorNotice error={view.error} section={t('receiptView.unavailableSection')} lastGoodAt={view.lastOkAt} nextSweepAt={nextSweepAt} />
          </Page>
        ) : null}
        <ReceiptContent snapshot={view.snapshot} source={view.source} />
      </>
    );
  }

  if (view.phase === 'idle' || view.phase === 'loading') return <ReceiptSkeleton />;

  if (view.error && view.error.kind !== 'not-found') {
    return (
      // No snapshot has been read, so the notice never claims "Showing the last good data" over a $— ghost: another
      // read succeeding (status.live.lastOkAt) put nothing on this page.
      <ReceiptGhost state="error" stopped="error" caption={unavailableCaption(view.error)}>
        <ErrorNotice error={view.error} section={t('receiptView.unavailableSection')} nextSweepAt={nextSweepAt} />
      </ReceiptGhost>
    );
  }

  return <WaitingGhost />;
}

/**
 * No snapshot yet. While sweeps are failing the hero says why ("Not metering: metrics access refused"), matching the
 * notice above it, instead of waiting for a sweep that cannot land; otherwise it waits for the first sweep.
 */
function WaitingGhost() {
  const now = useNow();
  const kind = useAppState((s) => meteringFailure(s, now)?.kind);
  const caption = kind ? t('receiptView.notMeteringCaption', { reason: t(`receiptView.notMeteringReason.${kind}`) }) : t('receiptView.waitingCaption');
  return (
    <ReceiptGhost state="waiting" stopped={kind ? 'failing' : undefined} caption={caption}>
      <MeteringNotice />
    </ReceiptGhost>
  );
}
