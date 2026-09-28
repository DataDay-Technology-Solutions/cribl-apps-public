// core/format.ts — money, percentages, bytes and durations for the edge (UI, payloads, receipts).
// Money arrives as integer MILLICENTS (1 cent = 1,000 mc; $1 = 100,000 mc) and is formatted only here.
// Negative amounts use U+2212 MINUS SIGN; rounding is half-up on the magnitude so it is symmetric.

export const MC_PER_CENT = 1_000;
export const MC_PER_DOLLAR = 100_000;

const MINUS = '−';

/** Groups an integer's digits with commas: 1234567 → '1,234,567'. */
function groupThousands(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}

/** Rounds a non-negative value half-up to an integer. */
function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/** '$1,234' — whole dollars, half-up; negative '−$12'. */
export function fmtDollars(mc: number): string {
  if (!Number.isFinite(mc)) return '$0';
  const dollars = roundHalfUp(Math.abs(mc) / MC_PER_DOLLAR);
  const body = `$${groupThousands(dollars)}`;
  return mc < 0 && dollars > 0 ? `${MINUS}${body}` : body;
}

/** '$1,234.56' — cents, half-up; negative '−$1.50'. */
export function fmtDollarsCents(mc: number): string {
  if (!Number.isFinite(mc)) return '$0.00';
  const cents = roundHalfUp(Math.abs(mc) / MC_PER_CENT);
  const body = `$${groupThousands(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
  return mc < 0 && cents > 0 ? `${MINUS}${body}` : body;
}

/** '$950', '$95.6k', '$1.2M', '$3.4B' — one decimal, trailing '.0' dropped. */
export function fmtDollarsCompact(mc: number): string {
  if (!Number.isFinite(mc)) return '$0';
  const dollars = Math.abs(mc) / MC_PER_DOLLAR;
  let body = `$${groupThousands(roundHalfUp(dollars))}`;
  if (roundHalfUp(dollars) >= 1_000) {
    const scales: [number, string][] = [
      [1e3, 'k'],
      [1e6, 'M'],
      [1e9, 'B'],
    ];
    for (let i = 0; i < scales.length; i++) {
      const [div, suffix] = scales[i];
      const tenths = roundHalfUp((dollars / div) * 10);
      // Promote to the next unit when rounding reaches 1,000 of this one ($999.96k → $1M).
      if (tenths >= 10_000 && i < scales.length - 1) continue;
      const whole = Math.floor(tenths / 10);
      const frac = tenths % 10;
      body = `$${groupThousands(whole)}${frac === 0 ? '' : `.${frac}`}${suffix}`;
      break;
    }
  }
  return mc < 0 && body !== '$0' ? `${MINUS}${body}` : body;
}

/** '60%' — ratio 0.6 → integer percent, half-up. */
export function fmtPct(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0%';
  const pct = roundHalfUp(Math.abs(ratio) * 100);
  // Grouped like every other figure (OQ-13: 'ROI 19259968%' on an extreme price).
  const text = pct >= 1000 ? pct.toLocaleString('en-US') : String(pct);
  return ratio < 0 && pct > 0 ? `${MINUS}${text}%` : `${text}%`;
}

/** '25 points' — a ratio delta (0.25) as percentage points; '1 point' singular. */
export function fmtPoints(deltaRatio: number): string {
  if (!Number.isFinite(deltaRatio)) return '0 points';
  const pts = roundHalfUp(Math.abs(deltaRatio) * 100);
  const sign = deltaRatio < 0 && pts > 0 ? MINUS : '';
  return `${sign}${pts} ${pts === 1 ? 'point' : 'points'}`;
}

/** '12.3 GB' — decimal units (1 GB = 1,000,000,000 bytes), one decimal; bytes below 1 KB as '512 B'. */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  let value = bytes / 1000;
  let i = 0;
  // Promote when one-decimal rounding would print 1000.0 of the current unit.
  while (i < units.length - 1 && Math.round(value * 10) / 10 >= 1000) {
    value /= 1000;
    i++;
  }
  return `${(Math.round(value * 10) / 10).toFixed(1)} ${units[i]}`;
}

/** '12.3 GB/day' from bytes per day. */
export function fmtGbPerDay(bytesPerDay: number): string {
  return `${fmtBytes(bytesPerDay)}/day`;
}

/** '2:51' for 171 s; '1:02:03' past an hour. Negative or non-finite → '0:00'. */
export function fmtDuration(sec: number): string {
  const total = Number.isFinite(sec) && sec > 0 ? Math.round(sec) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** No-break space: a number never wraps away from its unit ('3 min 19' / 's' on the Report card, rules round). */
const NBSP = '\u00a0';

/**
 * A duration in words for a document, never read as a clock time: '45 s', '2 min', '1 min 35 s', '1 h 5 min',
 * '2 d 3 h'. Each number is joined to its unit by a no-break space (U+00A0), so a line may break between the parts
 * but never inside one; the PDF writer draws it as a space. Negative or non-finite → '0 s'.
 */
export function fmtDurationShort(sec: number): string {
  const total = Number.isFinite(sec) && sec > 0 ? Math.round(sec) : 0;
  const u = (n: number, unit: string): string => `${n}${NBSP}${unit}`;
  if (total < 60) return u(total, 's');
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return h > 0 ? `${u(d, 'd')} ${u(h, 'h')}` : u(d, 'd');
  if (h > 0) return m > 0 ? `${u(h, 'h')} ${u(m, 'min')}` : u(h, 'h');
  return s > 0 ? `${u(m, 'min')} ${u(s, 's')}` : u(m, 'min');
}

/** '12 s ago', '3 min ago', '5 h ago', '2 d ago'; under a second 'just now'. */
export function fmtRelative(msAgo: number): string {
  if (!Number.isFinite(msAgo) || msAgo < 1000) return 'just now';
  const s = Math.floor(msAgo / 1000);
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export type ParseResult = { ok: true; value: number } | { ok: false; error: string };

/**
 * Parses a user-entered dollar amount into integer millicents: '$2.50' → 250,000; '0.023' → 2,300;
 * '1,234.5' → 123,450,000. Up to three decimals; negatives, blanks and non-numbers are rejected.
 * Integer arithmetic only, so '0.023' never becomes 2,299.
 */
export function parseDollarsToMc(input: string): ParseResult {
  const notNumber: ParseResult = { ok: false, error: 'must be 0 or more' };
  const raw = typeof input === 'string' ? input.trim() : '';
  let s = raw.replace(/^\$\s*/, '');
  if (s === '' || /^[-\u2212+]/.test(s)) return notNumber;
  // Commas are accepted only as well-formed thousands separators ('1,234.5', not '1,23').
  if (s.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) return notNumber;
    s = s.replace(/,/g, '');
  }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return notNumber;
  const wholePart = m[1];
  const fracPart = m[2] ?? '';
  if (fracPart.length > 3) return { ok: false, error: 'use at most 3 decimal places' };
  const whole = wholePart === '' ? 0 : Number(wholePart);
  const frac = Number(fracPart.padEnd(3, '0'));
  const value = whole * MC_PER_DOLLAR + frac * 100;
  if (!Number.isSafeInteger(value)) return { ok: false, error: 'is too large' };
  return { ok: true, value };
}

/** Cents (user-entered budgets, Cribl cost) → millicents. */
export function centsToMc(cents: number): number {
  return Math.round(cents * MC_PER_CENT);
}

/** Millicents → whole cents (half-up). */
export function mcToCents(mc: number): number {
  return Math.round(mc / MC_PER_CENT);
}

/** Per-day millicents → per-year millicents (× 365). */
export function perYear(mcPerDay: number): number {
  return mcPerDay * 365;
}

/** Millicents → a dollar string for an input field: 250,000 → '2.50', 2,300 → '0.023'. */
export function mcToDollarInput(mc: number): string {
  const v = Math.max(0, Math.round(mc));
  const whole = Math.floor(v / MC_PER_DOLLAR);
  const rest = v % MC_PER_DOLLAR; // hundredths of a cent … 0..99,999 → 5 digits of fraction
  let frac = String(rest).padStart(5, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${whole}.${frac}`;
}

