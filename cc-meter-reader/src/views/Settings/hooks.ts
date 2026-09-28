// src/views/Settings/hooks.ts — hooks and helpers every Settings section shares: the settings-save action
// (hasHydrated gate, SPEC 13), the per-section draft, the current-settings reader, the inventory read, and
// the Settings frame's contexts (unsaved sections, the save failure each bar keeps; EPIC_AUDIT P1-G07).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { InventoryDoc, Settings } from '../../../core/types.ts';
import { t } from '../../copy/en.ts';
import { notify } from '../../components/common/notify.tsx';
import { useActions, useAppState, useServices, useStoreApi } from '../../state/react.tsx';
import type { AppDocs } from '../../state/ports.ts';
import { canWrite } from '../../state/selectors.ts';
import { classifyError, type ApiErrorInfo } from '../../state/store.ts';
import type { WriteResult } from '../../state/services.ts';
import type { SweepNowResult } from '../../state/meterLoop.ts';
import { formatDuration, formatInt } from '../../lib/format.ts';
import { draftsEqual, type FieldErrors } from './model.ts';
import { classifySweepError, sweepErrorText } from '../../components/Shell/status.ts';

// ─── Save actions ────────────────────────────────────────────────────────────

/** The save bar's line for a failed write, or null when the result is not a failure the bar should keep. */
export function saveFailureLine(result: WriteResult): string | null {
  if (result.ok || result.reason !== 'error') return null;
  return t('settings.saveFailedBar', { status: result.error?.status || '—' });
}

/** A write's outcome for the save bars: the failure line (null once a save went through), and the section that
 * asked for the write when it is known (null: the frame falls back to the bar whose Save was pressed last). */
type WriteOutcomeListener = (failure: string | null, section: string | null) => void;
const writeOutcomeListeners = new Set<WriteOutcomeListener>();

/**
 * Hears every save the member asked for, as `reportWrite` reports it. The Settings frame keeps a failure in
 * that section's save bar (EPIC_AUDIT P1-G07), so every section gets it without passing anything. Returns the
 * unsubscribe.
 */
export function onWriteOutcome(listener: WriteOutcomeListener): () => void {
  writeOutcomeListeners.add(listener);
  return () => {
    writeOutcomeListeners.delete(listener);
  };
}

/**
 * Toasts a write's outcome with the SPEC 17 copy and tells the Settings frame (the save bar keeps a failure
 * after the toast is gone). `bar: false` for writes the member did not press Save for (a test's `lastTest`);
 * `section`, the section whose bar asked (`useSaveSettings` passes its slot's). Returns whether it saved.
 */
export function reportWrite(result: WriteResult, opts: { bar?: boolean; section?: string | null } = {}): boolean {
  if (opts.bar !== false) {
    const line = saveFailureLine(result);
    for (const listener of writeOutcomeListeners) listener(line, opts.section ?? null);
  }
  if (result.ok) {
    notify.success(t('settings.saved'));
    return true;
  }
  if (result.reason === 'not-hydrated') notify.warning(t('settings.notHydrated'));
  else if (result.reason === 'not-live') notify.warning(t('settings.readOnlySample'));
  else notify.error(t('settings.saveFailed', { status: result.error?.status || '—' }));
  return false;
}

/**
 * `save(next)` → actions.saveSettings with the toast (and the save bar's failure line, kept by the section this
 * hook renders in, even when the member has opened another section before the write answers); `saving` while
 * it runs.
 */
export function useSaveSettings(): { save: (next: Settings) => Promise<boolean>; saving: boolean } {
  const { saveSettings } = useActions();
  const slot = useContext(SettingsSlotContext);
  const [saving, setSaving] = useState(false);
  const save = useCallback(
    async (next: Settings) => {
      setSaving(true);
      try {
        return reportWrite(await saveSettings(next), { section: slot });
      } finally {
        setSaving(false);
      }
    },
    [saveSettings, slot],
  );
  return { save, saving };
}

// ─── The Settings frame (EPIC_AUDIT P1-G07) ──────────────────────────────────

/** What a section's save bar tells the frame (./index.tsx), and asks of it. Stable for the frame's life. */
export interface SettingsFrameRegistry {
  /** Records whether a section (a SectionCard id) has unsaved changes. */
  setDirty: (section: string, dirty: boolean) => void;
  /** A Save press starts a new attempt: the section's kept failure goes, and the frame remembers which bar asked. */
  savePressed: (section: string) => void;
}

