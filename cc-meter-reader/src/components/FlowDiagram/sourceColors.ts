// src/components/FlowDiagram/sourceColors.ts — which hue each Source wears on the Flow map (and everywhere that
// names a source in colour: the phone's list, the stage, the Story's map, the What-if's ghost).
//
// The owner's calls (9/27): three of the top sources sharing the same blue is a terrible look; then, having seen a
// vivid first cut, "a calmer set built around Cribl teal and blue with one warm accent: no two sources alike, no
// source sharing its destination's colour. More premium, less rainbow." Ribbons used to take their destination's
// colour, so every flow into the SIEM read as one slab. Now each Source has its own hue and destinations are ink.
//
// The palette (src/styles/palette.css `--mr-src-1..5`) is five hue families, one Capra visualization token per family
// per theme: Cribl teal, azure, navy (periwinkle in dark), purple (violet in dark) and one copper accent (orange in
// dark). Measured as drawn over the panel, not by eye (DECISIONS D55): every PAIR, not only neighbours, stays ≥ 14 ΔE
// apart for full-colour readers and ≥ 8 under protanopia and deuteranopia (OKLab ×100, Machado 2009), in both themes,
// and none is the incident red or amber. All pairs matter because a Sankey decides which sources sit side by side, not
// the palette. Five is where distinct FAMILIES run out inside teal-to-purple plus one warm (a sixth would be a lighter
// or darker twin of one of them: the purple beside a lavender the owner rejected). The sixth source and beyond is
// drawn in the neutral tail colour, which the map's note names, never a repeated hue.
//
// Assignment, so a colour follows its source and never its rank:
//   1. the group's sources are ranked by would-have-paid $/day (all drawable flows, drawn or folded); the top five
//      are the coloured set (rank decides only WHO is coloured);
//   2. inside the set each source takes a preferred slot from a hash of its id, in id order, probing to the next
//      free slot on a collision (the id decides WHICH hue).
// So a sweep that swaps two sources' ranks repaints nothing; a source keeps its hue on reload and in every view
// (the Flow, the What-if's projection, the byte map, the stage and the Story all feed the same live flows); and only
// a change in who is in the top five can move a colour.

/** How many distinct source hues the palette holds (`--mr-src-1..5`). */
export const SOURCE_HUES = 5;

/** A Source's colour class: its hue slot (`mr-flow-s1..5`), or the neutral tail past the coloured sources. */
export const hueClass = (hue: number | undefined): string => (hue === undefined ? 'mr-flow-tail' : `mr-flow-s${hue + 1}`);

/** 32-bit FNV-1a: a stable, well-spread hash of a source's key (no Math.random, no insertion order). */
export function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Hue slots (0-based, < `slots`) for the top `slots` sources by weight; a source past them is absent (the tail).
 * Pure and order-independent: the same totals give the same map in any order.
 */
export function assignSourceHues(totals: ReadonlyMap<string, number>, slots = SOURCE_HUES): Map<string, number> {
  const ranked = [...totals.entries()]
    .filter(([, w]) => Number.isFinite(w) && w > 0)
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, Math.max(0, slots))
    .map(([key]) => key)
    .sort(cmp);
  const taken = new Set<number>();
  const out = new Map<string, number>();
  for (const key of ranked) {
    let slot = hashKey(key) % slots;
    while (taken.has(slot)) slot = (slot + 1) % slots;
    taken.add(slot);
    out.set(key, slot);
  }
  return out;
}
