// src/components/IncidentCard/model.ts — the incident card family's pure logic (no React, no DOM), shared by
// IncidentCard, the presenter takeover and the Story view: titles, cause labels (SPEC 10), delivery status
// lines (SPEC 12.3 / 17), the "Caught in m:ss" clock (PRD 7, 8.1), the before → after figures and the
// recovery sentence. Money is formatted only through core/format.ts; every string comes from the copy table.

import type { DeliveryRef, Incident, IncidentType, NotificationEndpoint, ObjectKind, Severity } from '../../../core/types.ts';
import { fmtDollars, fmtDurationShort, fmtPct, perYear } from '../../../core/format.ts';
import { parseObjectKey } from '../../../core/flows.ts';
import { humanizeObjectKey } from '../../../core/humanize.ts';
import { incidentReadings, severityRank, titleFor } from '../../../core/incidents.ts';
import { BELL_ENDPOINT_ID, channelOf } from '../../../core/delivery.ts';
import { formatLocalMonthDay, fromIso } from '../../../core/time.ts';
import { interpolate, t } from '../../copy/en.ts';
import { endpointDisplayName } from '../../state/selectors.ts';

// ─── Identity ────────────────────────────────────────────────────────────────

/** The plain-words object label (the incident's own label, else the humanized object id). */
export function incidentLabel(incident: Pick<Incident, 'label' | 'objectKey'>, labels?: Record<string, string>): string {
  return incident.label?.trim() ? incident.label : humanizeObjectKey(incident.objectKey, labels);
}

/** SPEC 17 title: "Savings dropped: Payments API sampling". */
export function incidentTitle(incident: Pick<Incident, 'type' | 'label' | 'objectKey'>, labels?: Record<string, string>): string {
  return titleFor({
    type: incident.type,
    label: incidentLabel(incident, labels),
  });
}

const KIND_KEYS: Record<ObjectKind, 'incidents.kind.pipe' | 'incidents.kind.route' | 'incidents.kind.in' | 'incidents.kind.out'> = {
  pipe: 'incidents.kind.pipe',
  route: 'incidents.kind.route',
  in: 'incidents.kind.in',
  out: 'incidents.kind.out',
};

/** 'pipeline' · 'route' · 'source' · 'destination' for an ObjectKey (pipeline when unparseable). */
export function objectKindWord(objectKey: string): string {
  const parsed = parseObjectKey(objectKey);
  return t(KIND_KEYS[parsed?.kind ?? 'pipe']);
}

/** The in-app Ledger deep link for an incident's object (`?object=` keeps colons readable, SPEC 13). */
export function ledgerHref(objectKey: string): string {
  return `/ledger?object=${encodeURIComponent(objectKey).replace(/%3A/gi, ':')}`;
}

// ─── Time ────────────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

function safeZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined; // an invalid IANA name must never crash a render
  }
}

/**
 * '11:44 AM' (cards, SPEC 17) or '11:44:03 AM' (the takeover's delivery line) in the display timezone.
 * ICU's narrow no-break space before AM/PM becomes a plain space, as in core/time.ts.
 */
