// core/pricing.ts — the money model (SPEC 8). Prices are integer millicents per decimal GB;
// every amount is integer millicents, rounded ONCE per minute per flow, so totals always equal
// the sum of their rows and cheap destinations (S3 at 3¢/GB) accumulate instead of rounding to 0.

import type { Counterfactual, Headline, ISO, PriceEntry, PricesDoc, PriceVersion, TotalsDoc } from './types.ts';
import { isFreeOutput, isUnpricedPreset, type OutputHint } from './presets.ts';
import { mtdNetOfCribl } from './net.ts';
import {
  MINUTE_MS,
  MINUTES_PER_YEAR,
  addDaysToKey,
  daysBetweenKeys,
  fromIso,
  localDayKey,
  localDayStartMs,
  localMidnightMs,
  localMonthKey,
  localMonthStartMs,
  minutesInMonth,
  toIso,
} from './time.ts';

export const MAX_PRICE_VERSIONS = 50;
/** Defined in core/time.ts (so core/net.ts can use it without importing this module); re-exported here. */
export { MINUTES_PER_YEAR };

/** Decimal gigabytes (1 GB = 1,000,000,000 bytes), as stated in Show the math. */
export function gb(bytes: number): number {
  return bytes / 1e9;
}

/** `${groupId}:${outputId}` — the byOutputId key; lookups also accept a plain outputId. */
export function outputPriceKey(groupId: string, outputId: string): string {
  return `${groupId}:${outputId}`;
}

export function emptyPrices(nowIso: ISO): PricesDoc {
  return { schemaVersion: 1, updatedAt: nowIso, versions: [] };
}

/**
 * Versions ordered oldest → newest by effectiveFrom (stable for equal instants). Cached per array
 * (the sweep prices every flow every minute); an array mutated in place is re-sorted.
 */
const sortedCache = new WeakMap<PriceVersion[], { n: number; sorted: { t: number; v: PriceVersion }[] }>();
function sortedVersions(prices: PricesDoc): { t: number; v: PriceVersion }[] {
  const versions = prices?.versions ?? [];
  const hit = sortedCache.get(versions);
  if (hit && hit.n === versions.length) return hit.sorted;
  const sorted = versions
    .map((v, i) => ({ t: fromIso(v.effectiveFrom), v, i }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ t, v }) => ({ t, v }));
  sortedCache.set(versions, { n: versions.length, sorted });
  return sorted;
}

function entryIn(version: PriceVersion, groupId: string, outputId: string): PriceEntry | undefined {
  return version.byOutputId[outputPriceKey(groupId, outputId)] ?? version.byOutputId[outputId];
}

/**
 * The price entry in force for an output at `tMs`: the newest version with effectiveFrom ≤ t that
 * prices this output (versions written by appendPriceVersion are complete, so this is the newest
 * version ≤ t; hand-written partial versions fall through to older ones).
 */
export function priceEntryAt(prices: PricesDoc, groupId: string, outputId: string, tMs: number): PriceEntry | undefined {
  const sorted = sortedVersions(prices);
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].t > tMs) continue;
    const e = entryIn(sorted[i].v, groupId, outputId);
    if (e) return e;
  }
  // DECISIONS D25: history older than the FIRST price ever set for this output is priced at that first
  // price, so a new install's seeded backfill isn't $0. Later changes still never rewrite history: they
  // only apply from their own effectiveFrom, and minutes already metered are never re-priced.
  for (let i = 0; i < sorted.length; i++) {
    const e = entryIn(sorted[i].v, groupId, outputId);
    if (e) return sorted[i].t > tMs ? e : undefined;
  }
  return undefined;
}

/** One change to one output's price (P2-W24): when it took effect, what it became, and who saved it. */
export interface PriceChange {
  effectiveFrom: ISO;
  entry: PriceEntry;
  changedBy?: string;
}

