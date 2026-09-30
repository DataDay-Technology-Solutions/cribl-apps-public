// src/components/IncidentCard/IncidentCard.tsx — the incident card family (PRD 7, 8.1; DESIGN_BRIEF 5.1 Alerts,
// 5.4 incidents rail, 5.7 Demo Console; SPEC 10 cause labels, 12.3 delivery status, 17 copy).
//
//   <IncidentCard incident={i} />                         full card (Demo Console, Ledger detail)
//   <IncidentCard incident={i} variant="compact" />       rails and the Receipt's Alerts column
//
// Pure by default: everything can come in through props. Rendered inside <AppProviders>, whatever is not
// passed (endpoint names, display timezone, humanize overrides, demo mutes) is read from the store.
//
// Callouts (DESIGN_BRIEF 8): `per-day` on the money line, `commit` on the hash + message, `author` on the
// username — the ids Story mode and the video point at.
//
// One card rule (BEAUTY F8): severity is a full-bleed header band (glyph + title in the severity's tint), not
// a stripe clipped by the rounded corners. The compact card always sits inside another card (the Receipt's
// Alerts, the Ledger rail), so it is flat; the full card stands on its own (Demo Console) with the one card
// elevation. Delivery lines put a landed webhook or target before the bell (NOTIFY-3a issue 1).

import { useId, useState, type ReactNode } from 'react';
import { Button, Link } from '@capra/core';
import { ChevronDown, ChevronRight, ClockOutlined, GitAlt } from '@capra/icons';
import type { DeliveryRef, Incident, NotificationEndpoint } from '../../../core/types.ts';
import { canonicalPayload, slackPayload } from '../../../core/payloads.ts';
import { fmtDuration } from '../../../core/format.ts';
import { t, tn } from '../../copy/en.ts';
import { commitAuthor } from '../../lib/author.ts';
import { appLinkBase } from '../../lib/links.ts';
import { useNow } from '../../lib/ticker.ts';
import { SlackPreview } from '../SlackPreview/index.ts';
import { renderTemplate, useIncidentContext } from './context.tsx';
import {
  CATCH_UP_NOTE,
  DEMO_PROFILE_NOTE,
  causeInfo,
  caughtState,
  commitWhen,
  deliveryLines,
  expectsDelivery,
  formatClockTime,
  hasNote,
  impactFigures,
  impactWording,
  incidentLabel,
  incidentMeasure,
  incidentTitle,
  incidentTone,
  isNeutralClose,
  ledgerHref,
  mutedMinutesLeft,
  muteEndParts,
  objectKindWord,
  primaryDelivery,
  rankDeliveries,
  recoveryText,
  shortHash,
  type DeliveryLine,
} from './model.ts';
import { SeverityGlyph } from './SeverityGlyph.tsx';
import { IncidentActions } from './IncidentActions.tsx';
import { IncidentRatioWatch } from '../RatioWatch/RatioWatch.tsx';
import './IncidentCard.css';

export type IncidentCardVariant = 'compact' | 'full';

export interface IncidentCardProps {
  incident: Incident;
  variant?: IncidentCardVariant;
  /** Delivery attempts to show (default: `incident.deliveries`). */
  deliveries?: readonly DeliveryRef[];
  /** Clock for the live "Caught in" and mute countdowns (default: a shared 1-second ticker). */
  nowMs?: number;
  /** Endpoint names for "Sent to {endpoint}" (default: settings.notifications from the store). */
  endpoints?: readonly NotificationEndpoint[];
  /** Display timezone (default: settings.displayTimezone). */
  tz?: string;
  /** settings.humanize overrides for the object label. */
  labels?: Record<string, string>;
  /** ISO end of a demo mute on this object (default: demoState.muted[objectKey]). */
  mutedUntil?: string;
  /** Show the "View in Ledger" link (default true; the Ledger itself turns it off). */
  showLedgerLink?: boolean;
  /** Full variant: the "Show the Slack message" expansion — 'auto' when a Slack endpoint was sent to. */
  slackPreview?: 'auto' | 'always' | 'never';
  /** Heading level for the title (default h3). */
  headingLevel?: 'h2' | 'h3' | 'h4';
  /** Compact: an action in the card's own footer, right-aligned (the Ledger rail's "Show in table"). */
  action?: ReactNode;
  /** Say the demo-profile note inside the card (default true; the Ledger rail says it once in its header). */
  showDemoNote?: boolean;
}

