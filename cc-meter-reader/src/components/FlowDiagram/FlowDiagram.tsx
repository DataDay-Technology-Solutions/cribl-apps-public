// src/components/FlowDiagram/FlowDiagram.tsx — the SVG Flow map (PRD 8.2, 8.8 item 5; DESIGN_BRIEF 5.3).
//
// Draws a precomputed FlowLayout (layout.ts), eased to each new layout (a live snapshot over 1.2 s so a ribbon is
// SEEN to narrow and its wedge to grow; a re-fit over 200 ms; the What-if morph over 400 ms). Ribbons are coloured
// by their Source (sourceColors.ts; destinations and pipelines are ink); the saved wedge is a hatched region of the same ribbon; money sits on backing plates; a slow dash
// drift runs inside the highlighted path only (≥ 8 s a cycle), paused off screen and under reduced motion, so an
// idle map does not repaint (P1-I08).
// Nodes are keyboard-navigable: Tab reaches them, arrows move within and across columns, Enter pins a path,
// Escape clears. After the nodes, Tab reaches each ribbon, top to bottom (P1-I05), so a keyboard user can read one
// flow's receipt. Hover/focus reports a selection; the parent renders the one receipt card.

import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../../copy/en.ts';
import { formatMoney } from '../../lib/format.ts';
import { useOnScreen, useTweenedLayout } from './hooks.ts';
import { pathFlowKeys, type FlowSelection } from './selection.ts';
import { hueClass } from './sourceColors.ts';
import {
  bandPath,
  centerLinePath,
  solidPath,
  wedgePath,
  type FlowLayout,
  type LayoutLabel,
  type LayoutNode,
  type LayoutRibbon,
} from './layout.ts';

export interface FlowDiagramProps {
  layout: FlowLayout;
  selection: FlowSelection;
  pinned: boolean;
  onHover(selection: FlowSelection): void;
  onPin(selection: FlowSelection): void;
  ariaLabel: string;
  /** Ease duration when the layout changes (0 = jump). */
  tweenMs?: number;
  /** A change of this key marks a user-initiated morph (the What-if), eased over `morphMs` instead. */
  morphKey?: string;
  morphMs?: number;
  /** The projection's styling (dashed, ghosted) applies to projected ribbons and nodes. */
  projection?: boolean;
  /**
   * Whether the other labels step back while a path is highlighted (P1-I03). Off while the highlight is only the
   * What-if's resting focus, so a projection at rest keeps every label at full contrast.
   */
  dimLabels?: boolean;
}

const DRIFT_MIN_WIDTH = 4;
const LINE_HEIGHT = { name: 19, money: 20, caption: 16 } as const;

function ribbonClass(r: LayoutRibbon, active: Set<string>): string {
  // a folded "smaller flows" ribbon keeps the fold's own grey (is-other); every other ribbon its Source's hue
  const parts = ['mr-flow-ribbon'];
  if (!r.folded) parts.push(hueClass(r.hue));
  if (active.size > 0) parts.push(active.has(r.flowKey) ? 'is-active' : 'is-dim');
  if (r.projected) parts.push('is-projected');
  if (r.folded) parts.push('is-other');
  if (r.mark) parts.push('is-incident', `is-incident--${r.mark}`);
  return parts.join(' ');
}

