// src/views/Settings/PricesSection.tsx — Prices (PRD 6, 8.4; SPEC 5, 6, 8; DESIGN_BRIEF 5.5).
//
// Every destination the sweep would count is listed automatically with its status; the member picks a
// preset (auto-suggested), types a $ / GB (their contract rate) and chooses the counterfactual. A stored
// committed rate is kept on save; 1.0 shows no field for it (P0-19).
// Save appends ONE price version effective now (core/pricing.appendPriceVersion) holding only the rows
// that changed, then writes it through the store (hasHydrated gate). Invalid input never writes.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@capra/core';
import { appendPriceVersion, emptyPrices } from '../../../core/pricing.ts';
import { t, tn } from '../../copy/en.ts';
import { EmptyBlock } from '../../components/common/EmptyBlock.tsx';
import { ErrorNotice } from '../../components/common/ErrorNotice.tsx';
import { LoadingBlock } from '../../components/common/Loading.tsx';
import { RelativeTime } from '../../components/common/RelativeTime.tsx';
import { notify } from '../../components/common/notify.tsx';
import {
  PendingList,
  PriceTable,
  ReceiptTotals,
  buildRows,
  collectChanges,
  counterfactualOptions,
  draftReceipt,
  pendingChanges,
  fillSuggested,
  initialDraft,
  isDirty,
  listDestinations,
  rowCounts,
  suggestableCount,
  type PriceDraft,
  type PriceRow,
} from '../../components/PriceTable/index.ts';
import { shallowEqual, useActions, useAppState } from '../../state/react.tsx';
import { SaveBar, SectionCard, WaitingForInventory } from './shared.tsx';
import { SettingsFrameContext, isWaitingForInventory, reportWrite, useInventory, useWritable } from './hooks.ts';
import { SweepNowButton } from './SweepNowButton.tsx';
import { criblMemberName } from '../../lib/env.ts';

/** Keeps edited drafts, resets untouched ones to what is stored, adds new rows. */
function reconcileDrafts(rows: readonly PriceRow[], previousRows: readonly PriceRow[], drafts: Record<string, PriceDraft>): Record<string, PriceDraft> {
  const before = new Map(previousRows.map((r) => [r.key, r]));
  const next: Record<string, PriceDraft> = {};
  for (const row of rows) {
    const current = drafts[row.key];
    const old = before.get(row.key);
    // An edit made against the old stored state survives; anything untouched follows the new state.
    next[row.key] = current && old && isDirty(old, current) ? current : initialDraft(row);
  }
  return next;
}

