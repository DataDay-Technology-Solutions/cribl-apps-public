// src/story/layout.ts — where each callout label goes and where its leader line runs (pure geometry).
//
// PRD 15.3a / DESIGN_BRIEF §8: a callout is a label in the caption face with a leader line to the exact
// element being talked about. The Story view measures the targets (getBoundingClientRect) and asks this
// module for placements on every reflow; nothing here touches the DOM, so it is unit-tested directly.
//
// Rules, in order of strength:
//   HARD  inside the bounds · never over ANY target of the beat (so a later callout's element is never
//         hidden by an earlier label) · never over the caption rail or another label
//   CLEAN (P1-C03) among the legal spots, one whose leader runs through no words but its own target's, whose
//         dot sits on none, and whose label lies wholly inside or wholly outside every card and header band
//         wins over any that does not — a straight leader first, else an elbow along a gutter; only when no
//         clean spot exists does the least-bad legal one stand (and says so: `clean: false`)
//   SOFT  prefer the target's preferred side, the nearest distance, centred alignment, as little of the
//         page's own text under the label as possible, and the shortest leader
//   STICKY a label keeps its previous spot while that spot stays legal, as clean, and nearly as good (no
//         jitter while a card slides in or a number ticks)

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Side = 'top' | 'bottom' | 'left' | 'right';
/**
 * Along the side: centred on the target, flush with its start or end, or wholly past it ('before' /
 * 'after': a diagonal leader into the clear space beside a dense row).
 */
export type Align = 'center' | 'start' | 'end' | 'before' | 'after';

export interface CalloutInput {
  id: string;
  target: Rect;
  /** measured label box */
  size: { w: number; h: number };
  /** sides to try first (the rest follow in the default order) */
  prefer?: readonly Side[];
  /**
   * Where the leader's dot goes, when that is not just outside the target (W3-STAGE-3: the Flow map's "$ saved"
   * plate is the target the label keeps clear of, and its dot sits on the plate's hatched wedge). The dot is placed
   * on this point exactly; the label still sits beside `target`.
   */
  anchor?: Point;
}

/** A box a label should not cover, and a leader should not cross unless it is one of `owners`' own words. */
export interface SoftRect extends Rect {
  /** the callout ids whose target holds these words (a leader may run through its own target's words) */
  owners?: readonly string[];
  /** a small glyph (an icon), not words: a leader may not cross it, but its dot may sit beside it */
  glyph?: boolean;
}

export interface Placement {
  id: string;
  side: Side;
  align: Align;
  /** for 'before' / 'after': how far past the target's edge (index into SLIDES) */
  slide: number;
  /** distance step (0 = nearest) */
  step: number;
  /**
   * Snapped past the card edge the plain spot straddled, along its side's axis: 'out' beyond it (away from the
   * target), 'in' back inside it (P1-C03: wholly inside or wholly outside a card)
   */
  snap?: Snap;
  label: Rect;
  /** leader line: from the label's edge to the target's edge */
  from: Point;
  to: Point;
  /**
   * An elbow: the leader runs from `from` to `via`, then to `to` (a vertical or horizontal run along a gutter
   * and a short hook into the target), when a straight line would cross words it does not point at.
   */
  via?: Point;
  /** false when no legal spot existed and this is the least-bad one */
  ok: boolean;
  /** legal, and the leader crosses no other words or targets, its dot touches none, the label straddles no card edge */
  clean: boolean;
}

export interface LayoutOptions {
  bounds: Rect;
  /** nearest gap between a target and its label, px */
  gap: number;
  /** keep labels this far inside the bounds, px */
  margin?: number;
  /** other rectangles a label must never cover (the caption rail, the exit control) */
  hard?: readonly Rect[];
  /**
   * the page's own words (and small glyphs): a label should avoid covering them, and a leader may cross only
   * its own target's (P1-C03: a crossing is illegal whenever a spot without one exists)
   */
  soft?: readonly SoftRect[];
  /**
   * card and band rectangles (the takeover, its header band, a panel, the Slack message, the QR plate): a label
   * sits wholly inside or wholly outside each, never across an edge
   */
  edges?: readonly Rect[];
  /** last layout, for stickiness */
  previous?: readonly Placement[];
  /** air between a target's ink and its dot's rim, px (default DOT_OFFSET; a wide stage affords more) */
  dotClearance?: number;
}