function Ribbon({ r, hatch, active, onEnter, onPin }: { r: LayoutRibbon; hatch: string; active: Set<string>; onEnter: () => void; onPin: () => void }) {
  const { s1, s2 } = r;
  const wedge = wedgePath(s2);
  // the drift runs on the highlighted path only (hover, focus, pin, the What-if stream): nobody watches it elsewhere
  const lit = active.has(r.flowKey);
  const drift = lit && s1.w >= DRIFT_MIN_WIDTH;
  const drift2 = lit && s2.wOut >= DRIFT_MIN_WIDTH;
  return (
    <g
      className={ribbonClass(r, active)}
      data-ribbon={r.id}
      data-flow={r.flowKey}
      data-hue={r.hue === undefined ? undefined : r.hue + 1}
      data-pipe={r.pipeId}
      data-weight={r.weight}
      // what the band measures (P1-I01): its would-have-paid, and the width it is drawn at
      data-whp={r.flow.whpPerDayM}
      data-in={r.flow.inBPerDay}
      data-incident={r.mark}
      data-sink={r.sinkId ? '1' : undefined}
      data-wedge-w={Math.round(Math.max(0, r.s2.wIn - r.s2.wOut) * 100) / 100}
      data-band-w={Math.round(r.s1.w * 100) / 100}
      // Byte map only: √($/GB ÷ the map's highest $/GB), turned into band opacity (cheap flows fade). 1 on the dollar map.
      style={{ ['--mr-band-w' as string]: String(r.weight) }}
      onPointerEnter={onEnter}
      onClick={onPin}
    >
      <path className="mr-flow-band" d={bandPath(s1.x0, s1.top0, s1.x1, s1.top1, s1.w)} />
      <path className="mr-flow-band" d={solidPath(s2)} />
      {wedge ? <path className="mr-flow-wedge" d={wedge} fill={`url(#${hatch})`} data-wedge={r.id} /> : null}
      {drift ? <path className="mr-flow-drift" d={centerLinePath(s1.x0, s1.top0 + s1.w / 2, s1.x1, s1.top1 + s1.w / 2)} /> : null}
      {drift2 ? <path className="mr-flow-drift" d={centerLinePath(s2.x0, s2.top0 + s2.wOut / 2, s2.x1, s2.top1 + s2.wOut / 2)} /> : null}
      {r.projected ? (
        <>
          <path className="mr-flow-outline" d={bandPath(s1.x0, s1.top0, s1.x1, s1.top1, s1.w)} />
          <path className="mr-flow-outline" d={solidPath(s2)} />
        </>
      ) : null}
      {/* an incident on this flow (P2-W16): the whole ribbon outlined, dashed, in the alert's tone */}
      {r.mark ? (
        <>
          <path className="mr-flow-incident" d={bandPath(s1.x0, s1.top0, s1.x1, s1.top1, s1.w)} />
          <path className="mr-flow-incident" d={bandPath(s2.x0, s2.top0, s2.x1, s2.top1, s2.wOut)} />
        </>
      ) : null}
    </g>
  );
}

function Label({ l, dim, scale }: { l: LayoutLabel; dim: boolean; scale: number }) {
  const pad = l.plate ? 6 * scale : 0;
  const lh = (role: LayoutLabel['lines'][number]['role']) => LINE_HEIGHT[role] * scale;
  const tx = l.anchor === 'start' ? l.x + pad : l.anchor === 'end' ? l.x + l.w - pad : l.x + l.w / 2;
  const tops = l.lines.reduce<number[]>((acc, _line, i) => [...acc, i === 0 ? l.y : acc[i - 1] + lh(l.lines[i - 1].role)], []);
  const cls = ['mr-flow-label', `mr-flow-label--${l.kind}`];
  if (dim) cls.push('is-dim');
  if (l.halo) cls.push('has-halo');
  if (l.tone) cls.push(`is-${l.tone}`);
  // mid-tween, a plate new in the target fades in with the wedge it labels
  const style = l.appear !== undefined && l.appear < 1 ? { opacity: l.appear } : undefined;
  return (
    <g
      className={cls.join(' ')}
      data-label={l.id}
      data-full={l.full}
      data-in-band={l.inBand === undefined ? undefined : l.inBand ? '1' : '0'}
      aria-hidden="true"
      style={style}
    >
      {/* a pipeline's name is one line (OQ-08): its whole name is always in the <title>, truncated or not */}
      {l.truncated || l.kind === 'node-pipe' ? <title>{l.full}</title> : null}
      {/* a saved plate that had to leave its band points back to its wedge (P1-I02) */}
      {l.leader ? <line className="mr-flow-leader" x1={l.leader.x1} y1={l.leader.y1} x2={l.leader.x2} y2={l.leader.y2} /> : null}
      {l.plate ? <rect className="mr-flow-plate" x={l.x} y={l.y} width={l.w} height={l.h} rx={4 * scale} /> : null}
      {/* A name over a ribbon or a hatched wedge sits on a pill in the panel colour (craft review, round 1: a halo
          alone still read as words drawn over the bands). Its own box, widened a little on each side only. */}
      {!l.plate && l.halo ? <rect className="mr-flow-pill" x={l.x - 3 * scale} y={l.y} width={l.w + 6 * scale} height={l.h} rx={4 * scale} /> : null}
      {l.lines.map((line, i) => {
        const cy = tops[i] + lh(line.role) / 2;
        return (
          <text key={i} className={`mr-flow-text mr-flow-text--${line.role}`} x={tx} y={cy} textAnchor={l.anchor} dominantBaseline="central">
            {line.text}
          </text>
        );
      })}
    </g>
  );
}