export function PricesSection() {
  const writable = useWritable();
  const { savePrices } = useActions();
  const view = useAppState(
    (s) => ({
      prices: s.prices,
      snapshot: s.snapshot,
      source: s.source,
      includeInternal: s.settings.includeInternal,
      labels: s.settings.humanize,
      tz: s.settings.displayTimezone,
      pricesError: s.errors.prices,
      settingsError: s.errors.settings,
      hydrated: s.hasHydrated,
      phase: s.status.hydrate.phase,
    }),
    shallowEqual,
  );
  const inv = useInventory();
  const live = view.source === 'live';

  // Rows are recomputed when the stored prices or the destination list change (not every second).
  const destinations = useMemo(
    () => listDestinations(live ? inv.inventory : null, view.snapshot, view.includeInternal),
    [live, inv.inventory, view.snapshot, view.includeInternal],
  );
  const destKey = destinations.map((d) => `${d.groupId}:${d.outputId}:${d.type}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- destKey stands for `destinations`
  const rows = useMemo(() => buildRows(destinations, view.prices, Date.now(), view.labels), [destKey, view.prices, view.labels]);

  const [drafts, setDrafts] = useState<Record<string, PriceDraft>>(() => Object.fromEntries(rows.map((r) => [r.key, initialDraft(r)])));
  const previousRows = useRef<readonly PriceRow[]>(rows);
  useEffect(() => {
    setDrafts((d) => reconcileDrafts(rows, previousRows.current, d));
    previousRows.current = rows;
  }, [rows]);

  const changes = useMemo(() => collectChanges(rows, drafts), [rows, drafts]);
  const dirtySet = useMemo(() => new Set(changes.dirty), [changes.dirty]);
  const errorCount = Object.values(changes.errors).reduce((n, e) => n + (e.price ? 1 : 0) + (e.committed ? 1 : 0), 0);
  const counts = rowCounts(rows);
  const suggestable = suggestableCount(rows, drafts);
  const [saving, setSaving] = useState(false);

  const onChange = useCallback((key: string, draft: PriceDraft) => setDrafts((d) => ({ ...d, [key]: draft })), []);
  const discard = () => setDrafts(Object.fromEntries(rows.map((r) => [r.key, initialDraft(r)])));

  const fillSuggestedPrices = () => {
    const { drafts: next, filled } = fillSuggested(rows, drafts);
    setDrafts(next);
    if (filled.length > 0) notify.info(tn('settings.prices.suggestedFilled', filled.length));
  };

  const loadDemoPrices = async () => {
    // Demo build only: the branch (and the demo module) is dropped from the release bundle.
    if (import.meta.env.VITE_MR_BUILD === 'demo') {
      const { demoPriceDrafts } = await import('./demoPrices.ts');
      setDrafts((d) => demoPriceDrafts(rows, d));
      notify.info(t('settings.demoPanel.pricesLoaded'));
    }
  };

  // P2-W09: a workspace that has never saved a price starts its meter with this save.
  const neverPriced = (view.prices?.versions?.length ?? 0) === 0;
  const navigate = useNavigate();
  const registry = useContext(SettingsFrameContext);

  const save = async () => {
    if (!writable || changes.dirty.length === 0 || saving) return;
    if (errorCount > 0) {
      // Invalid input never writes (SPEC 5); move focus to the first field with an error.
      document.querySelector<HTMLElement>('.mr-pt [aria-invalid="true"]')?.focus();
      return;
    }
    const entries = changes.entries;
    if (Object.keys(entries).length === 0) return;
    setSaving(true);
    try {
      // P2-W24: the version names who saved it (the platform's own identity; never longer than 2 s to ask).
      const changedBy = await criblMemberName();
      const nowMs = Date.now();
      const doc = appendPriceVersion(view.prices ?? emptyPrices(new Date(nowMs).toISOString()), entries, nowMs, changedBy);
      const result = await savePrices(doc);
      if (neverPriced && result.ok) {
        // The first save starts the meter (the first sweep runs right after it): say so, and link to the Receipt.
        notify.success(t('settings.prices.meterStarted'), { action: { label: t('settings.prices.seeReceipt'), onClick: () => navigate('/') } });
      } else reportWrite(result);
    } finally {
      setSaving(false);
    }
  };

  // Cmd/Ctrl+S saves while this section has changes (P2-W09); the latest `save` is read through a ref.
  const saveRef = useRef(save);
  saveRef.current = save;
  const hasChanges = changes.dirty.length > 0;
  useEffect(() => {
    if (!hasChanges) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 's') return;
      // Only while Prices is the section on screen: the frame keeps a dirty section mounted (hidden) when the
      // member opens another, and ⌘S there belongs to that section, not to Prices.
      const card = document.querySelector<HTMLElement>('section[data-section="prices"]');
      if (!card || card.offsetParent === null) return;
      e.preventDefault();
      registry?.savePressed('prices');
      void saveRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasChanges, registry]);
  const shortcut = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? '⌘S' : 'Ctrl+S';

  // P2-W09: the live receipt (the last sweep's traffic at the prices on screen) and what Save will write.
  const receipt = useMemo(() => draftReceipt(rows, drafts, view.prices, view.snapshot, Date.now()), [rows, drafts, view.prices, view.snapshot]);
  const pending = useMemo(
    () => pendingChanges(rows, drafts, dirtySet, (row, key) => counterfactualOptions(row, rows).find((o) => o.id === key)?.label ?? key),
    [rows, drafts, dirtySet],
  );
  const startCount = Object.keys(changes.entries).length;

  const lastChangedAt = view.prices?.updatedAt;
  const lastChangedBy = view.prices?.versions?.at(-1)?.changedBy;
  const aside = rows.length > 0 ? (
    <div className="mr-set-counts" data-testid="prices-counts">
      <span className="mr-num">{tn('settings.prices.count', counts.total)}</span>
      <span aria-hidden="true" className="mr-set-dot">
        ·
      </span>
      {counts.unpriced > 0 ? (
        <span className="mr-set-count-warn mr-num">{tn('settings.prices.unpricedCount', counts.unpriced)}</span>
      ) : (
        <span className="mr-set-count-ok">{t('settings.prices.allPriced')}</span>
      )}
    </div>
  ) : null;

  const waiting = isWaitingForInventory(inv, live, rows.length);
  const showDemoButton = import.meta.env.VITE_MR_BUILD === 'demo';

  // Settings' own notice already names a failure that took the prices with it (one KV outage): the section shows its
  // ghost, not a second identical alert (P1-H03).
  const pageNoticeShows = live && view.settingsError !== undefined && view.settingsError.kind !== 'not-found';

  let body;
  let showTable = false;
  if (view.pricesError && view.pricesError.kind !== 'not-found' && pageNoticeShows) {
    body = <LoadingBlock loading rows={4} />;
  } else if (view.pricesError && view.pricesError.kind !== 'not-found') {
    body = <ErrorNotice error={view.pricesError} section={t('settings.prices.pricesSection')} />;
  } else if (inv.phase === 'error' && rows.length === 0 && inv.error) {
    body = <ErrorNotice error={inv.error} section={t('settings.prices.inventorySection')} />;
  } else if (!view.hydrated && view.phase !== 'error') {
    body = <LoadingBlock loading rows={4} />;
  } else if (waiting) {
    body = <WaitingForInventory action={<SweepNowButton variant="secondary" />} />;
  } else if (rows.length === 0) {
    body = (
      <EmptyBlock title={t('settings.prices.emptyTitle')} description={t('settings.prices.emptyBody')} illustration="EmptySuitcase">
        <SweepNowButton variant="secondary" />
      </EmptyBlock>
    );
  } else {
    showTable = true;
    body = (
      <>
        {(suggestable > 0 || showDemoButton) && (
          <div className="mr-set-toolbar">
            <p className="mr-set-muted">{t('settings.helperPresets')}</p>
            <div className="mr-set-toolbar-actions">
              {showDemoButton ? (
                // Secondary, not tertiary: Capra's tertiary text measures 4.48:1 on this toolbar at 390 px (light).
                <Button variant="secondary" disabled={!writable} onPress={() => void loadDemoPrices()}>
                  {t('settings.demoPanel.loadPrices')}
                </Button>
              ) : null}
              {suggestable > 0 ? (
                <Button variant="secondary" disabled={!writable} onPress={fillSuggestedPrices}>
                  {`${t('settings.prices.useSuggested')} (${suggestable})`}
                </Button>
              ) : null}
            </div>
          </div>
        )}
        <PriceTable rows={rows} drafts={drafts} errors={changes.errors} dirty={dirtySet} onChange={onChange} disabled={!writable} receipt={receipt?.rows} tz={view.tz} />
        {receipt && receipt.total.destinations > 0 ? <ReceiptTotals receipt={receipt} /> : null}
        <p className="mr-set-footnote">{t('settings.prices.versionNote')}</p>
      </>
    );
  }

  return (
    <SectionCard
      id="prices"
      title={t('settings.groups.prices')}
      description={t('settings.helperPrices')}
      aside={aside}
      footer={
        showTable ? (
          <>
            {hasChanges && errorCount === 0 ? <PendingList changes={pending} shortcut={writable ? shortcut : undefined} /> : null}
            <SaveBar
              dirty={changes.dirty.length}
              errors={errorCount}
              saving={saving}
              writable={writable}
              onSave={() => void save()}
              onDiscard={discard}
              saveLabel={neverPriced ? t('settings.prices.startMeter') : undefined}
              dirtyNote={
                neverPriced && startCount > 0 ? (
                  <>
                    <span>{tn('settings.unsaved', changes.dirty.length)}</span>
                    <span aria-hidden="true">{' · '}</span>
                    <span className="mr-pt-start-note">{t('settings.prices.startNote')}</span>
                  </>
                ) : undefined
              }
              note={
                lastChangedAt ? (
                  <span data-testid="prices-last-changed">
                    <RelativeTime
                      at={lastChangedAt}
                      render={(ago) => (lastChangedBy ? t('settings.prices.lastChangedBy', { user: lastChangedBy, ago }) : t('settings.prices.lastChanged', { ago }))}
                    />
                  </span>
                ) : (
                  t('settings.prices.neverChanged')
                )
              }
            />
          </>
        ) : undefined
      }
    >
      {body}
    </SectionCard>
  );
}
