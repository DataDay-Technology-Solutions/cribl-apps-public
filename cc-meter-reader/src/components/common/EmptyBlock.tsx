// src/components/common/EmptyBlock.tsx — the ONE empty-state pattern (DESIGN_BRIEF 6, BEAUTY F14): a 40 % ghost
// of the real layout, one sentence, and at most one action. No stock illustrations: a sleeping cloud or an empty
// folder says "generic template"; a faint outline of the table (or chart, or map) that will fill in says what is
// coming and where.
//
// `illustration` is still accepted so existing callers type-check, and ignored. Pass `ghost` to pick the shape
// that matches the component the empty state stands in for: 'flow' for the Flow / What-if map, 'card' for a
// stack of setting cards (Where to send alerts), 'rows' (the default) for a table.

import type { ReactNode } from 'react';
import { Ghost, type GhostShape } from './Ghost.tsx';
import './common.css';

export interface EmptyBlockProps {
  title: string;
  description?: string;
  /** @deprecated Ignored — stock illustrations are gone (BEAUTY F14). Use `ghost`. */
  illustration?: string;
  size?: 'md' | 'lg';
  /** The ghost of the real layout shown above the sentence (default: table rows). `false` for none. */
  ghost?: GhostShape | false;
  /** At most one action (a Capra Button) under the description. */
  children?: ReactNode;
}

export function EmptyBlock({ title, description, size = 'md', ghost = 'rows', children }: EmptyBlockProps) {
  return (
    <div className={`mr-empty mr-empty--${size}`} data-empty={ghost || 'none'}>
      {ghost ? <Ghost shape={ghost} className="mr-empty-ghost" /> : null}
      <div className="mr-empty-content">
        <p className="mr-empty-title">{title}</p>
        {description ? <p className="mr-empty-body">{description}</p> : null}
        {children ? <div className="mr-empty-actions">{children}</div> : null}
      </div>
    </div>
  );
}
