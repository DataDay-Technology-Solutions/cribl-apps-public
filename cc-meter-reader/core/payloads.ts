// core/payloads.ts — the canonical notification payload (SPEC 12.1) and its presets:
// Slack Block Kit (SPEC 12.2, PRD 8.8 item 10), ServiceNow (Tier 2) and generic JSON.

import type { CanonicalPayload, ISO, Incident, NotifyEvent, NotifyFormat, WeeklyReceipt } from './types.ts';
import { MC_PER_DOLLAR, fmtDollars, fmtDollarsCents, fmtDuration, fmtDurationShort, fmtPct, perYear } from './format.ts';
import { displayAuthor, humanize } from './humanize.ts';
import { incidentReadings, titleFor } from './incidents.ts';
import { receiptText } from './receipt.ts';
import { NEW_NORMAL_NOTE } from './detector.ts';
import { parseObjectKey } from './flows.ts';
import { CREDIT_STRINGS, PAYLOAD_STRINGS as S, fill } from './strings.ts';
import { formatLocalTime, fromIso } from './time.ts';

type CanonicalIncident = NonNullable<CanonicalPayload['incident']>;

const KIND_NAMES = { in: 'input', route: 'route', pipe: 'pipeline', out: 'output' } as const;

/** Note on incidents opened on a backfilled minute: "caught on catch-up" (DECISIONS D11). */
export const CATCH_UP_NOTE = 'catch-up';

/** Opened on catch-up: the change showed in a minute metered after a gap, not live. */
export function isCatchUp(i: Pick<Incident, 'notes'> | Pick<CanonicalIncident, 'notes'>): boolean {
  return (i.notes ?? []).includes(CATCH_UP_NOTE);
}

/**
 * Seconds from the change to its DETECTION (REVIEW-3a #13). `caughtInSec` is measured to `openedAt`, the minute
 * the change showed; an incident opened on catch-up was detected later, at `detectedAt`, and that gap counts.
 * Live incidents are detected as they open, so this is `caughtInSec`. The Slack message, the plain-text alert
 * and the canonical payload all carry this figure; the UI can use it for the same number.
 */
export function caughtInSeconds(i: Pick<Incident, 'caughtInSec' | 'openedAt' | 'detectedAt'>): number | undefined {
  if (i.caughtInSec === undefined) return undefined;
  const opened = fromIso(i.openedAt);
  const detected = i.detectedAt ? fromIso(i.detectedAt) : Number.NaN;
  const late = Number.isFinite(opened) && Number.isFinite(detected) && detected > opened ? (detected - opened) / 1000 : 0;
  return Math.round(i.caughtInSec + late);
}

export interface CanonicalOptions {
  incident?: Incident;
  /** Core-10 (M9): the workspace's dollar floor (thresholds.regressionMinCentsPerDay), named by a below-floor close. */
  regressionFloorCentsPerDay?: number;
  receipt?: WeeklyReceipt;
  /** workspace name or id */
  workspace: string;
  /** e.g. 'https://<org>.cribl.cloud/apps/a/meter-reader' — the Ledger deep link is appended */
  linkBase: string;
  /** settings.humanize overrides (label fallback) */
  labels?: Record<string, string>;
  /** defaults to now */
  sentAt?: ISO;
}

/** '<linkBase>/ledger?object=pipe:default:mrd_pay_sample' (colons kept readable). */
export function ledgerLink(linkBase: string, objectKey: string): string {
  const base = (linkBase ?? '').replace(/\/+$/, '');
  return `${base}/ledger?object=${encodeURIComponent(objectKey).replace(/%3A/gi, ':')}`;
}

/** Founder-build r1 core-10 (M9): a regression the D26 dollar floor closed — it recovered nowhere (D47). */
export const BELOW_FLOOR_NOTE = 'below-floor';
export function closedBelowFloor(i: Pick<CanonicalIncident, 'notes' | 'closedAt' | 'closedReason'> | Pick<Incident, 'notes' | 'closedAt' | 'closedReason'>): boolean {
  return !!i.closedAt && !i.closedReason && (i.notes ?? []).includes(BELOW_FLOOR_NOTE);
}

