// core/report-email.ts — the report card for an email body: HTML that survives a paste into Outlook and Gmail
// (tables for layout, every style inline, no class, no flexbox or grid, web-safe fonts, at most 640 px wide, no
// image), and a plain-text version in the receipt style (60 columns, dot leaders, right-aligned money).
// "Copy for email" puts both on the clipboard (text/html + text/plain); a mail client takes the richest one.

import type { ReportCard } from './report.ts';
import { alertLine, fill, fmtPricePerGb } from './report.ts';
import { escapeHtml as e } from './report-html.ts';
import { fmtBytes, fmtDollars, fmtPct } from './format.ts';

export const EMAIL_WIDTH = 640;
export const TEXT_WIDTH = 60;

const FONT = 'Arial, Helvetica, sans-serif';
const INK = '#1c2024';
const SUBTLE = '#60646c';
const FAINT = '#8b8d98';
const RULE = '#d9d9e0';
const HAIR = '#ececf0';
const PANEL = '#f7f7f9';
const SAVED = '#30a46c';
const SAVED_TEXT = '#00824d';
const PAID = '#8b8d98';
const WARN_TEXT = '#ad6200';
const WARN_TINT = '#fff5d6';
const DANGER = '#ce2c31';

const text = (size: number, color = INK, extra = '') => `font-family:${FONT};font-size:${size}px;line-height:1.4;color:${color};${extra}`;

function heading(title: string, caption?: string): string {
  return `<tr><td style="padding:22px 0 0 0;"><div style="${text(17, INK, 'font-weight:bold;')}">${e(title)}</div>${caption ? `<div style="${text(12, SUBTLE, 'padding-top:2px;')}">${e(caption)}</div>` : ''}</td></tr>`;
}

function th(label: string, right = false): string {
  return `<td valign="bottom" style="${text(10, SUBTLE, `font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;padding:6px 8px 6px 0;border-bottom:1px solid ${RULE};${right ? 'text-align:right;' : ''}`)}">${e(label)}</td>`;
}

function td(value: string, opts: { right?: boolean; bold?: boolean; color?: string; size?: number; sub?: string } = {}): string {
  const sub = opts.sub ? `<br><span style="${text(11, SUBTLE, 'font-weight:normal;')}">${e(opts.sub)}</span>` : '';
  return `<td valign="top" style="${text(opts.size ?? 13, opts.color ?? INK, `padding:7px 8px 7px 0;border-bottom:1px solid ${HAIR};${opts.right ? 'text-align:right;white-space:nowrap;' : ''}${opts.bold ? 'font-weight:bold;' : ''}`)}">${e(value)}${sub}</td>`;
}

