// src/components/IncidentTakeover/morph.ts — the alert → recovery hand-off (P1-B01): its timing and the frozen
// copy of the red card that fades out over the green one (IncidentTakeover.tsx runs it).

/** How long the red card takes to turn into the green one (P1-B01): the red fades out, then the green words in. */
export const MORPH_OUT_MS = 180;
export const MORPH_IN_DELAY_MS = 140;
export const MORPH_IN_MS = 200;
export const MORPH_MS = MORPH_IN_DELAY_MS + MORPH_IN_MS;

/**
 * A frozen, inert copy of the card on stage, for the alert → recovery crossfade. It keeps the card's look (every
 * modifier class, the fixed overlay placement) but none of its identity: no `mr-takeover` block class, ids,
 * roles, callouts or incident id, so nothing that looks for the card or a callout ever finds the copy.
 */
export function freezeCard(card: HTMLElement): HTMLElement {
  const ghost = card.cloneNode(true) as HTMLElement;
  ghost.classList.remove('mr-takeover');
  ghost.classList.add('mr-tk-ghost');
  for (const attr of ['role', 'aria-labelledby', 'aria-live', 'data-incident-id', 'data-mode', 'data-delivered', 'id']) ghost.removeAttribute(attr);
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('inert', '');
  for (const el of ghost.querySelectorAll('[id], [data-callout], [data-testid]')) {
    el.removeAttribute('id');
    el.removeAttribute('data-callout');
    el.removeAttribute('data-testid');
  }
  return ghost;
}