/**
 * An output's price history, oldest first (P2-W24): one item per version that CHANGED its entry (every saved
 * version carries every entry, so an unchanged price is not a change). The author is the version's `changedBy`.
 */
export function priceHistory(prices: PricesDoc | null | undefined, groupId: string, outputId: string): PriceChange[] {
  if (!prices) return [];
  const out: PriceChange[] = [];
  let last = '';
  for (const { v } of sortedVersions(prices)) {
    const e = entryIn(v, groupId, outputId);
    if (!e) continue;
    const key = JSON.stringify(e);
    if (key === last) continue;
    last = key;
    out.push({ effectiveFrom: v.effectiveFrom, entry: e, ...(v.changedBy ? { changedBy: v.changedBy } : {}) });
  }
  return out;
}

/** The change behind the price in force at `tMs` (the first one for older minutes, D25), or undefined when unpriced. */
export function priceChangeAt(prices: PricesDoc | null | undefined, groupId: string, outputId: string, tMs: number): PriceChange | undefined {
  const history = priceHistory(prices, groupId, outputId);
  let found: PriceChange | undefined;
  for (const c of history) if (fromIso(c.effectiveFrom) <= tMs) found = c;
  return found ?? history[0];
}

export interface EffectivePrices {
  /** this output's price, mc/GB */
  paidMcPerGb: number;
  /** the counterfactual's price, mc/GB (0 for 'none') */
  whpMcPerGb: number;
  counterfactual: Counterfactual;
  /**
   * no price entry (except a genuinely free type once any price is set), a $0 price from the unmatched 'internal'
   * fallback, or a counterfactual whose destination has no price (`counterfactualUnpriced`)
   */
  unpriced: boolean;
  /**
   * P1-F01: 'other' names a destination with no price entry, so would-have-paid for the diverted data is unknown
   * (priced at $0 until it has one) — not a real $0 credit. A built-in devnull counts as free for itself, never as
   * a price to credit diverted data at; a target priced at $0 on purpose is a real $0.
   */
  counterfactualUnpriced: boolean;
}

/**
 * Prices one output at `tMs` (SPEC 8 counterfactual): 'same' → would-have-paid at this output's
 * rate; 'other' → at the other output's rate (same group), crediting diverted data; 'none' → 0.
 * `outputType` (optional): a genuinely free type (devnull, default, router, cribl_tcp/http) counts as priced at
 * $0 with a $0 'internal' entry, and — once the member has set any price — with no entry at all (REVIEW-3a #11:
 * the built-in devnull nobody prices is not "unpriced"). Before the first price every destination is unpriced,
 * so the first-run price table still asks about each one (the demo rig's simulated SIEMs are DevNull outputs).
 * Given the output itself (type, id, description), a free-type output that stands in for a paid destination —
 * a preset in its description, vendor words in its id, the demo tag — stays unpriced without an entry (P0-04,
 * core/presets.isFreeOutput), so pricing one rig SIEM never makes the others read as free.
 */
export function effectivePrices(
  prices: PricesDoc,
  groupId: string,
  outputId: string,
  tMs: number,
  outputType?: string | OutputHint,
): EffectivePrices {
  const entry = priceEntryAt(prices, groupId, outputId, tMs);
  const paidMcPerGb = entry?.milliCentsPerGb ?? 0;
  const counterfactual: Counterfactual = entry?.counterfactual ?? { kind: 'same' };
  let whpMcPerGb: number;
  let counterfactualUnpriced = false;
  switch (counterfactual.kind) {
    case 'other': {
      if (counterfactual.outputId === outputId) {
        whpMcPerGb = paidMcPerGb;
        break;
      }
      const target = priceEntryAt(prices, groupId, counterfactual.outputId, tMs);
      whpMcPerGb = target?.milliCentsPerGb ?? 0;
      counterfactualUnpriced = !target;
      break;
    }
    case 'none':
      whpMcPerGb = 0;
      break;
    default:
      whpMcPerGb = paidMcPerGb;
  }
  const anyPrice = (prices?.versions ?? []).length > 0;
  const type = typeof outputType === 'string' ? outputType : outputType?.type;
  const unpricedSelf = !entry ? !(anyPrice && isFreeOutput(outputType)) : entry.milliCentsPerGb === 0 && isUnpricedPreset(entry.preset, type);
  return { paidMcPerGb, whpMcPerGb, counterfactual, unpriced: unpricedSelf || counterfactualUnpriced, counterfactualUnpriced };
}