export function formatClockTime(ms: number, tz?: string, withSeconds = false): string {
  if (!Number.isFinite(ms)) return t('common.dash');
  const zone = safeZone(tz);
  const key = `${zone ?? ''}|${withSeconds ? 's' : 'm'}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {}),
      hour12: true,
      timeZone: zone,
    });
    formatters.set(key, f);
  }
  return f.format(ms).replace(/[   ]/g, ' ');
}

function ms(iso: string | undefined): number {
  if (!iso) return Number.NaN;
  return fromIso(iso);
}

// ─── Cause (SPEC 10 matching → label) ────────────────────────────────────────

export type CauseKind = 'files' | 'message' | 'nearby' | 'table' | 'none';

export interface CauseInfo {
  kind: CauseKind;
  /** 'change to this pipeline' · 'change naming this pipeline' · 'nearby change' · 'No config change found nearby' */
  label: string;
  /** nearby only: 'A change was deployed 4 min earlier; it may not be the cause.' */
  caveat?: string;
}

/** When the matched commit took effect: its deploy time, else its commit time (labelled "committed"). */
export function commitEffectiveMs(incident: Pick<Incident, 'commit'>): number {
  const c = incident.commit;
  if (!c) return Number.NaN;
  const deployed = ms(c.deployedAt);
  return Number.isFinite(deployed) ? deployed : ms(c.committedAt);
}

export function causeInfo(incident: Pick<Incident, 'cause' | 'commit' | 'objectKey' | 'openedAt'>): CauseInfo {
  const c = incident.commit;
  if (!c || incident.cause === 'unknown') return { kind: 'none', label: t('incidents.noChange') };
  if (c.match === 'nearby') {
    const gapMs = ms(incident.openedAt) - commitEffectiveMs(incident);
    const minutes = Number.isFinite(gapMs) ? Math.max(1, Math.round(gapMs / 60_000)) : 1;
    return {
      kind: 'nearby',
      label: t('incidents.cause.nearby'),
      caveat: t('incidents.nearbyChange', { minutes }),
    };
  }
  const kind = objectKindWord(incident.objectKey);
  // A commit that edited the group's shared route table (pipelines/route.yml) without this route's entry confirmed
  // changed (usefulness review, round 1): never "change to this route". Core reports it as match 'table' once its
  // diff check lands; until then the string never occurs and this branch is idle.
  if ((c.match as string) === 'table') return { kind: 'table', label: t('incidents.cause.table'), caveat: t('incidents.tableCaveat', { kind }) };
  return c.match === 'files'
    ? { kind: 'files', label: t('incidents.cause.files', { kind }) }
    : { kind: 'message', label: t('incidents.cause.message', { kind }) };
}

/** 'deployed 11:39 AM' — or 'committed 11:39 AM' when no deploy time is known (SPEC 10). */
export function commitWhen(incident: Pick<Incident, 'commit'>, tz?: string, withSeconds = false): string | undefined {
  const c = incident.commit;
  if (!c) return undefined;
  const deployed = ms(c.deployedAt);
  if (Number.isFinite(deployed))
    return t('incidents.deployedAt', {
      time: formatClockTime(deployed, tz, withSeconds),
    });
  const committed = ms(c.committedAt);
  return Number.isFinite(committed)
    ? t('incidents.committedAt', {
        time: formatClockTime(committed, tz, withSeconds),
      })
    : undefined;
}

/** Short hash as the version API and the Slack message print it. */
export function shortHash(hash: string): string {
  return (hash ?? '').slice(0, 7);
}

// ─── Deliveries (SPEC 12.3, 17) ──────────────────────────────────────────────

export type DeliveryTone = 'ok' | 'retrying' | 'failed' | 'blocked';

export interface DeliveryLine {
  endpointId: string;
  tone: DeliveryTone;
  /** 'Sent to Slack ✓ 11:44 AM' · 'Sent to Cribl notifications ✓ 11:44 AM' · 'Delivery failed (503). Retrying.' · … */
  text: string;
  at: number;
  /** the endpoint's preset (slack / generic / servicenow) when known */
  format?: NotificationEndpoint['format'];
  /** the Cribl notification bell (stored, or the implicit default bell that is never stored) */
  bell?: boolean;
}

export function isDelivered(d: Pick<DeliveryRef, 'status'>): boolean {
  return d.status >= 200 && d.status < 300;
}

/**
 * The name a delivery line prints: 'Cribl notifications' for the bell — including the implicit default bell,
 * which is not in settings, so its id alone resolves (NOTIFY-3a issue 1) — else the endpoint's name, a
 * target's id, or the preset's name ('Slack', 'webhook'), else the id. The shared selector.
 */
export function endpointName(endpointId: string, endpoints?: readonly NotificationEndpoint[]): string {
  return endpointDisplayName(endpointId, endpoints);
}

/** Whether a delivery went to the Cribl bell (a stored bell endpoint, or the implicit default one). */
export function isBellEndpoint(endpointId: string, endpoints?: readonly NotificationEndpoint[]): boolean {
  const ep = endpoints?.find((e) => e.id === endpointId);
  return ep ? channelOf(ep) === 'cribl-bell' : endpointId === BELL_ENDPOINT_ID;
}

/** The newest attempt per endpoint, newest first. */
export function latestDeliveries(deliveries: readonly DeliveryRef[] | undefined): DeliveryRef[] {
  const byEndpoint = new Map<string, DeliveryRef>();
  for (const d of deliveries ?? []) {
    const prev = byEndpoint.get(d.endpointId);
    if (!prev || ms(d.at) >= ms(prev.at)) byEndpoint.set(d.endpointId, d);
  }
  return [...byEndpoint.values()].sort((a, b) => ms(b.at) - ms(a.at));
}

export function deliveryLine(
  d: DeliveryRef,
  opts: {
    endpoints?: readonly NotificationEndpoint[];
    tz?: string;
    withSeconds?: boolean;
  } = {},
): DeliveryLine {
  const at = ms(d.at);
  const endpoint = opts.endpoints?.find((e) => e.id === d.endpointId);
  const format = endpoint?.format;
  const bell = isBellEndpoint(d.endpointId, opts.endpoints);
  const base = { endpointId: d.endpointId, at, ...(format ? { format } : {}), ...(bell ? { bell } : {}) };
  if (isDelivered(d)) {
    return {
      ...base,
      tone: 'ok',
      // A notification target's 2xx is Cribl accepting it, not the target receiving it: "Handed to Cribl for …".
      text: t(endpoint && channelOf(endpoint) === 'cribl-target' ? 'incidents.handedTo' : 'incidents.sentTo', {
        endpoint: endpointName(d.endpointId, opts.endpoints),
        time: formatClockTime(at, opts.tz, opts.withSeconds),
      }),
    };
  }
  if (d.error === 'host_not_authorized') return { ...base, tone: 'blocked', text: t('incidents.deliveryBlocked') };
  // A Cribl channel on a Leader without the notification API (404/405) or refusing it (401/403): say why it went nowhere.
  if (d.error === 'not_available') return { ...base, tone: 'blocked', text: t('incidents.deliveryUnavailable', { status: d.status }) };
  if (d.error === 'not_permitted') return { ...base, tone: 'blocked', text: t('incidents.deliveryNotPermitted', { status: d.status }) };
  if (d.status === 0)
    return {
      ...base,
      tone: 'retrying',
      text: t('incidents.deliveryNoResponse'),
    };
  // SPEC 12.3: network errors and 5xx are retried; a 4xx is not.
  if (d.status >= 500)
    return {
      ...base,
      tone: 'retrying',
      text: t('incidents.deliveryFailed', { status: d.status }),
    };
  return {
    ...base,
    tone: 'failed',
    text: t('incidents.deliveryFailedFinal', { status: d.status }),
  };
}

/**
 * The one line a single status slot shows (the takeover, the compact card): a landed delivery beats a
 * failing one, and a landed webhook or notification target beats the bell — when Slack and the bell land in
 * the same sweep the stage still reads "Sent to Slack ✓", and the bell shows when it is all that landed.
 */
export function primaryDelivery(lines: readonly DeliveryLine[]): DeliveryLine | undefined {
  const ok = lines.filter((l) => l.tone === 'ok');
  return ok.find((l) => !l.bell) ?? ok[0] ?? lines[0];
}

/** The same order for a list of lines: landed non-bell, landed bell, then the rest (each newest first). */
export function rankDeliveries(lines: readonly DeliveryLine[]): DeliveryLine[] {
  const rank = (l: DeliveryLine) => (l.tone === 'ok' ? (l.bell ? 1 : 0) : 2);
  return lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i)
    .map((x) => x.l);
}

/** One line per endpoint (its latest attempt), newest first. */
export function deliveryLines(
  deliveries: readonly DeliveryRef[] | undefined,
  opts: {
    endpoints?: readonly NotificationEndpoint[];
    tz?: string;
    withSeconds?: boolean;
  } = {},
): DeliveryLine[] {
  return latestDeliveries(deliveries).map((d) => deliveryLine(d, opts));
}

/** Whether any enabled endpoint would be notified about an incident of this severity. */
export function expectsDelivery(severity: Severity, endpoints?: readonly NotificationEndpoint[]): boolean {
  return (endpoints ?? []).some((e) => e.enabled && severityRank(severity) >= severityRank(e.minSeverity ?? 'medium'));
}

// ─── Caught in m:ss (PRD 7, 8.1) ─────────────────────────────────────────────

/** The live clock runs only for this long after an incident opens; after that it shows the measured number. */
export const CAUGHT_LIVE_WINDOW_MS = 15 * 60_000;

/** When the clock starts: the matched commit's deploy (or commit) time, else the first qualifying minute. */
export function caughtStartMs(incident: Pick<Incident, 'commit' | 'caughtInSec' | 'openedAt'>): number {
  const commitMs = commitEffectiveMs(incident);
  if (Number.isFinite(commitMs)) return commitMs;
  const opened = ms(incident.openedAt);
  return incident.caughtInSec !== undefined && Number.isFinite(opened) ? opened - incident.caughtInSec * 1000 : Number.NaN;
}

export interface CaughtState {
  seconds: number;
  /** true while the clock is still counting (no delivery has landed yet) */
  live: boolean;
}

/**
 * The "Caught in m:ss" figure. Once a delivery has landed (or when nothing is due to be delivered) it is
 * the measured number — `caughtInSec`, the same figure the Slack message and the Story caption print. While
 * an enabled endpoint is still owed a delivery (or the last attempt failed), it counts live from the
 * deploy until the delivery lands (PRD 8.1), for at most CAUGHT_LIVE_WINDOW_MS after the incident opened.
 */
export function caughtState(
  incident: Pick<Incident, 'type' | 'commit' | 'caughtInSec' | 'openedAt' | 'closedAt' | 'severity'>,
  deliveries: readonly DeliveryRef[] | undefined,
  nowMs: number,
  expectDeliveryNow: boolean,
): CaughtState | undefined {
  // Budget pace and good news are not "caught": there is no bad change to time.
  if (incident.type === 'budget' || incident.type === 'goodnews') return undefined;
  const start = caughtStartMs(incident);
  const opened = ms(incident.openedAt);
  const measured =
    incident.caughtInSec !== undefined
      ? incident.caughtInSec
      : Number.isFinite(start) && Number.isFinite(opened)
        ? Math.max(0, (opened - start) / 1000)
        : undefined;
  const list = deliveries ?? [];
  const delivered = list.some(isDelivered);
  const owed = expectDeliveryNow || list.length > 0;
  const recent = Number.isFinite(opened) && nowMs - opened < CAUGHT_LIVE_WINDOW_MS;
  if (!incident.closedAt && !delivered && owed && recent && Number.isFinite(start)) {
    return {
      seconds: Math.max(measured ?? 0, (nowMs - start) / 1000),
      live: true,
    };
  }
  if (measured === undefined) return undefined;
  return { seconds: measured, live: false };
}

// ─── Figures ─────────────────────────────────────────────────────────────────

export interface IncidentMeasure {
  before: string;
  /** the worst reading while open; absent for an incident closed before D47 (the drop was not kept) */
  after?: string;
  /** closed incidents: where it recovered to, in the same unit ("76% → 49% · recovered to 89%") */
  recoveredTo?: string;
  /** unit suffix for the figures ('/ hour' for spikes) */
  per?: 'hour';
  /** 'savings ratio' · 'cost per hour' · 'of budget, projected' */
  caption: string;
  /** SPEC 17 sentence: 'Ratio fell from 75% to 50% at 11:42 AM'; without a drop, 'Recovered to 89% at 11:50 AM' */
  sentence: string;
  /** whether "after" is worse than "before" for this measure */
  worse: boolean;
}

/** One reading in the incident type's unit: '$412' an hour, '104%' of budget, '75%' savings ratio. */
export function formatReading(type: IncidentType, value: number): string {
  switch (type) {
    case 'spike':
      return fmtDollars(value);
    case 'budget':
      return fmtPct(value / 100);
    default:
      return fmtPct(value);
  }
}

type MeasureIncident = Pick<Incident, 'type' | 'before' | 'after' | 'recoveredTo' | 'openedAt' | 'closedAt'>;

/**
 * The figures a card prints, read through core/incidents.ts incidentReadings() (D47): the drop as it
 * happened and, once closed, where it recovered to. An incident closed before D47 kept no drop: its only
 * figure is the recovery, and its sentence names the close.
 */
export function incidentMeasure(incident: MeasureIncident, tz?: string): IncidentMeasure {
  const r = incidentReadings(incident);
  const time = formatClockTime(ms(incident.openedAt), tz);
  const before = formatReading(incident.type, r.before);
  const after = r.after === undefined ? undefined : formatReading(incident.type, r.after);
  const recoveredTo = r.recoveredTo === undefined ? undefined : formatReading(incident.type, r.recoveredTo);
  const figures = { before, ...(after !== undefined ? { after } : {}), ...(recoveredTo !== undefined ? { recoveredTo } : {}) };
  const closedSentence = t('incidents.recoveredToAt', { value: recoveredTo ?? '', time: formatClockTime(ms(incident.closedAt), tz) });
  switch (incident.type) {
    case 'spike':
      return {
        ...figures,
        per: 'hour',
        caption: t('incidents.measure.perHour'),
        sentence: after !== undefined ? t('incidents.spikeRose', { before, after, time }) : closedSentence,
        worse: true,
      };
    case 'budget':
      return {
        ...figures,
        caption: t('incidents.measure.budget'),
        sentence: after !== undefined ? t('incidents.budgetPace', { after, time }) : closedSentence,
        worse: true,
      };
    case 'goodnews':
      return {
        ...figures,
        caption: t('incidents.measure.ratio'),
        sentence: t('incidents.ratioRose', { before, after: after ?? '', time }),
        worse: false,
      };
    default:
      return {
        ...figures,
        caption: t('incidents.measure.ratio'),
        sentence: after !== undefined ? t('incidents.ratioFell', { before, after, time }) : closedSentence,
        worse: true,
      };
  }
}

/** '$25' and '$9,125' for 'X a day · Y a year'. */
export function impactFigures(incident: Pick<Incident, 'impactPerDayM'>): {
  perDay: string;
  perYear: string;
} {
  const perDayM = Math.max(0, incident.impactPerDayM ?? 0);
  return { perDay: fmtDollars(perDayM), perYear: fmtDollars(perYear(perDayM)) };
}

/**
 * The money line's wording (the report card's rule, report.card.impact): an open regression is priced a day and, as
 * what it would cost if left, a year; an open spike a day while it lasts; a closed incident a day while it lasted,
 * for how long when that is known. Good news and budget pace keep the day and the year (a rate that persists).
 * The duration keeps its number and unit together (no-break spaces).
 */
export function impactWording(incident: Pick<Incident, 'type' | 'openedAt' | 'closedAt'>): { template: string; duration?: string } {
  if (incident.type !== 'regression' && incident.type !== 'spike') return { template: t('incidents.perDayPerYear') };
  if (incident.closedAt) {
    const sec = openSeconds(incident);
    return sec === undefined
      ? { template: t('incidents.impact.closedNoDuration') }
      : { template: t('incidents.impact.closed'), duration: fmtDurationShort(sec).replace(/ /g, '\u00a0') };
  }
  return { template: t(incident.type === 'spike' ? 'incidents.impact.spike' : 'incidents.impact.open') };
}

/** The money line as plain text (the Demo Console's mini takeover). */
export function impactText(incident: Pick<Incident, 'type' | 'openedAt' | 'closedAt' | 'impactPerDayM'>): string {
  const { template, duration } = impactWording(incident);
  const money = impactFigures(incident);
  return interpolate(template, { perDay: money.perDay, perYear: money.perYear, duration: duration ?? '' });
}

export interface RecoveryMeasure {
  /** how far it had fallen, when known */
  from?: string;
  /** where it recovered to, when known */
  to?: string;
  per?: 'hour';
  caption: string;
}

/**
 * The green card's figures ("50% → 75%"): the drop the closed incident kept (D47) and where it recovered
 * to. An incident closed before D47 kept no drop, so its low comes from `was`, the last open version the
 * presenter saw; without that (a card placed directly, e.g. the Story) only the recovered figure shows. A
 * closed incident with no recovery reading (a demo reset) shows neither.
 */
export function recoveryMeasure(incident: MeasureIncident, was?: Pick<Incident, 'after'>, tz?: string): RecoveryMeasure {
  const now = incidentMeasure(incident, tz);
  const r = incidentReadings(incident);
  const base = { caption: now.caption, ...(now.per ? { per: now.per } : {}) };
  if (now.recoveredTo === undefined) return base;
  const from = r.after ?? (was && Number.isFinite(was.after) ? was.after : undefined);
  if (from === undefined || from === r.recoveredTo) return { ...base, to: now.recoveredTo };
  return { ...base, from: formatReading(incident.type, from), to: now.recoveredTo };
}

/** Seconds an incident was open (opened → closed), for "Open for 4:12"; undefined when unknown or over a day. */
export function openSeconds(incident: Pick<Incident, 'openedAt' | 'closedAt'>): number | undefined {
  const open = ms(incident.openedAt);
  const closed = ms(incident.closedAt);
  if (!Number.isFinite(open) || !Number.isFinite(closed) || closed < open) return undefined;
  const sec = (closed - open) / 1000;
  return sec <= 86_400 ? sec : undefined;
}

/** Delivery attempts made at or after the incident closed: the recovery message itself. */
export function recoveryDeliveries(incident: Pick<Incident, 'closedAt'>, deliveries: readonly DeliveryRef[] | undefined): DeliveryRef[] {
  const closed = ms(incident.closedAt);
  if (!Number.isFinite(closed)) return [];
  return (deliveries ?? []).filter((d) => ms(d.at) >= closed - 1_000);
}

/**
 * 'Recovered · savings back to 75% · closed itself.' (spike / budget variants), from the reading at close
 * (D47); a closed incident with no recovery reading (a demo reset) gets the plain sentence.
 */
export function recoveryText(incident: Pick<Incident, 'type' | 'before' | 'after' | 'recoveredTo' | 'closedAt' | 'closedReason' | 'closedBy'>): string {
  // P1-F07: a member closed it — nothing recovered; say what they did, and who.
  if (incident.closedReason) return memberClosedText(incident);
  const r = incidentReadings(incident);
  // Good news closes as it opens: its `after` is the new level.
  const to = incident.type === 'goodnews' ? r.after : r.recoveredTo;
  switch (incident.type) {
    case 'regression':
    case 'goodnews':
      return to === undefined ? t('incidents.recoveredGeneric') : t('incidents.recovered', { pct: fmtPct(to) });
    case 'spike':
      return to === undefined ? t('incidents.recoveredGeneric') : t('incidents.recoveredSpike', { amount: fmtDollars(to) });
    case 'budget':
      return t('incidents.recoveredBudget');
    default:
      return t('incidents.recoveredGeneric');
  }
}

/** P1-F07: when a member's mute ends, as the chip and the menu print it: { day: 'Sep 27', time: '8:31 PM' }. */
export function muteEndParts(ms: number, tz?: string): { day: string; time: string } {
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return { day: formatLocalMonthDay(ms, zone), time: formatClockTime(ms, tz) };
}

/** P1-F07: 'Accepted as the new normal by Steve Koelpin' (muted, left out of metering), or without a name. */
export function memberClosedText(incident: Pick<Incident, 'closedReason' | 'closedBy'>): string {
  const reason = incident.closedReason ?? 'accepted';
  return incident.closedBy ? t(`incidents.closedBy.${reason}`, { by: incident.closedBy }) : t(`incidents.closedByAnon.${reason}`);
}

// ─── Notes and muting ────────────────────────────────────────────────────────

export const DEMO_PROFILE_NOTE = 'demo-profile';
export const CATCH_UP_NOTE = 'catch-up';

export function hasNote(incident: Pick<Incident, 'notes'>, note: string): boolean {
  return (incident.notes ?? []).includes(note);
}

/** Whole minutes left on a mute (demoState.muted[objectKey]); 0 when not muted. */
export function mutedMinutesLeft(untilIso: string | undefined, nowMs: number): number {
  const until = ms(untilIso);
  if (!Number.isFinite(until) || until <= nowMs) return 0;
  return Math.max(1, Math.ceil((until - nowMs) / 60_000));
}

/** Severity class suffix for styling: high · medium · info · recovered. */
export type Tone = 'high' | 'medium' | 'info' | 'recovered';

export function incidentTone(incident: Pick<Incident, 'severity' | 'closedAt' | 'type' | 'closedReason'>): Tone {
  // P1-F07: accepted, muted or left out is closed but not recovered — neutral, never the saved green.
  if (incident.closedAt && incident.closedReason) return 'info';
  if (incident.closedAt || incident.type === 'goodnews') return 'recovered';
  if (incident.severity === 'high') return 'high';
  if (incident.severity === 'medium') return 'medium';
  return 'info';
}
