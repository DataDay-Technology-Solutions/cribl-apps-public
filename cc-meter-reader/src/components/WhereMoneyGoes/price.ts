// src/components/WhereMoneyGoes/price.ts — prices per GB keep their precision ($0.023), via core/format.

import { fmtPriceShown } from '../../../core/format.ts';

/** "$2.50", "$0.023", "$250,000.00" — a price per GB from integer millicents, through core/format. */
export function formatPricePerGb(mcPerGb: number): string {
  return fmtPriceShown(mcPerGb);
}
