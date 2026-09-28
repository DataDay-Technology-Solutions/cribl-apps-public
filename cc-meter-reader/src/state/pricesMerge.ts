// src/state/pricesMerge.ts — a prices save that never reverts another tab's (P1-D04).
//
// A tab builds its save from the prices document it holds: the newest version plus the member's edits
// (core/pricing `appendPriceVersion`). If another tab (or "Load demo prices" elsewhere) saved in between, that
// document is stale, and writing it would silently revert the other save (measured: tab B's $0.55 back to
// $0.03). So `savePrices` reads the stored document first; when it is not the one this tab built on, only
// what this tab CHANGED is appended as a new version on top of the stored document. Both saves survive: the
// stored versions stay as they are, and the new version carries the other tab's prices except where this tab
// changed one.

import { appendPriceVersion } from '../../core/pricing.ts';
import type { PriceEntry, PricesDoc, PriceVersion } from '../../core/types.ts';

function latest(doc: PricesDoc | null | undefined): PriceVersion | undefined {
  const versions = doc?.versions ?? [];
  return versions.length > 0 ? versions[versions.length - 1] : undefined;
}

/** Two documents are the same save when their stamps match (every save stamps `updatedAt`). */
export function isSameSave(a: PricesDoc | null | undefined, b: PricesDoc | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.updatedAt === b.updatedAt && (a.versions?.length ?? 0) === (b.versions?.length ?? 0);
}

/** The entries of `next`'s newest version that differ from `base`'s newest version: what this save changed. */
export function changedEntries(base: PricesDoc | null | undefined, next: PricesDoc): Record<string, PriceEntry> {
  const before = latest(base)?.byOutputId ?? {};
  const after = latest(next)?.byOutputId ?? {};
  const out: Record<string, PriceEntry> = {};
  for (const [key, entry] of Object.entries(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(entry)) out[key] = entry;
  }
  return out;
}

export interface PricesRebase {
  doc: PricesDoc;
  /** true when another save landed first and this one was appended on top of it */
  merged: boolean;
}

/**
 * The document to write for a save built as `next` on top of `base` (what this tab held), given what is
 * `stored` now. `updatedAt` is the save's stamp.
 */
export function rebasePrices(next: PricesDoc, base: PricesDoc | null | undefined, stored: PricesDoc | null, updatedAt: string): PricesRebase {
  if (stored === null || isSameSave(stored, base)) return { doc: { ...next, updatedAt }, merged: false };
  const delta = changedEntries(base, next);
  const mine = Date.parse(latest(next)?.effectiveFrom ?? updatedAt);
  const theirs = Date.parse(latest(stored)?.effectiveFrom ?? '');
  // Versions are looked up by effectiveFrom: keep the new one after the stored newest even across clock skew.
  const effectiveFromMs = Number.isFinite(theirs) && !(mine > theirs) ? theirs + 1 : Number.isFinite(mine) ? mine : Date.parse(updatedAt);
  if (Object.keys(delta).length === 0) return { doc: { ...stored, updatedAt }, merged: true };
  // The rebased version keeps this save's author (P2-W24).
  const doc = appendPriceVersion(stored, delta, effectiveFromMs, latest(next)?.changedBy);
  return { doc: { ...doc, updatedAt }, merged: true };
}
