// src/components/common/notify.tsx — the small `notify` API over Capra's imperative toasts (ToastHost, in Toasts.tsx, mounts
// them once). Its own module so Toasts.tsx exports only its component (React Fast Refresh; oxlint react/only-export-components).
//
//   • once per key: `notify.once(key, …)` shows a toast only if no toast with that key is still open — used
//     for "5xx → toast once, keep last good data" (SPEC 13) so a failing poll every 10 s never stacks toasts;
//   • once per text: a plain-text toast identical to one still open is not shown again ("Receipt copied." on
//     a double click, four identical save failures), so no call site has to key its toasts (P1-A03);
//   • bottom-right: clear of the tab row, the status cluster and the hero actions at every width, and lifted
//     above the Demo Console's pinned lever bar on phones (P1-A03; the shortcut chip sits bottom-centre);
//   • never on the stage: while presenter or Story mode is up (`notify.setStage`) nothing toasts, and entering
//     the stage clears what is showing — the stage's own status line and the takeover card are the message
//     there (P0-09). A keyed toast refused on the stage shows the next time its caller asks after the stage;
//   • motion: every toast body carries `data-mr-toast`, which Toasts.css uses to fade and slide the toast in
//     (Capra's medium.1 step, 200 ms; none under reduced motion).

import type { ReactNode } from 'react';
import { Toast, type ToastOptions } from '@capra/core';

type Kind = 'success' | 'info' | 'warning' | 'error';

/** Where every toast lands unless a caller says otherwise. */
export const TOAST_POSITION: NonNullable<ToastOptions['position']> = 'bottom-right';

/** Capra keeps a toast up at least this long, whatever `duration` asks for (its minimum reading time). */
const CAPRA_MIN_DURATION_MS = 5_000;
const CAPRA_DEFAULT_DURATION_MS = 6_000;

interface OpenToast {
  key?: string;
  /** When Capra's own timer will have closed it (Infinity: sticky until closed). */
  until: number;
}

const openById = new Map<string, OpenToast>();
const openByKey = new Map<string, string>();
let onStage = false;

function forget(id: string): void {
  const entry = openById.get(id);
  if (!entry) return;
  openById.delete(id);
  if (entry.key !== undefined && openByKey.get(entry.key) === id) openByKey.delete(entry.key);
}

/** The id of the open toast for `key`, if it is still up. */
function openFor(key: string): string | undefined {
  const id = openByKey.get(key);
  if (id === undefined) return undefined;
  const entry = openById.get(id);
  if (!entry || entry.until <= Date.now()) {
    forget(id);
    return undefined;
  }
  return id;
}

function show(kind: Kind, content: ReactNode, options?: ToastOptions, key?: string): string {
  if (onStage) return '';
  const dedupeKey = key ?? (typeof content === 'string' ? `text:${kind}:${content}` : undefined);
  if (dedupeKey !== undefined) {
    const existing = openFor(dedupeKey);
    if (existing !== undefined) return existing;
  }
  // Errors stay until dismissed (Capra reference pattern); the rest auto-dismiss.
  const base: ToastOptions = kind === 'error' ? { duration: 0, closable: true, position: TOAST_POSITION, ...options } : { position: TOAST_POSITION, ...options };
  let id = '';
  const opts: ToastOptions = {
    ...base,
    onClose: () => {
      forget(id);
      options?.onClose?.();
    },
  };
  id = Toast[kind](
    <span className="mr-toast-body" data-mr-toast={kind}>
      {content}
    </span>,
    opts,
  );
  const duration = opts.duration ?? CAPRA_DEFAULT_DURATION_MS;
  openById.set(id, { key: dedupeKey, until: duration > 0 ? Date.now() + Math.max(duration, CAPRA_MIN_DURATION_MS) : Infinity });
  if (dedupeKey !== undefined) openByKey.set(dedupeKey, id);
  return id;
}

/** Closes every toast this module opened. */
function clearAll(): void {
  const ids = [...openById.keys()];
  openById.clear();
  openByKey.clear();
  for (const id of ids) Toast.destroy(id);
}

export const notify = {
  success: (content: ReactNode, options?: ToastOptions) => show('success', content, options),
  info: (content: ReactNode, options?: ToastOptions) => show('info', content, options),
  warning: (content: ReactNode, options?: ToastOptions) => show('warning', content, options),
  error: (content: ReactNode, options?: ToastOptions) => show('error', content, options),

  /** Shows at most one open toast per key. Returns the open toast's id either way ('' on the stage). */
  once(key: string, kind: Kind, content: ReactNode, options?: ToastOptions): string {
    return show(kind, content, options, `key:${key}`);
  },

  /** Closes the keyed toast if it is open (e.g. the Leader answered again). */
  dismiss(key: string): void {
    const id = openByKey.get(`key:${key}`);
    if (id === undefined) return;
    forget(id);
    Toast.destroy(id);
  },

  /** Presenter or Story mode is up (true) or not: no toasts on the stage; entering it clears the open ones. */
  setStage(stage: boolean): void {
    if (stage && !onStage) clearAll();
    onStage = stage;
  },
};