/**
 * A price per GB as shown to a reader, "$2.50", "$0.023", "$250,000.00": mcToDollarInput's precision with thousands
 * separators on the whole dollars (OQ-13: "$250000.00 / GB"). Inputs and spreadsheet cells keep mcToDollarInput.
 */
export function fmtPriceShown(mc: number): string {
  const plain = mcToDollarInput(mc);
  const dot = plain.indexOf('.');
  const whole = Number(plain.slice(0, dot));
  return `$${whole.toLocaleString('en-US')}${plain.slice(dot)}`;
}

/**
 * Plain dollars for a spreadsheet cell (the report card's CSV): '1234.56' — two decimals, half-up on the
 * magnitude, no '$', no thousands separators, an ASCII '-' for negatives.
 */
export function fmtPlainDollars(mc: number): string {
  if (!Number.isFinite(mc)) return '0.00';
  const cents = roundHalfUp(Math.abs(mc) / MC_PER_CENT);
  const body = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
  return mc < 0 && cents > 0 ? `-${body}` : body;
}

/** Millicents rounded to whole dollars exactly as fmtDollars rounds them (half-up on the magnitude). */
export function roundToDollarsM(mc: number): number {
  if (!Number.isFinite(mc)) return 0;
  const dollars = roundHalfUp(Math.abs(mc) / MC_PER_DOLLAR);
  return (mc < 0 ? -dollars : dollars) * MC_PER_DOLLAR || 0;
}

