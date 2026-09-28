// src/views/Presenter/session.ts — "Saved since you started watching" (P2-W01), pure.
//
// The stage's hero is an annualized RATE: between sweeps it does not move. The session line under it is a running
// total the room can watch grow: from $0.00 the moment presenter mode opens, accruing at the snapshot's measured
// ratePerSecM (the same rate the Receipt's month-to-date ticks at between sweeps), re-anchored on every snapshot so
// a new rate takes over from exactly where the line is. It accrues only while the data is live: stale, offline or
// rate-limited data freezes it (a frozen line never invents money), and the extrapolation past a snapshot is capped
// at the live window (a sweep that stalls stops the line when the status stops saying Live).
//
// Money in integer millicents at the anchors (the Meter extrapolates between them); the rate caption picks the
// unit that shows at least a cent: "~$0.26 a second", "~$0.19 a minute", "~$11.40 an hour".

import { MC_PER_CENT, fmtDollarsCents } from '../../../core/format.ts';
import { t } from '../../copy/en.ts';

/** The live window: past this the data is stale (src/state/selectors.ts STALE_AFTER_MS), so the line stops too. */
export const SESSION_MAX_EXTRAPOLATION_SEC = 5 * 60;

/** One stretch of the session at one rate: the total at `fromMs`, and the rate since (0 = frozen). */
export interface SessionSegment {
  /** what re-anchors the line: the effective rate and the snapshot it came from */
  key: string;
  baseM: number;
  fromMs: number;
  ratePerSecM: number;
}

export function startSession(nowMs: number, ratePerSecM: number, key: string): SessionSegment {
  return { key, baseM: 0, fromMs: nowMs, ratePerSecM: sessionRate(ratePerSecM) };
}

/** A usable accrual rate: finite and positive, else 0 (frozen). */
export function sessionRate(ratePerSecM: number | null | undefined): number {
  return typeof ratePerSecM === 'number' && Number.isFinite(ratePerSecM) && ratePerSecM > 0 ? ratePerSecM : 0;
}

/** The session total at `nowMs` within a segment (capped at the live window past its anchor). */
export function sessionValueAt(seg: SessionSegment, nowMs: number): number {
  const elapsed = Math.min(SESSION_MAX_EXTRAPOLATION_SEC, Math.max(0, (nowMs - seg.fromMs) / 1000));
  return seg.baseM + seg.ratePerSecM * elapsed;
}

/** The next segment: the total so far carries over, the new rate (0 when not live) takes over from now. */
export function nextSegment(seg: SessionSegment, nowMs: number, ratePerSecM: number, key: string): SessionSegment {
  return { key, baseM: sessionValueAt(seg, nowMs), fromMs: Math.max(seg.fromMs, nowMs), ratePerSecM: sessionRate(ratePerSecM) };
}

/** "~$0.04 a second", or a minute or an hour when a second is under a cent; null when nothing accrues. */
export function sessionRateText(ratePerSecM: number): string | null {
  const rate = sessionRate(ratePerSecM);
  if (rate <= 0) return null;
  if (rate >= MC_PER_CENT) return t('presenter.session.perSecond', { amount: fmtDollarsCents(rate) });
  if (rate * 60 >= MC_PER_CENT) return t('presenter.session.perMinute', { amount: fmtDollarsCents(rate * 60) });
  return t('presenter.session.perHour', { amount: fmtDollarsCents(rate * 3600) });
}