function toCanonicalIncident(i: Incident, linkBase: string, labels?: Record<string, string>, floorCentsPerDay?: number): CanonicalIncident {
  const parsed = parseObjectKey(i.objectKey);
  const id = parsed?.id ?? i.objectKey;
  const isRatio = i.type === 'regression' || i.type === 'goodnews';
  const reading = (value: number): { ratio?: number; value?: number } => (isRatio ? { ratio: value } : { value });
  // D47: the drop as it happened, then the reading at close; an incident closed before D47 kept no drop.
  const r = incidentReadings(i);
  const out: CanonicalIncident = {
    id: i.id,
    type: i.type,
    severity: i.severity,
    title: titleFor({ type: i.type, label: i.label || humanize(id, labels) }),
    object: {
      kind: parsed ? KIND_NAMES[parsed.kind] : 'route',
      id,
      label: i.label || humanize(id, labels),
      group: parsed?.groupId ?? '',
    },
    before: reading(r.before),
    after: r.after === undefined ? {} : reading(r.after),
    impact: { perDayMillicents: i.impactPerDayM, perDay: fmtDollars(i.impactPerDayM), perYear: fmtDollars(perYear(i.impactPerDayM)) },
    openedAt: i.openedAt,
    link: ledgerLink(linkBase, i.objectKey),
    notes: [...(i.notes ?? [])],
  };
  if (r.recoveredTo !== undefined) out.recoveredTo = reading(r.recoveredTo);
  if (i.outputId) out.object.destination = i.outputId;
  if (i.cause) out.cause = i.cause;
  if (i.commit) {
    // An API credential's client id reads 'API client' (NOTIFY-3a issue 8).
    // An API credential's client id reads as the member's name for it, else 'API client ··1a2b' (C5, row 10).
    out.commit = { hash: i.commit.hash, message: i.commit.message, author: displayAuthor(i.commit.author, labels), match: i.commit.match };
    if (i.commit.deployedAt) out.commit.deployedAt = i.commit.deployedAt;
  }
  const caught = caughtInSeconds(i);
  if (caught !== undefined) out.caughtInSeconds = caught;
  if (i.closedAt) out.closedAt = i.closedAt;
  if (i.closedAt && i.closedReason) out.closedReason = i.closedReason;
  if (i.closedAt && i.closedBy) out.closedBy = i.closedBy;
  if (closedBelowFloor(i) && floorCentsPerDay !== undefined && Number.isFinite(floorCentsPerDay)) out.floorPerDay = fmtDollars(floorCentsPerDay * 1000);
  return out;
}

/** SPEC 12.1 — sent as-is for the generic preset. */
export function canonicalPayload(event: NotifyEvent, opts: CanonicalOptions): CanonicalPayload {
  const p: CanonicalPayload = {
    schemaVersion: 1,
    app: 'meter-reader',
    event,
    sentAt: opts.sentAt ?? new Date().toISOString(),
    workspace: opts.workspace,
  };
  if (opts.incident) p.incident = toCanonicalIncident(opts.incident, opts.linkBase, opts.labels, opts.regressionFloorCentsPerDay);
  if (opts.receipt) p.receipt = opts.receipt;
  return p;
}

// ─── Slack (Block Kit) ───────────────────────────────────────────────────────

export interface SlackOptions {
  /** display timezone for the context line (defaults to UTC) */
  tz?: string;
  /** settings.humanize overrides for the destination label */
  labels?: Record<string, string>;
}

type SlackText = { type: 'mrkdwn' | 'plain_text'; text: string; emoji?: boolean };
export type SlackBlock =
  | { type: 'header'; text: SlackText }
  | { type: 'section'; text?: SlackText; fields?: SlackText[] }
  | { type: 'context'; elements: SlackText[] }
  | { type: 'actions'; elements: { type: 'button'; text: SlackText; url: string; action_id: string }[] };
export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
/** Escapes the three characters Slack mrkdwn treats as control characters. */
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/**
 * Text inside a Slack code block: escaped, and a backtick in a label becomes a straight quote, so no name can close
 * the block early and have what follows it read as mrkdwn (a mention, a link).
 */
