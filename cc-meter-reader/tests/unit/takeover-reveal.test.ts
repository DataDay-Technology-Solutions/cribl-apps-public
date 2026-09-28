// Where the page scrolls when the alert card lands in the phone presenter (leftovers: the hero was clipped at 390).
// The card comes on screen, but the hero's top never leaves the frame.

import { describe, expect, it } from 'vitest';
import { revealScrollTop } from '../../src/components/IncidentTakeover/reveal.ts';

// A phone stage at 390 × 844 (document px): the hero's top (its label less 8 px of air) at 67, the card 491 to 931,
// a 16 px margin — a card taller than the frame leaves beside the hero.
const PHONE = { scrollY: 0, viewport: 844, cardTop: 491, cardBottom: 931, margin: 16, heroTop: 67 };

describe('revealScrollTop', () => {
  it('keeps the hero whole when hero and card do not fit together (390 × 844, 390 × 664)', () => {
    // "nearest" would have scrolled to 103 (the card's bottom at the frame's), taking the hero's label with it.
    expect(revealScrollTop(PHONE)).toBe(67);
    expect(revealScrollTop({ ...PHONE, viewport: 664 })).toBe(67);
  });

  it('moves as little as possible when hero and card fit together', () => {
    // A shorter card: its bottom needs 40 px of scroll, well under the hero's top.
    expect(revealScrollTop({ ...PHONE, cardBottom: 868 })).toBe(40);
    // Already whole on screen: no scroll.
    expect(revealScrollTop({ ...PHONE, viewport: 1000 })).toBe(0);
    // Scrolled a little, card and hero both on screen: stays.
    expect(revealScrollTop({ ...PHONE, cardBottom: 868, scrollY: 50 })).toBe(50);
  });

  it('comes back up to the hero when the member had scrolled past the card', () => {
    // Down at the QR: the card is above the frame.
    expect(revealScrollTop({ ...PHONE, scrollY: 1_200 })).toBe(67);
    expect(revealScrollTop({ ...PHONE, cardBottom: 868, scrollY: 1_200 })).toBe(67);
  });

  it('shows the card before the hero if the card would not even start on screen under it', () => {
    expect(revealScrollTop({ ...PHONE, cardTop: 1_000, cardBottom: 1_400 })).toBe(984);
  });

  it('off the stage (no hero) is the plain "nearest"', () => {
    const { heroTop: _drop, ...card } = PHONE;
    expect(revealScrollTop(card)).toBe(103);
    expect(revealScrollTop({ ...card, scrollY: 2_000 })).toBe(475);
    // A card taller than the frame shows its top.
    expect(revealScrollTop({ ...card, cardBottom: 491 + 900 })).toBe(475);
  });
});
