// core/report.ts — the report card (a savings summary an admin or a sales engineer hands to leadership):
// the model every rendering reads — the PDF (core/report-pdf.ts), the HTML file (core/report-html.ts), the
// email paste (core/report-email.ts) and the spreadsheet (core/report-csv.ts). Pure: no I/O, no DOM.
//
// Figures, and how each one relates to the Receipt (src/views/Receipt/model.ts; tests/unit/report.test.ts holds
// them equal to the millicent for the same period):
//   • Saved / would have paid / paid for the period: the snapshot's headline (month to date, today, the last
//     30 days) or a custom range's RangeFigures (core/range.ts, Σ of the rollup rows in the window).
//   • Annual run rate: headline.annualizedM (Σ saved ÷ Σ metered minutes × 525,600 over the last 30 days).
//   • Net after Cribl and the payback multiple: month to date exactly as the Receipt (the cost prorated to the
//     minutes metered this month, core/net.ts), and the run rate against twelve months of the cost (the
//     Receipt's annualized net). Other periods show the run-rate figures only.
//   • Volume, top savers and destinations: per day at the last hour's rate (the snapshot's last hour × 24), the
//     same basis as the Receipt's cards, and labelled so on the page; nothing on the card annualizes them — the
//     run rate is the one annual figure. Nothing holds per-period bytes, so volume is never summed over a period.
//   • Printed money foots: would have paid, paid and saved carry a `shown` copy rounded with core/format.ts
//     footMoney, so a printed row (and the hero) adds up to the dollar; totals are the sums of the printed rows.
//   • Protection: the snapshot's incidents (open, plus closed in the last 24 hours), regressions and spikes
//     opened in the period; the card says when that history is shorter than the period. A recovered alert says
//     how long it lasted; only an open one carries an annual figure ("if left").
//
// Every word comes from `input.copy` (src/copy/en.ts `report.doc`): core never imports the UI, so the caller
// passes the strings in and the card carries them to the renderers. Money stays integer millicents here and is
// formatted only with core/format.ts; ids become words only through core/humanize.ts.

import type {
  Attribution,
  Build,
  Counterfactual,
  DestinationFigures,
  Incident,
  PresetId,
  PricesDoc,
  Settings,
  Snapshot,
} from './types.ts';
import { MC_PER_DOLLAR, footMoney, fmtBytes, fmtDollars, fmtDollarsCents, fmtDollarsCompact, fmtDurationShort, fmtPct, fmtPriceShown, perYear, type MoneyTriple } from './format.ts';
import { displayAuthor, humanize } from './humanize.ts';
import { incidentReadings } from './incidents.ts';
import { meteredSpan, netOfCribl } from './net.ts';
import { effectivePrices, priceEntryAt, ratio } from './pricing.ts';
import { PRESET_NOTES, presetById } from './presets.ts';
import { rangeSpanLabel, type RangeFigures } from './range.ts';
import { CREDIT_STRINGS } from './strings.ts';
import { addDaysToKey, fromIso, localDayKey, localDayStartMs, localMonthStartMs, toIso, weekRangeLabel } from './time.ts';

// ─── The words (src/copy/en.ts `report.doc` satisfies this shape) ────────────

export interface PluralText {
  one: string;
  other: string;
}

/** Every string a report rendering shows. Placeholders are `{name}`; plurals are `{ one, other }` pairs. */
export interface ReportCopy {
  brand: string;
  title: string;
  preparedFor: string;
  preparedBy: string;
  generated: string;
  asOf: string;
  sampleBanner: string;
  sampleWatermark: string;
  noteLabel: string;
  period: { mtd: string; today: string; '30d': string; range: string };
  periodCaption: { mtd: string; today: string; '30d': string };
  collectingSince: string;
  heroLabel: string;
  heroWhp: string;
  heroPaid: string;
  heroDollarPct: string;
  /** The line under the hero that says what the prices are. */
  heroBasis: { list: PluralText; mixed: PluralText; custom: string };
  legend: { paid: string; saved: string; whp: string };
  kpi: {
    runRate: string;
    runRateUnit: string;
    runRateMonthly: string;
    runRateFrom: PluralText;
    runRateToday: string;
    roi: string;
    roiValue: string;
    roiEvery: string;
    roiPct: string;
    netPeriod: string;
    netRunRate: string;
    roiUnset: string;
    roiUnsetHint: string;
    volume: string;
    volumeUnit: string;
    volumeFlow: string;
    volumeBasis: string;
    volumeNone: string;
    protection: string;
    protectionValue: PluralText;
    protectionUnit: PluralText;
    protectionNone: string;
    protectionWindow: string;
    protectionAtRisk: string;
    protectionRecovered: string;
    protectionCaught: string;
    protectionQuiet: string;
  };
  trend: { title: string; empty: string; oneDay: string; soFar: string; peak: string; aria: PluralText };
  top: { title: string; caption: PluralText; captionOf: string; none: string };
  destinations: { title: string; caption: string; unpricedNote: PluralText; none: string; total: string; planWith: string; gap: PluralText };
  protection: { title: string; captionPeriod: string; captionLast24h: string; summaryOpen: string; summaryRecovered: string; fastest: string; none: string };
  cols: {
    whatItDoes: string;
    flow: string;
    volumeReduced: string;
    savedPerDay: string;
    destination: string;
    pricedAs: string;
    pricePerGb: string;
    gbPerDay: string;
    whp: string;
    paid: string;
    saved: string;
    caught: string;
    range: string;
    basis: string;
    source: string;
  };
  flowMore: string;
  flowArrow: string;
  gbPerDayValue: string;
  unpriced: string;
  /** A preset's destination at a rate an admin entered: 'Datadog Logs, your rate'. */
  pricedAsYourRate: string;
  /** A rate an admin entered with no preset. */
  yourRate: string;
  counterfactualOther: string;
  counterfactualOtherUnpriced: string;
  counterfactualNone: string;
  alert: { regression: string; spike: string };
  measure: {
    ratio: string;
    ratioRecovered: string;
    recoveredOnly: string;
    spike: string;
    spikeRecovered: string;
    spikeBackTo: string;
  };
  impact: { open: string; closed: string; closedNoDuration: string };
  commit: string;
  noCommit: string;
  status: { open: string; recovered: string };
  methodology: {
    title: string;
    period: { mtd: string; today: string; '30d': string; range: string };
    runRate: string;
    pricesTitle: string;
    pricesCaption: string;
    confidence: { published: string; reported: string; estimate: string };
    customBasis: string;
    /** A price with no entry to read its origin from (the prices document isn't loaded). */
    meteredBasis: string;
    counterfactual: string;
    counterfactualOthers: string;
    counterfactualOtherItem: string;
    bytes: { reconciled: string; route: string; pipeline: string; proportional: string; 'route-only': string };
    notCounted: string;
    criblCost: string;
    criblCostUnset: string;
    currentRates: string;
  };
  about: {
    title: string;
    workspace: string;
    workspaceUnknown: string;
    groups: string;
    collectingSince: string;
    asOf: string;
    generated: string;
    meteredBy: string;
    version: string;
    data: string;
    dataLive: string;
    dataSample: string;
    versionValue: string;
    versionDemo: string;
  };
  meteredBy: { runner: string; runnerHost: string; tab: string; backend: string; unknown: string };
  /** A price source's publisher by web host (matched on the host or a parent domain). */
  sourceNames: readonly { host: string; name: string }[];
  footer: string;
  footerNoWorkspace: string;
  /** The builder's signature under the footer: 'Made with Meter Reader, built by {name}'. */
  credit: string;
  page: string;
  csv: {
    record: { flow: string; destination: string };
    headers: readonly string[];
  };
  text: { topSavers: string; destinations: string; protection: string };
}

