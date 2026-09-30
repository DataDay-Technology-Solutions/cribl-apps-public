// src/views/Ledger/index.tsx — the admin view (PRD 8.3, DESIGN_BRIEF 5.4, SPEC 13, SPEC 17).
//
//   header      title, one-line purpose, freshness
//   flows card  toolbar (search '/', status, destination, worker group) → virtualized table (LedgerTable)
//   lower row   Change timeline (ratio + commit diamonds) · Alerts rail (right on desktop, below on phones)
//
// View state is the URL (params.ts). ?object=<ObjectKey> scrolls to and highlights the flow; clicking a row,
// an alert's "Show in table" or a "what moved" line sets it. Every state is designed: loading skeleton,
// no data yet (a ghost of the table), filtered to zero, deep link hidden by filters / not in the sweep, read errors.
//
// Flows with no traffic in the last hour fold into ONE summary row under the table by default ("7 flows with
// no traffic in the last hour · Show", ?quiet=show), so the table is the flows that carry money (BEAUTY F11).
// A deep-linked flow is never folded away, the "No traffic" status filter lists exactly those flows, and a
// workspace where every flow is quiet lists them all rather than an empty table.
//
// Frame (BEAUTY F7): the Shell's <Page> — the app's one page width and title row; from 1600 px the Ledger alone
// widens to 1440 px so its table uses the canvas (P1-K01, Ledger.css).

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ButtonLink, Skeleton } from '@capra/core';
import { commitImpacts, type CommitImpact } from '../../../core/commitImpacts.ts';
import { rangeDuration } from '../../../core/range.ts';
import { commitTimeMs, filesTouchObject } from '../../../core/timeline.ts';
import { ChangeTimeline, ChangesList, type LinkedFlow } from '../../components/ChangeTimeline/index.ts';
import { reversals } from '../../components/ChangeTimeline/money.ts';
import { EmptyBlock } from '../../components/common/EmptyBlock.tsx';
import { ErrorNotice } from '../../components/common/ErrorNotice.tsx';
import { InlineNotice } from '../../components/common/InlineNotice.tsx';
import { Page } from '../../components/Shell/Page.tsx';
import { IncidentsRail } from '../../components/IncidentsRail/index.ts';
import {
  LedgerTable,
  buildRows,
  destinationOptions,
  filterRows,
  groupOptions,
  hasActiveFilters,
  objectLabel,
  partitionQuiet,
  primaryObjectKey,
  rowsForObject,
  sortRows,
  statusCounts,
  totals,
  unlistedWindow,
  withWindow,
  type LedgerRow,
} from '../../components/LedgerTable/index.ts';
import { t, tn } from '../../copy/en.ts';
import { formatInt, formatMoney } from '../../lib/format.ts';
import { useAppParams } from '../../lib/params.ts';
import { useAppState } from '../../state/react.tsx';
import { isOtherFlow, snapshotFold } from '../../state/selectors.ts';
import { rangeWords } from '../Receipt/text.ts';
import { useRange } from '../Receipt/useRange.ts';
import { useLedgerParams } from './params.ts';
import { MoneyStrip } from './MoneyStrip.tsx';
import { ratioDayDelta } from './strip.ts';
import { Toolbar } from './Toolbar.tsx';
import { useViewZone } from '../Receipt/useViewZone.ts';
import './Ledger.css';

const URL_DEBOUNCE_MS = 250;

/** "7 days" / "4 h" / "90 min": the window's length, the money columns' unit under a range (P2-W14). */
function windowUnitOf(fromMs: number, toMs: number): string {
  const d = rangeDuration(fromMs, toMs);
  if (d.unit === 'minutes') return t('meter.range.durationMinutes', { n: d.value });
  if (d.unit === 'hours') return t('meter.range.durationHours', { n: d.value });
  return tn('meter.range.durationDays', d.count, { n: d.value });
}

/** Does this commit name, move or touch this flow? (The table ↔ timeline link, P2-W17.) */
function commitTouchesRow(impact: CommitImpact, row: LedgerRow): boolean {
  if (impact.moved.some((m) => row.objectKeys.includes(m.key))) return true;
  return row.objectKeys.some((k) => (k.startsWith('pipe:') || k.startsWith('route:')) && filesTouchObject(impact.commit.files ?? [], k, row.pipelineId) === 'object');
}