const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];
const ALIGNS: readonly Align[] = ['center', 'start', 'end', 'before', 'after'];
const STEPS = [0.5, 1, 1.9, 3, 4.4] as const;
/** How far past the target's edge a 'before' / 'after' label slides, px. */
const SLIDES = [8, 28, 56, 104] as const;

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5;
}

/** The point of `r` nearest to `p` (p itself when inside). */
export function nearestPoint(r: Rect, p: Point): Point {
  return { x: Math.min(Math.max(p.x, r.x), r.x + r.w), y: Math.min(Math.max(p.y, r.y), r.y + r.h) };
}

const center = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const clamp = (v: number, lo: number, hi: number): number => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));

/** The label box for one candidate, clamped inside the bounds. */
export function candidateRect(
  target: Rect,
  size: { w: number; h: number },
  side: Side,
  align: Align,
  distance: number,
  inner: Rect,
  past = distance * 0.4,
): { rect: Rect; shift: number } {
  let x: number;
  let y: number;
  if (side === 'top' || side === 'bottom') {
    y = side === 'top' ? target.y - distance - size.h : target.y + target.h + distance;
    x =
      align === 'center'
        ? target.x + target.w / 2 - size.w / 2
        : align === 'start'
          ? target.x
          : align === 'end'
            ? target.x + target.w - size.w
            : align === 'before'
              ? target.x - size.w - past
              : target.x + target.w + past;
  } else {
    x = side === 'left' ? target.x - distance - size.w : target.x + target.w + distance;
    y =
      align === 'center'
        ? target.y + target.h / 2 - size.h / 2
        : align === 'start'
          ? target.y
          : align === 'end'
            ? target.y + target.h - size.h
            : align === 'before'
              ? target.y - size.h - past
              : target.y + target.h + past;
  }
  const cx = clamp(x, inner.x, inner.x + inner.w - size.w);
  const cy = clamp(y, inner.y, inner.y + inner.h - size.h);
  return { rect: { x: cx, y: cy, w: size.w, h: size.h }, shift: Math.abs(cx - x) + Math.abs(cy - y) };
}

/** The leader's dot (the SVG circle's radius, without its stroke). */
export const DOT_RADIUS = 4.5;
/** Clear air between the target's ink and the dot's rim, so the dot never touches a glyph. */
export const DOT_OFFSET = 5;

/**
 * Leader line endpoints: `to` (the dot's centre) just outside the target edge nearest the label — the dot's
 * rim `clearance` px off the ink, but never more than halfway to the label — and `from` the label edge
 * nearest that point.
 */
export function leader(label: Rect, target: Rect, clearance = DOT_OFFSET): { from: Point; to: Point } {
  const edge = nearestPoint(target, center(label));
  const toward = nearestPoint(label, edge);
  const dx = toward.x - edge.x;
  const dy = toward.y - edge.y;
  const len = Math.hypot(dx, dy);
  const out = Math.min(clearance + DOT_RADIUS, len / 2);
  const to = len > 0 ? { x: edge.x + (dx / len) * out, y: edge.y + (dy / len) * out } : edge;
  const from = nearestPoint(label, to);
  return { from, to };
}

/** Whether the segment a→b passes through the rectangle (Liang–Barsky). */
export function segmentHits(a: Point, b: Point, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, a.x - r.x) && clip(dx, r.x + r.w - a.x) && clip(-dy, a.y - r.y) && clip(dy, r.y + r.h - a.y) && t0 < t1;
}

/** The share of a text line's box, above and below, that is leading rather than ink. */
const INK_LEADING = 0.12;
/** The shortest visible hook of an elbow leader, px (from its corner to the dot's centre). */
const MIN_HOOK = 12;
/** An elbow's corner keeps this far inside the label's own edge, px (the line leaves the label, not its corner). */
const ELBOW_INSET = 14;

interface Route {
  from: Point;
  to: Point;
  via?: Point;
  /** words, targets and labels the line runs through */
  crossings: number;
  /** the dot sits on words or a glyph it does not point at */
  touches: boolean;
  length: number;
  /** an anchored leader (W3-STAGE-3) running through its own target's words: allowed, but a spot that avoids it wins */
  ownCrossings?: number;
}

export type Snap = 'out' | 'in';

/** Air between a snapped label and the card edge it cleared, px. */
const SNAP_AIR = 8;

