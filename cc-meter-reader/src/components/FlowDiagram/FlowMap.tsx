// src/components/FlowDiagram/FlowMap.tsx — the Flow map as a product module: the diagram card (with its
// legend and the "showing N of M" caption) beside the ONE receipt card. Used by the Flow view and the What-if
// view (where the flows are the projected after-state).
//
// Real data (BEAUTY F9): the map is fitted to the room left in the viewport (one picture, no scrolling past
// the fold), the long tail folds into one "n smaller flows" ribbon per destination, band width is dollars
// (√ would-have-paid, P1-I01) and every ribbon worth ≥ 2 % of the map carries its $ plate. On a phone
// (≤ 640 px) it is a ranked list, with the Sankey one tap away.
//
// Selection: hover or keyboard focus shows a path on the receipt card; click / Enter pins it until Escape or a
// second click. With nothing selected the card shows the whole group (or, in a projection, the stream the
// What-if changed).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { prefersReducedMotion } from '../../lib/dom.ts';
import { Link } from 'react-router-dom';
import { Button, ToggleButtonGroup, type Key } from '@capra/core';
import { t, tn } from '../../copy/en.ts';
import { formatMoney, formatPct } from '../../lib/format.ts';
import { parseObjectKey } from '../../../core/flows.ts';
import { footMoney, mcToDollarInput } from '../../../core/format.ts';
import type { Incident } from '../../../core/types.ts';
import { incidentMarks } from './marks.ts';
import { FlowDiagram } from './FlowDiagram.tsx';
import { FlowList } from './FlowList.tsx';
import { listRows } from './listRows.ts';
import { flowCount, selectionExists, undrawnCounts, type FlowSelection } from './selection.ts';
import { useElementWidth, useFitHeight, useMediaQuery } from './hooks.ts';
import {
  GROUP_BELOW_SHARE,
  OTHER_ID,
  computeFlowLayout,
  groupSmallFlows,
  isDrawable,
  nodeId,
  ribbonId,
  sourceHues,
  sumTotals,
  type FlowLayout,
  type FlowMark,
  type LayoutFlow,
  type WeightBy,
} from './layout.ts';
import { ReceiptCard, type ReceiptCardProps } from './ReceiptCard.tsx';
import { layoutText, nodeName, otherName, pipelineHref } from './text.ts';
import { SOURCE_HUES } from './sourceColors.ts';
import { useDeepLinks } from '../../lib/deepLinks.ts';
import { useShortcut } from '../../lib/shortcuts.ts';
import { useClockReading } from '../../lib/ticker.ts';
import './FlowDiagram.css';

export interface FlowMapProps {
  /** The group's flows (projected copies in What-if mode). Undrawable flows are counted, not drawn. */
  flows: readonly LayoutFlow[];
  groupId: string;
  /** Destination ids in colour order (all of the snapshot's destinations, so colours match other views). */
  colorOrder: readonly string[];
  /** settings.humanize */
  humanize?: Record<string, string>;
  /** Projection styling + the Projection chip. */
  projection?: boolean;
  /**
   * The live flows a projection is drawn against (P1-I06): the projected map keeps their in-column node order, so
   * switching the What-if on ghosts the same picture instead of re-ordering its rows.
   */
  liveFlows?: readonly LayoutFlow[];
  /** The ribbon (stream) the card shows when nothing is selected — the What-if's stream. */
  focusRibbonId?: string;
  /** A line under that card's heading while it rests on `focusRibbonId`: the What-if's math (P1-I06 slice 2). */
  focusCaption?: string;
  /** Ease duration when the flows change with a new snapshot (200 ms). */
  tweenMs?: number;
  /** Changes when the member changes the What-if; that change morphs over 400 ms (DESIGN_BRIEF 5.9). */
  morphKey?: string;
  /** Query string for in-app links (keeps ?group). */
  ledgerHref?: string;
  settingsHref?: string;
  /** Destinations without a price (snapshot.unpricedOutputIds): only their flows send the footer to Settings. */
  unpricedOutputIds?: readonly string[];
  /**
   * What band width measures (P2-W02): dollars (default) or bytes, the way Cribl Insights draws it. With
   * `onWeightBy` the map card carries the "Width: Dollars | Bytes" toggle (on the Sankey, not the phone's list).
   */
  weightBy?: WeightBy;
  onWeightBy?: (weightBy: WeightBy) => void;
  /**
   * The presenter-scale map (P2-W10): labels and plates at `scale` (≈ 2 on a 1080-row projector), the map filling the
   * room, and the receipt card, the width toggle and the legend as a strip on the right between `header` and `footer`.
   */
  stage?: { scale: number; header?: ReactNode; footer?: ReactNode };
  /** The snapshot's incidents (P2-W16): an open one outlines its flow's ribbon and says what it costs, since when. */
  incidents?: readonly Incident[];
  /** The snapshot's destinations (P2-W16): each chip reads its price per GB. */
  destinations?: readonly { outputId: string; milliCentsPerGb: number; unpriced?: boolean }[];
  /** settings.displayTimezone, for the incident plates' times. */
  timeZone?: string;
  /** ?object= (P2-W16): open the card on that source, pipeline, destination or route. */
  pinObject?: string;
}


