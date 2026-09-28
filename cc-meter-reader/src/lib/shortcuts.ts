// src/lib/shortcuts.ts — the one keyboard map (SPEC 13 / PRD 8.7) and a tiny registry for it.
//
// The shell owns the single `keydown` listener and dispatches here. Anything can register a handler
// with `useShortcut(key, handler)` — the shell registers P / Y / ? / '/' / Escape, the diagnostics panel
// Shift+D, and the Demo Console (demo build only) the lever keys, so the release bundle carries no lever
// handler at all. Shortcuts never fire while a text field has focus, with Ctrl / ⌘ / Alt held, or while the
// key belongs to an open select, menu or dialog (dom.ts `isWidgetKeyTarget`, epic audit P0-05).
//
// Keys: a letter or symbol as printed on the key cap ('P', '?', '/'); the one named key 'Escape'; and a
// Shift chord on a letter ('Shift+D'). A Shift+letter keydown looks up its chord first and falls back to
// the plain letter, so Shift+P still opens the stage while Shift+D is the diagnostics panel's own.
//
// Each shortcut shows a 2-second confirmation chip in the corner (`showShortcutChip`).
//
// The off switch (WCAG 2.1.4, EPIC_AUDIT P1-A09): with the workspace setting "Single-key shortcuts" off,
// every key in this map is ignored — letters, symbols, digits and their Shift chords — except Escape, which
// only ever closes or leaves something. The shell mirrors the setting here (`setSingleKeyShortcuts`); the
// ⌘K / Ctrl+K palette, a modifier chord, is how the keyboard still reaches every action and the switch.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { t } from '../copy/en.ts';
import { isTypingTarget, isWidgetKeyTarget } from './dom.ts';

export interface ShortcutDef {
  /** As printed on the key cap: 'P', '?', '/', '1'. */
  key: string;
  label: string;
}

/** Work everywhere, in both builds. */
export const GLOBAL_SHORTCUTS: readonly ShortcutDef[] = [
  { key: 'P', label: t('shortcuts.presenter') },
  { key: 'Y', label: t('shortcuts.story') },
  { key: '?', label: t('shortcuts.sheet') },
  { key: '/', label: t('shortcuts.search') },
  { key: 'Ctrl+K', label: t('shortcuts.palette') },
  { key: 'Shift+D', label: t('shortcuts.diagnostics') },
];

/** Keys that work on one view only (listed so the sheet is the whole map). */
export const VIEW_SHORTCUTS: readonly ShortcutDef[] = [
  { key: 'F', label: t('shortcuts.flowStage') },
  { key: 'M', label: t('shortcuts.chime') },
];

/**
 * Demo build with demo mode on (listed on the sheet; handled by the Demo Console). Empty in the release
 * build: the flag is tested INLINE (see src/router.tsx) so the bundler drops the lever list — labels and
 * copy keys included — from the release bundle (SPEC 13 / 16).
 */
export const DEMO_LEVER_SHORTCUTS: readonly ShortcutDef[] =
  import.meta.env.VITE_MR_BUILD === 'demo'
    ? [
        { key: '1', label: t('shortcuts.lever.applyWindows') },
        { key: '2', label: t('shortcuts.lever.applyPaloAlto') },
        { key: '3', label: t('shortcuts.lever.applyVpc') },
        { key: 'A', label: t('shortcuts.lever.applyWindows') },
        { key: 'G', label: t('shortcuts.lever.aggressive') },
        { key: 'V', label: t('shortcuts.lever.revertAll') },
        { key: 'B', label: t('shortcuts.lever.breakTrim') },
        { key: 'R', label: t('shortcuts.lever.restore') },
        { key: 'S', label: t('shortcuts.lever.spike') },
        { key: 'C', label: t('shortcuts.lever.calm') },
        { key: 'W', label: t('shortcuts.lever.weekly') },
        { key: '0', label: t('shortcuts.lever.reset') },
      ]
    : [];

// ─── Registry ────────────────────────────────────────────────────────────────

/** A handler that returns `false` declined the key: the next one down the stack gets it, and if none takes it the event is left alone. */
type Handler = (event: KeyboardEvent) => void | boolean;

interface Entry {
  handler: Handler;
  priority: number;
}

/**
 * Handlers per normalized key, lowest priority first: the last entry wins. Within one priority the most
 * recently registered wins (a stack); a higher priority wins whenever it was registered — an overlay's
 * Escape (the diagnostics panel, priority 1) outranks the stage's (0) even when the stage opened later.
 */
const registry = new Map<string, Entry[]>();

/** The named (multi-character) keys a shortcut may use. Every other named key — Tab, arrows, F-keys — belongs to focus and widgets. */
const NAMED_KEYS: ReadonlySet<string> = new Set(['Escape']);

const isLetter = (key: string): boolean => key.length === 1 && key.toLowerCase() !== key.toUpperCase();

/**
 * Letters compare case-insensitively ('p' and 'P' are the same shortcut); symbols as typed; 'Esc' is
 * 'Escape'; a chord is written 'Shift+D' (any case).
 */
