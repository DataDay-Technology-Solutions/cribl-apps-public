// src/views/Presenter/StageKeys.tsx — the stage's own keys (P1-B03): Escape leaves presenter mode like P does,
// and "?" opens a stage-scaled list of the keys instead of the app's small Capra sheet over the number.
//
//   • "?" is registered here for as long as the stage is up; the shortcut registry is a stack, so the stage's
//     handler wins over the shell's while this view is mounted and the shell's sheet comes back after it.
//   • The list reads from the back of the room (keys ≥ 24 px at 1920, scaled with the stage like everything
//     else), uses the stage's neutrals only (no accent blue), and lists the demo lever keys when demo mode is on.
//   • Any key closes it, and that keypress is consumed (capture phase, ahead of the shell's dispatcher), so the
//     key that clears the list never also pulls a lever or leaves presenter mode — the same rule as the
//     incident takeover. A click anywhere closes it too.
//   • Escape leaves presenter mode unless something on the stage wants it first (the list, an alert card, an
//     open dialog, a focused field).

import { useEffect, useId, useRef, useState } from 'react';
import { t } from '../../copy/en.ts';
import { isTypingTarget } from '../../lib/dom.ts';
import { IS_DEMO_BUILD } from '../../lib/env.ts';
import { useAppParams } from '../../lib/params.ts';
import { DEMO_LEVER_SHORTCUTS, showShortcutChip, useShortcut, type ShortcutDef } from '../../lib/shortcuts.ts';
import { useAppState } from '../../state/react.tsx';

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS']);

/** Something else on the stage owns the keyboard: an open dialog or an incident card on stage. */
function keyboardClaimed(): boolean {
  return document.querySelector('[aria-modal="true"], .mr-takeover') !== null;
}

function KeyRows({ items }: { items: readonly ShortcutDef[] }) {
  return (
    <dl className="mr-pv-keys-list">
      {items.map((item) => (
        <div className="mr-pv-keys-row" key={`${item.key}-${item.label}`}>
          <dt>
            {item.key.split(' ').map((k) => (
              <kbd key={k} className="mr-pv-key">
                {k}
              </kbd>
            ))}
          </dt>
          <dd>{item.label}</dd>
        </div>
      ))}
    </dl>
  );
}

export function StageKeys() {
  const [params, setParams] = useAppParams();
  const [open, setOpen] = useState(false);
  const demoLevers = useAppState((s) => IS_DEMO_BUILD && s.settings.demo.enabled);
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement | null>(null);

  useShortcut('?', () => setOpen(true));

  // Escape leaves presenter mode (P does the same through the shell).
  useEffect(() => {
    if (open || !params.present) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat) return;
      if (isTypingTarget(event.target) || keyboardClaimed()) return;
      event.preventDefault();
      setParams({ present: false });
      showShortcutChip(t('shortcuts.chipPresenterOff'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, params.present, setParams]);

  // While the list is up: any key closes it and is consumed; focus goes to the list and comes back after.
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || MODIFIER_KEYS.has(event.key) || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      if (before?.isConnected) before.focus();
    };
  }, [open]);

  if (!open) return null;
  const stage: ShortcutDef[] = [
    { key: 'P Esc', label: t('presenter.keys.leave') },
    { key: 'Y', label: t('presenter.keys.story') },
    { key: '?', label: t('presenter.keys.show') },
    { key: 'M', label: t('presenter.keys.chime') },
  ];
  return (
    <div className="mr-pv-keys-backdrop" onClick={() => setOpen(false)}>
      <div
        ref={sheetRef}
        className="mr-pv-keys"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="stage-keys"
      >
        <h2 id={titleId} className="mr-pv-keys-title">
          {t('presenter.keys.title')}
        </h2>
        <KeyRows items={stage} />
        <p className="mr-pv-keys-note">{t('presenter.keys.card')}</p>
        {demoLevers && DEMO_LEVER_SHORTCUTS.length > 0 ? (
          <>
            <h3 className="mr-pv-keys-group">{t('shortcuts.groupDemo')}</h3>
            <KeyRows items={DEMO_LEVER_SHORTCUTS} />
          </>
        ) : null}
        <p className="mr-pv-keys-close">{t('presenter.keys.close')}</p>
      </div>
    </div>
  );
}