function table(inner: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${inner}</table>`;
}

/** The destinations' totals row (the column sums of the printed amounts). */
function totalsRow(card: ReportCard): string {
  const { copy } = card;
  const t = card.destinations.totals;
  const cellStyle = (right: boolean, color = INK) => text(13, color, `font-weight:bold;padding:7px 8px 7px 0;border-top:2px solid ${INK};${right ? 'text-align:right;white-space:nowrap;' : ''}`);
  return `<tr><td colspan="2" style="${cellStyle(false)}">${e(copy.destinations.total)}</td><td style="${cellStyle(true)}">${e(fmtDollars(t.whpM))}</td><td style="${cellStyle(true)}">${e(fmtDollars(t.paidM))}</td><td style="${cellStyle(true, SAVED_TEXT)}">${e(fmtDollars(t.savedM))}</td></tr>`;
}

/** The report card as email-safe HTML (one outer table, inline styles only). */
export function renderReportEmailHtml(card: ReportCard): string {
  const { copy } = card;
  const rows: string[] = [];
  const workspace = card.workspace ?? '';

  // Header.
  rows.push(
    `<tr><td style="border-top:5px solid ${SAVED};padding:18px 0 0 0;">${table(
      `<tr><td style="${text(11, SAVED_TEXT, 'font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;')}">${e(copy.brand)}</td><td align="right" style="${text(11, SUBTLE)}">${e(workspace)}</td></tr>`,
    )}</td></tr>`,
  );
  rows.push(
    `<tr><td style="padding:8px 0 0 0;"><div style="${text(24, INK, 'font-weight:bold;line-height:1.2;')}">${e(card.title)}</div><div style="${text(13, INK, 'font-weight:bold;padding-top:4px;')}">${e(card.period.title)} <span style="font-weight:normal;color:${SUBTLE};">${e(card.period.span)}</span></div><div style="${text(12, SUBTLE, 'padding-top:4px;')}">${e(card.byline.join(' · '))}</div></td></tr>`,
  );
  if (card.sample) {
    rows.push(
      `<tr><td style="padding:12px 0 0 0;">${table(`<tr><td bgcolor="${WARN_TINT}" style="${text(12, WARN_TEXT, `background-color:${WARN_TINT};padding:8px 12px;`)}"><b>${e(copy.sampleWatermark)}</b> &nbsp;${e(copy.sampleBanner)}</td></tr>`)}</td></tr>`,
    );
  }
  if (card.note) {
    rows.push(
      `<tr><td style="padding:12px 0 0 0;">${table(`<tr><td bgcolor="${PANEL}" style="${text(13, INK, `background-color:${PANEL};border-left:3px solid ${SAVED};padding:8px 12px;`)}"><span style="${text(10, SUBTLE, 'font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;')}">${e(copy.noteLabel)}</span><br>${e(card.note).replace(/\r?\n/g, '<br>')}</td></tr>`)}</td></tr>`,
    );
  }

  // Hero.
  const whp = card.headline.whpM;
  const paidPct = whp > 0 ? Math.round(Math.max(0, Math.min(1, card.headline.paidM / whp)) * 100) : 0;
  const bar =
    whp > 0
      ? `<tr>${paidPct > 0 ? `<td width="${paidPct}%" height="14" bgcolor="${PAID}" style="background-color:${PAID};height:14px;font-size:0;line-height:0;">&nbsp;</td>` : ''}${paidPct < 100 ? `<td width="${100 - paidPct}%" height="14" bgcolor="${SAVED}" style="background-color:${SAVED};height:14px;font-size:0;line-height:0;">&nbsp;</td>` : ''}</tr>`
      : `<tr><td height="14" bgcolor="${HAIR}" style="background-color:${HAIR};height:14px;font-size:0;line-height:0;">&nbsp;</td></tr>`;
  const [whpText, paidText, pctText] = card.headline.subline;
  rows.push(
    `<tr><td style="padding:20px 0 0 0;"><div style="${text(11, SUBTLE, 'font-weight:bold;text-transform:uppercase;letter-spacing:0.8px;')}">${e(card.headline.label)}</div><div style="${text(48, SAVED_TEXT, 'font-weight:bold;line-height:1.1;padding:4px 0 8px 0;')}">${e(fmtDollars(card.headline.savedM))}</div>${table(bar)}<div style="${text(14, INK, 'padding-top:8px;')}">${e(whpText ?? '')} &middot; ${e(paidText ?? '')} &middot; <b style="color:${SAVED_TEXT};">${e(pctText ?? '')}</b></div>${card.headline.basis ? `<div style="${text(12, SUBTLE, 'padding-top:2px;')}">${e(card.headline.basis)}</div>` : ''}${card.period.caption ? `<div style="${text(12, SUBTLE, 'padding-top:2px;')}">${e(card.period.caption)}</div>` : ''}</td></tr>`,
  );

  // KPI tiles, two by two.
  const tile = (i: number) => {
    const k = card.kpis[i];
    if (!k) return '<td width="50%">&nbsp;</td>';
    const color = k.tone === 'saved' ? SAVED_TEXT : k.tone === 'muted' ? SUBTLE : INK;
    const border = k.tone === 'saved' ? SAVED : k.tone === 'muted' ? RULE : INK;
    return `<td width="50%" valign="top" bgcolor="${PANEL}" style="background-color:${PANEL};border-top:3px solid ${border};padding:10px 12px 12px 12px;"><div style="${text(10, SUBTLE, 'font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;')}">${e(k.label)}</div><div style="${text(k.tone === 'muted' ? 17 : 24, color, 'font-weight:bold;line-height:1.2;padding-top:4px;')}">${e(k.value)}${k.unit ? ` <span style="${text(12, SUBTLE, 'font-weight:normal;')}">${e(k.unit)}</span>` : ''}</div>${k.lines.map((l) => `<div style="${text(12, SUBTLE, 'padding-top:3px;')}">${e(l)}</div>`).join('')}</td>`;
  };
  const gapCell = '<td width="12" style="font-size:0;line-height:0;">&nbsp;</td>';
  rows.push(
    `<tr><td style="padding:18px 0 0 0;">${table(`<tr>${tile(0)}${gapCell}${tile(1)}</tr><tr><td colspan="3" height="12" style="font-size:0;line-height:0;height:12px;">&nbsp;</td></tr><tr>${tile(2)}${gapCell}${tile(3)}</tr>`)}</td></tr>`,
  );

  // Top savers.
  rows.push(heading(copy.top.title, card.topSavers.caption));
  if (card.topSavers.rows.length === 0) rows.push(`<tr><td style="${text(13, SUBTLE, 'padding-top:6px;')}">${e(copy.top.none)}</td></tr>`);
  else
    rows.push(
      `<tr><td style="padding-top:8px;">${table(
        `<tr>${th(copy.cols.whatItDoes)}${th(copy.cols.volumeReduced, true)}${th(copy.cols.savedPerDay, true)}</tr>${card.topSavers.rows
          .map(
            (r) =>
              `<tr>${td(r.label, { bold: true, sub: r.flow })}${td(r.volumeRatio !== undefined ? fmtPct(r.volumeRatio) : '—', { right: true })}${td(fmtDollars(r.savedPerDayM), { right: true, bold: true, color: SAVED_TEXT })}</tr>`,
          )
          .join('')}`,
      )}</td></tr>`,
    );

  // Where the money goes.
  rows.push(heading(copy.destinations.title, card.destinations.caption));
  if (card.destinations.rows.length === 0) rows.push(`<tr><td style="${text(13, SUBTLE, 'padding-top:6px;')}">${e(copy.destinations.none)}</td></tr>`);
  else {
    const dash = '—';
    rows.push(
      `<tr><td style="padding-top:8px;">${table(
        `<tr>${th(copy.cols.destination)}${th(copy.cols.pricePerGb, true)}${th(copy.cols.whp, true)}${th(copy.cols.paid, true)}${th(copy.cols.saved, true)}</tr>${card.destinations.rows
          .map((r) => {
            const sub = [r.unpriced ? r.pricedAs : r.pricedAs !== r.label ? r.pricedAs : '', fill(copy.gbPerDayValue, { in: fmtBytes(r.inBPerDay), out: fmtBytes(r.outBPerDay) }), r.counterfactualNote ?? ''].filter(Boolean).join(' · ');
            return `<tr>${td(r.label, { bold: true, sub })}${td(r.unpriced ? dash : fmtPricePerGb(r.mcPerGb), { right: true })}${td(r.unpriced ? dash : fmtDollars(r.shown.whpM), { right: true })}${td(r.unpriced ? dash : fmtDollars(r.shown.paidM), { right: true })}${td(r.unpriced ? dash : fmtDollars(r.shown.savedM), { right: true, bold: true, color: SAVED_TEXT })}</tr>`;
          })
          .join('')}${totalsRow(card)}`,
      )}</td></tr>`,
    );
    rows.push(`<tr><td style="${text(12, SUBTLE, 'padding-top:6px;')}">${e(card.destinations.planNote)}</td></tr>`);
    if (card.destinations.gapNote) rows.push(`<tr><td style="${text(12, SUBTLE, 'padding-top:6px;')}">${e(card.destinations.gapNote)}</td></tr>`);
    if (card.destinations.unpricedNote) rows.push(`<tr><td style="${text(12, WARN_TEXT, 'padding-top:6px;')}">${e(card.destinations.unpricedNote)}</td></tr>`);
  }

  // Protection.
  const prot = card.protection;
  rows.push(heading(copy.protection.title, prot.caption));
  rows.push(`<tr><td style="${text(13, prot.count > 0 ? INK : SUBTLE, `padding-top:6px;${prot.count > 0 ? 'font-weight:bold;' : ''}`)}">${e(prot.summary)}</td></tr>`);
  for (const r of prot.rows) {
    const second = alertLine(r, copy.cols.caught, ' · ');
    const border = r.status === 'open' ? DANGER : SAVED;
    rows.push(
      `<tr><td style="padding-top:8px;">${table(`<tr><td bgcolor="${PANEL}" style="${text(13, INK, `background-color:${PANEL};border-left:3px solid ${border};padding:8px 12px;`)}"><b>${e(r.title)}</b> &nbsp;<span style="color:${border};font-weight:bold;">${e(r.statusText)}</span><br>${e(second)}<br><span style="color:${SUBTLE};font-size:12px;">${e(r.causeText)}</span></td></tr>`)}</td></tr>`,
    );
  }

  // How the numbers are made, prices, about.
  rows.push(heading(copy.methodology.title));
  rows.push(`<tr><td style="padding-top:6px;">${card.methodology.map((m) => `<div style="${text(12, INK, 'padding:0 0 5px 0;')}">&bull; ${e(m)}</div>`).join('')}</td></tr>`);
  if (card.prices.length > 0) {
    rows.push(heading(copy.methodology.pricesTitle, copy.methodology.pricesCaption));
    rows.push(
      `<tr><td style="padding-top:8px;">${table(
        `<tr>${th(copy.cols.pricedAs)}${th(copy.cols.pricePerGb, true)}${th(copy.cols.range, true)}${th(copy.cols.basis)}</tr>${card.prices
          .map((p) => `<tr>${td(p.label, { bold: true, size: 12, ...(p.source ? { sub: p.source } : {}) })}${td(fmtPricePerGb(p.mcPerGb), { right: true, size: 12 })}${td(p.range ?? '—', { right: true, size: 12 })}${td(p.basis, { size: 12, color: SUBTLE })}</tr>`)
          .join('')}`,
      )}</td></tr>`,
    );
  }
  rows.push(heading(copy.about.title));
  rows.push(
    `<tr><td style="padding-top:6px;">${table(card.about.map((a) => `<tr><td valign="top" width="140" style="${text(12, SUBTLE, 'font-weight:bold;padding:2px 8px 2px 0;')}">${e(a.label)}</td><td valign="top" style="${text(12, INK, 'padding:2px 0;')}">${e(a.value)}</td></tr>`).join(''))}</td></tr>`,
  );
  rows.push(`<tr><td style="${text(11, FAINT, 'padding:16px 0 2px 0;')}">${card.sample ? `<b style="color:${WARN_TEXT};">${e(copy.sampleWatermark)}</b> &middot; ` : ''}${e(card.footer)}</td></tr>`);
  // The builder's signature, under the footer, the name in bold (the HTML file's footer reads the same).
  const byAt = card.credit.lastIndexOf(card.builder);
  const credit = byAt < 0 ? e(card.credit) : `${e(card.credit.slice(0, byAt))}<b style="color:${INK};">${e(card.builder)}</b>${e(card.credit.slice(byAt + card.builder.length))}`;
  rows.push(`<tr><td style="${text(11, SUBTLE, `padding:0 0 4px 0;border-bottom:1px solid ${HAIR};`)}">${credit}</td></tr>`);

  return `<table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${EMAIL_WIDTH}px;border-collapse:collapse;background-color:#ffffff;">${rows.join('')}</table>`;
}

