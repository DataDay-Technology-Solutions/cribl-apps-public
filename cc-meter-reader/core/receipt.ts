// core/receipt.ts — the weekly receipt (SPEC 12.4) and the Receipt view's "Copy receipt" text (SPEC 13).
// The text form is monospace, 48 characters wide: dot leaders, right-aligned whole dollars, a divider,
// the total, the would-have-paid line, the week-over-week trend and the open alerts.

import type {
  Counterfactual,
  DestinationFigures,
  FlowKey,
  HeadlinePeriod,
  ISO,
  Incident,
  PresetId,
  PricesDoc,
  ReceiptBasis,
  ReceiptBasisPrice,
  Snapshot,
  WeeklyReceipt,
} from './types.ts';
import { fmtDollars, fmtPct, footColumn, footMoney, mcToDollarInput, roundToDollarsM, signedWholePct } from './format.ts';
import { humanize } from './humanize.ts';
import { effectivePrices, isDiversion, periodCoverage, priceEntryAt, ratio } from './pricing.ts';
import { presetById } from './presets.ts';
import { formatRangeParam, perDayAtRate, rangeSpanLabel, type RangeComparison, type RangeFigures, printedDeltaM } from './range.ts';
import { sumFlowRows } from './rollups.ts';
import { parseFlowKey } from './flows.ts';
import { titleFor } from './incidents.ts';
import { mtdNetOfCribl } from './net.ts';
import { CREDIT_STRINGS, RECEIPT_STRINGS as S, fill, plural } from './strings.ts';
import {
  addDaysToKey,
  fromIso,
  localDayKey,
  localDayStartMs,
  localMonthStartMs,
  toIso,
  weekRangeLabel,
} from './time.ts';

export const RECEIPT_WIDTH = 48;
export const RECEIPT_MAX_LINES = 5;
/** P0-23: the Basis block prints at most this many destinations, then "and N more priced destinations". */
export const RECEIPT_MAX_BASIS_PRICES = 8;
/** P1-F04: a truncated item label leaves at least this many leader dots before its amount. */
const MIN_LEADER_DOTS = 4;

type Money = { whpM: number; paidM: number; savedM: number };

export interface WeeklyReceiptInput {
  periodStartMs: number;
  /** exclusive end */
  periodEndMs: number;
  tz: string;
  /** per-flow money over the period; or give `rowsByFlow` and it is summed here */
  flowSums?: Record<FlowKey, Money>;
  /** roll/hour or roll/day rows by flow (t within the period count; the prior period is read from the same rows) */
  rowsByFlow?: Record<FlowKey, { t: ISO; whpM: number; paidM: number; savedM: number }[]>;
  /** settings.humanize overrides, keyed by pipeline (or route) id */
  labels?: Record<string, string>;
  /** Σ saved in the previous period of equal length (defaults to the sum from rowsByFlow, when given) */
  priorSavedM?: number;
  openIncidents?: (Pick<Incident, 'type' | 'label'> & { closedAt?: ISO })[];
  /**
   * P0-23: what the Basis block is built from — the prices document (preset or typed-in prices, read at the
   * period's end), the last snapshot's destinations (types, unpriced flags), and the minutes metered in the period.
   * Omitted → the receipt carries no basis (older callers).
   */
  basis?: Omit<BasisInput, 'byOutput' | 'atMs' | 'labels' | 'exactAmounts'>;
  /** P0-23: the App's link base ('https://<org>.cribl.cloud/apps/a/meter-reader'): the receipt links to its week on the Receipt */
  linkBase?: string;
}

/** Label of the line a flow's savings roll up to: its pipeline (the thing doing the saving), else its route. */
function lineLabel(key: FlowKey, labels?: Record<string, string>): string {
  const p = parseFlowKey(key);
  if (!p) return humanize(key, labels);
  if (p.pipelineId !== '-') return humanize(p.pipelineId, labels);
  if (p.routeId !== '-') return humanize(p.routeId, labels);
  return S.otherLine;
}

/**
 * P1-F02: the destinations (`${groupId}:${outputId}`) whose data is credited at another destination's price at
 * `atMs` — from the prices document when there is one, else the last snapshot's destinations.
 */
export function divertedOutputs(opts: { prices?: PricesDoc | null; destinations?: readonly DestinationFigures[] }, keys: Iterable<string>, atMs: number): Set<string> {
  const byKey = new Map<string, DestinationFigures>();
  for (const d of opts.destinations ?? []) byKey.set(`${d.groupId}:${d.outputId}`, d);
  const out = new Set<string>();
  for (const key of keys) {
    const cut = key.indexOf(':');
    if (cut < 0) continue;
    const groupId = key.slice(0, cut);
    const outputId = key.slice(cut + 1);
    const cf = opts.prices ? effectivePrices(opts.prices, groupId, outputId, atMs, byKey.get(key)?.type).counterfactual : byKey.get(key)?.counterfactual;
    if (isDiversion(cf, outputId)) out.add(key);
  }
  return out;
}

/** The destination key (`${groupId}:${outputId}`) of a flow, or undefined. */
function outputKeyOf(key: FlowKey): string | undefined {
  const p = parseFlowKey(key);
  return p && p.outputId !== '-' ? `${p.groupId}:${p.outputId}` : undefined;
}

/**
 * Item lines from per-flow sums: savings per pipeline, largest first, at most five. P1-F02: a pipeline's savings at a
 * destination credited at another's price are their own line, tagged `diverted`, never blended with bytes dropped.
 */
function itemLines(sums: Record<FlowKey, Money>, diverted: Set<string>, labels?: Record<string, string>): { label: string; savedM: number; diverted?: true }[] {
  const byLine = new Map<string, { label: string; savedM: number; diverted: boolean }>();
  for (const [key, m] of Object.entries(sums)) {
    const label = lineLabel(key, labels);
    const out = outputKeyOf(key);
    const isDiverted = out !== undefined && diverted.has(out);
    const k = `${isDiverted ? 'd' : 'r'}|${label}`;
    const acc = byLine.get(k) ?? { label, savedM: 0, diverted: isDiverted };
    acc.savedM += m.savedM;
    byLine.set(k, acc);
  }
  return [...byLine.values()]
    .filter((l) => l.savedM > 0)
    .sort((a, b) => b.savedM - a.savedM || (a.label < b.label ? -1 : a.label > b.label ? 1 : Number(a.diverted) - Number(b.diverted)))
    .slice(0, RECEIPT_MAX_LINES)
    .map((l) => (l.diverted ? { label: l.label, savedM: l.savedM, diverted: true as const } : { label: l.label, savedM: l.savedM }));
}

/** P1-F02: Σ savings of flows at diverted destinations. */
function divertedSum(sums: Record<FlowKey, Money>, diverted: Set<string>): number {
  let total = 0;
  for (const [key, m] of Object.entries(sums)) {
    const out = outputKeyOf(key);
    if (out !== undefined && diverted.has(out)) total += m.savedM;
  }
  return total;
}

