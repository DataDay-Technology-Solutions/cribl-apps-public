// src/components/DestinationStatement/text.ts — "Copy statement" (P2-W25): the destination's statement as a
// monospace receipt, 48 columns like the weekly receipt (core/receipt.ts): the two months side by side with dot
// leaders, then the budget, the price and the counterfactual, each wrapped to the width, and the receipt's sign-off.

import { fmtDollars } from '../../../core/format.ts';
import { RECEIPT_WIDTH, receiptSignOff } from '../../../core/receipt.ts';

export interface StatementTextInput {
  title: string;
  destination: string;
  /** Column heads: this month, last month. */
  months: [string, string];
  /** [label, this month, last month] — undefined prints an em dash. */
  rows: [string, number | undefined, number | undefined][];
  /** Lines under the rule (already in words). */
  notes: string[];
}

const COL = 12;

function money(m: number | undefined): string {
  return m === undefined || !Number.isFinite(m) ? '—' : fmtDollars(m);
}

function wrap(text: string, width = RECEIPT_WIDTH): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

export function statementText(input: StatementTextInput): string {
  const lines: string[] = [];
  const head = input.title;
  const dest = input.destination.slice(0, Math.max(0, RECEIPT_WIDTH - head.length - 2));
  lines.push(`${head}${' '.repeat(Math.max(2, RECEIPT_WIDTH - head.length - dest.length))}${dest}`);
  lines.push(`${' '.repeat(RECEIPT_WIDTH - 2 * COL)}${input.months[0].slice(0, COL - 1).padStart(COL)}${input.months[1].slice(0, COL - 1).padStart(COL)}`);
  for (const [label, a, b] of input.rows) {
    const room = RECEIPT_WIDTH - 2 * COL - 1;
    const name = label.slice(0, room - 2);
    lines.push(`${name} ${'.'.repeat(Math.max(1, room - name.length))}${money(a).padStart(COL)}${money(b).padStart(COL)}`);
  }
  lines.push('-'.repeat(RECEIPT_WIDTH));
  for (const note of input.notes) lines.push(...wrap(note));
  lines.push(...receiptSignOff());
  return lines.join('\n');
}
