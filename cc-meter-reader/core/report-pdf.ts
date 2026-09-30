// core/report-pdf.ts — the report card as a PDF (core/report.ts ReportCard in, bytes out), with no dependency:
// a small PDF 1.4 writer and the layout on top of it.
//
// The writer: US Letter pages, the two standard fonts Helvetica and Helvetica-Bold (WinAnsiEncoding, no embedding,
// every viewer has them), vector rectangles and lines, an Info dictionary, and a cross-reference table whose
// offsets are byte-exact. The file is assembled as one byte per character, so an offset is a string index: text
// outside WinAnsi is transliterated first (− → –, ≈ → ~, → is drawn as a vector arrow, anything else loses its
// accents or becomes '?'), and every byte ≥ 0x80 inside a string is written as an octal escape, which keeps the
// body 7-bit ASCII. Streams are not compressed (the file stays readable and testable; a report is a few dozen KB).
//
// The layout: page 1 is the executive summary (header, the hero number, the receipt bar and what the prices are,
// four KPI tiles as tall as the fullest one, the daily trend on the Receipt chart's round ticks, the top savers,
// and the provenance right after them when it fits); page 2 onward the detail (where the money goes with its
// totals, protection, how the numbers are made, the prices), flowing onto more pages when a workspace has many
// destinations. Nothing is cut to fit a fixed box: names, flows, notes and sources wrap, a heading always keeps
// its table's first rows, and a table's last row never goes to a page alone. Sample data carries a band on
// page 1, a faint diagonal watermark and a tag in every footer.
//
// Widths are Adobe's Core 14 AFM metrics (Helvetica.afm, Helvetica-Bold.afm: WX per glyph, 1/1000 em) for the
// WinAnsi codes 32–255, so right-aligned money and truncated labels land where they should.

import type { ReportCard } from './report.ts';
import { alertLine, fill, fmtPricePerGb, reportIncidentTone } from './report.ts';
import { fmtBytes, fmtDollars, fmtDollarsCompact, fmtPct } from './format.ts';

// ─── Fonts ───────────────────────────────────────────────────────────────────

/* prettier-ignore */
const HELVETICA_WIDTHS: readonly number[] = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500];
/* prettier-ignore */
const HELVETICA_BOLD_WIDTHS: readonly number[] = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556];

export type FontName = 'regular' | 'bold';
const FONT_RESOURCE: Record<FontName, string> = { regular: 'F1', bold: 'F2' };

/** Unicode code points that WinAnsiEncoding places at 0x80–0x9F. */
const WINANSI_HIGH: Readonly<Record<number, number>> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Characters outside WinAnsi that the report's own words and formatters produce, spelled with ones inside it. */
const TRANSLITERATE: Readonly<Record<string, string>> = {
  '\u2212': '\u2013', // minus sign (negative money) becomes an en dash
  '\u2248': '~', // almost equal
  '\u2192': '->', // right arrow: drawText draws a vector arrow instead; this is the fallback
  '\u2190': '<-',
  '\u2713': '', // check marks
  '\u2714': '',
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '\u2013',
  '\u2015': '\u2014',
  '\u2032': "'",
  '\u2033': '"',
  '\u2009': ' ',
  '\u200a': ' ',
  '\u202f': ' ',
  '\u2007': ' ',
  '\u2002': ' ',
  '\u2003': ' ',
  '\u200b': '',
  '\u2060': '',
  '\ufeff': '',
  '\u2264': '<=',
  '\u2265': '>=',
  '\u2260': '!=',
  '\u00a0': ' ',
};

/** One Unicode code point → its WinAnsi byte, or undefined. */
function winAnsiByte(cp: number): number | undefined {
  if (cp >= 0x20 && cp <= 0x7e) return cp;
  if (cp >= 0xa1 && cp <= 0xff) return cp;
  return WINANSI_HIGH[cp];
}

/**
 * A string → WinAnsi bytes: known substitutions first, then accents stripped (NFKD), then '?' for anything left.
 * Control characters (tabs, newlines) become spaces.
 */
export function encodeWinAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0) ?? 0x3f;
    if (cp < 0x20 || cp === 0x7f) {
      out.push(0x20);
      continue;
    }
    const direct = winAnsiByte(cp);
    if (direct !== undefined) {
      out.push(direct);
      continue;
    }
    const sub = TRANSLITERATE[ch];
    if (sub !== undefined) {
      for (const c of sub) out.push(winAnsiByte(c.codePointAt(0) ?? 0x3f) ?? 0x3f);
      continue;
    }
    const base = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    const bytes = [...base].map((c) => winAnsiByte(c.codePointAt(0) ?? 0x3f));
    if (base.length > 0 && base !== ch && bytes.every((b) => b !== undefined)) out.push(...(bytes as number[]));
    else out.push(0x3f);
  }
  return out;
}

/** Width in points of `text` in `font` at `size` (an arrow counts as ARROW_EM). */
export function textWidth(text: string, font: FontName, size: number): number {
  const table = font === 'bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let units = 0;
  for (const part of splitArrows(text)) {
    if (part === ARROW) units += ARROW_EM * 1000;
    else for (const b of encodeWinAnsi(part)) units += b >= 32 ? (table[b - 32] ?? 556) : 0;
  }
  return (units / 1000) * size;
}

const ARROW = '→';
const ARROW_EM = 1.05;

function splitArrows(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const ch of String(text)) {
    if (ch === ARROW) {
      if (buf) out.push(buf);
      out.push(ARROW);
      buf = '';
    } else buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/** `text` cut to fit `maxWidth` with a trailing ellipsis (whole characters). */
export function fitText(text: string, font: FontName, size: number, maxWidth: number): string {
  if (textWidth(text, font, size) <= maxWidth) return text;
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(`${chars.slice(0, mid).join('').trimEnd()}…`, font, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '…' : `${chars.slice(0, lo).join('').trimEnd()}…`;
}

/**
 * Greedy word wrap to `maxWidth`. A single word wider than the line (an id like splunk_hec_prod_useast1_indexers)
 * is broken across lines at the characters rather than cut (DESIGN_BRIEF §5.10: nothing is cut to fit; OQ-07: two
 * long names cut to one prefix printed as identical rows).
 */
export function wrapText(text: string, font: FontName, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  const pieces = (word: string): string[] => {
    const out: string[] = [];
    let cur = '';
    for (const ch of [...word]) {
      if (cur === '' || textWidth(cur + ch, font, size) <= maxWidth) cur += ch;
      else {
        out.push(cur);
        cur = ch;
      }
    }
    out.push(cur);
    return out;
  };
  for (const paragraph of String(text).split('\n')) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, font, size) <= maxWidth) line = candidate;
      else {
        if (line) lines.push(line);
        if (textWidth(word, font, size) <= maxWidth) line = word;
        else {
          const parts = pieces(word);
          lines.push(...parts.slice(0, -1));
          line = parts[parts.length - 1];
        }
      }
    }
    lines.push(line);
  }
  return lines;
}