/** `{name}` placeholders → values; a placeholder without a value stays visible (as src/copy/en.ts does). */
export function fill(template: string, vars: Readonly<Record<string, string | number>> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (vars[name] === undefined ? whole : String(vars[name])));
}

/** `one` when n === 1, else `other`, with `{n}` bound. */
export function plural(forms: PluralText, n: number, vars: Readonly<Record<string, string | number>> = {}): string {
  return fill(n === 1 ? forms.one : forms.other, { n, ...vars });
}

// ─── Input ───────────────────────────────────────────────────────────────────

export type ReportPeriodKey = 'mtd' | 'today' | '30d';
export type ReportPeriod = { kind: ReportPeriodKey } | { kind: 'range'; figures: RangeFigures; caption?: string };

export interface ReportInput {
  snapshot: Snapshot;
  prices: PricesDoc | null;
  settings: Pick<Settings, 'criblCostCentsPerMonth' | 'criblCostEstimate' | 'humanize'>;
  period: ReportPeriod;
  /** When the report is generated (epoch ms). */
  nowMs: number;
  /** Display timezone (IANA). */
  tz: string;
  copy: ReportCopy;
  source: 'live' | 'sample';
  /** 'v1.0.0' */
  appVersion: string;
  build?: Build;
  /** The viewer's name (getCriblUser): "Prepared by". */
  viewer?: string;
  /** The Cribl.Cloud workspace (organization) label. */
  workspace?: string;
  /** Worker group ids; default: the groups the snapshot's flows run in. */
  groups?: string[];
  /** meta.lastSweepOwner: who metered the figures. */
  lastSweepOwner?: string;
  preparedFor?: string;
  note?: string;
}

// ─── The card ────────────────────────────────────────────────────────────────

export interface ReportSaver {
  key: string;
  /** What the pipeline does (the Receipt's top-saver label). */
  label: string;
  /** Source(s) → destination(s), in words. */
  flow: string;
  savedPerDayM: number;
  /** Share of the dollars saved (saved ÷ would have paid). */
  dollarRatio: number;
  /** Share of the bytes removed (1 − out ÷ in); undefined with no bytes in. */
  volumeRatio?: number;
}

export interface ReportDestination {
  key: string;
  groupId: string;
  outputId: string;
  label: string;
  type: string;
  /** 'Splunk Cloud' (the preset at its typical price), 'Datadog Logs, your rate', 'Your rate', the type in words, or 'No price set'. */
  pricedAs: string;
  presetId?: PresetId;
  /** The price in force (mc/GB) and whether it is the preset's typical value. */
  mcPerGb: number;
  /** The price would have paid uses (the counterfactual destination's for 'other'); undefined when unknown. */
  whpMcPerGb?: number;
  isPresetPrice: boolean;
  /** The prices document holds an entry for this destination (false when it isn't loaded). */
  hasPriceEntry: boolean;
  counterfactual: Counterfactual;
  /** 'Without Cribl it would go to Splunk Cloud at $2.25/GB' / '… nowhere: not counted'. */
  counterfactualNote?: string;
  inBPerDay: number;
  outBPerDay: number;
  whpPerDayM: number;
  paidPerDayM: number;
  savedPerDayM: number;
  /** The three amounts as printed (whole dollars that add up; core/format.ts footMoney). */
  shown: MoneyTriple;
  unpriced: boolean;
}

export interface ReportIncident {
  id: string;
  type: 'regression' | 'spike';
  title: string;
  openedAtMs: number;
  /** "75% → 50% of dollars saved" / "$152 → $210 an hour" (and the recovery, when closed). */
  measure: string;
  impactPerDayM: number;
  /** Open: "$250 a day above normal until fixed (about $91.3k a year if left)"; recovered: how long it lasted. */
  impactText: string;
  /** Alert to recovery, for a recovered alert. */
  durationSec?: number;
  caughtInSec?: number;
  /** '2 min', '1 min 35 s' (never a clock time). */
  caughtText?: string;
  commit?: { hash: string; message: string; author: string };
  causeText: string;
  status: 'open' | 'recovered';
  statusText: string;
}

