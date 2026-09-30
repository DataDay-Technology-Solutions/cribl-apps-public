// src/components/IncidentTakeover/TakeoverCard.tsx — the payoff frame (PRD 8.1, DESIGN_BRIEF 5.2): the
// incident card at projector scale. Presentational only; <IncidentTakeover> decides when it shows, and the
// Story view can place it directly.
//
// One card, two moods (BEAUTY F3, F8): a full-bleed header band carries the severity (glyph + title in a
// tinted band — no clipped stripe), then the figures, then the foot with the clock and the delivery.
//
//   alert     band: severity glyph + title · before → after as two large numbers · "$25 a day · $9,125 a
//             year" (callout per-day) · commit hash + message (callout commit) · username (callout author) ·
//             a live "Caught in m:ss" clock that stops and is joined by "Sent to Slack ✓ 11:44:03 AM" when
//             the delivery lands · the demo-profile note when it applies
//   recovery  the same card in saved green: "Recovered · savings back to 75% · closed itself." · how far it
//             fell → where it is now ("50% → 75%", when the presenter saw it open) · the object and what it
//             is saving again · the change that restored it ("Restored in 9b1c2f3 by s.koelpin" and its
//             message), else "Back at its baseline since 7:54 PM" · "Alert open for 4:12" and the recovery
//             message's delivery
//
// Polish (P1-B02): the body's columns start at the top; the person on the alert reads at the money's scale
// ("a1f3c9e by s.koelpin" ≥ 32 px at 1920, the message on its own line under it); the money line never
// starts or ends a line on its "·"; the foot is a fixed grid — clock | delivery | note — so every delivery
// state has the same height (a long delivery line ellipsizes instead of wrapping out of the card); on a
// phone the delivery keeps a two-line slot and crossfades when it changes.

import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { IconButton } from '@capra/core';
import { ClockOutlined, CloseOutlined, GitAlt } from '@capra/icons';
import type { CommitRef, DeliveryRef, Incident, NotificationEndpoint } from '../../../core/types.ts';
import { fmtDollarsCents, fmtDuration } from '../../../core/format.ts';
import { t } from '../../copy/en.ts';
import { commitAuthor } from '../../lib/author.ts';
import { prefersReducedMotion } from '../../lib/dom.ts';
import { useNow } from '../../lib/ticker.ts';
import { renderTemplate, useIncidentContext } from '../IncidentCard/context.tsx';
import {
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
  openSeconds,
  primaryDelivery,
  recoveryDeliveries,
  recoveryMeasure,
  recoveryText,
  shortHash,
  type DeliveryLine,
} from '../IncidentCard/model.ts';
import { SeverityGlyph } from '../IncidentCard/SeverityGlyph.tsx';
import { Meter } from '../Meter/Meter.tsx';
import { IncidentRatioWatch } from '../RatioWatch/RatioWatch.tsx';
import { lostAt, lostClock, type LostClock } from './lost.ts';
import { revealScrollTop } from './reveal.ts';
import type { TakeoverMode } from './tracker.ts';
import './IncidentTakeover.css';

/** Motion budget (DESIGN_BRIEF 4): the only thing that moves onto the screen by itself. */
export const TAKEOVER_ENTER_MS = 450;
export const TAKEOVER_FADE_MS = 200;
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';

export interface TakeoverCardProps {
  incident: Incident;
  mode: TakeoverMode;
  /** Recovery: the last open version of the incident, for "how far it fell → where it is now". */
  was?: Incident;
  deliveries?: readonly DeliveryRef[];
  nowMs?: number;
  endpoints?: readonly NotificationEndpoint[];
  tz?: string;
  labels?: Record<string, string>;
  /** Shows the close button and the "Press any key" hint. */
  onDismiss?: () => void;
  /** 'overlay': fixed over the lower half of the frame, slides up. 'inline': in flow (Story, previews). */
  placement?: 'overlay' | 'inline';
  /**
   * The live "Lost since the deploy" counter (P2-W03); default on. Story turns it off (D52): its incident runs on the
   * story's compressed clock while a counter runs on the wall clock, so the figure the room watched jumped by 40 %
   * as the card turned green, and Story leaves the drawn drop (P2-W15) off too.
   */
  lostCounter?: boolean;
  /** Plays the enter animation on mount (overlay default true). */
  animate?: boolean;
  /** Recovery: the change that restored the savings (restore.ts), when the timeline names one. */
  restoredBy?: CommitRef;
  /** The hint beside the close button (default "Press any key to dismiss": the stage's any-key dismissal). */
  dismissHint?: string;
  /**
   * The capture callouts (per-day, commit, author); default on. Off where the page already carries its own (the tour's
   * card on the Receipt, FOUNDER_PLAN row 11), so each callout stays one per page.
   */
  callouts?: boolean;
  /** A line for the foot's note slot (the tour's card: "Sample data. Nothing is written to your workspace."). */
  note?: string;
}