// ─── PDF strings ─────────────────────────────────────────────────────────────

/** A PDF literal string body: ( ) \ escaped, bytes outside printable ASCII as \ddd. */
export function pdfLiteral(bytes: number[]): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return `(${out})`;
}

/** A text string for the Info dictionary: UTF-16BE with a byte-order mark, as hex (any language survives). */
export function pdfTextString(text: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

/** 'D:20260926211200Z' */
function pdfDate(ms: number): string {
  const iso = new Date(Number.isFinite(ms) ? ms : 0).toISOString();
  return `D:${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

const num = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

// ─── The page canvas (top-left origin, y down; converted to PDF space on write) ─────

export const PAGE_W = 612;
export const PAGE_H = 792;

export type Rgb = readonly [number, number, number];

function hex(h: string): Rgb {
  const v = h.replace('#', '');
  return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
}

/** The app's light palette (Capra: green-9/11, slate-12/11/9/7/6/3, amber, red), so paper matches the screen. */
export const PDF_COLORS = {
  ink: hex('#1c2024'),
  subtle: hex('#60646c'),
  faint: hex('#8b8d98'),
  rule: hex('#d9d9e0'),
  hairline: hex('#e8e8ec'),
  panel: hex('#f7f7f9'),
  saved: hex('#30a46c'),
  savedText: hex('#00824d'),
  savedTint: hex('#e6f6eb'),
  savedPartial: hex('#a3dcbf'),
  paid: hex('#8b8d98'),
  warnText: hex('#ad6200'),
  warnTint: hex('#fff5d6'),
  dangerText: hex('#ce2c31'),
  watermark: hex('#f1f1f4'),
  white: hex('#ffffff'),
} as const;

export interface TextOptions {
  font?: FontName;
  size?: number;
  color?: Rgb;
  align?: 'left' | 'right' | 'center';
  /** Cut to this width with an ellipsis. */
  maxWidth?: number;
  /** Extra space between characters (points), e.g. for small caps labels. */
  tracking?: number;
}

export class PdfPage {
  private readonly ops: string[] = [];

  /** Filled rectangle; `y` is the top edge. */
  rect(x: number, y: number, w: number, h: number, color: Rgb): void {
    if (!(w > 0) || !(h > 0)) return;
    this.ops.push(`${rgb(color)} rg ${num(x)} ${num(PAGE_H - y - h)} ${num(w)} ${num(h)} re f`);
  }

  /** Stroked rectangle outline. */
  strokeRect(x: number, y: number, w: number, h: number, color: Rgb, width = 0.75): void {
    this.ops.push(`${rgb(color)} RG ${num(width)} w ${num(x)} ${num(PAGE_H - y - h)} ${num(w)} ${num(h)} re S`);
  }

  line(x1: number, y1: number, x2: number, y2: number, color: Rgb, width = 0.75): void {
    this.ops.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(PAGE_H - y1)} m ${num(x2)} ${num(PAGE_H - y2)} l S`);
  }

  /** A right-pointing arrow in a box `w` wide whose baseline is `y`, sized for text of `size` points. */
  arrow(x: number, y: number, w: number, size: number, color: Rgb): void {
    const mid = PAGE_H - (y - size * 0.32);
    const x1 = x + w * 0.14;
    const x2 = x + w * 0.86;
    const head = size * 0.24;
    const lw = Math.max(0.5, size * 0.07);
    this.ops.push(
      `${rgb(color)} RG ${num(lw)} w 1 J 1 j ${num(x1)} ${num(mid)} m ${num(x2)} ${num(mid)} l S ${num(x2 - head)} ${num(mid + head)} m ${num(x2)} ${num(mid)} l ${num(x2 - head)} ${num(mid - head)} l S 0 J 0 j`,
    );
  }

  /** Text whose baseline is at `y`. Returns the width drawn. */
  text(x: number, y: number, value: string, opts: TextOptions = {}): number {
    const font = opts.font ?? 'regular';
    const size = opts.size ?? 9;
    const color = opts.color ?? PDF_COLORS.ink;
    const tracking = opts.tracking ?? 0;
    const shown = opts.maxWidth !== undefined ? fitText(value, font, size, opts.maxWidth - Math.max(0, [...value].length - 1) * tracking) : value;
    const width = textWidth(shown, font, size) + Math.max(0, [...shown].length - 1) * tracking;
    let left = x;
    if (opts.align === 'right') left = x - width;
    else if (opts.align === 'center') left = x - width / 2;
    let cursor = left;
    for (const part of splitArrows(shown)) {
      if (part === ARROW) {
        const w = ARROW_EM * size;
        this.arrow(cursor, y, w, size, color);
        cursor += w + tracking;
        continue;
      }
      const bytes = encodeWinAnsi(part);
      // Tc is text state and outlives ET, so every run sets it (0 when untracked).
      const tc = `${num(tracking)} Tc `;
      this.ops.push(`BT /${FONT_RESOURCE[font]} ${num(size)} Tf ${tc}${rgb(color)} rg ${num(cursor)} ${num(PAGE_H - y)} Td ${pdfLiteral(bytes)} Tj ET`);
      cursor += textWidth(part, font, size) + bytes.length * tracking;
    }
    return width;
  }

  /** Text rotated by `degrees` around its own start (the sample watermark). */
  rotatedText(x: number, y: number, value: string, degrees: number, opts: TextOptions = {}): void {
    const font = opts.font ?? 'bold';
    const size = opts.size ?? 72;
    const rad = (degrees * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    this.ops.push(
      `q BT /${FONT_RESOURCE[font]} ${num(size)} Tf 0 Tc ${rgb(opts.color ?? PDF_COLORS.watermark)} rg ${num(c)} ${num(s)} ${num(-s)} ${num(c)} ${num(x)} ${num(PAGE_H - y)} Tm ${pdfLiteral(encodeWinAnsi(value))} Tj ET Q`,
    );
  }

  /** Lines of wrapped text from baseline `y`, `leading` apart; returns the y after the last line. */
  paragraph(x: number, y: number, value: string, width: number, opts: TextOptions & { leading?: number; maxLines?: number } = {}): number {
    const font = opts.font ?? 'regular';
    const size = opts.size ?? 9;
    const leading = opts.leading ?? size * 1.35;
    let lines = wrapText(value, font, size, width);
    if (opts.maxLines !== undefined && lines.length > opts.maxLines) {
      lines = lines.slice(0, opts.maxLines);
      lines[lines.length - 1] = fitText(`${lines[lines.length - 1]}…`, font, size, width);
    }
    let cy = y;
    for (const line of lines) {
      this.text(x, cy, line, { ...opts, font, size });
      cy += leading;
    }
    return cy - leading;
  }

  content(): string {
    return this.ops.join('\n');
  }
}

