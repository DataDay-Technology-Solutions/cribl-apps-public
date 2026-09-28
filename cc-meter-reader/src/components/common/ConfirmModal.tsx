// src/components/common/ConfirmModal.tsx — the confirmation AGENTS.md requires before any volatile
// operation ("Confirming Destructive Operations"): opened only by a deliberate click, it names EXACTLY
// what will be affected (resource and action), warns when it cannot be undone, runs the operation, and
// reports the outcome. Capra's imperative `Modal.danger` has no Cancel button, so this is a controlled
// Capra `Modal` with its own footer.

import { useState, type ReactNode } from 'react';
import { Alert, Button, Modal } from '@capra/core';
import { t } from '../../copy/en.ts';
import { notify } from './notify.tsx';
import './common.css';

export interface AffectedItem {
  /** What it is, in plain words: "Pipeline Payments API sampling". */
  label: string;
  /** Its id, shown in code style: "mrd_pay_sample". */
  id?: string;
  /** The action on it: "disable the [mr-trim] function, commit and deploy". */
  action?: string;
}

export interface ConfirmModalProps {
  isOpen: boolean;
  /** Question form, e.g. "Break the trim on Payments API sampling?" */
  title: string;
  /** Explanation above the affected list. */
  body?: ReactNode;
  /** Every resource the operation touches. Required: a confirmation that names nothing is not one. */
  affects: AffectedItem[];
  /** Adds "This cannot be undone." */
  irreversible?: boolean;
  /** Verb-first label for the confirm button ("Break the trim", "Delete Endpoint"). */
  confirmText: string;
  cancelText?: string;
  /** Destructive styling for the confirm button (default true). */
  danger?: boolean;
  /** Runs the operation. Throw (or reject) to keep the modal open and show the reason. */
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  /** Toast shown after success (the outcome report AGENTS.md asks for). */
  successMessage?: string;
}

export function ConfirmModal(props: ConfirmModalProps) {
  const { isOpen, title, body, affects, irreversible, confirmText, cancelText, danger = true, onConfirm, onClose, successMessage } = props;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Every way out clears the failure line, so the next opening starts clean.
  const close = () => {
    setFailure(null);
    onClose();
  };

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      await onConfirm();
      setPending(false);
      close();
      if (successMessage) notify.success(successMessage);
    } catch (error) {
      setPending(false);
      setFailure(t('confirm.failed', { reason: error instanceof Error ? error.message : String(error) }));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onIsOpenChange={(open) => {
        if (!open && !pending) close();
      }}
      title={title}
      size="sm"
      isDismissible={!pending}
      footer={
        <Modal.FooterActions>
          <Button slot="close" variant="secondary" disabled={pending}>
            {cancelText ?? t('confirm.cancel')}
          </Button>
          <Button variant="primary" appearance={danger ? 'danger' : 'default'} pending={pending} onPress={() => void confirm()}>
            {confirmText}
          </Button>
        </Modal.FooterActions>
      }
    >
      <div className="mr-confirm">
        {body ? <div className="mr-confirm-body">{body}</div> : null}
        <div>
          <p className="mr-type-caption">{t('confirm.affects')}</p>
          <ul className="mr-confirm-list">
            {affects.map((item, i) => (
              <li key={`${item.id ?? item.label}-${i}`}>
                <span className="mr-confirm-label">{item.label}</span>
                {item.id ? <code className="mr-confirm-id">{item.id}</code> : null}
                {item.action ? <span className="mr-confirm-action">{item.action}</span> : null}
              </li>
            ))}
          </ul>
        </div>
        {irreversible ? <p className="mr-confirm-warning">{t('confirm.cannotUndo')}</p> : null}
        {failure ? (
          <Alert appearance="danger" layout="inline">
            {failure}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}