/**
 * A label box that straddles `edge`, moved along its side's axis to lie wholly beyond it (`out`: on the far side
 * of the edge it crossed, away from the target) or wholly within it (`in`). Null when it does not straddle.
 */
export function snapRect(rect: Rect, edge: Rect, side: Side, snap: Snap): Rect | null {
  if (!intersects(rect, edge) || contains(edge, rect)) return null;
  const vertical = side === 'top' || side === 'bottom';
  if (vertical) {
    // Which horizontal edge it crosses: the one nearer its centre.
    const cy = rect.y + rect.h / 2;
    const crossesTop = Math.abs(cy - edge.y) <= Math.abs(cy - (edge.y + edge.h));
    const y = crossesTop ? (snap === 'out' ? edge.y - rect.h - SNAP_AIR : edge.y + SNAP_AIR) : snap === 'out' ? edge.y + edge.h + SNAP_AIR : edge.y + edge.h - rect.h - SNAP_AIR;
    return { ...rect, y };
  }
  const cx = rect.x + rect.w / 2;
  const crossesLeft = Math.abs(cx - edge.x) <= Math.abs(cx - (edge.x + edge.w));
  const x = crossesLeft ? (snap === 'out' ? edge.x - rect.w - SNAP_AIR : edge.x + SNAP_AIR) : snap === 'out' ? edge.x + edge.w + SNAP_AIR : edge.x + edge.w - rect.w - SNAP_AIR;
  return { ...rect, x };
}

interface Scored {
  side: Side;
  align: Align;
  slide: number;
  step: number;
  snap?: Snap;
  rect: Rect;
  legal: boolean;
  hides: boolean;
  straddles: boolean;
  /** the score without the leader */
  base: number;
  /** set by `finish` */
  route?: Route;
  clean: boolean;
  score: number;
}

/**
 * The elbow leaders a label could use instead of a straight one: from its top or bottom edge along a vertical
 * run to the target's middle, then a hook into the target's left or right side (a label above or below a line
 * of words); or from its left or right edge along a horizontal run, then down or up into the target's top or
 * bottom (a label beside it). Each keeps its corner inside the label's span and its hook at least MIN_HOOK long.
 */
export function elbowRoutes(label: Rect, target: Rect, clearance = DOT_OFFSET): { from: Point; via: Point; to: Point }[] {
  const out: { from: Point; via: Point; to: Point }[] = [];
  const reach = clearance + DOT_RADIUS;
  const tcy = target.y + target.h / 2;
  const tcx = target.x + target.w / 2;
  const above = label.y + label.h <= tcy - MIN_HOOK;
  const below = label.y >= tcy + MIN_HOOK;
  if (above || below) {
    const edgeY = above ? label.y + label.h : label.y;
    const lo = label.x + ELBOW_INSET;
    const hi = label.x + label.w - ELBOW_INSET;
    const right = { x: target.x + target.w + reach, y: tcy };
    const cxR = Math.max(right.x + MIN_HOOK, lo);
    if (cxR <= hi) out.push({ from: { x: cxR, y: edgeY }, via: { x: cxR, y: tcy }, to: right });
    const left = { x: target.x - reach, y: tcy };
    const cxL = Math.min(left.x - MIN_HOOK, hi);
    if (cxL >= lo) out.push({ from: { x: cxL, y: edgeY }, via: { x: cxL, y: tcy }, to: left });
  }
  const leftOf = label.x + label.w <= target.x - MIN_HOOK;
  const rightOf = label.x >= target.x + target.w + MIN_HOOK;
  if (leftOf || rightOf) {
    const edgeX = leftOf ? label.x + label.w : label.x;
    const lcy = label.y + label.h / 2;
    const inset = Math.min(ELBOW_INSET, target.w / 2);
    // The drop lands as near the label as the target allows.
    const dx = leftOf ? Math.max(target.x + inset, edgeX + MIN_HOOK) : Math.min(target.x + target.w - inset, edgeX - MIN_HOOK);
    if (dx >= target.x && dx <= target.x + target.w && Math.abs(dx - tcx) <= target.w / 2) {
      const top = { x: dx, y: target.y - reach };
      if (lcy <= top.y - MIN_HOOK) out.push({ from: { x: edgeX, y: lcy }, via: { x: dx, y: lcy }, to: top });
      const bottom = { x: dx, y: target.y + target.h + reach };
      if (lcy >= bottom.y + MIN_HOOK) out.push({ from: { x: edgeX, y: lcy }, via: { x: dx, y: lcy }, to: bottom });
    }
  }
  return out;
}

