// src/components/PriceTable/receiptModel.ts — the Prices page's live receipt (EPIC_AUDIT P2-W09).
//
// As a price is typed, each row prints what its destination's traffic costs at that price — the last sweep's
// delivered GB/day × the draft $/GB, "~ $1,350 / day" — and the card prints the receipt those prices would
// produce: would have paid, paid, saved per day. Nothing is estimated here that the meter would not compute:
// the drafts become a price version exactly as Save would write it (core/pricing.appendPriceVersion over the
// stored document), each destination is priced with core/pricing.effectivePrices (its counterfactual included)
// and every flow into it with core/pricing.priceMinute over the snapshot's per-day bytes. So the numbers are the
// last sweep's traffic at the new prices, to the millicent; a never-swept workspace has no traffic yet (D33), and
// then there is no line at all rather than a guess.

import type { PriceEntry, PricesDoc, Snapshot } from '../../../core/types.ts';
import { appendPriceVersion, effectivePrices, emptyPrices, outputPriceKey, priceEntryAt, priceMinute } from '../../../core/pricing.ts';
import { footColumn, footMoney, mcToDollarInput } from '../../../core/format.ts';
import { toIso } from '../../../core/time.ts';
import { t } from '../../copy/en.ts';
import { counterfactualKey, draftToEntry, validateDraft, type PriceDraft, type PriceRow } from './model.ts';

/** One destination's traffic, per day, from the last sweep: every flow into it (they are priced one by one, as the sweep does). */
export interface DestinationVolume {
  inBPerDay: number;
  outBPerDay: number;
  flows: { inB: number; outB: number }[];
}

/** Per-day bytes by `${groupId}:${outputId}` from the snapshot's flows. */
export function destinationVolumes(snapshot: Pick<Snapshot, 'flows'> | null | undefined): Map<string, DestinationVolume> {
  const out = new Map<string, DestinationVolume>();
  for (const f of snapshot?.flows ?? []) {
    const key = outputPriceKey(f.groupId, f.outputId);
    const v = out.get(key) ?? { inBPerDay: 0, outBPerDay: 0, flows: [] };
    const inB = Number.isFinite(f.inBPerDay) && f.inBPerDay > 0 ? f.inBPerDay : 0;
    const outB = Number.isFinite(f.outBPerDay) && f.outBPerDay > 0 ? f.outBPerDay : 0;
    v.inBPerDay += inB;
    v.outBPerDay += outB;
    v.flows.push({ inB, outB });
    out.set(key, v);
  }
  return out;
}

/** What one row's draft price makes of its destination's traffic. */
export interface RowReceipt {
  /** Delivered bytes per day (what the destination bills on). */
  outBPerDay: number;
  /** The draft's $/GB in millicents. */
  priceMc: number;
  paidPerDayM: number;
  /** paidPerDayM as printed: whole dollars footed so every destination's line adds up to the card's printed Paid. */
  shownPaidPerDayM: number;
  whpPerDayM: number;
  savedPerDayM: number;
  /** The same traffic at the stored price, when the draft changes a stored price (the row's "was"). */
  wasPaidPerDayM?: number;
}

export interface DraftReceipt {
  /** Rows with a valid price and traffic in the last sweep, by row key. */
  rows: Record<string, RowReceipt>;
  /** Σ over every priced destination the last sweep saw. */
  total: {
    whpPerDayM: number;
    paidPerDayM: number;
    savedPerDayM: number;
    destinations: number;
  };
  /** The total as printed: whole dollars, would have paid − paid = saved (core/format.ts footMoney), as every receipt. */
  shown: { whpM: number; paidM: number; savedM: number };
}

/** A valid draft's entry (null when empty or invalid), with an 'other' counterfactual to an unlisted destination read as 'same', as Save does. */
function validEntry(row: PriceRow, draft: PriceDraft | undefined, listed: ReadonlySet<string>): PriceEntry | null {
  if (!draft) return null;
  const errors = validateDraft(row, draft);
  if (errors.price || errors.committed) return null;
  const entry = draftToEntry(draft);
  if (!entry) return null;
  if (entry.counterfactual?.kind === 'other' && !listed.has(outputPriceKey(row.groupId, entry.counterfactual.outputId)))
    entry.counterfactual = { kind: 'same' };
  return entry;
}

function priceDestination(doc: PricesDoc, row: PriceRow, volume: DestinationVolume, nowMs: number): { whpM: number; paidM: number; savedM: number } {
  const eff = effectivePrices(doc, row.groupId, row.outputId, nowMs, {
    type: row.type,
    id: row.outputId,
    description: row.description,
  });
  const sum = { whpM: 0, paidM: 0, savedM: 0 };
  for (const f of volume.flows) {
    const m = priceMinute(f, eff.paidMcPerGb, eff.whpMcPerGb, eff.counterfactual);
    sum.whpM += m.whpM;
    sum.paidM += m.paidM;
    sum.savedM += m.savedM;
  }
  return sum;
}

