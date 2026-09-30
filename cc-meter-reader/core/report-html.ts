// core/report-html.ts — the report card as ONE self-contained HTML file: inline CSS and inline SVG, no script,
// no external font, image or stylesheet, every dynamic string escaped. Light theme, print-first (US Letter, the
// detail starts on a new page, nothing splits a tile, a row or an alert), and readable on a phone (the tiles
// stack two by two, and each table row becomes a small card: the name and the money first, then the rest as
// labelled lines, so no figure hides behind a sideways scroll). Same content and order as the PDF
// (core/report-pdf.ts): the summary, then about this report, then the detail. Links open in a new tab
// (<base target="_blank">), so in the preview's sandboxed frame a click is refused rather than navigating the
// preview away from the document it shows.
//
// The Report card view shows this exact string in a sandboxed iframe, so the preview is the download.

import type { ReportCard } from './report.ts';
import { alertLine, fill, fmtPricePerGb, plural, reportIncidentTone } from './report.ts';
import { fmtBytes, fmtDollars, fmtDollarsCompact, fmtPct } from './format.ts';

/** Escapes text for HTML element content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

const e = escapeHtml;

/** The document's palette: the app's light tokens (Capra green-9/11, slate-12/11/9/6/3, amber, red). */
const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; background: #eef0f3; color: #1c2024; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-variant-numeric: tabular-nums; }
.sheet { position: relative; max-width: 816px; margin: 24px auto; background: #ffffff; padding: 40px 48px 32px; box-shadow: 0 1px 3px rgba(28,32,36,.12), 0 8px 24px rgba(28,32,36,.06); border-top: 6px solid #30a46c; overflow: hidden; }
.watermark { position: absolute; top: 38%; left: 50%; transform: translate(-50%, -50%) rotate(-35deg); font-weight: 800; font-size: 120px; letter-spacing: .04em; color: rgba(28,32,36,.045); white-space: nowrap; pointer-events: none; user-select: none; z-index: 0; }
.sheet > *:not(.watermark) { position: relative; z-index: 1; }
.brand { display: flex; justify-content: space-between; gap: 16px; font-size: 11px; color: #60646c; }
.brand b { color: #00824d; letter-spacing: .12em; text-transform: uppercase; }
.titlebar { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-top: 10px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 30px; line-height: 1.15; letter-spacing: -.01em; text-wrap: balance; }
.period { text-align: right; }
.period strong { display: block; font-size: 15px; }
.period span { color: #60646c; font-size: 13px; }
.byline { margin: 6px 0 0; color: #60646c; font-size: 12px; }
.byline span + span::before { content: "\\00B7"; margin: 0 8px; color: #8b8d98; }
hr { border: 0; border-top: 1px solid #d9d9e0; margin: 14px 0 16px; }
.band { background: #fff5d6; color: #ad6200; padding: 8px 12px; font-size: 12px; margin-bottom: 12px; }
.band b { letter-spacing: .08em; margin-right: 8px; }
.note { background: #f7f7f9; border-left: 3px solid #30a46c; padding: 8px 12px 10px; margin-bottom: 14px; }
.note .k { font-size: 10px; font-weight: 700; letter-spacing: .06em; color: #60646c; text-transform: uppercase; }
.note p { margin: 2px 0 0; white-space: pre-wrap; }
.eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: #60646c; }
.hero-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-top: 6px; }
.legend { display: flex; gap: 14px; font-size: 11px; color: #60646c; }
.legend i { display: inline-block; width: 9px; height: 9px; margin-right: 5px; vertical-align: -1px; }
.big { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin: 2px 0 6px; }
.big strong { font-size: 64px; line-height: 1.05; font-weight: 800; color: #00824d; letter-spacing: -.02em; }
.big span { color: #60646c; font-size: 12px; }
.bar { display: block; width: 100%; height: 18px; }
.subline { margin: 8px 0 18px; font-size: 14px; }
.subline span + span::before { content: "\\00B7"; margin: 0 10px; color: #8b8d98; }
.subline .pct { color: #00824d; font-weight: 700; }
.basis { margin: -12px 0 18px; font-size: 12px; color: #60646c; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 22px; }
.kpi { background: #f7f7f9; border-top: 3px solid #1c2024; padding: 12px 12px 14px; break-inside: avoid; }
.kpi.saved { border-top-color: #30a46c; }
.kpi.muted { border-top-color: #d9d9e0; }
.kpi .k { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #60646c; }
.kpi .v { margin-top: 6px; font-size: 26px; font-weight: 800; line-height: 1.1; }
.kpi.saved .v { color: #00824d; }
.kpi.muted .v { font-size: 17px; color: #60646c; }
.kpi .v small { font-size: 12px; font-weight: 400; color: #60646c; margin-left: 4px; }
.kpi p { margin: 6px 0 0; font-size: 11.5px; color: #60646c; line-height: 1.35; }
h2 { font-size: 17px; margin: 0; break-after: avoid; }
.cap { margin: 2px 0 10px; color: #60646c; font-size: 12px; break-after: avoid; }
a { color: inherit; text-decoration: underline; text-decoration-color: #cdced6; text-underline-offset: 2px; }
td.src { font-size: 11.5px; overflow-wrap: anywhere; max-width: 210px; }
section { margin-bottom: 22px; break-inside: auto; }
.chart { display: block; width: 100%; height: 96px; }
.axis { display: flex; justify-content: space-between; font-size: 10px; color: #8b8d98; margin-top: 3px; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #60646c; padding: 6px 8px 6px 0; border-bottom: 1px solid #d9d9e0; white-space: nowrap; }
td { padding: 7px 8px 7px 0; border-bottom: 1px solid #ececf0; vertical-align: top; }
tr { break-inside: avoid; }
th.n, td.n { text-align: right; white-space: nowrap; }
th:last-child, td:last-child { padding-right: 0; }
td.name { font-weight: 700; }
td.dim { color: #60646c; }
td .sub { display: block; font-weight: 400; font-size: 11px; color: #60646c; }
td.saved { color: #00824d; font-weight: 700; }
td.warn { color: #ad6200; font-weight: 700; }
tfoot td { font-weight: 700; border-top: 1.5px solid #1c2024; border-bottom: 0; }
.plan { margin: 6px 0 0; font-size: 12px; color: #60646c; }
.warn-note { color: #ad6200; }
.detail { break-before: page; }
.summary-line { font-weight: 700; margin: 0 0 10px; }
.alert { background: #f7f7f9; border-left: 3px solid #30a46c; padding: 9px 12px; margin-bottom: 8px; break-inside: avoid; }
.alert.open { border-left-color: #ce2c31; }
.alert .t { display: flex; justify-content: space-between; gap: 12px; font-weight: 700; }
.alert .s { color: #00824d; white-space: nowrap; }
.alert.open .s { color: #ce2c31; }
.alert.closed { border-left-color: #8b8d98; }
.alert.closed .s { color: #60646c; }
.alert p { margin: 3px 0 0; font-size: 12.5px; }
.alert p.c { color: #60646c; font-size: 11.5px; }
ul.method { margin: 0; padding-left: 18px; font-size: 12px; }
ul.method li { margin-bottom: 5px; }
.about { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 24px; margin: 0; font-size: 12px; }
.about div { display: grid; grid-template-columns: 124px minmax(0, 1fr); gap: 8px; }
.about dt { font-weight: 700; color: #60646c; }
.about dd { margin: 0; overflow-wrap: anywhere; }
.muted { color: #60646c; }
footer { display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid #ececf0; padding-top: 10px; margin-top: 8px; font-size: 11px; color: #8b8d98; flex-wrap: wrap; }
footer b { background: #fff5d6; color: #ad6200; padding: 1px 6px; letter-spacing: .08em; font-size: 10px; margin-right: 8px; }
footer .credit { color: #60646c; }
footer .credit strong { color: #1c2024; font-weight: 600; }
@media screen and (max-width: 720px) {
  .sheet { margin: 0; padding: 20px 16px 20px; box-shadow: none; }
  h1 { font-size: 24px; }
  .period { text-align: left; }
  .big strong { font-size: 44px; }
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .kpi .v { font-size: 22px; }
  .about { grid-template-columns: minmax(0, 1fr); }
  .about div { grid-template-columns: 112px minmax(0, 1fr); }
  .watermark { font-size: 64px; }
  /* Each row a small card: the name and the money on the first line, the rest as labelled lines under it. */
  table.stack, table.stack tbody, table.stack tfoot { display: block; }
  table.stack thead { display: none; }
  table.stack tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 12px; row-gap: 2px; padding: 8px 0; border-bottom: 1px solid #ececf0; }
  table.stack tfoot tr { border-top: 1.5px solid #1c2024; border-bottom: 0; }
  table.stack td { display: block; grid-column: 1 / -1; padding: 0; border: 0; text-align: left; white-space: normal; font-size: 12px; }
  table.stack td.lead { grid-column: 1; grid-row: 1; font-size: 13.5px; }
  table.stack td.key { grid-column: 2; grid-row: 1; text-align: right; font-size: 13.5px; white-space: nowrap; }
  table.stack td.key[data-label]::before { content: attr(data-label) "\\00A0"; font-weight: 400; color: #60646c; font-size: 12px; }
  table.stack td.row[data-label] { display: flex; justify-content: space-between; gap: 12px; }
  table.stack td.row[data-label]::before { content: attr(data-label); color: #60646c; font-weight: 400; }
  table.stack td.gap { display: none; }
  table.stack td.src { max-width: none; }
}
@media (max-width: 340px) {
  .kpis { grid-template-columns: minmax(0, 1fr); }
}
@page { size: letter; margin: 0.5in 0.55in; }
@media print {
  body { background: #ffffff; font-size: 11px; }
  h1 { font-size: 26px; }
  hr { margin: 10px 0 12px; }
  .big strong { font-size: 48px; }
  .subline { margin: 6px 0 14px; font-size: 12.5px; }
  .kpis { gap: 10px; margin-bottom: 16px; }
  .kpi { padding: 10px 10px 12px; }
  .kpi .v { font-size: 22px; }
  .kpi p { font-size: 10px; margin-top: 3px; line-height: 1.3; }
  .basis { margin: -10px 0 12px; font-size: 10.5px; }
  .note { padding: 6px 12px 7px; margin-bottom: 10px; }
  section { margin-bottom: 16px; }
  h2 { font-size: 15px; }
  .cap { font-size: 11px; margin-bottom: 6px; }
  .chart { height: 56px; }
  section { margin-bottom: 14px; }
  td { padding: 4px 8px 4px 0; }
  ul.method { font-size: 9.5px; line-height: 1.4; }
  .detail table { font-size: 10px; }
  .detail h2 { font-size: 14px; }
  ul.method li { margin-bottom: 2px; }
  .alert { padding: 6px 10px; margin-bottom: 6px; }
  .detail section:last-child { margin-bottom: 6px; }
  footer { margin-top: 4px; padding-top: 6px; break-before: avoid; }
  .about-section { margin-bottom: 0; }
  .about { display: block; font-size: 9.5px; line-height: 1.5; }
  .about div, .about dt, .about dd { display: inline; }
  .about dt { margin-right: 4px; }
  .about div + div::before { content: "\\00B7"; margin: 0 6px 0 2px; color: #8b8d98; }
  td.src { max-width: none; overflow-wrap: normal; font-size: 10px; }
  table { font-size: 10.5px; }
  .sheet { margin: 0; padding: 0; max-width: none; box-shadow: none; border-top: 0; overflow: visible; }
  .watermark { position: fixed; top: 45%; }
  .detail section { margin-bottom: 10px; }
  .detail td { padding: 3px 8px 3px 0; }
  .detail .cap, .plan { font-size: 9.5px; margin-bottom: 4px; }
  .plan { margin-top: 3px; }
  .detail .summary-line { font-size: 10.5px; margin-bottom: 6px; }
  .alert p { font-size: 10px; }
  .alert p.c { font-size: 9.5px; }
  ul.method { font-size: 9px; }
  td .sub { font-size: 9px; }
  a { color: inherit; text-decoration: none; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

function receiptBar(card: ReportCard): string {
  const whp = card.headline.whpM;
  const paidPct = whp > 0 ? Math.max(0, Math.min(100, (card.headline.paidM / whp) * 100)) : 0;
  const savedPct = whp > 0 ? 100 - paidPct : 0;
  const label = card.headline.subline.join(' · ');
  return `<svg class="bar" viewBox="0 0 1000 18" preserveAspectRatio="none" role="img" aria-label="${e(label)}"><rect x="0" y="0" width="1000" height="18" fill="#e8e8ec"/>${
    whp > 0 ? `<rect x="0" y="0" width="${(paidPct * 10).toFixed(2)}" height="18" fill="#8b8d98"/><rect x="${(paidPct * 10).toFixed(2)}" y="0" width="${(savedPct * 10).toFixed(2)}" height="18" fill="#30a46c"/>` : ''
  }</svg>`;
}

function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function trendChart(card: ReportCard): string {
  const { copy } = card;
  const pts = card.trend.points;
  const head = `<h2>${e(card.trend.title)}</h2>`;
  if (pts.length < 2) return `<section class="trend">${head}<p class="cap">${e(card.trend.empty ?? copy.trend.empty)}</p></section>`;
  const max = Math.max(1, ...pts.map((p) => p.savedM));
  const W = 1000;
  const H = 96;
  const slot = W / pts.length;
  const barW = slot * 0.72;
  const lastPartial = card.period.kind !== 'range';
  const bars = pts
    .map((p, i) => {
      const h = Math.max(0, (p.savedM / max) * (H - 4));
      const fill = lastPartial && i === pts.length - 1 ? '#a3dcbf' : '#30a46c';
      return `<rect x="${(i * slot + (slot - barW) / 2).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}"><title>${e(`${dayLabel(p.day)}: ${fmtDollars(p.savedM)}`)}</title></rect>`;
    })
    .join('');
  const grid = `<line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="#d9d9e0" stroke-width="1" vector-effect="non-scaling-stroke"/><line x1="0" y1="4" x2="${W}" y2="4" stroke="#ececf0" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  const last = dayLabel(pts[pts.length - 1].day);
  const aria = plural(copy.trend.aria, pts.length, { title: card.trend.title, amount: fmtDollars(max) });
  return `<section class="trend">${head}<p class="cap">${e(fill(copy.trend.peak, { amount: fmtDollarsCompact(max) }))}</p><svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${e(aria)}">${grid}${bars}</svg><div class="axis"><span>${e(dayLabel(pts[0].day))}</span><span>${e(lastPartial ? fill(copy.trend.soFar, { day: last }) : last)}</span></div></section>`;
}

/** A cell: `cls` for the desktop table, `role` for the phone card ('lead' name, 'key' money, 'row' labelled line). */
function cell(content: string, opts: { cls?: string; role?: 'lead' | 'key' | 'row' | 'gap'; label?: string; colspan?: number } = {}): string {
  const classes = [opts.cls, opts.role].filter(Boolean).join(' ');
  return `<td${classes ? ` class="${classes}"` : ''}${opts.label ? ` data-label="${e(opts.label)}"` : ''}${opts.colspan ? ` colspan="${opts.colspan}"` : ''}>${content}</td>`;
}

function topSavers(card: ReportCard): string {
  const { copy } = card;
  const rows = card.topSavers.rows;
  const body =
    rows.length === 0
      ? `<p class="muted">${e(copy.top.none)}</p>`
      : `<table class="stack"><thead><tr><th>${e(copy.cols.whatItDoes)}</th><th>${e(copy.cols.flow)}</th><th class="n">${e(copy.cols.volumeReduced)}</th><th class="n">${e(copy.cols.savedPerDay)}</th></tr></thead><tbody>${rows
          .map(
            (r) =>
              `<tr>${cell(e(r.label), { cls: 'name', role: 'lead' })}${cell(e(r.flow), { cls: 'dim' })}${cell(e(r.volumeRatio !== undefined ? fmtPct(r.volumeRatio) : '—'), { cls: 'n', role: 'row', label: copy.cols.volumeReduced })}${cell(e(fmtDollars(r.savedPerDayM)), { cls: 'n saved', role: 'key', label: copy.cols.savedPerDay })}</tr>`,
          )
          .join('')}</tbody></table>`;
  return `<section><h2>${e(copy.top.title)}</h2><p class="cap">${e(card.topSavers.caption)}</p>${body}</section>`;
}

function about(card: ReportCard): string {
  return `<section class="about-section"><p class="eyebrow">${e(card.copy.about.title)}</p><dl class="about">${card.about
    .map((a) => `<div><dt>${e(a.label)}</dt><dd>${e(a.value)}</dd></div>`)
    .join('')}</dl></section>`;
}

function destinations(card: ReportCard): string {
  const { copy } = card;
  const rows = card.destinations.rows;
  if (rows.length === 0) return `<section><h2>${e(copy.destinations.title)}</h2><p class="muted">${e(copy.destinations.none)}</p></section>`;
  const dash = '—';
  const money = (unpriced: boolean, mc: number) => e(unpriced ? dash : fmtDollars(mc));
  const body = rows
    .map((r) => {
      const sub = r.counterfactualNote ? `<span class="sub">${e(r.counterfactualNote)}</span>` : '';
      return `<tr>${cell(`${e(r.label)}${sub}`, { cls: 'name', role: 'lead' })}${cell(e(r.pricedAs), { cls: r.unpriced ? 'warn' : 'dim', role: 'row', label: copy.cols.pricedAs })}${cell(e(r.unpriced ? dash : fmtPricePerGb(r.mcPerGb)), { cls: 'n', role: 'row', label: copy.cols.pricePerGb })}${cell(e(fill(copy.gbPerDayValue, { in: fmtBytes(r.inBPerDay), out: fmtBytes(r.outBPerDay) })), { cls: 'n', role: 'row', label: copy.cols.gbPerDay })}${cell(money(r.unpriced, r.shown.whpM), { cls: 'n', role: 'row', label: copy.cols.whp })}${cell(money(r.unpriced, r.shown.paidM), { cls: 'n', role: 'row', label: copy.cols.paid })}${cell(money(r.unpriced, r.shown.savedM), { cls: 'n saved', role: 'key', label: copy.cols.saved })}</tr>`;
    })
    .join('');
  const t = card.destinations.totals;
  const foot = `<tfoot><tr>${cell(e(copy.destinations.total), { role: 'lead' })}${cell('', { role: 'gap' })}${cell('', { role: 'gap' })}${cell('', { role: 'gap' })}${cell(e(fmtDollars(t.whpM)), { cls: 'n', role: 'row', label: copy.cols.whp })}${cell(e(fmtDollars(t.paidM)), { cls: 'n', role: 'row', label: copy.cols.paid })}${cell(e(fmtDollars(t.savedM)), { cls: 'n saved', role: 'key', label: copy.cols.saved })}</tr></tfoot>`;
  const plan = `<p class="plan">${e(card.destinations.planNote)}</p>${card.destinations.gapNote ? `<p class="plan">${e(card.destinations.gapNote)}</p>` : ''}`;
  const note = card.destinations.unpricedNote ? `<p class="plan warn-note">${e(card.destinations.unpricedNote)}</p>` : '';
  return `<section><h2>${e(copy.destinations.title)}</h2><p class="cap">${e(card.destinations.caption)}</p><table class="stack"><thead><tr><th>${e(copy.cols.destination)}</th><th>${e(copy.cols.pricedAs)}</th><th class="n">${e(copy.cols.pricePerGb)}</th><th class="n">${e(copy.cols.gbPerDay)}</th><th class="n">${e(copy.cols.whp)}</th><th class="n">${e(copy.cols.paid)}</th><th class="n">${e(copy.cols.saved)}</th></tr></thead><tbody>${body}</tbody>${foot}</table>${plan}${note}</section>`;
}

function protection(card: ReportCard): string {
  const { copy } = card;
  const prot = card.protection;
  const alerts = prot.rows
    .map((r) => `<div class="alert ${reportIncidentTone(r.status)}"><div class="t"><span>${e(r.title)}</span><span class="s">${e(r.statusText)}</span></div><p>${e(alertLine(r, copy.cols.caught, ' · '))}</p><p class="c">${e(r.causeText)}</p></div>`)
    .join('');
  return `<section><h2>${e(copy.protection.title)}</h2><p class="cap">${e(prot.caption)}</p><p class="${prot.count > 0 ? 'summary-line' : 'muted'}">${e(prot.summary)}</p>${alerts}</section>`;
}

function methodology(card: ReportCard): string {
  return `<section><h2>${e(card.copy.methodology.title)}</h2><ul class="method">${card.methodology.map((m) => `<li>${e(m)}</li>`).join('')}</ul></section>`;
}

function prices(card: ReportCard): string {
  const { copy } = card;
  if (card.prices.length === 0) return '';
  const rows = card.prices
    .map(
      (p) =>
        `<tr>${cell(e(p.label), { cls: 'name', role: 'lead' })}${cell(e(fmtPricePerGb(p.mcPerGb)), { cls: 'n', role: 'key' })}${cell(e(p.range ?? '—'), { cls: 'n', role: 'row', label: copy.cols.range })}${cell(e(p.basis), { cls: 'dim', role: 'row', label: copy.cols.basis })}${cell(p.sourceUrl ? `<a href="${e(p.sourceUrl)}" target="_blank" rel="noopener noreferrer">${e(p.source ?? '')}</a>` : e(p.source ?? '—'), { cls: 'dim src', role: 'row', label: copy.cols.source })}</tr>`,
    )
    .join('');
  return `<section><h2>${e(copy.methodology.pricesTitle)}</h2><p class="cap">${e(copy.methodology.pricesCaption)}</p><table class="stack"><thead><tr><th>${e(copy.cols.pricedAs)}</th><th class="n">${e(copy.cols.pricePerGb)}</th><th class="n">${e(copy.cols.range)}</th><th>${e(copy.cols.basis)}</th><th>${e(copy.cols.source)}</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

/** The report card as one self-contained HTML document. */
/** The builder's signature, the name in bold: 'Made with Meter Reader, built by <strong>Steve Koelpin</strong>'. */
function credit(card: ReportCard): string {
  const at = card.credit.lastIndexOf(card.builder);
  if (at < 0) return e(card.credit);
  return `${e(card.credit.slice(0, at))}<strong>${e(card.builder)}</strong>${e(card.credit.slice(at + card.builder.length))}`;
}

export function renderReportHtml(card: ReportCard): string {
  const { copy } = card;
  const workspace = card.workspace ?? '';
  const byline = card.byline.map((b) => `<span>${e(b)}</span>`).join('');
  const band = card.sample ? `<div class="band" role="note"><b>${e(copy.sampleWatermark)}</b>${e(copy.sampleBanner)}</div>` : '';
  const note = card.note ? `<div class="note"><div class="k">${e(copy.noteLabel)}</div><p>${e(card.note)}</p></div>` : '';
  const kpis = card.kpis
    .map(
      (k) =>
        `<div class="kpi ${k.tone}"><div class="k">${e(k.label)}</div><div class="v">${e(k.value)}${k.unit ? `<small>${e(k.unit)}</small>` : ''}</div>${k.lines.map((line) => `<p>${e(line)}</p>`).join('')}</div>`,
    )
    .join('');
  const [whp, paid, pct] = card.headline.subline;
  const title = `${card.title} · ${card.period.title} · ${card.period.span}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${e(copy.brand)}">
<base target="_blank">
<title>${e(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="sheet" data-report="card"${card.sample ? ' data-sample="true"' : ''}>
${card.sample ? `<div class="watermark" aria-hidden="true">${e(copy.sampleWatermark)}</div>` : ''}
<div class="brand"><b>${e(copy.brand)}</b><span>${e(workspace)}</span></div>
<div class="titlebar"><h1>${e(card.title)}</h1><div class="period"><strong>${e(card.period.title)}</strong><span>${e(card.period.span)}</span></div></div>
<p class="byline">${byline}</p>
<hr>
${band}${note}
<section class="hero">
<div class="hero-head"><span class="eyebrow">${e(card.headline.label)}</span><span class="legend"><span><i style="background:#8b8d98"></i>${e(copy.legend.paid)}</span><span><i style="background:#30a46c"></i>${e(copy.legend.saved)}</span></span></div>
<div class="big"><strong data-figure="saved">${e(fmtDollars(card.headline.savedM))}</strong>${card.period.caption ? `<span>${e(card.period.caption)}</span>` : ''}</div>
${receiptBar(card)}
<p class="subline"><span>${e(whp ?? '')}</span><span>${e(paid ?? '')}</span><span class="pct">${e(pct ?? '')}</span></p>
${card.headline.basis ? `<p class="basis">${e(card.headline.basis)}</p>` : ''}
</section>
<div class="kpis">${kpis}</div>
${trendChart(card)}
${topSavers(card)}
${about(card)}
<div class="detail">
${destinations(card)}
${protection(card)}
${methodology(card)}
${prices(card)}
</div>
<footer>${card.sample ? `<span><b>${e(copy.sampleWatermark)}</b>${e(card.footer)}</span>` : `<span>${e(card.footer)}</span>`}<span class="credit">${credit(card)}</span></footer>
</main>
</body>
</html>
`;
}
