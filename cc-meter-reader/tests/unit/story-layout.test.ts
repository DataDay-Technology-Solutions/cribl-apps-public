// Callout placement for Story mode (src/story/layout.ts): a label with a leader line onto the element being
// talked about — never over any target, the caption rail or another label; inside the frame; steady.

import { describe, expect, it } from 'vitest';
import {
  DOT_OFFSET,
  DOT_RADIUS,
  contains,
  elbowRoutes,
  inflate,
  intersects,
  layoutCallouts,
  leader,
  nearestPoint,
  overlapArea,
  segmentDistance,
  segmentHits,
  type Placement,
  type Rect,
  type SoftRect,
} from '../../src/story/layout.ts';

const FRAME: Rect = { x: 0, y: 0, w: 1920, h: 1080 };
const PHONE: Rect = { x: 0, y: 0, w: 390, h: 700 };
const LABEL = { w: 160, h: 36 };

function onEdge(r: Rect, p: { x: number; y: number }): boolean {
  const inX = p.x >= r.x - 0.01 && p.x <= r.x + r.w + 0.01;
  const inY = p.y >= r.y - 0.01 && p.y <= r.y + r.h + 0.01;
  const edge = Math.abs(p.x - r.x) < 0.01 || Math.abs(p.x - r.x - r.w) < 0.01 || Math.abs(p.y - r.y) < 0.01 || Math.abs(p.y - r.y - r.h) < 0.01;
  return inX && inY && edge;
}

describe('layoutCallouts', () => {
  it('puts the label beside its target, on the preferred side, with a leader from edge to edge', () => {
    const target: Rect = { x: 800, y: 500, w: 300, h: 60 };
    const [p] = layoutCallouts([{ id: 'whp', target, size: LABEL, prefer: ['top'] }], { bounds: FRAME, gap: 40 });
    expect(p.ok).toBe(true);
    expect(p.side).toBe('top');
    expect(p.label.y + p.label.h).toBeLessThanOrEqual(target.y - 40 + 0.01);
    expect(intersects(p.label, target)).toBe(false);
    // The dot's rim sits DOT_OFFSET clear of the target's edge; the line starts on the label's edge.
    expect(onEdge(inflate(target, DOT_OFFSET + DOT_RADIUS), p.to)).toBe(true);
    expect(onEdge(p.label, p.from)).toBe(true);
  });

  it('never covers any target of the beat, the caption rail or another label', () => {
    const a: Rect = { x: 700, y: 400, w: 500, h: 40 };
    const b: Rect = { x: 700, y: 400, w: 200, h: 40 }; // inside a (the paid segment of the bar)
    const c: Rect = { x: 760, y: 330, w: 400, h: 60 }; // directly above: the "top" spot is taken
    const rail: Rect = { x: 0, y: 960, w: 1920, h: 120 };
    const placed = layoutCallouts(
      [
        { id: 'whp', target: a, size: LABEL, prefer: ['top'] },
        { id: 'paid', target: b, size: LABEL, prefer: ['bottom'] },
        { id: 'saved', target: c, size: LABEL, prefer: ['top'] },
      ],
      { bounds: FRAME, gap: 32, hard: [rail] },
    );
    for (const p of placed) {
      expect(p.ok, p.id).toBe(true);
      for (const t of [a, b, c]) expect(intersects(p.label, t), `${p.id} over a target`).toBe(false);
      expect(intersects(p.label, rail), `${p.id} over the rail`).toBe(false);
      expect(contains(FRAME, p.label)).toBe(true);
    }
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(intersects(placed[i].label, placed[j].label)).toBe(false);
  });

  it('flips to another side when the preferred one leaves the frame, and stays inside at phone width', () => {
    const nearTop: Rect = { x: 20, y: 10, w: 350, h: 50 };
    const [p] = layoutCallouts([{ id: 'qr', target: nearTop, size: LABEL, prefer: ['top'] }], { bounds: PHONE, gap: 20 });
    expect(p.ok).toBe(true);
    expect(p.side).not.toBe('top');
    expect(contains(PHONE, p.label)).toBe(true);
    expect(intersects(p.label, nearTop)).toBe(false);
  });

  it('prefers a spot that leaves the page’s own text readable', () => {
    const target: Rect = { x: 800, y: 500, w: 100, h: 40 };
    const textAbove: Rect = { x: 600, y: 380, w: 700, h: 100 };
    const [p] = layoutCallouts([{ id: 'per-day', target, size: LABEL, prefer: ['top', 'bottom'] }], { bounds: FRAME, gap: 30, soft: [textAbove] });
    expect(overlapArea(p.label, textAbove)).toBe(0);
  });

  it('keeps its spot while that spot stays legal (no jitter as a card slides in)', () => {
    const t1: Rect = { x: 800, y: 600, w: 200, h: 40 };
    const first = layoutCallouts([{ id: 'commit', target: t1, size: LABEL, prefer: ['right', 'top'] }], { bounds: FRAME, gap: 30 });
    // The target moves 12 px; a soft obstacle now makes another side marginally better.
    const t2: Rect = { ...t1, y: 588 };
    // Just clear of the old spot's edge: within the air words keep, not under the label (a hidden word would
    // make the old spot unclean, and a clean spot always wins — see the P1-C03 block).
    const soft: Rect[] = [{ x: first[0].label.x + first[0].label.w + 2, y: first[0].label.y, w: 6, h: 6 }];
    const second = layoutCallouts([{ id: 'commit', target: t2, size: LABEL, prefer: ['right', 'top'] }], { bounds: FRAME, gap: 30, soft, previous: first });
    expect(second[0].side).toBe(first[0].side);
    expect(second[0].label.y - first[0].label.y).toBeCloseTo(-12, 5);
  });

  it('squeezes into the only room left beside a big target', () => {
    const big: Rect = { x: 10, y: 10, w: 370, h: 600 };
    const [p] = layoutCallouts([{ id: 'slack-message', target: big, size: LABEL, prefer: ['top'] }], { bounds: PHONE, gap: 20 });
    expect(p.ok).toBe(true);
    expect(p.side).toBe('bottom');
    expect(intersects(p.label, big)).toBe(false);
  });

  it('when nothing is legal, covers as little of its target as it can and says so', () => {
    const huge: Rect = { x: 5, y: 5, w: 380, h: 690 };
    const [p] = layoutCallouts([{ id: 'slack-message', target: huge, size: LABEL }], { bounds: PHONE, gap: 20 });
    expect(p.ok).toBe(false);
    expect(contains(PHONE, p.label)).toBe(true);
  });
});

