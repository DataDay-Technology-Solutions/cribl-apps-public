// src/components/Shell/sweepHistory.ts — the live pulse's memory (EPIC_AUDIT P2-W21): the sweeps this tab has
// SEEN land in the last 60 minutes, and when the next one is due.
//
// Nothing here is invented. A sweep enters the history when this tab sees `meta.lastSweepAt` move (its own
// sweep handing meta back, or a poll reading the runner's) with the calls and duration meta recorded; a
// sweep this tab ran that failed enters as a failure. A tab opened 12 minutes ago knows 12 minutes, and the
// caption says so. The next sweep is this tab's own timer when it meters, otherwise the last sweep plus the
// cadence the history shows (or the meter's documented one), and is then marked "expected".

import { useEffect, useSyncExternalStore } from 'react';
import { t, tn } from '../../copy/en.ts';
import { formatClock, formatDuration, formatInt, formatTimeOfDay } from '../../lib/format.ts';
import { SETTLE_MS } from '../../../core/sweep.ts';
import { UI_SWEEP_INTERVAL_MS } from '../../state/meterLoop.ts';
import type { AppState } from '../../state/store.ts';

/** How far back the pulse looks. */
export const HISTORY_WINDOW_MS = 60 * 60_000;
/** At most this many entries are kept (a 30 s cadence fills an hour with 120). */
export const HISTORY_MAX = 180;

export type SweepEntryKind = 'ok' | 'failed';

export interface SweepEntry {
  /** epoch ms the sweep finished (meta.lastSweepAt, or the failure's time) */
  at: number;
  kind: SweepEntryKind;
  calls?: number;
  durationMs?: number;
  /** 'runner' | 'tab' | 'backend' | 'other' — who ran it */
  by: 'runner' | 'this-tab' | 'other-tab' | 'backend' | 'unknown';
}

export interface SweepHistory {
  /** epoch ms this tab started watching (the caption's "since") */
  since: number;
  entries: SweepEntry[];
  /** successful sweeps recorded so far (never decreases; the dot's tick keys off it) */
  landed: number;
}

export function emptyHistory(now: number): SweepHistory {
  return { since: now, entries: [], landed: 0 };
}

/** Adds one entry (deduplicated by time and kind, kept in time order), dropping what fell out of the window. */
export function recordSweep(history: SweepHistory, entry: SweepEntry, now: number): SweepHistory {
  if (!Number.isFinite(entry.at)) return history;
  if (history.entries.some((e) => e.at === entry.at && e.kind === entry.kind)) return history;
  const floor = now - HISTORY_WINDOW_MS;
  const entries = [...history.entries.filter((e) => e.at >= floor), entry].sort((a, b) => a.at - b.at).slice(-HISTORY_MAX);
  return { ...history, entries, landed: history.landed + (entry.kind === 'ok' ? 1 : 0) };
}

/** The entries inside the window at `now`. */
export function windowEntries(history: SweepHistory, now: number): SweepEntry[] {
  const floor = now - HISTORY_WINDOW_MS;
  return history.entries.filter((e) => e.at >= floor && e.at <= now + 5_000);
}

function ownerKind(owner: string | undefined, mine: string | undefined): SweepEntry['by'] {
  if (!owner) return 'unknown';
  if (mine && owner === mine) return 'this-tab';
  if (owner.startsWith('runner:')) return 'runner';
  if (owner.startsWith('backend:')) return 'backend';
  if (owner.startsWith('ui:')) return 'other-tab';
  return 'unknown';
}

/** The entries a store state adds: its last sweep (from meta) and this tab's last failure. Live data only. */
export function entriesFrom(state: AppState): SweepEntry[] {
  if (state.source !== 'live') return [];
  const out: SweepEntry[] = [];
  const meta = state.meta;
  const at = meta?.lastSweepAt ? Date.parse(meta.lastSweepAt) : Number.NaN;
  if (meta && Number.isFinite(at)) {
    out.push({
      at,
      kind: 'ok',
      ...(meta.lastSweepCalls !== undefined ? { calls: meta.lastSweepCalls } : {}),
      ...(meta.lastSweepMs !== undefined ? { durationMs: meta.lastSweepMs } : {}),
      by: ownerKind(meta.lastSweepOwner, state.status.sweep.ownerId),
    });
  }
  const failure = state.status.sweep.lastFailure;
  if (failure) out.push({ at: failure.at, kind: 'failed', by: 'this-tab' });
  return out;
}

/** Every meter sweeps once a minute (a tab checks every 30 s and meters each minute once it has settled). */
export function documentedCadenceMs(by: SweepEntry['by'] | undefined): number {
  void by;
  return 60_000;
}

/** How often the tab's meter loop checks (src/state/meterLoop.ts UI_SWEEP_INTERVAL_MS). */
export const TAB_TICK_MS = UI_SWEEP_INTERVAL_MS;