/** The node or ribbon that holds keyboard focus inside the map, as a selection (null when focus is elsewhere). */
function focusedSelection(svg: SVGSVGElement | null): FlowSelection {
  const el = typeof document === 'undefined' ? null : document.activeElement;
  if (!svg || !el || !svg.contains(el)) return null;
  const ribbon = el.getAttribute('data-ribbon-key');
  if (ribbon) return { kind: 'ribbon', id: ribbon };
  const node = el.getAttribute('data-node');
  return node ? { kind: 'node', id: node } : null;
}

/** What a screen reader hears on a ribbon: its whole path and its money. */
function ribbonAria(layout: FlowLayout, r: LayoutRibbon): string {
  const name = (id: string) => layout.nodes.find((n) => n.id === id)?.name ?? '';
  return t('flow.ribbonAria', {
    source: name(r.sourceId),
    pipeline: name(r.pipeId),
    destination: name(r.destId),
    whp: formatMoney(r.flow.whpPerDayM),
    saved: formatMoney(r.flow.savedPerDayM),
  });
}

/** Keyboard neighbour of a node: up/down within its column, left/right to the nearest connected node. */
function neighbour(layout: FlowLayout, current: LayoutNode, key: string): LayoutNode | undefined {
  const column = layout.nodes.filter((n) => n.kind === current.kind).sort((a, b) => a.y0 - b.y0);
  const i = column.findIndex((n) => n.id === current.id);
  if (key === 'ArrowDown') return column[Math.min(column.length - 1, i + 1)];
  if (key === 'ArrowUp') return column[Math.max(0, i - 1)];
  const order: LayoutNode['kind'][] = ['in', 'pipe', 'out'];
  const next = order[order.indexOf(current.kind) + (key === 'ArrowRight' ? 1 : -1)];
  if (!next) return undefined;
  const linked = new Set<string>();
  for (const r of layout.ribbons) {
    if (![r.sourceId, r.pipeId, r.destId].includes(current.id)) continue;
    linked.add(next === 'in' ? r.sourceId : next === 'pipe' ? r.pipeId : r.destId);
  }
  const cy = (current.y0 + current.y1) / 2;
  return layout.nodes
    .filter((n) => n.kind === next && (linked.size === 0 || linked.has(n.id)))
    .sort((a, b) => Math.abs((a.y0 + a.y1) / 2 - cy) - Math.abs((b.y0 + b.y1) / 2 - cy))[0];
}