/** Top savers, totals, ratio, trend and open alerts for a period (SPEC 12.4 JSON form). */
export function buildWeeklyReceipt(input: WeeklyReceiptInput): WeeklyReceipt {
  const sums = input.flowSums ?? (input.rowsByFlow ? sumFlowRows(input.rowsByFlow, input.periodStartMs, input.periodEndMs) : {});
  const total: Money = { whpM: 0, paidM: 0, savedM: 0 };
  for (const m of Object.values(sums)) {
    total.whpM += m.whpM;
    total.paidM += m.paidM;
    total.savedM += m.savedM;
  }
  const outKeys = new Set(Object.keys(sums).map(outputKeyOf).filter((k): k is string => k !== undefined));
  const diverted = input.basis ? divertedOutputs(input.basis, outKeys, input.periodEndMs - 1) : new Set<string>();
  const lines = itemLines(sums, diverted, input.labels);
  const divertedM = divertedSum(sums, diverted);

  let priorSavedM = input.priorSavedM;
  if (priorSavedM === undefined && input.rowsByFlow) {
    const len = input.periodEndMs - input.periodStartMs;
    const prior = sumFlowRows(input.rowsByFlow, input.periodStartMs - len, input.periodStartMs);
    const values = Object.values(prior);
    if (values.length > 0) priorSavedM = values.reduce((s, m) => s + m.savedM, 0);
  }

  const receipt: WeeklyReceipt = {
    periodStart: toIso(input.periodStartMs),
    periodEnd: toIso(input.periodEndMs),
    label: weekRangeLabel(input.periodStartMs, input.periodEndMs, input.tz),
    lines,
    savedM: total.savedM,
    whpM: total.whpM,
    paidM: total.paidM,
    ratio: ratio(total.savedM, total.whpM),
    openIncidents: (input.openIncidents ?? []).filter((i) => !i.closedAt).map((i) => ({ title: titleFor(i) })),
  };
  if (divertedM > 0) receipt.divertedM = Math.min(divertedM, total.savedM);
  if (priorSavedM !== undefined) {
    receipt.priorSavedM = priorSavedM;
    // R2 core-9 (BO-11): half up on the magnitude, as the comparison prints the same change (fmtPct).
    if (priorSavedM > 0) receipt.trendPct = signedWholePct((total.savedM - priorSavedM) / priorSavedM);
  }
  if (input.basis) {
    receipt.basis = receiptBasis({
      ...input.basis,
      byOutput: sumsByOutput(sums),
      atMs: input.periodEndMs - 1,
      ...(input.labels ? { labels: input.labels } : {}),
      exactAmounts: true,
    });
  }
  if (input.linkBase) receipt.link = receiptLink(input.linkBase, input.periodStartMs, input.periodEndMs);
  return receipt;
}

/**
 * P0-23: the Receipt showing exactly this period as a custom range — '<linkBase>/?range=2026-09-21T04:00Z..2026-09-28T04:00Z'
 * (colons kept readable, as in the Ledger link).
 */
export function receiptLink(linkBase: string, fromMs: number, toMs: number): string {
  const base = (linkBase ?? '').replace(/\/+$/, '');
  const range = encodeURIComponent(formatRangeParam({ kind: 'absolute', fromMs, toMs })).replace(/%3A/gi, ':');
  return `${base}/?range=${range}`;
}

// ─── Basis (P0-23) ───────────────────────────────────────────────────────────

/** Per-flow money summed per destination, keyed `${groupId}:${outputId}`. */
function sumsByOutput(sums: Record<FlowKey, Money>): Record<string, Money> {
  const out: Record<string, Money> = {};
  for (const [key, m] of Object.entries(sums)) {
    const p = parseFlowKey(key);
    if (!p || p.outputId === '-') continue;
    const k = `${p.groupId}:${p.outputId}`;
    const acc = out[k] ?? { whpM: 0, paidM: 0, savedM: 0 };
    acc.whpM += m.whpM;
    acc.paidM += m.paidM;
    acc.savedM += m.savedM;
    out[k] = acc;
  }
  return out;
}

export interface BasisInput {
  /** money per destination over the period (or per day, for a rate), keyed `${groupId}:${outputId}` */
  byOutput: Record<string, Money>;
  /** the last snapshot's destinations: output types, prices as of that sweep, unpriced flags */
  destinations?: readonly DestinationFigures[];
  /** the prices document: whether a price is a preset's typical list price or one typed in (a contract rate) */
  prices?: PricesDoc | null;
  /** the instant prices are read at (the period's last moment) */
  atMs: number;
  labels?: Record<string, string>;
  /** `byOutput` holds the period's own sums (weekly, a range, month to date), so credits print their amount */
  exactAmounts?: boolean;
  coverage?: ReceiptBasis['coverage'];
  /** destinations with no price of their own; defaults to the count in `destinations` */
  unpricedCount?: number;
}

/** Destinations with no price of their own (a counterfactual to an unpriced target is still priced itself, P1-F01). */
function unpricedOwnCount(destinations: readonly DestinationFigures[] | undefined): number {
  return new Set((destinations ?? []).filter((d) => d.unpriced && !d.counterfactualUnpriced).map((d) => d.outputId)).size;
}

/**
 * P0-23: the prices behind a receipt's dollars — one line per destination that carries money, its $/GB and
 * whether that is a preset's typical list price or a price typed in; the counterfactual credits (data credited at
 * another destination's price, or never counted); how many destinations are unpriced and excluded; and how much of
 * the period was metered. Largest would-have-paid first.
 */