/**
 * P0-14: the overlay's height is fixed. The title and the commit are already clamped; if the body still cannot
 * fit (a long title and a wrapped nearby caveat on a narrow frame), the least important line goes whole — the
 * caveat, then the cause row — rather than being cut through its glyphs. The foot's demo-profile note goes first;
 * then each column is judged by itself: the figures' column gives up its drawn drop (P2-W15) when it is the one that
 * cannot fit, and the detail column a cause row with nothing but the deploy time, then its lost counter (P2-W03),
 * then its caveat, then its cause row.
 */
function fitOverlayBody(body: HTMLElement | null): void {
  if (!body) return;
  const foot = body.parentElement?.querySelector<HTMLElement>(':scope > .mr-tk-foot') ?? null;
  delete body.dataset.fit;
  delete body.dataset.lost;
  delete body.dataset.watch;
  if (foot) delete foot.dataset.note;
  if (body.scrollHeight <= body.clientHeight + 1) return;
  // Measured afresh each time: dropping the foot's note gives the body back the foot's second line.
  const overflows = (sel: string) => {
    const limit = body.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(body).paddingBottom) || 0) + 1;
    const el = body.querySelector(`:scope > ${sel}`);
    return !!el && el.getBoundingClientRect().bottom > limit;
  };
  const either = () => overflows('.mr-tk-ratio') || overflows('.mr-tk-detail');
  // 1. The demo-profile note, a presenter's footnote that can take the foot a second line (review W2: at 1280×720 it
  //    stayed while the lost counter and the drawn drop went).
  if (foot?.querySelector(':scope > .mr-tk-note')) {
    foot.dataset.note = 'none';
    if (!either()) return;
  }
  if (overflows('.mr-tk-ratio')) body.dataset.watch = 'none';
  if (!overflows('.mr-tk-detail')) return;
  // 2. A cause row with no caveat to keep ("change to this route · deployed 2:36 AM"): the commit above names it.
  const cause = body.querySelector('.mr-tk-cause');
  if (cause && !cause.querySelector('.mr-tk-caveat')) {
    body.dataset.fit = 'no-cause';
    if (!overflows('.mr-tk-detail')) return;
    delete body.dataset.fit;
  }
  // 3. The lost counter goes before the nearby caveat: the caveat says the change may not be the cause (honesty first).
  body.dataset.lost = 'none';
  if (!overflows('.mr-tk-detail')) return;
  body.dataset.fit = 'no-caveat';
  if (!overflows('.mr-tk-detail')) return;
  body.dataset.fit = 'no-cause';
}

/** A lost counter runs for at most a day past its start (the card is up for 45 s; the change may be older). */
const LOST_MAX_SEC = 86_400;

/**
 * "Lost since the deploy $0.83" (P2-W03): the money the drop has cost so far, in the incident red, its cents
 * turning at the incident's own rate. Under reduced motion it steps once a second (the card's clock) instead of
 * rolling. Visual only: the card is role="alert", and a counter inside it would be re-announced.
 */
function LostCounter({ clock, nowMs }: { clock: LostClock; nowMs: number }) {
  const still = prefersReducedMotion();
  return (
    <p className="mr-tk-lost" data-live="true" aria-hidden="true" data-testid="lost-counter">
      <span className="mr-tk-lost-label">{t(clock.sinceDeploy ? 'incidents.lostSinceDeploy' : 'incidents.lostSinceStart')}</span>
      <span className="mr-tk-lost-figure mr-num">
        <Meter
          valueM={still ? lostAt(clock, nowMs) : 0}
          ratePerSecM={clock.ratePerSecM}
          anchorMs={still ? nowMs : clock.startMs}
          maxExtrapolationSec={LOST_MAX_SEC}
          label={t(clock.sinceDeploy ? 'incidents.lostSinceDeploy' : 'incidents.lostSinceStart')}
          size="inherit"
          callout={null}
        />
      </span>
    </p>
  );
}