export interface ReportCard {
  copy: ReportCopy;
  sample: boolean;
  /** The file name without extension: meter-reader-report-<workspace>-<period>-<yyyy-mm-dd>. */
  fileBase: string;
  title: string;
  /** The workspace the figures come from, when Cribl reported one. */
  workspace?: string;
  generatedAtMs: number;
  preparedFor?: string;
  preparedBy?: string;
  note?: string;
  /** "Prepared for … · Prepared by … · Generated …" parts, in order. */
  byline: string[];
  period: {
    kind: ReportPeriodKey | 'range';
    /** 'Month to date' */
    title: string;
    /** 'month to date' (inside sentences) */
    words: string;
    /** 'Sep 1–26, 2026' */
    span: string;
    /** 'collecting since Sep 24' / a range's exactness */
    caption?: string;
    slug: string;
    fromMs: number;
    toMs: number;
  };
  headline: {
    savedM: number;
    whpM: number;
    paidM: number;
    /** The three as printed: whole dollars that add up. */
    shown: MoneyTriple;
    /** saved ÷ would have paid — the DOLLAR basis */
    dollarRatio: number;
    label: string;
    subline: string[];
    /** What the prices are: 'At typical list prices for 8 destinations, not contract rates (see Prices used).' */
    basis?: string;
  };
  volume: {
    inBPerDay: number;
    outBPerDay: number;
    /** 1 − out ÷ in — the VOLUME basis; undefined with no bytes */
    ratio?: number;
  };
  runRate: { annualM: number; monthlyM: number; fromDays: number; basis: string };
  cribl?: {
    costPerMonthM: number;
    /** The cost is Cribl's list price × the measured ingest ("Use this estimate"), not a contract figure. */
    estimate?: true;
    /** Month to date only: the Receipt's net and payback. */
    period?: { costM: number; netM: number; paybackX?: number };
    runRate: { costM: number; netM: number; paybackX?: number; monthlyNetM: number };
  };
  /** The four tiles under the hero: a big value, an optional unit beside it (secondary text), then basis lines. */
  kpis: { label: string; value: string; unit?: string; lines: string[]; tone: 'saved' | 'neutral' | 'muted' }[];
  topSavers: { rows: ReportSaver[]; shown: number; total: number; caption: string };
  destinations: {
    rows: ReportDestination[];
    /** Column sums of the printed amounts of the priced rows. */
    totals: MoneyTriple;
    unpricedLabels: string[];
    caption: string;
    unpricedNote?: string;
    /** Under the totals: these are the last hour's rate; plan with the run rate. */
    planNote: string;
    /**
     * When would have paid − paid is less than saved (a destination that is paid for but saves nothing: one that
     * would get no data without Cribl, or one that costs more with it), the sentence that says by how much and why.
     */
    gapNote?: string;
  };
  /** How many priced destinations use a preset's typical list price, and how many a rate an admin entered. */
  priceMix: { list: number; custom: number };
  protection: {
    rows: ReportIncident[];
    count: number;
    openCount: number;
    /** Σ per-day impact of the alerts still open. */
    atRiskPerDayM: number;
    /** Σ per-day impact of every alert listed. */
    totalPerDayM: number;
    fastestSec?: number;
    medianSec?: number;
    coverage: 'period' | 'last24h';
    caption: string;
    summary: string;
  };
  /** `empty` says why there is no chart: fewer than two days in the period (one-day period, or a new install). */
  trend: { title: string; points: { day: string; savedM: number }[]; empty?: string };
  flows: ReportFlowRow[];
  /** Every price behind the figures, once: the preset's typical price with its range, basis and source, or the admin's rate. */
  prices: ReportPriceRow[];
  methodology: string[];
  about: { label: string; value: string }[];
  footer: string;
  /** 'Made with Meter Reader, built by Steve Koelpin': on every page of the PDF, the HTML and the email. */
  credit: string;
  /** The name inside `credit`, which the PDF and the HTML set in bold. */
  builder: string;
}

export interface ReportPriceRow {
  key: string;
  /** The preset's label, or the destination's 'priced as' for a rate an admin entered. */
  label: string;
  mcPerGb: number;
  /** 'Typical range' in words ('$1.47–$4.85'), presets only. */
  range?: string;
  /** How firm the figure is (presets), or 'Entered by an admin for <destination>'. */
  basis: string;
  /** The first source's publisher ('UK G-Cloud filing'), else its host (presets only). */
  source?: string;
  sourceUrl?: string;
  custom: boolean;
}