// ─── Plain text ──────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

const GLUE = '\u00a0';

/**
 * Keeps a timestamp, an amount of data and a duration on one line: '2026-09-25 20:30 UTC', '3:30 PM CDT',
 * '605.0 GB' and '2 min 51 s' are glued with no-break spaces, which wrap() never breaks on and turns back into
 * plain spaces.
 */
function glue(s: string): string {
  return s
    // core/format fmtDurationShort already joins each number to its unit with U+00A0; the space between parts is glued here.
    .replace(/\d+[ \u00a0](?:d|h|min|s)(?:[ \u00a0]\d+[ \u00a0](?:h|min|s))?(?=$|[\s.,;:)])/g, (m) => m.replaceAll(' ', GLUE))
    .replace(/(\d[\d.,]*) (B|KB|MB|GB|TB|PB)(?=$|[\s.,;:)])/g, `$1${GLUE}$2`)
    .replace(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/g, `$1${GLUE}$2${GLUE}UTC`)
    .replace(/(\d{1,2}:\d{2}) (AM|PM)(?: ([A-Z]{2,5}|GMT[+-]\d{1,2}(?::\d{2})?))?/g, (_m, time: string, ampm: string, zone?: string) => `${time}${GLUE}${ampm}${zone ? `${GLUE}${zone}` : ''}`);
}