/** Millicents rounded to whole cents exactly as fmtDollarsCents and fmtPlainDollars round them. */
export function roundToCentsM(mc: number): number {
  if (!Number.isFinite(mc)) return 0;
  const cents = roundHalfUp(Math.abs(mc) / MC_PER_CENT);
  return (mc < 0 ? -cents : cents) * MC_PER_CENT || 0;
}

export interface MoneyTriple {
  whpM: number;
  paidM: number;
  savedM: number;
}

/**
 * Would have paid, paid and saved rounded so the printed figures add up. Each is rounded on its own (saved prints
 * exactly as fmtDollars prints it everywhere else); when the exact figures satisfy saved = would have paid − paid,
 * paid is printed as the difference of the rounded two, so rounding never leaves a $1 gap. When they don't (a
 * flow marked as going nowhere is paid for but saves nothing, and a flow's saving is never below zero), paid stays
 * its own rounding: the gap is real and is not hidden. `unit` is whole dollars for the documents, cents for a
 * spreadsheet.
 */
export function footMoney(m: MoneyTriple, unit: 'dollars' | 'cents' = 'dollars'): MoneyTriple {
  const round = unit === 'cents' ? roundToCentsM : roundToDollarsM;
  const whpM = round(m.whpM);
  const savedM = round(m.savedM);
  const paidM = round(m.paidM);
  const foots = Math.abs(m.whpM - m.paidM - m.savedM) < (unit === 'cents' ? MC_PER_CENT : MC_PER_DOLLAR) / 2;
  return { whpM, paidM: foots ? Math.max(0, whpM - savedM) : paidM, savedM };
}

/**
 * Lines printed under a total, rounded so they add up to the total as printed (whole dollars): each line is rounded
 * on its own, then the dollar or two that rounding gained or lost goes to (or comes from) the lines whose exact
 * values were closest to rounding the other way. The total is the anchor: it prints exactly as fmtDollars prints
 * it everywhere else. When the lines are not a split of the total (the gap is more than a dollar per line), each
 * keeps its own rounding and the gap is not hidden.
 */
export function footColumn(valuesM: readonly number[], totalM: number): number[] {
  const rounded = valuesM.map((v) => roundToDollarsM(v));
  const n = rounded.length;
  if (n === 0) return rounded;
  let deficit = Math.round((roundToDollarsM(totalM) - rounded.reduce((a, b) => a + b, 0)) / MC_PER_DOLLAR);
  if (deficit === 0 || Math.abs(deficit) > n) return rounded;
  // How far each exact value sits from its rounding, in dollars: + means it was rounded down.
  const slack = valuesM.map((v, i) => ({ i, d: (Number.isFinite(v) ? v - rounded[i] : 0) / MC_PER_DOLLAR }));
  if (deficit > 0) {
    slack.sort((a, b) => b.d - a.d || a.i - b.i);
    for (let k = 0; deficit > 0; k = (k + 1) % n, deficit--) rounded[slack[k].i] += MC_PER_DOLLAR;
  } else {
    slack.sort((a, b) => a.d - b.d || b.i - a.i); // a tie gives the dollar back from the later (smaller) line
    for (let k = 0, guard = 0; deficit < 0 && guard < 2 * n; k = (k + 1) % n, guard++) {
      if (rounded[slack[k].i] < MC_PER_DOLLAR) continue;
      rounded[slack[k].i] -= MC_PER_DOLLAR;
      deficit++;
    }
  }
  return rounded;
}

/** Plain decimal gigabytes for a spreadsheet cell: 12,345,678,901 bytes → '12.346' (1 GB = 10^9 bytes). */
export function fmtPlainGb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0.000';
  const thousandths = roundHalfUp(bytes / 1_000_000);
  return `${Math.floor(thousandths / 1000)}.${String(thousandths % 1000).padStart(3, '0')}`;
}