export function receiptBasis(input: BasisInput): ReceiptBasis {
  const dests = new Map<string, DestinationFigures>();
  for (const d of input.destinations ?? []) dests.set(`${d.groupId}:${d.outputId}`, d);
  const rows: { weightM: number; price: ReceiptBasisPrice }[] = [];
  for (const [key, m] of Object.entries(input.byOutput)) {
    if (!(m.whpM > 0 || m.paidM > 0)) continue;
    const cut = key.indexOf(':');
    if (cut < 0) continue;
    const groupId = key.slice(0, cut);
    const outputId = key.slice(cut + 1);
    const d = dests.get(key);
    const eff = input.prices ? effectivePrices(input.prices, groupId, outputId, input.atMs, d?.type) : undefined;
    const cfUnpriced = eff ? eff.counterfactualUnpriced : d?.counterfactualUnpriced === true;
    if (eff ? eff.unpriced && !cfUnpriced : d?.unpriced === true && !cfUnpriced) continue;
    const price: ReceiptBasisPrice = { label: humanize(outputId, input.labels), milliCentsPerGb: eff?.paidMcPerGb ?? d?.milliCentsPerGb ?? 0 };
    const entry = input.prices ? priceEntryAt(input.prices, groupId, outputId, input.atMs) : undefined;
    if (entry) {
      const preset = presetById(entry.preset);
      // A committed rate is the member's own (P1-F10): never a preset's typical list price.
      if (preset && preset.milliCentsPerGb === entry.milliCentsPerGb && entry.committedMilliCentsPerGb === undefined) {
        price.source = 'preset';
        price.presetLabel = preset.label;
      } else price.source = 'custom';
    }
    const cf: Counterfactual = eff?.counterfactual ?? d?.counterfactual ?? { kind: 'same' };
    if (cf.kind === 'other' && cf.outputId !== outputId) {
      const target = dests.get(`${groupId}:${cf.outputId}`);
      const credited: NonNullable<ReceiptBasisPrice['creditedAt']> = {
        label: humanize(cf.outputId, input.labels),
        milliCentsPerGb: eff?.whpMcPerGb ?? target?.milliCentsPerGb ?? 0,
      };
      if (cfUnpriced) credited.unpriced = true;
      else if (input.exactAmounts) credited.whpM = m.whpM;
      price.creditedAt = credited;
    } else if (cf.kind === 'none') price.noSavings = true;
    rows.push({ weightM: Math.max(m.whpM, m.paidM), price });
  }
  rows.sort((a, b) => b.weightM - a.weightM || (a.price.label < b.price.label ? -1 : a.price.label > b.price.label ? 1 : 0));
  const basis: ReceiptBasis = { prices: rows.map((r) => r.price), unpricedCount: input.unpricedCount ?? unpricedOwnCount(input.destinations) };
  if (input.coverage && input.coverage.expected > 0) basis.coverage = input.coverage;
  return basis;
}

/**
 * P1-F10: what the dollars on screen are priced at — 'contract' when every destination carrying money has a price the
 * member entered (their rate, or a committed rate), else 'preset' (some still at a preset's typical list price). The
 * counts say how many. Undefined while no priced destination carries money.
 */
export interface PriceBasisSummary {
  kind: 'contract' | 'preset';
  /** money-carrying destinations at the member's own rate */
  custom: number;
  /** money-carrying priced destinations */
  total: number;
}

export function priceBasisSummary(snapshot: Pick<Snapshot, 'destinations' | 'sweepAt'> | null | undefined, prices: PricesDoc | null | undefined): PriceBasisSummary | undefined {
  if (!snapshot || !prices) return undefined;
  const byOutput: Record<string, Money> = {};
  for (const d of snapshot.destinations ?? []) {
    const mtd = { whpM: d.mtdWhpM, paidM: d.mtdPaidM, savedM: d.mtdSavedM };
    byOutput[`${d.groupId}:${d.outputId}`] = mtd.whpM > 0 || mtd.paidM > 0 ? mtd : { whpM: d.whpPerDayM, paidM: d.paidPerDayM, savedM: d.savedPerDayM };
  }
  const at = fromIso(snapshot.sweepAt);
  const basis = receiptBasis({ byOutput, destinations: snapshot.destinations, prices, atMs: Number.isNaN(at) ? Date.now() : at });
  const sourced = basis.prices.filter((p) => p.source !== undefined && p.milliCentsPerGb > 0);
  if (sourced.length === 0) return undefined;
  const custom = sourced.filter((p) => p.source === 'custom').length;
  return { kind: custom === sourced.length ? 'contract' : 'preset', custom, total: sourced.length };
}

/** '$2.25/GB', '$0.023/GB' — a price keeps its precision. */
const perGb = (mc: number): string => `$${mcToDollarInput(mc)}/GB`;

/** 1234567 → '1,234,567'. */
const int = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Greedy word wrap to the width; continuation lines are indented two spaces. A word longer than a line is cut. */
function wrapWords(text: string, width = RECEIPT_WIDTH, indent = '  '): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ').filter(Boolean)) {
    const lead = out.length === 0 ? '' : indent;
    if (line === '') line = `${lead}${word}`;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = `${indent}${word}`;
    }
  }
  if (line !== '') out.push(line);
  return out.map((l) => truncate(l, width));
}

/** A destination named after its preset ("Datadog" priced as "Datadog Logs") need not repeat the vendor. */
function namesPreset(label: string, presetLabel: string): boolean {
  const a = label.trim().toLowerCase();
  const b = presetLabel.trim().toLowerCase();
  return a.length > 0 && (a === b || b.startsWith(`${a} `) || a.startsWith(`${b} `));
}

/** The price line of one destination: "siem-prod: $2.25/GB, Splunk Cloud typical list" ("Datadog: $1.80/GB, typical list"). */
function basisPriceText(p: ReceiptBasisPrice): string {
  const preset =
    p.source === 'preset' && p.presetLabel ? (namesPreset(p.label, p.presetLabel) ? S.typicalList : fill(S.presetTypicalList, { preset: p.presetLabel })) : undefined;
  const source = preset ? `, ${preset}` : p.source === 'custom' ? `, ${S.customPrice}` : '';
  let text = `${fill(S.basisPrice, { label: p.label, price: perGb(p.milliCentsPerGb) })}${source}`;
  if (p.creditedAt) {
    const c = p.creditedAt;
    const amount = c.whpM !== undefined ? `: ${fmtDollars(c.whpM)}` : '';
    text += c.unpriced ? `; ${fill(S.creditedUnpriced, { label: c.label })}` : `; ${fill(S.creditedAt, { label: c.label, price: perGb(c.milliCentsPerGb) })}${amount}`;
  } else if (p.noSavings) text += `; ${S.neverSavings}`;
  return text;
}

/**
 * "Metered 27,540 of 34,560 minutes (79%)" — the percentage never rounds up to 100 while a minute is missing, and
 * never reads 0 while something was metered ("under 1%").
 */
export function coverageLine(c: NonNullable<ReceiptBasis['coverage']>): string {
  const metered = Math.min(Math.max(0, c.metered), c.expected);
  const unit = c.unit === 'days' ? plural(c.expected, { one: S.units.day, other: S.units.days }) : plural(c.expected, { one: S.units.minute, other: S.units.minutes });
  return fill(S.metered, { metered: int(metered), expected: int(c.expected), unit, pct: coveragePct(c) });
}

/**
 * The coverage percentage as coverageLine prints it: floored, so it never reads 100% while a minute is missing, and
 * never 0% while something was metered ("under 1%"). Founder-build r3 core-2: the bell's weekly line prints it too.
 */
export function coveragePct(c: NonNullable<ReceiptBasis['coverage']>): string {
  const metered = Math.min(Math.max(0, c.metered), c.expected);
  const floorPct = Math.floor((metered / c.expected) * 100);
  return metered >= c.expected ? fmtPct(1) : metered > 0 && floorPct === 0 ? S.meteredUnder1 : fmtPct(floorPct / 100);
}

/** R3 core-2: whether a receipt's coverage says part of its period was not metered (an older receipt has none). */
export function partialCoverage(c: ReceiptBasis['coverage'] | undefined): c is NonNullable<ReceiptBasis['coverage']> {
  return !!c && Number.isFinite(c.metered) && Number.isFinite(c.expected) && c.expected > 0 && c.metered < c.expected;
}

