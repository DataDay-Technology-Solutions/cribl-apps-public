// src/components/IncidentTakeover/reveal.ts — where the page scrolls when the alert card lands on a phone.
//
// On a phone the presenter's card sits in the page between the savers and the QR (P1-B02), usually below the
// fold, so it is brought on screen as it lands. `scrollIntoView({ block: 'nearest' })` aligned the card's bottom
// with the frame's, and at 390 × 844 that scrolled the hero's label and the top of its figure off the screen
// (leftovers: "the presenter hero is clipped at 390 while an alert is up"). Now the hero's top never leaves the
// frame: where the hero and the whole card fit, the page moves as little as it can to show both; where they do
// not, the hero stays whole with the card's headline and drop under it, and the rest is one scroll away.

/** Page-relative (document) positions, px. */
export interface RevealBox {
  /** the window's current scroll */
  scrollY: number;
  /** the window's height */
  viewport: number;
  /** the card's top and bottom, and the room kept around it (its scroll-margin) */
  cardTop: number;
  cardBottom: number;
  margin: number;
  /** the hero's top (its label, less a little air); undefined off the stage */
  heroTop?: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The window scroll that brings the card on screen without scrolling the hero's top away. */
export function revealScrollTop({ scrollY, viewport, cardTop, cardBottom, margin, heroTop }: RevealBox): number {
  const top = Math.max(0, cardTop - margin);
  // The least scroll that shows the card's bottom (with its margin).
  const lo = Math.max(0, cardBottom + margin - viewport);
  // Off the stage: the plain "nearest" (a card taller than the frame shows its top).
  if (heroTop === undefined) return lo <= top ? clamp(scrollY, lo, top) : top;
  const hero = Math.max(0, heroTop);
  // Hero and card fit together: move as little as possible.
  const hi = Math.min(top, hero);
  if (lo <= hi) return clamp(scrollY, lo, hi);
  // They do not: the hero stays whole with the card's head under it, unless the card would not even start on screen.
  return top < hero + viewport ? hero : top;
}