/** Every flow at the last hour's rate (the CSV), with the prices of the destination it reaches. */
export interface ReportFlowRow {
  key: string;
  groupId: string;
  source: string;
  route: string;
  pipeline: string;
  destination: string;
  /** The destination's 'priced as', its paid price and the price would have paid uses (mc/GB). */
  pricedAs?: string;
  paidMcPerGb?: number;
  whpMcPerGb?: number;
  unpriced: boolean;
  inBPerDay: number;
  outBPerDay: number;
  volumeRatio?: number;
  whpPerDayM: number;
  paidPerDayM: number;
  savedPerDayM: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MAX_TOP = 5;
const DAY_MS = 86_400_000;
const LAST_24H_MS = DAY_MS;

function finite(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** 1 − out ÷ in, clamped to [0, 1]; undefined with nothing in. */
export function volumeReduction(inB: number, outB: number): number | undefined {
  if (!(inB > 0)) return undefined;
  return Math.min(1, Math.max(0, 1 - outB / inB));
}

/** '2.7' — a payback multiple with one decimal, grouped when large ('192,600.7', OQ-13). */
export function fmtMultiple(x: number): string {
  return (Math.round(x * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** 'CDT' / 'GMT+2' for `tz` at `ms`; '' when Intl can't name it. */
function tzAbbrev(ms: number, tz: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

/** 'Sep 26, 2026, 4:12 PM CDT' */
export function formatStamp(ms: number, tz: string): string {
  let text: string;
  try {
    text = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));
  } catch {
    text = toIso(ms);
  }
  const abbrev = tzAbbrev(ms, tz);
  return `${text.replace(/[\u202f\u00a0\u2009]/g, ' ')}${abbrev ? ` ${abbrev}` : ''}`;
}

/** '2026-09-26 21:12 UTC' */
export function formatUtcStamp(ms: number): string {
  const iso = toIso(ms);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** 'Sep 24, 2026' */
function formatDay(ms: number, tz: string): string {
  return weekRangeLabel(ms, ms + 1, tz);
}

/** Lower-case letters, digits and single dashes: 'Acme Corp (prod)' → 'acme-corp-prod'. */
export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 'Palo Alto firewall east + 1 more' */
function listWords(labels: string[], copy: ReportCopy): string {
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return fill(copy.flowMore, { first: labels[0], n: labels.length - 1 });
}

/** Who metered the figures, from meta.lastSweepOwner (`runner:<host>:<pid>`, `ui:<id>`, `backend:<id>`). */
export function meteredByWords(owner: string | undefined, copy: ReportCopy): string {
  if (typeof owner !== 'string' || owner === '') return copy.meteredBy.unknown;
  if (owner.startsWith('runner:')) {
    const parts = owner.slice('runner:'.length).split(':');
    const host = parts.length >= 2 ? parts.slice(0, -1).join(':').trim() : /^\d+$/.test(parts[0] ?? '') ? '' : (parts[0] ?? '').trim();
    return host ? fill(copy.meteredBy.runnerHost, { host }) : copy.meteredBy.runner;
  }
  if (owner.startsWith('ui:')) return copy.meteredBy.tab;
  if (owner.startsWith('backend:')) return copy.meteredBy.backend;
  return copy.meteredBy.unknown;
}

// ─── Period ──────────────────────────────────────────────────────────────────

interface PeriodFiguresLite {
  savedM: number;
  whpM: number;
  paidM: number;
  ratio: number;
}

/** Saved / would have paid / paid for a period: the same fields the Receipt's periodFigures reads. */
export function reportPeriodFigures(snapshot: Snapshot, period: ReportPeriod): PeriodFiguresLite {
  const h = snapshot.headline;
  switch (period.kind) {
    case 'today':
      return { savedM: h.todayM, whpM: h.whpTodayM, paidM: h.paidTodayM, ratio: ratio(h.todayM, h.whpTodayM) };
    case '30d':
      return { savedM: h.d30M, whpM: h.whp30dM, paidM: h.paid30dM, ratio: ratio(h.d30M, h.whp30dM) };
    case 'range':
      return { savedM: period.figures.savedM, whpM: period.figures.whpM, paidM: period.figures.paidM, ratio: period.figures.ratio };
    default:
      return { savedM: h.mtdM, whpM: h.whpMtdM, paidM: h.paidMtdM, ratio: h.ratioMtd };
  }
}

function periodWindow(period: ReportPeriod, sweepMs: number, tz: string): { fromMs: number; toMs: number } {
  switch (period.kind) {
    case 'range':
      return { fromMs: period.figures.fromMs, toMs: period.figures.toMs };
    case 'today':
      return { fromMs: localDayStartMs(localDayKey(sweepMs, tz), tz), toMs: sweepMs };
    case '30d':
      return { fromMs: localDayStartMs(addDaysToKey(localDayKey(sweepMs, tz), -29), tz), toMs: sweepMs };
    default:
      return { fromMs: localMonthStartMs(sweepMs, tz), toMs: sweepMs };
  }
}

function periodSlug(period: ReportPeriod, tz: string): string {
  if (period.kind !== 'range') return period.kind;
  // In the display timezone, as the document's title prints the window (OQ-15: the name was UTC, the title local).
  const compact = (ms: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(ms)
        .map((p) => [p.type, p.value]),
    );
    return Number.isFinite(ms) ? `${parts.year}${parts.month}${parts.day}t${parts.hour}${parts.minute}` : toIso(ms).slice(0, 16).replace(/[-:]/g, '').toLowerCase();
  };
  return `range-${compact(period.figures.fromMs)}-${compact(period.figures.toMs)}`;
}

// ─── Destinations (the Receipt's destinationRows + moneyDestinations, per day at the last hour's rate) ─────

/** Every destination the snapshot knows (`all`, for the CSV's flow rows) and the ones that carry money (`rows`). */
function destinationRowsFor(
  snapshot: Snapshot,
  prices: PricesDoc | null,
  labels: Record<string, string> | undefined,
  copy: ReportCopy,
): { rows: ReportDestination[]; all: Map<string, ReportDestination> } {
  const sweepMs = fromIso(snapshot.sweepAt);
  const byOutput = new Map<string, DestinationFigures>();
  for (const d of snapshot.destinations ?? []) byOutput.set(`${d.groupId}:${d.outputId}`, d);
  const bytes = new Map<string, { inB: number; outB: number }>();
  for (const f of snapshot.flows ?? []) {
    const k = `${f.groupId}:${f.outputId}`;
    const acc = bytes.get(k) ?? { inB: 0, outB: 0 };
    acc.inB += finite(f.inBPerDay);
    acc.outB += finite(f.outBPerDay);
    bytes.set(k, acc);
  }
  const all = new Map<string, ReportDestination>();
  for (const [key, d] of byOutput) {
    const eff = prices && Number.isFinite(sweepMs) ? effectivePrices(prices, d.groupId, d.outputId, sweepMs, d.type) : undefined;
    const counterfactual = eff?.counterfactual ?? d.counterfactual ?? { kind: 'same' };
    const entry = prices && Number.isFinite(sweepMs) ? priceEntryAt(prices, d.groupId, d.outputId, sweepMs) : undefined;
    const preset = presetById(entry?.preset);
    const mcPerGb = eff?.paidMcPerGb ?? d.milliCentsPerGb;
    const isPresetPrice = preset !== undefined && preset.milliCentsPerGb === mcPerGb;
    const whpMcPerGb = eff ? eff.whpMcPerGb : counterfactual.kind === 'same' ? mcPerGb : undefined;
    let pricedAs: string;
    if (d.unpriced) pricedAs = copy.unpriced;
    else if (preset && isPresetPrice) pricedAs = preset.label;
    else if (preset) pricedAs = fill(copy.pricedAsYourRate, { preset: preset.label });
    else if (entry) pricedAs = copy.yourRate;
    else pricedAs = humanize(d.type);
    const b = bytes.get(key) ?? { inB: 0, outB: 0 };
    let counterfactualNote: string | undefined;
    if (counterfactual.kind === 'other') {
      const destination = humanize(counterfactual.outputId, labels);
      counterfactualNote =
        whpMcPerGb !== undefined && whpMcPerGb > 0
          ? fill(copy.counterfactualOther, { destination, price: fmtPricePerGb(whpMcPerGb) })
          : fill(copy.counterfactualOtherUnpriced, { destination });
    } else if (counterfactual.kind === 'none') counterfactualNote = copy.counterfactualNone;
    const money = { whpM: finite(d.whpPerDayM), paidM: finite(d.paidPerDayM), savedM: finite(d.savedPerDayM) };
    all.set(key, {
      key,
      groupId: d.groupId,
      outputId: d.outputId,
      label: humanize(d.outputId, labels),
      type: d.type,
      pricedAs,
      ...(preset ? { presetId: preset.id } : {}),
      mcPerGb,
      ...(whpMcPerGb !== undefined ? { whpMcPerGb } : {}),
      isPresetPrice,
      hasPriceEntry: entry !== undefined,
      counterfactual,
      ...(counterfactualNote ? { counterfactualNote } : {}),
      inBPerDay: b.inB,
      outBPerDay: b.outB,
      whpPerDayM: money.whpM,
      paidPerDayM: money.paidM,
      savedPerDayM: money.savedM,
      shown: footMoney(money),
      unpriced: d.unpriced,
    });
  }
  const rows = [...all.values()]
    .filter((r) => r.unpriced || r.whpPerDayM > 0 || r.paidPerDayM > 0)
    .sort(
      (a, b) =>
        Number(a.unpriced) - Number(b.unpriced) ||
        b.whpPerDayM - a.whpPerDayM ||
        b.paidPerDayM - a.paidPerDayM ||
        (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
    );
  return { rows, all };
}

/**
 * Why the totals' would have paid − paid falls short of their saved: the priced rows whose printed amounts don't
 * add up (paid for, but saving nothing), named, with the gap. Undefined when the totals add up.
 */
function destinationGap(rows: ReportDestination[], totals: MoneyTriple, copy: ReportCopy): string | undefined {
  const gapM = totals.savedM - (totals.whpM - totals.paidM);
  if (gapM <= 0) return undefined;
  const names = rows.filter((r) => !r.unpriced && r.shown.whpM - r.shown.paidM !== r.shown.savedM).map((r) => r.label);
  if (names.length === 0) return undefined;
  return plural(copy.destinations.gap, names.length, { amount: fmtDollars(gapM), names: names.join(', ') });
}

/** Column sums of the printed amounts of the priced rows (so the totals row adds up on the page). */
function destinationTotals(rows: ReportDestination[]): MoneyTriple {
  const t = { whpM: 0, paidM: 0, savedM: 0 };
  for (const r of rows) {
    if (r.unpriced) continue;
    t.whpM += r.shown.whpM;
    t.paidM += r.shown.paidM;
    t.savedM += r.shown.savedM;
  }
  return t;
}

// ─── Top savers ──────────────────────────────────────────────────────────────

function topSaversFor(snapshot: Snapshot, labels: Record<string, string> | undefined, copy: ReportCopy): { rows: ReportSaver[]; total: number } {
  const byRoute = new Map<string, { inB: number; outB: number; saved: number; inputs: Map<string, number>; outputs: Map<string, number> }>();
  for (const f of snapshot.flows ?? []) {
    if (f.routeId === '-') continue;
    const k = `route:${f.groupId}:${f.routeId}`;
    const acc = byRoute.get(k) ?? { inB: 0, outB: 0, saved: 0, inputs: new Map(), outputs: new Map() };
    acc.inB += finite(f.inBPerDay);
    acc.outB += finite(f.outBPerDay);
    acc.saved += finite(f.savedPerDayM);
    if (f.inputId !== '-') acc.inputs.set(f.inputId, (acc.inputs.get(f.inputId) ?? 0) + finite(f.inBPerDay));
    if (f.outputId !== '-') acc.outputs.set(f.outputId, (acc.outputs.get(f.outputId) ?? 0) + finite(f.outBPerDay));
    byRoute.set(k, acc);
  }
  const total = [...byRoute.values()].filter((r) => r.saved > 0).length;
  const ranked = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => humanize(id, labels));
  const rows = (snapshot.topSavers ?? [])
    .filter((s) => s.savedPerDayM > 0)
    .slice(0, MAX_TOP)
    .map((s): ReportSaver => {
      const r = byRoute.get(s.objectKey);
      const sources = r ? listWords(ranked(r.inputs), copy) : '';
      const destinations = r ? listWords(ranked(r.outputs), copy) : '';
      const flow = sources && destinations ? fill(copy.flowArrow, { from: sources, to: destinations }) : sources || destinations;
      const volumeRatio = r ? volumeReduction(r.inB, r.outB) : undefined;
      return {
        key: s.objectKey,
        label: s.label,
        flow,
        savedPerDayM: s.savedPerDayM,
        dollarRatio: s.ratio,
        ...(volumeRatio !== undefined ? { volumeRatio } : {}),
      };
    });
  return { rows, total: Math.max(total, rows.length) };
}

// ─── Protection ──────────────────────────────────────────────────────────────

/**
 * What moved, read through core/incidents.ts incidentReadings() (D47), the one place display reads an
 * incident's figures: open, the drop; closed, the drop and the reading at close (`recoveredTo`). An incident
 * closed before D47 back on the recovered side kept no drop, so only its close shows; one closed on the wrong
 * side (a demo reset, a below-floor close) keeps its drop and has no recovery reading.
 */
function incidentMeasure(i: Incident & { type: 'regression' | 'spike' }, copy: ReportCopy): string {
  const r = incidentReadings(i);
  const spike = i.type === 'spike';
  const fmt = spike ? fmtDollars : fmtPct;
  const before = fmt(r.before);
  if (r.after === undefined) {
    // Closed before D47: `after` held the reading at close, which the helper returns as `recoveredTo`.
    const recovered = fmt(r.recoveredTo ?? i.after);
    return spike ? fill(copy.measure.spikeBackTo, { recovered }) : fill(copy.measure.recoveredOnly, { before, recovered });
  }
  const after = fmt(r.after);
  if (r.recoveredTo === undefined) return fill(spike ? copy.measure.spike : copy.measure.ratio, { before, after });
  return fill(spike ? copy.measure.spikeRecovered : copy.measure.ratioRecovered, { before, after, recovered: fmt(r.recoveredTo) });
}

function protectionFor(
  snapshot: Snapshot,
  window: { fromMs: number; toMs: number },
  copy: ReportCopy,
  periodWords: string,
): ReportCard['protection'] {
  const sweepMs = fromIso(snapshot.sweepAt);
  const inPeriod = (snapshot.incidents ?? []).filter((i): i is Incident & { type: 'regression' | 'spike' } => {
    if (i.type !== 'regression' && i.type !== 'spike') return false;
    const t = fromIso(i.openedAt);
    return Number.isFinite(t) && t >= window.fromMs && t <= window.toMs;
  });
  const rows = inPeriod
    .map((i): ReportIncident => {
      const impact = Math.max(0, finite(i.impactPerDayM));
      const caught = typeof i.caughtInSec === 'number' && Number.isFinite(i.caughtInSec) && i.caughtInSec >= 0 ? i.caughtInSec : undefined;
      const commit = i.commit ? { hash: i.commit.hash.slice(0, 7), message: i.commit.message, author: displayAuthor(i.commit.author) } : undefined;
      const status = i.closedAt ? 'recovered' : 'open';
      const openedAtMs = fromIso(i.openedAt);
      const lasted = i.closedAt ? (fromIso(i.closedAt) - openedAtMs) / 1000 : Number.NaN;
      const durationSec = Number.isFinite(lasted) && lasted >= 0 ? lasted : undefined;
      const perDay = fmtDollars(impact);
      let impactText: string;
      if (status === 'open') impactText = fill(copy.impact.open, { perDay, perYear: fmtDollarsCompact(perYear(impact)) });
      else if (durationSec !== undefined) impactText = fill(copy.impact.closed, { perDay, duration: fmtDurationShort(durationSec) });
      else impactText = fill(copy.impact.closedNoDuration, { perDay });
      return {
        id: i.id,
        type: i.type,
        title: fill(i.type === 'spike' ? copy.alert.spike : copy.alert.regression, { label: i.label }),
        openedAtMs,
        measure: incidentMeasure(i, copy),
        impactPerDayM: impact,
        impactText,
        ...(durationSec !== undefined ? { durationSec } : {}),
        ...(caught !== undefined ? { caughtInSec: caught, caughtText: fmtDurationShort(caught) } : {}),
        ...(commit ? { commit } : {}),
        causeText: commit ? fill(copy.commit, commit) : copy.noCommit,
        status,
        statusText: copy.status[status],
      };
    })
    .sort((a, b) => b.openedAtMs - a.openedAtMs);
  const caughts = rows.map((r) => r.caughtInSec).filter((s): s is number => s !== undefined);
  const fastestSec = caughts.length > 0 ? Math.min(...caughts) : undefined;
  const medianSec = median(caughts);
  const open = rows.filter((r) => r.status === 'open');
  const atRiskPerDayM = open.reduce((s, r) => s + r.impactPerDayM, 0);
  const totalPerDayM = rows.reduce((s, r) => s + r.impactPerDayM, 0);
  // The snapshot keeps the open alerts plus the last 24 hours of closed ones.
  const coverage: 'period' | 'last24h' = Number.isFinite(sweepMs) && window.fromMs < sweepMs - LAST_24H_MS ? 'last24h' : 'period';
  const caption = coverage === 'last24h' ? copy.protection.captionLast24h : fill(copy.protection.captionPeriod, { period: periodWords });
  let summary = copy.protection.none;
  if (rows.length > 0) {
    const alerts = plural(copy.kpi.protectionValue, rows.length);
    summary = open.length > 0 ? fill(copy.protection.summaryOpen, { alerts, amount: fmtDollars(atRiskPerDayM) }) : fill(copy.protection.summaryRecovered, { alerts });
    if (fastestSec !== undefined && medianSec !== undefined) summary += fill(copy.protection.fastest, { fastest: fmtDurationShort(fastestSec), median: fmtDurationShort(medianSec) });
  }
  return {
    rows,
    count: rows.length,
    openCount: open.length,
    atRiskPerDayM,
    totalPerDayM,
    ...(fastestSec !== undefined ? { fastestSec } : {}),
    ...(medianSec !== undefined ? { medianSec } : {}),
    coverage,
    caption,
    summary,
  };
}

/** The second line of an alert card: what it cost, what moved, how fast it was caught. */
export function alertLine(r: ReportIncident, caughtLabel: string, sep: string): string {
  return [r.impactText, r.measure, r.caughtText ? `${caughtLabel} ${r.caughtText}` : ''].filter(Boolean).join(sep);
}

// ─── Methodology ─────────────────────────────────────────────────────────────

/** A source's publisher from the copy's list (the host or a parent domain matches), else the host. */
export function sourceName(host: string, names: ReportCopy['sourceNames']): string {
  const h = host.toLowerCase();
  return names.find((n) => h === n.host || h.endsWith(`.${n.host}`))?.name ?? host;
}

function priceRows(destinations: ReportDestination[], copy: ReportCopy): ReportPriceRow[] {
  const out: ReportPriceRow[] = [];
  const seen = new Set<string>();
  for (const d of destinations) {
    if (d.unpriced) continue;
    const preset = d.presetId ? presetById(d.presetId) : undefined;
    const note = d.presetId ? PRESET_NOTES[d.presetId] : undefined;
    if (preset && note && d.isPresetPrice) {
      const key = `preset:${preset.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let host = '';
      const url = note.sources[0]?.url ?? '';
      try {
        host = url ? new URL(url).host.replace(/^www\./, '') : '';
      } catch {
        host = '';
      }
      out.push({
        key,
        label: preset.label,
        mcPerGb: preset.milliCentsPerGb,
        range: `${fmtUsdPerGb(note.rangeUsd[0])}\u2013${fmtUsdPerGb(note.rangeUsd[1])}`,
        basis: copy.methodology.confidence[note.confidence],
        ...(host ? { source: sourceName(host, copy.sourceNames), sourceUrl: url } : {}),
        custom: false,
      });
    } else {
      const key = `custom:${d.key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const basis = d.hasPriceEntry ? fill(copy.methodology.customBasis, { destination: d.label }) : fill(copy.methodology.meteredBasis, { destination: d.label });
      out.push({ key, label: d.pricedAs, mcPerGb: d.mcPerGb, basis, custom: true });
    }
  }
  return out;
}

/** '$2.25' / '$0.023' — a per-GB price at the precision it was entered with (core/format.ts mcToDollarInput). */
export function fmtPricePerGb(mcPerGb: number): string {
  return fmtPriceShown(mcPerGb);
}

function fmtUsdPerGb(usd: number): string {
  return fmtPricePerGb(Math.round(usd * 100_000));
}

// ─── Build ───────────────────────────────────────────────────────────────────

export function buildReportCard(input: ReportInput): ReportCard {
  const { snapshot, copy, tz } = input;
  const labels = input.settings.humanize;
  const sample = input.source === 'sample';
  const sweepMs = Number.isFinite(fromIso(snapshot.sweepAt)) ? fromIso(snapshot.sweepAt) : input.nowMs;
  const h = snapshot.headline;

  // ── Period ──
  const period = input.period;
  const window = periodWindow(period, sweepMs, tz);
  const figures = reportPeriodFigures(snapshot, period);
  const periodWords = period.kind === 'range' ? rangeSpanLabel(window.fromMs, window.toMs, tz, sweepMs) : copy.periodCaption[period.kind];
  const periodTitle = copy.period[period.kind];
  const span = period.kind === 'range' ? rangeSpanLabel(window.fromMs, window.toMs, tz, sweepMs) : weekRangeLabel(window.fromMs, sweepMs + 1, tz);
  const sinceMs = fromIso(snapshot.collectingSince);
  let caption: string | undefined;
  if (period.kind === 'range') caption = period.caption;
  else if (Number.isFinite(sinceMs) && sinceMs > window.fromMs) caption = fill(copy.collectingSince, { date: formatDay(sinceMs, tz) });

  // ── Volume (per day at the last hour's rate) ──
  let inBPerDay = 0;
  let outBPerDay = 0;
  for (const f of snapshot.flows ?? []) {
    inBPerDay += finite(f.inBPerDay);
    outBPerDay += finite(f.outBPerDay);
  }
  const volumeRatio = volumeReduction(inBPerDay, outBPerDay);

  // ── Run rate ──
  const annualM = finite(h.annualizedM);
  const monthlyM = Math.round(annualM / 12);
  const fromDays = finite(h.annualizedFromDays);
  const days = Math.round(fromDays);
  const runRateBasis = fromDays >= 1 ? plural(copy.kpi.runRateFrom, days) : copy.kpi.runRateToday;

  // ── Cribl cost: the Receipt's net (month to date) and its annualized net ──
  const costCents = input.settings.criblCostCentsPerMonth;
  let cribl: ReportCard['cribl'];
  if (costCents !== undefined && Number.isFinite(costCents) && costCents > 0) {
    const costPerMonthM = costCents * 1000;
    const yearCostM = costPerMonthM * 12;
    cribl = {
      costPerMonthM,
      ...(input.settings.criblCostEstimate === true ? { estimate: true as const } : {}),
      runRate: {
        costM: yearCostM,
        netM: annualM - yearCostM,
        ...(yearCostM > 0 ? { paybackX: annualM / yearCostM } : {}),
        monthlyNetM: monthlyM - costPerMonthM,
      },
    };
    if (period.kind === 'mtd') {
      // The Receipt's month-to-date net (src/views/Receipt/model.ts netFigures): the cost prorated to the minutes
      // metered this month (core/net.ts meteredSpan), not the calendar days, so a workspace metering since the
      // 26th is not charged 26 days of Cribl against one day of savings.
      const monthSpan = meteredSpan(localMonthStartMs(sweepMs, tz), sweepMs, sinceMs);
      const net = netOfCribl(h.mtdM, monthSpan.minutes, costCents);
      if (net) cribl.period = { costM: net.costM, netM: net.netM, ...(net.paybackX !== undefined ? { paybackX: net.paybackX } : {}) };
    }
  }

  // ── Sections ──
  const top = topSaversFor(snapshot, labels, copy);
  const { rows: destinations, all: allDestinations } = destinationRowsFor(snapshot, input.prices, labels, copy);
  const unpricedLabels = destinations.filter((d) => d.unpriced).map((d) => d.label);
  const protection = protectionFor(snapshot, window, copy, periodWords);
  const priced = destinations.filter((d) => !d.unpriced);
  // A price is a typical list price (a preset at its own figure) or an admin's rate (a price entry at any other
  // figure). Without the prices document neither is known, and the card makes no claim about them.
  const priceMix = { list: priced.filter((d) => d.isPresetPrice).length, custom: priced.filter((d) => !d.isPresetPrice && d.hasPriceEntry).length };
  let priceBasis: string | undefined;
  if (priceMix.list > 0 && priceMix.custom === 0) priceBasis = plural(copy.heroBasis.list, priceMix.list);
  else if (priceMix.list > 0) priceBasis = plural(copy.heroBasis.mixed, priced.length, { list: priceMix.list });
  else if (priceMix.custom > 0) priceBasis = copy.heroBasis.custom;

  // ── KPI tiles ──
  const kpis: ReportCard['kpis'] = [];
  kpis.push({
    label: copy.kpi.runRate,
    value: fmtDollarsCompact(annualM),
    unit: copy.kpi.runRateUnit,
    lines: [fill(copy.kpi.runRateMonthly, { amount: fmtDollarsCompact(monthlyM) }), runRateBasis],
    tone: 'saved',
  });
  if (cribl) {
    const usePeriod = cribl.period?.paybackX !== undefined;
    const payback = usePeriod ? cribl.period?.paybackX : cribl.runRate.paybackX;
    const net = usePeriod && cribl.period ? fill(copy.kpi.netPeriod, { amount: fmtDollars(cribl.period.netM), period: periodWords }) : fill(copy.kpi.netRunRate, { amount: fmtDollars(cribl.runRate.netM) });
    kpis.push({
      label: copy.kpi.roi,
      value: payback !== undefined ? fill(copy.kpi.roiValue, { multiple: fmtMultiple(payback) }) : copy.kpi.roiUnset,
      lines:
        payback !== undefined
          ? [fill(copy.kpi.roiEvery, { amount: fmtDollarsCents(Math.round(payback * MC_PER_DOLLAR)) }), fill(copy.kpi.roiPct, { pct: fmtPct(payback - 1) }), net]
          : [net],
      tone: 'neutral',
    });
  } else {
    kpis.push({ label: copy.kpi.roi, value: copy.kpi.roiUnset, lines: [copy.kpi.roiUnsetHint], tone: 'muted' });
  }
  kpis.push(
    volumeRatio !== undefined
      ? {
          label: copy.kpi.volume,
          value: fmtPct(volumeRatio),
          unit: copy.kpi.volumeUnit,
          lines: [fill(copy.kpi.volumeFlow, { in: fmtBytes(inBPerDay), out: fmtBytes(outBPerDay) }), copy.kpi.volumeBasis],
          tone: 'neutral',
        }
      : { label: copy.kpi.volume, value: copy.kpi.volumeNone, lines: [copy.kpi.volumeBasis], tone: 'muted' },
  );
  const window24 = protection.coverage === 'last24h' ? [copy.kpi.protectionWindow] : [];
  if (protection.count > 0) {
    const lines = [...window24];
    lines.push(
      protection.openCount > 0
        ? fill(copy.kpi.protectionAtRisk, { amount: fmtDollars(protection.atRiskPerDayM) })
        : fill(copy.kpi.protectionRecovered, { amount: fmtDollars(protection.totalPerDayM) }),
    );
    if (protection.fastestSec !== undefined) lines.push(fill(copy.kpi.protectionCaught, { time: fmtDurationShort(protection.fastestSec) }));
    kpis.push({ label: copy.kpi.protection, value: String(protection.count), unit: plural(copy.kpi.protectionUnit, protection.count), lines, tone: 'neutral' });
  } else {
    kpis.push({ label: copy.kpi.protection, value: copy.kpi.protectionNone, lines: [copy.kpi.protectionQuiet, ...window24], tone: 'muted' });
  }

  // ── Trend: the snapshot's local days that fall inside the period ──
  const fromKey = localDayKey(window.fromMs, tz);
  const toKey = localDayKey(Math.max(window.fromMs, window.toMs - 1), tz);
  const trendPoints = (snapshot.trend ?? []).filter((p) => p.day >= fromKey && p.day <= toKey).map((p) => ({ day: p.day, savedM: finite(p.savedM) }));

  // ── Methodology ──
  const methodology: string[] = [];
  const periodSentence = period.kind === 'range' ? fill(copy.methodology.period.range, { span, tz }) : fill(copy.methodology.period[period.kind], { tz });
  methodology.push(`${periodSentence} ${fill(copy.methodology.runRate, { basis: runRateBasis })}`);
  const others = priced
    .filter((d): d is ReportDestination & { counterfactual: { kind: 'other'; outputId: string } } => d.counterfactual.kind === 'other')
    .map((d) => fill(copy.methodology.counterfactualOtherItem, { destination: d.label, target: humanize(d.counterfactual.outputId, labels) }));
  methodology.push(fill(copy.methodology.counterfactual, { others: others.length > 0 ? fill(copy.methodology.counterfactualOthers, { list: others.join('; ') }) : '' }));
  const attribution: Attribution = snapshot.attributionSummary ?? 'route';
  methodology.push(copy.methodology.bytes[attribution] ?? copy.methodology.bytes.route);
  methodology.push(copy.methodology.currentRates);
  methodology.push(copy.methodology.notCounted);
  methodology.push(cribl ? fill(copy.methodology.criblCost, { amount: fmtDollars(cribl.costPerMonthM) }) : copy.methodology.criblCostUnset);

  // ── About ──
  const groups = input.groups && input.groups.length > 0 ? [...input.groups] : [...new Set((snapshot.flows ?? []).map((f) => f.groupId))].sort();
  const workspace = (input.workspace ?? '').trim();
  const about: ReportCard['about'] = [];
  about.push({ label: copy.about.workspace, value: workspace || copy.about.workspaceUnknown });
  if (groups.length > 0) about.push({ label: copy.about.groups, value: groups.join(', ') });
  if (Number.isFinite(sinceMs)) about.push({ label: copy.about.collectingSince, value: formatStamp(sinceMs, tz) });
  about.push({ label: copy.about.asOf, value: formatStamp(sweepMs, tz) });
  about.push({ label: copy.about.generated, value: `${formatStamp(input.nowMs, tz)} · ${formatUtcStamp(input.nowMs)}` });
  if (!sample) about.push({ label: copy.about.meteredBy, value: meteredByWords(input.lastSweepOwner, copy) });
  about.push({ label: copy.about.version, value: fill(input.build === 'demo' ? copy.about.versionDemo : copy.about.versionValue, { brand: copy.brand, version: input.appVersion }) });
  about.push({ label: copy.about.data, value: sample ? copy.about.dataSample : copy.about.dataLive });

  // ── Byline, file name, footer ──
  const preparedFor = (input.preparedFor ?? '').trim() || undefined;
  const preparedBy = (input.viewer ?? '').trim() || undefined;
  const note = (input.note ?? '').trim() || undefined;
  const byline: string[] = [];
  if (preparedFor) byline.push(fill(copy.preparedFor, { name: preparedFor }));
  if (preparedBy) byline.push(fill(copy.preparedBy, { name: preparedBy }));
  byline.push(fill(copy.generated, { time: formatStamp(input.nowMs, tz) }));
  const dateKey = localDayKey(input.nowMs, tz);
  const fileBase = `meter-reader-report-${slugify(workspace) || (sample ? 'sample' : 'workspace')}-${periodSlug(period, tz)}-${dateKey}`;

  const shown = top.rows.length;
  const topCaption = shown === top.total ? plural(copy.top.caption, shown) : fill(copy.top.captionOf, { n: shown, total: top.total });
  const heroShown = footMoney({ whpM: figures.whpM, paidM: figures.paidM, savedM: figures.savedM });
  const destTotals = destinationTotals(destinations);
  const destGap = destinationGap(destinations, destTotals, copy);

  return {
    copy,
    sample,
    fileBase,
    title: copy.title,
    ...(workspace ? { workspace } : {}),
    generatedAtMs: input.nowMs,
    ...(preparedFor ? { preparedFor } : {}),
    ...(preparedBy ? { preparedBy } : {}),
    ...(note ? { note } : {}),
    byline,
    period: {
      kind: period.kind,
      title: periodTitle,
      words: periodWords,
      span,
      ...(caption ? { caption } : {}),
      slug: periodSlug(period, tz),
      fromMs: window.fromMs,
      toMs: window.toMs,
    },
    headline: {
      savedM: figures.savedM,
      whpM: figures.whpM,
      paidM: figures.paidM,
      shown: heroShown,
      dollarRatio: figures.ratio,
      label: fill(copy.heroLabel, { period: periodWords }),
      subline: [
        fill(copy.heroWhp, { amount: fmtDollars(heroShown.whpM) }),
        fill(copy.heroPaid, { amount: fmtDollars(heroShown.paidM) }),
        fill(copy.heroDollarPct, { pct: fmtPct(figures.ratio) }),
      ],
      ...(priceBasis ? { basis: priceBasis } : {}),
    },
    volume: { inBPerDay, outBPerDay, ...(volumeRatio !== undefined ? { ratio: volumeRatio } : {}) },
    runRate: { annualM, monthlyM, fromDays, basis: runRateBasis },
    ...(cribl ? { cribl } : {}),
    kpis,
    topSavers: { rows: top.rows, shown, total: top.total, caption: topCaption },
    destinations: {
      rows: destinations,
      totals: destTotals,
      ...(destGap ? { gapNote: destGap } : {}),
      unpricedLabels,
      caption: copy.destinations.caption,
      ...(unpricedLabels.length > 0 ? { unpricedNote: plural(copy.destinations.unpricedNote, unpricedLabels.length, { names: unpricedLabels.join(', ') }) } : {}),
      planNote: fill(copy.destinations.planWith, { annual: fmtDollarsCompact(annualM), basis: runRateBasis }),
    },
    priceMix,
    protection,
    trend: {
      title: fill(copy.trend.title, { period: periodWords }),
      points: trendPoints,
      ...(trendPoints.length < 2 ? { empty: (snapshot.trend ?? []).length >= 2 ? copy.trend.oneDay : copy.trend.empty } : {}),
    },
    flows: flowRows(snapshot, labels, allDestinations),
    prices: priceRows(destinations, copy),
    methodology,
    about,
    footer: fill(workspace ? copy.footer : copy.footerNoWorkspace, { brand: copy.brand, version: input.appVersion, workspace, time: formatUtcStamp(input.nowMs) }),
    credit: fill(copy.credit, { name: CREDIT_STRINGS.builder }),
    builder: CREDIT_STRINGS.builder,
  };
}

function flowRows(snapshot: Snapshot, labels: Record<string, string> | undefined, destinations: Map<string, ReportDestination>): ReportFlowRow[] {
  const word = (id: string) => (id === '-' ? '' : humanize(id, labels));
  return (snapshot.flows ?? [])
    .map((f): ReportFlowRow => {
      const volumeRatio = volumeReduction(finite(f.inBPerDay), finite(f.outBPerDay));
      const d = destinations.get(`${f.groupId}:${f.outputId}`);
      return {
        key: f.key,
        groupId: f.groupId,
        source: word(f.inputId),
        route: word(f.routeId),
        pipeline: word(f.pipelineId),
        destination: word(f.outputId),
        ...(d ? { pricedAs: d.pricedAs } : {}),
        ...(d && !d.unpriced ? { paidMcPerGb: d.mcPerGb } : {}),
        ...(d && !d.unpriced && d.whpMcPerGb !== undefined ? { whpMcPerGb: d.whpMcPerGb } : {}),
        unpriced: d?.unpriced ?? false,
        inBPerDay: finite(f.inBPerDay),
        outBPerDay: finite(f.outBPerDay),
        ...(volumeRatio !== undefined ? { volumeRatio } : {}),
        whpPerDayM: finite(f.whpPerDayM),
        paidPerDayM: finite(f.paidPerDayM),
        savedPerDayM: finite(f.savedPerDayM),
      };
    })
    .sort((a, b) => b.savedPerDayM - a.savedPerDayM || b.whpPerDayM - a.whpPerDayM || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