describe('geometry helpers', () => {
  it('inflates, intersects and measures overlap', () => {
    const r: Rect = { x: 10, y: 10, w: 10, h: 10 };
    expect(inflate(r, 2)).toEqual({ x: 8, y: 8, w: 14, h: 14 });
    expect(intersects(r, { x: 19, y: 19, w: 5, h: 5 })).toBe(true);
    expect(intersects(r, { x: 20, y: 20, w: 5, h: 5 })).toBe(false);
    expect(overlapArea(r, { x: 15, y: 15, w: 10, h: 10 })).toBe(25);
  });

  it('draws the leader between the nearest edges, its dot just clear of the target', () => {
    const label: Rect = { x: 0, y: 0, w: 100, h: 20 };
    const target: Rect = { x: 200, y: 0, w: 50, h: 20 };
    // The dot's centre is its radius plus the clearance out, so its rim (not its centre) is clear of the ink.
    expect(leader(label, target)).toEqual({ from: { x: 100, y: 10 }, to: { x: 200 - DOT_OFFSET - DOT_RADIUS, y: 10 } });
    // A wide stage asks for more air; a label right beside the target gets the dot no further than halfway.
    expect(leader(label, target, 7).to).toEqual({ x: 200 - 7 - DOT_RADIUS, y: 10 });
    expect(leader({ x: 190, y: 0, w: 8, h: 20 }, target).to).toEqual({ x: 199, y: 10 });
    expect(leader({ x: 192, y: 0, w: 8, h: 20 }, target).to).toEqual({ x: 200, y: 10 });
    expect(nearestPoint(target, { x: 210, y: 5 })).toEqual({ x: 210, y: 5 });
  });

  it('knows when a leader runs through a box', () => {
    const r: Rect = { x: 10, y: 10, w: 10, h: 10 };
    expect(segmentHits({ x: 0, y: 15 }, { x: 30, y: 15 }, r)).toBe(true);
    expect(segmentHits({ x: 0, y: 0 }, { x: 30, y: 5 }, r)).toBe(false);
    expect(segmentHits({ x: 0, y: 0 }, { x: 5, y: 5 }, r)).toBe(false);
  });

  it('routes the leader clear of text when it can', () => {
    const target: Rect = { x: 900, y: 600, w: 80, h: 30 };
    const row: Rect = { x: 700, y: 520, w: 500, h: 40 }; // a line of text right above the target
    const [p] = layoutCallouts([{ id: 'commit', target, size: LABEL, prefer: ['top'] }], { bounds: FRAME, gap: 30, soft: [row] });
    expect(segmentHits(p.from, p.to, row)).toBe(false);
    expect(overlapArea(p.label, row)).toBe(0);
  });
});

