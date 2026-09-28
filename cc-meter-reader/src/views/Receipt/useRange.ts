// src/views/Receipt/useRange.ts — the Receipt's custom range as React state: reads through the action surface
// (never from the view), re-reads when the range changes and when a new sweep lands (the current bucket is
// live: core/sweep.ts writes the current hour's minute document every sweep and folds an hour into the day's
// hour document once it ends), keeps the last figures on screen while the next read is in flight, and never
// lets a stale request land (StrictMode mounts effects twice).
//
// The API budget (api-budget F2): every read runs under an AbortSignal that the next one aborts, so a range
// replaced mid-read starts no further GETs; a new range right after another one waits out the rest of
// SPEC_SETTLE_MS (the last one wins) instead of stacking plans, while the first range, a refresh and a retry
// start at once; the read itself starts on a timer, so StrictMode's discarded first mount reads nothing. A 429
// (rangeReader.ts) keeps the last figures of the same range on screen and retries by itself at the time the
// reader gives — never a Retry that re-fires the plan into the limit.
//
// Loading is DERIVED, not set: a request is identified by (spec, refresh key, attempt), and the hook is
// loading whenever the settled outcome is for a different request. The outcome carries the last successful
// read of the same spec, so a refresh keeps the old figures on screen instead of a skeleton.
//
// Compare with… (P2-W13): with a comparison requested, the two windows are planned against the clock at read
// time (core/range.ts planComparison) and read one after the other through the same action and signal — the
// current window first (the aligned one, not the URL's), the baseline only once it landed, so the second read
// shares the reader's immutable-document cache and a 429 on the first starts no second GET. A refused
// comparison reads the range alone and reports why. A 429 on the baseline keeps the last comparison of the same
// request on screen and retries by itself, like the range. The request key is the range AND the comparison, so a
// comparison switched on never shows the plain range's figures as its own.

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatRangeParam, type ComparisonPlan, type ComparisonRefusal, type RangeSpec } from '../../../core/range.ts';
import { useActions } from '../../state/react.tsx';
import type { RangeReadOk, RangeReadResult } from '../../state/rangeReader.ts';
import type { ApiErrorInfo } from '../../state/store.ts';

/** A different range this soon after the last one started waits out the rest (the last one wins). */
export const SPEC_SETTLE_MS = 300;

type FailureReason = Exclude<RangeReadResult, { ok: true }>['reason'];

export type RangeState =
  | { status: 'idle' }
  | { status: 'loading'; spec: RangeSpec; previous?: RangeReadOk }
  /** `retryAtMs`: a refresh was refused by a 429 — these are the last figures, and the read is retried then. */
  | { status: 'ready'; result: RangeReadOk; retryAtMs?: number }
  | { status: 'error'; spec: RangeSpec; reason: FailureReason; error?: ApiErrorInfo; retryAtMs?: number };

/** A comparison to read alongside the range (P2-W13). */
export interface CompareRequest {
  /** Identifies the comparison ('prev', 'week', '<hash>@<deploy ms>'): a different key is a different request. */
  key: string;
  /** Plans both windows against the clock at read time (core/range.ts planComparison). */
  plan: (nowMs: number) => ComparisonPlan | ComparisonRefusal;
}

/** What the comparison shows: while the range reads, its windows' figures, why it can't be made, or its failure. */
export type CompareView =
  | { status: 'loading' }
  /** `retryAtMs`: a refresh of the baseline was refused by a 429 — this is the last comparison, retried then. */
  | { status: 'ready'; plan: ComparisonPlan; baseline: RangeReadOk; retryAtMs?: number }
  | { status: 'refused'; refusal: ComparisonRefusal }
  | { status: 'error'; plan: ComparisonPlan; reason: FailureReason; error?: ApiErrorInfo; retryAtMs?: number };

export interface UseRange {
  state: RangeState;
  /** The figures to show: the latest successful read for this spec, kept while a refresh is in flight or held off. */
  result: RangeReadOk | undefined;
  /** The comparison, when one was requested (undefined otherwise). */
  compare?: CompareView;
  retry: () => void;
}

type CompareOutcome = { plan: ComparisonPlan; baseline: RangeReadResult } | { refusal: ComparisonRefusal };
type CompareOk = { plan: ComparisonPlan; baseline: RangeReadOk } | { refusal: ComparisonRefusal };

interface Outcome {
  specKey: string;
  refreshKey: string | undefined;
  attempt: number;
  result: RangeReadResult;
  /** The comparison read with it (absent when none was requested, or the range's own read failed). */
  compare?: CompareOutcome;
  /** The newest successful read of `specKey` (this one, or an earlier one). */
  lastOk?: RangeReadOk;
  /** The newest comparison of `specKey` that read (or was refused) cleanly. */
  lastCompare?: CompareOk;
}

const retryAtOf = (result: RangeReadResult): number | undefined => (!result.ok && result.reason === 'rate-limited' ? result.retryAtMs : undefined);

/** The comparison as it settled, if it settled cleanly (a refusal is clean: nothing more will change it). */
function cleanCompare(c: CompareOutcome | undefined): CompareOk | undefined {
  if (!c) return undefined;
  if ('refusal' in c) return c;
  return c.baseline.ok ? { plan: c.plan, baseline: c.baseline } : undefined;
}

function compareView(c: CompareOk): CompareView {
  return 'refusal' in c ? { status: 'refused', refusal: c.refusal } : { status: 'ready', plan: c.plan, baseline: c.baseline };
}

/**
 * Reads `spec` while `enabled`; `refreshKey` (the snapshot's sweepAt) re-reads the same spec when new rows
 * may exist. Disabled or absent → idle. `compare` reads a second window to compare the range with.
 */
