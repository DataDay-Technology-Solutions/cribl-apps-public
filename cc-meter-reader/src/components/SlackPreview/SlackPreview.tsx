// src/components/SlackPreview/SlackPreview.tsx — a faithful Block Kit renderer framed like a Slack message
// (DESIGN_BRIEF 5.8, PRD 8.8 item 10). Used by Settings (test results), Story beat 6 and the incident card's
// "Show the Slack message" expansion.
//
// Supports exactly what Meter Reader sends (core/payloads.ts slackPayload): `header` (plain_text), `section`
// with `text` and/or a two-column `fields` grid, `context`, `actions` (buttons) and `divider`. Unknown
// blocks are skipped, as a Slack client skips blocks it cannot draw. The button is drawn, not wired: a
// preview never navigates.

import { useMemo, type ReactNode } from 'react';
import { t } from '../../copy/en.ts';
import { renderInline, renderMrkdwn } from './mrkdwn.tsx';
import { toSlackMessage, type Block, type TextObject } from './message.ts';
import './SlackPreview.css';

function textOf(obj: TextObject | string | undefined): {
  text: string;
  mrkdwn: boolean;
} {
  if (typeof obj === 'string') return { text: obj, mrkdwn: false };
  return { text: obj?.text ?? '', mrkdwn: obj?.type === 'mrkdwn' };
}

function RichText({ value, reveal }: { value: TextObject | string | undefined; reveal?: number }) {
  const { text, mrkdwn } = textOf(value);
  return <>{mrkdwn ? renderMrkdwn(text, reveal) : renderInline(text, true)}</>;
}

function renderBlock(block: Block, index: number, reveal?: number): ReactNode {
  switch (block.type) {
    case 'header': {
      // The header lays its glyph out with a flex gap, so the space after a leading shortcode goes.
      const text = block.text
        ? {
            ...block.text,
            text: (block.text.text ?? '').replace(/^(:[a-z0-9_+-]+:)\s+/, '$1'),
          }
        : undefined;
      return (
        <div key={index} className="mr-slack-header">
          <RichText value={text} />
        </div>
      );
    }
    case 'section':
      return (
        <div key={index} className="mr-slack-section">
          {block.text ? (
            <div className="mr-slack-section-text">
              <RichText value={block.text} reveal={reveal} />
            </div>
          ) : null}
          {block.fields && block.fields.length > 0 ? (
            <div className="mr-slack-fields">
              {block.fields.map((f, i) => (
                <div key={i} className="mr-slack-field">
                  <RichText value={f} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      );
    case 'context':
      return (
        <div key={index} className="mr-slack-context">
          {(block.elements ?? [])
            .filter((el) => el.type === 'mrkdwn' || el.type === 'plain_text')
            .map((el, i) => (
              <span key={i} className="mr-slack-context-item">
                <RichText
                  value={{
                    type: el.type,
                    text: typeof el.text === 'string' ? el.text : el.text?.text,
                  }}
                />
              </span>
            ))}
        </div>
      );
    case 'actions':
      return (
        <div key={index} className="mr-slack-actions">
          {(block.elements ?? [])
            .filter((el) => el.type === 'button')
            .map((el, i) => (
              <span
                key={i}
                className={`mr-slack-button${el.style === 'primary' ? ' mr-slack-button--primary' : el.style === 'danger' ? ' mr-slack-button--danger' : ''}`}
              >
                <RichText value={el.text} />
              </span>
            ))}
        </div>
      );
    case 'divider':
      return <hr key={index} className="mr-slack-divider" />;
    default:
      return null;
  }
}

export interface SlackPreviewProps {
  /** A Slack message body (`{ text, blocks }`, e.g. core/payloads `slackPayload()`), or a blocks array. */
  message: unknown;
  /** The time shown next to the app name ('11:44 AM'), already formatted. */
  time?: string;
  /** Story / video callout id on the frame (DESIGN_BRIEF 8). */
  callout?: string;
  /**
   * Print a code block a line at a time (Story mode's Monday receipt, P2-W12): how many of its lines show, the
   * receipt's total last; the rest keep their room, hidden. Omitted: every line shows.
   */
  revealLines?: number;
}

/** A Slack message, drawn: avatar square, app name + badge + time, then the blocks. */
export function SlackPreview({ message, time, callout = 'slack-message', revealLines }: SlackPreviewProps) {
  const msg = useMemo(() => toSlackMessage(message), [message]);
  const blocks = msg?.blocks ?? [];
  const body: ReactNode =
    blocks.length > 0 ? (
      blocks.map((b, i) => renderBlock(b, i, revealLines))
    ) : msg?.text ? (
      <div className="mr-slack-section-text">{renderMrkdwn(msg.text, revealLines)}</div>
    ) : (
      <div className="mr-slack-empty">{t('slackPreview.empty')}</div>
    );
  return (
    <figure className="mr-slack" data-callout={callout} aria-label={t('slackPreview.label')}>
      <div className="mr-slack-avatar" aria-hidden="true">
        {t('slackPreview.avatar')}
      </div>
      <div className="mr-slack-body">
        <div className="mr-slack-meta">
          <span className="mr-slack-name">{t('slackPreview.appName')}</span>
          <span className="mr-slack-badge">{t('slackPreview.appBadge')}</span>
          {time ? <span className="mr-slack-time">{time}</span> : null}
        </div>
        <div className="mr-slack-blocks">{body}</div>
      </div>
    </figure>
  );
}