/**
 * The live receipt for the drafts on screen: the stored prices with every valid draft applied as one new version
 * at `nowMs` (what Save would write), priced over the last sweep's traffic. Null when the workspace has no swept
 * traffic yet (a fresh install meters nothing until prices exist, D33).
 */
export function draftReceipt(
  rows: readonly PriceRow[],
  drafts: Record<string, PriceDraft>,
  prices: PricesDoc | null | undefined,
  snapshot: Pick<Snapshot, 'flows'> | null | undefined,
  nowMs: number,
): DraftReceipt | null {
  const volumes = destinationVolumes(snapshot);
  if (volumes.size === 0) return null;
  const listed = new Set(rows.map((r) => r.key));
  const entries: Record<string, PriceEntry> = {};
  for (const row of rows) {
    const entry = validEntry(row, drafts[row.key], listed);
    if (entry) entries[row.key] = entry;
  }
  const stored = prices ?? emptyPrices(toIso(nowMs));
  const draftDoc = appendPriceVersion(stored, entries, nowMs);
  const out: DraftReceipt = {
    rows: {},
    total: { whpPerDayM: 0, paidPerDayM: 0, savedPerDayM: 0, destinations: 0 },
    shown: { whpM: 0, paidM: 0, savedM: 0 },
  };
  const paidKeys: string[] = [];
  const paidValues: number[] = [];
  for (const row of rows) {
    const volume = volumes.get(row.key);
    const entry = priceEntryAt(draftDoc, row.groupId, row.outputId, nowMs);
    if (!volume || !entry) continue;
    const money = priceDestination(draftDoc, row, volume, nowMs);
    out.total.whpPerDayM += money.whpM;
    out.total.paidPerDayM += money.paidM;
    out.total.savedPerDayM += money.savedM;
    out.total.destinations += 1;
    paidKeys.push(row.key);
    paidValues.push(money.paidM);
    // A row prints its line only for a price it holds on screen (a valid draft) and traffic to price.
    if (!entries[row.key] || volume.outBPerDay + volume.inBPerDay <= 0) continue;
    const line: RowReceipt = {
      outBPerDay: volume.outBPerDay,
      priceMc: entry.milliCentsPerGb,
      paidPerDayM: money.paidM,
      shownPaidPerDayM: money.paidM,
      whpPerDayM: money.whpM,
      savedPerDayM: money.savedM,
    };
    const was = row.stored;
    if (was && was.milliCentsPerGb !== entry.milliCentsPerGb && prices) line.wasPaidPerDayM = priceDestination(prices, row, volume, nowMs).paidM;
    out.rows[row.key] = line;
  }
  // The card's triple adds up to the dollar, and the destinations' lines add up to its Paid (every destination is
  // in the total, so the lines are a split of it): the Receipt, the Flow map and the Ledger print the same triple.
  out.shown = footMoney({ whpM: out.total.whpPerDayM, paidM: out.total.paidPerDayM, savedM: out.total.savedPerDayM });
  const shownPaid = footColumn(paidValues, out.shown.paidM);
  paidKeys.forEach((key, i) => {
    const line = out.rows[key];
    if (line) line.shownPaidPerDayM = shownPaid[i];
  });
  return out;
}

// ─── What Save will write, receipt-style (P2-W09) ────────────────────────────

/** One line of the save bar's list: 'siem-prod  $2.25 → $2.50', or what else changed when the price did not. */
export interface PendingChange {
  key: string;
  name: string;
  /** '$2.25', 'unpriced' for a never-priced row, or 'free' for a free output type priced at $0 (D33) */
  before: string;
  /** '$2.50' */
  after: string;
  /** 'without Cribl: Nowhere (archive-only data)' when the counterfactual changed */
  detail?: string;
}

/** The dirty rows that Save will write (valid ones; an invalid row shows its inline error instead), in table order. */
export function pendingChanges(
  rows: readonly PriceRow[],
  drafts: Record<string, PriceDraft>,
  dirty: ReadonlySet<string>,
  counterfactualLabel: (row: PriceRow, key: string) => string,
): PendingChange[] {
  const out: PendingChange[] = [];
  for (const row of rows) {
    const draft = drafts[row.key];
    if (!draft || !dirty.has(row.key)) continue;
    const errors = validateDraft(row, draft);
    if (errors.price || errors.committed) continue;
    const entry = draftToEntry(draft);
    if (!entry) continue;
    const change: PendingChange = {
      key: row.key,
      name: row.name,
      // A free output type priced at $0 by D33 was "free" before this save, not "unpriced" (r1 ui-9, m4).
      before: row.stored ? `$${mcToDollarInput(row.stored.milliCentsPerGb)}` : row.unpriced ? t('settings.prices.diffNew') : t('settings.prices.diffFree'),
      after: `$${mcToDollarInput(entry.milliCentsPerGb)}`,
    };
    const cfBefore = counterfactualKey(row.stored?.counterfactual);
    if (draft.counterfactual !== cfBefore)
      change.detail = t('settings.prices.diffCounterfactual', {
        label: counterfactualLabel(row, draft.counterfactual),
      });
    out.push(change);
  }
  return out;
}