/** The phone breakpoint shared with the stylesheets (Shell, FlowScreen, FlowDiagram). */
const PHONE_QUERY = '(max-width: 640px)';
/** On stage nothing comes within 40 px of an edge (DESIGN_BRIEF 5.2). */
const STAGE_MARGIN = 40;

/**
 * The receipt card for one flow: a real one, or a destination's folded "smaller flows" — named as a part of the
 * shared node when that node folds more ("15 of the 18 smaller flows", P1-I04).
 */
function flowCard(f: LayoutFlow, projected: boolean, humanize: Record<string, string> | undefined, foldShare: number, foldedTotal = 0, weightBy: WeightBy = 'dollars'): ReceiptCardProps {
  if (f.inputId === OTHER_ID) {
    const n = f.folded ?? 0;
    return {
      heading: foldedTotal > n ? t('flow.other.part', { n, total: foldedTotal }) : otherName('in', n, weightBy),
      eyebrow: flowCount(f.folded ?? 0),
      path: [otherName('pipe', f.folded ?? 0), nodeName('out', f.outputId, humanize)],
      caption: t('flow.other.path', { pct: formatPct(foldShare) }),
      totals: sumTotals([f]),
      projected,
    };
  }
  const names = [nodeName('in', f.inputId, humanize), nodeName('pipe', f.pipelineId, humanize), nodeName('out', f.outputId, humanize)];
  return {
    heading: names[0],
    eyebrow: t('flow.kind.in'),
    // the heading is the source; the path continues from it
    path: names.slice(1),
    totals: sumTotals([f]),
    projected,
    link: f.pipelineId !== '-' ? { href: pipelineHref(f.groupId, f.pipelineId), label: t('flow.card.openPipeline') } : undefined,
  };
}

function cardFor(
  layout: FlowLayout | null,
  selection: FlowSelection,
  all: readonly LayoutFlow[],
  byRibbon: ReadonlyMap<string, LayoutFlow>,
  groupId: string,
  humanize: Record<string, string> | undefined,
  foldedTotal: number,
): ReceiptCardProps {
  if (selection?.kind === 'ribbon') {
    const r = layout?.ribbons.find((x) => x.id === selection.id);
    if (r) return flowCard(r.flow, r.projected, humanize, layout!.foldShare, layout!.nodes.find((n) => n.id === r.sourceId && n.other)?.flows ?? 0, layout!.weightBy);
    const f = byRibbon.get(selection.id);
    if (f) return flowCard(f, !!f.projected, humanize, GROUP_BELOW_SHARE, foldedTotal);
  }
  if (selection?.kind === 'node' && layout) {
    const n = layout.nodes.find((x) => x.id === selection.id);
    if (n) {
      const flows = layout.ribbons.filter((r) => n.flowKeys.includes(r.flowKey)).map((r) => r.flow);
      // the node's whole totals, the same figures its caption prints (P1-I04)
      return {
        heading: n.name,
        eyebrow: `${t(`flow.kind.${n.kind}`)} · ${flowCount(n.flows)}`,
        totals: n.totals,
        projected: flows.some((f) => f.projected),
        link: n.kind === 'pipe' && n.rawId !== '-' && !n.other ? { href: pipelineHref(n.groupId, n.rawId), label: t('flow.card.openPipeline') } : undefined,
      };
    }
  }
  const drawable = all.filter(isDrawable);
  return {
    heading: t('flow.card.allTitle', { group: groupId }),
    eyebrow: flowCount(drawable.length),
    caption: t('flow.card.allHint'),
    totals: sumTotals(drawable),
  };
}