export interface MinuteMoney {
  whpM: number;
  paidM: number;
  savedM: number;
}

/**
 * One flow, one minute (SPEC 8): whpM = round(gb(inB) × whpPrice), paidM = round(gb(outB) × paidPrice),
 * savedM = max(0, whpM − paidM). Counterfactual 'none' → whpM = 0 and savedM = 0 (paid still counts).
 */
export function priceMinute(
  bytes: { inB: number; outB: number },
  paidMcPerGb: number,
  whpMcPerGb: number,
  counterfactual: Counterfactual | Counterfactual['kind'] = 'same',
): MinuteMoney {
  const kind = typeof counterfactual === 'string' ? counterfactual : counterfactual.kind;
  const inB = Number.isFinite(bytes.inB) && bytes.inB > 0 ? bytes.inB : 0;
  const outB = Number.isFinite(bytes.outB) && bytes.outB > 0 ? bytes.outB : 0;
  const paidPrice = Number.isFinite(paidMcPerGb) && paidMcPerGb > 0 ? paidMcPerGb : 0;
  const whpPrice = Number.isFinite(whpMcPerGb) && whpMcPerGb > 0 ? whpMcPerGb : 0;
  const paidM = Math.round((outB * paidPrice) / 1e9);
  if (kind === 'none') return { whpM: 0, paidM, savedM: 0 };
  const whpM = Math.round((inB * whpPrice) / 1e9);
  return { whpM, paidM, savedM: Math.max(0, whpM - paidM) };
}

/**
 * P1-F02: whether a destination's counterfactual credits its data at ANOTHER destination's price — a diversion: the
 * would-have-paid rests on where the data would have gone, not on bytes a pipeline dropped.
 */
export function isDiversion(counterfactual: Counterfactual | undefined, outputId: string): boolean {
  return counterfactual?.kind === 'other' && counterfactual.outputId !== outputId;
}

/**
 * P1-F03: what a pipeline that grows bytes (enrichment, GeoIP) adds: paid beyond would-have-paid. Saved stays
 * clipped at 0 (priceMinute), so this is recorded beside it, never netted into it. 1 GB in, 1.3 GB out at $2.25 →
 * saved 0, added 67,500 mc ($0.675). Nothing is added where nothing would have been paid (no price, or 'none').
 */
export function addedCost(m: { whpM: number; paidM: number }): number {
  return m.whpM > 0 && m.paidM > m.whpM ? m.paidM - m.whpM : 0;
}

/**
 * P1-F03: out-bytes within this share of in-bytes are counting noise, not a pipeline adding data (Cribl's per-route
 * estimates run a few bytes high per event on passthrough, DECISIONS D20): no cost added, no negative reduction.
 */
export const INFLATION_NOISE = 0.01;

/** Savings ratio ∈ [0, 1]; 0 when nothing would have been paid. */
export function ratio(savedM: number, whpM: number): number {
  if (!(whpM > 0) || !Number.isFinite(savedM)) return 0;
  return Math.min(1, Math.max(0, savedM / whpM));
}

// ─── Headline (SPEC 8) ───────────────────────────────────────────────────────

interface Sums {
  whpM: number;
  paidM: number;
  savedM: number;
  minutes: number;
}
const zero = (): Sums => ({ whpM: 0, paidM: 0, savedM: 0, minutes: 0 });
function addDay(acc: Sums, d: Sums | undefined): void {
  if (!d) return;
  acc.whpM += d.whpM;
  acc.paidM += d.paidM;
  acc.savedM += d.savedM;
  acc.minutes += d.minutes;
}