const pathLength = (pts: readonly Point[]): number => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);

/** The shortest distance between two segments, px (0 when they cross). */
export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  const toSeg = (p: Point, q: Point, r: Point): number => {
    const dx = r.x - q.x;
    const dy = r.y - q.y;
    const len = dx * dx + dy * dy;
    const t = len > 0 ? Math.min(1, Math.max(0, ((p.x - q.x) * dx + (p.y - q.y) * dy) / len)) : 0;
    return Math.hypot(p.x - (q.x + t * dx), p.y - (q.y + t * dy));
  };
  return Math.min(toSeg(a, c, d), toSeg(b, c, d), toSeg(c, a, b), toSeg(d, a, b));
}

/** Two leaders closer than this read as one line (or a knot), px. */
const LEADER_AIR = 8;
/** How many clean spots of an earlier label the search tries before it settles for a later one being unclean. */
const SEARCH_WIDTH = 4;

/** A placed leader, as segments. */
const leaderSegments = (p: Pick<Placement, 'from' | 'to' | 'via'>): [Point, Point][] => (p.via ? [[p.from, p.via], [p.via, p.to]] : [[p.from, p.to]]);

/**
 * Places every callout. Earlier ones get the better spots; when that leaves a later one no clean spot, the
 * earlier ones try their next clean spots (a small search), so the set comes out clean whenever one exists.
 * A label never covers another label or another leader, and leaders keep LEADER_AIR apart.
 */