export function normalizeKey(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  if (key === 'Esc') return 'Escape';
  const chord = /^shift\+(.)$/i.exec(key);
  if (chord) return `Shift+${chord[1].toUpperCase()}`;
  return key;
}

/** The registry keys a keydown may match, most specific first: 'Shift+D' then 'D' for Shift+d, else just the key. */
export function keysForEvent(event: KeyboardEvent): string[] {
  const key = normalizeKey(event.key);
  return event.shiftKey && isLetter(event.key) ? [`Shift+${key}`, key] : [key];
}

export interface ShortcutOptions {
  /** Higher wins over lower whatever the registration order (default 0). */
  priority?: number;
}

export function registerShortcut(key: string, handler: Handler, opts: ShortcutOptions = {}): () => void {
  const k = normalizeKey(key);
  const entry: Entry = { handler, priority: opts.priority ?? 0 };
  const stack = registry.get(k) ?? [];
  // After every entry of the same or a lower priority: the newest of its rank, below any higher rank.
  let at = stack.length;
  while (at > 0 && stack[at - 1].priority > entry.priority) at--;
  stack.splice(at, 0, entry);
  registry.set(k, stack);
  return () => {
    const current = registry.get(k);
    if (!current) return;
    const index = current.indexOf(entry);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) registry.delete(k);
  };
}

// ─── The off switch (P1-A09) ─────────────────────────────────────────────────

let singleKeyShortcuts = true;

/** Turns the single-key shortcuts on or off (the shell mirrors settings.keyboard.singleKeyShortcuts). */
export function setSingleKeyShortcuts(enabled: boolean): void {
  singleKeyShortcuts = enabled;
}

export function singleKeyShortcutsEnabled(): boolean {
  return singleKeyShortcuts;
}

/** Whether this keydown may trigger a shortcut at all. */
export function isShortcutEvent(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key.length !== 1 && !NAMED_KEYS.has(normalizeKey(event.key))) return false; // Shift, Tab, arrows, F-keys …
  if (!singleKeyShortcuts && event.key.length === 1) return false; // switched off: only Escape is left
  if (isTypingTarget(event.target)) return false;
  // A key meant for an open select, menu or dialog (typeahead 'p' in the Status list) stays there.
  return !isWidgetKeyTarget(event.target);
}

export interface DispatchOptions {
  /** Only Shift+letter chords (Story mode, where every other key leaves). */
  chordsOnly?: boolean;
}

/**
 * Runs the handler registered for this keydown. Returns true when one took it; the event is then consumed
 * (default prevented, propagation stopped: one key, one effect — the shell listens in the capture phase,
 * so nothing below it also acts on a shortcut).
 */
export function dispatchShortcut(event: KeyboardEvent, opts: DispatchOptions = {}): boolean {
  if (!isShortcutEvent(event)) return false;
  const keys = keysForEvent(event).filter((k) => !opts.chordsOnly || k.startsWith('Shift+'));
  for (const key of keys) {
    const stack = registry.get(key);
    if (!stack) continue;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].handler(event) === false) continue;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
  }
  return false;
}

/**
 * Runs the handler registered for `key` as if it had been pressed — the palette's way to every action, which
 * works with the single-key shortcuts off too (it is not a keypress). Returns whether a handler took it.
 */
export function runShortcut(key: string): boolean {
  const k = normalizeKey(key);
  const stack = registry.get(k);
  if (!stack) return false;
  const chord = /^Shift\+(.)$/.exec(k);
  const event = new KeyboardEvent('keydown', { key: chord ? chord[1] : k, shiftKey: !!chord, cancelable: true });
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].handler(event) === false) continue;
    return true;
  }
  return false;
}

/** Registers a shortcut for the lifetime of the calling component (while `enabled`). The latest `handler` is always used. */
export function useShortcut(key: string, handler: Handler, enabled = true, priority = 0): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    return registerShortcut(key, (event) => latest.current(event), { priority });
  }, [key, enabled, priority]);
}

// ─── Confirmation chip ───────────────────────────────────────────────────────

export const CHIP_DURATION_MS = 2_000;

interface ChipState {
  id: number;
  label: string;
}

let chip: ChipState | null = null;
let chipTimer: ReturnType<typeof setTimeout> | undefined;
const chipListeners = new Set<() => void>();

function emitChip(): void {
  for (const listener of [...chipListeners]) listener();
}

/** Shows "Presenter mode on" (etc.) in the corner for 2 s; a new chip replaces the current one. */
export function showShortcutChip(label: string): void {
  chip = { id: (chip?.id ?? 0) + 1, label };
  if (chipTimer !== undefined) clearTimeout(chipTimer);
  chipTimer = setTimeout(() => {
    chip = null;
    chipTimer = undefined;
    emitChip();
  }, CHIP_DURATION_MS);
  emitChip();
}

function subscribeChip(listener: () => void): () => void {
  chipListeners.add(listener);
  return () => chipListeners.delete(listener);
}

export function useShortcutChip(): ChipState | null {
  return useSyncExternalStore(
    subscribeChip,
    () => chip,
    () => null,
  );
}
