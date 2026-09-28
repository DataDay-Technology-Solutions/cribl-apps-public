// src/views/Flow/FlowStage.tsx — the Flow map on stage (P2-W10, /flow?stage=1, F on the Flow view): the whole
// viewport, no tabs, no title, no footer. The presenter view owns `?present=1` and the Shell sends it to '/' (P0-06),
// so the map's stage is its own layer: a portal on <body> over the app, with the app made inert beneath it (no focus
// or screen reader wanders into the hidden tabs) and the page's scroll held while it is up. P or Escape leaves.

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function FlowStage({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = document.getElementById('root');
    const html = document.documentElement;
    const overflow = html.style.overflow;
    root?.setAttribute('inert', '');
    html.style.overflow = 'hidden';
    // the keyboard starts on the stage, not on a tab it can no longer reach
    ref.current?.focus({ preventScroll: true });
    return () => {
      root?.removeAttribute('inert');
      html.style.overflow = overflow;
    };
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={ref} className="mr-flowstage" role="region" aria-label={label} tabIndex={-1} data-testid="flow-stage">
      {children}
    </div>,
    document.body,
  );
}