const escCode = (s: string): string => esc(s).replace(/\u0060/g, '\u0027');
const field = (label: string, value: string): SlackText => ({ type: 'mrkdwn', text: clip(`*${label}*\n${value}`, 2000) });

/** P1-F06: a spike closed because its level became ordinary (core/detector NEW_NORMAL_NOTE), not because it came back. */
export function closedAsNewNormal(i: Pick<CanonicalIncident, 'notes'>): boolean {
  return (i.notes ?? []).includes(NEW_NORMAL_NOTE);
}

/** P1-F07: the title prefix of an incident a member closed, by why. */
const MEMBER_CLOSED_PREFIX: Record<NonNullable<CanonicalIncident['closedReason']>, string> = S.memberClosed;

/**
 * The title prefix of a closed incident: 'Recovered: ', 'New normal: ' when nothing came back (P1-F06), or what a
 * member did with it (P1-F07: accepted as the new normal, muted, alerts stopped).
 */
export function closedPrefix(i: Pick<CanonicalIncident, 'notes' | 'closedReason'>): string {
  if (i.closedReason) return MEMBER_CLOSED_PREFIX[i.closedReason] ?? S.closedPrefix;
  // Core-10 (M9): the floor closed it; nothing came back.
  if ((i.notes ?? []).includes(BELOW_FLOOR_NOTE)) return S.closedPrefix;
  return closedAsNewNormal(i) ? S.newNormalPrefix : S.recoveredPrefix;
}

/** P1-F07: ' by Steve Koelpin' after a member's close, '' otherwise. */
function closedByText(i: Pick<CanonicalIncident, 'closedReason' | 'closedBy'>): string {
  return i.closedReason && i.closedBy ? fill(S.closedBy, { by: i.closedBy }) : '';
}

/** Severity glyph for the header: red high · orange medium · green recovered/good news · receipt · blue otherwise (a new normal, a member's close). */
export function slackGlyph(p: CanonicalPayload): string {
  if (p.event === 'receipt.weekly') return ':receipt:';
  const i = p.incident;
  if (!i) return ':large_blue_circle:';
  if ((p.event === 'incident.closed' || i.closedAt) && (closedAsNewNormal(i) || i.closedReason || (i.notes ?? []).includes(BELOW_FLOOR_NOTE))) return ':large_blue_circle:';
  if (p.event === 'incident.closed' || i.closedAt || i.type === 'goodnews') return ':large_green_circle:';
  if (i.severity === 'high') return ':red_circle:';
  if (i.severity === 'medium') return ':large_orange_circle:';
  return ':large_blue_circle:';
}

function commitText(i: CanonicalIncident): string {
  if (!i.commit) return S.noChange;
  const nearby = i.commit.match === 'nearby' ? S.nearby : '';
  return `\`${i.commit.hash.slice(0, 7)}\` ${esc(clip(i.commit.message, 150))}${nearby}`;
}

function perHour(value: number | undefined): string {
  return fill(S.perHour, { amount: fmtDollars(value ?? 0) });
}

const pctOfBudget = (value: number | undefined): string => fill(S.pctOfBudget, { pct: Math.round(value ?? 0) });
const F = S.fields;

/** Seconds an incident was open, for a recovered message; undefined without both timestamps. */
function openSeconds(i: Pick<CanonicalIncident, 'openedAt' | 'closedAt'>): number | undefined {
  const opened = fromIso(i.openedAt);
  const closed = i.closedAt ? fromIso(i.closedAt) : Number.NaN;
  return Number.isFinite(opened) && Number.isFinite(closed) && closed >= opened ? (closed - opened) / 1000 : undefined;
}

type ImpactIncident = Pick<CanonicalIncident, 'type' | 'impact' | 'openedAt' | 'closedAt' | 'closedReason'> &
  Partial<Pick<CanonicalIncident, 'notes' | 'after' | 'floorPerDay'>>;

/** A recovered (or new-normal) incident: closed by the meter, not by a member (P1-F07: a member's close did not end the cost). */
function endedByItself(i: Pick<CanonicalIncident, 'closedAt' | 'closedReason'>): boolean {
  return !!i.closedAt && !i.closedReason;
}

