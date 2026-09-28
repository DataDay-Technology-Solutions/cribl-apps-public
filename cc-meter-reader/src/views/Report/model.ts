// src/views/Report/model.ts — what the Report card view derives, as pure functions (tests/unit/report-view.test.tsx):
// the period the view opens on (the Receipt's period or its active custom range), the viewer's display name, the
// workspace label, and the file names.

import type { HeadlinePeriod } from '../../../core/types.ts';
import type { ReportCard, ReportCopy } from '../../../core/report.ts';
import { centsToMc, fmtBytes, mcToDollarInput } from '../../../core/format.ts';
import { workspaceFromUrl } from '../../../core/runtime.ts';
import { en, t, tn } from '../../copy/en.ts';
import { formatMoney, formatMultiple, formatPct } from '../../lib/format.ts';
import type { CriblCostSuggestion } from '../Receipt/model.ts';
import { SAMPLE_WORKSPACE } from '../../tour/workspace.ts';
import type { AppParams } from '../../lib/params.ts';
import type { DataSource } from '../../state/store.ts';

/** Every word of the document (core/report.ts reads them as data; core never imports the UI). */
export const REPORT_COPY: ReportCopy = en.report.doc;

export type ReportChoice = 'mtd' | 'today' | '30d' | 'range';
export const PRESET_CHOICES: readonly Exclude<ReportChoice, 'range'>[] = ['mtd', 'today', '30d'];

/** Where a custom range can be summed: live data, and the tour's sample (its history is synthesized in memory, P2-W05). */
export function rangeable(source: DataSource): boolean {
  return source === 'live' || source === 'sample';
}

/**
 * The period the report shows: the Receipt's active custom range (on live data and the tour's sample, as the Receipt
 * sums it; OQ-03), else its ?period when the report has it (the annualized run rate is on every report, so it maps
 * to month to date), else the workspace's default period, else month to date.
 */
export function reportChoice(params: Pick<AppParams, 'period' | 'range'> & { report?: string | null }, source: DataSource, fallback: HeadlinePeriod | undefined): ReportChoice {
  const live = rangeable(source);
  if (params.report === 'range' && live && params.range) return 'range';
  const asChoice = (p: string | null | undefined): Exclude<ReportChoice, 'range'> | undefined =>
    (PRESET_CHOICES as readonly string[]).includes(p ?? '') ? (p as Exclude<ReportChoice, 'range'>) : undefined;
  const explicit = asChoice(params.report);
  if (explicit) return explicit;
  if (live && params.range) return 'range';
  return asChoice(params.period) ?? asChoice(fallback) ?? 'mtd';
}

/** "Jordan Lee" from getCriblUser(), else the username; undefined without one. */
export function viewerDisplayName(user: Partial<CriblUser> | null | undefined): string | undefined {
  if (!user) return undefined;
  const full = [user.firstName, user.lastName].filter((s) => typeof s === 'string' && s.trim() !== '').join(' ').trim();
  if (full) return full;
  const username = typeof user.username === 'string' ? user.username.trim() : '';
  return username || undefined;
}

/** The workspace label on the report: the sample's name, or the Cribl.Cloud workspace from the API URL. */
export function reportWorkspace(source: DataSource, apiUrl: string | undefined): string {
  if (source !== 'live') return SAMPLE_WORKSPACE.name;
  return workspaceFromUrl(apiUrl);
}

export type ReportFileKind = 'pdf' | 'html' | 'csv';

export const FILE_TYPES: Readonly<Record<ReportFileKind, string>> = {
  pdf: 'application/pdf',
  html: 'text/html;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
};

/** meter-reader-report-<workspace>-<period>-<yyyy-mm-dd>.<ext> */
export function reportFileName(fileBase: string, kind: ReportFileKind): string {
  return `${fileBase}.${kind}`;
}

// ─── Before you send it ──────────────────────────────────────────────────────

/**
 * What the sender should know before the document leaves (never printed on it: a CFO can't act on an admin's
 * to-do): list prices rather than contract rates, no Cribl cost (so no return), destinations with no price.
 */
export function reportChecks(card: ReportCard, suggestion?: CriblCostSuggestion): string[] {
  const out: string[] = [];
  if (card.priceMix.list > 0) out.push(t('report.view.checkListPrices'));
  if (!card.cribl) out.push(noCostCheck(card, suggestion));
  const unpriced = card.destinations.unpricedLabels;
  if (unpriced.length > 0) out.push(tn('report.view.checkUnpriced', unpriced.length, { names: unpriced.join(', ') }));
  return out;
}

/**
 * "No Cribl cost is set": with the list-price estimate the Receipt shows, when the ingest is measured (usefulness
 * review, round 2) — the payback at the annualized run rate, as the report's own return would read. The document
 * itself prints no estimate: the sender reads this and decides.
 */
function noCostCheck(card: ReportCard, suggestion: CriblCostSuggestion | undefined): string {
  const yearCostM = suggestion ? suggestion.centsPerMonth * 1000 * 12 : 0;
  if (!suggestion || !(yearCostM > 0) || !Number.isFinite(card.runRate.annualM)) return t('report.view.checkNoCost');
  const x = card.runRate.annualM / yearCostM;
  const vars = {
    volume: fmtBytes(suggestion.bytesInPerDay),
    list: `$${mcToDollarInput(suggestion.listMcPerGb)}`,
    amount: formatMoney(centsToMc(suggestion.centsPerMonth)),
  };
  return x >= 1
    ? t('report.view.checkNoCostEstimate', { ...vars, multiple: formatMultiple(x) })
    : t('report.view.checkNoCostEstimatePartial', { ...vars, pct: formatPct(Math.floor(Math.max(0, x) * 100) / 100) });
}