function rgb(c: Rgb): string {
  return `${num(c[0])} ${num(c[1])} ${num(c[2])}`;
}

// ─── The document writer ─────────────────────────────────────────────────────

export interface PdfInfo {
  title: string;
  author?: string;
  subject?: string;
  creator: string;
  createdAtMs: number;
}

/** Assembles pages into a PDF 1.4 file: catalog, page tree, two standard fonts, one content stream per page. */
export function writePdf(pages: PdfPage[], info: PdfInfo): Uint8Array<ArrayBuffer> {
  const objects: string[] = [];
  // 1 catalog · 2 pages · 3 Helvetica · 4 Helvetica-Bold · 5 info · then (page, content) per page.
  const pageIds = pages.map((_, i) => 6 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  const infoEntries = [
    `/Title ${pdfTextString(info.title)}`,
    ...(info.author ? [`/Author ${pdfTextString(info.author)}`] : []),
    ...(info.subject ? [`/Subject ${pdfTextString(info.subject)}`] : []),
    `/Creator ${pdfTextString(info.creator)}`,
    `/Producer ${pdfTextString(info.creator)}`,
    `/CreationDate (${pdfDate(info.createdAtMs)})`,
  ];
  objects[5] = `<< ${infoEntries.join(' ')} >>`;
  pages.forEach((page, i) => {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /ProcSet [/PDF /Text] >> /Contents ${contentId} 0 R >>`;
    const stream = page.content();
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  // One byte per character throughout: the header's binary comment is the only non-ASCII (four bytes ≥ 0x80).
  let file = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = file.length;
    file += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = file.length;
  const size = objects.length;
  file += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) file += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  file += `trailer\n<< /Size ${size} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  const bytes = new Uint8Array(file.length);
  for (let i = 0; i < file.length; i++) bytes[i] = file.charCodeAt(i) & 0xff;
  return bytes;
}

// ─── The report layout ───────────────────────────────────────────────────────

const M = 48; // side margin
const CONTENT_W = PAGE_W - M * 2;
const TOP = 40;
const BOTTOM = PAGE_H - 52; // content never passes this line; the footer sits below it
const C = PDF_COLORS;

/** The most lines a note takes on page 1 (the view caps what can be typed well below this). */
const NOTE_MAX_LINES = 14;

/** Word wrap capped at `maxLines`: when text is cut, the last line kept ends with an ellipsis. */
export function wrapCapped(text: string, font: FontName, size: number, width: number, maxLines: number): string[] {
  const lines = wrapText(text, font, size, width);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, Math.max(1, maxLines));
  const last = kept.length - 1;
  kept[last] = fitText(`${kept[last]}…`, font, size, width);
  return kept;
}

/**
 * The top of a money axis: 1, 2, 3, 4, 5, 6 or 8 × 10^k at or above `max` (millicents), so the midline is a round
 * figure too — the rule the Receipt's trend chart uses (src/components/TrendChart/trendMath.ts niceMax), so
 * the paper and the screen label the same data with the same ticks.
 */
export function niceAxisMax(max: number): number {
  if (!(max > 0) || !Number.isFinite(max)) return 100_000;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  for (const step of [1, 2, 3, 4, 5, 6, 8, 10]) {
    if (step * base >= max) return step * base;
  }
  return 10 * base;
}

interface Flow {
  page: PdfPage;
  y: number;
}

class Layout {
  readonly pages: PdfPage[] = [];
  private flow!: Flow;

  readonly card: ReportCard;

  constructor(card: ReportCard) {
    this.card = card;
  }

  get page(): PdfPage {
    return this.flow.page;
  }
  get y(): number {
    return this.flow.y;
  }
  set y(v: number) {
    this.flow.y = v;
  }

  newPage(): PdfPage {
    const page = new PdfPage();
    if (this.card.sample) page.rotatedText(122, 640, this.card.copy.sampleWatermark, 38, { size: 88, color: C.watermark });
    this.pages.push(page);
    this.flow = { page, y: TOP };
    return page;
  }

  /** Starts a new page (with the running header) when `h` more points would pass the bottom margin. */
  ensure(h: number): void {
    if (this.y + h <= BOTTOM) return;
    this.newPage();
    this.runningHeader();
  }

  /** The brand strip every page opens with: the workspace on the right, and on later pages the period too. */
  brandStrip(withPeriod: boolean): void {
    const { copy } = this.card;
    const p = this.page;
    p.rect(0, 0, PAGE_W, 5, C.saved);
    p.text(M, TOP + 6, copy.brand.toUpperCase(), { font: 'bold', size: 8, color: C.savedText, tracking: 1.1 });
    const right = [this.card.workspace, withPeriod ? `${this.card.period.title} · ${this.card.period.span}` : ''].filter(Boolean).join('   ·   ');
    p.text(PAGE_W - M, TOP + 6, right, { size: 8, color: C.subtle, align: 'right', maxWidth: CONTENT_W - 120 });
  }

  /** Pages after the first: the brand strip, the title in small, a rule. */
  runningHeader(): void {
    const p = this.page;
    this.brandStrip(true);
    p.text(M, TOP + 24, this.card.title, { font: 'bold', size: 11 });
    p.line(M, TOP + 34, PAGE_W - M, TOP + 34, C.rule);
    this.y = TOP + 46;
  }

  /**
   * A section's title and caption, kept on the same page as the first `keepWith` points of what follows (a
   * table's header and first rows), so a heading never sits alone at the foot of a page.
   */
  sectionTitle(title: string, caption?: string, keepWith = 0): void {
    const capLines = caption ? wrapCapped(caption, 'regular', 8.5, CONTENT_W, 2) : [];
    const h = capLines.length > 0 ? 32 + (capLines.length - 1) * 11 : 21;
    this.ensure(h + keepWith);
    const p = this.page;
    p.text(M, this.y + 12, title, { font: 'bold', size: 12.5 });
    capLines.forEach((line, i) => p.text(M, this.y + 25 + i * 11, line, { size: 8.5, color: C.subtle }));
    this.y += h;
  }

  footers(): void {
    const { copy } = this.card;
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      // Two lines under the rule: the provenance with the page number, then the builder's signature.
      const y = PAGE_H - 32;
      p.line(M, y - 13, PAGE_W - M, y - 13, C.hairline, 0.5);
      const pageText = fill(copy.page, { n: i + 1, total });
      const pageW = p.text(PAGE_W - M, y, pageText, { size: 7.5, color: C.faint, align: 'right' });
      let left = M;
      if (this.card.sample) {
        const tag = copy.sampleWatermark;
        const w = textWidth(tag, 'bold', 6.5) + 0.8 * (tag.length - 1) + 10;
        p.rect(left, y - 8.5, w, 12, C.warnTint);
        p.text(left + 5, y, tag, { font: 'bold', size: 6.5, color: C.warnText, tracking: 0.8 });
        left += w + 8;
      }
      p.text(left, y, this.card.footer, { size: 7.5, color: C.faint, maxWidth: PAGE_W - M - pageW - 16 - left });
      this.credit(p, y + 11);
    });
  }

  /** 'Made with Meter Reader, built by Steve Koelpin' at the left margin, the name in bold. */
  private credit(p: PdfPage, y: number): void {
    const { credit, builder } = this.card;
    const at = credit.lastIndexOf(builder);
    if (at < 0) {
      p.text(M, y, credit, { size: 7.5, color: C.subtle, maxWidth: PAGE_W - 2 * M });
      return;
    }
    let x = M + p.text(M, y, credit.slice(0, at), { size: 7.5, color: C.subtle });
    x += p.text(x, y, builder, { font: 'bold', size: 7.5, color: C.ink });
    const rest = credit.slice(at + builder.length);
    if (rest) p.text(x, y, rest, { size: 7.5, color: C.subtle });
  }
}