/**
 * Headline figures from the running totals (keys are local days in `tz`):
 * today; month to date; the last 30 local days (today and the 29 before it); and the annualized
 * run rate = Σ saved ÷ Σ metered minutes × 525,600 over the last 30 local days since collecting began
 * (REVIEW-3a #6): a gap while no tab or runner metered lowers neither side, so it no longer drags the
 * rate down the way averaging calendar days did. `annualizedFromDays` (the caption's basis, unchanged) is
 * the number of WHOLE local days of history, up to 30 — a whole day is a completed local day that began at
 * or after `collectingSinceMs` — and, with less than one, the minutes metered so far ÷ 1,440 (fractional).
 * Net and payback appear when a Cribl cost is set.
 */
export function computeHeadline(
  totals: TotalsDoc,
  nowMs: number,
  tz: string,
  collectingSinceMs: number,
  criblCostCentsPerMonth?: number,
  meteredThroughMs?: number,
  opts: { pricedSinceMs?: number; emptyMinutesBeforePriced?: number } = {},
): Headline {
  const byDay = totals?.byDay ?? {};
  const todayKey = localDayKey(nowMs, tz);
  const monthKey = localMonthKey(nowMs, tz);

  const today = zero();
  addDay(today, byDay[todayKey]);

  const mtd = zero();
  const d30 = zero();
  const d30FirstKey = addDaysToKey(todayKey, -29);
  for (const [key, d] of Object.entries(byDay)) {
    if (key > todayKey) continue;
    if (key.startsWith(monthKey)) addDay(mtd, d);
    if (key >= d30FirstKey) addDay(d30, d);
  }

  // Whole local days since collecting began, ending yesterday. Founder-build r1 core-6 (#42): since the first minute that
  // carried priced traffic when that is later — a first run meters a day of history, and traffic that began minutes
  // before the install must not be annualized over the empty hours before it.
  const collecting = Number.isFinite(collectingSinceMs) ? collectingSinceMs : nowMs;
  const priced = opts.pricedSinceMs !== undefined && Number.isFinite(opts.pricedSinceMs) ? (opts.pricedSinceMs as number) : collecting;
  const since = Math.max(collecting, priced);
  const sinceKey = localDayKey(since, tz);
  const firstWholeKey = localMidnightMs(since, tz) === since ? sinceKey : addDaysToKey(sinceKey, 1);
  const yesterdayKey = addDaysToKey(todayKey, -1);
  const wholeDays = firstWholeKey <= yesterdayKey ? daysBetweenKeys(firstWholeKey, yesterdayKey) + 1 : 0;
  let annualizedM = 0;
  let annualizedFromDays = 0;
  const recent = zero();
  const firstKey = sinceKey > d30FirstKey ? sinceKey : d30FirstKey;
  for (const [key, d] of Object.entries(byDay)) if (key >= firstKey && key <= todayKey) addDay(recent, d);
  // Core-6: the metered minutes of the first day that came before the traffic carried nothing; they leave the basis.
  // Founder-build r2 core-5 (FINDINGS_R2 #7): only the METERED ones. The day keeps the minutes from `since` to its end
  // (or the cursor) — at most what it metered, at least one — so a metering gap before the first priced minute (never
  // metered, never counted) no longer shrinks the basis (1.77× in the gap case, 25× where the floor was 1 minute).
  // Founder-build r3 core-5 (FINDINGS_R3 #3): when the sweep recorded how many of that day's metered minutes came before
  // the first priced minute (Snapshot.pricedSinceEmptyMinutes), exactly those leave the basis — nothing is inferred, so
  // a gap after the first priced minute (the tab closed soon after it) no longer keeps the empty minutes in (0.48–0.75×).
  // Without the count (an older snapshot, a zone change since), r2's arithmetic below.
  const recorded = opts.emptyMinutesBeforePriced;
  if (since > collecting && firstKey === sinceKey && recorded !== undefined && Number.isFinite(recorded) && recorded >= 0) {
    const firstDay = byDay[firstKey]?.minutes ?? 0;
    // Never more than the day held before its first priced minute (a stale count cannot empty the basis).
    const emptyBefore = Math.min(Math.floor(recorded), Math.max(0, firstDay - 1));
    recent.minutes = Math.max(firstDay > 0 ? 1 : 0, recent.minutes - emptyBefore);
  } else if (since > collecting && firstKey === sinceKey) {
    const firstDay = byDay[firstKey]?.minutes ?? 0;
    const dayEnd = localDayStartMs(addDaysToKey(firstKey, 1), tz);
    const through = meteredThroughMs !== undefined && Number.isFinite(meteredThroughMs) ? Math.min(meteredThroughMs, nowMs) : nowMs;
    const trafficMinutes = Math.min(firstDay, Math.max(firstDay > 0 ? 1 : 0, Math.floor((Math.min(dayEnd, through) - since) / MINUTE_MS)));
    const emptyBefore = Math.max(0, firstDay - trafficMinutes);
    recent.minutes = Math.max(trafficMinutes, recent.minutes - emptyBefore);
  }
  // 1.1.4 (judge path g): nothing saved over the basis leaves no saved figure for the Receipt to scale would-have-paid
  // and paid by (src/views/Receipt/model.ts annualizedParts), which printed "You would have paid $0 · You paid $0" for a
  // plain Datagen whose Ledger showed $22 a day paid. Then they are their own run rates over the same minutes. Only in
  // that case: a saved rate above 0 keeps the headline (and the committed sample tour) exactly as before.
  let zeroSavedRates: { annualizedWhpM: number; annualizedPaidM: number } | undefined;
  if (recent.minutes > 0) {
    annualizedM = Math.round((recent.savedM / recent.minutes) * MINUTES_PER_YEAR);
    const n = Math.min(30, wholeDays);
    annualizedFromDays = n >= 1 ? n : recent.minutes / 1440;
    if (annualizedM === 0) {
      zeroSavedRates = {
        annualizedWhpM: Math.round((recent.whpM / recent.minutes) * MINUTES_PER_YEAR),
        annualizedPaidM: Math.round((recent.paidM / recent.minutes) * MINUTES_PER_YEAR),
      };
    }
  }

  const headline: Headline = {
    todayM: today.savedM,
    mtdM: mtd.savedM,
    d30M: d30.savedM,
    annualizedM,
    annualizedFromDays,
    ...zeroSavedRates,
    whpMtdM: mtd.whpM,
    paidMtdM: mtd.paidM,
    ratioMtd: ratio(mtd.savedM, mtd.whpM),
    whpTodayM: today.whpM,
    paidTodayM: today.paidM,
    whp30dM: d30.whpM,
    paid30dM: d30.paidM,
  };
  // P0-23 coverage: the minutes each period has held up to what was metered through (the sweep's window end;
  // `nowMs` without one), beside the minutes actually metered in it.
  const through = Number.isFinite(meteredThroughMs) ? Math.min(meteredThroughMs as number, nowMs) : nowMs;
  const heldMin = (startMs: number): number => Math.max(0, Math.floor((through - startMs) / MINUTE_MS));
  headline.minutesMtd = mtd.minutes;
  headline.expectedMinutesMtd = heldMin(localMonthStartMs(nowMs, tz));
  headline.minutesToday = today.minutes;
  headline.expectedMinutesToday = heldMin(localMidnightMs(nowMs, tz));
  headline.minutes30d = d30.minutes;
  headline.expectedMinutes30d = heldMin(localDayStartMs(d30FirstKey, tz));
  // D49: net of Cribl the way the Receipt hero reads it — the cost prorated to the minutes metered this month,
  // not the calendar days (core/net.ts). No usable cost (unset, 0) or no metered minute: no net.
  const net = mtdNetOfCribl(mtd.savedM, nowMs, tz, collectingSinceMs, criblCostCentsPerMonth);
  if (net) {
    headline.netMtdM = net.netM;
    if (net.paybackX !== undefined) headline.paybackX = net.paybackX;
  }
  return headline;
}

