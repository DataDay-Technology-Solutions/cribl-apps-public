// src/views/Receipt/mathNet.ts — Show the math's "Net after Cribl" section, as a pure selector (founder-build r2 ui-8,
// FINDINGS_EXTRA BO-5): the same net the hero prints — the Cribl cost that is set, or with none set the list-price
// estimate the hero shows ("Net after Cribl ≈ … at list price"), labelled an estimate with its GB/day × $/GB basis and the
// way to the contract cost. Before, the drawer said "No Cribl cost is set" beside the hero's estimate.

import { CRIBL_LIST_MC_PER_GB, impliedCostPerGbM } from '../../../core/net.ts';
import type { MathNet } from '../../components/MathDrawer/MathDrawer.tsx';
import { printedNetM, type NetBreakdown } from './model.ts';
import { estimateBasisLine, netSpanWords } from './text.ts';

export const CONTRACT_COST_HREF = '/settings?section=cost';

export interface MathNetInput {
  /** The set Cribl cost's net (netFigures), or null with none set. */
  netBreakdown: NetBreakdown | null;
  /** With no cost set: the list-price estimate the hero shows (listPriceEstimate). */
  estimate: { suggestion: Parameters<typeof estimateBasisLine>[0]; net: NetBreakdown } | undefined;
  /** The cost that is set was saved from "Use this estimate" (Settings.criblCostEstimate). */
  costIsEstimate: boolean;
  /** The period's saved figure (the hero's). */
  savedM: number;
  /** What the workspace receives per day, when the flows say it exactly. */
  bytesInPerDay: number | undefined;
}

/** The drawer's net section, or undefined when there is neither a cost nor an estimate (the "No Cribl cost" line). */
export function mathNetFor(input: MathNetInput): MathNet | undefined {
  const source = input.netBreakdown ?? input.estimate?.net;
  if (!source) return undefined;
  const received = input.bytesInPerDay;
  const fromEstimate = !input.netBreakdown && input.estimate !== undefined;
  const estimate = fromEstimate
    ? { href: CONTRACT_COST_HREF, basis: estimateBasisLine(input.estimate!.suggestion) }
    : input.costIsEstimate
      ? { href: CONTRACT_COST_HREF }
      : undefined;
  return {
    ...source,
    savedM: input.savedM,
    // Printed saved − printed cost (r1 ui-8, m9): the hero's net to the dollar.
    printedNetM: printedNetM(source.netM, source.costM),
    spanWords: netSpanWords(source.minutes),
    impliedMcPerGb: received !== undefined ? impliedCostPerGbM(source.monthlyCostCents, received) : undefined,
    bytesInPerDay: received,
    listMcPerGb: CRIBL_LIST_MC_PER_GB,
    ...(estimate ? { estimate } : {}),
  };
}