/** Word wrap to the text width, with an optional indent on every line (breaks at plain spaces only). */
function wrap(s: string, width = TEXT_WIDTH, indent = ''): string[] {
  const out: string[] = [];
  let line = '';
  const push = (l: string) => out.push((indent + l).replaceAll(GLUE, ' '));
  for (const word of glue(s).split(/[ \t\r\n]+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (indent.length + candidate.length <= width) line = candidate;
    else {
      if (line) push(line);
      line = word.length + indent.length > width ? truncate(word, width - indent.length) : word;
    }
  }
  if (line) push(line);
  return out;
}

/** 'label ........ amount' to exactly the width (the label is cut when it must be; at least two dots). */
function leader(label: string, amount: string, width = TEXT_WIDTH): string {
  const room = width - amount.length - 4;
  const l = truncate(label, room);
  return `${l} ${'.'.repeat(Math.max(2, width - l.length - amount.length - 2))} ${amount}`;
}

/** 'left      right', right-aligned to the width; two lines when both don't fit. */
function spread(left: string, right: string, width = TEXT_WIDTH): string[] {
  const gap = width - left.length - right.length;
  return gap >= 2 ? [`${left}${' '.repeat(gap)}${right}`] : [...wrap(left, width), right.padStart(width)];
}

/** The report card as plain text, at most 60 columns a line. */
export function renderReportText(card: ReportCard): string {
  const { copy } = card;
  const rule = '-'.repeat(TEXT_WIDTH);
  const double = '='.repeat(TEXT_WIDTH);
  const out: string[] = [];
  out.push(truncate(`${copy.brand.toUpperCase()} · ${card.title}`, TEXT_WIDTH));
  out.push(...wrap(`${card.period.title} · ${card.period.span}`));
  for (const b of card.byline) out.push(...wrap(b));
  if (card.sample) out.push('', ...wrap(`${copy.sampleWatermark}: ${copy.sampleBanner}`));
  if (card.note) {
    out.push('');
    const [first, ...rest] = card.note.split(/\r?\n/);
    out.push(...wrap(`${copy.noteLabel}: ${first ?? ''}`));
    for (const line of rest) out.push(...(line.trim() === '' ? [''] : wrap(line, TEXT_WIDTH, '  ')));
  }
  out.push(double);
  out.push(...spread(card.headline.label, fmtDollars(card.headline.savedM)));
  out.push(...wrap(card.headline.subline.join(' · ')));
  if (card.headline.basis) out.push(...wrap(card.headline.basis));
  if (card.period.caption) out.push(...wrap(card.period.caption));
  out.push(rule);
  for (const k of card.kpis) {
    out.push(leader(k.label, `${k.value}${k.unit ? ` ${k.unit}` : ''}`));
    for (const l of k.lines) out.push(...wrap(l, TEXT_WIDTH, '  '));
  }
  out.push(rule);
  out.push(copy.text.topSavers);
  if (card.topSavers.rows.length === 0) out.push(...wrap(copy.top.none));
  for (const r of card.topSavers.rows) {
    out.push(leader(r.label, fmtDollars(r.savedPerDayM)));
    const pct = r.volumeRatio !== undefined ? `${copy.cols.volumeReduced} ${fmtPct(r.volumeRatio)}` : '';
    out.push(...wrap([r.flow, pct].filter(Boolean).join(' · '), TEXT_WIDTH, '  '));
  }
  out.push(...wrap(card.topSavers.caption));
  out.push(rule);
  out.push(copy.text.destinations);
  if (card.destinations.rows.length === 0) out.push(...wrap(copy.destinations.none));
  for (const r of card.destinations.rows) {
    out.push(leader(r.label, r.unpriced ? r.pricedAs : fmtDollars(r.shown.savedM)));
    if (!r.unpriced)
      out.push(
        ...wrap(
          `${r.pricedAs} ${fmtPricePerGb(r.mcPerGb)}/GB · ${copy.cols.whp} ${fmtDollars(r.shown.whpM)} · ${copy.cols.paid} ${fmtDollars(r.shown.paidM)}${r.counterfactualNote ? ` · ${r.counterfactualNote}` : ''}`,
          TEXT_WIDTH,
          '  ',
        ),
      );
  }
  if (card.destinations.rows.some((r) => !r.unpriced)) {
    const t = card.destinations.totals;
    out.push(leader(copy.destinations.total, fmtDollars(t.savedM)));
    out.push(...wrap(`${copy.cols.whp} ${fmtDollars(t.whpM)} · ${copy.cols.paid} ${fmtDollars(t.paidM)}`, TEXT_WIDTH, '  '));
    out.push(...wrap(card.destinations.planNote));
    if (card.destinations.gapNote) out.push(...wrap(card.destinations.gapNote));
  }
  if (card.destinations.unpricedNote) out.push(...wrap(card.destinations.unpricedNote));
  out.push(rule);
  out.push(copy.text.protection);
  out.push(...wrap(card.protection.summary));
  for (const r of card.protection.rows) {
    out.push(...wrap(`[${r.statusText}] ${r.title}`, TEXT_WIDTH, '  '));
    out.push(...wrap(alertLine(r, copy.cols.caught, ' · '), TEXT_WIDTH, '    '));
    out.push(...wrap(r.causeText, TEXT_WIDTH, '    '));
  }
  out.push(rule);
  out.push(copy.methodology.title);
  for (const m of card.methodology) out.push(...wrap(m, TEXT_WIDTH, '  ').map((l, i) => (i === 0 ? `-${l.slice(1)}` : l)));
  if (card.prices.length > 0) out.push(copy.methodology.pricesTitle);
  for (const p of card.prices) out.push(...wrap(`${p.label} ${fmtPricePerGb(p.mcPerGb)}/GB${p.range ? ` (${p.range})` : ''} · ${p.basis}${p.source ? ` · ${p.source}` : ''}`, TEXT_WIDTH, '  '));
  out.push(rule);
  for (const a of card.about) out.push(...wrap(`${a.label}: ${a.value}`));
  out.push(...wrap(card.footer));
  out.push(...wrap(card.credit));
  // Plain text is plain: a no-break space a formatter put in (a duration) reads as a space in any mail client.
  return out.map((l) => l.replaceAll(GLUE, ' ').replace(/\s+$/, '')).join('\n');
}

/** Both parts of the email paste. */
export function renderReportEmail(card: ReportCard): { html: string; text: string } {
  return { html: renderReportEmailHtml(card), text: renderReportText(card) };
}
