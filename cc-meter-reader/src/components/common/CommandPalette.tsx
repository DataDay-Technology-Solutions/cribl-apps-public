// src/components/common/CommandPalette.tsx — ⌘K / Ctrl+K (and ?) : go to anything, run anything (EPIC_AUDIT P2-W22).
//
// It replaces the static shortcut sheet. One field finds the tabs and Settings pages, every source, pipeline
// and destination on screen by the names the app shows ('wind' → the Windows flows' Ledger rows), and the
// actions — Presenter, Story, the booth loop, the Ledger search, the report card, Sweep now, diagnostics and,
// in the demo build with demo mode on, the levers — each with the key cap it answers to outside the palette.
// With an empty field it is the keyboard map. Inside it single letters only type: the shortcut conflicts
// end here, and with "Single-key shortcuts" off (its switch sits at the bottom) ⌘K is the keyboard's way to
// everything.
//
// ARIA: a combobox field that owns a listbox (aria-activedescendant); ↑ ↓ move, Enter runs, Esc closes, a click
// runs. An action that is a key in the map runs that key's own handler (runShortcut), so a lever still asks
// for its confirmation.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Modal } from '@capra/core';
import { SearchOutlined } from '@capra/icons';
import { t } from '../../copy/en.ts';
import { DEMO_LEVER_SHORTCUTS, runShortcut, showShortcutChip } from '../../lib/shortcuts.ts';
import { useAppState, useServices } from '../../state/react.tsx';
import { focusSearchWhenReady } from '../Shell/useShellEffects.ts';
import { GROUP_ORDER, filterItems, paletteItems, withStickyParams, type PaletteGroup, type PaletteItem } from './paletteItems.ts';
import { SingleKeySwitch } from './ShortcutSheet.tsx';
import './CommandPalette.css';
import { guardNavigation, targetPath } from '../../lib/navGuard.ts';

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  /** List the demo lever keys (demo build with demo mode on). */
  showDemoLevers: boolean;
}

/** The matches grouped, groups ordered by their best match (the list the field owns). */
function groupsOf(items: readonly PaletteItem[]): { group: PaletteGroup; items: PaletteItem[] }[] {
  const order: PaletteGroup[] = [];
  const by = new Map<PaletteGroup, PaletteItem[]>();
  for (const item of items) {
    if (!by.has(item.group)) {
      by.set(item.group, []);
      order.push(item.group);
    }
    by.get(item.group)?.push(item);
  }
  return order.map((group) => ({ group, items: by.get(group) ?? [] }));
}

function KeyCap({ cap }: { cap: string }) {
  return (
    <span className="mr-palette-keys" aria-hidden="true">
      {cap.split('+').map((k) => (
        <kbd key={k} className="mr-kbd">
          {k}
        </kbd>
      ))}
    </span>
  );
}

function PaletteBody({ onClose, showDemoLevers }: Omit<CommandPaletteProps, 'isOpen'>) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const { meter } = useServices();
  const snapshot = useAppState((s) => s.snapshot);
  const labels = useAppState((s) => s.settings.humanize);
  const canSweep = useAppState((s) => s.source === 'live' && s.hasHydrated);
  const demoTab = useAppState((s) => import.meta.env.VITE_MR_BUILD === 'demo' && s.settings.demo.enabled);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-o${i}`;

  const all = useMemo(
    () => paletteItems({ snapshot, labels, canSweep, demoTab, levers: showDemoLevers ? DEMO_LEVER_SHORTCUTS : [] }),
    [snapshot, labels, canSweep, demoTab, showDemoLevers],
  );
  const matches = useMemo(() => filterItems(all, query), [all, query]);
  const groups = useMemo(() => (query.trim() ? groupsOf(matches) : GROUP_ORDER.map((g) => ({ group: g, items: matches.filter((m) => m.group === g) })).filter((g) => g.items.length > 0)), [matches, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const current = Math.min(active, Math.max(0, flat.length - 1));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    document.getElementById(`${listId}-o${current}`)?.scrollIntoView({ block: 'nearest' });
  }, [current, listId]);

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    const r = item.run;
    if (r.kind === 'navigate') {
      const to = withStickyParams(r.to, new URLSearchParams(search));
      // Asks the in-app navigation guard first (unsaved Settings drafts, src/lib/navGuard.ts).
      guardNavigation(targetPath(to), () => {
        void navigate(to);
        if (r.focusSearch) focusSearchWhenReady();
      });
    } else if (r.kind === 'sweep') {
      showShortcutChip(t('palette.sweeping'));
      void meter.sweepNow();
    } else {
      // After the dialog has gone, so a lever's own confirmation (or the stage) opens on a clean page.
      window.setTimeout(() => runShortcut(r.key), 0);
    }
  };

  const indexOf = new Map(flat.map((item, i) => [item.id, i]));
  return (
    <div className="mr-palette" data-testid="command-palette">
      <div className="mr-palette-field">
        <span className="mr-palette-field-icon" aria-hidden="true">
          <SearchOutlined />
        </span>
        <input
          ref={inputRef}
          className="mr-palette-input"
          type="text"
          role="combobox"
          aria-label={t('palette.inputLabel')}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={flat.length > 0 ? optionId(current) : undefined}
          placeholder={t('palette.placeholder')}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (flat.length === 0) return;
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setActive((current + step + flat.length) % flat.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(flat[current]);
            }
          }}
          data-testid="palette-input"
        />
      </div>
      <div className="mr-palette-results" role="listbox" id={listId} aria-label={t('palette.title')}>
        {groups.map(({ group, items }) => (
          <div key={group} role="group" aria-labelledby={`${listId}-${group}`} className="mr-palette-section">
            <div id={`${listId}-${group}`} className="mr-palette-group" role="presentation">
              {t(`palette.groups.${group}`)}
            </div>
            {items.map((item) => {
              const i = indexOf.get(item.id) ?? 0;
              return (
                <div
                  key={item.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === current}
                  className="mr-palette-item"
                  data-group={item.group}
                  onMouseMove={() => i !== current && setActive(i)}
                  onClick={() => run(item)}
                >
                  <span className="mr-palette-text">
                    <span className="mr-palette-label">{item.label}</span>
                    {item.hint ? <span className="mr-palette-hint">{item.hint}</span> : null}
                  </span>
                  {item.keyCap ? <KeyCap cap={item.keyCap} /> : null}
                </div>
              );
            })}
          </div>
        ))}
        {flat.length === 0 ? <p className="mr-palette-empty">{t('palette.empty', { query: query.trim() })}</p> : null}
      </div>
      <p className="mr-palette-foot">
        <span>{t('palette.hint')}</span>
        <span>{t('palette.openHint')}</span>
      </p>
      <SingleKeySwitch />
    </div>
  );
}

export function CommandPalette({ isOpen, onClose, showDemoLevers }: CommandPaletteProps) {
  return (
    <Modal
      isOpen={isOpen}
      onIsOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('palette.title')}
      size="md"
      footer={null}
    >
      {isOpen ? <PaletteBody onClose={onClose} showDemoLevers={showDemoLevers} /> : null}
    </Modal>
  );
}
