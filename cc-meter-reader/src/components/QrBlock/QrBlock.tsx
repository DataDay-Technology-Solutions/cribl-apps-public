// src/components/QrBlock/QrBlock.tsx — the presenter's QR (PRD 8.1, 8.8 item 8: ≥ 220 px with a one-line
// caption; DESIGN_BRIEF 5.2 bottom-right, callout `qr`). Dark modules on a light plate in BOTH themes: an
// inverted code on a dark background fails many phone scanners, and "QR scans to the repo" is a DoD line.
//
// Layouts: 'side' puts the caption beside the code, 'stack' under it (Story), 'over' stacks it ABOVE the code
// inside the code's own column (the presenter, BEAUTY F1): the caption's " · " parts become lines and the
// address may break only after a slash, so the vote ask never reaches outside the corner the incident
// takeover keeps free.

import { Fragment, useMemo, type CSSProperties, type ReactNode } from 'react';
import { t } from '../../copy/en.ts';
import { displayUrl, qrPath } from './qrPath.ts';
import './QrBlock.css';

export interface QrBlockProps {
  /** What the code opens. */
  url: string;
  /** One line beside (or under, or over) the code. */
  caption?: string;
  /** Rendered edge of the code in CSS px (≥ 220 on stage). Omit to size it from CSS (`--mr-qr-size`). */
  size?: number;
  /** Also print the address in small mono text, for anyone who can't scan. */
  showUrl?: boolean;
  /** 'side': caption to the left of the code; 'stack': caption under it; 'over': caption lines above it. */
  layout?: 'side' | 'stack' | 'over';
  callout?: string;
}

const SEP = ' · ';

/** The caption as lines at its " · " joints (the separators stay in the text for assistive tech). */
function captionLines(caption: string): ReactNode {
  const parts = caption.split(SEP);
  return parts.map((part, i) => (
    <Fragment key={i}>
      {i > 0 ? <span className="mr-visually-hidden">{SEP}</span> : null}
      <span className="mr-qr-line">{part}</span>
    </Fragment>
  ));
}

/** The address with a break opportunity after each slash only — never at a hyphen or inside a word. */
function breakableUrl(text: string): ReactNode {
  const parts = text.split('/');
  return parts.map((part, i) => (
    <Fragment key={i}>
      <span className="mr-qr-url-part">{i < parts.length - 1 ? `${part}/` : part}</span>
      {i < parts.length - 1 ? <wbr /> : null}
    </Fragment>
  ));
}

export function QrBlock({ url, caption, size, showUrl = true, layout = 'side', callout = 'qr' }: QrBlockProps) {
  const qr = useMemo(() => qrPath(url), [url]);
  const style = size ? ({ '--mr-qr-size': `${size}px` } as CSSProperties) : undefined;
  const over = layout === 'over';
  const address = displayUrl(url);
  return (
    <figure className={`mr-qr mr-qr--${layout}`} style={style}>
      <div className="mr-qr-plate" data-callout={callout}>
        <svg
          className="mr-qr-svg"
          viewBox={`0 0 ${qr.size} ${qr.size}`}
          shapeRendering="crispEdges"
          role="img"
          aria-label={t('presenter.qrAlt', { url: address })}
        >
          <path className="mr-qr-modules" d={qr.d} />
        </svg>
      </div>
      {caption || showUrl ? (
        <figcaption className="mr-qr-caption">
          {caption ? <span className="mr-qr-caption-main">{over ? captionLines(caption) : caption}</span> : null}
          {showUrl ? <span className="mr-qr-url">{over ? breakableUrl(address) : address}</span> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}