/** The median gap between the successful sweeps in the history (at least three sweeps), else undefined. */
export function observedCadenceMs(entries: readonly SweepEntry[]): number | undefined {
  const ok = entries.filter((e) => e.kind === 'ok');
  if (ok.length < 3) return undefined;
  const gaps = ok.slice(1).map((e, i) => e.at - ok[i].at).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

export interface NextSweep {
  at: number;
  /** true when this is an estimate (someone else meters), false for this tab's own timer */
  expected: boolean;
}

/** When the next sweep lands: this tab's own timer, or the last sweep plus the cadence. Null off live data. */
export function nextSweep(state: AppState, history: SweepHistory, now: number): NextSweep | null {
  if (state.source !== 'live') return null;
  const sweep = state.status.sweep;
  const lastAt = state.meta?.lastSweepAt ? Date.parse(state.meta.lastSweepAt) : Number.NaN;
  if (sweep.metering && sweep.nextAt !== undefined && sweep.nextAt >= now - 1_000) {
    // This tab's timer ticks every 30 s but meters a minute once it has settled (core/sweep.ts SETTLE_MS): the
    // next sweep is the first tick at or after the minute after meteredThrough has settled.
    let at = sweep.nextAt;
    const through = state.meta?.meteredThrough ? Date.parse(state.meta.meteredThrough) : Number.NaN;
    if (Number.isFinite(through)) while (at < through + 60_000 + SETTLE_MS) at += TAB_TICK_MS;
    return { at, expected: false };
  }
  if (!Number.isFinite(lastAt)) return null;
  const entries = windowEntries(history, now);
  const last = [...entries].reverse().find((e) => e.kind === 'ok');
  const cadence = observedCadenceMs(entries) ?? documentedCadenceMs(last?.by ?? ownerKind(state.meta?.lastSweepOwner, sweep.ownerId));
  return { at: lastAt + cadence, expected: true };
}

// ─── In words ────────────────────────────────────────────────────────────────

/** "Next sweep in 0:42" / "expected in" / "due now" / "0:40 late"; null when nothing is metered. */
export function countdownLine(next: NextSweep | null, now: number): string | null {
  if (!next) return null;
  const secs = Math.ceil((next.at - now) / 1000);
  if (secs > 0) return t(next.expected ? 'pulse.nextExpected' : 'pulse.next', { countdown: formatClock(secs) });
  if (secs > -30) return t('pulse.due');
  return t('pulse.overdue', { countdown: formatClock(-secs) });
}

/** The strip's short form: "next 0:42", "next ≈ 0:42"; null when overdue or unknown. */
export function stripCountdown(next: NextSweep | null, now: number): string | null {
  if (!next) return null;
  const secs = Math.ceil((next.at - now) / 1000);
  if (secs <= 0) return null;
  return t(next.expected ? 'pulse.stripNextExpected' : 'pulse.stripNext', { countdown: formatClock(secs) });
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The caption under the strip: how many sweeps, since when (a tab open under an hour), median duration and calls. */
export function historyCaption(history: SweepHistory, now: number, timeZone?: string): string {
  const entries = windowEntries(history, now);
  const ok = entries.filter((e) => e.kind === 'ok');
  const failed = entries.length - ok.length;
  if (entries.length === 0) return t('pulse.none');
  const parts = [tn('pulse.seen', ok.length)];
  if (history.since > now - HISTORY_WINDOW_MS) parts.push(t('pulse.seenSince', { time: formatTimeOfDay(history.since, timeZone) }));
  const ms = median(ok.map((e) => e.durationMs).filter((v): v is number => v !== undefined));
  if (ms !== undefined) parts.push(t('pulse.median', { duration: formatDuration(ms) }));
  const calls = median(ok.map((e) => e.calls).filter((v): v is number => v !== undefined));
  if (calls !== undefined) parts.push(t('pulse.calls', { calls: formatInt(calls) }));
  if (failed > 0) parts.push(tn('pulse.failed', failed));
  return parts.join(' · ');
}

// ─── The tab's history (one per page) ────────────────────────────────────────

let history: SweepHistory = emptyHistory(Date.now());
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Feeds a state's entries into the tab's history (the shell calls it on every store change). */
export function observeSweeps(state: AppState, now = Date.now()): void {
  let next = history;
  for (const entry of entriesFrom(state)) next = recordSweep(next, entry, now);
  if (next !== history) {
    history = next;
    emit();
  }
}

/** Tests: start over. */
export function resetSweepHistory(now = Date.now()): void {
  history = emptyHistory(now);
  emit();
}

export function useSweepHistory(): SweepHistory {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => history,
    () => history,
  );
}

/** Subscribes the tab's history to the store for the shell's lifetime. */
export function useRecordSweeps(store: { getState(): AppState; subscribe(listener: () => void): () => void }): void {
  useEffect(() => {
    observeSweeps(store.getState());
    return store.subscribe(() => observeSweeps(store.getState()));
  }, [store]);
}
