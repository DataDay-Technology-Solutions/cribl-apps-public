// src/components/PriceTable/PriceTable.tsx — the Prices table (PRD 6, 8.4; DESIGN_BRIEF 5.5; SPEC 6, 8).
//
// One row per destination: name (humanized) + status badge, id · type · group; Preset (auto-suggested,
// each option naming its typical $/GB and range, with an ⓘ popover on what that price rests on);
// $ / GB ("Your contract rate" under it); "Without Cribl this data would go to". A table on wide
// containers, a stack of cards on narrow ones (container query), so it works in the Settings column at
// 1440 and at 390. Fields inside rows carry aria-labels; the per-cell captions are visible only in the
// card layout. The committed rate stays in the schema (PriceEntry.committedMilliCentsPerGb) and a stored
// one is kept on save, but 1.0 shows no column for it: nothing in core reads it yet (P0-19, P1-F10).

import { memo, useState } from 'react';
import { Pill, SelectField, TextField, type Key } from '@capra/core';
import { CheckOutlined } from '@capra/icons';
import { t } from '../../copy/en.ts';
import {
  CUSTOM_PRESET,
  applyPreset,
  counterfactualOptions,
  destinationMeta,
  editPrice,
  isCustomDraft,
  historyNewestFirst,
  pricePlaceholder,
  rowNoteLine,
  type Option,
  type PriceDraft,
  type PriceFieldErrors,
  type PriceRow,
} from './model.ts';
import { PresetInfoButton } from './PresetInfoButton.tsx';
import { PresetPicker } from './PresetPicker.tsx';
import { PriceHistoryList } from './PriceHistory.tsx';
import { RowReceiptLine } from './LiveReceipt.tsx';
import type { RowReceipt } from './receiptModel.ts';
import './PriceTable.css';

export interface PriceTableProps {
  rows: readonly PriceRow[];
  drafts: Record<string, PriceDraft>;
  /** Inline errors by row key. */
  errors: Record<string, PriceFieldErrors>;
  /** Row keys whose draft differs from what is stored. */
  dirty: ReadonlySet<string>;
  onChange: (key: string, draft: PriceDraft) => void;
  /** Read-only (sample data, not hydrated, 403). */
  disabled?: boolean;
  /** P2-W09: each row's live receipt line (the last sweep's traffic at the price on screen), by row key. */
  receipt?: Record<string, RowReceipt>;
  /** P2-W24: the display timezone for each row's price history. */
  tz?: string;
}

export function PriceTable({ rows, drafts, errors, dirty, onChange, disabled, receipt, tz }: PriceTableProps) {
  return (
    <div className="mr-pt" role="table" aria-label={t('settings.groups.prices')} aria-rowcount={rows.length + 1}>
      <div className="mr-pt-head" role="row">
        <span role="columnheader" className="mr-pt-col-dest">
          {t('settings.prices.colDestination')}
        </span>
        <span role="columnheader">{t('settings.prices.colPreset')}</span>
        <span role="columnheader">{t('settings.prices.colPrice')}</span>
        <span role="columnheader">{t('settings.prices.colCounterfactual')}</span>
      </div>
      {rows.map((row) => (
        <PriceTableRow
          key={row.key}
          row={row}
          draft={drafts[row.key]}
          errors={errors[row.key]}
          dirty={dirty.has(row.key)}
          cfOptions={counterfactualOptions(row, rows)}
          onChange={onChange}
          disabled={disabled}
          line={receipt?.[row.key]}
          tz={tz}
        />
      ))}
    </div>
  );
}

interface RowProps {
  row: PriceRow;
  draft: PriceDraft | undefined;
  errors: PriceFieldErrors | undefined;
  dirty: boolean;
  cfOptions: Option[];
  onChange: (key: string, draft: PriceDraft) => void;
  disabled?: boolean;
  line?: RowReceipt;
  tz?: string;
}

