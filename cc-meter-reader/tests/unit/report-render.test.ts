// tests/unit/report-render.test.ts — the report card's four renderings: the PDF writer (structure checked by
// parsing our own cross-reference table, string escaping, WinAnsi transliteration, text present), the HTML
// file (self-contained, escaped, same order), the email paste (tables and inline styles only; text ≤ 60
// columns) and the CSV (RFC 4180, the header row, plain numbers).

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fmtDollars } from '../../core/format.ts';
import { encodeWinAnsi, fitText, niceAxisMax, pdfLiteral, pdfTextString, renderReportPdf, textWidth, wrapCapped, wrapText } from '../../core/report-pdf.ts';
import { escapeHtml, renderReportHtml } from '../../core/report-html.ts';
import { EMAIL_WIDTH, TEXT_WIDTH, renderReportEmail } from '../../core/report-email.ts';
import { csvField, renderReportCsv } from '../../core/report-csv.ts';
import { buildReportCard, fill, plural } from '../../core/report.ts';
import { niceMax } from '../../src/components/TrendChart/trendMath.ts';
import { COPY, liveCard, liveInput, sampleCard } from './report-fixture.ts';

const latin1 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};

/** Parses the file's own xref table and checks every offset lands on its object. */
function checkXref(file: string): { size: number; objects: Map<number, string> } {
  const m = /startxref\n(\d+)\n%%EOF\n$/.exec(file);
  expect(m, 'startxref at the end').not.toBeNull();
  const xrefAt = Number(m![1]);
  expect(file.slice(xrefAt, xrefAt + 5)).toBe('xref\n');
  const header = /^xref\n0 (\d+)\n/.exec(file.slice(xrefAt))!;
  const size = Number(header[1]);
  const entriesAt = xrefAt + header[0].length;
  const objects = new Map<number, string>();
  for (let i = 0; i < size; i++) {
    const entry = file.slice(entriesAt + i * 20, entriesAt + (i + 1) * 20);
    expect(entry, `entry ${i} is 20 bytes`).toMatch(/^\d{10} \d{5} [nf] \n$/);
    if (i === 0) {
      expect(entry).toBe('0000000000 65535 f \n');
      continue;
    }
    const offset = Number(entry.slice(0, 10));
    expect(file.slice(offset, offset + `${i} 0 obj\n`.length), `object ${i} at ${offset}`).toBe(`${i} 0 obj\n`);
    const end = file.indexOf('\nendobj\n', offset);
    objects.set(i, file.slice(offset + `${i} 0 obj\n`.length, end));
  }
  const trailer = file.slice(entriesAt + size * 20);
  expect(trailer.startsWith(`trailer\n<< /Size ${size} /Root 1 0 R /Info 5 0 R >>\n`)).toBe(true);
  return { size, objects };
}

/** The text shown by every Tj in every content stream, unescaped (octal → byte → Latin-1/WinAnsi char). */
function shownText(objects: Map<number, string>): string {
  const out: string[] = [];
  for (const body of objects.values()) {
    const s = /stream\n([\s\S]*)\nendstream$/.exec(body);
    if (!s) continue;
    const re = /\(((?:\\.|[^\\)])*)\) Tj/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s[1]))) out.push(m[1].replace(/\\([0-7]{3}|.)/g, (_, x: string) => (x.length === 3 ? String.fromCharCode(parseInt(x, 8)) : x)));
  }
  return out.join('\n');
}

/** The shown text of each page, in page order (a page's content stream is the object after the page's own). */
function pageTexts(objects: Map<number, string>): string[] {
  const out: string[] = [];
  for (const [id, body] of objects) {
    if (!body.startsWith('<< /Type /Page /Parent')) continue;
    const content = objects.get(id + 1);
    out.push(content ? shownText(new Map([[id + 1, content]])) : '');
  }
  return out;
}

/** The PDF's text with line breaks folded to spaces, so a sentence wrapped over lines reads as one. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** A string as the PDF shows it: WinAnsi bytes read back as Latin-1, arrows gone (they are drawn, not set). */
const asShown = (text: string): string => flat(String.fromCharCode(...encodeWinAnsi(text.replaceAll('\u2192', ' '))));

