// src/components/WhatIf/WhatIfSkeleton.tsx — the What-if's loading state (DESIGN_BRIEF 6: a skeleton matching
// the final layout, P1-J04): the calculator card's own shape — the Stream / Treatment / basis row, the four-cell
// before → after strip and the projected Receipt hero (P2-W08) — so /whatif never shows the Flow map's outline while it loads.

import { Skeleton, SkeletonGroup } from '@capra/core';
import { t } from '../../copy/en.ts';
import '../../views/Receipt/Receipt.css';
import './WhatIf.css';

function Field() {
  return (
    <div className="mr-whatif-skel-field">
      <Skeleton title={{ width: '30%' }} paragraph={false} />
      <SkeletonGroup.Input size="md" />
    </div>
  );
}

export function WhatIfSkeleton() {
  return (
    <section className="mr-whatif mr-whatif--skeleton" aria-busy="true" aria-label={t('whatif.loading')} data-testid="whatif-skeleton">
      <div className="mr-whatif-controls">
        <div className="mr-whatif-controls-main">
          <Field />
          <Field />
        </div>
      </div>
      <div className="mr-whatif-results">
        <div className="mr-whatif-compare-wrap">
          <Skeleton title={{ width: '22%' }} paragraph={false} />
          <div className="mr-whatif-compare" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="mr-whatif-cell">
                <Skeleton title={{ width: '60%' }} paragraph={{ rows: 2, width: ['45%', '75%'] }} />
              </div>
            ))}
          </div>
          <Skeleton title={false} paragraph={{ rows: 1, width: ['70%'] }} />
        </div>
        {/* The projected Receipt hero's shape (P2-W08): the perforated card, its label, figure, caption and bar. */}
        <div className="mr-hero-frame mr-whatif-heroframe" aria-hidden="true">
          <div className="mr-hero-shadow" />
          <div className="mr-panel mr-hero mr-hero--whatif mr-whatif-hero--skeleton">
            <Skeleton title={{ width: '55%' }} paragraph={{ rows: 3, width: ['70%', '80%', '100%'] }} />
          </div>
        </div>
      </div>
    </section>
  );
}