export function FlowMap({
  flows,
  groupId,
  colorOrder,
  humanize,
  projection = false,
  liveFlows,
  focusRibbonId,
  focusCaption,
  tweenMs = 200,
  morphKey,
  ledgerHref = '/ledger',
  settingsHref = '/settings/prices',
  unpricedOutputIds,
  weightBy = 'dollars',
  onWeightBy,
  stage,
  incidents,
  destinations,
  timeZone,
  pinObject,
}: FlowMapProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  // P1-I05: on the phone's list a tap pins the flow on the card below the list, so the card comes into view and
  // its border answers the tap once (no animation under reduced motion)
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (flash === 0) return;
    asideRef.current?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    const timer = window.setTimeout(() => setFlash(0), 900);
    return () => window.clearTimeout(timer);
  }, [flash]);
  const phone = useMediaQuery(PHONE_QUERY);
  const [mapOnPhone, setMapOnPhone] = useState(false);
  // on stage the map is always the Sankey (a projector is never a phone, even a narrow browser window)
  const listMode = phone && !mapOnPhone && !stage;
  const width = useElementWidth(frameRef, !listMode);
  // the stage keeps 40 px clear under the map (DESIGN_BRIEF 5.2: nothing within 40 px of an edge)
  // (on stage nothing sits under the map in its column — the legend is in the strip — so the frame is its own card: the
  // stretched grid cell must not count as room below it)
  const fitted = useFitHeight(frameRef, stage ? frameRef : cardRef, !listMode, stage ? STAGE_MARGIN : undefined);
  // A projection keeps the height the map had before it (WP-J): the What-if calculator opening above the map
  // must not re-fit it while the 400 ms morph plays (the frame would shrink under the calculator mid-morph).
  // (A /whatif opened directly starts in projection: its first measurement is taken, then held.)
  const [liveHeight, setLiveHeight] = useState(fitted);
  if ((!projection || liveHeight === undefined) && liveHeight !== fitted) setLiveHeight(fitted);
  const maxHeight = projection ? liveHeight : fitted;
  const text = useMemo(() => layoutText(humanize), [humanize]);
  // One frame for every layout of this map (the live rows, the dollar rows, the drawn map): same width, room, scale.
  const scale = stage?.scale;
  const onStage = stage !== undefined;
  // The marks read the clock through the shared ticker (fresh to the second, never ticking on its own) rather than
  // Date.now() in render, and keep their identity while their content is unchanged, so a new reading alone never
  // re-lays the map; a recovery's green mark ends at the first render past its ten seconds.
  const clock = useClockReading();
  const marksKey = useMemo(() => JSON.stringify(incidentMarks(flows, incidents, clock, timeZone)), [flows, incidents, clock, timeZone]);
  const marks = useMemo(() => JSON.parse(marksKey) as Record<string, FlowMark>, [marksKey]);
  // Each Source's hue, from the LIVE flows: a projection ghosts the same colours it is compared with (sourceColors.ts).
  const sourceColors = useMemo(() => sourceHues(liveFlows ?? flows), [liveFlows, flows]);
  // the savings as a place (P2-W16): every desktop map pools its wedges in the "Removed by Cribl" sink
  const frame = useMemo(
    () => ({ width, text, colorOrder, sourceColors, maxHeight, scale, fill: onStage, sink: true, marks }),
    [width, text, colorOrder, sourceColors, maxHeight, scale, onStage, marks],
  );
  // In a projection, the live map's rows (same frame, same fold rules) pin the projected map's node order; the byte
  // map (P2-W02) keeps the dollar map's rows, so the toggle morphs widths in place instead of shuffling the rows.
  const nodeOrder = useMemo(() => {
    if (frame.width <= 0 || listMode) return undefined;
    if (projection && liveFlows) return computeFlowLayout(liveFlows, frame).nodes.map((n) => n.id);
    if (weightBy === 'bytes') return computeFlowLayout(flows, frame).nodes.map((n) => n.id);
    return undefined;
  }, [projection, liveFlows, flows, weightBy, frame, listMode]);
  const layout = useMemo(
    () => (frame.width > 0 && !listMode ? computeFlowLayout(flows, { ...frame, nodeOrder, weightBy }) : null),
    [flows, frame, listMode, nodeOrder, weightBy],
  );
  const toggle = onWeightBy !== undefined && !listMode && !projection;
  const bytes = weightBy === 'bytes';
  // A flow with an alert on it keeps its own row on the phone's list, as it keeps its own ribbon on the map (P2-W16).
  const folding = useMemo(() => groupSmallFlows(flows, undefined, Object.keys(marks)), [flows, marks]);
  const rows = useMemo(() => (listMode ? listRows(folding.flows, sourceColors, humanize, marks) : []), [listMode, folding, sourceColors, humanize, marks]);
  const byRibbon = useMemo(() => new Map(rows.map((r) => [r.id, r.flow])), [rows]);

  const [hover, setHover] = useState<FlowSelection>(null);
  const [pinnedRaw, setPinned] = useState<FlowSelection>(null);
  // A pin whose flow has left the map (or the list) no longer counts.
  const pinned = selectionExists(layout, pinnedRaw) || (pinnedRaw?.kind === 'ribbon' && byRibbon.has(pinnedRaw.id)) ? pinnedRaw : null;
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned]);
  // On stage, Escape also leaves the stage (a shortcut, dispatched before any window listener): with a path pinned,
  // the first Escape releases the pin and the stage stays; the second leaves (priority above the stage's 2).
  useShortcut('Escape', () => setPinned(null), stage !== undefined && pinned !== null, 3);

  // ?object= (P2-W16): the card opens on that object once the map (or the list) has it, once per ?object= value. A
  // state adjusted while rendering (React's pattern for state that follows a prop), not a setState in an effect.
  const [pinnedFor, setPinnedFor] = useState<string | undefined>(undefined);
  if (pinObject && pinnedFor !== pinObject && (layout || listMode)) {
    const parsed = parseObjectKey(pinObject);
    if (parsed) {
      let target: FlowSelection = null;
      if (parsed.kind === 'route') {
        const f = flows.find((x) => x.groupId === parsed.groupId && x.routeId === parsed.id && isDrawable(x));
        if (f) target = { kind: 'ribbon', id: ribbonId(f) };
      } else if (layout?.nodes.some((n) => n.id === pinObject)) target = { kind: 'node', id: pinObject };
      setPinnedFor(pinObject);
      if (target) setPinned(target);
    }
  }

  // The stage's cursor tip (P2-W10): the three numbers beside the pointer, so the room's eyes stay on the ribbon.
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const linksOut = useDeepLinks();

  const fallback: FlowSelection = focusRibbonId ? { kind: 'ribbon', id: focusRibbonId } : null;
  const selection = pinned ?? hover ?? fallback;
  const found = layout || listMode ? cardFor(layout, selection, flows, byRibbon, groupId, humanize, folding.folded) : null;
  // Sample data: no "Open pipeline" out of the app (OQ-01). On stage, no "Hover or focus…": a projector's room does
  // not hover (review W2).
  const unlinked = found && !linksOut ? { ...found, link: undefined } : found;
  // On a phone's list there is no map to hover: the hint names what a tap does there instead.
  const hinted = unlinked && listMode && unlinked.caption === t('flow.card.allHint') ? { ...unlinked, caption: t('flow.card.listHint') } : unlinked;
  const base = hinted && onStage && hinted.caption === t('flow.card.allHint') ? { ...hinted, caption: undefined } : hinted;
  const card = base && focusCaption && selection === fallback && fallback !== null ? { ...base, caption: focusCaption } : base;
  const tip = stage && pointer && hover && layout ? cardFor(layout, hover, flows, byRibbon, groupId, humanize, folding.folded) : null;
  // The tip's triple adds up to the dollar, as the receipt card's does (core/format.ts footMoney).
  const tipShown = tip ? footMoney({ whpM: tip.totals.whpPerDayM, paidM: tip.totals.paidPerDayM, savedM: tip.totals.savedPerDayM }) : null;
  const undrawn = useMemo(() => undrawnCounts(flows, unpricedOutputIds), [flows, unpricedOutputIds]);
  const folded = layout ? layout.folded : folding.folded;
  const foldShare = layout ? layout.foldShare : GROUP_BELOW_SHARE;
  const capped = layout !== null && layout.shown < layout.eligible;
  // a named source past the coloured ones is drawn in the neutral (D55): the note says so. Read from the flows at the
  // default fold, not from the fitted layout, so the note's own line can never re-fit the map into or out of a tail.
  const tail = folding.flows.some((f) => isDrawable(f) && !f.folded && f.inputId !== OTHER_ID && !sourceColors.has(nodeId('in', f.groupId, f.inputId)));
  const note = capped || undrawn.noTraffic + undrawn.unpriced + undrawn.zero > 0 || folded > 0 || tail;
  // the phone's legend, and the stage's (its strip holds the receipt; the legend only names the two shapes)
  const short = phone || onStage;

  const weightToggle = toggle ? (
    // P2-W02: the pitch as a gesture — the map Insights draws, then what it costs
    <span className="mr-flowmap-weight" data-testid="flow-weight-toggle">
      <span className="mr-flowmap-weight-label" aria-hidden="true">
        {t('flow.weight.label')}
      </span>
      <ToggleButtonGroup
        aria-label={t('flow.weight.aria')}
        size={stage ? 'md' : 'sm'}
        disallowEmptySelection
        selectedKeys={new Set<Key>([weightBy])}
        onSelectionChange={(keys: Set<Key>) => {
          const next = [...keys][0];
          if (next === 'dollars' || next === 'bytes') onWeightBy?.(next);
        }}
        items={[
          { key: 'dollars', text: t('flow.weight.dollars') },
          { key: 'bytes', text: t('flow.weight.bytes') },
        ]}
      />
    </span>
  ) : null;

  const priceOf = new Map((destinations ?? []).map((d) => [d.outputId, d]));
  // the chips head the map card beside the width toggle (no extra height where they fit); not on a phone or the stage
  const chipNodes = layout && !onStage && !phone ? layout.nodes.filter((n) => n.kind === 'out' && !n.sink).sort((a, b) => a.y0 - b.y0) : [];
  const chips =
    chipNodes.length > 1 ? (
      <ul className="mr-flowmap-chips" aria-label={t('flow.chips.aria')} data-testid="flow-dest-chips">
        {chipNodes.map((n) => {
          const price = priceOf.get(n.rawId);
          const on = pinned?.kind === 'node' && pinned.id === n.id;
          return (
            <li key={n.id}>
              <button
                type="button"
                className="mr-flowmap-chip-btn"
                aria-pressed={on}
                data-dest-chip={n.id}
                onClick={() => setPinned(on ? null : { kind: 'node', id: n.id })}
              >
                <span className="mr-flowmap-chip-dot" aria-hidden="true" />
                <span className="mr-flowmap-chip-name">{n.name}</span>
                <span className="mr-flowmap-chip-money mr-num">
                  {price && !price.unpriced && price.milliCentsPerGb > 0
                    ? t('flow.chips.chip', { amount: formatMoney(n.totals.paidPerDayM), price: `$${mcToDollarInput(price.milliCentsPerGb)}` /* the rate as Prices and the Receipt print it: $0.023 */ })
                    : t('flow.chips.chipUnpriced', { amount: formatMoney(n.totals.paidPerDayM) })}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    ) : null;

  const foot = (
    <footer className="mr-flowmap-foot">
      <ul className="mr-flowmap-legend" aria-label={t('flow.title')}>
        <li>
          <span className="mr-flowmap-swatch mr-flowmap-swatch--band" aria-hidden="true" />
          {bytes ? t(short ? 'flow.legendPaidBytesShort' : 'flow.legendPaidBytes') : t(short ? 'flow.legendPaidShort' : 'flow.legendPaid')}
        </li>
        <li>
          <span className="mr-flowmap-swatch mr-flowmap-swatch--wedge" aria-hidden="true" />
          {bytes ? t(short ? 'flow.legendSavedBytesShort' : 'flow.legendSavedBytes') : t(short ? 'flow.legendSavedShort' : 'flow.legendSaved')}
        </li>
        {projection ? (
          <li>
            <span className="mr-flowmap-swatch mr-flowmap-swatch--projected" aria-hidden="true" />
            {t('flow.legendProjected')}
          </li>
        ) : null}
      </ul>
      {note ? (
        <p className="mr-flowmap-note" data-testid="flow-note">
          {folded > 0 ? <span>{tn('flow.grouped', folded, { pct: formatPct(foldShare) })} </span> : null}
          {tail ? <span data-testid="flow-note-tail">{tn('flow.tailNote', SOURCE_HUES)} </span> : null}
          {capped ? (
            <>
              {t('flow.showing', { shown: layout!.shown, total: layout!.eligible })} <Link to={ledgerHref}>{t('flow.seeLedger')}</Link>{' '}
            </>
          ) : null}
          {undrawn.noTraffic > 0 ? <span data-testid="flow-note-idle">{tn('flow.undrawn.noTraffic', undrawn.noTraffic)} </span> : null}
          {undrawn.zero > 0 ? <span data-testid="flow-note-zero">{tn('flow.undrawn.zero', undrawn.zero)} </span> : null}
          {/* the one bucket Settings can fix ends the note, with its link */}
          {undrawn.unpriced > 0 ? (
            <span data-testid="flow-note-unpriced">
              {tn('flow.undrawn.unpriced', undrawn.unpriced)} <Link to={settingsHref}>{t('flow.setPrices')}</Link>
            </span>
          ) : null}
        </p>
      ) : null}
    </footer>
  );

  const diagram = listMode ? (
    <FlowList
      rows={rows}
      groupId={groupId}
      selectedId={pinned?.kind === 'ribbon' ? pinned.id : focusRibbonId ?? null}
      onSelect={(id) => {
        setPinned(id ? { kind: 'ribbon', id } : null);
        if (id) setFlash((n) => n + 1);
      }}
    />
  ) : (
    <div
      ref={frameRef}
      className={`mr-flowmap-frame${layout ? '' : ' is-measuring'}`}
      onPointerMove={
        stage
          ? (e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setPointer({ x: e.clientX - box.left, y: e.clientY - box.top });
            }
          : undefined
      }
      onPointerLeave={stage ? () => setPointer(null) : undefined}
    >
      {layout ? (
        <FlowDiagram
          layout={layout}
          selection={selection}
          pinned={pinned !== null}
          onHover={setHover}
          onPin={setPinned}
          ariaLabel={t(bytes ? 'flow.mapAriaBytes' : 'flow.mapAria', { group: groupId })}
          tweenMs={tweenMs}
          morphKey={morphKey}
          projection={projection}
          dimLabels={pinned !== null || hover !== null}
        />
      ) : null}
      {tip && tipShown && pointer ? (
        <div
          className={`mr-flowstage-tip${pointer.x > width * 0.6 ? ' is-left' : ''}`}
          style={{ left: pointer.x, top: pointer.y }}
          data-testid="flow-stage-tip"
          aria-hidden="true"
        >
          <span className="mr-flowstage-tip-title">{tip.heading}</span>
          <span className="mr-flowstage-tip-line">
            {t('flow.card.whp')} <b className="mr-num">{formatMoney(tipShown.whpM)}</b>
          </span>
          <span className="mr-flowstage-tip-line">
            {t('flow.card.paid')} <b className="mr-num">{formatMoney(tipShown.paidM)}</b>
          </span>
          <span className="mr-flowstage-tip-line is-saved">
            {t('flow.card.saved')} <b className="mr-num">{formatMoney(tipShown.savedM)}</b>
          </span>
        </div>
      ) : null}
    </div>
  );

  const receipt = card ? <ReceiptCard {...card} pinned={pinned !== null} /> : null;

  if (stage) {
    // The stage (P2-W10): the map takes the frame; the receipt, the width toggle and the legend are a strip on the right.
    return (
      <div className={`mr-flowmap is-stage${projection ? ' is-projection' : ''}`} data-testid="flow-stage-map">
        <section ref={cardRef} className="mr-flowmap-diagram" aria-label={t(bytes ? 'flow.mapAriaBytes' : 'flow.mapAria', { group: groupId })}>
          {diagram}
        </section>
        <aside ref={asideRef} className="mr-flowmap-card mr-flowstage-strip" data-testid="flow-stage-strip">
          {stage.header}
          {weightToggle}
          {receipt}
          {foot}
          {stage.footer}
        </aside>
      </div>
    );
  }

  return (
    <div className={`mr-flowmap${projection ? ' is-projection' : ''}${listMode ? ' is-list' : ''}`}>
      <section ref={cardRef} className="mr-flowmap-diagram" aria-label={t('flow.mapAria', { group: groupId })}>
        {projection || phone || toggle || chips ? (
          <div className={`mr-flowmap-top${toggle || chips ? ' has-toggle' : ''}`}>
            {chips}
            {projection ? (
              <div className="mr-flowmap-chip" data-testid="projection-chip">
                {t('flow.projectionChip')}
              </div>
            ) : null}
            {weightToggle}
            {phone ? (
              <span className="mr-flowmap-toggle" data-testid="flow-view-toggle">
                <Button variant="tertiary" size="sm" onPress={() => setMapOnPhone((v) => !v)} aria-pressed={mapOnPhone}>
                  {mapOnPhone ? t('flow.list.showList') : t('flow.list.showMap')}
                </Button>
              </span>
            ) : null}
          </div>
        ) : null}
        {diagram}
        {foot}
      </section>
      <aside ref={asideRef} className={`mr-flowmap-card${flash > 0 ? ' is-flash' : ''}`} data-flash={flash > 0 ? '1' : undefined}>
        {receipt}
      </aside>
    </div>
  );
}