function Delivery({ line }: { line: DeliveryLine }) {
  // Keyed by its words by the caller, so a delivery landing fades the new line in (on a phone its slot is
  // reserved; on the stage it is one line that ellipsizes, full wording on hover).
  return (
    <p className={`mr-tk-delivery mr-tk-delivery--${line.tone}`} data-tone={line.tone} title={line.text}>
      {line.text}
    </p>
  );
}

/**
 * A money line of " · "-joined parts ("$25 a day · $9,125 a year"): each part stays whole and each separator
 * hangs in the gap before the part it introduces, so a narrow card breaks between the parts and never starts or
 * ends a line on a lone "·" (the separator of a wrapped part falls outside the line, where the overflow clips it).
 */
export function MoneyLine({ template, nodes }: { template: string; nodes: Record<string, ReactNode> }) {
  const parts = template.split(' · ');
  return parts.map((part, i) =>
    i === 0 ? (
      <span key={i} className="mr-tk-part">
        {renderTemplate(part, nodes)}
      </span>
    ) : (
      <span key={i} className="mr-tk-part mr-tk-tail">
        <span className="mr-tk-sep">{' · '}</span>
        {renderTemplate(part, nodes)}
      </span>
    ),
  );
}

/** The air kept over the hero's label when the card scrolls the page (px). */
const HERO_AIR_PX = 8;

/** Scrolls the window so the in-page card is on screen and the stage's hero keeps its top (reveal.ts). */
function revealOnPhone(el: HTMLElement): void {
  const card = el.getBoundingClientRect();
  // The hero's top is its label ("Saved by Cribl"), with a little air; the hero's box when it has no label yet.
  const stage = el.closest('.mr-pv');
  const label = stage?.querySelector('.mr-pv-label')?.getBoundingClientRect();
  const box = stage?.querySelector('.mr-pv-hero')?.getBoundingClientRect();
  const hero = label ? { top: label.top - HERO_AIR_PX } : box;
  const y = window.scrollY;
  const next = revealScrollTop({
    scrollY: y,
    viewport: window.innerHeight,
    cardTop: card.top + y,
    cardBottom: card.bottom + y,
    margin: parseFloat(getComputedStyle(el).scrollMarginBottom) || 0,
    heroTop: hero ? hero.top + y : undefined,
  });
  // The two-argument form: instant in every browser (an older one rejects behavior: 'instant' with a TypeError).
  if (Math.abs(next - y) >= 1) window.scrollTo(0, next);
}

/**
 * The change on the card: "a1f3c9e by s.koelpin" at the money's scale (the person is the story), then the
 * message, smaller (after the person on the stage, ellipsizing, full text on hover; under it on a phone). The alert card carries
 * the commit and author callouts; the recovery card's restoring change carries none (one of each per page).
 */
function CommitBlock({
  commit,
  template,
  callouts,
  labels,
}: {
  commit: Pick<CommitRef, 'hash' | 'message' | 'author'>;
  template: string;
  callouts: boolean;
  labels?: Record<string, string>;
}) {
  return (
    <div className="mr-tk-commit">
      <GitAlt size="md" aria-hidden="true" />
      <div className="mr-tk-commit-lines">
        <p className="mr-tk-commit-text">
          {renderTemplate(template, {
            hash: (
              <code className="mr-tk-hash" data-callout={callouts ? 'commit' : undefined}>
                {shortHash(commit.hash)}
              </code>
            ),
            author: (
              <span className="mr-tk-author" data-callout={callouts ? 'author' : undefined}>
                {commitAuthor(commit.author, labels)}
              </span>
            ),
          })}
        </p>
        <p className="mr-tk-message" title={commit.message}>
          {t('incidents.commitQuoted', { message: commit.message })}
        </p>
      </div>
    </div>
  );
}