const PriceTableRow = memo(function PriceTableRow({ row, draft, errors, dirty, cfOptions, onChange, disabled, line, tz }: RowProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  if (!draft) return null;
  const set = (patch: Partial<PriceDraft>) => onChange(row.key, { ...draft, ...patch });
  const suggestion = pricePlaceholder(draft.preset);
  const isCustom = isCustomDraft(draft);
  const ids = `mr-pt-${row.groupId}-${row.outputId}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return (
    <div className="mr-pt-row" role="row" data-dirty={dirty ? 'true' : undefined} data-output={row.outputId} data-testid={`price-row-${row.outputId}`}>
      <div className="mr-pt-cell mr-pt-dest" role="cell">
        <div className="mr-pt-name-line">
          <span className="mr-pt-name" id={`${ids}-name`}>
            {row.name}
          </span>
          <span className="mr-pt-badge" data-status={row.unpriced ? 'unpriced' : 'priced'}>
            {/* Priced is a state, not money: a neutral outline pill with a check (EPIC_AUDIT P1-G08). */}
            <Pill appearance={row.unpriced ? 'warning' : 'default'} variant="outline" inline icon={row.unpriced ? undefined : <CheckOutlined />}>
              {row.unpriced ? t('unpriced.badge') : t('settings.prices.priced')}
            </Pill>
          </span>
        </div>
        <span className="mr-pt-meta" title={t('settings.prices.meta', { id: row.outputId, type: row.type, group: row.groupId })}>
          {destinationMeta(row)}
        </span>
        {row.type === 'router' && row.unpriced ? (
          <span className="mr-pt-meta" data-testid={`price-router-hint-${row.outputId}`}>
            {t('settings.prices.routerHint')}
          </span>
        ) : null}
        {row.history && row.history.length > 0 ? (
          <button
            type="button"
            className="mr-pt-history-toggle"
            aria-expanded={historyOpen}
            aria-controls={`${ids}-history`}
            onClick={() => setHistoryOpen((o) => !o)}
            data-testid={`price-history-toggle-${row.outputId}`}
          >
            {t('settings.prices.historyToggle', { n: row.history.length })}
          </button>
        ) : null}
      </div>

      <div className="mr-pt-cell mr-pt-preset" role="cell">
        <span className="mr-pt-cell-label" aria-hidden="true">
          {t('settings.prices.colPreset')}
        </span>
        <div className="mr-pt-preset-line">
          {/* A popover grid of vendor tiles, the suggestion pinned first (P2-W24, finishing P0-20). */}
          <PresetPicker
            value={draft.preset}
            suggested={row.suggestedPreset}
            rowName={row.name}
            disabled={disabled}
            onPick={(id) => onChange(row.key, applyPreset(draft, id))}
          />
          {/* Custom price rests on nothing but the member's contract: no ⓘ, and a spacer keeps the column even. */}
          {draft.preset === CUSTOM_PRESET ? (
            <span className="mr-pt-info-spacer" aria-hidden="true" />
          ) : (
            <PresetInfoButton preset={draft.preset} rowName={row.name} />
          )}
        </div>
        <span className="mr-pt-preset-note" data-testid={`preset-note-${row.outputId}`} data-custom={isCustom ? 'true' : undefined}>
          {rowNoteLine(draft)}
        </span>
      </div>

      <div className="mr-pt-cell mr-pt-price" role="cell">
        <span className="mr-pt-cell-label" aria-hidden="true">
          {t('settings.prices.colPrice')}
        </span>
        <TextField
          aria-label={`${t('settings.prices.colPrice')}, ${row.name}`}
          leadingSlot={<span className="mr-pt-affix">$</span>}
          inputMode="decimal"
          autoComplete="off"
          placeholder={suggestion}
          value={draft.price}
          disabled={disabled}
          appearance={errors?.price ? 'danger' : 'default'}
          helperText={errors?.price ?? t('settings.prices.priceHelper')}
          onChange={(price) => onChange(row.key, editPrice(draft, price))}
          data-testid={`price-input-${row.outputId}`}
        />
      </div>

      <div className="mr-pt-cell mr-pt-cf" role="cell">
        <span className="mr-pt-cell-label" aria-hidden="true">
          {t('settings.prices.colCounterfactual')}
        </span>
        <SelectField
          aria-label={`${t('settings.prices.colCounterfactual')}, ${row.name}`}
          items={cfOptions}
          value={draft.counterfactual}
          disabled={disabled}
          onChange={(key: Key | null) => {
            if (key !== null) set({ counterfactual: String(key) });
          }}
        />
      </div>

      {line ? <RowReceiptLine line={line} outputId={row.outputId} /> : null}
      {historyOpen && row.history ? <PriceHistoryList changes={historyNewestFirst(row)} tz={tz} id={`${ids}-history`} /> : null}
    </div>
  );
});