// P1-C03: a leader never runs through words it does not point at when a spot without a crossing exists; a label
// sits wholly inside or wholly outside a card; where no straight line is clear, an elbow runs along a gutter.
describe('clean callouts (P1-C03)', () => {
  /** Every segment of a placement's leader. */
  const segments = (p: Placement) => (p.via ? [[p.from, p.via], [p.via, p.to]] : [[p.from, p.to]]) as [{ x: number; y: number }, { x: number; y: number }][];
  const crosses = (p: Placement, r: Rect) => segments(p).some(([a, b]) => segmentHits(a, b, r));

  it('takes a spot whose leader crosses no words over a preferred side whose leader would', () => {
    // "the commit" over "$1,250 a day": the preferred top spot would run its leader through that line.
    const hash: Rect = { x: 900, y: 600, w: 90, h: 24 };
    const money: SoftRect = { x: 880, y: 560, w: 420, h: 30, owners: [] };
    const [p] = layoutCallouts([{ id: 'commit', target: hash, size: LABEL, prefer: ['top'] }], { bounds: FRAME, gap: 30, soft: [money] });
    expect(p.clean).toBe(true);
    expect(crosses(p, money)).toBe(false);
    expect(overlapArea(p.label, money)).toBe(0);
  });

  it('may run through its own target’s words, never another’s', () => {
    const slack: Rect = { x: 600, y: 300, w: 600, h: 400 };
    const inside: SoftRect = { x: 620, y: 320, w: 560, h: 30, owners: ['slack-message'] };
    const [p] = layoutCallouts([{ id: 'slack-message', target: slack, size: LABEL, prefer: ['top'] }], { bounds: FRAME, gap: 30, soft: [inside] });
    expect(p.clean).toBe(true);
    // The same words owned by nobody else would not be crossable: the owner list is what exempts them.
    const theirs: SoftRect = { ...inside, owners: ['commit'] };
    const [q] = layoutCallouts([{ id: 'per-day', target: { x: 900, y: 360, w: 100, h: 24 }, size: LABEL, prefer: ['top'] }], { bounds: FRAME, gap: 30, soft: [theirs] });
    expect(crosses(q, theirs)).toBe(false);
  });

  it('puts a label wholly inside or wholly outside every card edge, never across one', () => {
    // A QR plate at the top-right of its column: the label must not hang off the plate's corner.
    const plate: Rect = { x: 150, y: 300, w: 200, h: 200 };
    const [p] = layoutCallouts([{ id: 'qr', target: plate, size: { w: 110, h: 24 }, prefer: ['right', 'top'] }], { bounds: PHONE, gap: 18, margin: 8, edges: [plate] });
    expect(p.clean).toBe(true);
    expect(intersects(p.label, plate)).toBe(false);
    const card: Rect = { x: 16, y: 200, w: 358, h: 300 };
    const figure: Rect = { x: 40, y: 260, w: 240, h: 60 };
    const [q] = layoutCallouts([{ id: 'saved', target: figure, size: { w: 110, h: 24 }, prefer: ['right', 'top'] }], { bounds: PHONE, gap: 18, margin: 8, edges: [card] });
    expect(q.clean).toBe(true);
    expect(!intersects(q.label, card) || contains(card, q.label)).toBe(true);
  });

  it('routes an elbow along a gutter when every straight leader would cross a line of words', () => {
    // The weekly receipt on a phone: the total line sits in a block of mono lines inside a card; the only way in
    // is the card's padding beside the block, then a hook into the line's start.
    const card: Rect = { x: 16, y: 300, w: 358, h: 300 };
    const pre: Rect = { x: 60, y: 330, w: 300, h: 250 };
    const lines: SoftRect[] = [];
    for (let i = 0; i < 12; i++) lines.push({ x: 70, y: 340 + i * 18, w: i === 6 ? 280 : 250 + (i % 3) * 10, h: 16, owners: i === 6 ? ['receipt-total'] : [] });
    const total = lines[6];
    const [p] = layoutCallouts([{ id: 'receipt-total', target: total, size: { w: 120, h: 24 }, prefer: ['right', 'left', 'bottom'] }], {
      bounds: PHONE,
      gap: 18,
      margin: 8,
      soft: lines,
      edges: [card, pre],
    });
    expect(p.clean).toBe(true);
    expect(p.via).toBeDefined();
    for (const l of lines.filter((l) => l !== total)) expect(crosses(p, l), 'the elbow crosses a receipt line').toBe(false);
  });

  it('builds elbows only with a visible hook and a corner inside the label’s span', () => {
    const target: Rect = { x: 100, y: 100, w: 80, h: 16 };
    const below: Rect = { x: 150, y: 200, w: 120, h: 24 };
    for (const e of elbowRoutes(below, target)) {
      expect(e.from.y).toBe(below.y);
      expect(e.via.x).toBeGreaterThanOrEqual(below.x);
      expect(e.via.x).toBeLessThanOrEqual(below.x + below.w);
      expect(Math.hypot(e.to.x - e.via.x, e.to.y - e.via.y)).toBeGreaterThanOrEqual(12);
    }
    expect(elbowRoutes(below, target).length).toBeGreaterThan(0);
    // A label on the target's own row has no vertical elbow into its side.
    expect(elbowRoutes({ x: 400, y: 96, w: 120, h: 24 }, target).every((e) => e.to.y !== 108)).toBe(true);
  });

  it('keeps a clean spot over a sticky one that has turned unclean', () => {
    const hash: Rect = { x: 900, y: 600, w: 90, h: 24 };
    const first = layoutCallouts([{ id: 'commit', target: hash, size: LABEL, prefer: ['top'] }], { bounds: FRAME, gap: 30 });
    expect(first[0].side).toBe('top');
    // A line of words now lies between the old spot and its target.
    const money: SoftRect = { x: 700, y: 560, w: 600, h: 30, owners: [] };
    const [p] = layoutCallouts([{ id: 'commit', target: hash, size: LABEL, prefer: ['top'] }], { bounds: FRAME, gap: 30, soft: [money], previous: first });
    expect(p.clean).toBe(true);
    expect(crosses(p, money)).toBe(false);
  });
});

