// src/tour/dialogs.ts — opens the tour's dialog (the Slack message, the weekly receipt) from outside the
// React tree. The tour is driven by timers and toasts, so the dialog lives in its own small React root on
// <body> — the same technique Capra's imperative Modal API uses.

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TourDialog, type TourDialogContent } from './TourDialog.tsx';

export type { TourDialogContent } from './TourDialog.tsx';

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function close(): void {
  root?.render(null);
}

/** Opens (or replaces) the tour dialog. */
export function openTourDialog(content: TourDialogContent): void {
  if (typeof document === 'undefined') return;
  if (!host || !host.isConnected) {
    host = document.createElement('div');
    host.dataset.mrTourDialogs = '';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  root?.render(createElement(TourDialog, { content, onClose: close }));
}

/** Closes the dialog and releases its root (tour stopped). */
export function closeTourDialogs(): void {
  if (!root) return;
  const r = root;
  const h = host;
  root = null;
  host = null;
  r.unmount();
  h?.remove();
}
