// src/state/sweepSummary.ts — normalizes what a sweep (local runSweep or the backend endpoint) returns
// into the UI's SweepSummary, without trusting its shape.

import type { Meta, Snapshot } from '../../core/types.ts';
import type { SweepSummary } from './store.ts';

/** Maps whatever a sweep returns into the UI's SweepSummary without trusting its shape. */
export function toSummary(result: unknown, mode: 'ui' | 'manual', elapsedMs: number): SweepSummary {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const skipped = typeof r.skipped === 'string' ? r.skipped : undefined;
  const error = typeof r.error === 'string' ? r.error : undefined;
  const snapshot = r.snapshot && typeof r.snapshot === 'object' ? (r.snapshot as Snapshot) : undefined;
  const meta = r.meta && typeof r.meta === 'object' ? (r.meta as Meta) : undefined;
  return {
    ok: typeof r.ok === 'boolean' ? r.ok : error === undefined,
    mode,
    skipped,
    error,
    calls: num(r.calls),
    durationMs: num(r.durationMs) ?? num(r.ms) ?? elapsedMs,
    snapshot,
    meta,
  };
}