/** Missing minutes a period may show before its coverage counts as partial: the 20 s settle and the D31 hold. */
export const COVERAGE_SLACK_MIN = 5;

export interface PeriodCoverage {
  metered: number;
  expected: number;
  /** metered ÷ expected, in [0, 1] */
  ratio: number;
  /** every minute of the period so far was metered (within COVERAGE_SLACK_MIN) */
  complete: boolean;
}

/**
 * P0-23: how much of a headline period was metered — "27,540 of 34,560 minutes metered (79%)". The annualized run
 * rate rests on the last 30 days. Undefined for a headline without the coverage fields (an older snapshot).
 */
export function periodCoverage(h: Headline, period: 'mtd' | 'today' | '30d' | 'annualized'): PeriodCoverage | undefined {
  const [metered, expected] =
    period === 'mtd' ? [h.minutesMtd, h.expectedMinutesMtd] : period === 'today' ? [h.minutesToday, h.expectedMinutesToday] : [h.minutes30d, h.expectedMinutes30d];
  if (!Number.isFinite(metered) || !Number.isFinite(expected) || !((expected as number) > 0)) return undefined;
  const e = expected as number;
  const m = Math.min(Math.max(0, metered as number), e);
  return { metered: m, expected: e, ratio: m / e, complete: e - m <= COVERAGE_SLACK_MIN };
}

