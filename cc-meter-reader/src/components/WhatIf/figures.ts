// src/components/WhatIf/figures.ts — the What-if figures as text PIECES (P1-J01).
//
// A figure is one or more pieces of text; a line may break only BETWEEN pieces. A point estimate is one
// piece ("$66"); a range is two, split right after its dash ("$68–" / "$140"), so a narrow cell wraps a
// range at the dash and never inside "24.0 GB" or "$24,765". Every piece is set in tabular figures
// (`.mr-num`, which never wraps inside itself).
//
// Rules (the strip, DESIGN_BRIEF 5.9):
//   • money ranges whose larger end reaches $10,000 are compact, both ends to the tenth ("$24.8k–$51.0k");
//     points stay exact;
//   • a byte range names its unit once when both ends share it ("24.0–52.9 GB");
//   • a signed range carries one sign when both ends share it ("+$68–$140"), each its own otherwise.
// Money is integer millicents in, formatted only through src/lib/format.ts (core/format.ts underneath).

import { t, tn } from '../../copy/en.ts';
import { formatBytes, formatMoney, formatPct } from '../../lib/format.ts';
import type { EstimateOk, Projection } from '../../../core/whatif.ts';

export interface Figure {
  /** The text in pieces; a line breaks only between them. */
  parts: string[];
  /** The whole figure as one string (what a screen reader and a test read). */
  text: string;
}

/** $10,000 in millicents: from here a money RANGE is compact. */
export const COMPACT_RANGE_FROM_M = 1_000_000_000;

const MINUS = '−';

const one = (text: string): Figure => ({ parts: [text], text });

/** "low–high" (the copy's range template) as two pieces split after the dash; one piece when they print alike. */
export function joinRange(low: string, high: string): Figure {
  if (low === high) return one(low);
  const text = t('whatif.range', { low, high });
  const at = text.lastIndexOf(high);
  return at > 0 ? { parts: [text.slice(0, at), text.slice(at)], text } : one(text);
}

/** A projection's value at the estimate's low and high end, ordered by value (equal for a point estimate). */
export function spanOf(e: EstimateOk, get: (p: Projection) => number): [number, number] {
  if (!e.range) {
    const v = get(e.mid);
    return [v, v];
  }
  const a = get(e.low);
  const b = get(e.high);
  return a <= b ? [a, b] : [b, a];
}

/** Compact ends print with the same precision: "$24.8k–$51k" reads "$24.8k–$51.0k". */
function alignCompact(a: string, b: string): [string, string] {
  const tenths = /\.\d[kMB]$/;
  const whole = /^([^.]*\d)([kMB])$/;
  if (tenths.test(a) && whole.test(b)) return [a, b.replace(whole, '$1.0$2')];
  if (tenths.test(b) && whole.test(a)) return [a.replace(whole, '$1.0$2'), b];
  return [a, b];
}

function compactPair(lo: number, hi: number, signed: boolean): [string, string] {
  const compact = Math.max(Math.abs(lo), Math.abs(hi)) >= COMPACT_RANGE_FROM_M;
  const a = formatMoney(lo, { compact, signed });
  const b = formatMoney(hi, { compact, signed });
  return compact ? alignCompact(a, b) : [a, b];
}

/** "$66", "$68–$140", "$24.8k–$51.0k" (a range reaching $10,000 is compact). */
export function moneyFigure(lo: number, hi: number): Figure {
  if (lo === hi) return one(formatMoney(lo));
  return joinRange(...compactPair(lo, hi, false));
}

/** "+$66", "+$68–$140", "−$5–$12", "−$3–+$9": one sign when both ends share it. */
export function signedMoneyFigure(lo: number, hi: number): Figure {
  if (lo === hi) return one(formatMoney(lo, { signed: true }));
  if (lo > 0 || hi < 0) {
    const sign = lo > 0 ? '+' : MINUS;
    const [a, b] = lo > 0 ? [lo, hi] : [-hi, -lo];
    return prefixed(sign, joinRange(...compactPair(a, b, false)));
  }
  return joinRange(...compactPair(lo, hi, true));
}

/** "34%", "34%–70%". */
export function pctFigure(lo: number, hi: number): Figure {
  return joinRange(formatPct(lo), formatPct(hi));
}

/** Drops the low end's unit when both ends share it: "24.0 GB" + "52.9 GB" → "24.0" + "52.9 GB". */
function shareUnit(low: string, high: string): [string, string] {
  const unit = /\s\S+$/.exec(low)?.[0];
  return unit !== undefined && high.endsWith(unit) ? [low.slice(0, -unit.length), high] : [low, high];
}

/** "53.6 GB", "24.0–52.9 GB". */
export function bytesFigure(lo: number, hi: number): Figure {
  const a = formatBytes(lo);
  const b = formatBytes(hi);
  if (a === b) return one(a);
  const [low, high] = shareUnit(a, b);
  return joinRange(low, high);
}

/** Prefixes a figure's first piece (a sign). */
function prefixed(prefix: string, f: Figure): Figure {
  return { parts: [prefix + f.parts[0], ...f.parts.slice(1)], text: prefix + f.text };
}

/** "−26.4 GB", "−27.1–55.9 GB", "+1.2 GB" — a change in bytes sent (`lo` ≤ `hi`; one sign when the ends share it). */
export function signedBytesFigure(lo: number, hi: number): Figure {
  const sign = (n: number): string => (n > 0 ? '+' : n < 0 ? MINUS : '');
  if (lo === hi) return prefixed(sign(lo), one(formatBytes(Math.abs(lo))));
  if (lo > 0) return prefixed('+', bytesFigure(lo, hi));
  if (hi < 0) return prefixed(MINUS, bytesFigure(-hi, -lo));
  return joinRange(sign(lo) + formatBytes(Math.abs(lo)), sign(hi) + formatBytes(Math.abs(hi)));
}

/** Whole percentage points between two ratios, signed ("+33", "−2", "0"). */
function pointsBetween(from: number, to: number): number {
  return Math.round(to * 100) - Math.round(from * 100);
}

/** "+33 points", "+1–37 points", "−2–10 points", "1 point" — the change in the savings ratio (`lo` ≤ `hi`). */
export function pointsFigure(fromRatio: number, lo: number, hi: number): Figure {
  const a = pointsBetween(fromRatio, lo);
  const b = pointsBetween(fromRatio, hi);
  if (a === b) return prefixed(a > 0 ? '+' : a < 0 ? MINUS : '', one(tn('units.points', Math.abs(a))));
  const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `${MINUS}${Math.abs(n)}` : '0');
  const f = a > 0 ? prefixed('+', joinRange(String(a), String(b))) : b < 0 ? prefixed(MINUS, joinRange(String(-b), String(-a))) : joinRange(signed(a), signed(b));
  const unit = ` ${t('whatif.compare.pointsUnit')}`;
  const last = f.parts.length - 1;
  return { parts: f.parts.map((p, i) => (i === last ? p + unit : p)), text: f.text + unit };
}

/** Today's annualized bar moved by the projection: paid shrinks by what the change saves, saved grows by it. */
export function projectBar(bar: { whpM: number; paidM: number; savedM: number }, deltaM: number): { whpM: number; paidM: number; savedM: number; ratio: number; addM: number } {
  const d = Math.max(-bar.savedM, Math.min(bar.paidM, Math.round(deltaM)));
  const savedM = bar.savedM + d;
  return { whpM: bar.whpM, paidM: bar.paidM - d, savedM, ratio: bar.whpM > 0 ? savedM / bar.whpM : 0, addM: Math.max(0, d) };
}
