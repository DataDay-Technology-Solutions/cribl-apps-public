// src/components/common/ShortcutSheet.tsx — the "?" sheet: the one keyboard map (SPEC 13), and the switch that
// turns the single-key shortcuts off (WCAG 2.1.4, EPIC_AUDIT P1-A09), shared with the command palette.

import { useId, useState } from 'react';
import { Modal, Switch } from '@capra/core';
import { t } from '../../copy/en.ts';
import { DEMO_LEVER_SHORTCUTS, GLOBAL_SHORTCUTS, VIEW_SHORTCUTS, type ShortcutDef } from '../../lib/shortcuts.ts';
import { useActions, useAppState, useStoreApi } from '../../state/react.tsx';
import './common.css';
import './CommandPalette.css';

/**
 * "Single-key shortcuts" on or off, saved in the workspace's settings (it is the App's only persistence; no
 * browser storage). Absent means on. Disabled on sample data, where nothing is written.
 */
export function SingleKeySwitch() {
  const store = useStoreApi();
  const { saveSettings } = useActions();
  const enabled = useAppState((s) => s.settings.keyboard?.singleKeyShortcuts !== false);
  const canWrite = useAppState((s) => s.hasHydrated && s.source === 'live');
  const [state, setState] = useState<'idle' | 'saving' | 'failed'>('idle');
  const labelId = useId();
  const hintId = useId();
  const hint = !canWrite
    ? t('shortcuts.singleKeySample')
    : state === 'failed'
      ? t('shortcuts.singleKeyFailed')
      : enabled
        ? t('shortcuts.singleKeyOn')
        : t('shortcuts.singleKeyOff');
  return (
    <div className="mr-kbd-switch" data-testid="single-key-switch" data-enabled={enabled ? 'true' : 'false'}>
      <div className="mr-kbd-switch-text">
        <span id={labelId} className="mr-kbd-switch-label">
          {t('shortcuts.singleKey')}
        </span>
        <span id={hintId} className="mr-kbd-switch-hint" data-tone={state === 'failed' ? 'error' : undefined}>
          {hint}
        </span>
      </div>
      <Switch
        aria-labelledby={labelId}
        aria-describedby={hintId}
        checked={enabled}
        // Never disabled while saving: a focused control that turns disabled drops focus out of the dialog.
        disabled={!canWrite}
        aria-busy={state === 'saving' || undefined}
        onChange={(event) => {
          if (state === 'saving') return;
          const next = event.target.checked;
          setState('saving');
          void saveSettings({ ...store.getState().settings, keyboard: { singleKeyShortcuts: next } }).then((result) =>
            setState(result.ok ? 'idle' : 'failed'),
          );
        }}
      />
    </div>
  );
}

export interface ShortcutSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** List the demo lever keys (demo build with demo mode on). */
  showDemoLevers: boolean;
}

function Group({ title, items }: { title: string; items: readonly ShortcutDef[] }) {
  return (
    <section className="mr-shortcuts-group" aria-label={title}>
      <h3 className="mr-type-caption mr-shortcuts-heading">{title}</h3>
      <dl className="mr-shortcuts-list">
        {items.map((item) => (
          <div className="mr-shortcuts-row" key={`${item.key}-${item.label}`}>
            <dt>
              <kbd className="mr-kbd">{item.key}</kbd>
            </dt>
            <dd>{item.label}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ShortcutSheet({ isOpen, onClose, showDemoLevers }: ShortcutSheetProps) {
  return (
    <Modal
      isOpen={isOpen}
      onIsOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('shortcuts.title')}
      size="sm"
      confirmButtonText={t('shortcuts.close')}
      cancelButtonText={null}
      onConfirm={onClose}
    >
      <div className="mr-shortcuts">
        <Group title={t('shortcuts.groupEverywhere')} items={GLOBAL_SHORTCUTS} />
        <Group title={t('shortcuts.groupViews')} items={VIEW_SHORTCUTS} />
        {showDemoLevers ? <Group title={t('shortcuts.groupDemo')} items={DEMO_LEVER_SHORTCUTS} /> : null}
        <p className="mr-type-caption">{t('shortcuts.note')}</p>
        <SingleKeySwitch />
      </div>
    </Modal>
  );
}
