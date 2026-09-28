// src/views/Story/Callouts.tsx — the callout layer (PRD 15.3a, DESIGN_BRIEF §8): for each callout whose
// moment has come, a label in the caption face and a leader line to the element carrying the matching
// `data-callout` id, so a viewer at a booth gets "this is the commit, this is who deployed it" pointing
// without anyone talking.
//
// Positions are measured, not designed: while callouts are up, the targets are read with
// getBoundingClientRect and handed to layoutCallouts (src/story/layout.ts), which keeps each label off
// every target of the beat, off the caption rail and the top bar, off the other labels, and as clear of
// the page's own text as it can; a label keeps its spot while that stays legal. The layer measures the
// moment a callout or the beat changes, on the next frame (the labels have their size), whenever the stage
// resizes and the fonts land, and every 250 ms after that — not on every animation frame (P1-C05: that
// was a second 60 fps loop beside the Meter's). So a resize, a theme switch, a card that has slid in or a
// number that has ticked all reflow it, and a label never covers what it names.
// The layer is `aria-hidden`: the caption rail is the spoken channel.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { StoryCallout } from '../../../core/types.ts';
import { DOT_OFFSET, DOT_RADIUS, layoutCallouts, type Placement, type Rect, type Side, type SoftRect } from '../../story/layout.ts';

/** Where each label would rather sit (a hint; the layout keeps whatever is legal and clearest). */
const PREFER: Readonly<Record<string, readonly Side[]>> = {
  whp: ['top', 'bottom'],
  paid: ['bottom', 'top'],
  saved: ['right', 'top', 'left'],
  'change-marker': ['left', 'bottom', 'top'],
  commit: ['top', 'bottom'],
  author: ['top', 'bottom', 'right'],
  'per-day': ['right', 'top', 'left'],
  'slack-message': ['right', 'left', 'top', 'bottom'],
  'receipt-total': ['right', 'left', 'bottom'],
  qr: ['right', 'left', 'top'],
  'flow-plate': ['top', 'bottom'],
  'flow-saved': ['bottom', 'top', 'right'],
};

/** How often a standing label re-checks its spot (targets that move by themselves settle well within it). */
const REMEASURE_MS = 250;

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};
const seen = (r: Rect): boolean => r.w > 0.5 && r.h > 0.5;

/**
 * The box of what an element SHOWS: a block paragraph's box spans its column, but its words may end
 * halfway — the rest is room for a label. HTML elements are measured by their contents (a Range);
 * SVG shapes and empty boxes (a bar segment) by themselves.
 */
function inkRect(el: Element): Rect {
  const box = rectOf(el);
  if (!(el instanceof HTMLElement) || el.childNodes.length === 0) return box;
  const range = document.createRange();
  range.selectNodeContents(el);
  const r = range.getBoundingClientRect();
  if (!(r.width > 0.5 && r.height > 0.5)) return box;
  const x = Math.max(box.x, r.left);
  const y = Math.max(box.y, r.top);
  const w = Math.min(box.x + box.w, r.right) - x;
  const h = Math.min(box.y + box.h, r.bottom) - y;
  return w > 0.5 && h > 0.5 ? { x, y, w, h } : box;
}

/** A scene fading out (index.tsx): nothing in it is pointed at or avoided. */
const leaving = (el: Element): boolean => el.closest('[data-leaving="true"]') !== null;

/**
 * W3-STAGE-3: a target may name where its dot goes (`data-callout-dot="dx,dy"`, px from its box's top-left): the
 * Flow map's saved plate points its dot at a spot on its own hatched wedge (stages.tsx). Null when it names none.
 */
function anchorOf(el: Element): { x: number; y: number } | null {
  const raw = el.getAttribute('data-callout-dot');
  if (!raw) return null;
  const [dx, dy] = raw.split(',').map(Number);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const box = rectOf(el);
  return { x: box.x + dx, y: box.y + dy };
}

/** The visible target for a callout id inside the stage (the first one that has a box, in the live scene). */
function findTarget(stage: HTMLElement, id: string): Element | null {
  for (const el of stage.querySelectorAll(`[data-callout="${CSS.escape(id)}"]`)) if (!leaving(el) && seen(rectOf(el))) return el;
  return null;
}

/** The callout ids of an element and every element around it (the words' owners: a leader may cross its own). */
function ownersOf(el: Element): string[] {
  const out: string[] = [];
  for (let a: Element | null = el.closest('[data-callout]'); a; a = a.parentElement?.closest('[data-callout]') ?? null) {
    const id = a.getAttribute('data-callout');
    if (id) out.push(id);
  }
  return out;
}