export function useRange(spec: RangeSpec | undefined, enabled: boolean, refreshKey: string | undefined, compare?: CompareRequest): UseRange {
  const { readRange } = useActions();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** The range and instant the last read STARTED (not merely was scheduled). */
  const lastStartRef = useRef<{ key: string; at: number } | null>(null);
  const specKey = spec ? `${formatRangeParam(spec)}${compare ? `|${compare.key}` : ''}` : undefined;
  // The effect keys on the spec's URL form, not its identity: a re-created but equal spec is the same range.
  const specRef = useRef(spec);
  const compareRef = useRef(compare);
  const active = spec !== undefined && enabled;

  // The latest spec for the read below; effects run in order, so this one lands first in every commit.
  useEffect(() => {
    specRef.current = spec;
    compareRef.current = compare;
  });

  useEffect(() => {
    const current = specRef.current;
    if (!active || !current || specKey === undefined) return;
    const controller = new AbortController();
    const last = lastStartRef.current;
    const delay = last && last.key !== specKey ? Math.max(0, SPEC_SETTLE_MS - (Date.now() - last.at)) : 0;
    const read = async (): Promise<{ result: RangeReadResult; compare?: CompareOutcome }> => {
      const cmp = compareRef.current?.plan(Date.now());
      if (!cmp || !cmp.ok) {
        const result = await readRange(current, controller.signal);
        return { result, ...(cmp ? { compare: { refusal: cmp } } : {}) };
      }
      // One after the other: the baseline only once the current window landed (a 429 there starts no second GET).
      const result = await readRange({ kind: 'absolute', ...cmp.current }, controller.signal);
      if (!result.ok) return { result };
      const baseline = await readRange({ kind: 'absolute', ...cmp.baseline }, controller.signal);
      return { result, compare: { plan: cmp, baseline } };
    };
    const timer = setTimeout(() => {
      lastStartRef.current = { key: specKey, at: Date.now() };
      void read().then(({ result, compare: cmp }) => {
        const aborted = (r: RangeReadResult) => !r.ok && r.reason === 'aborted';
        if (controller.signal.aborted || aborted(result) || (cmp && 'baseline' in cmp && aborted(cmp.baseline))) return;
        setOutcome((prev) => {
          const same = prev && prev.specKey === specKey ? prev : null;
          const clean = result.ok ? cleanCompare(cmp) : undefined;
          return {
            specKey,
            refreshKey,
            attempt,
            result,
            ...(cmp ? { compare: cmp } : {}),
            lastOk: result.ok ? result : same?.lastOk,
            lastCompare: clean ?? same?.lastCompare,
          };
        });
      });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, specKey, refreshKey, attempt, readRange]);

  // A 429 on either window: try again when the reader says the limit has passed (one timer, for the range on screen).
  const baselineRead = outcome?.compare && 'baseline' in outcome.compare ? outcome.compare.baseline : undefined;
  const retryAtMs = outcome && outcome.specKey === specKey ? (retryAtOf(outcome.result) ?? (baselineRead ? retryAtOf(baselineRead) : undefined)) : undefined;
  useEffect(() => {
    if (!active || retryAtMs === undefined) return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), Math.max(0, retryAtMs - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [active, retryAtMs]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (!active || !spec || specKey === undefined) return { state: { status: 'idle' }, result: undefined, retry };

  const sameSpec = outcome !== null && outcome.specKey === specKey ? outcome : null;
  const settled = sameSpec && sameSpec.refreshKey === refreshKey && sameSpec.attempt === attempt ? sameSpec : null;
  const previous = sameSpec?.lastOk;
  const previousCompare = sameSpec?.lastCompare;
  // While anything reads, the last clean comparison of this request stays (like the range's figures).
  const heldCompare: CompareView | undefined = compare ? (previousCompare && previous ? compareView(previousCompare) : { status: 'loading' }) : undefined;

  if (!settled) return { state: { status: 'loading', spec, ...(previous ? { previous } : {}) }, result: previous, ...(heldCompare ? { compare: heldCompare } : {}), retry };
  const result = settled.result;
  if (result.ok) {
    let view: CompareView | undefined;
    const c = settled.compare;
    if (c && 'refusal' in c) view = { status: 'refused', refusal: c.refusal };
    else if (c && c.baseline.ok) view = { status: 'ready', plan: c.plan, baseline: c.baseline };
    else if (c && !c.baseline.ok) {
      const failed = c.baseline;
      const held = retryAtOf(failed);
      // A 429 on the baseline with a comparison of this request on screen: it stays, and is retried at retryAtMs.
      if (held !== undefined && previousCompare && 'baseline' in previousCompare) view = { status: 'ready', plan: previousCompare.plan, baseline: previousCompare.baseline, retryAtMs: held };
      else view = { status: 'error', plan: c.plan, reason: failed.reason, ...('error' in failed && failed.error ? { error: failed.error } : {}), ...(held !== undefined ? { retryAtMs: held } : {}) };
    } else if (compare) view = { status: 'loading' };
    return { state: { status: 'ready', result }, result, ...(view ? { compare: view } : {}), retry };
  }
  const heldOff = retryAtOf(result);
  // Rate limited with figures of this range already on screen: they stay, and the read is retried at retryAtMs.
  if (heldOff !== undefined && previous) return { state: { status: 'ready', result: previous, retryAtMs: heldOff }, result: previous, ...(heldCompare ? { compare: heldCompare } : {}), retry };
  return {
    state: {
      status: 'error',
      spec,
      reason: result.reason,
      ...('error' in result && result.error ? { error: result.error } : {}),
      ...(heldOff !== undefined ? { retryAtMs: heldOff } : {}),
    },
    result: undefined,
    retry,
  };
}
