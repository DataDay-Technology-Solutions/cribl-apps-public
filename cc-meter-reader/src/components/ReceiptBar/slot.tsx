// src/components/ReceiptBar/slot.tsx — helpers for the receipt bar (and any copy that carries a figure).

import type { ReactNode } from 'react';

/** Splits a copy template on `{amount}`-style placeholders and slots in React nodes. */
export function slot(template: string, nodes: Record<string, ReactNode>): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) out.push(template.slice(last, m.index));
    const node = nodes[m[1]];
    out.push(node === undefined ? m[0] : <span key={`slot-${i++}`}>{node}</span>);
    last = m.index + m[0].length;
  }
  if (last < template.length) out.push(template.slice(last));
  return out;
}

/** Paid share of the bar, clamped to [0, 1] (paid can exceed would-have-paid; saved is then 0). */
export function paidShare(whpM: number, paidM: number): number {
  if (!(whpM > 0)) return 0;
  return Math.min(1, Math.max(0, paidM / whpM));
}