/** Glyphs up to this size (an icon beside a commit, the clock) are obstacles like words; a chart is not. */
const GLYPH_PX = 40;

/**
 * The page's own words (HTML text and SVG <text>) and small glyphs, as boxes a label should avoid covering and
 * a leader should not cross (P1-C03). Words are measured per rendered line — a Range over each text node — so
 * "$1,250 a day" is its own box and a line that ends early leaves the rest of its row free for a label. Each
 * box names the callout targets around it: a leader may run through its own target's words. A chart's plot
 * area is fair game (a label may sit on a gridline), not its tick labels. An odometer's off-screen digit cells
 * would read as text above and below the number, so a Meter counts as its one visible box; visually hidden
 * text is not on the page.
 */
function textRects(stage: HTMLElement): SoftRect[] {
  const out: SoftRect[] = [];
  for (const meter of stage.querySelectorAll('[data-testid="meter"]')) if (!leaving(meter)) out.push({ ...rectOf(meter), owners: ownersOf(meter) });
  const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const owners = new Map<Element, string[]>();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const el = node.parentElement;
    if (!el || !node.textContent || node.textContent.trim() === '') continue;
    if (el.closest('[data-testid="meter"], .mr-visually-hidden') || leaving(el)) continue;
    let own = owners.get(el);
    if (!own) {
      own = ownersOf(el);
      owners.set(el, own);
    }
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width > 0.5 && r.height > 0.5) out.push({ x: r.left, y: r.top, w: r.width, h: r.height, owners: own });
  }
  for (const svg of stage.querySelectorAll('svg')) {
    if (leaving(svg) || svg.closest('[data-testid="meter"]')) continue;
    const r = rectOf(svg);
    if (seen(r) && r.w <= GLYPH_PX && r.h <= GLYPH_PX) out.push({ ...r, owners: ownersOf(svg), glyph: true });
  }
  return out;
}

/** Cards and header bands a label sits wholly inside or wholly outside (never across an edge). */
const EDGES = '.mr-takeover, .mr-tk-head, .mr-st-panel, .mr-slack, .mr-slack-pre, .mr-qr-plate';

function edgeRects(stage: HTMLElement): Rect[] {
  return [...stage.querySelectorAll(EDGES)].filter((el) => !leaving(el)).map(rectOf).filter(seen);
}

function samePlacements(a: readonly Placement[], b: readonly Placement[]): boolean {
  if (a.length !== b.length) return false;
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5;
  return a.every((p, i) => {
    const q = b[i];
    return (
      p.id === q.id &&
      near(p.label.x, q.label.x) &&
      near(p.label.y, q.label.y) &&
      near(p.from.x, q.from.x) &&
      near(p.from.y, q.from.y) &&
      near(p.to.x, q.to.x) &&
      near(p.to.y, q.to.y) &&
      near(p.via?.x ?? -1, q.via?.x ?? -1) &&
      near(p.via?.y ?? -1, q.via?.y ?? -1)
    );
  });
}

export interface CalloutLayerProps {
  /** callouts whose moment has come */
  visible: readonly StoryCallout[];
  /** every callout of the beat (their targets are off-limits from the start) */
  all: readonly StoryCallout[];
  /**
   * the callouts of the current caption line, up or still to come: placed together, so a later label finds the
   * room the earlier ones left it and none of them moves when it arrives (P1-C03). Defaults to `visible`.
   */
  group?: readonly StoryCallout[];
  /** changes whenever the beat does (drops stickiness from the last beat) */
  beatKey: string;
  stageRef: RefObject<HTMLElement | null>;
  /** regions no label may cover (caption rail, top bar) */
  avoidRefs: readonly RefObject<HTMLElement | null>[];
  reducedMotion: boolean;
}

