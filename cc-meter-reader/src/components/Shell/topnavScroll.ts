// src/components/Shell/topnavScroll.ts — the tab row's scroll math (BEAUTY-3a F6), pure so it is unit-tested.

/** Width of the edge fade (Shell.css `--mr-topnav-fade`); a revealed tab clears it entirely. */
export const TAB_FADE_PX = 24;

/** Which edges of a horizontal scroller hide content (1 px tolerance for sub-pixel layouts). */
export function scrollEdges(el: Pick<HTMLElement, 'scrollLeft' | 'scrollWidth' | 'clientWidth'>): { start: boolean; end: boolean } {
  const max = el.scrollWidth - el.clientWidth;
  return { start: el.scrollLeft > 1, end: max > 1 && el.scrollLeft < max - 1 };
}

/**
 * The scrollLeft that shows `[left, right)` (child coordinates relative to the scroller's content box)
 * fully, clear of a `fade`-wide edge fade on either side; unchanged when it already is. Sets the
 * scroller's own offset only, never `scrollIntoView` (that can scroll the page or the Cribl frame).
 */
export function revealScrollLeft(scrollLeft: number, clientWidth: number, left: number, right: number, fade: number = TAB_FADE_PX): number {
  const viewStart = scrollLeft + (scrollLeft > 0 ? fade : 0);
  const viewEnd = scrollLeft + clientWidth - fade;
  if (left < viewStart) return Math.max(0, left - fade);
  if (right > viewEnd) return right + fade - clientWidth;
  return scrollLeft;
}