function DeliveryText({ line }: { line: DeliveryLine }) {
  return (
    <span className={`mr-inc-delivery mr-inc-delivery--${line.tone}`} data-tone={line.tone}>
      {line.text}
    </span>
  );
}

export function IncidentCard(props: IncidentCardProps) {
  const { incident, variant = 'full', showLedgerLink = true, slackPreview = 'auto', headingLevel = 'h3', action, showDemoNote = true } = props;
  const ctx = useIncidentContext();
  const tickNow = useNow();
  const nowMs = props.nowMs ?? tickNow;
  const endpoints = props.endpoints ?? ctx.endpoints;
  const tz = props.tz ?? ctx.tz;
  const labels = props.labels ?? ctx.labels;
  const deliveries = props.deliveries ?? incident.deliveries ?? [];
  const mutedUntil = props.mutedUntil ?? ctx.muted?.[incident.objectKey];
  const titleId = useId();
  const [slackOpen, setSlackOpen] = useState(false);

  const tone = incidentTone(incident);
  const title = incidentTitle(incident, labels);
  const measure = incidentMeasure(incident, tz);
  const money = impactFigures(incident);
  const cause = causeInfo(incident);
  const lines = rankDeliveries(deliveryLines(deliveries, { endpoints, tz }));
  const caught = caughtState(incident, deliveries, nowMs, expectsDelivery(incident.severity, endpoints));
  const mutedMin = mutedMinutesLeft(mutedUntil, nowMs);
  const closed = !!incident.closedAt;
  // P1-F07: accepted, muted or left out by a member — closed, not recovered; so is a close the $/day floor made (M9)
  // and a good-news card (it never recovers from anything: row 9, PACK_PAYOFF F1).
  const memberClosed = closed && isNeutralClose(incident);
  const when = closed
    ? t(memberClosed || incident.type === 'goodnews' ? 'incidents.closedAt' : 'incidents.recoveredAt', {
        time: formatClockTime(Date.parse(incident.closedAt ?? ''), tz),
      })
    : t('incidents.openedAt', {
        time: formatClockTime(Date.parse(incident.openedAt), tz),
      });
  const Heading = headingLevel;
  const actionsNode = closed ? null : <IncidentActions incident={incident} tz={tz} label={title} nowMs={nowMs} />;

  const sentToSlack = lines.some((l) => l.tone === 'ok' && l.format === 'slack');
  const canPreviewSlack = variant === 'full' && (slackPreview === 'always' || (slackPreview === 'auto' && sentToSlack));
  const slackMessage =
    canPreviewSlack && slackOpen
      ? slackPayload(
          canonicalPayload(incident.closedAt ? 'incident.closed' : 'incident.opened', {
            incident,
            workspace: '',
            linkBase: appLinkBase(),
            labels,
          }),
          { tz, labels },
        )
      : null;
  const slackSent = lines.find((l) => l.format === 'slack' && l.tone === 'ok');

  const commitNode = incident.commit ? (
    <span className="mr-inc-commit-text">
      {renderTemplate(t(variant === 'compact' ? 'incidents.commitBy' : 'incidents.commitShort'), {
        hash: (
          <code className="mr-inc-hash" data-callout={variant === 'compact' ? 'commit' : undefined}>
            {shortHash(incident.commit.hash)}
          </code>
        ),
        message: <span className="mr-inc-message">{incident.commit.message}</span>,
        author: (
          <span className="mr-inc-author" data-callout="author">
            {commitAuthor(incident.commit.author, labels)}
          </span>
        ),
      })}
    </span>
  ) : null;

  // Only an open regression is projected to a year (as its cost if left); a spike or a closed incident never is.
  const impact = impactWording(incident, { floorCentsPerDay: ctx.floorCentsPerDay });
  const moneyLine = renderTemplate(impact.template, {
    perDay: <span className="mr-num">{money.perDay}</span>,
    perYear: <span className="mr-num">{money.perYear}</span>,
    duration: <span className="mr-num">{impact.duration}</span>,
  });

  const caughtNode = caught ? (
    <span className="mr-inc-caught" data-live={caught.live ? 'true' : undefined}>
      {renderTemplate(t('incidents.caughtIn'), {
        duration: <span className="mr-num">{fmtDuration(caught.seconds)}</span>,
      })}
    </span>
  ) : null;

  const notes: string[] = [];
  if (showDemoNote && hasNote(incident, DEMO_PROFILE_NOTE)) notes.push(t('demoProfile.notice'));

  // P1-F07: a member's mute reads until when, not "after a demo change".
  const memberMuteUntil = mutedMin > 0 ? undefined : ctx.mutes?.[incident.objectKey]?.until;
  const memberMuted = mutedMinutesLeft(memberMuteUntil, nowMs) > 0;
  const mutedChip =
    mutedMin > 0 ? (
      <span className="mr-inc-chip mr-inc-chip--muted">{t('ledger.mutedChip', { minutes: mutedMin })}</span>
    ) : memberMuted ? (
      <span className="mr-inc-chip mr-inc-chip--muted" data-muted-by-member="true">
        {t('incidents.mutedUntil', muteEndParts(Date.parse(memberMuteUntil ?? ''), tz))}
      </span>
    ) : null;

  // D47: a closed incident keeps its drop and adds where it recovered to ("76% → 49% · recovered to 89%");
  // one closed before D47 kept no drop, so the recovery stands alone — leading the line, in sentence case —
  // with no arrow to a figure it never had.
  const recoveredNode =
    measure.recoveredTo !== undefined
      ? renderTemplate(t(measure.after === undefined ? 'incidents.recoveredToLead' : 'incidents.recoveredTo'), {
          value: (
            <span className="mr-num">
              {measure.recoveredTo}
              {/* A no-break space, as the figures elsewhere space their unit ("$119 / hour"), never wrapping between them. */}
              {measure.per ? <span className="mr-figure-unit">{`\u00a0${t('units.perHour')}`}</span> : null}
            </span>
          ),
        })
      : null;

  if (variant === 'compact') {
    const status: ReactNode[] = [];
    if (closed)
      status.push(
        <span key="rec" className={memberClosed ? 'mr-inc-closed-by' : 'mr-inc-recovered'} data-closed-reason={incident.closedReason}>
          {recoveryText(incident)}
        </span>,
      );
    else {
      if (caughtNode) status.push(<span key="caught">{caughtNode}</span>);
      const first = primaryDelivery(lines);
      if (first) status.push(<DeliveryText key="d" line={first} />);
    }
    return (
      <article
        className={`mr-inc mr-inc--compact mr-inc--${tone}`}
        aria-labelledby={titleId}
        data-incident-id={incident.id}
        data-tone={tone}
      >
        {/* The kind and the time are a small eyebrow; the object is the one-line title (P1-H04), so a narrow column
            never wraps the title beside a centred timestamp. The heading still reads the whole SPEC 17 title. */}
        <header className="mr-inc-head">
          <SeverityGlyph tone={tone} size="sm" />
          <div className="mr-inc-compact-titles">
            <Heading id={titleId} className="mr-inc-title mr-truncate" title={title}>
              <span className="mr-visually-hidden">{`${t(`incidents.eyebrow.${incident.type}`)}: `}</span>
              {incidentLabel(incident, labels)}
            </Heading>
            <p className="mr-inc-eyebrow">
              <span aria-hidden="true">{t(`incidents.eyebrow.${incident.type}`)}</span>
              <span className="mr-inc-eyebrow-sep" aria-hidden="true">
                ·
              </span>
              <span className="mr-inc-when">{formatClockTime(Date.parse(closed ? (incident.closedAt ?? '') : incident.openedAt), tz)}</span>
            </p>
          </div>
        </header>
        <div className="mr-inc-body">
          <p className="mr-inc-line">
            {measure.after !== undefined ? (
              <span className="mr-inc-ratio-inline mr-num">
                {measure.before}
                <span className="mr-inc-arrow-inline" aria-hidden="true">
                  {' → '}
                </span>
                <span className="mr-visually-hidden"> {t('incidents.arrow')} </span>
                <span className={measure.worse && !closed ? `mr-incident-${tone === 'medium' ? 'medium' : 'high'}` : undefined}>
                  {measure.after}
                </span>
              </span>
            ) : null}
            {/* Each separator hangs off what it introduces (.mr-inc-tail), so a narrow rail never starts or ends
                a line on a lone "·"; the first fragment of a line carries none. */}
            {recoveredNode ? tail(<span className="mr-inc-recovered-to">{recoveredNode}</span>, measure.after !== undefined) : null}
            {tail(
              <span className="mr-inc-money" data-callout="per-day">
                {moneyLine}
              </span>,
              measure.after !== undefined || recoveredNode !== null,
            )}
          </p>
          <p className="mr-inc-line mr-inc-sub">
            {commitNode ? (
              <>
                <span className="mr-inc-commit-inline">
                  <GitAlt size="xs" aria-hidden="true" />
                  {commitNode}
                </span>
                {tail(<span className="mr-inc-cause-text">{cause.label}</span>)}
              </>
            ) : (
              <span className="mr-inc-cause-text">{cause.label}</span>
            )}
          </p>
          {status.length > 0 ? <p className="mr-inc-line mr-inc-sub mr-inc-status-line">{status.map((n, i) => (i === 0 ? n : tail(n, true, i)))}</p> : null}
          {showLedgerLink || mutedChip || notes.length > 0 || action || actionsNode ? (
            <footer className="mr-inc-foot">
              {showLedgerLink ? <Link href={ledgerHref(incident.objectKey)}>{t('incidents.viewInLedger')}</Link> : null}
              {mutedChip}
              {notes.map((n) => (
                <span key={n} className="mr-inc-note">
                  {n}
                </span>
              ))}
              {action || actionsNode ? (
                <span className="mr-inc-foot-end mr-inc-foot-actions">
                  {action}
                  {actionsNode}
                </span>
              ) : null}
            </footer>
          ) : null}
        </div>
      </article>
    );
  }

  return (
    <article className={`mr-inc mr-inc--full mr-inc--${tone}`} aria-labelledby={titleId} data-incident-id={incident.id} data-tone={tone}>
      <header className="mr-inc-head">
        <SeverityGlyph tone={tone} size="md" />
        <div className="mr-inc-headtext">
          <Heading id={titleId} className="mr-inc-title">
            {title}
          </Heading>
          <p className="mr-inc-meta">
            <span>{objectKindWord(incident.objectKey)}</span>
            <span aria-hidden="true">·</span>
            <span>{when}</span>
            {hasNote(incident, CATCH_UP_NOTE) ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{t('incidents.caughtOnCatchUp')}</span>
              </>
            ) : null}
          </p>
        </div>
        {mutedChip}
      </header>

      <div className="mr-inc-body">
        <div className="mr-inc-figures">
          <div className="mr-inc-ratio">
            <p className="mr-inc-ratio-row mr-num" aria-hidden="true">
              {measure.after !== undefined ? (
                <>
                  <span className="mr-inc-before">{measure.before}</span>
                  <span className="mr-inc-arrow">→</span>
                  <span className={`mr-inc-after${measure.worse && !closed ? ` mr-incident-${tone === 'medium' ? 'medium' : 'high'}` : ''}`}>
                    {measure.after}
                  </span>
                  {measure.per ? <span className="mr-figure-unit">{t('units.perHour')}</span> : null}
                </>
              ) : null}
              {recoveredNode ? (
                <span className={`mr-inc-recovered-to${measure.after === undefined ? ' mr-inc-recovered-to--only' : ''}`}>{recoveredNode}</span>
              ) : null}
            </p>
            <p className="mr-inc-caption">{measure.sentence}</p>
          </div>
          <p className="mr-inc-money mr-inc-money--full" data-callout="per-day">
            {moneyLine}
          </p>
        </div>
        {/* P2-W15: the drop, drawn (the flow's minutes from the store's snapshot; nothing without them). */}
        <IncidentRatioWatch incident={incident} tz={tz} />

        <div className="mr-inc-section">
          {commitNode ? (
            <p className="mr-inc-commit" data-callout="commit">
              <GitAlt size="sm" aria-hidden="true" />
              {commitNode}
            </p>
          ) : null}
          <p className="mr-inc-cause">
            <span className={`mr-inc-chip mr-inc-chip--cause mr-inc-chip--${cause.kind}`}>{cause.label}</span>
            {commitWhen(incident, tz) ? <span className="mr-inc-cause-when">{commitWhen(incident, tz)}</span> : null}
          </p>
          {cause.caveat ? <p className="mr-inc-caveat">{cause.caveat}</p> : null}
        </div>

        <div className="mr-inc-section mr-inc-status">
          {closed ? (
            <p className={memberClosed ? 'mr-inc-closed-by' : 'mr-inc-recovered'} data-closed-reason={incident.closedReason}>
              {recoveryText(incident)}
            </p>
          ) : (
            <p className="mr-inc-status-row">
              {caughtNode ? (
                <span className="mr-inc-status-caught">
                  <ClockOutlined size="sm" aria-hidden="true" />
                  {caughtNode}
                </span>
              ) : null}
              {lines.slice(0, 2).map((l) => (
                <DeliveryText key={l.endpointId} line={l} />
              ))}
              {lines.length > 2 ? <span className="mr-inc-delivery">{tn('incidents.deliveryMore', lines.length - 2)}</span> : null}
            </p>
          )}
          {notes.map((n) => (
            <p key={n} className="mr-inc-note">
              {n}
            </p>
          ))}
        </div>

        {showLedgerLink || canPreviewSlack || actionsNode ? (
          <footer className="mr-inc-foot">
            {showLedgerLink ? <Link href={ledgerHref(incident.objectKey)}>{t('incidents.viewInLedger')}</Link> : null}
            {actionsNode ? <span className="mr-inc-foot-end">{actionsNode}</span> : null}
            {canPreviewSlack ? (
              <span className={actionsNode ? undefined : 'mr-inc-foot-end'}>
                <Button
                  variant="tertiary"
                  size="sm"
                  trailingIcon={slackOpen ? ChevronDown : ChevronRight}
                  aria-expanded={slackOpen}
                  onPress={() => setSlackOpen((o) => !o)}
                >
                  {slackOpen ? t('incidents.hideSlack') : t('incidents.showSlack')}
                </Button>
              </span>
            ) : null}
          </footer>
        ) : null}
        {slackMessage ? (
          <div className="mr-inc-slack">
            <SlackPreview message={slackMessage} time={slackSent ? formatClockTime(slackSent.at, tz) : undefined} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

/**
 * A fragment of a compact line with the middle dot that introduces it. The two wrap as one, and the dot hangs
 * in the gap before the fragment (IncidentCard.css), where a wrap clips it: no line ever starts or ends on "·".
 */
function tail(node: ReactNode, sep = true, key?: number): ReactNode {
  return (
    <span key={key} className="mr-inc-tail">
      {sep ? (
        <span className="mr-inc-sep" aria-hidden="true">
          ·
        </span>
      ) : null}
      {node}
    </span>
  );
}
