// src/components/FlowDiagram/listRows.ts — the phone list's rows (FlowList.tsx), as a pure function: largest would-have-paid
// first, each with its Source's hue, its bar widths and, on a flow with an alert, the map's mark (P2-W16). Its own module
// so FlowList.tsx exports only its component (React Fast Refresh; oxlint react/only-export-components).

import { OTHER_ID, isDrawable, nodeId, ribbonId, type FlowMark, type LayoutFlow } from './layout.ts';
import { nodeName, otherName } from './text.ts';

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

export interface FlowListRow {
  id: string;
  flow: LayoutFlow;
  names: [string, string, string];
  /** its Source's hue slot (as on the map); absent for the tail and a folded row */
  hue?: number;
  weight: number;
  /** share of the largest row's would-have-paid, in [0, 1] */
  width: number;
  /** saved ÷ would-have-paid, in [0, 1] */
  savedShare: number;
  /** an open (or just recovered) alert on this flow, as the map marks it (marks.ts incidentMarks) */
  mark?: FlowMark;
}

/**
 * The rows, from flows already folded (groupSmallFlows, keeping the marked flows unfolded); undrawable flows are
 * skipped. `marks` is incidentMarks' by flow key. Pure.
 */
export function listRows(
  flows: readonly LayoutFlow[],
  sourceColors: ReadonlyMap<string, number>,
  humanize?: Record<string, string>,
  marks?: Readonly<Record<string, FlowMark>>,
): FlowListRow[] {
  const drawable = flows.filter(isDrawable).sort((a, b) => b.whpPerDayM - a.whpPerDayM || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const max = drawable[0]?.whpPerDayM ?? 0;
  return drawable.map((f) => {
    const other = f.inputId === OTHER_ID;
    const hue = other ? undefined : sourceColors.get(nodeId('in', f.groupId, f.inputId));
    const mark = other ? undefined : marks?.[f.key];
    return {
      id: ribbonId(f),
      flow: f,
      names: [
        other ? otherName('in', f.folded ?? 0) : nodeName('in', f.inputId, humanize),
        other ? otherName('pipe', f.folded ?? 0) : nodeName('pipe', f.pipelineId, humanize),
        nodeName('out', f.outputId, humanize),
      ],
      ...(hue !== undefined ? { hue } : {}),
      // the bar is dollars already: no price fade (the map's dollar mode, P1-I01)
      weight: 1,
      width: max > 0 ? clamp01(f.whpPerDayM / max) : 0,
      savedShare: f.whpPerDayM > 0 ? clamp01(f.savedPerDayM / f.whpPerDayM) : 0,
      ...(mark ? { mark } : {}),
    };
  });
}
