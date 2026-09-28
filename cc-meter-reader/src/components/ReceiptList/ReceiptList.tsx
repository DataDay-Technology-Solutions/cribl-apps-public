// src/components/ReceiptList/ReceiptList.tsx — itemized money lines with dot leaders, set in Capra's mono
// face (DESIGN_BRIEF §1 "The receipt"): `Windows event trimming ........ $1,340 / day`.
//
// Used by the Receipt view's "What's saving the most" (size 'md', with its total lines), the hero's other-period
// aside (lines that are buttons: `onPress` switches the period) and the calm Alerts card (counts as `valueText`);
// reusable by the Presenter view's top-five list (size 'lg' ≥ 32 px) and any other receipt in the app (a
// negative line printed with a real minus sign by core/format, and a `total` line under a dotted rule — never
// a solid rule, BEAUTY F13). A line with `href` is a deep link out of the app iframe (target `_top`, AGENTS.md
// "Linking Out of Your App").
//
// A label never ellipsises (P1-H02): it wraps, and the dot leader runs on its LAST line, from the end of the
// words to the amount — like a long item on a printed receipt. The leader is anchored to the words (a
// zero-width marker after the last character), so it starts one character after them on whichever line they
// end, and it is cut at the last whole character cell before the amount (ReceiptList.css).

import type { ReactNode } from 'react';
import { ArrowUpRightFromSquare } from '@capra/icons';
import { t } from '../../copy/en.ts';
import { formatMoney } from '../../lib/format.ts';
import './ReceiptList.css';

export interface ReceiptLine {
  id: string;
  label: string;
  /** Integer millicents. */
  amountM: number;
  /** Printed in the amount's place instead of money (a count, a time), in the neutral tone. */
  valueText?: string;
  per?: 'day' | 'year' | 'hour';
  /** Deep link to the object in the Cribl UI. */
  href?: string;
  /** Accessible name for the link ("Open Payments API sampling in Cribl"), or for the button (`onPress`). */
  hrefLabel?: string;
  /** Tooltip (e.g. the reduction ratio). */
  title?: string;
  /** 'saved' (default) prints the amount in the money green; 'neutral' for costs and other non-savings lines. */
  tone?: 'saved' | 'neutral';
  /** The bottom line of a receipt: semibold, under a dotted rule. */
  total?: boolean;
  /** A line that is a control inside the app (the hero's periods): rendered as a button. */
  onPress?: () => void;
  /** A secondary line: subtle label (e.g. "4 other flows"). */
  muted?: boolean;
  /** Test hook on the line. */
  testId?: string;
}

export interface ReceiptListProps {
  lines: ReceiptLine[];
  size?: 'md' | 'lg';
  /** Accessible name of the list. */
  ariaLabel: string;
  /** Link target when leaving the app: '_top' (default) or '_blank'. */
  target?: '_top' | '_blank';
  /** Rendered instead of the list when there are no lines. */
  empty?: ReactNode;
  className?: string;
  /** Keep the out-link glyph's width on every line, so a list below a linked one keeps its right edge. */
  linkSlot?: boolean;
}

const PER: Record<NonNullable<ReceiptLine['per']>, () => string> = {
  day: () => t('units.perDay'),
  year: () => t('units.perYear'),
  hour: () => t('units.perHour'),
};

/**
 * `linked` draws the out-link glyph; `slot` keeps its width empty on a line without a link, so in a list where
 * some lines link out (Top savers) every amount still ends on the same right edge (the total lines included).
 */
function LineBody({ line, linked, slot }: { line: ReceiptLine; linked: boolean; slot: boolean }) {
  return (
    <>
      <span className="mr-rlist-labelbox">
        <span className="mr-rlist-label">
          {line.label}
          {/* The leader's anchor: zero width, right after the last character, on the words' last line. */}
          <span className="mr-rlist-leader" aria-hidden="true" />
        </span>
      </span>
      <span className={`mr-rlist-amount mr-num${line.tone === 'neutral' || line.valueText !== undefined ? ' mr-rlist-amount--neutral' : ''}`}>
        {line.valueText ?? formatMoney(line.amountM)}
      </span>
      {line.per ? <span className="mr-rlist-per">{PER[line.per]()}</span> : null}
      {linked ? (
        <span className="mr-rlist-go" aria-hidden="true">
          <ArrowUpRightFromSquare size="xs" />
        </span>
      ) : slot ? (
        <span className="mr-rlist-go mr-rlist-go--slot" aria-hidden="true" />
      ) : null}
    </>
  );
}

function itemClass(line: ReceiptLine): string {
  return ['mr-rlist-item', line.total ? 'mr-rlist-item--total' : '', line.muted ? 'mr-rlist-item--muted' : ''].filter(Boolean).join(' ');
}

export function ReceiptList({ lines, size = 'md', ariaLabel, target = '_top', empty, className, linkSlot = false }: ReceiptListProps) {
  if (lines.length === 0) return empty ? <>{empty}</> : null;
  const slot = linkSlot || lines.some((l) => l.href);
  return (
    <ol className={['mr-rlist', `mr-rlist--${size}`, className].filter(Boolean).join(' ')} aria-label={ariaLabel}>
      {lines.map((line) => (
        <li key={line.id} className={itemClass(line)} data-testid={line.testId}>
          {line.href ? (
            <a
              className="mr-rlist-line mr-rlist-line--link"
              href={line.href}
              target={target}
              rel={target === '_blank' ? 'noopener noreferrer' : undefined}
              aria-label={line.hrefLabel}
              title={line.title}
            >
              <LineBody line={line} linked slot={slot} />
            </a>
          ) : line.onPress ? (
            <button
              type="button"
              className="mr-rlist-line mr-rlist-line--button"
              onClick={line.onPress}
              aria-label={line.hrefLabel}
              title={line.title}
            >
              <LineBody line={line} linked={false} slot={slot} />
            </button>
          ) : (
            <span className="mr-rlist-line" title={line.title}>
              <LineBody line={line} linked={false} slot={slot} />
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
