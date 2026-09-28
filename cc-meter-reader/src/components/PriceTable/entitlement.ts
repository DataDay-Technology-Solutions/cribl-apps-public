// src/components/PriceTable/entitlement.ts — the Receipt's entitlement line (EPIC_AUDIT P1-F11).
//
// "You would have paid / You paid / Saved" reads as cash, but a Splunk Cloud ingest subscription, a Sentinel
// commitment tier or a Sumo credit pool is a prepaid entitlement: what Cribl avoids there is realized at renewal,
// when the entitlement is resized. The Receipt says so in one line under its receipt bar (and in Copy receipt),
// only when a destination priced with an entitlement-billed preset carries money (core/receipt.entitlementPresets).

import type { PricesDoc, Snapshot } from '../../../core/types.ts';
import { entitlementPresets } from '../../../core/receipt.ts';
import { presetById } from '../../../core/presets.ts';
import { tn } from '../../copy/en.ts';

/** 'Splunk Cloud', 'Splunk Cloud and Microsoft Sentinel', 'A, B, and C'. */
function joinNames(names: string[]): string {
  try {
    return new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
}

/** The entitlement line for this snapshot at the stored prices, or null when no entitlement-billed destination carries money. */
export function entitlementLine(snapshot: Pick<Snapshot, 'sweepAt' | 'destinations'> | null | undefined, prices: PricesDoc | null | undefined): string | null {
  const names = entitlementPresets(snapshot, prices).map((id) => presetById(id)?.label ?? id);
  if (names.length === 0) return null;
  return tn('receipt.entitlement', names.length, { vendors: joinNames(names) });
}