/** The Basis block (P0-23): a blank line, 'Basis', then its lines wrapped inside the 48 columns. */
function basisBlock(b: ReceiptBasis): string[] {
  const out: string[] = ['', S.basis];
  const shown = b.prices.slice(0, RECEIPT_MAX_BASIS_PRICES);
  for (const p of shown) out.push(...wrapWords(basisPriceText(p)));
  const more = b.prices.length - shown.length;
  if (more > 0) out.push(fill(plural(more, S.morePriced), { n: more }));
  if (b.prices.length === 0) out.push(S.noMoney);
  if (b.unpricedCount > 0) out.push(fill(plural(b.unpricedCount, S.unpricedExcluded), { n: b.unpricedCount }));
  if (b.coverage) out.push(coverageLine(b.coverage));
  return out;
}

// ─── Periods ─────────────────────────────────────────────────────────────────

/** The last complete local Monday–Sunday week before `nowMs` (what the Monday 12:00 UTC send covers). */
export function previousWeek(nowMs: number, tz: string): { startMs: number; endMs: number } {
  const today = localDayKey(nowMs, tz);
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const thisMonday = addDaysToKey(today, -((dow + 6) % 7));
  return { startMs: localDayStartMs(addDaysToKey(thisMonday, -7), tz), endMs: localDayStartMs(thisMonday, tz) };
}

/** The seven whole local days before today ("Weekly receipt now"). */
export function trailingWeek(nowMs: number, tz: string): { startMs: number; endMs: number } {
  const today = localDayKey(nowMs, tz);
  return { startMs: localDayStartMs(addDaysToKey(today, -7), tz), endMs: localDayStartMs(today, tz) };
}

// ─── Text form ───────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Joins segments with ' · ', breaking between segments (never inside one) to stay within the width. */
function wrapSegments(segments: string[], width = RECEIPT_WIDTH): string[] {
  const out: string[] = [];
  let line = '';
  for (const seg of segments) {
    if (line === '') line = seg;
    else if (line.length + 3 + seg.length <= width) line += ` · ${seg}`;
    else {
      out.push(line);
      line = seg;
    }
  }
  if (line !== '') out.push(line);
  return out.map((l) => truncate(l, width));
}

/** 'Open alerts: 1 (Savings dropped: X)' on one line when it fits, else a count line and one indented line per alert. */
function alertLines(alerts: { title: string }[], width = RECEIPT_WIDTH): string[] {
  if (alerts.length === 0) return [S.openAlertsNone];
  const one = fill(S.openAlertsList, { n: alerts.length, titles: alerts.map((a) => a.title).join('; ') });
  if (one.length <= width) return [one];
  return [fill(S.openAlertsCount, { n: alerts.length }), ...alerts.map((a) => truncate(`  ${a.title}`, width))];
}

/**
 * The receipt's sign-off: a blank line, then the builder's signature centred on the receipt's width, where a till
 * prints its thank-you. The last lines of every receipt (Copy receipt, the weekly receipt in Slack, the bell and
 * ServiceNow, a comparison, a destination's statement).
 */
export function receiptSignOff(width = RECEIPT_WIDTH): string[] {
  const sig = CREDIT_STRINGS.signature;
  return ['', `${' '.repeat(Math.max(0, Math.floor((width - sig.length) / 2)))}${sig}`];
}

/** 'left' + spaces + 'right', right-aligned to the width (≥ 2 spaces), or two lines when it can't fit. */
function spread(left: string, right: string, width = RECEIPT_WIDTH): string[] {
  const gap = width - left.length - right.length;
  if (gap >= 2) return [`${left}${' '.repeat(gap)}${right}`];
  return [truncate(left, width), right.padStart(width)];
}

interface ReceiptBody {
  title: string;
  rangeLabel: string;
  lines: { label: string; savedM: number; diverted?: true }[];
  /** P1-F04: a line above the items saying what they are (rates, not the period's sums) */
  linesHeader?: string;
  /** P1-F04: appended to each item amount ('/day' for rates) */
  lineSuffix?: string;
  /**
   * R2 core-9 (BO-9): the lines are a split of the total (the weekly receipt, a range): they print footed to it
   * (footColumn, D53), with an "Other" line for the savers beyond the five listed. Rates (the period receipt) are not.
   */
  footLines?: true;
  totalLabel: string;
  savedM: number;
  /** "Would have paid …", "Paid …", "N% saved" — joined with ' · ' and wrapped between segments */
  summary: string[];
  /** P1-F04: "Net after Cribl …" segments, wrapped the same way */
  net?: string[];
  /** P1-F02: of the total, the part credited by diversion (the rest was bytes dropped): a split line when > 0 */
  divertedM?: number;
  trend?: string;
  /** A closing caveat in prose, word-wrapped (P1-F11: the entitlement line). */
  note?: string;
  openAlerts: { title: string }[];
  /** P0-23: the Basis block */
  basis?: ReceiptBasis;
  /** P0-23: the deep link, printed whole on its own line (a URL is never wrapped or cut at 48 columns) */
  link?: string;
}

/**
 * R2 core-9 (BO-9): the item lines as printed under a total they split — the savers beyond the five listed as one
 * "Other" line (when they come to a printed dollar), then every line footed to the printed total (core/format.ts
 * footColumn): "$110 + $2 = $112", never "$110 + $3" above "$112". The receipt's data keeps its exact amounts.
 */
export function footedReceiptLines<L extends { label: string; savedM: number; diverted?: true }>(lines: readonly L[], totalM: number): { label: string; savedM: number; diverted?: true }[] {
  const listed: { label: string; savedM: number; diverted?: true }[] = lines.map((l) => (l.diverted ? { label: l.label, savedM: l.savedM, diverted: true as const } : { label: l.label, savedM: l.savedM }));
  const rest = totalM - listed.reduce((s, l) => s + l.savedM, 0);
  if (listed.length >= RECEIPT_MAX_LINES && roundToDollarsM(rest) > 0) listed.push({ label: S.otherLine, savedM: rest });
  const footed = footColumn(
    listed.map((l) => l.savedM),
    totalM,
  );
  // R2 core-10 (IC-4): a line that saved something but foots to $0 prints '< $1' (its exact amount), never "$0".
  return listed.map((l, i) => ({ ...l, savedM: footed[i] === 0 && l.savedM > 0 ? l.savedM : footed[i] }));
}

