// core/report-csv.ts — the report card's flows and destinations as one CSV table for a spreadsheet: every flow
// and every destination per day at the last hour's rate, with the prices behind them (each flow carries its
// destination's 'priced as', the price would have paid uses and the price paid, so GB × price can be checked),
// RFC 4180 (a header row, CRLF line ends, fields with a comma, quote or line break quoted with doubled quotes),
// money in plain dollars with two decimals that add up across a row (core/format.ts footMoney, in cents), GB with
// three, the volume reduction as a percentage with one decimal. No annual column: the report's one annual figure
// is its run rate. A leading byte-order mark lets Excel read the file as UTF-8; a text field that starts like a
// formula (= + - @, a tab or a carriage return) is prefixed with an apostrophe so a spreadsheet shows it rather than
// evaluating it, and a field holding a semicolon or a tab is quoted too: a spreadsheet whose list separator is ';'
// (Excel in much of Europe) or a tab would otherwise split it there, and the piece after the split could start
// like a formula.

import type { ReportCard } from './report.ts';
import { footMoney, fmtPlainDollars, fmtPlainGb, mcToDollarInput } from './format.ts';

const BOM = '﻿';

/** One RFC 4180 field, also quoted when it holds a ';' or a tab (other locales' separators). */
export function csvField(value: string | number): string {
  const s = String(value);
  return /[",;\t\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * A text cell: formula-looking values are neutralised before quoting. A reader whose separator is ';' or a tab (or
 * that splits a comma file on a line break it misreads) ignores this file's quotes, so a piece after one of those
 * characters that starts like a formula is neutralised the same way.
 */
export function textCell(value: string): string {
  const inner = value.replace(/([;\t\r\n][ ]*)([=+\-@])/g, "$1'$2");
  return csvField(/^[=+\-@\t\r]/.test(inner) ? `'${inner}` : inner);
}

function pctCell(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return '';
  return (Math.round(ratio * 1000) / 10).toFixed(1);
}

/** Price cell: the per-GB price at the precision it was entered with, or empty. */
function priceCell(mcPerGb: number | undefined): string {
  return mcPerGb === undefined ? '' : mcToDollarInput(mcPerGb);
}

/** Would have paid, paid and saved in cents that add up (empty for an unpriced destination). */
function moneyCells(m: { whpPerDayM: number; paidPerDayM: number; savedPerDayM: number }, unpriced: boolean): string[] {
  if (unpriced) return ['', '', ''];
  const f = footMoney({ whpM: m.whpPerDayM, paidM: m.paidPerDayM, savedM: m.savedPerDayM }, 'cents');
  return [fmtPlainDollars(f.whpM), fmtPlainDollars(f.paidM), fmtPlainDollars(f.savedM)];
}

/** The flows and destinations as CSV text (with a byte-order mark). */
export function renderReportCsv(card: ReportCard): string {
  const { copy } = card;
  const lines: string[] = [copy.csv.headers.map(textCell).join(',')];
  for (const f of card.flows) {
    lines.push(
      [
        textCell(copy.csv.record.flow),
        textCell(f.pipeline || f.route),
        textCell(f.groupId),
        textCell(f.source),
        textCell(f.pipeline),
        textCell(f.destination),
        textCell(f.pricedAs ?? ''),
        priceCell(f.whpMcPerGb),
        priceCell(f.paidMcPerGb),
        fmtPlainGb(f.inBPerDay),
        fmtPlainGb(f.outBPerDay),
        pctCell(f.volumeRatio),
        ...moneyCells(f, f.unpriced),
      ].join(','),
    );
  }
  for (const d of card.destinations.rows) {
    const ratio = d.inBPerDay > 0 ? Math.max(0, 1 - d.outBPerDay / d.inBPerDay) : undefined;
    lines.push(
      [
        textCell(copy.csv.record.destination),
        textCell(d.label),
        textCell(d.groupId),
        '',
        '',
        textCell(d.label),
        textCell(d.pricedAs),
        d.unpriced ? '' : priceCell(d.whpMcPerGb),
        d.unpriced ? '' : priceCell(d.mcPerGb),
        fmtPlainGb(d.inBPerDay),
        fmtPlainGb(d.outBPerDay),
        pctCell(ratio),
        ...moneyCells(d, d.unpriced),
      ].join(','),
    );
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
