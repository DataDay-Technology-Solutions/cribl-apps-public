// src/lib/dom.ts — small DOM helpers shared by the shell and views.

/**
 * True when keyboard input is going to a text field, so global shortcuts must stay quiet
 * (SPEC 13: shortcuts work "only when no text field is focused").
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).tagName !== 'string') return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    // Buttons, checkboxes and radios take focus but not text; shortcuts stay live on them.
    return !['button', 'checkbox', 'radio', 'range', 'reset', 'submit', 'color', 'file', 'image'].includes(type);
  }
  const role = el.getAttribute('role');
  return role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton';
}

/**
 * Elements whose keys are their own: a listbox and its options (react-aria typeahead), a menu and its
 * items, a closed Select's trigger (`aria-haspopup="listbox"`: react-aria's trigger types ahead through
 * the options even while the list is shut), and any dialog. A menu button (`aria-haspopup` "menu"/"true")
 * and a hover card's marker ("dialog") read no letters while closed, so shortcuts still work from them.
 */
const WIDGET_SELECTOR = [
  '[role="listbox"]',
  '[role="option"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[aria-haspopup="listbox"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
].join(', ');

/** An open popup that owns the keyboard wherever focus sits: a modal, a listbox or a menu. */
const OPEN_POPUP_SELECTOR = '[aria-modal="true"], [role="listbox"], [role="menu"]';

/**
 * True when a keydown belongs to an open select, menu or dialog, so global shortcuts must stay quiet
 * (epic audit P0-05: with the shell listening in the capture phase it sees these keys first).
 */
export function isWidgetKeyTarget(target: EventTarget | null): boolean {
  if (typeof document === 'undefined') return false;
  if (target instanceof Element && target.closest(WIDGET_SELECTOR)) return true;
  return document.querySelector(OPEN_POPUP_SELECTOR) !== null;
}

/**
 * Selector views put on their search field so the `/` shortcut can find it
 * (e.g. `<input data-mr-search …>` or a wrapper `<div data-mr-search>` around a Capra TextField).
 */
export const SEARCH_FIELD_SELECTOR = '[data-mr-search]';

/** Focuses the first visible search field on the page. Returns whether one was found. */
export function focusSearchField(root: ParentNode = document): boolean {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(SEARCH_FIELD_SELECTOR));
  for (const candidate of candidates) {
    const input =
      candidate.matches('input, textarea') ? candidate : candidate.querySelector<HTMLElement>('input, textarea');
    if (input && input.getClientRects().length > 0) {
      input.focus();
      if (input instanceof HTMLInputElement) input.select();
      return true;
    }
  }
  return false;
}

/**
 * Copies text to the clipboard. The async Clipboard API can be unavailable in the sandboxed iframe, or
 * refuse (a frame without the clipboard-write permission), so fall back to a hidden textarea + execCommand
 * (SPEC 13 "Copy receipt"). `writeText` is called before the first await, inside the click's user
 * activation, which Safari requires.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea path
  }
  return copyWithTextarea(text);
}

/**
 * The execCommand path. Selecting the textarea moves focus into it and removing it drops focus to <body>,
 * so the element that had focus (the Copy button, for a keyboard user) gets it back, without scrolling.
 */
function copyWithTextarea(text: string): boolean {
  const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', ''); // no on-screen keyboard on touch devices
  area.setAttribute('aria-hidden', 'true');
  area.tabIndex = -1;
  // Pinned inside the viewport's top-left corner, so focusing it never scrolls the page.
  Object.assign(area.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', padding: '0', border: '0', opacity: '0', pointerEvents: 'none' });
  document.body.appendChild(area);
  area.focus({ preventScroll: true });
  area.select();
  area.setSelectionRange(0, text.length); // iOS Safari ignores select() on a read-only field
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  previous?.focus({ preventScroll: true });
  return ok;
}

/** `prefers-reduced-motion: reduce` right now (for JS-driven motion such as the Meter's rAF loop). */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/** Reads a resolved custom property from `<body>` (where the `.dark` class and the `--mr-*` palette live). */
export function readCssVar(name: string, element: Element | null = typeof document === 'undefined' ? null : document.body): string {
  if (!element) return '';
  return getComputedStyle(element).getPropertyValue(name).trim();
}
