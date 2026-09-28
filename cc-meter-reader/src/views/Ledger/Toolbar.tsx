// src/views/Ledger/Toolbar.tsx — search ('/' focuses it: the shell looks for [data-mr-search]) and the three
// filters (status, destination, worker group). Values come from and go to the URL (params.ts); nothing here
// writes KV. A value the latest sweep does not know never becomes an option (P1-K05): the view does not apply it
// and says so in a notice.

import { Button, IconButton, SelectField, TextField, type Key } from '@capra/core';
import { CloseOutlined, SearchOutlined } from '@capra/icons';
import { t } from '../../copy/en.ts';
import type { Option, RowStatus } from '../../components/LedgerTable/model.ts';
import { ROW_STATUSES } from '../../components/LedgerTable/model.ts';
import { STATUS_COPY } from '../../components/LedgerTable/status.ts';

const ALL = '__all__';

export interface ToolbarProps {
  query: string;
  onQueryChange: (q: string) => void;
  state?: RowStatus;
  onStateChange: (s: RowStatus | null) => void;
  statusCounts: Record<RowStatus, number>;
  dest?: string;
  onDestChange: (d: string | null) => void;
  destinations: Option[];
  group?: string;
  onGroupChange: (g: string | null) => void;
  groups: Option[];
  /** show the toolbar's "Clear filters": filters are on and no other control on screen offers the recovery (P1-K05) */
  filtered: boolean;
  onClear: () => void;
  /** "17 flows" / "3 of 17 flows" */
  countText: string;
}

function withCount(label: string, n: number): string {
  return t('ledger.filters.optionCount', { label, n });
}

export function Toolbar(props: ToolbarProps) {
  const { query, onQueryChange, state, onStateChange, statusCounts, dest, onDestChange, destinations, group, onGroupChange, groups } =
    props;

  const statusItems = [
    { id: ALL, label: t('ledger.filters.stateAll') },
    ...ROW_STATUSES.filter((s) => statusCounts[s] > 0 || s === state).map((s) => ({
      id: s,
      label: withCount(STATUS_COPY[s], statusCounts[s]),
    })),
  ];
  const destItems = [
    { id: ALL, label: t('ledger.filters.destinationAll') },
    ...destinations.map((o) => ({
      id: o.id,
      label: withCount(o.label, o.count),
    })),
  ];
  const groupItems = [
    { id: ALL, label: t('ledger.filters.groupAll') },
    ...groups.map((o) => ({ id: o.id, label: withCount(o.label, o.count) })),
  ];

  const pick = (k: Key | null): string | null => (k === null || k === ALL ? null : String(k));

  return (
    <div className="mr-ledger-toolbar" role="search" aria-label={t('ledger.filters.searchLabel')}>
      <div className="mr-ledger-search" data-mr-search>
        <TextField
          aria-label={t('ledger.filters.searchLabel')}
          placeholder={t('ledger.searchPlaceholder')}
          value={query}
          onChange={onQueryChange}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault();
              onQueryChange('');
            }
          }}
          leadingSlot={<SearchOutlined size="sm" />}
          trailingSlot={
            query ? (
              <IconButton
                icon={CloseOutlined}
                aria-label={t('ledger.filters.clearSearch')}
                size="xs"
                variant="tertiary"
                onPress={() => onQueryChange('')}
              />
            ) : (
              <kbd className="mr-ledger-kbd" title={t('ledger.filters.searchHint')}>
                /
              </kbd>
            )
          }
        />
      </div>
      <div className="mr-ledger-filters">
        <div className="mr-ledger-filter" data-filter="state">
          <SelectField
            aria-label={t('ledger.filters.state')}
            items={statusItems}
            value={state ?? ALL}
            onChange={(k) => onStateChange(pick(k) as RowStatus | null)}
          />
        </div>
        <div className="mr-ledger-filter" data-filter="dest">
          <SelectField
            aria-label={t('ledger.filters.destination')}
            items={destItems}
            value={dest ?? ALL}
            onChange={(k) => onDestChange(pick(k))}
          />
        </div>
        <div className="mr-ledger-filter" data-filter="group">
          <SelectField
            aria-label={t('ledger.filters.group')}
            items={groupItems}
            value={group ?? ALL}
            onChange={(k) => onGroupChange(pick(k))}
          />
        </div>
      </div>
      <div className="mr-ledger-toolbar-end" data-filtered={props.filtered ? 'true' : 'false'}>
        <span className="mr-ledger-count mr-num" aria-live="polite">
          {props.countText}
        </span>
        {props.filtered ? (
          <Button variant="tertiary" size="sm" onPress={props.onClear}>
            {t('ledger.filters.clear')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