// ─── Budget pace (P0-17) ─────────────────────────────────────────────────────

/**
 * Budget pace projects a month from the minutes behind it; alerting abstains until those are the smaller of a
 * day and 5 % of the month (a day, in every month), so one busy first hour never pages at 2,927 %.
 */
export const BUDGET_SETTLED_MIN = 1_440;
export const BUDGET_SETTLED_MONTH_SHARE = 0.05;
/** Under three days behind the projection a budget alert is at most a warning (medium). */
export const BUDGET_EARLY_MIN = 3 * 1_440;

/** Minutes metered in one local month ('YYYY-MM'): Σ minutes of its days in the running totals. */
export function meteredMinutesInMonth(totals: TotalsDoc | null | undefined, monthKey: string): number {
  let n = 0;
  for (const [day, d] of Object.entries(totals?.byDay ?? {})) if (day.startsWith(monthKey)) n += Number.isFinite(d?.minutes) ? d.minutes : 0;
  return n;
}

export interface BudgetPaceInput {
  /** paid to the destination this local month, millicents */
  paidMtdM: number;
  budgetCentsPerMonth?: number;
  nowMs: number;
  tz: string;
  /** minutes metered this month (meteredMinutesInMonth); the paid figure covers exactly these minutes */
  meteredMinutes?: number;
  /** without metered minutes: elapsed time counts from max(the month's start, this) */
  collectingSinceMs?: number;
}

export interface BudgetPace {
  /** the month at this pace, millicents */
  projectedM: number;
  /** projected ÷ budget × 100; undefined without a budget */
  pct?: number;
  /** the minutes the projection divides by */
  elapsedMin: number;
  /** 'metered': minutes metered this month; 'elapsed': wall-clock since the month (or collecting) began */
  basis: 'metered' | 'elapsed';
  /** enough behind the projection to alert on (BUDGET_SETTLED_MIN) */
  settled: boolean;
  /** under BUDGET_EARLY_MIN: an alert is at most medium */
  early: boolean;
}

/**
 * The one budget projection (P0-17): the detector, the snapshot's destination figures and Settings → Budgets all
 * call it. Paid month-to-date ÷ the minutes it was metered over × the minutes in the month — a gap nobody metered
 * lowers neither side, and an install on the 25th projects its real pace instead of 25× low. Without metered
 * minutes (older snapshots) the elapsed time counts from the later of the month's start and collecting-since.
 */
