// src/components/PriceTable/PresetPicker.tsx — the vendor-tile preset picker (EPIC_AUDIT P2-W24, finishing P0-20).
//
// The 15-line wrapping listbox becomes a popover grid that reads like a product: a search field, then the row's
// suggestion pinned first ("Suggested for this destination"), the vendors as tiles — a two-letter monogram in the
// destination ramp, the name, the typical $/GB — and Custom price and Internal / free last. Keyboard: the search
// field takes focus; ArrowDown enters the grid; arrows move by position (a tile above or below is the nearest
// one in that direction), Home/End jump, Enter or Space picks, typing jumps to the next tile whose name starts
// with what was typed, and Escape closes (the popover returns focus to its trigger). The list is a listbox of
// options, so assistive tech hears "Splunk Cloud · typical $2.25 / GB · range $1.47–$4.85, selected".

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Popover, TextField } from '@capra/core';
import { ChevronDown, Search } from '@capra/icons';
import type { PresetId } from '../../../core/types.ts';
import { t } from '../../copy/en.ts';
import { presetTileFor, presetTiles, type DraftPreset, type PresetTile } from './model.ts';

export interface PresetPickerProps {
  value: DraftPreset;
  suggested: PresetId;
  /** The row's destination name (the trigger's accessible name). */
  rowName: string;
  disabled?: boolean;
  onPick: (id: DraftPreset) => void;
}

/** The nearest tile from `from` in a direction, by position on screen (so it works across the groups' grids). */
function nearest(tiles: HTMLElement[], from: HTMLElement, dir: 'up' | 'down'): HTMLElement | undefined {
  const a = from.getBoundingClientRect();
  let best: { el: HTMLElement; score: number } | undefined;
  for (const el of tiles) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const dy = dir === 'down' ? b.top - a.top : a.top - b.top;
    if (dy <= 1) continue;
    const score = dy * 4 + Math.abs(b.left - a.left);
    if (!best || score < best.score) best = { el, score };
  }
  return best?.el;
}

function Tile({ tile, selected, active, onPick, onFocus }: { tile: PresetTile; selected: boolean; active: boolean; onPick: () => void; onFocus: () => void }) {
  return (
    <div
      role="option"
      id={`mr-pp-${tile.id}`}
      aria-selected={selected}
      aria-label={tile.label}
      tabIndex={active ? 0 : -1}
      className="mr-pp-tile"
      data-preset={tile.id}
      data-tone={tile.tone}
      onClick={onPick}
      onFocus={onFocus}
    >
      <span className="mr-pp-mono" aria-hidden="true">
        {tile.monogram}
      </span>
      <span className="mr-pp-text" aria-hidden="true">
        <span className="mr-pp-name">{tile.name}</span>
        <span className="mr-pp-caption">{tile.caption}</span>
      </span>
    </div>
  );
}

