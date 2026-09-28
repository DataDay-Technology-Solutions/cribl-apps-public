// src/components/common/Ghost.tsx — a static, 40 % "ghost" of the real layout for empty and waiting states
// (DESIGN_BRIEF 6 "skeleton matching final layout", BEAUTY F14): table rows, a chart, receipt lines, destination
// bars, a Flow map outline or a stack of setting cards. Decorative only (aria-hidden), neutral tokens only, never
// animated.

import type { JSX } from 'react';
import './common.css';

export type GhostShape = 'rows' | 'chart' | 'list' | 'bars' | 'flow' | 'card';

/** Widths (%) of the text bars in each ghost table row, so the rows don't look stamped. */
const ROW_WIDTHS = [
  [62, 44, 30],
  [48, 36, 22],
  [56, 28, 26],
] as const;

function Rows() {
  return (
    <div className="mr-ghost-rows">
      <div className="mr-ghost-row mr-ghost-row--head">
        <span className="mr-ghost-bar" style={{ width: '14%' }} />
        <span className="mr-ghost-bar" style={{ width: '10%' }} />
        <span className="mr-ghost-fill" />
        <span className="mr-ghost-bar" style={{ width: '8%' }} />
      </div>
      {ROW_WIDTHS.map(([a, b, c], i) => (
        <div key={i} className="mr-ghost-row">
          <span className="mr-ghost-bar" style={{ width: `${a / 3}%` }} />
          <span className="mr-ghost-bar" style={{ width: `${b / 3}%` }} />
          <span className="mr-ghost-fill" />
          <span className="mr-ghost-bar" style={{ width: `${c / 3}%` }} />
        </div>
      ))}
    </div>
  );
}

function Chart() {
  return (
    <svg className="mr-ghost-svg" viewBox="0 0 400 120" preserveAspectRatio="none" focusable="false">
      <line className="mr-ghost-grid" x1="0" x2="400" y1="20" y2="20" vectorEffect="non-scaling-stroke" />
      <line className="mr-ghost-grid" x1="0" x2="400" y1="60" y2="60" vectorEffect="non-scaling-stroke" />
      <line className="mr-ghost-axis" x1="0" x2="400" y1="100" y2="100" vectorEffect="non-scaling-stroke" />
      <path
        className="mr-ghost-line"
        d="M0,62 C40,58 70,66 110,60 S180,54 220,58 S300,50 340,54 S380,52 400,50"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function List() {
  return (
    <div className="mr-ghost-list">
      {[58, 44, 50].map((w, i) => (
        <div key={i} className="mr-ghost-line-item">
          <span className="mr-ghost-bar" style={{ width: `${w * 0.5}%` }} />
          <span className="mr-ghost-dots" />
          <span className="mr-ghost-bar" style={{ width: '14%' }} />
        </div>
      ))}
    </div>
  );
}

function Bars() {
  return (
    <div className="mr-ghost-bars">
      {[92, 64, 38].map((w, i) => (
        <div key={i} className="mr-ghost-bars-row">
          <span className="mr-ghost-bar" style={{ width: '22%' }} />
          <span className="mr-ghost-track">
            <span className="mr-ghost-track-fill" style={{ width: `${w}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function Flow() {
  return (
    <svg className="mr-ghost-svg mr-ghost-svg--flow" viewBox="0 0 400 160" preserveAspectRatio="none" focusable="false">
      <path className="mr-ghost-ribbon" d="M16,18 C200,18 200,36 384,36 L384,72 C200,72 200,52 16,52 Z" />
      <path className="mr-ghost-ribbon" d="M16,64 C200,64 200,80 384,80 L384,100 C200,100 200,88 16,88 Z" />
      <path className="mr-ghost-ribbon" d="M16,100 C200,100 200,108 384,108 L384,140 C200,140 200,142 16,142 Z" />
      <rect className="mr-ghost-node" x="4" y="14" width="12" height="132" rx="2" />
      <rect className="mr-ghost-node" x="384" y="32" width="12" height="112" rx="2" />
    </svg>
  );
}

/** Title widths (%) of the two ghost cards, so the stack doesn't look stamped. */
const CARD_TITLES = [34, 26] as const;

/**
 * Two stacked setting cards (Settings → Where to send alerts): a title with its badge and an on/off switch on
 * the first row, a line of description beside a field, then the card's one action under a hairline.
 */
function Card() {
  return (
    <div className="mr-ghost-cards">
      {CARD_TITLES.map((w, i) => (
        <div key={i} className="mr-ghost-card">
          <div className="mr-ghost-card-head">
            <span className="mr-ghost-bar mr-ghost-bar--title" style={{ width: `${w}%` }} />
            <span className="mr-ghost-pill" />
            <span className="mr-ghost-fill" />
            <span className="mr-ghost-switch" />
          </div>
          <div className="mr-ghost-card-body">
            <span className="mr-ghost-bar" style={{ width: `${48 - i * 8}%` }} />
            <span className="mr-ghost-fill" />
            <span className="mr-ghost-field" />
          </div>
          <div className="mr-ghost-card-foot">
            <span className="mr-ghost-button" />
          </div>
        </div>
      ))}
    </div>
  );
}

const SHAPES: Record<GhostShape, () => JSX.Element> = { rows: Rows, chart: Chart, list: List, bars: Bars, flow: Flow, card: Card };

/** The ghost of `shape`, faded to 40 %; purely decorative. */
export function Ghost({ shape, className }: { shape: GhostShape; className?: string }) {
  const Shape = SHAPES[shape];
  return (
    <div className={['mr-ghost', `mr-ghost--${shape}`, className].filter(Boolean).join(' ')} aria-hidden="true" data-ghost={shape}>
      <Shape />
    </div>
  );
}
