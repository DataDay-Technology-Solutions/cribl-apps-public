// src/components/SlackPreview/mrkdwn.tsx — Slack mrkdwn → React nodes, safely (no innerHTML).
//
// The subset Meter Reader's payloads use (core/payloads.ts), rendered the way Slack renders it:
//   *bold*  _italic_  ~strike~  `code`  ```code block```  <url|text> / <url>  :emoji_shortcode:
//   &amp; &lt; &gt; entities, and \n line breaks.
// Emoji shortcodes Meter Reader sends (the severity glyph and the receipt) become drawn glyphs rather than
// emoji characters, so they render identically on every OS and in headless browsers. Unknown shortcodes
// stay as text, as Slack shows an unknown emoji name.

import type { ReactNode } from 'react';
import { SHORTCODE_GLYPHS } from './glyphs.ts';
import { SlackGlyph } from './SlackGlyph.tsx';

/** Decodes the three entities Slack escapes in mrkdwn. */
export function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Inline tokens, in priority order. Code first so nothing inside backticks is formatted. As in Slack, *, _
// and ~ only format at word boundaries and never around whitespace, so `mrd_pay_sample` stays literal.
const B = '(?<![A-Za-z0-9])';
const E = '(?![A-Za-z0-9])';
const INLINE = new RegExp(
  [
    '(`[^`\\n]+`)',
    '(<[^<>\\s|]+(?:\\|[^<>]+)?>)',
    `(${B}\\*[^*\\s](?:[^*\\n]*[^*\\s])?\\*${E})`,
    `(${B}_[^_\\s](?:[^_\\n]*[^_\\s])?_${E})`,
    `(${B}~[^~\\s](?:[^~\\n]*[^~\\s])?~${E})`,
    '(:[a-z0-9_+-]+:)',
  ].join('|'),
  'g',
);

/**
 * Inline mrkdwn (one line, no code blocks) → nodes. `emojiOnly` is for plain_text (only shortcodes apply).
 *
 * Keys are the node's place in this call's output (`keyPrefix` + kind + index), so the same text yields the same
 * keys on every render and React updates the nodes in place. A counter shared across renders gave every node a new
 * key each time, so any re-render of the parent remounted the whole message; with the Settings test preview on
 * screen, WebKit then moved a page scrolled to its end by 72 px in the middle of a click, and the press that had
 * begun on "Send a test alert" ended off the button (leftovers: Safari's first click did nothing).
 */
export function renderInline(text: string, emojiOnly = false, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let seq = 0;
  const nextKey = (kind: string): string => `${keyPrefix}${kind}${seq++}`;
  let last = 0;
  // A fresh matcher per call: bold/italic recurse, and a shared /g regex would lose its place.
  const re = new RegExp(INLINE.source, 'g');
  const source = text ?? '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const [whole, code, link, bold, italic, strike, emoji] = m;
    if (emojiOnly && !emoji) continue;
    if (m.index > last) out.push(decodeEntities(source.slice(last, m.index)));
    if (code) {
      out.push(
        <code key={nextKey('c')} className="mr-slack-code">
          {decodeEntities(code.slice(1, -1))}
        </code>,
      );
    } else if (link) {
      const inner = link.slice(1, -1);
      const bar = inner.indexOf('|');
      const label = bar >= 0 ? inner.slice(bar + 1) : inner;
      out.push(
        <span key={nextKey('l')} className="mr-slack-link">
          {decodeEntities(label)}
        </span>,
      );
    } else if (bold) {
      out.push(<strong key={nextKey('b')}>{renderInline(bold.slice(1, -1))}</strong>);
    } else if (italic) {
      out.push(<em key={nextKey('i')}>{renderInline(italic.slice(1, -1))}</em>);
    } else if (strike) {
      out.push(<s key={nextKey('s')}>{renderInline(strike.slice(1, -1))}</s>);
    } else if (emoji) {
      const glyph = SHORTCODE_GLYPHS[emoji.slice(1, -1)];
      out.push(glyph ? <SlackGlyph key={nextKey('e')} name={glyph} /> : whole);
    }
    last = m.index + whole.length;
  }
  if (last < source.length) out.push(decodeEntities(source.slice(last)));
  return out;
}

/** Marks the receipt's total line so Story mode and the video can point at it (DESIGN_BRIEF 8). */
function isReceiptTotal(line: string): boolean {
  return /^Saved by Cribl\b/.test(line.trim());
}

/**
 * The order a code block's lines print in when revealed a line at a time (P2-W12, Story mode's Monday receipt):
 * top to bottom, the receipt's total last, so it lands on a receipt already printed around it.
 */
export function printOrder(lines: readonly string[]): number[] {
  const rest = lines.map((l, i) => ({ l, i })).filter((x) => !isReceiptTotal(x.l));
  const totals = lines.map((l, i) => ({ l, i })).filter((x) => isReceiptTotal(x.l));
  const rank: number[] = [];
  [...rest, ...totals].forEach((x, k) => (rank[x.i] = k));
  return rank;
}

/**
 * A ``` block: monospace, whitespace preserved (the weekly receipt's dot leaders depend on it). With `reveal`,
 * only that many lines show (in printOrder); the others keep their room, hidden, so nothing moves as they land.
 */
function codeBlock(text: string, key: string, reveal?: number): ReactNode {
  const body = decodeEntities(text.replace(/^\n/, '').replace(/\n$/, ''));
  const lines = body.split('\n');
  const rank = reveal === undefined ? null : printOrder(lines);
  return (
    <pre key={key} className="mr-slack-pre">
      {lines.map((line, i) => {
        const shown = rank === null ? undefined : rank[i] < (reveal ?? 0);
        return (
          <span
            key={i}
            className="mr-slack-pre-line"
            data-callout={isReceiptTotal(line) ? 'receipt-total' : undefined}
            data-shown={shown === undefined ? undefined : String(shown)}
            style={shown === false ? { visibility: 'hidden' } : undefined}
          >
            {line}
            {i < lines.length - 1 ? '\n' : ''}
          </span>
        );
      })}
    </pre>
  );
}

/**
 * Full mrkdwn → nodes: code blocks, then lines (with <br>) of inline formatting. `revealLines` shows only that
 * many of each code block's lines (SlackPreview's print-a-line-at-a-time, P2-W12); omitted, everything shows.
 */
export function renderMrkdwn(text: string, revealLines?: number): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = (text ?? '').split(/```/);
  parts.forEach((part, index) => {
    const inCode = index % 2 === 1 && index < parts.length - 1;
    if (inCode) {
      out.push(codeBlock(part, `pre${index}`, revealLines));
      return;
    }
    // An unmatched trailing ``` is literal text, as in Slack.
    const literal = index % 2 === 1 ? `\`\`\`${part}` : part;
    const lines = literal.split('\n');
    lines.forEach((line, li) => {
      if (li > 0) out.push(<br key={`br${index}.${li}`} />);
      // Every line's nodes join one list: the prefix keeps their keys apart (and the same on every render).
      out.push(...renderInline(line, false, `${index}.${li}:`));
    });
  });
  return out;
}