/** D26's default dollar floor, $5 a day (core/detector.ts DEFAULT_REGRESSION_MIN_CENTS_PER_DAY). */
const DEFAULT_FLOOR_CENTS_PER_DAY = 500;

/**
 * What an ended incident came to: its per-day rate over the time it was open (money in millicents), when that time is
 * known and at most a day (the card's rule: a longer or out-of-order span drops the duration). Undefined otherwise.
 */
export function realizedImpactM(i: Pick<CanonicalIncident, 'impact' | 'openedAt' | 'closedAt'>): number | undefined {
  const sec = openSeconds(i);
  if (sec === undefined || sec > 86_400) return undefined;
  return Math.round((Math.max(0, i.impact.perDayMillicents) * sec) / 86_400);
}

/** '$0.09' under $100 (a short blip costs cents), else '$1,234'. */
function fmtRealized(mc: number): string {
  return mc < 100 * MC_PER_DOLLAR ? fmtDollarsCents(mc) : fmtDollars(mc);
}

/**
 * The money line every alert channel prints (the bell, a notification target's text, the Slack fallback, the plain
 * text ServiceNow carries), worded by the incident card's rule (D62; rules round 2 carried it to the channels): an
 * open regression is priced a day and, as what it costs if left, a year; an open spike a day above normal while it
 * lasts; a recovered regression or spike a day while it lasted, for how long and what it came to; good news keeps its
 * year; budget pace is a day over budget. A drop a member accepted or muted did not end (P1-F07): it reads as open.
 */
export function impactPhrase(i: ImpactIncident): string {
  const M = S.impact;
  const money = { perDay: i.impact.perDay, perYear: i.impact.perYear };
  if (i.type === 'budget') return fill(M.overBudget, money);
  if (i.type === 'goodnews') return fill(M.perDayPerYear, money);
  // Core-10 (M9): closed by the dollar floor — still down, never "while it lasted", never a year.
  if (i.closedAt && !i.closedReason && (i.notes ?? []).includes(BELOW_FLOOR_NOTE))
    return fill(M.belowFloor, { floor: i.floorPerDay ?? fmtDollars(DEFAULT_FLOOR_CENTS_PER_DAY * 1000), after: fmtPct(i.after?.ratio ?? 0) });
  if (endedByItself(i)) {
    const sec = openSeconds(i);
    const realized = realizedImpactM(i);
    return sec === undefined || realized === undefined
      ? fill(M.closedNoDuration, money)
      : fill(M.closed, { ...money, duration: fmtDurationShort(sec), realized: fmtRealized(realized) });
  }
  return fill(i.type === 'spike' ? M.spike : M.open, money);
}

/**
 * The field grid. Open: the money, the commit, before → after. Recovered (D47): the same drop, then where it
 * recovered to and how long it was open; an incident closed before D47 kept no drop, so only the recovery shows.
 */
