// src/views/Story/wedgeSpot.ts — where the dollar map's "what the pipeline removed" dot goes (W3-STAGE-3).
//
// The flow-saved callout names the "$ saved" plate (the label keeps clear of it), and its dot belongs on the hatched
// wedge that plate labels: what the pipeline removed. A dot placed just outside the plate can land on the solid
// ribbons around it (at 390 it sat on the Splunk Cloud convergence), so the spot is found on the wedge itself: the
// point of the wedge the screen actually shows (hit-tested, so a ribbon drawn over it does not count) with the most
// room around it for the dot, nearest the plate among the roomiest.

import { DOT_RADIUS } from '../../story/layout.ts';

/** Grid samples across the wedge's box, per side. */
const GRID = 18;
/** Rings tried around a sample (px): its room is the largest ring whose eight points are all still the wedge. */
const RINGS = [2, 4, DOT_RADIUS + 1.5, DOT_RADIUS + 3.5, DOT_RADIUS + 6] as const;
/** Room beyond this does not make a spot better; nearness to the plate decides then. */
const ENOUGH = DOT_RADIUS + 3.5;

/** A client-coordinate point on `wedge` for the dot (null when the wedge shows no point of its own). */
export function wedgeSpot(wedge: Element, plate: Element): { x: number; y: number } | null {
  const doc = wedge.ownerDocument;
  const box = wedge.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  const shows = (x: number, y: number): boolean => doc.elementFromPoint(x, y) === wedge;
  const p = plate.getBoundingClientRect();
  const pcx = p.left + p.width / 2;
  const pcy = p.top + p.height / 2;
  let best: { x: number; y: number; score: number } | null = null;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const x = box.left + ((i + 0.5) * box.width) / GRID;
      const y = box.top + ((j + 0.5) * box.height) / GRID;
      if (!shows(x, y)) continue;
      let room = 0;
      for (const r of RINGS) {
        let all = true;
        for (let k = 0; k < 8 && all; k++) all = shows(x + r * Math.cos((k * Math.PI) / 4), y + r * Math.sin((k * Math.PI) / 4));
        if (!all) break;
        room = r;
      }
      const score = Math.min(room, ENOUGH) * 1_000 - Math.hypot(x - pcx, y - pcy);
      if (!best || score > best.score) best = { x, y, score };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}