// The callouts of one caption line are placed together (Callouts.tsx hands them over as a group): a later label
// gets room the earlier ones leave it, labels never cover another's leader, and leaders keep apart.
describe('a line’s callouts, placed together (P1-C03)', () => {
  it('moves an earlier label to its next clean spot when its best one leaves the later label none', () => {
    // The meter beat on a phone: the receipt bar in a card, "You paid $958,407" and "36% saved" under it.
    const card: Rect = { x: 16, y: 100, w: 358, h: 150 };
    const bar: Rect = { x: 30, y: 200, w: 330, h: 12 };
    const grey: Rect = { x: 30, y: 200, w: 200, h: 12 };
    const words: SoftRect[] = [
      { x: 30, y: 172, w: 215, h: 18, owners: [] },
      { x: 30, y: 220, w: 135, h: 18, owners: [] },
      { x: 275, y: 220, w: 85, h: 18, owners: [] },
    ];
    const placed = layoutCallouts(
      [
        { id: 'whp', target: bar, size: { w: 150, h: 24 }, prefer: ['top', 'bottom'] },
        { id: 'paid', target: grey, size: { w: 90, h: 24 }, prefer: ['bottom', 'top'] },
      ],
      { bounds: PHONE, gap: 18, margin: 8, soft: words, edges: [card] },
    );
    for (const p of placed) expect(p.clean, p.id).toBe(true);
    const [a, b] = placed.map((p) => (p.via ? [[p.from, p.via], [p.via, p.to]] : [[p.from, p.to]]) as [{ x: number; y: number }, { x: number; y: number }][]);
    for (const [p, q] of a) for (const [r, s] of b) expect(segmentDistance(p, q, r, s), 'the leaders keep apart').toBeGreaterThanOrEqual(8);
    expect(intersects(placed[0].label, placed[1].label)).toBe(false);
  });

  it('searches: an earlier label gives up its best spot when that is the later one’s only clean spot', () => {
    // Room for labels in two pockets only (everything else is hard): Z1 above the targets, Z2 below B. B's lines
    // from Z1 all cross words, so B is clean only in Z2 — which A, alone, would take (it prefers the bottom).
    const frame: Rect = { x: 0, y: 0, w: 300, h: 200 };
    const hard: Rect[] = [
      { x: 0, y: 0, w: 300, h: 20 },
      { x: 0, y: 20, w: 60, h: 40 },
      { x: 160, y: 20, w: 140, h: 40 },
      { x: 0, y: 60, w: 300, h: 80 },
      { x: 0, y: 140, w: 140, h: 40 },
      { x: 250, y: 140, w: 50, h: 40 },
      { x: 0, y: 180, w: 300, h: 20 },
    ];
    const a: Rect = { x: 100, y: 90, w: 20, h: 20 };
    const b: Rect = { x: 180, y: 90, w: 20, h: 20 };
    const soft: SoftRect[] = [
      { x: 150, y: 60, w: 50, h: 25, owners: [] },
      { x: 130, y: 92, w: 35, h: 16, owners: [] },
    ];
    const inputs = [
      { id: 'a', target: a, size: { w: 80, h: 24 }, prefer: ['bottom', 'top'] as const },
      { id: 'b', target: b, size: { w: 80, h: 24 }, prefer: ['bottom', 'top'] as const },
    ];
    // Alone, A takes the bottom pocket.
    const [alone] = layoutCallouts([inputs[0]], { bounds: frame, gap: 20, hard, soft });
    expect(alone.clean).toBe(true);
    expect(alone.label.y).toBeGreaterThan(b.y);
    // Together, A moves to the top pocket and both are clean.
    const placed = layoutCallouts(inputs, { bounds: frame, gap: 20, hard, soft });
    expect(placed.map((p) => p.clean)).toEqual([true, true]);
    expect(placed[0].label.y + placed[0].label.h).toBeLessThanOrEqual(a.y);
    expect(placed[1].label.y).toBeGreaterThanOrEqual(b.y + b.h);
  });

  it('measures the distance between segments', () => {
    expect(segmentDistance({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(0);
    expect(segmentDistance({ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 5, y: 0 }, { x: 5, y: 10 })).toBe(5);
    expect(segmentDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 13, y: 4 }, { x: 20, y: 4 })).toBe(5);
  });
});

describe('anchored callouts (W3-STAGE-3: the saved plate points its dot at its hatched wedge)', () => {
  const plate: Rect = { x: 900, y: 600, w: 150, h: 30 };
  const anchor = { x: 860, y: 560 };

  it("puts the dot exactly on the anchor while the label keeps clear of the target", () => {
    const [p] = layoutCallouts([{ id: 'flow-saved', target: plate, size: LABEL, prefer: ['bottom'], anchor }], { bounds: FRAME, gap: 40 });
    expect(p.ok).toBe(true);
    expect(p.to.x).toBeCloseTo(anchor.x, 6);
    expect(p.to.y).toBeCloseTo(anchor.y, 6);
    expect(intersects(p.label, plate)).toBe(false);
  });

  it("an unanchored callout keeps its dot just off the target's edge", () => {
    const [p] = layoutCallouts([{ id: 'flow-saved', target: plate, size: LABEL, prefer: ['bottom'] }], { bounds: FRAME, gap: 40 });
    expect(contains(inflate(plate, DOT_OFFSET + DOT_RADIUS + 0.01), { ...p.to, w: 0, h: 0 })).toBe(true);
    expect(contains(plate, { ...p.to, w: 0, h: 0 })).toBe(false);
  });

  it("prefers a spot whose line does not run through the target's own words to reach the anchor", () => {
    // The anchor is above the plate; the plate's words are its own. A label below would draw its line through them.
    const words: SoftRect[] = [{ x: 910, y: 605, w: 130, h: 20, owners: ['flow-saved'] }];
    const [p] = layoutCallouts([{ id: 'flow-saved', target: plate, size: LABEL, prefer: ['bottom', 'top'], anchor: { x: 975, y: 570 } }], {
      bounds: FRAME,
      gap: 40,
      soft: words,
    });
    const crosses = p.via
      ? segmentHits(p.from, p.via, words[0]) || segmentHits(p.via, p.to, words[0])
      : segmentHits(p.from, p.to, words[0]);
    expect(crosses).toBe(false);
  });
});