export function layoutCallouts(inputs: readonly CalloutInput[], opts: LayoutOptions): Placement[] {
  const margin = opts.margin ?? 8;
  const inner: Rect = { x: opts.bounds.x + margin, y: opts.bounds.y + margin, w: opts.bounds.w - 2 * margin, h: opts.bounds.h - 2 * margin };
  const targets = inputs.map((i) => inflate(i.target, 4));
  const hard = opts.hard ?? [];
  const edges = opts.edges ?? [];
  // Text keeps a little air around it (for covering); a line may pass closer than a label may sit.
  const softIn = opts.soft ?? [];
  const soft = softIn.map((r) => inflate(r, 4));
  // Where a line of words actually inks: its box less the leading above and below (a 24 px label may sit in the
  // gutter between two rows whose boxes touch).
  const inks = softIn.map((r) => (r.glyph ? r : { x: r.x, y: r.y + r.h * INK_LEADING, w: r.w, h: r.h * (1 - 2 * INK_LEADING) }));

  /** The spots for one callout given those already placed: up to `width` clean ones by score, else the best legal (or least-bad) one. */
  const rank = (input: CalloutInput, placed: readonly Placement[], width: number): Scored[] => {
    const order = [...(input.prefer ?? []), ...SIDES.filter((s) => !(input.prefer ?? []).includes(s))];
    const area = Math.max(1, input.size.w * input.size.h);
    const own = inflate(input.target, 2);
    // Words a leader may not run through: every word but its own target's (owners known), or, for boxes with
    // no owners, every box clear of its target.
    const mine = (r: SoftRect): boolean => (r.owners ? r.owners.includes(input.id) : intersects(r, own));
    const words = softIn.filter((r) => !mine(r));
    const lineObstacles = words.map((r) => inflate(r, 2));
    const others = targets.filter((_, i) => inputs[i] !== input);
    const labels = placed.map((p) => inflate(p.label, 2));
    const leaders = placed.flatMap(leaderSegments);
    // Hot path (every candidate, every 250 ms): plain loops, a bounding-box reject before the clip test.
    const countHits = (a: Point, b: Point, rects: readonly Rect[]): number => {
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      let n = 0;
      for (const r of rects) if (r.x <= x1 && x0 <= r.x + r.w && r.y <= y1 && y0 <= r.y + r.h && segmentHits(a, b, r)) n++;
      return n;
    };
    const nearLeaders = (a: Point, b: Point): number => {
      let n = 0;
      for (const [c, d] of leaders) if (segmentDistance(a, b, c, d) < LEADER_AIR) n++;
      return n;
    };
    const cross = (a: Point, b: Point): number =>
      countHits(a, b, lineObstacles) + countHits(a, b, others) * 2 + countHits(a, b, labels) * 2 + nearLeaders(a, b) * 2;
    const dotTouches = (p: Point): boolean => {
      const dot = inflate({ x: p.x, y: p.y, w: 0, h: 0 }, DOT_RADIUS + 1);
      return words.some((r) => !r.glyph && intersects(dot, r)) || others.some((r) => intersects(dot, r));
    };
    // Many candidates clamp to the same box: route each box once.
    const routes = new Map<string, Route>();
    // An anchored callout's leader ends on its anchor (a zero-size aim, no clearance: the dot's centre on the point).
    const aim: Rect = input.anchor ? { x: input.anchor.x, y: input.anchor.y, w: 0, h: 0 } : input.target;
    const clearance = input.anchor ? -DOT_RADIUS : opts.dotClearance;
    // Its line ends off the target, so running through the target's own words is a cost there (not a foul).
    const ownWords = input.anchor ? softIn.filter(mine).map((r) => inflate(r, 2)) : [];
    const ownCross = (pts: readonly Point[]): number => pts.slice(1).reduce((n, p, i) => n + countHits(pts[i], p, ownWords), 0);
    const routeFor = (rect: Rect): Route => {
      const key = `${rect.x.toFixed(1)},${rect.y.toFixed(1)}`;
      const hit = routes.get(key);
      if (hit) return hit;
      const line = leader(rect, aim, clearance);
      const straight: Route = {
        ...line,
        crossings: cross(line.from, line.to),
        touches: dotTouches(line.to),
        length: Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y),
        ownCrossings: ownCross([line.from, line.to]),
      };
      let best = straight;
      if (straight.crossings > 0 || straight.touches)
        for (const e of elbowRoutes(rect, aim, clearance)) {
          const r: Route = {
            ...e,
            crossings: cross(e.from, e.via) + cross(e.via, e.to),
            touches: dotTouches(e.to),
            length: pathLength([e.from, e.via, e.to]),
            ownCrossings: ownCross([e.from, e.via, e.to]),
          };
          const bad = (x: Route) => x.crossings * 2 + (x.touches ? 1 : 0);
          if (bad(r) < bad(best) || (bad(r) === bad(best) && r.length < best.length && best.via)) best = r;
        }
      routes.set(key, best);
      return best;
    };
    const plain = (side: Side, align: Align, step: number, slide: number) => {
      const past = align === 'before' || align === 'after' ? SLIDES[slide] : 0;
      return candidateRect(input.target, input.size, side, align, opts.gap * STEPS[step], inner, past);
    };
    const evaluate = (side: Side, align: Align, step: number, slide = 0, snap?: Snap): Scored | null => {
      let { rect, shift } = plain(side, align, step, slide);
      if (snap) {
        const edge = edges.find((e) => intersects(rect, e) && !contains(e, rect));
        const moved = edge ? snapRect(rect, edge, side, snap) : null;
        if (!moved) return null;
        shift += Math.abs(moved.x - rect.x) + Math.abs(moved.y - rect.y);
        rect = moved;
      }
      const legal =
        contains(inner, rect) &&
        !targets.some((t) => intersects(rect, t)) &&
        !hard.some((h) => intersects(rect, h)) &&
        !placed.some((p) => intersects(rect, inflate(p.label, 6)));
      const covered = soft.reduce((sum, r) => sum + overlapArea(rect, r), 0) / area;
      // Clean also means the label hides no word at all (the air around words is only a preference), and no
      // leader already drawn.
      const box = inflate(rect, 2);
      const hides = inks.some((r) => intersects(rect, r)) || leaders.some(([a, b]) => segmentHits(a, b, box));
      const straddles = edges.some((e) => intersects(rect, e) && !contains(e, rect));
      // Everything but the leader: a lower bound on the full score (the leader only ever adds).
      const base =
        order.indexOf(side) * 40 +
        Math.abs(step - 1) * 14 +
        (align === 'center' ? 0 : align === 'start' || align === 'end' ? 8 : 16 + slide * 4) +
        covered * 900 +
        (straddles ? 120 : 0) +
        (snap ? 20 : 0) +
        shift * 0.4;
      return { side, align, slide, step, ...(snap ? { snap } : {}), rect, legal, hides, straddles, base, clean: false, score: base };
    };
    /** Adds the leader: its route, its cost, and whether the spot is clean. */
    const finish = (c: Scored): Scored => {
      if (c.route) return c;
      const route = routeFor(c.rect);
      c.route = route;
      c.score = c.base + route.crossings * 60 + (route.touches ? 60 : 0) + (route.via ? 24 : 0) + route.length * 0.05 + (route.ownCrossings ?? 0) * 45;
      c.clean = c.legal && !c.hides && !c.straddles && route.crossings === 0 && !route.touches;
      return c;
    };

    const all: Scored[] = [];
    const add = (side: Side, align: Align, step: number, slide = 0) => {
      const c = evaluate(side, align, step, slide);
      if (!c) return;
      all.push(c);
      // A spot across a card edge also tries the two spots that clear it (P1-C03).
      if (edges.length > 0 && edges.some((e) => intersects(c.rect, e) && !contains(e, c.rect)))
        for (const snap of ['out', 'in'] as const) {
          const sn = evaluate(side, align, step, slide, snap);
          if (sn) all.push(sn);
        }
    };
    for (const side of order)
      for (const align of ALIGNS)
        for (let step = 0; step < STEPS.length; step++)
          if (align === 'before' || align === 'after') for (let slide = 0; slide < SLIDES.length; slide++) add(side, align, step, slide);
          else add(side, align, step);
    const byScore = (a: Scored, b: Scored) => a.score - b.score;

    // A spot whose leader crosses nothing wins over any that crosses words, whatever else it costs (P1-C03).
    // Best first: candidates in order of their score without the leader, routed only until no cheaper one is
    // left (the leader never lowers a score), so the clean spots are found without routing every candidate.
    const clean: Scored[] = [];
    for (const c of [...all].sort((a, b) => a.base - b.base)) {
      if (clean.length >= width && c.base >= clean[width - 1].score) break;
      if (!c.legal || c.hides || c.straddles) continue;
      if (finish(c).clean) {
        clean.push(c);
        clean.sort(byScore);
      }
    }
    const top = clean.slice(0, width);

    // STICKY: the previous spot first while it stays legal, as clean, and nearly as good.
    const prev = opts.previous?.find((p) => p.id === input.id);
    const again = prev ? evaluate(prev.side, prev.align, prev.step, prev.slide, prev.snap) : null;
    if (again && again.legal && finish(again)) {
      const best = top[0] ?? all.filter((c) => c.legal).map(finish).sort(byScore)[0];
      if (best && (again.clean || !best.clean) && again.score <= best.score + 25) return [again, ...top.filter((c) => c.rect.x !== again.rect.x || c.rect.y !== again.rect.y)];
    }
    if (top.length > 0) return top;
    const legal = all.filter((c) => c.legal).map(finish).sort(byScore)[0];
    if (legal) return [legal];
    // No legal spot: the least-bad one — as little of its own target covered as possible first
    // (targets outrank everything else), then of the other hard rectangles, then the usual score.
    const ownBox = inflate(input.target, 4);
    const cost = (c: Scored): number =>
      overlapArea(c.rect, ownBox) * 1e6 + [...hard, ...placed.map((p) => p.label)].reduce((sum, r) => sum + overlapArea(c.rect, r), 0) * 1e3 + c.score;
    return [all.map(finish).sort((a, b) => cost(a) - cost(b))[0]];
  };

  const toPlacement = (input: CalloutInput, c: Scored): Placement => {
    const r = c.route!;
    return {
      id: input.id,
      side: c.side,
      align: c.align,
      slide: c.slide,
      step: c.step,
      ...(c.snap ? { snap: c.snap } : {}),
      label: c.rect,
      from: r.from,
      to: r.to,
      ...(r.via ? { via: r.via } : {}),
      ok: c.legal,
      clean: c.clean,
    };
  };

  interface Plan {
    list: Placement[];
    clean: number;
    score: number;
  }
  const better = (a: Plan, b: Plan | null): boolean => !b || a.clean > b.clean || (a.clean === b.clean && a.score < b.score);
  const solve = (i: number, placed: Placement[], score: number): Plan => {
    if (i === inputs.length) return { list: placed, clean: placed.filter((p) => p.clean).length, score };
    const options = rank(inputs[i], placed, i === inputs.length - 1 ? 1 : SEARCH_WIDTH);
    let best: Plan | null = null;
    for (const c of options) {
      const plan = solve(i + 1, [...placed, toPlacement(inputs[i], c)], score + c.score);
      if (better(plan, best)) best = plan;
      // The first plan in which every label is clean is the one (earlier labels keep their better spots).
      if (best!.clean === inputs.length) break;
    }
    return best!;
  };
  return solve(0, [], 0).list;
}