export function CalloutLayer({ visible, all, group: groupProp, beatKey, stageRef, avoidRefs, reducedMotion }: CalloutLayerProps) {
  const [placements, setPlacements] = useState<Placement[]>([]);
  const labels = useRef(new Map<string, HTMLSpanElement>());
  const previous = useRef<{ key: string; list: Placement[] }>({ key: beatKey, list: [] });
  // The line's callouts in play order, the visible ones always among them.
  const group = [...(groupProp ?? []), ...visible.filter((c) => !(groupProp ?? []).some((g) => g.target === c.target))];
  const latest = useRef({ visible, all, group, beatKey, avoidRefs });
  useLayoutEffect(() => {
    latest.current = { visible, all, group, beatKey, avoidRefs };
  });

  const ids = visible.map((c) => c.target).join('|');
  const groupIds = group.map((c) => c.target).join('|');

  useEffect(() => {
    // Nothing to point at: stale placements are simply not drawn (only visible callouts render).
    if (ids === '') return;
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const stage = stageRef.current;
      const { group: g, all: every, beatKey: key, avoidRefs: avoid } = latest.current;
      if (!stage) return;
      if (previous.current.key !== key) previous.current = { key, list: [] };
      const inputs = g
        .map((c) => {
          const el = findTarget(stage, c.target);
          const label = labels.current.get(c.target);
          if (!el || !label) return null;
          const anchor = anchorOf(el);
          return { id: c.target, target: inkRect(el), size: { w: label.offsetWidth, h: label.offsetHeight }, prefer: PREFER[c.target], ...(anchor ? { anchor } : {}) };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const upcoming = every
        .filter((c) => !g.some((x) => x.target === c.target))
        .map((c) => findTarget(stage, c.target))
        .filter((el): el is Element => el !== null)
        .map(inkRect);
      const hard = [...upcoming, ...avoid.map((r) => (r.current ? rectOf(r.current) : null)).filter((r): r is Rect => r !== null && seen(r))];
      const bounds = rectOf(stage);
      const small = bounds.w < 640;
      // The label's gap and the dot's clearance both grow with the stage, so on a projector the dot sits
      // clear of "$456,250 a year" instead of on its last glyph.
      const gap = small ? 18 : Math.min(48, Math.max(24, bounds.w * 0.022));
      const next = layoutCallouts(inputs, {
        bounds,
        gap,
        margin: small ? 8 : 16,
        hard,
        soft: textRects(stage),
        edges: edgeRects(stage),
        previous: previous.current.list,
        dotClearance: small ? DOT_OFFSET : Math.max(DOT_OFFSET, Math.round(gap / 6)),
      });
      previous.current.list = next;
      setPlacements((p) => (samePlacements(p, next) ? p : next));
    };
    measure();
    const frame = window.requestAnimationFrame(measure);
    const timer = window.setInterval(measure, REMEASURE_MS);
    const stage = stageRef.current;
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (resize && stage) resize.observe(stage);
    void document.fonts?.ready.then(measure);
    return () => {
      alive = false;
      window.cancelAnimationFrame(frame);
      window.clearInterval(timer);
      resize?.disconnect();
    };
  }, [ids, groupIds, beatKey, stageRef]);

  const byId = new Map(placements.map((p) => [p.id, p]));
  return (
    <div className="mr-st-callouts" data-story-callouts="" data-reduced={reducedMotion ? 'true' : 'false'} aria-hidden="true">
      <svg className="mr-st-leaders" width="100%" height="100%">
        {visible.map((c) => {
          const p = byId.get(c.target);
          if (!p) return null;
          const long = Math.hypot(p.to.x - p.from.x, p.to.y - p.from.y) > 3;
          return (
            <g key={c.target} className="mr-st-leader" data-target={c.target} data-clean={String(p.clean)}>
              {p.via ? (
                // An elbow along a gutter (P1-C03): one stroke, a square corner.
                <polyline points={`${p.from.x},${p.from.y} ${p.via.x},${p.via.y} ${p.to.x},${p.to.y}`} />
              ) : long ? (
                <line x1={p.from.x} y1={p.from.y} x2={p.to.x} y2={p.to.y} />
              ) : null}
              <circle cx={p.to.x} cy={p.to.y} r={DOT_RADIUS} />
            </g>
          );
        })}
      </svg>
      {/* The line's labels still to come: measured (their size is part of the plan), never shown. */}
      {group
        .filter((c) => !visible.some((v) => v.target === c.target))
        .map((c) => (
          <span
            key={`measure:${c.target}`}
            ref={(el) => {
              if (el) labels.current.set(c.target, el);
              else if (labels.current.get(c.target)?.classList.contains('mr-st-callout-measure')) labels.current.delete(c.target);
            }}
            className="mr-st-callout-measure"
          >
            {c.label}
          </span>
        ))}
      {visible.map((c) => {
        const p = byId.get(c.target);
        return (
          <span
            key={c.target}
            ref={(el) => {
              if (el) labels.current.set(c.target, el);
              else labels.current.delete(c.target);
            }}
            className="mr-st-callout"
            data-target={c.target}
            data-placed={p ? 'true' : 'false'}
            data-ok={p ? String(p.ok) : undefined}
            data-clean={p ? String(p.clean) : undefined}
            style={p ? { transform: `translate(${p.label.x}px, ${p.label.y}px)` } : undefined}
          >
            {c.label}
          </span>
        );
      })}
    </div>
  );
}