/** Column: x offset from the left margin, width, alignment. */
interface Col {
  x: number;
  w: number;
  align: 'left' | 'right';
}

function cols(widths: number[], aligns: ('left' | 'right')[]): Col[] {
  let x = M;
  return widths.map((w, i) => {
    const col = { x, w, align: aligns[i] ?? 'left' };
    x += w;
    return col;
  });
}

function cellX(c: Col): number {
  return c.align === 'right' ? c.x + c.w : c.x;
}

const HEADER_H = 13;

function headerRow(p: PdfPage, y: number, columns: Col[], labels: string[]): void {
  labels.forEach((label, i) => {
    const c = columns[i];
    p.text(cellX(c), y, label.toUpperCase(), { font: 'bold', size: 6.5, color: C.subtle, align: c.align, maxWidth: c.align === 'right' ? c.w - 2 : c.w - 6, tracking: 0.3 });
  });
  p.line(M, y + 5, PAGE_W - M, y + 5, C.rule, 0.75);
}

/** What a table keeps with its heading: the header row and the first two rows (or all of them, when fewer). */
function tableLead<T>(rows: T[], heightOf: (row: T) => number): number {
  return HEADER_H + rows.slice(0, 2).reduce((s, r) => s + heightOf(r), 0);
}

/**
 * Rows under a header that repeats on every page the table reaches. `draw` paints one row whose top is `top`
 * on `page`; rows are separated by hairlines. The header never ends a page without two rows under it, the last
 * row never goes to a page on its own (it takes the one before it along), and `tailH` — a totals row or a note
 * that belongs to the table — stays on the last row's page.
 */
function table<T>(
  l: Layout,
  columns: Col[],
  labels: string[],
  rows: T[],
  heightOf: (row: T) => number,
  draw: (page: PdfPage, top: number, row: T) => void,
  tailH = 0,
): void {
  const head = () => {
    headerRow(l.page, l.y + 8, columns, labels);
    l.y += HEADER_H;
  };
  l.ensure(tableLead(rows, heightOf) + (rows.length <= 2 ? tailH : 0));
  head();
  rows.forEach((row, i) => {
    const h = heightOf(row);
    const isLast = i === rows.length - 1;
    const next = rows[i + 1];
    const breakHere =
      l.y + h + (isLast ? tailH : 0) > BOTTOM ||
      // Keep the last row company: when the last two don't fit together, both move.
      (i >= 2 && i === rows.length - 2 && next !== undefined && l.y + h + heightOf(next) + tailH > BOTTOM);
    if (breakHere && i > 0) {
      l.ensure(BOTTOM);
      head();
    }
    draw(l.page, l.y, row);
    l.y += h;
    l.page.line(M, l.y, PAGE_W - M, l.y, C.hairline, 0.5);
  });
}

/** Lines drawn from baseline `y`, `leading` apart. */
function drawLines(p: PdfPage, x: number, y: number, lines: string[], leading: number, opts: TextOptions): void {
  lines.forEach((line, i) => p.text(x, y + i * leading, line, opts));
}

// ── Page 1 ──