function renderReceipt(b: ReceiptBody): string {
  const suffix = b.lineSuffix ?? '';
  if (b.footLines) b = { ...b, lines: footedReceiptLines(b.lines, b.savedM) };
  const amounts = [...b.lines.map((l) => `${fmtDollars(l.savedM)}${suffix}`), fmtDollars(b.savedM)];
  const field = Math.max(8, ...amounts.map((a) => a.length + 2));
  const out: string[] = [...spread(b.title, b.rangeLabel)];
  if (b.linesHeader && b.lines.length > 0) out.push(truncate(b.linesHeader, RECEIPT_WIDTH));
  for (const l of b.lines) {
    const amount = `${fmtDollars(l.savedM)}${suffix}`.padStart(field);
    // P1-F04: label + ' ' + at least MIN_LEADER_DOTS dots, so a truncated label never ends in '… ..'.
    const room = RECEIPT_WIDTH - field - 1 - MIN_LEADER_DOTS;
    // P1-F02: a diversion credit says so; the tag survives truncation (the label gives way).
    const tag = l.diverted ? DIVERTED_TAG : '';
    const label = `${truncate(l.label, room - tag.length)}${tag}`;
    const dots = RECEIPT_WIDTH - label.length - 1 - field;
    out.push(`${label} ${'.'.repeat(dots)}${amount}`);
  }
  out.push('-'.repeat(RECEIPT_WIDTH));
  out.push(...spread(b.totalLabel, fmtDollars(b.savedM)));
  out.push(...wrapSegments(b.summary));
  if (b.divertedM !== undefined && b.divertedM > 0) out.push(...wrapSegments(splitSegments(b.savedM, b.divertedM)));
  if (b.net && b.net.length > 0) out.push(...wrapSegments(b.net));
  if (b.trend) out.push(b.trend);
  if (b.note) out.push(...wrapWords(b.note, RECEIPT_WIDTH, ''));
  out.push(...alertLines(b.openAlerts));
  if (b.basis) out.push(...basisBlock(b.basis));
  if (b.link) out.push('', S.openThisWeek, b.link);
  out.push(...receiptSignOff());
  return out.join('\n');
}

/** P1-F02: the tag on an item line whose savings are a diversion credit. */
export const DIVERTED_TAG: string = S.divertedTag;

/**
 * P1-F02: "Saved by reduction $X · by diversion $Y" — measured bytes dropped, then the credit that rests on a price.
 * The two parts add up to the printed total (core/format.ts footMoney): reduction = the printed saved − the printed
 * diversion, so $177,198 never splits into $150,000 + $27,199.
 */
function splitSegments(savedM: number, divertedM: number): string[] {
  const d = Math.min(Math.max(0, divertedM), Math.max(0, savedM));
  const shown = footMoney({ whpM: savedM, paidM: savedM - d, savedM: d });
  return [fill(S.byReduction, { amount: fmtDollars(shown.paidM) }), fill(S.byDiversion, { amount: fmtDollars(shown.savedM) })];
}

/**
 * "Would have paid $X · Paid $Y · 60% saved" — the summary segments every receipt prints. Printed money adds up
 * (core/format.ts footMoney): would have paid − paid = the saved the receipt's total line prints, to the dollar
 * ($452,147 − $274,949 = $177,198, never Paid $274,948 beside it).
 */
function summarySegments(whpM: number, paidM: number, savedM: number, r: number): string[] {
  const shown = footMoney({ whpM, paidM, savedM });
  return [fill(S.wouldHavePaid, { amount: fmtDollars(shown.whpM) }), fill(S.paid, { amount: fmtDollars(shown.paidM) }), fill(S.savedPct, { pct: fmtPct(r) })];
}

function trendLine(trendPct: number | undefined, what: string): string | undefined {
  if (trendPct === undefined) return undefined;
  const sign = trendPct > 0 ? '+' : trendPct < 0 ? '−' : '';
  return fill(S.vs, { what, sign, pct: Math.abs(trendPct) });
}

/**
 * SPEC 12.4 text:
 *   Meter Reader — weekly receipt       Sep 21–27, 2026
 *   Windows event trimming .................  $9,380
 *   ------------------------------------------------
 *   Saved by Cribl, last week              $23,807
 *   Would have paid $39,678 · Paid $15,871 · 60% saved
 *   vs. prior week: +4%
 *   Open alerts: 1 (Savings dropped: Payments API sampling)
 * Every line is at most 48 characters (long ones wrap).
 */
export function receiptText(r: WeeklyReceipt): string {
  return renderReceipt({
    title: S.weeklyTitle,
    rangeLabel: r.label,
    lines: r.lines,
    footLines: true,
    totalLabel: S.savedLastWeek,
    savedM: r.savedM,
    summary: summarySegments(r.whpM, r.paidM, r.savedM, r.ratio),
    ...(r.divertedM !== undefined ? { divertedM: r.divertedM } : {}),
    trend: trendLine(r.trendPct, S.priorWeek),
    ...(r.sentLate ? { note: S.sentLate } : {}),
    openAlerts: r.openIncidents,
    ...(r.basis ? { basis: r.basis } : {}),
    ...(r.link ? { link: r.link } : {}),
  });
}

const PERIOD_CAPTIONS: Record<HeadlinePeriod, string> = S.periods;

/** The Meter caption for a period (SPEC 17): 'month to date' · 'today' · 'last 30 days' · 'annualized run rate'. */
export function periodCaption(period: HeadlinePeriod): string {
  return PERIOD_CAPTIONS[period];
}

function inferPeriod(label: string): HeadlinePeriod {
  const found = (Object.entries(PERIOD_CAPTIONS) as [HeadlinePeriod, string][]).find(([k, v]) => v === label.trim().toLowerCase() || k === label.trim());
  return found ? found[0] : 'mtd';
}

export interface PeriodReceiptOptions {
  /** defaults to the period named by `label` ('month to date' …), else 'mtd' */
  period?: HeadlinePeriod;
  /**
   * per-saver amounts for this exact period (e.g. sumFlowRows over roll/hour rows); omitted → the snapshot's top
   * savers at their current rates, labelled per day (P1-F04)
   */
  lines?: { label: string; savedM: number }[];
  /** display timezone for the date range (defaults to UTC) */
  tz?: string;
  /** a closing caveat printed under the totals (the entitlement line, P1-F11) */
  note?: string;
  /** P0-23: the prices document, so the Basis block says which prices are presets and which were typed in */
  prices?: PricesDoc | null;
  /** settings.humanize overrides (destination labels in the Basis block) */
  labels?: Record<string, string>;
  /**
   * P1-F04: the Cribl cost setting, as the hero reads it: the Net line shows for month to date and the annualized run
   * rate when it is set (> 0), month to date against the cost over the minutes metered this month (D49), so the
   * pasted line is the hero's. Omitted → month to date uses the headline's net when the sweep had one.
   */
  criblCostCentsPerMonth?: number;
}

/** "1.9×" — a payback multiple with one decimal. */
const multiple = (x: number): string => `${(Math.round(x * 10) / 10).toFixed(1)}×`;

/**
 * The Net line's segments for a period, mirroring the hero (month to date; the run rate × 12 months). A caller that
 * passes the cost setting (the Receipt view, even when it is unset) gets exactly the hero's rule: no cost set, no
 * Net line — even when the last sweep's headline still carries a net from before the cost was cleared — and month
 * to date is recomputed at that cost over the minutes metered this month (D49: src/views/Receipt/model.ts
 * netFigures), so the pasted line matches the hero even in the minute after the cost was edited.
 */