export function FlowDiagram({ layout: target, selection, pinned, onHover, onPin, ariaLabel, tweenMs = 200, morphKey = '', morphMs = 400, projection = false, dimLabels = true }: FlowDiagramProps) {
  const { layout, tween } = useTweenedLayout(target, tweenMs, morphKey, morphMs);
  const rawId = useId();
  const uid = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  const hatch = `mr-flow-hatch-${uid}`;
  const hintId = `mr-flow-hint-${uid}`;
  const [focused, setFocused] = useState<string | null>(null);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const svgRef = useRef<SVGSVGElement>(null);
  const onScreen = useOnScreen(svgRef);

  const active = useMemo(() => pathFlowKeys(target, selection), [target, selection]);
  const activeNodes = useMemo(() => {
    const ids = new Set<string>();
    for (const r of target.ribbons) if (active.has(r.flowKey)) [r.sourceId, r.pipeId, r.destId, r.sinkId].forEach((id) => id && ids.add(id));
    return ids;
  }, [target, active]);

  const onNodeKey = (n: LayoutNode) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPin({ kind: 'node', id: n.id });
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onPin(null);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = neighbour(target, n, e.key);
      if (next) nodeRefs.current.get(next.id)?.focus();
    }
  };

  const focusedNode = focused ? layout.nodes.find((n) => n.id === focused) : undefined;
  // ribbons in reading order for the keyboard: top to bottom by where they leave their source
  const ribbonKeys = useMemo(() => [...layout.ribbons].sort((a, b) => a.s1.top0 - b.s1.top0 || (a.id < b.id ? -1 : 1)), [layout]);

  return (
    <svg
      ref={svgRef}
      className={`mr-flow-svg${projection ? ' is-projection' : ''}${active.size > 0 ? ' has-selection' : ''}${onScreen ? '' : ' is-paused'}${layout.scale > 1 ? ' is-scaled' : ''}`}
      style={layout.scale > 1 ? { ['--mr-flow-scale' as string]: String(layout.scale) } : undefined}
      data-scale={layout.scale}
      width={layout.width}
      height={Math.round(layout.height)}
      viewBox={`0 0 ${layout.width} ${Math.round(layout.height)}`}
      role="group"
      aria-label={ariaLabel}
      aria-describedby={hintId}
      // The pointer leaving (or a scroll moving the map from under it) hands the card back to whatever holds keyboard
      // focus in the map, so a focused node or ribbon keeps its receipt (P1-I05).
      onPointerLeave={() => onHover(focusedSelection(svgRef.current))}
      data-testid="flow-diagram"
      data-tween={tween ?? undefined}
      data-weight-by={layout.weightBy}
      data-total-whp={layout.totalWhpPerDayM}
    >
      <desc id={hintId}>{t('flow.keyboardHint')}</desc>
      <defs>
        <pattern id={hatch} patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
          <rect className="mr-flow-hatch-bg" width={6} height={6} />
          <line className="mr-flow-hatch-line" x1={1.5} y1={0} x2={1.5} y2={6} />
        </pattern>
      </defs>

      <g className="mr-flow-ribbons">
        {layout.ribbons.map((r) => (
          <Ribbon
            key={r.id}
            r={r}
            hatch={hatch}
            active={active}
            onEnter={() => onHover({ kind: 'ribbon', id: r.id })}
            onPin={() => onPin(pinned && selection?.kind === 'ribbon' && selection.id === r.id ? null : { kind: 'ribbon', id: r.id })}
          />
        ))}
      </g>

      <g className="mr-flow-nodes">
        {layout.nodes.map((n) => {
          const cls = ['mr-flow-node', `mr-flow-node--${n.kind}`];
          if (active.size > 0) cls.push(activeNodes.has(n.id) ? 'is-active' : 'is-dim');
          if (n.projected) cls.push('is-projected');
          if (n.other) cls.push('is-other');
          if (n.sink) cls.push('mr-flow-node--sink');
          // a Source wears its hue, as its bands do; a destination is ink, like a pipeline, so no source shares its
          // destination's colour (the owner, D55)
          if (n.kind === 'in' && !n.other) cls.push(hueClass(n.hue));
          const aria = n.sink
            ? t('flow.sink.aria', { saved: formatMoney(n.totals.savedPerDayM) })
            : t('flow.nodeAria', {
                kind: t(`flow.kind.${n.kind}`),
                name: n.name,
                whp: formatMoney(n.totals.whpPerDayM),
                saved: formatMoney(n.totals.savedPerDayM),
              });
          const isPinned = pinned && selection?.kind === 'node' && selection.id === n.id;
          return (
            <g
              key={n.id}
              ref={(el) => {
                if (el) nodeRefs.current.set(n.id, el);
                else nodeRefs.current.delete(n.id);
              }}
              className={cls.join(' ')}
              data-node={n.id}
              data-hue={n.hue === undefined ? undefined : n.hue + 1}
              tabIndex={0}
              role="button"
              aria-label={aria}
              aria-pressed={isPinned}
              onPointerEnter={() => onHover({ kind: 'node', id: n.id })}
              onFocus={() => {
                setFocused(n.id);
                onHover({ kind: 'node', id: n.id });
              }}
              onBlur={() => {
                setFocused((f) => (f === n.id ? null : f));
                onHover(null);
              }}
              onClick={() => onPin(isPinned ? null : { kind: 'node', id: n.id })}
              onKeyDown={onNodeKey(n)}
            >
              {/* a wider invisible hit area so thin nodes are easy to hover and tap */}
              <rect className="mr-flow-node-hit" x={n.x0 - 8} y={n.y0 - 4} width={n.x1 - n.x0 + 16} height={Math.max(8, n.y1 - n.y0) + 8} />
              <rect
                className="mr-flow-node-bar"
                x={n.x0}
                y={n.y0}
                width={n.x1 - n.x0}
                height={Math.max(1, n.y1 - n.y0)}
                rx={2}
                // the sink is the hatched green the wedges are made of (P2-W16); inline, over the node's class fill
                style={n.sink ? { fill: `url(#${hatch})` } : undefined}
              />
            </g>
          );
        })}
      </g>

      <g className="mr-flow-labels">
        {layout.labels.map((l) => {
          const owner = l.kind.startsWith('node') ? activeNodes.has(l.ownerId) : target.ribbons.some((r) => r.id === l.ownerId && active.has(r.flowKey));
          return <Label key={l.id} l={l} dim={dimLabels && active.size > 0 && !owner} scale={layout.scale} />;
        })}
      </g>

      {/* One focus target per ribbon, after the nodes in the tab order (P1-I05). Pointer events pass through to the
          ribbon itself; the outline shows only while the target has keyboard focus. */}
      <g className="mr-flow-ribbon-keys">
        {ribbonKeys.map((r) => (
          <path
            key={r.id}
            className="mr-flow-ribbon-key"
            d={`${bandPath(r.s1.x0, r.s1.top0, r.s1.x1, r.s1.top1, r.s1.w)}${bandPath(r.s2.x0, r.s2.top0, r.s2.x1, r.s2.top1, r.s2.wIn)}`}
            data-ribbon-key={r.id}
            tabIndex={0}
            role="button"
            aria-label={ribbonAria(layout, r)}
            aria-pressed={pinned && selection?.kind === 'ribbon' && selection.id === r.id}
            onFocus={() => onHover({ kind: 'ribbon', id: r.id })}
            onBlur={() => onHover(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPin(pinned && selection?.kind === 'ribbon' && selection.id === r.id ? null : { kind: 'ribbon', id: r.id });
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onPin(null);
              }
            }}
          />
        ))}
      </g>

      {focusedNode ? (
        <rect
          className="mr-flow-focus"
          x={focusedNode.x0 - 4}
          y={focusedNode.y0 - 4}
          width={focusedNode.x1 - focusedNode.x0 + 8}
          height={Math.max(1, focusedNode.y1 - focusedNode.y0) + 8}
          rx={4}
          aria-hidden="true"
        />
      ) : null}
    </svg>
  );
}