/** The frame's registry; absent when a section renders on its own (unit tests). */
export const SettingsFrameContext = createContext<SettingsFrameRegistry | null>(null);

/** The section a mounted Settings slot holds (./index.tsx); null outside the frame. */
export const SettingsSlotContext = createContext<string | null>(null);

/** The failed-save line each section's bar keeps until its next attempt, by section id. */
export const SettingsFailuresContext = createContext<Readonly<Record<string, string>>>({});

/**
 * While `dirty`, asks the browser to confirm leaving the page (EPIC_AUDIT P1-G07). Inside Cribl's sandboxed
 * iframe the browser may not show the prompt; nothing else depends on it.
 */
export function useBeforeUnloadGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older engines need returnValue set to show the prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}

/** Whether this tab may write (hydrated + live data), from the store. */
export function useWritable(): boolean {
  return useAppState(canWrite);
}

// ─── Section drafts ──────────────────────────────────────────────────────────

export interface SectionDraft<D> {
  draft: D;
  setDraft: (update: D | ((d: D) => D)) => void;
  /** Resets the draft to the stored value. */
  discard: () => void;
  dirty: boolean;
  /** The draft the stored settings produce right now. */
  stored: D;
}

/**
 * A draft of one section's fields. It follows the stored settings while untouched (another save, a
 * hydration that lands late) and keeps the member's edits once dirty.
 */
export function useSectionDraft<D>(pick: (s: Settings) => D, deps: readonly unknown[] = []): SectionDraft<D> {
  const settings = useAppState((s) => s.settings);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `pick` is re-created per render; deps list what it reads
  const stored = useMemo(() => pick(settings), [settings, ...deps]);
  const [draft, setDraftState] = useState<D>(stored);
  const baseline = useRef<D>(stored);

  useEffect(() => {
    // Untouched drafts follow the store; edited drafts are kept.
    setDraftState((current) => (draftsEqual(current, baseline.current) ? stored : current));
    baseline.current = stored;
  }, [stored]);

  const setDraft = useCallback((update: D | ((d: D) => D)) => {
    setDraftState((current) => (typeof update === 'function' ? (update as (d: D) => D)(current) : update));
  }, []);
  const discard = useCallback(() => setDraftState(baseline.current), []);
  return { draft, setDraft, discard, dirty: !draftsEqual(draft, stored), stored };
}

/** Counts errors and dirty keys for the save bar. */
export function errorCount(errors: FieldErrors): number {
  return Object.keys(errors).length;
}

/** The current settings at save time (never a stale render's copy). */
export function useCurrentSettings(): () => Settings {
  const store = useStoreApi();
  return useCallback(() => store.getState().settings, [store]);
}

// ─── Inventory (the destinations to price) ───────────────────────────────────

export interface InventoryState {
  inventory: InventoryDoc | null;
  /** 'loading' until the first read answers */
  phase: 'loading' | 'ready' | 'error';
  error?: ApiErrorInfo;
  /** Where `inventory` came from: the sweep's KV document, or straight from the Leader before any sweep. */
  from?: 'kv' | 'leader';
}

/** What one inventory read found: the sweep's KV document, or the Leader walk on a never-swept workspace. */
interface InventoryRead {
  inventory: InventoryDoc | null;
  from: 'kv' | 'leader';
}

/** One shared read per services instance and sweep (EPIC_AUDIT P1-G02). */
interface InventoryCacheEntry {
  /** The last sweep this read belongs to ('' before the first sweep). */
  key: string;
  promise: Promise<InventoryRead>;
  /** Set once the read answers, so a remount starts from it without a loading flash. */
  value?: InventoryRead;
}

/**
 * The inventory every Settings section shares (EPIC_AUDIT P1-G02). Before, each mount of Prices or Budgets read
 * it again: on a never-priced workspace that was a full Leader walk (groups, then four GETs per group) on first
 * paint and again after every hop between sections; on a priced one the KV document was re-read per hook
 * instance, per sweep and per hop. Now one read serves every section until the next sweep: keyed by the last
 * sweep's time, so the never-swept Leader walk is kept for the session and replaced by the KV document the
 * moment the first sweep writes it. A failed read is dropped, so the next mount tries again. Keyed by the
 * services' `docs` (a WeakMap), so tests with fresh services never share a read.
 */