function incidentFields(i: CanonicalIncident, closed: boolean, labels?: Record<string, string>): SlackText[] {
  const commitPair = [field(F.commit, commitText(i)), field(F.by, i.commit ? esc(displayAuthor(i.commit.author, labels)) : '—')];
  const open = closed ? openSeconds(i) : undefined;
  // Core-10 (M9): closed by the dollar floor — still down: no recovery fields, no year.
  const underFloor = closed && closedBelowFloor(i);
  // P1-F07: a drop a member accepted (or muted) did not end — its money reads in the present tense.
  const recovered = closed && !i.closedReason && !underFloor;
  const openFor = open !== undefined ? [field(F.openFor, fmtDuration(open))] : [];
  // The second money field (D62, rules round 2): only an open regression is projected to a year, as what it costs if
  // left; a recovered incident states what it came to while it was open; a spike and budget pace carry no year.
  const realized = recovered ? realizedImpactM(i) : undefined;
  const cameTo = (label: string): SlackText[] => (realized !== undefined ? [field(label, `≈ ${fmtRealized(realized)}`)] : []);
  switch (i.type) {
    case 'spike':
      return [
        field(recovered ? F.wasCostingExtra : F.extraPerDay, i.impact.perDay),
        ...cameTo(F.costWhileOpen),
        ...commitPair,
        field(F.baseline, perHour(i.before.value)),
        ...(i.after.value !== undefined ? [field(recovered ? F.peak : F.now, perHour(i.after.value))] : []),
        ...(i.recoveredTo ? [field(F.now, perHour(i.recoveredTo.value))] : []),
        ...openFor,
      ];
    case 'budget':
      return [
        field(F.overBudgetPerDay, i.impact.perDay),
        ...(i.after.value !== undefined ? [field(recovered ? F.peakProjection : F.projected, pctOfBudget(i.after.value))] : []),
        field(F.threshold, `${Math.round(i.before.value ?? 0)}%`),
        ...(i.recoveredTo ? [field(F.now, pctOfBudget(i.recoveredTo.value))] : []),
        ...openFor,
      ];
    case 'goodnews':
      return [
        field(F.savingPerDay, i.impact.perDay),
        field(F.perYear, i.impact.perYear),
        ...commitPair,
        field(F.before, fmtPct(i.before.ratio ?? 0)),
        field(F.after, fmtPct(i.after.ratio ?? 0)),
      ];
    default:
      return [
        field(recovered ? F.wasLosingPerDay : F.lostPerDay, i.impact.perDay),
        // m15 (#36): an accepted or muted drop reads as open — "a year if left", as its fallback text says; a
        // below-floor close has no year at all (M9).
        ...(recovered ? cameTo(F.lostWhileOpen) : underFloor ? [] : [field(F.perYearIfLeft, i.impact.perYear)]),
        ...commitPair,
        field(F.before, fmtPct(i.before.ratio ?? 0)),
        ...(i.after.ratio !== undefined ? [field(F.after, fmtPct(i.after.ratio))] : []),
        ...(i.recoveredTo ? [field(F.recoveredTo, fmtPct(i.recoveredTo.ratio ?? 0))] : []),
        ...openFor,
      ];
  }
}

/**
 * 'caught in 2:07', or for an incident opened on catch-up 'caught on catch-up, 41:12 after the change'
 * (REVIEW-3a #13). '' without a caught-in figure.
 */
export function caughtLine(i: Pick<CanonicalIncident, 'caughtInSeconds' | 'notes'>): string {
  if (isCatchUp(i)) return i.caughtInSeconds !== undefined ? fill(S.caughtOnCatchUpAfter, { duration: fmtDuration(i.caughtInSeconds) }) : S.caughtOnCatchUp;
  return i.caughtInSeconds !== undefined ? fill(S.caughtIn, { duration: fmtDuration(i.caughtInSeconds) }) : '';
}

function localTime(iso: ISO | undefined, tz: string): string {
  const t = iso ? fromIso(iso) : Number.NaN;
  if (Number.isNaN(t)) return '';
  return `${formatLocalTime(t, tz)}${tz === 'UTC' ? ' UTC' : ''}`;
}

/**
 * Slack incoming-webhook body. Incidents: header (glyph + title), a two-column field grid with the
 * money first and the commit second, a context line ("Meter Reader by Steve Koelpin · <destination> · <local time>"),
 * one "Open in Ledger" button. Closed incidents read "Recovered". Weekly receipt: header + a single
 * section holding the SPEC 12.4 text in a code block.
 */