export const PresetPicker = memo(function PresetPicker({ value, suggested, rowName, disabled, onPick }: PresetPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<DraftPreset>(value);
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: '', at: 0 });

  const groups = useMemo(() => presetTiles(suggested, query), [suggested, query]);
  const flat = useMemo(() => [...(groups.suggested ? [groups.suggested] : []), ...groups.listed, ...groups.other], [groups]);
  const current = presetTileFor(value);

  // Opening starts from the selected tile with an empty search; closing forgets the search.
  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      setQuery('');
      if (next) setActiveId(value);
    },
    [value],
  );
  // The search field takes focus once the popover has rendered.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => searchRef.current?.querySelector('input')?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // The roving tab stop follows the filter: the active tile, else the first one shown.
  const rovingId = flat.some((tile) => tile.id === activeId) ? activeId : flat[0]?.id;

  const tilesInGrid = (): HTMLElement[] => Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
  const focusTile = (el: HTMLElement | undefined) => {
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: 'nearest' });
  };

  const pick = useCallback(
    (id: DraftPreset) => {
      onPick(id);
      onOpenChange(false);
    },
    [onPick, onOpenChange],
  );

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const tiles = tilesInGrid();
    const from = document.activeElement as HTMLElement | null;
    const i = from ? tiles.indexOf(from) : -1;
    if (i < 0) return;
    let next: HTMLElement | undefined;
    switch (e.key) {
      case 'ArrowRight':
        next = tiles[i + 1];
        break;
      case 'ArrowLeft':
        next = tiles[i - 1];
        break;
      case 'ArrowDown':
        next = nearest(tiles, tiles[i], 'down');
        break;
      case 'ArrowUp':
        next = nearest(tiles, tiles[i], 'up');
        if (!next) {
          e.preventDefault();
          searchRef.current?.querySelector('input')?.focus();
          return;
        }
        break;
      case 'Home':
        next = tiles[0];
        break;
      case 'End':
        next = tiles[tiles.length - 1];
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const id = tiles[i].dataset.preset as DraftPreset | undefined;
        if (id) pick(id);
        return;
      }
      default: {
        // Type-ahead: the next tile whose name starts with what was typed in the last half second.
        if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
        const now = Date.now();
        const text = (now - typeahead.current.at < 500 ? typeahead.current.text : '') + e.key.toLowerCase();
        typeahead.current = { text, at: now };
        const order = [...tiles.slice(i + (text.length === 1 ? 1 : 0)), ...tiles.slice(0, i + (text.length === 1 ? 1 : 0))];
        next = order.find((el) => (el.querySelector('.mr-pp-name')?.textContent ?? '').toLowerCase().startsWith(text));
        if (!next) return;
      }
    }
    if (next) {
      e.preventDefault();
      focusTile(next);
    }
  };

  const onSearchKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const tiles = tilesInGrid();
      focusTile(tiles.find((el) => el.dataset.preset === rovingId) ?? tiles[0]);
    } else if (e.key === 'Enter' && flat.length > 0) {
      // Enter in the search picks the first match: 'wind', Enter.
      e.preventDefault();
      pick(flat[0].id);
    }
  };

  const group = (key: string, heading: string, tiles: PresetTile[]) =>
    tiles.length === 0 ? null : (
      <div className="mr-pp-group" role="group" aria-labelledby={`mr-pp-h-${key}`} key={key} data-group={key}>
        <p className="mr-pp-heading" id={`mr-pp-h-${key}`}>
          {heading}
        </p>
        <div className="mr-pp-grid">
          {tiles.map((tile) => (
            <Tile
              key={tile.id}
              tile={tile}
              selected={tile.id === value}
              active={tile.id === rovingId}
              onPick={() => pick(tile.id)}
              onFocus={() => setActiveId(tile.id)}
            />
          ))}
        </div>
      </div>
    );

  const content = (
    <div className="mr-pp" data-testid="preset-picker">
      <div className="mr-pp-search" ref={searchRef} onKeyDown={onSearchKey}>
        <TextField
          aria-label={t('settings.prices.presetSearch')}
          placeholder={t('settings.prices.presetSearchPlaceholder')}
          leadingSlot={<Search size="sm" />}
          value={query}
          onChange={setQuery}
          autoComplete="off"
          data-testid="preset-search"
        />
      </div>
      <div className="mr-pp-scroll" role="listbox" aria-label={t('settings.prices.colPreset')} ref={gridRef} onKeyDown={onGridKey}>
        {group('suggested', t('settings.prices.presetSuggested'), groups.suggested ? [groups.suggested] : [])}
        {group('listed', t('settings.prices.presetGroupListed'), groups.listed)}
        {group('other', t('settings.prices.presetGroupOther'), groups.other)}
      </div>
      {flat.length === 0 ? (
        <p className="mr-pp-empty" role="status">
          {t('settings.prices.presetNoMatch', { query })}
        </p>
      ) : null}
    </div>
  );

  return (
    <span className="mr-pp-trigger" data-tone={current?.tone ?? 0}>
      <Popover content={content} placement="bottomLeft" isOpen={open} onOpenChange={onOpenChange}>
        <Button
          variant="secondary"
          block
          trailingIcon={ChevronDown}
          disabled={disabled}
          aria-label={t('settings.prices.presetPicker', { column: t('settings.prices.colPreset'), row: rowName, preset: current?.name ?? '' })}
          aria-haspopup="dialog"
          data-testid="preset-picker-trigger"
        >
          {current?.name ?? ''}
        </Button>
      </Popover>
    </span>
  );
});
