// src/components/common/InlineNotice.tsx — a neutral, one-line notice (BEAUTY F10: colour is spent on money and
// severity, not on chrome). Capra's Alert has no neutral appearance (info is blue, warning amber), so setup notes
// such as "1 destination is unpriced" and "hidden by your filters" use this instead: an info glyph in subtle text,
// the sentence, and at most one action or a dismiss button.

import type { ReactNode } from 'react';
import { Button, IconButton } from '@capra/core';
import { CloseOutlined, InfoOutlined } from '@capra/icons';
import { t } from '../../copy/en.ts';
import './common.css';

export interface InlineNoticeProps {
  children: ReactNode;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  /** 'card' sits between cards with the card border; 'inline' sits inside a card (no border). */
  variant?: 'card' | 'inline';
  'data-testid'?: string;
  'data-state'?: string;
}

export function InlineNotice({ children, action, onDismiss, variant = 'card', ...rest }: InlineNoticeProps) {
  return (
    <div className={`mr-notice mr-notice--${variant}`} role="status" data-testid={rest['data-testid']} data-state={rest['data-state']}>
      <span className="mr-notice-icon" aria-hidden="true">
        <InfoOutlined size="sm" />
      </span>
      <p className="mr-notice-text">{children}</p>
      {action || onDismiss ? (
        <span className="mr-notice-actions">
          {action ? (
            <Button variant="secondary" size="sm" onPress={action.onClick}>
              {action.label}
            </Button>
          ) : null}
          {onDismiss ? <IconButton icon={CloseOutlined} aria-label={t('common.close')} size="sm" variant="tertiary" onPress={onDismiss} /> : null}
        </span>
      ) : null}
    </div>
  );
}