/** The view zone when it is valid, else UTC (the day keys of the 7-day trend follow it). */
function validZone(tz: string | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** The skeleton table: a header line, then rows at the table's own 48 px pitch (widths vary so they don't look stamped). */
const SKELETON_ROWS = ['100%', '92%', '97%', '88%', '95%', '90%', '84%', '93%'];

/**
 * The loading skeleton is the finished page's frame (P1-K06, DESIGN_BRIEF 6 "skeleton matching final layout"): the
 * flows card (toolbar, header, rows, totals) and the lower row (the change timeline 2fr beside the alerts rail 1fr,
 * one column under 1100 px), each at its loaded floor, so nothing jumps when the first sweep's rows land.
 */
function LedgerSkeleton() {
  return (
    <Page className="mr-ledger" title={t('ledger.title')} subtitle={t('ledger.subtitle')} aria-busy="true" aria-label={t('ledger.loading')} data-state="loading">
      <section className="mr-panel mr-ledger-skeleton-strip" aria-hidden="true">
        <Skeleton title={{ width: '18%' }} paragraph={{ rows: 2, width: ['72%', '56%'] }} />
      </section>
      <section className="mr-ledger-flows mr-panel" data-testid="ledger-skeleton">
        <div className="mr-ledger-skeleton-toolbar">
          <Skeleton title={{ width: '28%' }} paragraph={false} />
        </div>
        <div className="mr-ledger-skeleton mr-ledger-skeleton--table">
          {SKELETON_ROWS.map((width, i) => (
            <div key={i} className={i === 0 ? 'mr-ledger-skeleton-row mr-ledger-skeleton-row--head' : 'mr-ledger-skeleton-row'}>
              <Skeleton title={{ width }} paragraph={false} />
            </div>
          ))}
        </div>
      </section>
      <div className="mr-ledger-lower" aria-hidden="true">
        <div className="mr-ledger-timeline">
          <section className="mr-panel mr-ledger-skeleton-card mr-ledger-skeleton-card--timeline">
            <Skeleton title={{ width: '36%' }} paragraph={{ rows: 1, width: ['60%'] }} />
            <div className="mr-ledger-skeleton-chart" />
          </section>
        </div>
        <div className="mr-ledger-rail">
          <section className="mr-panel mr-ledger-skeleton-card">
            <Skeleton title={{ width: '44%' }} paragraph={{ rows: 3, width: ['80%', '100%', '64%'] }} />
          </section>
        </div>
      </div>
      <section className="mr-panel mr-ledger-skeleton-changes" aria-hidden="true">
        <Skeleton title={{ width: '20%' }} paragraph={{ rows: 4, width: ['40%', '96%', '90%', '94%'] }} />
      </section>
    </Page>
  );
}

