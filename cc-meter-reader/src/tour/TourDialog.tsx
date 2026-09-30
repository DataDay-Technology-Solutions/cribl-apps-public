// src/tour/TourDialog.tsx — the two things a tour toast can open: what the regression's Cribl notification target
// received (plain text: the release hands every alert to Cribl, D57; founder-build r1 ui-7 m1, r2 ui-11 IC-14 — no Slack
// card) and the weekly receipt (SPEC 12.4 text form, the monospace receipt with dot leaders).
//
// Rendered by src/tour/dialogs.ts in its own small React root: it needs no app context — everything it
// shows arrives as props. Capra portals the modal into <body>, where the host theme's `.dark` class
// lives, so both themes apply.

import { Modal, Text } from '@capra/core';
import type { WeeklyReceipt } from '../../core/types.ts';
import { receiptText } from '../../core/receipt.ts';
import { t } from '../copy/en.ts';
import './tour.css';

export type TourDialogContent =
  /** What a Cribl notification target received: plain text (founder-build r1 ui-7, m1). */
  | { kind: 'target'; endpoint: string; text: string; time: string }
  | { kind: 'receipt'; receipt: WeeklyReceipt };

export interface TourDialogProps {
  content: TourDialogContent;
  onClose: () => void;
}

export function TourDialog({ content, onClose }: TourDialogProps) {
  const title = content.kind === 'target' ? t('tour.dialog.targetTitle', { endpoint: content.endpoint }) : t('tour.dialog.receiptTitle', { label: content.receipt.label });
  return (
    <Modal
      isOpen
      onIsOpenChange={(open) => {
        if (!open) onClose();
      }}
      onClose={onClose}
      onConfirm={onClose}
      title={title}
      size="sm"
      confirmButtonText={t('tour.dialog.close')}
      cancelButtonText={null}
    >
      {content.kind === 'target' ? (
        <div className="mr-tour-dialog" data-tour-dialog="target">
          <div className="mr-tour-receipt-frame">
            <pre className="mr-tour-receipt mr-tour-target mr-num" data-callout="target-message">
              {content.text}
            </pre>
          </div>
          <Text as="p" variant="body-sm-normal" color="secondary">
            {t('tour.dialog.targetCaption')}
          </Text>
        </div>
      ) : (
        <div className="mr-tour-dialog" data-tour-dialog="receipt">
          <div className="mr-tour-receipt-frame">
            <pre className="mr-tour-receipt mr-num" data-callout="receipt-total">
              {receiptText(content.receipt)}
            </pre>
          </div>
          <Text as="p" variant="body-sm-normal" color="secondary">
            {t('tour.dialog.receiptCaption')}
          </Text>
        </div>
      )}
    </Modal>
  );
}
