// src/components/common/Loading.tsx — skeleton states (PRD 8.6 "skeleton loading", 8.8 item 4: no
// shimmer longer than 1.2 s — so skeletons are static unless a caller opts into `active`).

import type { ReactNode } from 'react';
import { Skeleton } from '@capra/core';
import { t } from '../../copy/en.ts';
import './common.css';

export interface LoadingBlockProps {
  loading: boolean;
  /** Paragraph rows in the placeholder. */
  rows?: number;
  title?: boolean;
  active?: boolean;
  children?: ReactNode;
}

/** Shows a skeleton while `loading`, then its children. */
export function LoadingBlock({ loading, rows = 3, title = true, active = false, children }: LoadingBlockProps) {
  return (
    <Skeleton loading={loading} title={title} paragraph={{ rows }} active={active}>
      {children}
    </Skeleton>
  );
}

/** Full-view placeholder: the Suspense fallback while a lazy view loads, shaped like a Meter Reader page. */
export function ViewSkeleton() {
  return (
    <div className="mr-view-skeleton" aria-busy="true" aria-label={t('common.loading')}>
      <div className="mr-view-skeleton-hero">
        <Skeleton title={{ width: '40%' }} paragraph={{ rows: 2, width: ['60%', '35%'] }} />
      </div>
      <div className="mr-grid">
        {[0, 1, 2].map((i) => (
          <div key={i} className="mr-span-4 mr-panel">
            <Skeleton title paragraph={{ rows: 3 }} />
          </div>
        ))}
      </div>
    </div>
  );
}
