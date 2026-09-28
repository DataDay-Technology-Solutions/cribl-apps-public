// src/views/Flow/FlowStates.tsx — every non-map state of the Flow view in the map's own frame (P1-I07): the same two
// cards (the map card beside the receipt card, 932 + 332 at 1440) with a 40 % grey Sankey where the map will be, so
// loading, an error, a rate limit, "nothing priced" and "no traffic" never collapse into a lone banner over a blank
// page, and nothing snaps from one layout to another when the map arrives.

import type { ReactNode } from 'react';
import { Skeleton } from '@capra/core';
import { t } from '../../copy/en.ts';
import { bandPath } from '../../components/FlowDiagram/layout.ts';

/** A still Sankey (six flows, three columns) in the ghost tokens: the shape the map will take. */
const GHOST_FLOWS = [
  { s: 40, p: 40, d: 60, w: 70, out: 50 },
  { s: 150, p: 110, d: 110, w: 50, out: 40 },
  { s: 240, p: 200, d: 250, w: 60, out: 60 },
  { s: 340, p: 260, d: 310, w: 40, out: 25 },
  { s: 420, p: 370, d: 420, w: 55, out: 35 },
  { s: 500, p: 425, d: 455, w: 30, out: 20 },
] as const;
const GHOST_PIPES = [
  [40, 160],
  [200, 300],
  [370, 455],
] as const;
const GHOST_DESTS = [
  [60, 150],
  [250, 335],
  [420, 475],
] as const;

export function FlowGhost({ loading = false }: { loading?: boolean }) {
  return (
    <div className={`mr-ghost mr-flowview-ghost${loading ? ' is-loading' : ''}`} aria-hidden="true" data-ghost="flow-map">
      <svg viewBox="0 0 1000 560" preserveAspectRatio="none" focusable="false">
        {GHOST_FLOWS.map((f, i) => (
          <g key={i}>
            <path className="mr-ghost-ribbon" d={bandPath(132, f.s, 490, f.p, f.w)} vectorEffect="non-scaling-stroke" />
            <path className="mr-ghost-ribbon" d={bandPath(502, f.p, 866, f.d, f.out)} vectorEffect="non-scaling-stroke" />
            <rect className="mr-ghost-node" x={120} y={f.s} width={12} height={f.w} rx={2} />
          </g>
        ))}
        {GHOST_PIPES.map(([y0, y1], i) => (
          <rect key={`p${i}`} className="mr-ghost-node" x={490} y={y0} width={12} height={y1 - y0} rx={2} />
        ))}
        {GHOST_DESTS.map(([y0, y1], i) => (
          <rect key={`d${i}`} className="mr-ghost-node" x={866} y={y0} width={12} height={y1 - y0} rx={2} />
        ))}
      </svg>
    </div>
  );
}

/** The receipt card's place: a title and the receipt lines, as a skeleton while loading, else a still ghost. */
function CardGhost({ loading }: { loading: boolean }) {
  return (
    <section className="mr-receipt mr-flowview-cardghost" aria-hidden="true">
      {loading ? (
        <Skeleton title paragraph={{ rows: 7 }} />
      ) : (
        <div className="mr-ghost mr-flowview-cardghost-lines">
          <span className="mr-ghost-bar" style={{ width: '32%' }} />
          <span className="mr-ghost-bar mr-flowview-cardghost-title" style={{ width: '64%' }} />
          {[82, 74, 88, 70, 80].map((w, i) => (
            <span key={i} className="mr-ghost-bar" style={{ width: `${w}%` }} />
          ))}
        </div>
      )}
    </section>
  );
}

export type FlowStateKind = 'loading' | 'error' | 'unpriced' | 'no-data' | 'no-traffic';

/**
 * The two-card frame of the map with the Sankey ghost behind `children` (a notice, an empty state), or alone while
 * loading. `data-state` names which one it is.
 */
export function FlowStateFrame({ state, children, testId }: { state: FlowStateKind; children?: ReactNode; testId?: string }) {
  const loading = state === 'loading';
  return (
    <div className="mr-flowmap mr-flowview-state" data-state={state} data-testid={testId ?? 'flow-state'}>
      <section className="mr-flowmap-diagram mr-flowview-statecard" aria-busy={loading || undefined} aria-label={loading ? t('common.loading') : undefined}>
        <FlowGhost loading={loading} />
        {children ? <div className="mr-flowview-statebody">{children}</div> : null}
      </section>
      <aside className="mr-flowmap-card">
        <CardGhost loading={loading} />
      </aside>
    </div>
  );
}