export function slackPayload(canonical: CanonicalPayload, opts: SlackOptions = {}): SlackMessage {
  const tz = opts.tz ?? 'UTC';
  const glyph = slackGlyph(canonical);

  if (canonical.event === 'receipt.weekly' && canonical.receipt) {
    const r = canonical.receipt;
    return {
      text: esc(fill(S.weeklyFallback, { glyph, label: r.label, amount: fmtDollars(r.savedM) })),
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: clip(fill(S.weeklyHeader, { glyph, label: r.label }), 150), emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`\n${clip(escCode(receiptText(r)), 2990)}\n\`\`\`` } },
        // P0-23: the week on the Receipt, as the incident cards open the Ledger.
        ...(r.link
          ? [{ type: 'actions' as const, elements: [{ type: 'button' as const, text: { type: 'plain_text' as const, text: S.openReceipt }, url: r.link, action_id: 'open_receipt' }] }]
          : []),
      ],
    };
  }

  const i = canonical.incident;
  if (!i) {
    const text = canonical.event === 'test' ? S.testTitle : fill(S.eventTitle, { event: canonical.event });
    return { text: esc(`${glyph} ${text}`), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: esc(`${glyph} ${text}`) } }] };
  }

  // Good news opens and closes in one minute (a one-shot announcement): it is never a recovery (row 9, PACK_PAYOFF F1),
  // so it keeps its caught-in line and the time it was found, like an opened alert.
  const recovered = (canonical.event === 'incident.closed' || !!i.closedAt) && i.type !== 'goodnews';
  const prefix = canonical.event === 'test' ? S.testPrefix : recovered ? closedPrefix(i) : '';
  const title = `${prefix}${i.title}`;
  const destination = i.object.destination ? humanize(i.object.destination, opts.labels) : i.object.group;
  const when = recovered && i.closedAt ? localTime(i.closedAt, tz) : localTime(i.openedAt, tz);
  const context = [CREDIT_STRINGS.signature, destination, `${when}${recovered ? closedByText(i) : ''}`, recovered ? '' : caughtLine(i)].filter((s) => s).join(' · ');
  const notes = i.notes.includes('demo-profile') ? S.demoProfile : '';
  return {
    // The top-level text is the notification fallback: Slack reads &, < and > as control characters there too.
    text: esc(fill(S.incidentFallback, { glyph, title, money: impactPhrase(i) })),
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: clip(`${glyph} ${title}`, 150), emoji: true } },
      { type: 'section', fields: incidentFields(i, recovered, opts.labels) },
      { type: 'context', elements: [{ type: 'mrkdwn', text: esc(`${context}${notes}`) }] },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: S.openLedger }, url: i.link, action_id: 'open_in_ledger' }] },
    ],
  };
}

// ─── ServiceNow, generic, dispatch ───────────────────────────────────────────

export interface ServiceNowPayload {
  short_description: string;
  description: string;
  urgency: 1 | 2 | 3;
  u_meter_reader: CanonicalIncident | WeeklyReceipt | { event: NotifyEvent };
}

/**
 * Plain-text incident summary (ServiceNow description, logs). A recovered incident adds where it recovered to
 * (D47); one closed before D47 kept no drop, so its figure line opens with the baseline instead of an arrow.
 */
export function incidentPlainText(i: CanonicalIncident, tz = 'UTC'): string {
  const P = S.plain;
  const money = { money: impactPhrase(i) };
  const lines = [i.title];
  if (i.type === 'regression' || i.type === 'goodnews') {
    const drop = i.after.ratio !== undefined ? `${fmtPct(i.before.ratio ?? 0)} → ${fmtPct(i.after.ratio)}` : fill(P.before, { value: fmtPct(i.before.ratio ?? 0) });
    const back = i.recoveredTo ? fill(P.recoveredTo, { value: fmtPct(i.recoveredTo.ratio ?? 0) }) : '';
    lines.push(fill(P.ratio, { drop, back, ...money }));
  } else if (i.type === 'spike') {
    const rise = i.after.value !== undefined ? `${perHour(i.before.value)} → ${perHour(i.after.value)}` : fill(P.before, { value: perHour(i.before.value) });
    const back = i.recoveredTo ? fill(P.recoveredTo, { value: perHour(i.recoveredTo.value) }) : '';
    lines.push(fill(P.cost, { rise, back, ...money }));
  } else {
    const pace = i.after.value !== undefined ? fill(P.projected, { value: pctOfBudget(i.after.value) }) : fill(P.threshold, { pct: Math.round(i.before.value ?? 0) });
    const back = i.recoveredTo ? fill(P.recoveredTo, { value: pctOfBudget(i.recoveredTo.value) }) : '';
    lines.push(fill(P.budget, { pace, back, perDay: i.impact.perDay }));
  }
  lines.push(i.commit ? fill(P.commit, { hash: i.commit.hash.slice(0, 7), message: i.commit.message, author: displayAuthor(i.commit.author) }) : S.noChange);
  const line = caughtLine(i);
  const caught = line ? `${line[0].toUpperCase()}${line.slice(1)} · ` : '';
  const closedWord = i.closedReason
    ? `${closedPrefix(i).replace(/: $/, '')}${closedByText(i)}`
    : closedAsNewNormal(i)
      ? S.closedAsNewNormal
      : closedBelowFloor(i)
        ? S.closed
        : S.recovered;
  // Good news closes the minute it opens (one-shot): it has no close to report and never "Recovered" (row 9, F1).
  // Core-11 (m16, #38): times in the display zone, as Slack prints them (a value that is not a date prints as stored).
  const closedPart = i.closedAt && i.type !== 'goodnews' ? fill(P.closed, { closed: closedWord, at: localTime(i.closedAt, tz) || i.closedAt }) : '';
  lines.push(`${caught}${fill(P.opened, { at: localTime(i.openedAt, tz) || i.openedAt })}${closedPart}`);
  lines.push(fill(S.openLedgerAt, { link: i.link }));
  lines.push(CREDIT_STRINGS.signature);
  return lines.join('\n');
}