function netSegments(snapshot: Snapshot, period: HeadlinePeriod, opts: PeriodReceiptOptions): string[] | undefined {
  const h = snapshot.headline;
  const costCents = opts.criblCostCentsPerMonth;
  const costKnown = Object.prototype.hasOwnProperty.call(opts, 'criblCostCentsPerMonth');
  const costSet = costCents !== undefined && Number.isFinite(costCents) && costCents > 0;
  if (period === 'mtd') {
    let net: { netM: number; paybackX?: number } | null = null;
    if (costKnown) {
      if (costSet) {
        const exact = mtdNetOfCribl(h.mtdM, fromIso(snapshot.sweepAt), opts.tz ?? 'UTC', fromIso(snapshot.collectingSince), costCents);
        // Printed net = printed saved − printed cost (r1 ui-8, m9, D53's footing rule).
        net = exact ? { ...exact, netM: roundToDollarsM(h.mtdM) - roundToDollarsM(exact.costM) } : null;
      }
    } else if (h.netMtdM !== undefined) net = { netM: h.netMtdM, paybackX: h.paybackX };
    if (!net) return undefined;
    return [
      fill(S.netAfterCribl, { amount: fmtDollars(net.netM) }),
      ...(net.paybackX !== undefined && Number.isFinite(net.paybackX) ? [fill(S.paidForItself, { multiple: multiple(net.paybackX) })] : []),
    ];
  }
  if (period === 'annualized' && costSet) {
    const yearCostM = (costCents as number) * 1000 * 12;
    return [
      fill(S.netAfterCriblYear, { amount: fmtDollars(roundToDollarsM(h.annualizedM) - roundToDollarsM(yearCostM)) }),
      fill(S.paidForItself, { multiple: multiple(h.annualizedM / yearCostM) }),
    ];
  }
  return undefined;
}

/**
 * The Receipt view's "Copy receipt" text for the selected period, in the SPEC 12.4 layout, from the snapshot's
 * headline. The snapshot holds per-day RATES, not per-period sums per saver: given no `lines` for the period, the
 * item lines are the top savers at their current rates, headed and suffixed as per-day figures so nobody sums
 * them into the total (P1-F04). Then the Net line (a Cribl cost set) and the Basis block (P0-23): each priced
 * destination's $/GB and where it comes from, the counterfactual credits, the unpriced count and the coverage.
 */
export function receiptTextForPeriod(label: string, snapshot: Snapshot, opts: PeriodReceiptOptions = {}): string {
  const period = opts.period ?? inferPeriod(label);
  const tz = opts.tz ?? 'UTC';
  const h = snapshot.headline;
  const now = fromIso(snapshot.sweepAt);
  const nowMs = Number.isNaN(now) ? 0 : now;
  const caption = label.trim() || periodCaption(period);
  let savedM: number;
  let summary: string[];
  let rangeLabel: string;
  switch (period) {
    case 'today':
      savedM = h.todayM;
      summary = summarySegments(h.whpTodayM, h.paidTodayM, h.todayM, ratio(h.todayM, h.whpTodayM));
      rangeLabel = weekRangeLabel(nowMs, nowMs + 1, tz);
      break;
    case '30d':
      savedM = h.d30M;
      summary = summarySegments(h.whp30dM, h.paid30dM, h.d30M, ratio(h.d30M, h.whp30dM));
      rangeLabel = weekRangeLabel(localDayStartMs(addDaysToKey(localDayKey(nowMs, tz), -29), tz), nowMs + 1, tz);
      break;
    case 'annualized': {
      savedM = h.annualizedM;
      const days = h.annualizedFromDays;
      const basis = days >= 1 ? fill(plural(Math.round(days), S.lastDays), { n: Math.round(days) }) : S.todaySoFar;
      summary = [fill(S.savedPct, { pct: fmtPct(ratio(h.d30M, h.whp30dM)) }), fill(S.annualizedFrom, { basis })];
      // P1-F04: the date the run rate was read, not the literal 'run rate'.
      rangeLabel = fill(S.asOf, { date: weekRangeLabel(nowMs, nowMs + 1, tz) });
      break;
    }
    default:
      savedM = h.mtdM;
      summary = summarySegments(h.whpMtdM, h.paidMtdM, h.mtdM, h.ratioMtd);
      rangeLabel = weekRangeLabel(localMonthStartMs(nowMs, tz), nowMs + 1, tz);
  }
  const rates = opts.lines === undefined;
  const source: ReceiptBody['lines'] = rates
    ? (snapshot.topSavers ?? []).map((t) => (t.diverted ? { label: t.label, savedM: t.savedPerDayM, diverted: true as const } : { label: t.label, savedM: t.savedPerDayM }))
    : (opts.lines ?? []);
  const lines = source
    .filter((l) => l.savedM > 0)
    .sort((a, b) => b.savedM - a.savedM || (a.label < b.label ? -1 : 1))
    .slice(0, RECEIPT_MAX_LINES);
  const net = netSegments(snapshot, period, opts);
  return renderReceipt({
    title: S.periodTitle,
    rangeLabel,
    lines,
    ...(rates ? { linesHeader: S.topSaversRates, lineSuffix: S.perDaySuffix } : {}),
    totalLabel: fill(S.savedFor, { period: caption }),
    savedM,
    summary,
    // P1-F02: month to date has the split exactly (per-destination month totals); the other periods do not.
    ...(period === 'mtd' && h.divertedMtdM !== undefined ? { divertedM: h.divertedMtdM } : {}),
    ...(net ? { net } : {}),
    note: opts.note,
    openAlerts: (snapshot.incidents ?? []).filter((i) => !i.closedAt).map((i) => ({ title: titleFor(i) })),
    ...(snapshot.destinations ? { basis: periodBasis(snapshot, period, nowMs, opts) } : {}),
  });
}

/** P0-23: the Basis block for a headline period, from the snapshot's destinations. */
function periodBasis(snapshot: Snapshot, period: HeadlinePeriod, nowMs: number, opts: PeriodReceiptOptions): ReceiptBasis {
  // Month to date has each destination's own sums; the other periods rank destinations by their current rates.
  const byOutput: Record<string, Money> = {};
  for (const d of snapshot.destinations ?? []) {
    byOutput[`${d.groupId}:${d.outputId}`] =
      period === 'mtd' ? { whpM: d.mtdWhpM, paidM: d.mtdPaidM, savedM: d.mtdSavedM } : { whpM: d.whpPerDayM, paidM: d.paidPerDayM, savedM: d.savedPerDayM };
  }
  const cov = period === 'annualized' ? undefined : periodCoverage(snapshot.headline, period);
  return receiptBasis({
    byOutput,
    destinations: snapshot.destinations,
    ...(opts.prices ? { prices: opts.prices } : {}),
    atMs: nowMs,
    ...(opts.labels ? { labels: opts.labels } : {}),
    exactAmounts: period === 'mtd',
    ...(cov ? { coverage: { unit: 'minutes' as const, metered: cov.metered, expected: cov.expected } } : {}),
  });
}