describe('PDF writer', () => {
  it('is a PDF 1.4 file whose xref offsets, stream lengths, page tree and trailer are exact', () => {
    const bytes = renderReportPdf(sampleCard());
    const file = latin1(bytes);
    expect(file.startsWith('%PDF-1.4\n%')).toBe(true);
    expect(file.endsWith('%%EOF\n')).toBe(true);
    const { size, objects } = checkXref(file);
    expect(size).toBe(objects.size + 1);
    // Every stream's /Length is its byte count.
    for (const body of objects.values()) {
      const s = /^<< \/Length (\d+) >>\nstream\n([\s\S]*)\nendstream$/.exec(body);
      if (s) expect(s[2].length).toBe(Number(s[1]));
    }
    const pages = [...objects.values()].filter((b) => b.startsWith('<< /Type /Page /Parent'));
    const tree = objects.get(2)!;
    expect(tree).toContain(`/Count ${pages.length}`);
    expect(pages.length).toBe(2);
    expect(objects.get(3)).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
    expect(objects.get(4)).toContain('/BaseFont /Helvetica-Bold');
    // Everything after the header's binary comment is 7-bit ASCII.
    const afterHeader = bytes.slice(file.indexOf('\n', 10) + 1);
    expect([...afterHeader].every((b) => b < 0x80)).toBe(true);
  });

  it('shows the figures, the sections and the sample marking', () => {
    const card = sampleCard();
    const text = shownText(checkXref(latin1(renderReportPdf(card))).objects);
    for (const expected of [card.title, fmtDollars(card.headline.savedM), COPY.destinations.title, COPY.protection.title, COPY.methodology.title, COPY.methodology.pricesTitle, COPY.sampleWatermark, card.topSavers.rows[0].label]) {
      expect(text, expected).toContain(expected);
    }
    const live = shownText(checkXref(latin1(renderReportPdf(liveCard()))).objects);
    expect(live).not.toContain(COPY.sampleWatermark);
  });

  it('writes the Info dictionary: title, the viewer as author, Meter Reader as creator', () => {
    const card = liveCard({ kind: 'mtd' }, {}, { viewer: 'Zoë (Ops) \\ Team' });
    const info = checkXref(latin1(renderReportPdf(card))).objects.get(5)!;
    const decode = (key: string): string => {
      const hex = new RegExp(`/${key} <FEFF([0-9A-F]*)>`).exec(info)![1];
      let s = '';
      for (let i = 0; i < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return s;
    };
    expect(decode('Author')).toBe('Zoë (Ops) \\ Team');
    expect(decode('Creator')).toBe('Meter Reader');
    expect(decode('Title')).toBe(`${card.title} · ${card.period.title} · ${card.period.span}`);
    expect(info).toMatch(/\/CreationDate \(D:\d{14}Z\)/);
  });

  it('escapes ( ) \\ and writes bytes outside ASCII as octal', () => {
    expect(pdfLiteral(encodeWinAnsi('a(b)c\\d'))).toBe('(a\\(b\\)c\\\\d)');
    expect(pdfLiteral(encodeWinAnsi('Zoë · 2×'))).toBe('(Zo\\353 \\267 2\\327)');
    expect(pdfTextString('é')).toBe('<FEFF00E9>');
  });

  it('transliterates what WinAnsi lacks', () => {
    const s = (t: string) => String.fromCharCode(...encodeWinAnsi(t));
    expect(encodeWinAnsi('−$12')).toEqual([0x96, 0x24, 0x31, 0x32]); // minus sign → en dash
    expect(encodeWinAnsi('€…—–·×’“”')).toEqual([0x80, 0x85, 0x97, 0x96, 0xb7, 0xd7, 0x92, 0x93, 0x94]);
    expect(s('≈ $5')).toBe('~ $5');
    expect(s('a → b')).toBe('a -> b');
    expect(s('ok ✓')).toBe('ok ');
    expect(s('Łódź őr')).toBe('?\xf3dz or');
    expect(s('中')).toBe('?');
    expect(s('tab\there')).toBe('tab here');
    expect(s('1\u202f000')).toBe('1 000');
  });

  it('measures, fits and wraps with the Helvetica metrics', () => {
    expect(textWidth('abc', 'regular', 10)).toBeCloseTo(16.12, 6);
    expect(textWidth('abc', 'bold', 10)).toBeCloseTo(17.23, 6);
    expect(textWidth('a → b', 'regular', 10)).toBeCloseTo((556 + 278 + 278 + 556) / 100 + 10.5, 6);
    const cut = fitText('Palo Alto traffic aggregation', 'regular', 10, 60);
    expect(cut.endsWith('…')).toBe(true);
    expect(textWidth(cut, 'regular', 10)).toBeLessThanOrEqual(60);
    expect(fitText('short', 'regular', 10, 100)).toBe('short');
    expect(fitText('WWWW', 'bold', 10, 5)).toBe('…');
    const lines = wrapText('one two three four five six seven', 'regular', 10, 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(textWidth(l, 'regular', 10)).toBeLessThanOrEqual(60);
    // A word wider than the line breaks across lines, whole, never cut (OQ-07).
    const broken = wrapText('Supercalifragilistic', 'regular', 10, 40);
    expect(broken.length).toBeGreaterThan(1);
    expect(broken.join('')).toBe('Supercalifragilistic');
    for (const l of broken) expect(textWidth(l, 'regular', 10)).toBeLessThanOrEqual(40);
    // Two long names that share a prefix stay tell-apart-able.
    const a = wrapText('splunk_hec_prod_useast1_indexers_primary', 'bold', 8.5, 96).join('');
    const b = wrapText('splunk_hec_prod_useast1_indexers_replica', 'bold', 8.5, 96).join('');
    expect(a).not.toBe(b);
  });

  it('flows long detail onto more pages with the header repeated, and stays valid', () => {
    const input = liveInput();
    const many = Array.from({ length: 60 }, (_, i) => ({ ...input.snapshot.destinations[0], outputId: `out_${i}`, whpPerDayM: 1_000_000 + i, paidPerDayM: 500_000, savedPerDayM: 500_000 + i }));
    const card = buildReportCard({ ...input, snapshot: { ...input.snapshot, destinations: many }, note: 'A long note. '.repeat(40) });
    const file = latin1(renderReportPdf(card));
    const { objects } = checkXref(file);
    const pages = [...objects.values()].filter((b) => b.startsWith('<< /Type /Page /Parent')).length;
    expect(pages).toBeGreaterThanOrEqual(3);
    const text = shownText(objects);
    const headers = text.split('\n').filter((l) => l === COPY.cols.destination.toUpperCase()).length;
    expect(headers).toBeGreaterThanOrEqual(2);
    expect(text).toContain(`Page ${pages} of ${pages}`);
  });

  it('closes page 1 with the provenance when it fits, else gives it its own section at the end', () => {
    const fits = shownText(checkXref(latin1(renderReportPdf(liveCard()))).objects);
    expect(fits).toContain(COPY.about.title.toUpperCase());
    expect(fits).not.toContain(`\n${COPY.about.title}\n`);
    const full = sampleCard(undefined, { note: 'A long note that goes on. '.repeat(30), preparedFor: 'The office of the chief financial officer and the board audit committee' });
    const text = shownText(checkXref(latin1(renderReportPdf(full))).objects);
    expect(text).not.toContain(COPY.about.title.toUpperCase());
    expect(text).toContain(`\n${COPY.about.title}\n`);
    for (const a of full.about) expect(text).toContain(a.label);
  });

  it('renders an empty workspace', () => {
    const input = liveInput({ kind: 'today' }, { withIncidents: false });
    const card = buildReportCard({ ...input, snapshot: { ...input.snapshot, flows: [], destinations: [], topSavers: [], trend: [] }, prices: null });
    const text = shownText(checkXref(latin1(renderReportPdf(card))).objects);
    expect(text).toContain(COPY.top.none);
    expect(text).toContain(COPY.destinations.none);
    expect(text).toContain(COPY.trend.empty);
  });

  it('KPI tiles grow to their content: nothing is dropped, even at a payback above 10×', () => {
    const card = liveCard({ kind: 'mtd' }, { withIncidents: true, criblCostCentsPerMonth: 500_000 });
    expect(card.cribl?.period?.paybackX).toBeGreaterThan(10);
    const text = flat(shownText(checkXref(latin1(renderReportPdf(card))).objects));
    for (const k of card.kpis) for (const line of k.lines) expect(text, line).toContain(asShown(line));
    expect(text).toContain(asShown(fill(COPY.kpi.netPeriod, { amount: fmtDollars(card.cribl?.period?.netM ?? 0), period: COPY.periodCaption.mtd })));
  });

  it('keeps a note’s line breaks and every line of it (what the preview shows is what prints)', () => {
    const note = 'Highlights:\n- Splunk Cloud ingest down 31%\n- Sentinel down 30%\n- VPC Flow 90% smaller\n- One spike caught in 2 minutes\nAsk: approve the Q4 rollout.';
    const card = sampleCard(undefined, { note });
    const text = shownText(checkXref(latin1(renderReportPdf(card))).objects);
    const lines = note.split('\n');
    const at = lines.map((l) => text.indexOf(`\n${l}\n`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Past the cap, the last line kept says it was cut.
    const long = sampleCard(undefined, { note: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') });
    const t2 = shownText(checkXref(latin1(renderReportPdf(long))).objects);
    expect(t2).toContain('line 13');
    expect(t2).toContain(asShown('line 14…'));
    expect(t2).not.toContain('line 15');
  });

  it('a heading never ends a page without its first rows; a last row never goes to a page alone', () => {
    const input = liveInput();
    for (const n of [20, 33, 34, 35, 36, 37, 38, 47, 60]) {
      const many = Array.from({ length: n }, (_, i) => ({ ...input.snapshot.destinations[0], outputId: `out_${String(i).padStart(2, '0')}`, whpPerDayM: 10_000_000 - i, paidPerDayM: 500_000, savedPerDayM: 9_500_000 - i }));
      const card = buildReportCard({ ...input, snapshot: { ...input.snapshot, destinations: many } });
      const pages = pageTexts(checkXref(latin1(renderReportPdf(card))).objects);
      const labels = card.destinations.rows.map((r) => r.label);
      for (const [title, first] of [
        [COPY.destinations.title, labels[0]],
        [COPY.methodology.pricesTitle, card.prices[0]?.label],
        [COPY.protection.title, card.protection.summary],
      ] as const) {
        if (!first) continue;
        const page = pages.findIndex((p) => p.split('\n').includes(title));
        expect(page, `${title} (${n})`).toBeGreaterThanOrEqual(0);
        expect(flat(pages[page]), `${title} keeps its first row (${n} destinations)`).toContain(asShown(first));
      }
      const lastPage = pages.findIndex((p) => p.split('\n').includes(labels[labels.length - 1]));
      expect(pages[lastPage].split('\n'), `the last row has company (${n})`).toContain(labels[labels.length - 2]);
    }
  });

  it('when a long note pushes page 1 over, the detail follows on that page instead of leaving it empty', () => {
    const card = sampleCard(undefined, { note: Array.from({ length: 14 }, (_, i) => `Point ${i + 1} of the renewal case.`).join('\n') });
    const pages = pageTexts(checkXref(latin1(renderReportPdf(card))).objects);
    const lastSaver = card.topSavers.rows[card.topSavers.rows.length - 1].label;
    const spill = pages.findIndex((p) => p.includes(lastSaver));
    expect(spill).toBeGreaterThan(0);
    expect(pages[spill].split('\n')).toContain(COPY.destinations.title);
  });

  it('prints the destinations’ totals as the sums of their rows, with the plan note and any gap', () => {
    const card = liveCard();
    const text = flat(shownText(checkXref(latin1(renderReportPdf(card))).objects));
    const t = card.destinations.totals;
    expect(text).toContain(`${COPY.destinations.total} ${fmtDollars(t.whpM)} ${fmtDollars(t.paidM)} ${fmtDollars(t.savedM)}`);
    expect(text).toContain(asShown(card.destinations.planNote));
    expect(text).toContain(asShown(card.destinations.gapNote ?? '(missing)'));
    // One annual figure: no "Saved / year" column anywhere.
    expect(text).not.toContain('SAVED / YEAR');
  });

  it('the trend axis uses the Receipt chart’s round ticks, down to $0', () => {
    for (const v of [1, 99_999, 100_000, 1_234_567, 2_870_000_000, 2_870_000_001, 5_999_999, 80_000_000_000]) expect(niceAxisMax(v)).toBe(niceMax(v));
    expect(niceAxisMax(0)).toBe(niceMax(0));
    const text = shownText(checkXref(latin1(renderReportPdf(sampleCard()))).objects).split('\n');
    for (const tick of ['$30k', '$15k', '$0']) expect(text).toContain(tick);
  });

  it('page 1 says what the prices are, and closes on the provenance', () => {
    const card = sampleCard();
    const pages = pageTexts(checkXref(latin1(renderReportPdf(card))).objects);
    expect(flat(pages[0])).toContain(asShown(plural(COPY.heroBasis.list, 8)));
    expect(pages[0]).toContain(COPY.about.title.toUpperCase());
  });

  it('wrapCapped cuts with an ellipsis only when it must', () => {
    expect(wrapCapped('one two three', 'regular', 10, 500, 2)).toEqual(['one two three']);
    const cut = wrapCapped('one two three four five six seven eight nine ten', 'regular', 10, 40, 2);
    expect(cut).toHaveLength(2);
    expect(cut[1].endsWith('…')).toBe(true);
    expect(textWidth(cut[1], 'regular', 10)).toBeLessThanOrEqual(40);
  });

  const pdfinfo = '/opt/homebrew/bin/pdfinfo';
  it.runIf(existsSync(pdfinfo))('passes pdfinfo with nothing on stderr (poppler repairs silently, so a warning is a failure)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mr-report-'));
    try {
      const path = join(dir, 'report.pdf');
      writeFileSync(path, renderReportPdf(sampleCard()));
      const r = spawnSync(pdfinfo, [path], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toMatch(/Pages:\s+2/);
      expect(r.stdout).toMatch(/PDF version:\s+1\.4/);
      expect(r.stdout).toMatch(/Page size:\s+612 x 792 pts \(letter\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('HTML file', () => {
  it('is one self-contained document: no script, stylesheet link, image or remote font', () => {
    const html = renderReportHtml(sampleCard());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script|<link|<img|<iframe|@import|url\(|src=/i);
    // The only URLs are the price sources, as plain links.
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h).toMatch(/^https:\/\//);
  });

  it('escapes every dynamic string', () => {
    const card = liveCard({ kind: 'mtd' }, {}, { preparedFor: '<img src=x onerror=alert(1)>', note: 'Q3 & "renewal" </main>' });
    const html = renderReportHtml(card);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Q3 &amp; &quot;renewal&quot; &lt;/main&gt;');
    expect(html).toContain('Edge CDN, &quot;public&quot;');
    expect(escapeHtml(`<a href='x'>&`)).toBe('&lt;a href=&#39;x&#39;&gt;&amp;');
  });

  it('carries the figures in the PDF order, and marks samples', () => {
    const card = sampleCard();
    const html = renderReportHtml(card);
    const h2 = (s: string) => `<h2>${escapeHtml(s)}</h2>`;
    const order = [
      `<h1>${escapeHtml(card.title)}</h1>`,
      `>${escapeHtml(fmtDollars(card.headline.savedM))}<`,
      `>${escapeHtml(card.kpis[0].label)}<`,
      h2(card.trend.title),
      h2(COPY.top.title),
      `>${escapeHtml(COPY.about.title)}<`,
      h2(COPY.destinations.title),
      h2(COPY.protection.title),
      h2(COPY.methodology.title),
      h2(COPY.methodology.pricesTitle),
    ];
    const at = order.map((s) => html.indexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toContain('data-sample="true"');
    expect(html).toContain('class="watermark"');
    const live = renderReportHtml(liveCard());
    expect(live).not.toContain('data-sample');
    expect(live).not.toContain('class="watermark"');
  });

  it('links open a new tab, so a click in the sandboxed preview never navigates the preview away', () => {
    const html = renderReportHtml(sampleCard());
    expect(html).toContain('<base target="_blank">');
    const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) expect(a).toContain('target="_blank"');
  });

  it('on a phone, every table row is a card with its money in view (no sideways scroll)', () => {
    const html = renderReportHtml(liveCard());
    expect(html).not.toContain('class="scroll"');
    expect(html).toContain('table.stack thead { display: none; }');
    // Saved leads each row's card; the other amounts are labelled lines.
    expect(html).toMatch(/<td class="n saved key" data-label="Saved">/);
    expect(html).toMatch(/<td class="n row" data-label="Would have paid">/);
    expect(html).toContain(escapeHtml(liveCard().destinations.gapNote ?? '(missing)'));
    expect(html).toContain(escapeHtml(liveCard().headline.basis ?? '(missing)'));
  });

  it('prints on Letter and breaks before the detail', () => {
    const html = renderReportHtml(liveCard());
    expect(html).toContain('@page { size: letter;');
    expect(html).toContain('.detail { break-before: page; }');
  });
});

describe('email paste', () => {
  it('HTML survives Outlook and Gmail: tables, inline styles, no class, no flex or grid, ≤ 640 px', () => {
    const { html } = renderReportEmail(sampleCard());
    expect(html).not.toMatch(/class=|<style|<script|<img|display:\s*(flex|grid)/i);
    expect(html.startsWith(`<table role="presentation" width="${EMAIL_WIDTH}"`)).toBe(true);
    const widths = [...html.matchAll(/width="(\d+)"/g)].map((m) => Number(m[1]));
    expect(Math.max(...widths)).toBeLessThanOrEqual(EMAIL_WIDTH);
    expect(html).toContain(fmtDollars(sampleCard().headline.savedM));
    expect(html).toMatch(/font-family:Arial, Helvetica, sans-serif/);
  });

  it('plain text: receipt style, never wider than 60 columns', () => {
    for (const card of [sampleCard(), liveCard({ kind: 'today' }, { criblCostCentsPerMonth: 3_500_000 }, { note: 'x'.repeat(200), preparedFor: 'Finance' })]) {
      const { text } = renderReportEmail(card);
      const long = text.split('\n').filter((l) => [...l].length > TEXT_WIDTH);
      expect(long).toEqual([]);
      expect(text).toContain(fmtDollars(card.headline.savedM));
      expect(text).toMatch(/ \.{2,} /); // dot leaders
    }
  });

  it('plain text keeps amounts, durations and times on one line, and leads an alert with its status', () => {
    const { text } = renderReportEmail(liveCard({ kind: 'mtd' }, { criblCostCentsPerMonth: 3_500_000 }));
    const lines = text.split('\n');
    expect(lines.filter((l) => /^\s*(UTC|GB|TB|s|min|PM|AM)\b/.test(l))).toEqual([]);
    expect(text).toContain(`[${COPY.status.open}] ${fill(COPY.alert.spike, { label: 'Kubernetes' })}`);
    expect(text).toContain('2 min 51 s');
    expect(text).toContain(liveCard().destinations.gapNote?.slice(0, 20));
  });

  it('marks samples and escapes names', () => {
    const { html, text } = renderReportEmail(sampleCard(undefined, { preparedFor: '<b>CFO</b>' }));
    expect(html).toContain(COPY.sampleWatermark);
    expect(text).toContain(COPY.sampleWatermark);
    expect(html).toContain('&lt;b&gt;CFO&lt;/b&gt;');
  });

  it('renders the empty states', () => {
    const input = liveInput({ kind: 'today' }, { withIncidents: false });
    const card = buildReportCard({ ...input, snapshot: { ...input.snapshot, flows: [], destinations: [], topSavers: [] }, prices: null });
    const { html, text } = renderReportEmail(card);
    for (const s of [COPY.top.none, COPY.destinations.none, COPY.protection.none]) {
      expect(html).toContain(escapeHtml(s));
      expect(text).toContain(s);
    }
  });
});

/** A small RFC 4180 reader for the checks. */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && csv[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += c;
  }
  return rows;
}

describe('CSV', () => {
  it('has a byte-order mark, the header row, CRLF lines and fifteen fields everywhere', () => {
    const card = liveCard();
    const csv = renderReportCsv(card);
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/\n/);
    const rows = parseCsv(csv.slice(1));
    expect(rows[0]).toEqual(COPY.csv.headers);
    expect(rows.length).toBe(1 + card.flows.length + card.destinations.rows.length);
    for (const r of rows) expect(r).toHaveLength(15);
  });

  it('writes plain numbers: dollars with two decimals, GB with three, percent with one', () => {
    const card = liveCard();
    const rows = parseCsv(renderReportCsv(card).slice(1)).slice(1);
    for (const r of rows) {
      expect(r[9]).toMatch(/^\d+\.\d{3}$/);
      expect(r[10]).toMatch(/^\d+\.\d{3}$/);
      if (r[11] !== '') expect(r[11]).toMatch(/^\d+\.\d$/);
      for (const i of [12, 13, 14]) if (r[i] !== '') expect(r[i]).toMatch(/^-?\d+\.\d{2}$/);
      // The money in a row adds up (to the cent) whenever it can: a flow paid for but saving nothing can't.
      if (r[12] !== '' && Number(r[14]) > 0) expect(Math.round((Number(r[12]) - Number(r[13])) * 100)).toBe(Math.round(Number(r[14]) * 100));
    }
    const siem = rows.find((r) => r[0] === COPY.csv.record.destination && r[1] === 'SIEM')!;
    expect(siem.slice(6, 9)).toEqual(['Splunk Cloud', '2.25', '2.25']);
    // Every flow carries its destination's prices, so GB × price can be checked in the spreadsheet.
    const flow = rows.find((r) => r[0] === COPY.csv.record.flow && r[3] === 'Windows DC')!;
    expect(flow.slice(6, 15)).toEqual(['Splunk Cloud', '2.25', '2.25', '400.000', '160.000', '60.0', '900.00', '360.00', '540.00']);
    expect(Number(flow[9]) * Number(flow[7])).toBeCloseTo(Number(flow[12]), 2);
    expect(Number(flow[10]) * Number(flow[8])).toBeCloseTo(Number(flow[13]), 2);
    // Priced elsewhere: the would-have-paid price is the other destination's.
    const archive = rows.find((r) => r[0] === COPY.csv.record.flow && r[5] === 'Archive')!;
    expect(archive.slice(6, 9)).toEqual(['Amazon S3', '2.25', '0.023']);
    const unpriced = rows.find((r) => r[1] === 'Edge CDN, "public"')!;
    expect(unpriced[6]).toBe(COPY.unpriced);
    expect(unpriced.slice(7, 9)).toEqual(['', '']);
    expect(unpriced.slice(12)).toEqual(['', '', '']);
    // No annual column: the report's one annual figure is its run rate.
    expect(COPY.csv.headers.some((h) => /year/i.test(h))).toBe(false);
  });

  it('quotes per RFC 4180 and neutralises formula-looking text', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    const input = liveInput();
    const csv = renderReportCsv(buildReportCard({ ...input, settings: { ...input.settings, humanize: { win_trim: '=HYPERLINK("x")', siem: '@SUM(A1)' } } }));
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`'@SUM(A1)`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });
});