const URGENCY: Record<string, 1 | 2 | 3> = { high: 1, medium: 2, info: 3 };

/** SPEC 12.2 ServiceNow wrapper: short_description, plain-text description, urgency high→1 medium→2 info→3. */
export function servicenowPayload(canonical: CanonicalPayload, tz = 'UTC'): ServiceNowPayload {
  if (canonical.receipt) {
    return {
      short_description: fill(S.servicenowWeekly, { label: canonical.receipt.label }),
      description: receiptText(canonical.receipt),
      urgency: 3,
      u_meter_reader: canonical.receipt,
    };
  }
  if (canonical.incident) {
    const i = canonical.incident;
    const recovered = canonical.event === 'incident.closed' || !!i.closedAt;
    return {
      short_description: `${recovered && i.type !== 'goodnews' ? closedPrefix(i) : ''}${i.title}`,
      description: incidentPlainText(i, tz),
      urgency: URGENCY[i.severity] ?? 3,
      u_meter_reader: i,
    };
  }
  const title = fill(S.eventTitle, { event: canonical.event });
  return { short_description: title, description: title, urgency: 3, u_meter_reader: { event: canonical.event } };
}

export function genericPayload(canonical: CanonicalPayload): CanonicalPayload {
  return canonical;
}

/** The body for an endpoint's format. */
export function payloadFor(format: NotifyFormat, canonical: CanonicalPayload, opts: SlackOptions = {}): SlackMessage | ServiceNowPayload | CanonicalPayload {
  switch (format) {
    case 'slack':
      return slackPayload(canonical, opts);
    case 'servicenow':
      return servicenowPayload(canonical, opts.tz ?? 'UTC');
    default:
      return genericPayload(canonical);
  }
}

/**
 * SPEC 12.5 — `event: 'test'` with a synthetic, sample-noted incident (the SPEC 12.1 example numbers). Founder-build r1
 * core-11 (m8): its names are neutral (core/strings.ts testSample) and its link opens the Ledger itself, not an object.
 */
export function testPayload(workspace: string, nowIso: ISO, linkBase = ''): CanonicalPayload {
  const openedMs = fromIso(nowIso);
  const at = (deltaSec: number): ISO => new Date((Number.isNaN(openedMs) ? 0 : openedMs) + deltaSec * 1000).toISOString();
  const incident: Incident = {
    id: 'inc_test00',
    type: 'regression',
    severity: 'high',
    objectKey: `pipe:default:${S.testSample.objectId}`,
    label: S.testSample.label,
    outputId: S.testSample.outputId,
    openedAt: at(0),
    cause: 'commit',
    commit: {
      hash: 'a1f3c9e',
      message: S.testSample.commitMessage,
      author: 'meter-reader',
      committedAt: at(-180),
      deployedAt: at(-171),
      groupId: 'default',
      match: 'message',
    },
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    caughtInSec: 171,
    notes: ['sample'],
    deliveries: [],
  };
  const out = canonicalPayload('test', { incident, workspace, linkBase, sentAt: nowIso });
  if (out.incident) out.incident.link = ledgerRootLink(linkBase);
  return out;
}

/** '<linkBase>/ledger': the Ledger itself (core-11 m8: the test alert's link names no object). */
export function ledgerRootLink(linkBase: string): string {
  return `${(linkBase ?? '').replace(/\/+$/, '')}/ledger`;
}