export default function LedgerView() {
  const snapshot = useAppState((s) => s.snapshot);
  const phase = useAppState((s) => s.status.hydrate.phase);
  const snapshotError = useAppState((s) => s.errors.snapshot);
  const lastOkAt = useAppState((s) => s.status.live.lastOkAt);
  const humanizeMap = useAppState((s) => s.settings.humanize);
  // A snapshot over its size cap lists the largest flows and sums the rest on one Other row (core/snapshot.ts): the
  // page counts every flow the sweep meters and says so (usefulness review, round 2).
  const inventory = useAppState((s) => s.inventory);
  const fold = useMemo(() => snapshotFold(snapshot, inventory), [snapshot, inventory]);
  // r3 ui-1 (C3): the Receipt's zone (stored settings → snapshot.zone → this browser's), so a settings-less workspace's
  // day keys, commit times and range words match the Receipt's and the Report's.
  const timeZone = useViewZone();
  const [params, setParams] = useLedgerParams();
  // The Receipt's custom range follows the member here (?range=, a sticky param): the money columns sum it (P2-W14).
  // Live data only — sample and replay data have no rollup history, as on the Receipt.
  const [appParams, setAppParams] = useAppParams();
  const source = useAppState((s) => s.source);
  const rangeSpec = source === 'live' ? appParams.range : undefined;
  const { state: rangeState, result: rangeResult, retry: retryRange } = useRange(rangeSpec, rangeSpec !== undefined, snapshot?.sweepAt);
  const figures = rangeSpec ? rangeResult?.figures : undefined;

  // ── Search: local for instant typing, deferred for filtering, debounced into the URL ──
  const [query, setQuery] = useState(params.q);
  const lastWritten = useRef(params.q);
  useEffect(() => {
    // Back / forward (or a pasted link) changed ?q= — follow it.
    if (params.q !== lastWritten.current) {
      lastWritten.current = params.q;
      setQuery(params.q);
    }
  }, [params.q]);
  useEffect(() => {
    if (query === lastWritten.current) return;
    const id = setTimeout(() => {
      lastWritten.current = query;
      setParams({ q: query });
    }, URL_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query, setParams]);
  const deferredQuery = useDeferredValue(query);

  // ── Rows ──
  // Mute countdowns are measured at the sweep that wrote the snapshot (render stays pure).
  const sweptRows = useMemo(
    () =>
      buildRows(snapshot, {
        humanize: humanizeMap,
        now: snapshot ? Date.parse(snapshot.sweepAt) : 0,
        ...(fold
          ? { otherLabel: fold.inOther !== undefined ? tn('ledger.fold.otherRow', fold.inOther, { n: formatInt(fold.inOther) }) : t('ledger.fold.otherRowNoCount') }
          : {}),
      }),
    [snapshot, humanizeMap, fold],
  );
  // Under a range every row carries its window's money (P2-W14); flows the window metered that the sweep no longer
  // lists are summed on one line under the table, so the totals reconcile with the Receipt's figure.
  const allRows = useMemo(() => (figures ? withWindow(sweptRows, figures.byFlow) : sweptRows), [sweptRows, figures]);
  const unlisted = useMemo(() => (figures ? unlistedWindow(sweptRows, figures.byFlow) : undefined), [sweptRows, figures]);
  const windowUnit = figures ? windowUnitOf(figures.fromMs, figures.toMs) : undefined;
  const windowWords = figures ? rangeWords(figures, validZone(timeZone)) : undefined;
  const destinations = useMemo(() => destinationOptions(allRows), [allRows]);
  const groups = useMemo(() => groupOptions(allRows), [allRows]);
  // A ?dest= / ?group= the latest sweep does not know (a vanished destination, a mistyped link) is not applied: it
  // would empty the table for no reason the member can see. A notice names it instead (P1-K05).
  const destUnknown = !!params.dest && allRows.length > 0 && !destinations.some((o) => o.id === params.dest);
  const groupUnknown = !!params.group && allRows.length > 0 && !groups.some((o) => o.id === params.group);
  const dest = destUnknown ? undefined : params.dest;
  const group = groupUnknown ? undefined : params.group;
  const filters = useMemo(
    () => ({
      q: deferredQuery,
      state: params.state,
      destination: dest,
      group,
    }),
    [deferredQuery, params.state, dest, group],
  );
  const filtered = useMemo(() => filterRows(allRows, filters), [allRows, filters]);
  // Deep-link targets are computed on every row, so a quiet flow someone linked to is never folded away.
  const targets = useMemo(() => rowsForObject(allRows, params.object), [allRows, params.object]);
  const folded = useMemo(() => {
    const keep = new Set(targets.map((r) => r.id));
    const part = partitionQuiet(filtered, { show: params.showQuiet, state: params.state, keep });
    // Every matching flow is quiet (a fresh workspace, or a search that only finds them): list them all.
    if (part.visible.length === 0 && part.quiet > 0) return { visible: [...filtered], quiet: 0, all: true };
    return { ...part, all: false };
  }, [filtered, targets, params.showQuiet, params.state]);
  const rows = useMemo(() => sortRows(folded.visible, params.sort), [folded.visible, params.sort]);
  // The Other row stands for the flows it folds: the total line counts them.
  const sums = useMemo(() => {
    const sum = totals(rows);
    const folded = fold?.inOther !== undefined && rows.some((r) => isOtherFlow(r.flow)) ? fold.inOther - 1 : 0;
    return folded > 0 ? { ...sum, flows: sum.flows + folded } : sum;
  }, [rows, fold]);
  const counts = useMemo(() => statusCounts(allRows), [allRows]);
  const active = hasActiveFilters({ ...filters, q: query });

  // ── Deep link ──
  const [nonce, setNonce] = useState(0);
  const visibleIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const visibleTargets = useMemo(() => targets.filter((r) => visibleIds.has(r.id)), [targets, visibleIds]);
  const highlighted = useMemo(() => new Set(visibleTargets.map((r) => r.id)), [visibleTargets]);
  const firstTarget = visibleTargets[0]?.id;
  // Scroll whenever the object changes, and once the first sweep's rows arrive for a pasted link.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!params.object || !firstTarget) return;
    const key = `${params.object}|${firstTarget}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    setNonce((n) => n + 1);
  }, [params.object, firstTarget]);
  const scrollTo = firstTarget ? { rowId: firstTarget, nonce } : undefined;

  const clearFilters = useCallback(() => {
    setQuery('');
    lastWritten.current = '';
    setParams({ q: null, state: null, dest: null, group: null });
  }, [setParams]);

  /** Select an object from the rail or the timeline: show it even if the filters hid it. */
  const selectObject = useCallback(
    (objectKey: string) => {
      const hits = rowsForObject(allRows, objectKey);
      const hidden = hits.length > 0 && !hits.some((r) => visibleIds.has(r.id));
      if (hidden) {
        setQuery('');
        lastWritten.current = '';
        setParams({
          object: objectKey,
          q: null,
          state: null,
          dest: null,
          group: null,
          commit: null,
        });
      } else {
        setParams({ object: objectKey, commit: null });
      }
      scrolledFor.current = null;
    },
    [allRows, visibleIds, setParams],
  );

  const onRowSelect = useCallback(
    (row: LedgerRow) => {
      const key = primaryObjectKey(row);
      setParams({ object: params.object === key ? null : key });
    },
    [params.object, setParams],
  );


  // ── Every commit priced (P2-W07): the timeline's card and annotation, and the "Changes" list ──
  const zone = useMemo(() => validZone(timeZone), [timeZone]);
  const impacts = useMemo(() => commitImpacts(snapshot, { timeZone: zone, humanize: humanizeMap }), [snapshot, zone, humanizeMap]);
  const impactsByHash = useMemo(() => new Map(impacts.map((i) => [i.commit.hash, i])), [impacts]);
  const undone = useMemo(() => reversals(impacts, snapshot), [impacts, snapshot]);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const selectCommit = useCallback((hash: string | null) => setParams({ commit: hash }), [setParams]);

  // ── The table and the timeline point at each other (P2-W17) ──
  const [hoverRowId, setHoverRowId] = useState<string | null>(null);
  const [hoverCommit, setHoverCommit] = useState<string | null>(null);
  const onRowHover = useCallback((row: LedgerRow | null) => setHoverRowId(row ? row.id : null), []);
  const endMs = snapshot ? Date.parse(snapshot.windowEnd) : undefined;
  const newestCommitMs = useMemo(() => {
    const times = (snapshot?.timeline ?? []).map(commitTimeMs).filter((x) => Number.isFinite(x));
    return times.length ? Math.max(...times) : undefined;
  }, [snapshot]);
  const linkedFlow = useMemo((): LinkedFlow | null => {
    const row = hoverRowId ? allRows.find((r) => r.id === hoverRowId) : undefined;
    if (!row) return null;
    const spark = row.flow.sparkline ?? [];
    return {
      label: row.pipeline || row.source,
      ratio: spark.length ? spark[spark.length - 1] : undefined,
      since: spark.length && endMs !== undefined ? endMs - spark.length * 60_000 : undefined,
      commits: new Set(impacts.filter((i) => commitTouchesRow(i, row)).map((i) => i.commit.hash.slice(0, 7))),
    };
  }, [hoverRowId, allRows, impacts, endMs]);
  const linkedRows = useMemo(() => {
    const impact = hoverCommit ? impacts.find((i) => i.commit.hash.slice(0, 7) === hoverCommit) : undefined;
    return new Set(impact ? allRows.filter((r) => commitTouchesRow(impact, r)).map((r) => r.id) : []);
  }, [hoverCommit, impacts, allRows]);
  const dayDelta = useMemo(() => ratioDayDelta(snapshot?.ratioSeries), [snapshot]);
  const showCommit = useCallback(
    (hash: string) => {
      setParams({ commit: hash });
      const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      timelineRef.current?.scrollIntoView?.({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    },
    [setParams],
  );

  if (!snapshot && !snapshotError && (phase === 'idle' || phase === 'loading')) return <LedgerSkeleton />;

  const totalCount = allRows.length;
  const countText = active
    ? t('ledger.countFiltered', {
        shown: formatInt(rows.length),
        total: formatInt(totalCount),
      })
    : fold?.total !== undefined
      ? tn('ledger.count', fold.total, { n: formatInt(fold.total) })
      : tn('ledger.count', rows.length, { n: formatInt(rows.length) });
  // The summary row: folded flows ("· Show"), or the listed ones ("· Hide") once the member asked for them.
  const quietRow =
    params.state === 'idle' || folded.all || folded.quiet === 0 ? null : (
      <div className="mr-ledger-quiet" data-testid="ledger-quiet" data-shown={params.showQuiet ? 'true' : 'false'}>
        <span className="mr-ledger-quiet-text mr-num">
          {tn(params.showQuiet ? 'ledger.quiet.shown' : 'ledger.quiet.hidden', folded.quiet, { n: formatInt(folded.quiet) })}
        </span>
        <Button variant="tertiary" size="sm" onPress={() => setParams({ showQuiet: !params.showQuiet })}>
          {params.showQuiet ? t('ledger.quiet.hide') : t('ledger.quiet.show')}
        </Button>
      </div>
    );
  const objectMissing = !!params.object && !!snapshot && targets.length === 0;
  const objectHidden = !!params.object && targets.length > 0 && visibleTargets.length === 0;
  const hasFlows = totalCount > 0;
  // The snapshot could not be read and none is on screen (P1-K06): the page says so once, in the error notice, and
  // the empty sections say "can't be read", never the first-run "No flows yet".
  const unreadable = !snapshot && !!snapshotError;
  // One recovery action per state (P1-K05): the filtered-to-zero block and the hidden-link notice carry their own
  // "Clear filters", so the toolbar's steps aside while either is on screen.
  const toolbarClears = active && rows.length > 0 && !objectHidden;

  const filteredEmpty = (
    <div className="mr-ledger-filtered-empty" data-state="filtered-empty">
      <p className="mr-ledger-filtered-title">{t('ledger.emptyFiltered')}</p>
      <p className="mr-ledger-filtered-body">{t('ledger.emptyFilteredBody')}</p>
      <div>
        <Button variant="secondary" size="sm" onPress={clearFilters}>
          {t('ledger.filters.clear')}
        </Button>
      </div>
    </div>
  );

  return (
    <Page className="mr-ledger" title={t('ledger.title')} subtitle={t('ledger.subtitle')} data-state={hasFlows ? 'ready' : unreadable ? 'error' : 'empty'}>

      {snapshotError ? (
        <div className="mr-ledger-notice">
          <ErrorNotice
            error={snapshotError}
            section={t('ledger.tableLabel').toLowerCase()}
            // "Showing the last good data" only where some is on screen (P1-K06).
            lastGoodAt={snapshot ? lastOkAt : undefined}
            layout="section"
          />
        </div>
      ) : null}

      {hasFlows ? <MoneyStrip totals={sums} countText={countText} dayDelta={active ? undefined : dayDelta} windowWords={windowWords} /> : null}

      <section className="mr-ledger-flows mr-panel" aria-label={t('ledger.tableLabel')}>
        {hasFlows ? (
          <>
            <Toolbar
              query={query}
              onQueryChange={setQuery}
              state={params.state}
              onStateChange={(s) => setParams({ state: s })}
              statusCounts={counts}
              dest={dest}
              onDestChange={(d) => setParams({ dest: d })}
              destinations={destinations}
              group={group}
              onGroupChange={(g) => setParams({ group: g })}
              groups={groups}
              filtered={toolbarClears}
              onClear={clearFilters}
              countText={countText}
            />
            {fold ? (
              <div className="mr-ledger-inline-notice" data-testid="ledger-fold" data-shown={fold.shown} data-total={fold.total}>
                <InlineNotice variant="inline" data-state="folded">
                  {fold.total !== undefined && fold.inOther !== undefined
                    ? t('ledger.fold.notice', { shown: formatInt(fold.shown), total: formatInt(fold.total), other: formatInt(fold.inOther) })
                    : t('ledger.fold.noticeNoTotal', { shown: formatInt(fold.shown) })}
                </InlineNotice>
              </div>
            ) : null}
            {rangeSpec ? (
              <div className="mr-ledger-inline-notice" data-testid="ledger-window" data-state={rangeState.status}>
                {rangeState.status === 'error' ? (
                  <InlineNotice variant="inline" data-state="window-error" action={{ label: t('ledger.window.retry'), onClick: retryRange }}>
                    {t('ledger.window.error')}
                  </InlineNotice>
                ) : (
                  <InlineNotice
                    variant="inline"
                    data-state={figures ? 'window' : 'window-loading'}
                    action={{ label: t('ledger.window.perDay'), onClick: () => setAppParams({ range: null }) }}
                  >
                    {figures && windowWords ? t('ledger.window.summed', { words: windowWords }) : t('ledger.window.loading')}
                  </InlineNotice>
                )}
              </div>
            ) : null}
            {destUnknown || groupUnknown ? (
              <div className="mr-ledger-inline-notice">
                <InlineNotice
                  variant="inline"
                  data-state="filter-missing"
                  onDismiss={() => setParams({ ...(destUnknown ? { dest: null } : {}), ...(groupUnknown ? { group: null } : {}) })}
                >
                  {[
                    destUnknown ? t('ledger.destMissing', { id: params.dest ?? '' }) : '',
                    groupUnknown ? t('ledger.groupMissing', { id: params.group ?? '' }) : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                </InlineNotice>
              </div>
            ) : null}
            {objectHidden ? (
              <div className="mr-ledger-inline-notice">
                <InlineNotice variant="inline" data-state="object-hidden" action={{ label: t('ledger.showAll'), onClick: clearFilters }}>
                  {`${objectLabel(params.object ?? '', humanizeMap)} · ${t('ledger.objectHidden')}`}
                </InlineNotice>
              </div>
            ) : null}
            {objectMissing ? (
              <div className="mr-ledger-inline-notice">
                <InlineNotice variant="inline" data-state="object-missing" onDismiss={() => setParams({ object: null })}>
                  {`${objectLabel(params.object ?? '', humanizeMap)} · ${t('ledger.objectMissing')}`}
                </InlineNotice>
              </div>
            ) : null}
            <LedgerTable
              rows={rows}
              sort={params.sort}
              onSortChange={(sort) => setParams({ sort })}
              highlighted={highlighted}
              scrollTo={scrollTo}
              onRowSelect={onRowSelect}
              totals={sums}
              empty={filteredEmpty}
              linked={linkedRows}
              onRowHover={onRowHover}
              newestCommitMs={newestCommitMs}
              sparkEndMs={endMs}
              windowUnit={windowUnit}
            />
            {quietRow}
            {unlisted && unlisted.flows > 0 ? (
              <div className="mr-ledger-quiet" data-testid="ledger-unlisted" data-saved-m={unlisted.money.savedM}>
                <span className="mr-ledger-quiet-text mr-num">
                  {tn(fold ? 'ledger.window.unlistedFolded' : 'ledger.window.unlisted', unlisted.flows, {
                    n: formatInt(unlisted.flows),
                    amount: formatMoney(unlisted.money.savedM),
                  })}
                </span>
              </div>
            ) : null}
          </>
        ) : unreadable ? (
          <div className="mr-ledger-empty" data-state="unreadable">
            <EmptyBlock title={t('ledger.unreadable')} description={t('ledger.unreadableBody')} ghost="rows" />
          </div>
        ) : (
          <div className="mr-ledger-empty" data-state="no-flows">
            <EmptyBlock title={t('ledger.empty')} description={t('ledger.emptyBody')} ghost="rows">
              {/* Flows are priced at their destinations: the way out of an empty Ledger is a price (P1-D06). */}
              <ButtonLink href="/settings/prices" variant="secondary" size="sm" data-testid="ledger-set-prices">
                {t('ledger.emptySetPrices')}
              </ButtonLink>
            </EmptyBlock>
          </div>
        )}
      </section>

      <div className="mr-ledger-lower">
        <div className="mr-ledger-timeline" ref={timelineRef}>
          <ChangeTimeline
            snapshot={snapshot}
            range={params.range}
            onRangeChange={(range) => setParams({ range })}
            timeZone={timeZone}
            humanize={humanizeMap}
            onSelectObject={selectObject}
            unavailable={unreadable}
            impacts={impactsByHash}
            selectedCommit={params.commit ?? null}
            onSelectCommit={selectCommit}
            linkedFlow={linkedFlow}
            onHoverCommit={setHoverCommit}
          />
        </div>
        <div className="mr-ledger-rail">
          <IncidentsRail
            incidents={snapshot?.incidents ?? []}
            flowsWatched={fold?.total ?? totalCount}
            onSelectObject={selectObject}
            selectedObject={params.object}
            unavailable={unreadable}
          />
        </div>
      </div>

      {snapshot ? <ChangesList
          impacts={impacts}
          timeZone={zone}
          selected={params.commit ?? null}
          onSelect={showCommit}
          truncated={snapshot.timelineTruncated === true}
          reversals={undone}
          labels={humanizeMap}
        /> : null}
    </Page>
  );
}