export interface RangeReceiptOptions {
  /** display timezone for the range's words (defaults to UTC) */
  tz?: string;
  /** Now, for the window's words: a window in another year names its year (OQ-05). */
  nowMs?: number;
  /** settings.humanize overrides, keyed by pipeline (or route) id */
  labels?: Record<string, string>;
  openIncidents?: (Pick<Incident, 'type' | 'label'> & { closedAt?: ISO })[];
  /** a closing caveat printed under the totals (the entitlement line, P1-F11) */
  note?: string;
  /** P0-23: the last snapshot's destinations and the prices document, for the Basis block (omitted → no block) */
  destinations?: readonly DestinationFigures[];
  prices?: PricesDoc | null;
}

/**
 * "Copy receipt" for a custom range (core/range.ts): the same layout as the period receipt, with item lines
 * summed per pipeline from the range's own rows (exact, nothing extrapolated), the window in words, and the
 * rate the window ran at:
 *   Meter Reader — receipt        Sep 26, 10:00 AM–2:00 PM
 *   Payments API sampling ..................  $1,212
 *   ------------------------------------------------
 *   Saved by Cribl, Sep 26, 10:00 AM–2:00 PM  $3,870
 *   Would have paid $6,450 · Paid $2,580 · 60% saved
 *   ≈ $23,220 a day at this rate
 *   Open alerts: none
 */
export function receiptTextForRange(figures: RangeFigures, opts: RangeReceiptOptions = {}): string {
  const tz = opts.tz ?? 'UTC';
  const span = rangeSpanLabel(figures.fromMs, figures.toMs, tz, opts.nowMs);
  const diverted = opts.destinations || opts.prices ? divertedOutputs(opts, Object.keys(figures.byOutput ?? {}), figures.toMs - 1) : new Set<string>();
  const lines = itemLines(figures.byFlow, diverted, opts.labels);
  const divertedM = divertedSum(figures.byFlow, diverted);
  const summary = summarySegments(figures.whpM, figures.paidM, figures.savedM, figures.ratio);
  // The total line names the window when it fits the width beside the amount; the header carries it anyway.
  const longLabel = fill(S.savedFor, { period: span });
  const totalLabel = longLabel.length + 2 + fmtDollars(figures.savedM).length <= RECEIPT_WIDTH ? longLabel : S.saved;
  return renderReceipt({
    title: S.periodTitle,
    rangeLabel: span,
    lines,
    footLines: true,
    totalLabel,
    savedM: figures.savedM,
    summary,
    ...(divertedM > 0 ? { divertedM } : {}),
    trend: figures.ratePerDayM !== undefined ? fill(S.rangeRate, { amount: fmtDollars(figures.ratePerDayM) }) : undefined,
    note: opts.note,
    openAlerts: (opts.openIncidents ?? []).filter((i) => !i.closedAt).map((i) => ({ title: titleFor(i) })),
    ...(opts.destinations ? { basis: rangeBasis(figures, opts) } : {}),
  });
}

/** P0-23: the Basis block for a custom range: its own per-destination sums, and minutes (or whole UTC days) metered. */
function rangeBasis(figures: RangeFigures, opts: RangeReceiptOptions): ReceiptBasis {
  let coverage: ReceiptBasis['coverage'];
  if (figures.minutesMetered !== undefined) coverage = { unit: 'minutes', metered: figures.minutesMetered, expected: figures.expectedMinutes };
  else if (figures.daysMetered !== undefined) coverage = { unit: 'days', metered: figures.daysMetered, expected: Math.max(1, Math.round(figures.expectedMinutes / 1440)) };
  return receiptBasis({
    byOutput: figures.byOutput,
    ...(opts.destinations ? { destinations: opts.destinations } : {}),
    ...(opts.prices ? { prices: opts.prices } : {}),
    atMs: figures.toMs - 1,
    ...(opts.labels ? { labels: opts.labels } : {}),
    exactAmounts: true,
    ...(coverage ? { coverage } : {}),
  });
}

// ─── Entitlement billing (P1-F11) ────────────────────────────────────────────

/**
 * The presets billed as prepaid entitlements (core/presets.ts `billing`) among the destinations that carry money
 * in this snapshot (would-have-paid or paid above $0 per day or month to date), each once, largest would-have-paid
 * first. For those vendors the avoided cost is realized at renewal, when the entitlement is resized, not on the
 * next bill; the Receipt and its text say so under the totals only when this is not empty. A destination priced
 * with no preset (Custom price) names no vendor and is left out.
 */
export function entitlementPresets(
  snapshot: Pick<Snapshot, 'sweepAt' | 'destinations'> | null | undefined,
  prices: PricesDoc | null | undefined,
): PresetId[] {
  const tMs = fromIso(snapshot?.sweepAt ?? '');
  if (!snapshot || !prices || Number.isNaN(tMs)) return [];
  const weight = new Map<PresetId, number>();
  for (const d of snapshot.destinations ?? []) {
    const carries = d.whpPerDayM > 0 || d.paidPerDayM > 0 || d.mtdWhpM > 0 || d.mtdPaidM > 0;
    if (!carries) continue;
    const preset = presetById(priceEntryAt(prices, d.groupId, d.outputId, tMs)?.preset);
    if (!preset || preset.billing !== 'entitlement') continue;
    weight.set(preset.id, (weight.get(preset.id) ?? 0) + Math.max(d.whpPerDayM, d.mtdWhpM, d.paidPerDayM));
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
}

// ─── Compare with… (P2-W13) ──────────────────────────────────────────────────

/** One receipt line of a comparison: a pipeline's saved in both windows and the change. */
export interface ComparisonLine {
  label: string;
  currentM: number;
  baselineM: number;
  deltaM: number;
}

/** Σ saved per receipt line (pipeline, else route) of a range's rows. */
function savedByLine(figures: RangeFigures, labels?: Record<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, m] of Object.entries(figures.byFlow)) {
    const label = lineLabel(key, labels);
    out.set(label, (out.get(label) ?? 0) + m.savedM);
  }
  return out;
}

/**
 * The per-pipeline lines of a comparison, biggest change first: each line's saved in the current and the baseline
 * window on the comparison's basis — sums, or a day at each window's own rate when the windows are compared per
 * day (the same scaling as the total, so the lines and the total never mix bases). Lines that saved nothing in
 * either window are left out; ties sort by the current amount, then the label.
 */