function pageOne(l: Layout): void {
  const { card } = l;
  const { copy } = card;
  const p = l.newPage();
  l.brandStrip(false);

  // Title row: the title left, the period right.
  p.text(M, TOP + 38, card.title, { font: 'bold', size: 22 });
  p.text(PAGE_W - M, TOP + 26, card.period.title, { font: 'bold', size: 11, align: 'right' });
  p.text(PAGE_W - M, TOP + 39, card.period.span, { size: 9, color: C.subtle, align: 'right' });
  const byline = wrapCapped(card.byline.join('   ·   '), 'regular', 8.5, CONTENT_W, 2);
  drawLines(p, M, TOP + 56, byline, 11.5, { size: 8.5, color: C.subtle });
  let y = TOP + 56 + (byline.length - 1) * 11.5 + 11;
  p.line(M, y, PAGE_W - M, y, C.rule);
  y += 12;

  if (card.sample) {
    p.rect(M, y, CONTENT_W, 22, C.warnTint);
    const tag = copy.sampleWatermark;
    const tagW = p.text(M + 10, y + 14.5, tag, { font: 'bold', size: 7.5, color: C.warnText, tracking: 0.8 });
    p.text(M + 10 + tagW + 10, y + 14.5, copy.sampleBanner, { size: 8.5, color: C.warnText, maxWidth: CONTENT_W - tagW - 30 });
    y += 28;
  }

  if (card.note) {
    // The note keeps its own line breaks: each paragraph wraps on its own, and a blank line stays blank.
    const lines = wrapCapped(card.note, 'regular', 9.5, CONTENT_W - 26, NOTE_MAX_LINES);
    const h = 20 + lines.length * 12.5;
    p.rect(M, y, CONTENT_W, h, C.panel);
    p.rect(M, y, 3, h, C.saved);
    p.text(M + 14, y + 13, copy.noteLabel.toUpperCase(), { font: 'bold', size: 6.5, color: C.subtle, tracking: 0.6 });
    drawLines(p, M + 14, y + 26, lines, 12.5, { size: 9.5 });
    y += h + 10;
  }

  // Hero: the label, the number, the receipt bar, the sentence under it, and what the prices are.
  y += 4;
  p.text(M, y + 10, card.headline.label.toUpperCase(), { font: 'bold', size: 8, color: C.subtle, tracking: 0.7, maxWidth: CONTENT_W - 170 });
  // Legend, top right of the hero.
  let lx = PAGE_W - M;
  for (const [label, color] of [
    [copy.legend.saved, C.saved],
    [copy.legend.paid, C.paid],
  ] as const) {
    const w = p.text(lx, y + 10, label, { size: 7.5, color: C.subtle, align: 'right' });
    lx -= w + 5;
    p.rect(lx - 7, y + 3.5, 7, 7, color);
    lx -= 7 + 12;
  }
  const big = fmtDollars(card.headline.savedM);
  p.text(M - 2, y + 58, big, { font: 'bold', size: 50, color: C.savedText });
  if (card.period.caption) {
    // Wrapped beside the figure, its last line on the figure's baseline (OQ-06: one line cut off the clause that
    // explains a $0 — "nothing was metered in this window").
    const bigW = textWidth(big, 'bold', 50);
    const capLines = wrapCapped(card.period.caption, 'regular', 8.5, CONTENT_W - bigW - 12, 4);
    drawLines(p, M + bigW + 10, y + 58 - (capLines.length - 1) * 10.5, capLines, 10.5, { size: 8.5, color: C.subtle });
  }
  y += 72;
  // The receipt bar: its whole length is would have paid; grey is paid, green is saved.
  const barH = 14;
  p.rect(M, y, CONTENT_W, barH, C.hairline);
  const whp = card.headline.whpM;
  if (whp > 0) {
    const paidW = Math.max(0, Math.min(CONTENT_W, (card.headline.paidM / whp) * CONTENT_W));
    p.rect(M, y, paidW, barH, C.paid);
    p.rect(M + paidW, y, CONTENT_W - paidW, barH, C.saved);
  }
  y += barH + 15;
  const [whpText, paidText, pctText] = card.headline.subline;
  let sx = M;
  sx += p.text(sx, y, whpText, { size: 10 });
  sx += p.text(sx, y, '   ·   ', { size: 10, color: C.faint });
  sx += p.text(sx, y, paidText, { size: 10 });
  sx += p.text(sx, y, '   ·   ', { size: 10, color: C.faint });
  p.text(sx, y, pctText, { font: 'bold', size: 10, color: C.savedText, maxWidth: PAGE_W - M - sx });
  if (card.headline.basis) {
    const basis = wrapCapped(card.headline.basis, 'regular', 8, CONTENT_W, 2);
    drawLines(p, M, y + 13, basis, 10, { size: 8, color: C.subtle });
    y += 13 + (basis.length - 1) * 10;
  }
  y += 15;

  // KPI tiles, all as tall as the fullest one (nothing is ever cut to fit a fixed box).
  const gap = 10;
  const tileW = (CONTENT_W - gap * 3) / 4;
  // Each basis line wraps on its own, with a little air between them so three facts don't read as one sentence.
  const TILE_LEADING = 9.5;
  const TILE_PARA = 3.5;
  const tileBlocks = card.kpis.map((k) => k.lines.map((line) => wrapText(line, 'regular', 7.5, tileW - 20)));
  const blocksHeight = (blocks: string[][]) => blocks.reduce((h, b, i) => h + b.length * TILE_LEADING + (i > 0 ? TILE_PARA : 0), 0);
  const tallest = Math.max(0, ...tileBlocks.map(blocksHeight));
  const tileH = Math.max(84, 58 + tallest - TILE_LEADING + 9);
  card.kpis.forEach((k, i) => {
    const x = M + i * (tileW + gap);
    p.rect(x, y, tileW, tileH, C.panel);
    p.rect(x, y, tileW, 2.5, k.tone === 'saved' ? C.saved : k.tone === 'muted' ? C.rule : C.ink);
    p.text(x + 10, y + 17, k.label.toUpperCase(), { font: 'bold', size: 6.5, color: C.subtle, tracking: 0.5, maxWidth: tileW - 20 });
    const valueSize = k.tone === 'muted' ? 13 : 19;
    const vw = p.text(x + 10, y + 42, k.value, { font: 'bold', size: valueSize, color: k.tone === 'saved' ? C.savedText : k.tone === 'muted' ? C.subtle : C.ink, maxWidth: tileW - 20 });
    if (k.unit) p.text(x + 10 + vw + 4, y + 42, k.unit, { size: 8.5, color: C.subtle, maxWidth: tileW - 24 - vw });
    let ly = y + 58;
    for (const block of tileBlocks[i]) {
      drawLines(p, x + 10, ly, block, TILE_LEADING, { size: 7.5, color: C.subtle });
      ly += block.length * TILE_LEADING + TILE_PARA;
    }
  });
  y += tileH + 16;

  // Trend.
  l.y = y;
  trendChart(l);

  // Top savers.
  topSaversSection(l);
}

const CHART_H = 50;