export function budgetPace(input: BudgetPaceInput): BudgetPace {
  const monthMin = minutesInMonth(input.nowMs, input.tz);
  const monthStart = localMonthStartMs(input.nowMs, input.tz);
  const metered = Number.isFinite(input.meteredMinutes) ? Math.max(0, input.meteredMinutes as number) : 0;
  let elapsedMin: number;
  let basis: BudgetPace['basis'];
  if (metered > 0) {
    elapsedMin = Math.min(metered, monthMin);
    basis = 'metered';
  } else {
    const since = Number.isFinite(input.collectingSinceMs) ? Math.max(monthStart, input.collectingSinceMs as number) : monthStart;
    elapsedMin = Math.max(0, (input.nowMs - since) / MINUTE_MS);
    basis = 'elapsed';
  }
  const paid = Number.isFinite(input.paidMtdM) ? Math.max(0, input.paidMtdM) : 0;
  const projectedM = elapsedMin > 0 ? (paid / Math.max(1, elapsedMin)) * monthMin : 0;
  const pace: BudgetPace = {
    projectedM,
    elapsedMin,
    basis,
    settled: elapsedMin >= Math.min(BUDGET_SETTLED_MIN, BUDGET_SETTLED_MONTH_SHARE * monthMin),
    early: elapsedMin < BUDGET_EARLY_MIN,
  };
  const budgetM = (input.budgetCentsPerMonth ?? 0) * 1000;
  if (budgetM > 0) pace.pct = (projectedM / budgetM) * 100;
  return pace;
}

// ─── Price versions ──────────────────────────────────────────────────────────

/**
 * Appends a price version effective at `effectiveFromMs` (append-only; history is never rewritten).
 * The new version is COMPLETE: the newest version's entries overlaid with `byOutputId` (a plain
 * outputId key replaces group-scoped keys for that output). Beyond MAX_PRICE_VERSIONS the oldest
 * version is folded into the next one AT THE NEXT ONE'S effectiveFrom (P1-F08): no price is ever
 * read before the instant it was set. Minutes older than the oldest kept version fall to the first-price
 * rule (D25) — they read that version's price — and outputs priced only in the dropped version stay
 * priced through the merge. Metered minutes are never re-priced, so only a later backfill of that
 * distant past would read the coarser history.
 */
export function appendPriceVersion(prices: PricesDoc, byOutputId: Record<string, PriceEntry>, effectiveFromMs: number, changedBy?: string): PricesDoc {
  const base = prices ?? emptyPrices(toIso(effectiveFromMs));
  const versions = [...(base.versions ?? [])];
  const merged: Record<string, PriceEntry> = { ...(versions.length > 0 ? versions[versions.length - 1].byOutputId : {}) };
  for (const [key, entry] of Object.entries(byOutputId)) {
    // A plain outputId key (single-group installs) supersedes any group-scoped key for the same output;
    // otherwise the older scoped entry would keep winning the lookup.
    if (!key.includes(':')) for (const k of Object.keys(merged)) if (k.endsWith(`:${key}`)) delete merged[k];
    merged[key] = entry;
  }
  // P2-W24: the version names who saved it, when the caller knows (the Prices page reads window.getCriblUser).
  versions.push({ effectiveFrom: toIso(effectiveFromMs), byOutputId: merged, ...(changedBy ? { changedBy } : {}) });
  while (versions.length > MAX_PRICE_VERSIONS) {
    const [a, b] = versions;
    versions.splice(0, 2, { effectiveFrom: b.effectiveFrom, byOutputId: { ...a.byOutputId, ...b.byOutputId }, ...(b.changedBy ? { changedBy: b.changedBy } : {}) });
  }
  return { schemaVersion: 1, updatedAt: toIso(effectiveFromMs), versions };
}