export function TakeoverCard(props: TakeoverCardProps) {
  const { incident, mode, onDismiss, placement = 'overlay' } = props;
  const callouts = props.callouts !== false;
  const animate = props.animate ?? placement === 'overlay';
  const ctx = useIncidentContext();
  const tick = useNow();
  const nowMs = props.nowMs ?? tick;
  const endpoints = props.endpoints ?? ctx.endpoints;
  const tz = props.tz ?? ctx.tz;
  const labels = props.labels ?? ctx.labels;
  const deliveries = props.deliveries ?? incident.deliveries ?? [];
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Checked after every render (the card re-renders each second for its clock), on every resize of the body
  // AND of its rows — the body's own box is fixed, so content that starts to wrap (a web font arriving, a
  // delivery line landing) changes only the rows — and when fonts finish loading. The check ends in the same
  // state when nothing changed, so the observer never loops.
  useLayoutEffect(() => {
    if (placement === 'overlay') fitOverlayBody(bodyRef.current);
  });
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || placement !== 'overlay') return;
    const refit = () => fitOverlayBody(body);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : undefined;
    if (observer) for (const el of [body, ...body.querySelectorAll(':scope > *, :scope > * > *')]) observer.observe(el);
    document.fonts?.addEventListener?.('loadingdone', refit);
    return () => {
      observer?.disconnect();
      document.fonts?.removeEventListener?.('loadingdone', refit);
    };
  }, [mode, placement]);

  // Enter: 450 ms ease-out slide up; reduced motion → a 200 ms fade (Web Animations, so the global
  // reduced-motion CSS override does not flatten the fade to nothing). Once per incident: the same card
  // turning green (alert → recovery, P1-B01) does not slide in again.
  useEffect(() => {
    const el = ref.current;
    if (!animate || !el || typeof el.animate !== 'function') return;
    // On a phone the overlay sits in the page between the savers and the QR (P1-B02): bring it on screen first,
    // without scrolling the hero's top away (reveal.ts), before the slide's transform moves its box.
    if (placement === 'overlay' && getComputedStyle(el).position !== 'fixed') revealOnPhone(el);
    const anim = prefersReducedMotion()
      ? el.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: TAKEOVER_FADE_MS,
          easing: 'ease-out',
        })
      : el.animate([{ transform: 'translateY(calc(100% + 64px))' }, { transform: 'translateY(0)' }], {
          duration: TAKEOVER_ENTER_MS,
          easing: EASE_OUT,
        });
    return () => anim.cancel();
    // Once per incident (placement is fixed for a card's life).
  }, [animate, incident.id, placement]);

  const recovery = mode === 'recovery';
  // A close that is not a recovery (a member's, or the $/day floor's: M9, founder-build r1 ui-6) takes the stage neutral.
  const neutralClose = recovery && isNeutralClose(incident);
  const tone = recovery ? (neutralClose ? 'info' : 'recovered') : incidentTone(incident);
  const title = incidentTitle(incident, labels);
  const className = `mr-takeover mr-takeover--${placement} mr-takeover--${mode} mr-takeover--${tone}`;
  const money = impactFigures(incident);

  // The overlay clamps the title to two lines (P0-14); the full wording stays on hover.
  const head = (heading: string) => (
    <header className="mr-tk-head">
      <SeverityGlyph tone={tone} size="lg" />
      <h2 id={titleId} className={`mr-tk-title${recovery ? ' mr-tk-title--recovery' : ''}`} title={heading}>
        {heading}
      </h2>
      {onDismiss ? (
        <div className="mr-tk-dismiss">
          <span className="mr-tk-hint">{props.dismissHint ?? t('incidents.dismissHint')}</span>
          <IconButton
            icon={CloseOutlined}
            aria-label={t('incidents.dismiss')}
            variant="tertiary"
            appearance="neutral"
            size="lg"
            onPress={onDismiss}
          />
        </div>
      ) : null}
    </header>
  );

  if (recovery) {
    const figures = recoveryMeasure(incident, props.was, tz);
    const open = openSeconds(incident);
    const sent = primaryDelivery(deliveryLines(recoveryDeliveries(incident, deliveries), { endpoints, tz, withSeconds: true }));
    const closedMs = Date.parse(incident.closedAt ?? '');
    // "Saving … again" only when savings came back (never after a neutral close: they are still where they fell).
    const savingAgain = !neutralClose && (incident.type === 'regression' || incident.type === 'goodnews');
    // The lost counter, frozen at the close (P2-W03): what the drop cost from its start until it recovered. Only
    // beside the figures — a close with no reading (a demo reset) recovered nothing we measured.
    const lostClockAtClose = lostClock(props.was ?? incident);
    const costM = lostClockAtClose && Number.isFinite(closedMs) ? lostAt(lostClockAtClose, closedMs) : null;
    const cost =
      costM !== null && costM > 0 ? (
        <p className="mr-tk-lost mr-tk-lost--frozen" data-testid="lost-frozen">
          {renderTemplate(t('incidents.costBeforeRecovered'), { amount: <span className="mr-tk-lost-figure mr-num">{fmtDollarsCents(costM)}</span> })}
        </p>
      ) : null;
    return (
      <section
        ref={ref}
        className={className}
        role="status"
        aria-labelledby={titleId}
        data-incident-id={incident.id}
        data-mode="recovery"
        data-delivered={sent?.tone === 'ok' ? 'true' : 'false'}
      >
        {head(recoveryText(incident))}
        <div ref={bodyRef} className="mr-tk-body">
          {/* How far it fell → where it recovered to (D47); a close with no reading at all (a demo reset) has no figures. */}
          {figures.from || figures.to ? (
            <div className="mr-tk-ratio">
              <p className="mr-tk-ratio-row mr-num">
                {figures.from ? (
                  <>
                    <span className="mr-tk-before">{figures.from}</span>
                    {figures.to ? (
                      <>
                        <span className="mr-tk-arrow" aria-hidden="true">
                          →
                        </span>
                        <span className="mr-visually-hidden"> {t('incidents.arrow')} </span>
                      </>
                    ) : null}
                  </>
                ) : null}
                {figures.to ? <span className="mr-tk-after mr-tk-after--saved">{figures.to}</span> : null}
                {figures.per ? <span className="mr-tk-unit">{t('units.perHour')}</span> : null}
              </p>
              <p className="mr-tk-caption">{figures.caption}</p>
              {/* The drop and the way back, drawn (P2-W15; on the stage only). */}
              {placement === 'overlay' ? <IncidentRatioWatch incident={incident} variant="takeover" tz={tz} /> : null}
            </div>
          ) : null}
          <div className="mr-tk-detail">
            {/* The object, not the alert's title: "Savings dropped" under "Recovered" contradicts it (BEAUTY F3). */}
            <p className="mr-tk-object">{incidentLabel(incident, labels)}</p>
            {savingAgain ? (
              <p className="mr-tk-money" data-callout={callouts ? 'per-day' : undefined}>
                <MoneyLine
                  template={t('incidents.savingAgain')}
                  nodes={{ perDay: <span className="mr-num">{money.perDay}</span>, perYear: <span className="mr-num">{money.perYear}</span> }}
                />
              </p>
            ) : null}
            {figures.from || figures.to ? cost : null}
            {/* What happened (P1-B02): the change that restored it, else "back at its baseline since …" — never a
                bare kind chip. */}
            {props.restoredBy ? (
              <CommitBlock commit={props.restoredBy} template={t('incidents.restoredBy')} callouts={false} labels={labels} />
            ) : Number.isFinite(closedMs) ? (
              <p className="mr-tk-cause">
                <span className="mr-tk-when">
                  {neutralClose ? t('incidents.closedAt', { time: formatClockTime(closedMs, tz, true) }) : t('incidents.backAtBaseline', { time: formatClockTime(closedMs, tz, true) })}
                </span>
              </p>
            ) : null}
          </div>
        </div>
        {open !== undefined || sent ? (
          <footer className="mr-tk-foot">
            {open !== undefined ? (
              <p className="mr-tk-caught">
                <ClockOutlined size="lg" aria-hidden="true" />
                <span className="mr-tk-caught-text">
                  {renderTemplate(t('incidents.openFor'), {
                    duration: <span className="mr-num mr-tk-clock">{fmtDuration(open)}</span>,
                  })}
                </span>
              </p>
            ) : null}
            {sent ? <Delivery key={sent.text} line={sent} /> : <p className="mr-tk-slot" aria-hidden="true" />}
          </footer>
        ) : null}
      </section>
    );
  }

  const measure = incidentMeasure(incident, tz);
  const cause = causeInfo(incident);
  const lines = deliveryLines(deliveries, { endpoints, tz, withSeconds: true });
  const caught = caughtState(incident, deliveries, nowMs, expectsDelivery(incident.severity, endpoints));
  // A landed webhook or notification target first, the bell when it is all that landed (NOTIFY-3a issue 1).
  const statusLine = primaryDelivery(lines);
  const when = commitWhen(incident, tz, true);
  const worseClass = measure.worse ? ` mr-tk-after--${tone === 'medium' ? 'medium' : 'high'}` : '';
  const lost = lostClock(incident);

  return (
    <section
      ref={ref}
      className={className}
      role="alert"
      aria-labelledby={titleId}
      data-incident-id={incident.id}
      data-mode="alert"
      data-delivered={statusLine?.tone === 'ok' ? 'true' : 'false'}
    >
      {head(title)}

      <div ref={bodyRef} className="mr-tk-body">
        <div className="mr-tk-ratio">
          <p className="mr-tk-ratio-row mr-num">
            {measure.after !== undefined ? (
              <>
                <span className="mr-tk-before">{measure.before}</span>
                <span className="mr-tk-arrow" aria-hidden="true">
                  →
                </span>
                <span className="mr-visually-hidden"> {t('incidents.arrow')} </span>
                <span className={`mr-tk-after${worseClass}`}>{measure.after}</span>
              </>
            ) : (
              // An incident closed before D47 kept no drop (D47): the recovery is the only figure, so it leads.
              <span className="mr-tk-recovered-to">
                {renderTemplate(t('incidents.recoveredToLead'), { value: <span className="mr-tk-after mr-tk-after--saved">{measure.recoveredTo}</span> })}
              </span>
            )}
            {measure.per ? <span className="mr-tk-unit">{t('units.perHour')}</span> : null}
          </p>
          <p className="mr-tk-caption">{measure.caption}</p>
          {/* The drop, drawn (P2-W15): the ratio minute by minute, the diamond at the deploy, the loss shaded. On the
              stage only: the Story draws its own chart in the beats around its card. */}
          {placement === 'overlay' ? <IncidentRatioWatch incident={incident} variant="takeover" tz={tz} /> : null}
        </div>

        <div className="mr-tk-detail">
          <p className="mr-tk-money" data-callout={callouts ? 'per-day' : undefined}>
            <MoneyLine
              template={impactWording(incident, { floorCentsPerDay: ctx.floorCentsPerDay }).template}
              nodes={{
                perDay: <span className="mr-num">{money.perDay}</span>,
                perYear: <span className="mr-num">{money.perYear}</span>,
                duration: <span className="mr-num">{impactWording(incident, { floorCentsPerDay: ctx.floorCentsPerDay }).duration}</span>,
              }}
            />
          </p>
          {/* What the rate has cost so far (P2-W03), under the rate itself. */}
          {lost && props.lostCounter !== false ? <LostCounter clock={lost} nowMs={nowMs} /> : null}
          {/* The hash and the person on their own line at the money's scale; on the overlay a long message ellipsizes
              on the line under it, so neither is ever cut (P0-14, P1-B02). */}
          {incident.commit ? <CommitBlock commit={incident.commit} template={t('incidents.commitBy')} callouts={callouts} labels={labels} /> : null}
          {/* A nearby change's caveat already says when it deployed ("3 min earlier"), so it takes the time's
              place in the chip's row instead of adding a line the fixed-height overlay may not have (P0-14). */}
          <p className="mr-tk-cause">
            <span className={`mr-tk-chip mr-tk-chip--${cause.kind}`}>{cause.label}</span>
            {cause.caveat ? (
              <span className="mr-tk-caveat">{cause.caveat}</span>
            ) : when ? (
              <span className="mr-tk-when">{when}</span>
            ) : null}
          </p>
        </div>
      </div>

      <footer className="mr-tk-foot">
        {caught ? (
          <p className="mr-tk-caught" data-live={caught.live ? 'true' : 'false'}>
            <ClockOutlined size="lg" aria-hidden="true" />
            {/* The card is role="alert": a ticking clock inside it would be re-announced every second, so
                assistive tech gets the measured number once and the digits stay visual only. */}
            <span className="mr-tk-caught-text" aria-hidden="true">
              {renderTemplate(t('incidents.caughtIn'), {
                duration: <span className="mr-num mr-tk-clock">{fmtDuration(caught.seconds)}</span>,
              })}
            </span>
            {incident.caughtInSec !== undefined ? (
              <span className="mr-visually-hidden">{t('incidents.caughtIn', { duration: fmtDuration(incident.caughtInSec) })}</span>
            ) : null}
          </p>
        ) : null}
        {/* The delivery's slot is kept while nothing has landed, so the line arriving never reflows the card. */}
        {statusLine ? <Delivery key={statusLine.text} line={statusLine} /> : <p className="mr-tk-slot" aria-hidden="true" />}
        {props.note ? (
          <p className="mr-tk-note" title={typeof props.note === 'string' ? props.note : undefined}>
            {props.note}
          </p>
        ) : hasNote(incident, DEMO_PROFILE_NOTE) ? (
          <p className="mr-tk-note" title={t('demoProfile.notice')}>
            {t('demoProfile.notice')}
          </p>
        ) : null}
      </footer>
    </section>
  );
}