const inventoryCache = new WeakMap<AppDocs, InventoryCacheEntry>();

function sharedInventoryRead(docs: AppDocs, key: string): InventoryCacheEntry {
  const hit = inventoryCache.get(docs);
  if (hit && hit.key === key) return hit;
  const load = async (): Promise<InventoryRead> => {
    const stored = await docs.readInventory();
    if (stored || !docs.readLeaderInventory) return { inventory: stored, from: 'kv' };
    return { inventory: await docs.readLeaderInventory(), from: 'leader' };
  };
  const entry: InventoryCacheEntry = { key, promise: load() };
  entry.promise.then(
    (value) => {
      entry.value = value;
    },
    () => {
      if (inventoryCache.get(docs) === entry) inventoryCache.delete(docs);
    },
  );
  inventoryCache.set(docs, entry);
  return entry;
}

/** The answered read for this sweep, if there is one (a remount starts from it). */
function settledInventory(docs: AppDocs, key: string): InventoryState | undefined {
  const hit = inventoryCache.get(docs);
  return hit && hit.key === key && hit.value ? { inventory: hit.value.inventory, phase: 'ready', from: hit.value.from } : undefined;
}

/**
 * Reads the `inventory` KV document the sweep maintains, and re-reads it after every sweep this tab
 * sees. A fresh install has none: the 'ui' runtime does not sweep until prices exist (REVIEW-3a #3), and
 * pricing needs the destination list first — so when KV holds no inventory, it is read straight from the
 * Leader (config GETs only, `AppDocs.readLeaderInventory`; nothing is written). The first sweep after
 * "Save changes" writes the KV document, which then takes over. Every section and every remount shares one
 * read per sweep (P1-G02).
 */
export function useInventory(): InventoryState {
  const { docs } = useServices();
  const lastSweepAt = useAppState((s) => s.meta?.lastSweepAt ?? s.snapshot?.sweepAt ?? null);
  const source = useAppState((s) => s.source);
  const key = lastSweepAt ?? '';
  const [state, setState] = useState<InventoryState>(() => (source === 'live' ? settledInventory(docs, key) : undefined) ?? { inventory: null, phase: 'loading' });

  useEffect(() => {
    if (source !== 'live') return;
    let cancelled = false;
    sharedInventoryRead(docs, key)
      .promise.then((read) => {
        if (!cancelled) setState({ inventory: read.inventory, phase: 'ready', from: read.from });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState((s) => ({ ...s, phase: s.inventory ? 'ready' : 'error', error: classifyError(error) }));
      });
    return () => {
      cancelled = true;
    };
  }, [docs, key, source]);

  return state;
}

/** Whether a destination list is still waiting on the first sweep rather than genuinely empty. */
export function isWaitingForInventory(inv: InventoryState, live: boolean, listed: number): boolean {
  return live && listed === 0 && (inv.phase === 'loading' || (inv.phase === 'ready' && inv.inventory === null));
}

// ─── Sweep now ───────────────────────────────────────────────────────────────

/** The SPEC 17 line for a Sweep now outcome. */
export function sweepResultLine(result: SweepNowResult | null): { text: string; tone: 'ok' | 'warn' | 'error' } | null {
  if (!result) return null;
  switch (result.status) {
    case 'throttled':
      return { text: t('sweep.throttled', { seconds: Math.ceil(result.retryInMs / 1000) }), tone: 'warn' };
    case 'busy':
      return { text: t('sweep.running'), tone: 'ok' };
    case 'blocked':
      return {
        text:
          result.reason === 'no-prices'
            ? t('settings.runtime.sweepNoPrices')
            : result.reason === 'not-live'
              ? t('settings.runtime.notLive')
              : t('settings.readOnlyLoading'),
        tone: 'warn',
      };
    case 'done': {
      const s = result.summary;
      if (s.skipped === 'locked') return { text: t('sweep.skippedLocked'), tone: 'ok' };
      // Never the raw code ("rate_limited", a JSON body): what it means, in words (P0-07).
      if (!s.ok) {
        const info = classifySweepError(s.error ?? s.skipped, s.status);
        return { text: sweepErrorText(info), tone: info.kind === 'rate-limited' ? 'warn' : 'error' };
      }
      return {
        text: t('sweep.done', { calls: formatInt(s.calls ?? 0), duration: formatDuration(s.durationMs ?? 0) }),
        tone: 'ok',
      };
    }
    default:
      return null;
  }
}