export function comparisonLines(cmp: RangeComparison, labels?: Record<string, string>, max = RECEIPT_MAX_LINES): ComparisonLine[] {
  if (cmp.basis === 'none') return [];
  const onBasis = (f: RangeFigures, m: number): number => (cmp.basis === 'rate' ? (perDayAtRate(f, m) ?? 0) : m);
  const now = savedByLine(cmp.current, labels);
  const before = savedByLine(cmp.baseline, labels);
  const lines: ComparisonLine[] = [];
  for (const label of new Set([...now.keys(), ...before.keys()])) {
    const currentM = onBasis(cmp.current, now.get(label) ?? 0);
    const baselineM = onBasis(cmp.baseline, before.get(label) ?? 0);
    if (currentM <= 0 && baselineM <= 0) continue;
    lines.push({ label, currentM, baselineM, deltaM: currentM - baselineM });
  }
  return lines
    .sort((a, b) => Math.abs(b.deltaM) - Math.abs(a.deltaM) || b.currentM - a.currentM || (a.label < b.label ? -1 : 1))
    .slice(0, Math.max(0, max));
}

/** '+$120' / '−$95' / '$0' — a signed whole-dollar change. */
function signedDollars(mc: number): string {
  const text = fmtDollars(mc);
  return mc > 0 && /[1-9]/.test(text) ? `+${text}` : text;
}

/** '+14%' / '−6%' / '0%' — a signed change ratio. */
function signedPct(ratio: number): string {
  const text = fmtPct(ratio);
  return ratio > 0 && text !== '0%' ? `+${text}` : text;
}

export interface ComparisonReceiptOptions {
  /** display timezone for the windows' words (defaults to UTC) */
  tz?: string;
  /** Now, for the window's words: a window in another year names its year (OQ-05). */
  nowMs?: number;
  labels?: Record<string, string>;
  openIncidents?: (Pick<Incident, 'type' | 'label'> & { closedAt?: ISO })[];
  /** What the baseline is, sentence case: 'Previous period', 'A week earlier', 'Before a1f3c9e'. */
  baselineName: string;
  /** What the current window is, sentence case: 'This range' (default), 'After a1f3c9e'. */
  currentName?: string;
}

/**
 * "Copy receipt" for a comparison: both windows with their words, the per-pipeline lines with a change column,
 * both totals, the signed change (a percentage of the baseline), both money summaries and the basis:
 *   Meter Reader — receipt comparison
 *   This range       Sep 19, 2:00 PM–Sep 26, 2:00 PM
 *   Previous period  Sep 12, 2:00 PM–Sep 19, 2:00 PM
 *   Windows event trimming ..........  $1,340  +$120
 *   Payments API sampling ...........  $1,212   −$95
 *   ------------------------------------------------
 *   Saved by Cribl, this range                $2,602
 *   Saved by Cribl, previous period           $2,577
 *   Change                                +$25 (+1%)
 *   This range: would have paid $5,204
 *     paid $2,602 · 50% saved
 *   Previous period: would have paid $5,154
 *     paid $2,577 · 50% saved
 *   Open alerts: none
 * On a per-day basis the lines, totals and change are a day at each window's rate, and two lines say so.
 */
export function receiptTextForComparison(cmp: RangeComparison, opts: ComparisonReceiptOptions): string {
  const tz = opts.tz ?? 'UTC';
  const currentName = opts.currentName ?? S.thisRange;
  const baselineName = opts.baselineName;
  const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
  const perDay = cmp.basis === 'rate';
  const unit = perDay ? S.aDaySuffix : '';
  const out: string[] = [S.comparisonTitle];
  // Each window's name and words: one aligned line each when both fit, else both as name, then indented words.
  const windows: [string, string][] = [
    [currentName, rangeSpanLabel(cmp.current.fromMs, cmp.current.toMs, tz, opts.nowMs)],
    [baselineName, rangeSpanLabel(cmp.baseline.fromMs, cmp.baseline.toMs, tz, opts.nowMs)],
  ];
  const nameWidth = Math.max(currentName.length, baselineName.length) + 2;
  if (windows.every(([, span]) => nameWidth + span.length <= RECEIPT_WIDTH)) for (const [name, span] of windows) out.push(`${name.padEnd(nameWidth)}${span}`);
  else for (const [name, span] of windows) out.push(truncate(name, RECEIPT_WIDTH), truncate(`  ${span}`, RECEIPT_WIDTH));
  // The windows differ in length or in how much of them was metered: their sums are not like for like.
  if (perDay) out.push(S.comparedPerDay, S.comparedPerDayWhy);

  const lines = comparisonLines(cmp, opts.labels);
  if (lines.length > 0) {
    const amountField = Math.max(8, ...lines.map((l) => fmtDollars(l.currentM).length + 2));
    const deltaField = Math.max(7, ...lines.map((l) => signedDollars(l.deltaM).length + 2));
    for (const l of lines) {
      const amount = fmtDollars(l.currentM).padStart(amountField);
      const delta = signedDollars(l.deltaM).padStart(deltaField);
      const room = RECEIPT_WIDTH - amountField - deltaField - 1 - 2;
      const label = truncate(l.label, room);
      const dots = RECEIPT_WIDTH - label.length - 1 - amountField - deltaField;
      out.push(`${label} ${'.'.repeat(dots)}${amount}${delta}`);
    }
  }
  out.push('-'.repeat(RECEIPT_WIDTH));
  if (cmp.basis === 'none') {
    // Nothing was metered in the baseline: its figures are unknown, so it prints as not metered, never $0.
    out.push(...spread(fill(S.savedFor, { period: lower(currentName) }), fmtDollars(cmp.current.savedM)));
    out.push(...spread(fill(S.savedFor, { period: lower(baselineName) }), S.notMetered));
    out.push(S.nothingToCompare);
  } else {
    out.push(...spread(fill(S.savedFor, { period: lower(currentName) }), `${fmtDollars(cmp.currentM)}${unit}`));
    out.push(...spread(fill(S.savedFor, { period: lower(baselineName) }), `${fmtDollars(cmp.baselineM)}${unit}`));
    const pct = cmp.pct !== undefined ? ` (${signedPct(cmp.pct)})` : '';
    // The change foots with the two figures above it, as printed (r1 ui-8, m11).
    out.push(...spread(S.change, `${signedDollars(printedDeltaM(cmp))}${unit}${pct}`));
  }
  // Each window's money on two lines, the second indented under its name, the same shape for both windows.
  // Printed money adds up: each window's would have paid − paid = its saved, to the dollar (core/format.ts footMoney).
  const summary = (name: string, f: RangeFigures): string[] => {
    const shown = footMoney({ whpM: f.whpM, paidM: f.paidM, savedM: f.savedM });
    return [
      truncate(fill(S.windowWouldHavePaid, { name, amount: fmtDollars(shown.whpM) }), RECEIPT_WIDTH),
      truncate(fill(S.windowPaid, { amount: fmtDollars(shown.paidM), pct: fmtPct(f.ratio) }), RECEIPT_WIDTH),
    ];
  };
  out.push(...summary(currentName, cmp.current), ...(cmp.basis === 'none' ? [] : summary(baselineName, cmp.baseline)));
  out.push(...alertLines((opts.openIncidents ?? []).filter((i) => !i.closedAt).map((i) => ({ title: titleFor(i) }))));
  out.push(...receiptSignOff());
  return out.join('\n');
}
