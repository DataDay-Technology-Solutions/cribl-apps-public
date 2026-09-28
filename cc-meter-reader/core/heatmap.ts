// core/heatmap.ts — the hour-of-week savings map (P2-W25): 7 local days × 24 local hours of saved dollars, summed
// from the hour rollups (roll/hour/YYYY-MM-DD, one document per UTC day, rows already priced). Pure, millicents.
//
// The window is the last 168 whole hours before `endMs`: each cell is one real hour, so a cell is "saved that
// hour", never an average. Rows are placed by their local weekday (Monday first) and local hour in `tz`; a DST
// change folds an hour into its neighbour or leaves one empty, which is the truth for that week.

import type { FlowKey, RollHourDoc } from './types.ts';
import { parseFlowKey } from './flows.ts';
import { hourDocKey } from './rollups.ts';
import { DAY_MS, HOUR_MS, fromIso, hourFloor } from './time.ts';

export const HEATMAP_HOURS = 168;

export interface HeatCell {
  /** 0 = Monday … 6 = Sunday (local). */
  day: number;
  /** 0–23, local. */
  hour: number;
  savedM: number;
  whpM: number;
  paidM: number;
  /** Rows summed into this cell (0 = nothing metered that hour). */
  rows: number;
  /** The hour's start, epoch ms (the latest row's hour when several fold together). */
  atMs?: number;
}

export interface Heatmap {
  /** 168 cells, day-major: cells[day * 24 + hour]. */
  cells: HeatCell[];
  fromMs: number;
  toMs: number;
  maxSavedM: number;
  totalSavedM: number;
  /** Indices into `cells` of the three largest savers (fewer when fewer hours saved anything). */
  top: number[];
  /** Hours that had at least one row. */
  hoursMetered: number;
}

/** The last 168 whole hours before `endMs`, and the hour documents (UTC days) that hold them — at most 8. */
export function heatmapWindow(endMs: number): { fromMs: number; toMs: number; keys: string[] } {
  const toMs = hourFloor(endMs);
  const fromMs = toMs - HEATMAP_HOURS * HOUR_MS;
  const keys: string[] = [];
  for (let d = fromMs; d < toMs + DAY_MS; d += DAY_MS) {
    const key = hourDocKey(Math.min(d, toMs - 1));
    if (!keys.includes(key)) keys.push(key);
  }
  return { fromMs, toMs, keys };
}

const WEEKDAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function localSlot(ms: number, fmt: Intl.DateTimeFormat): { day: number; hour: number } {
  const parts = fmt.formatToParts(new Date(ms));
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  return { day: WEEKDAY[wd] ?? 0, hour: h };
}

export interface HeatmapOptions {
  fromMs: number;
  toMs: number;
  tz: string;
  /** Only these flows (e.g. the ones reaching one destination). */
  include?: (key: FlowKey) => boolean;
}

/** Only the flows that reach `outputId` (in `groupId` when given). */
export function flowsTo(outputId: string, groupId?: string): (key: FlowKey) => boolean {
  return (key) => {
    const p = parseFlowKey(key);
    return p !== null && p.outputId === outputId && (groupId === undefined || p.groupId === groupId);
  };
}

export function buildHeatmap(docs: readonly (RollHourDoc | null | undefined)[], opts: HeatmapOptions): Heatmap {
  const cells: HeatCell[] = [];
  for (let day = 0; day < 7; day++) for (let hour = 0; hour < 24; hour++) cells.push({ day, hour, savedM: 0, whpM: 0, paidM: 0, rows: 0 });
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: opts.tz, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
  const metered = new Set<number>();
  for (const doc of docs) {
    for (const [key, rows] of Object.entries(doc?.flows ?? {})) {
      if (opts.include && !opts.include(key)) continue;
      for (const r of rows ?? []) {
        const t = fromIso(r.t);
        if (!Number.isFinite(t) || t < opts.fromMs || t >= opts.toMs) continue;
        const { day, hour } = localSlot(t, fmt);
        const c = cells[day * 24 + hour];
        c.savedM += Number.isFinite(r.savedM) ? r.savedM : 0;
        c.whpM += Number.isFinite(r.whpM) ? r.whpM : 0;
        c.paidM += Number.isFinite(r.paidM) ? r.paidM : 0;
        c.rows += 1;
        c.atMs = Math.max(c.atMs ?? t, t);
        metered.add(hourFloor(t));
      }
    }
  }
  let maxSavedM = 0;
  let totalSavedM = 0;
  for (const c of cells) {
    maxSavedM = Math.max(maxSavedM, c.savedM);
    totalSavedM += c.savedM;
  }
  const top = cells
    .map((c, i) => [c.savedM, i] as const)
    .filter(([v]) => v > 0)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .slice(0, 3)
    .map(([, i]) => i);
  return { cells, fromMs: opts.fromMs, toMs: opts.toMs, maxSavedM, totalSavedM, top, hoursMetered: metered.size };
}