function trendChart(l: Layout): void {
  const card = l.card;
  const { copy } = card;
  const points = card.trend.points;
  l.ensure(points.length < 2 ? 62 : 18 + CHART_H + 22);
  const p = l.page;
  let y = l.y;
  p.text(M, y + 10, card.trend.title, { font: 'bold', size: 10 });
  y += 18;
  if (points.length < 2) {
    p.rect(M, y, CONTENT_W, 30, C.panel);
    p.text(M + 10, y + 19, card.trend.empty ?? copy.trend.empty, { size: 8.5, color: C.subtle, maxWidth: CONTENT_W - 20 });
    l.y = y + 44;
    return;
  }
  const top = niceAxisMax(Math.max(0, ...points.map((pt) => pt.savedM)));
  const labelW = 40;
  const x0 = M + labelW;
  const w = CONTENT_W - labelW;
  // Ticks at the axis top, its half and zero.
  for (const f of [1, 0.5, 0]) {
    const gy = y + CHART_H - CHART_H * f;
    if (f > 0) p.line(x0, gy, PAGE_W - M, gy, C.hairline, 0.5);
    p.text(x0 - 6, gy + 2.5, fmtDollarsCompact(top * f), { size: 6.5, color: C.faint, align: 'right' });
  }
  p.line(x0, y + CHART_H, PAGE_W - M, y + CHART_H, C.rule, 0.75);
  const slot = w / points.length;
  const barW = Math.max(1, slot * 0.72);
  const lastIsToday = card.period.kind !== 'range';
  points.forEach((pt, i) => {
    const h = Math.max(0, Math.min(1, pt.savedM / top) * CHART_H);
    const bx = x0 + i * slot + (slot - barW) / 2;
    p.rect(bx, y + CHART_H - h, barW, h, lastIsToday && i === points.length - 1 ? C.savedPartial : C.saved);
  });
  const dayLabel = (key: string) => {
    const [yy, mm, dd] = key.split('-').map(Number);
    return new Date(Date.UTC(yy, mm - 1, dd)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  p.text(x0 + slot / 2, y + CHART_H + 11, dayLabel(points[0].day), { size: 6.5, color: C.faint, align: 'center' });
  const lastLabel = dayLabel(points[points.length - 1].day);
  p.text(x0 + (points.length - 0.5) * slot, y + CHART_H + 11, lastIsToday ? fill(copy.trend.soFar, { day: lastLabel }) : lastLabel, { size: 6.5, color: C.faint, align: 'right' });
  l.y = y + CHART_H + 22;
}

function topSaversSection(l: Layout): void {
  const card = l.card;
  const { copy } = card;
  const rows = card.topSavers.rows;
  const columns = cols([180, 190, 78, 68], ['left', 'left', 'right', 'right']);
  // Names and flows wrap rather than cut: the destination is the end of a flow, the part worth reading.
  const layout = rows.map((r) => ({
    r,
    label: wrapCapped(r.label, 'bold', 8.5, columns[0].w - 10, 3),
    flow: wrapCapped(r.flow, 'regular', 8, columns[1].w - 10, 3),
  }));
  const heightOf = (x: (typeof layout)[number]) => 18 + (Math.max(x.label.length, x.flow.length) - 1) * 10;
  l.sectionTitle(copy.top.title, card.topSavers.caption, rows.length > 0 ? tableLead(layout, heightOf) : 22);
  if (rows.length === 0) {
    l.page.text(M, l.y + 10, copy.top.none, { size: 9, color: C.subtle });
    l.y += 22;
    return;
  }
  table(l, columns, [copy.cols.whatItDoes, copy.cols.flow, copy.cols.volumeReduced, copy.cols.savedPerDay], layout, heightOf, (p, top, x) => {
    const base = top + 12.5;
    drawLines(p, columns[0].x, base, x.label, 10, { font: 'bold', size: 8.5 });
    drawLines(p, columns[1].x, base, x.flow, 10, { size: 8, color: C.subtle });
    p.text(cellX(columns[2]), base, x.r.volumeRatio !== undefined ? fmtPct(x.r.volumeRatio) : '—', { size: 8.5, align: 'right' });
    p.text(cellX(columns[3]), base, fmtDollars(x.r.savedPerDayM), { font: 'bold', size: 8.5, color: C.savedText, align: 'right' });
  });
  l.y += 4;
}

// ── Detail pages ──

function destinationsTable(l: Layout): void {
  const card = l.card;
  const { copy } = card;
  const rows = card.destinations.rows;
  const columns = cols([104, 90, 40, 94, 72, 52, 64], ['left', 'left', 'right', 'right', 'right', 'right', 'right']);
  const labels = [copy.cols.destination, copy.cols.pricedAs, copy.cols.pricePerGb, copy.cols.gbPerDay, copy.cols.whp, copy.cols.paid, copy.cols.saved];
  const dash = '—';
  const noteW = columns[0].w + columns[1].w - 8;
  const layout = rows.map((r) => {
    // Names wrap in full (OQ-07: capped at two lines, similar long names printed as one identical prefix).
    const label = wrapCapped(r.label, 'bold', 8.5, columns[0].w - 8, 6);
    const pricedAs = wrapCapped(r.pricedAs, r.unpriced ? 'bold' : 'regular', 8, columns[1].w - 8, 4);
    const note = r.counterfactualNote ? wrapCapped(r.counterfactualNote, 'regular', 6.8, noteW, 3) : [];
    const main = Math.max(label.length, pricedAs.length);
    return { r, label, pricedAs, note, main };
  });
  const heightOf = (x: (typeof layout)[number]) => 16.5 + (x.main - 1) * 10 + x.note.length * 8.5;
  // The totals row and the notes under it belong to the table.
  const t = card.destinations.totals;
  const planLines = wrapCapped(card.destinations.planNote, 'regular', 7.5, CONTENT_W, 3);
  const gapLines = card.destinations.gapNote ? wrapCapped(card.destinations.gapNote, 'regular', 7.5, CONTENT_W, 3) : [];
  const unpricedLines = card.destinations.unpricedNote ? wrapCapped(card.destinations.unpricedNote, 'regular', 7.5, CONTENT_W, 3) : [];
  const noteH = (lines: string[]) => (lines.length > 0 ? 3 + lines.length * 9.5 : 0);
  const tailH = 20 + 4 + planLines.length * 9.5 + noteH(gapLines) + noteH(unpricedLines);
  l.sectionTitle(copy.destinations.title, card.destinations.caption, rows.length > 0 ? tableLead(layout, heightOf) : 22);
  if (rows.length === 0) {
    l.page.text(M, l.y + 8, copy.destinations.none, { size: 9, color: C.subtle });
    l.y += 22;
    return;
  }
  table(
    l,
    columns,
    labels,
    layout,
    heightOf,
    (p, top, x) => {
      const { r } = x;
      const base = top + 11.5;
      drawLines(p, columns[0].x, base, x.label, 10, { font: 'bold', size: 8.5 });
      drawLines(p, columns[1].x, base, x.pricedAs, 10, { size: 8, color: r.unpriced ? C.warnText : C.subtle, font: r.unpriced ? 'bold' : 'regular' });
      drawLines(p, columns[0].x, base + (x.main - 1) * 10 + 9.5, x.note, 8.5, { size: 6.8, color: C.subtle });
      p.text(cellX(columns[2]), base, r.unpriced ? dash : fmtPricePerGb(r.mcPerGb), { size: 8.5, align: 'right' });
      p.text(cellX(columns[3]), base, fill(copy.gbPerDayValue, { in: fmtBytes(r.inBPerDay), out: fmtBytes(r.outBPerDay) }), { size: 8, align: 'right', maxWidth: columns[3].w - 4 });
      p.text(cellX(columns[4]), base, r.unpriced ? dash : fmtDollars(r.shown.whpM), { size: 8.5, align: 'right' });
      p.text(cellX(columns[5]), base, r.unpriced ? dash : fmtDollars(r.shown.paidM), { size: 8.5, align: 'right' });
      p.text(cellX(columns[6]), base, r.unpriced ? dash : fmtDollars(r.shown.savedM), { font: 'bold', size: 8.5, color: C.savedText, align: 'right' });
    },
    tailH,
  );
  // Totals, per day: the sums of the amounts printed above, so the column adds up on the page.
  const p = l.page;
  p.line(M, l.y, PAGE_W - M, l.y, C.ink, 0.75);
  const base = l.y + 13;
  p.text(M, base, copy.destinations.total, { font: 'bold', size: 8.5 });
  p.text(cellX(columns[4]), base, fmtDollars(t.whpM), { font: 'bold', size: 8.5, align: 'right' });
  p.text(cellX(columns[5]), base, fmtDollars(t.paidM), { font: 'bold', size: 8.5, align: 'right' });
  p.text(cellX(columns[6]), base, fmtDollars(t.savedM), { font: 'bold', size: 8.5, color: C.savedText, align: 'right' });
  l.y += 20;
  drawLines(p, M, l.y + 8, planLines, 9.5, { size: 7.5, color: C.subtle });
  l.y += 4 + planLines.length * 9.5;
  for (const [lines, color] of [
    [gapLines, C.subtle],
    [unpricedLines, C.warnText],
  ] as const) {
    if (lines.length === 0) continue;
    drawLines(p, M, l.y + 11, lines, 9.5, { size: 7.5, color });
    l.y += noteH(lines);
  }
  l.y += 12;
}

/** One alert card: its lines, and its height. */
function alertCard(r: ReportCard['protection']['rows'][number], caughtLabel: string): { second: string[]; cause: string[]; h: number } {
  const second = wrapCapped(alertLine(r, caughtLabel, '  ·  '), 'regular', 8, CONTENT_W - 24, 3);
  const cause = wrapCapped(r.causeText, 'regular', 7.5, CONTENT_W - 24, 2);
  return { second, cause, h: 40 + (second.length - 1) * 10 + (cause.length - 1) * 9.5 };
}

function protectionSection(l: Layout): void {
  const card = l.card;
  const { copy } = card;
  const prot = card.protection;
  const cards = prot.rows.map((r) => ({ r, ...alertCard(r, copy.cols.caught) }));
  const summary = wrapCapped(prot.summary, prot.count > 0 ? 'bold' : 'regular', 9, CONTENT_W, 2);
  const summaryH = 15 + (summary.length - 1) * 11;
  l.sectionTitle(copy.protection.title, prot.caption, summaryH + (cards[0] ? cards[0].h + 5 : 0));
  drawLines(l.page, M, l.y + 8, summary, 11, { font: prot.count > 0 ? 'bold' : 'regular', size: 9, color: prot.count > 0 ? C.ink : C.subtle });
  l.y += summaryH;
  for (const c of cards) {
    l.ensure(c.h + 5);
    const p = l.page;
    const y = l.y;
    const { r } = c;
    p.rect(M, y, CONTENT_W, c.h, C.panel);
    // R2 core-6: a close that was not a recovery is neutral, never the recovered green.
    const tone = reportIncidentTone(r.status);
    p.rect(M, y, 2.5, c.h, tone === 'open' ? C.dangerText : tone === 'recovered' ? C.saved : C.subtle);
    p.text(M + 12, y + 13.5, r.title, { font: 'bold', size: 9, maxWidth: CONTENT_W - 110 });
    p.text(PAGE_W - M - 10, y + 13.5, r.statusText, { font: 'bold', size: 8, color: tone === 'open' ? C.dangerText : tone === 'recovered' ? C.savedText : C.subtle, align: 'right' });
    drawLines(p, M + 12, y + 25, c.second, 10, { size: 8 });
    drawLines(p, M + 12, y + 25 + (c.second.length - 1) * 10 + 10, c.cause, 9.5, { size: 7.5, color: C.subtle });
    l.y += c.h + 5;
  }
  l.y += 10;
}

function methodologySection(l: Layout): void {
  const { card } = l;
  const LEAD = 9.6;
  const paras = card.methodology.map((para) => wrapText(para, 'regular', 7.5, CONTENT_W - 12));
  l.sectionTitle(card.copy.methodology.title, undefined, paras[0] ? paras[0].length * LEAD + 3 : 0);
  for (const lines of paras) {
    l.ensure(lines.length * LEAD + 3);
    const p = l.page;
    p.rect(M + 1, l.y + 2.8, 2.4, 2.4, C.faint);
    drawLines(p, M + 12, l.y + 6.5, lines, LEAD, { size: 7.5, color: C.ink });
    l.y += lines.length * LEAD + 3;
  }
  l.y += 8;
}

function pricesTable(l: Layout): void {
  const { card } = l;
  const { copy } = card;
  if (card.prices.length === 0) return;
  const columns = cols([142, 50, 84, 140, 100], ['left', 'right', 'right', 'left', 'left']);
  const labels = [copy.cols.pricedAs, copy.cols.pricePerGb, copy.cols.range, copy.cols.basis, copy.cols.source];
  const gutter = 12;
  // The two left-aligned columns after the right-aligned ones sit a gutter away from them.
  columns[3] = { ...columns[3], x: columns[3].x + gutter, w: columns[3].w - gutter };
  const layout = card.prices.map((r) => {
    const label = wrapCapped(r.label, 'bold', 7.5, columns[0].w - 8, 6);
    const basis = wrapCapped(r.basis, 'regular', 7.5, columns[3].w - 8, 6);
    const source = wrapCapped(r.source ?? '—', 'regular', 7.5, columns[4].w, 4);
    return { r, label, basis, source, n: Math.max(label.length, basis.length, source.length) };
  });
  const heightOf = (x: (typeof layout)[number]) => 12 + (x.n - 1) * 9;
  l.sectionTitle(copy.methodology.pricesTitle, copy.methodology.pricesCaption, tableLead(layout, heightOf));
  table(l, columns, labels, layout, heightOf, (p, top, x) => {
    const base = top + 8.8;
    const { r } = x;
    drawLines(p, columns[0].x, base, x.label, 9, { font: 'bold', size: 7.5 });
    p.text(cellX(columns[1]), base, fmtPricePerGb(r.mcPerGb), { size: 7.5, align: 'right' });
    p.text(cellX(columns[2]), base, r.range ?? '—', { size: 7.5, align: 'right', color: r.range ? C.ink : C.faint });
    drawLines(p, columns[3].x, base, x.basis, 9, { size: 7.5, color: C.subtle });
    drawLines(p, columns[4].x, base, x.source, 9, { size: 7.5, color: C.subtle });
  });
  l.y += 14;
}

const ABOUT_COL_W = (CONTENT_W - 20) / 2;
const ABOUT_LABEL_W = 86;

/** Height of one line pair of the About grid (the taller of its two values). */
function aboutRowHeight(card: ReportCard, r: number): number {
  const rows = card.about;
  const half = Math.ceil(rows.length / 2);
  const linesOf = (i: number) => (rows[i] ? Math.max(1, wrapText(rows[i].value, 'regular', 7.5, ABOUT_COL_W - ABOUT_LABEL_W).length) : 1);
  return Math.max(12, Math.max(linesOf(r), linesOf(r + half)) * 10 + 2);
}

function aboutSection(l: Layout): void {
  const { card } = l;
  l.sectionTitle(card.copy.about.title, undefined, aboutRowHeight(card, 0) + 2);
  // Two columns of label / value pairs.
  const colW = ABOUT_COL_W;
  const labelW = ABOUT_LABEL_W;
  const rows = card.about;
  const half = Math.ceil(rows.length / 2);
  for (let r = 0; r < half; r++) {
    const h = aboutRowHeight(card, r);
    l.ensure(h + 2);
    const p = l.page;
    for (const [i, x] of [
      [r, M],
      [r + half, M + colW + 20],
    ] as const) {
      const row = rows[i];
      if (!row) continue;
      p.text(x, l.y + 8, row.label, { font: 'bold', size: 7.5, color: C.subtle, maxWidth: labelW - 6 });
      p.paragraph(x + labelW, l.y + 8, row.value, colW - labelW, { size: 7.5, leading: 10 });
    }
    l.y += h;
  }
}

interface Run {
  text: string;
  font: FontName;
}

/** Greedy wrap of mixed-font runs (label bold, value regular) into lines of runs no wider than `width`. */
function wrapRuns(runs: Run[], size: number, width: number): Run[][] {
  const lines: Run[][] = [];
  let line: Run[] = [];
  let used = 0;
  for (const run of runs) {
    for (const word of run.text.split(/\s+/).filter(Boolean)) {
      const lead = line.length > 0 ? textWidth(' ', run.font, size) : 0;
      const w = textWidth(word, run.font, size);
      if (line.length > 0 && used + lead + w > width) {
        lines.push(line);
        line = [];
        used = 0;
      }
      const last = line[line.length - 1];
      const piece = line.length > 0 ? ` ${word}` : word;
      if (last && last.font === run.font) last.text += piece;
      else line.push({ text: piece, font: run.font });
      used += textWidth(piece, run.font, size);
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/**
 * Wraps label/value pairs, keeping each pair on one line when it fits there (a pair longer than a whole line
 * wraps word by word). Pairs are separated by a middle dot.
 */
function wrapPairs(pairs: { label: string; value: string }[], size: number, width: number): Run[][] {
  const lines: Run[][] = [];
  let line: Run[] = [];
  let used = 0;
  const sep = '  ·  ';
  const sepW = textWidth(sep, 'regular', size);
  for (const pair of pairs) {
    const runs: Run[] = [
      { text: `${pair.label} `, font: 'bold' },
      { text: pair.value, font: 'regular' },
    ];
    const w = runs.reduce((s, r) => s + textWidth(r.text, r.font, size), 0);
    if (line.length > 0 && used + sepW + w <= width) {
      line.push({ text: sep, font: 'regular' }, ...runs);
      used += sepW + w;
      continue;
    }
    if (line.length > 0) lines.push(line);
    if (w <= width) {
      line = runs;
      used = w;
    } else {
      const wrapped = wrapRuns(runs, size, width);
      lines.push(...wrapped.slice(0, -1));
      line = wrapped[wrapped.length - 1] ?? [];
      used = line.reduce((s, r) => s + textWidth(r.text, r.font, size), 0);
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

const PROV_SIZE = 7;
const PROV_LEADING = 9.5;
const PROV_GAP = 14;

/** The provenance block's height (title rule + lines). */
function provenanceHeight(card: ReportCard): number {
  return 14 + wrapPairs(card.about, PROV_SIZE, CONTENT_W).length * PROV_LEADING;
}

/** Provenance ("About this report") as a compact block that closes page 1, right after the top savers. */
function provenanceBlock(l: Layout, top: number): void {
  const { card } = l;
  const p = l.page;
  p.line(M, top, PAGE_W - M, top, C.hairline, 0.5);
  p.text(M, top + 10, card.copy.about.title.toUpperCase(), { font: 'bold', size: 6.5, color: C.subtle, tracking: 0.5 });
  let y = top + 10 + PROV_LEADING + 1;
  for (const line of wrapPairs(card.about, PROV_SIZE, CONTENT_W)) {
    let x = M;
    for (const run of line) x += p.text(x, y, run.text, { font: run.font, size: PROV_SIZE, color: run.font === 'bold' ? C.subtle : C.ink });
    y += PROV_LEADING;
  }
  l.y = y;
}

/** The report card as a PDF file (US Letter, portrait). */
export function renderReportPdf(card: ReportCard): Uint8Array<ArrayBuffer> {
  const l = new Layout(card);
  pageOne(l);
  // Where it fits, the provenance closes the summary page, so a forwarded page 1 stands on its own.
  const provTop = l.y + PROV_GAP;
  const aboutOnFirst = l.pages.length === 1 && provTop + provenanceHeight(card) <= BOTTOM;
  if (aboutOnFirst) provenanceBlock(l, provTop);
  // The detail starts on a page of its own, unless the summary already ran onto one (a long note): then it
  // follows on that page rather than leaving it nearly empty.
  if (l.pages.length === 1) {
    l.newPage();
    l.runningHeader();
  } else l.y += 18;
  destinationsTable(l);
  protectionSection(l);
  methodologySection(l);
  pricesTable(l);
  if (!aboutOnFirst) aboutSection(l);
  l.footers();
  return writePdf(l.pages, {
    title: `${card.title} · ${card.period.title} · ${card.period.span}`,
    ...(card.preparedBy ? { author: card.preparedBy } : {}),
    subject: card.headline.label,
    creator: card.copy.brand,
    createdAtMs: card.generatedAtMs,
  });
}
