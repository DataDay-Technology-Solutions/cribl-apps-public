// core/adapters/cribl-notify.ts — alert delivery THROUGH Cribl itself (DECISIONS D23; docs/NOTIFICATIONS.md).
//
// On Standard and free plans an App cannot declare proxies, so the UI runtime cannot POST to Slack or a
// webhook directly. Cribl can: this adapter drives two documented Leader APIs, both measured live on
// Cribl.Cloud 4.20.1 (docs/NOTIFICATIONS.md §2 has every request and response):
//
//   • The notification bell — `POST /system/messages` (BulletinMessage). Severity is one of
//     info|warn|error|fatal (the spec's `success` answers 400). A message id is write-once: re-posting an id
//     answers 409 "already exists" and PATCH answers 405, so every alert state gets its own id and a 409 is
//     read as "already in the bell" (a retry whose first attempt landed). Nothing here ever deletes.
//
//   • Cribl Notification targets (Slack, PagerDuty, email, SNS, webhook — configured by an administrator,
//     secrets held by Cribl) — through the Search notification relay:
//       1. a saved search `meter_reader_alert_relay` in `default_search` that is never scheduled, carrying
//       2. one notification per target, `meter_reader_relay_<targetId>` (condition 'search'), then
//       3. `POST /search/notifications` (Leader-level: the `/m/default_search/…` form 404s) with
//          `{ id, notificationId, message, … }`. The notification service delivers the event to the
//          notification's targets ONLY when `id` starts with `SEARCH_NOTIFICATION_<notificationId>_`
//          (measured: every other id is accepted with 200 and silently dropped). Extra fields ride along
//          to webhook targets, so the canonical payload travels as `meter_reader`.
//     Steps 1–2 are configuration writes: only an explicit member action creates them (`ensureRelay`,
//     behind a confirmation in Settings). The sweep only reads the relay's state and forwards.
//
// Every function takes a CriblHttp (the sweep passes its metered transport) and never throws: transport
// errors, the sweep's call budget and a second 429 come back as an outcome with an error code.

import type { CanonicalPayload, CriblHttp, HttpResult, Severity } from '../types.ts';

// ─── Paths and ids (measured; docs/NOTIFICATIONS.md) ─────────────────────────
export const BELL_PATH = '/system/messages';
export const TARGETS_PATH = '/notification-targets';
/** Leader-level on purpose: `/m/default_search/search/notifications` answers 404 (measured). */
export const SEARCH_NOTIFY_PATH = '/search/notifications';
export const SEARCH_GROUP = 'default_search';
export const RELAY_SAVED_SEARCH_ID = 'meter_reader_alert_relay';
export const RELAY_NOTIFICATION_PREFIX = 'meter_reader_relay_';
/** The notification service routes a forwarded event only when its id carries this prefix + the notification id. */
export const SEARCH_NOTIFICATION_ID_PREFIX = 'SEARCH_NOTIFICATION_';
/** Target type of the built-in `system_notifications` target: the bell itself (the bell channel covers it). */
export const BELL_TARGET_TYPE = 'bulletin_message';

export const savedSearchPath = (id: string = RELAY_SAVED_SEARCH_ID): string => `/m/${SEARCH_GROUP}/search/saved/${encodeURIComponent(id)}`;
export const SAVED_SEARCHES_PATH = `/m/${SEARCH_GROUP}/search/saved`;
export const relayNotificationsPath = (savedSearchId: string = RELAY_SAVED_SEARCH_ID): string => `${savedSearchPath(savedSearchId)}/notifications`;

// ─── Outcomes ────────────────────────────────────────────────────────────────
export type CriblNotifyError =
  | 'not_permitted' // 401/403: the member (or this App's policies) may not call it
  | 'not_available' // 404/405: this Leader has no such API (not Cribl.Cloud, or an older version)
  | 'relay_missing' // the relay notification for this target does not exist yet
  | 'target_missing' // the target id is not in GET /notification-targets
  | 'invalid_request' // 400
  | 'rate_limited'
  | 'budget'
  | 'network_error'
  | `http_${number}`;

export interface NotifyOutcome {
  /** HTTP status of the final call; 0 when no response arrived. */
  status: number;
  ok: boolean;
  error?: CriblNotifyError;
  /** Short human detail for the delivery log (e.g. 'already in the bell'). */
  detail?: string;
  /** Worth another attempt (network error, 5xx). */
  retry: boolean;
}

/** Calls the Leader; a thrown error (budget, rate limit, transport) becomes a status-0 result with a code. */
async function call(http: CriblHttp, method: 'GET' | 'POST', path: string, body?: unknown): Promise<HttpResult & { thrown?: CriblNotifyError; message?: string }> {
  try {
    return await http.request(method, path, body);
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    const message = e instanceof Error ? e.message : String(e);
    const thrown: CriblNotifyError = name === 'BudgetExceeded' ? 'budget' : name === 'RateLimited' ? 'rate_limited' : 'network_error';
    return { status: 0, ok: false, thrown, message };
  }
}

/** The platform's `{ status:'error', message }` body, else the text, clipped for a log line. */
export function errorMessage(res: HttpResult): string | undefined {
  const j = res.json as { message?: unknown } | undefined;
  const m = typeof j?.message === 'string' ? j.message : typeof res.text === 'string' ? res.text : undefined;
  if (!m) return undefined;
  const flat = m.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

/** Maps one Leader answer to an outcome. `conflictOk`: a 409 means the object already exists (idempotent create). */
export function classifyCribl(res: HttpResult & { thrown?: CriblNotifyError; message?: string }, conflictOk = false): NotifyOutcome {
  const s = res.status;
  if (res.thrown) return { status: 0, ok: false, error: res.thrown, retry: res.thrown === 'network_error', ...(res.message ? { detail: res.message } : {}) };
  if (s >= 200 && s < 300) return { status: s, ok: true, retry: false };
  if (s === 409 && conflictOk) return { status: s, ok: true, retry: false, detail: 'already exists' };
  const detail = errorMessage(res);
  const withDetail = (o: NotifyOutcome): NotifyOutcome => (detail ? { ...o, detail } : o);
  if (s === 0) return withDetail({ status: 0, ok: false, error: 'network_error', retry: true });
  if (s === 401 || s === 403) return withDetail({ status: s, ok: false, error: 'not_permitted', retry: false });
  if (s === 404 || s === 405) return withDetail({ status: s, ok: false, error: 'not_available', retry: false });
  if (s === 400) return withDetail({ status: s, ok: false, error: 'invalid_request', retry: false });
  if (s === 429) return withDetail({ status: s, ok: false, error: 'rate_limited', retry: false });
  return withDetail({ status: s, ok: false, error: `http_${s}`, retry: s >= 500 });
}

// ─── The bell ────────────────────────────────────────────────────────────────
export type BellSeverity = 'info' | 'warn' | 'error' | 'fatal';
/** high → error, medium → warn, info → info. Recoveries and good news are always info (`success` is refused live). */
export const BELL_SEVERITY: Readonly<Record<Severity, BellSeverity>> = { high: 'error', medium: 'warn', info: 'info' };

export interface BulletinMessage {
  id: string;
  severity: BellSeverity;
  title: string;
  text: string;
  /** epoch ms */
  time: number;
}

/**
 * Posts one bell message. 200 → posted; 409 → this id is already in the bell (a retry, or the same alert
 * state re-sent after the cooldown) and counts as delivered; 404/405 → this Leader has no bell API.
 */
export async function postBell(http: CriblHttp, msg: BulletinMessage): Promise<NotifyOutcome> {
  const out = classifyCribl(await call(http, 'POST', BELL_PATH, msg), true);
  return out.status === 409 ? { ...out, detail: 'already in the bell' } : out;
}

// ─── Notification targets ────────────────────────────────────────────────────
/** What the App keeps of a target: never its URL, token or any other field (GET returns them in full). */
export interface TargetSummary {
  id: string;
  type: string;
  description?: string;
}

export type TargetsResult = { ok: true; status: number; targets: TargetSummary[] } | { ok: false; status: number; error: CriblNotifyError; detail?: string };

/** GET /notification-targets, reduced to id/type/description. The bell's own target is kept; callers filter. */
export async function listTargets(http: CriblHttp): Promise<TargetsResult> {
  const res = await call(http, 'GET', TARGETS_PATH);
  const out = classifyCribl(res);
  if (!out.ok) return { ok: false, status: out.status, error: out.error ?? 'network_error', ...(out.detail ? { detail: out.detail } : {}) };
  const items = (res.json as { items?: unknown } | undefined)?.items;
  const targets: TargetSummary[] = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const r = raw as { id?: unknown; type?: unknown; description?: unknown };
    if (typeof r?.id !== 'string' || r.id === '') continue;
    const t: TargetSummary = { id: r.id, type: typeof r.type === 'string' ? r.type : 'unknown' };
    if (typeof r.description === 'string' && r.description.trim() !== '') t.description = r.description.trim();
    targets.push(t);
  }
  return { ok: true, status: out.status, targets };
}

/** Targets a member can pick for the target channel: everything except the bell's own target. */
export function pickableTargets(targets: readonly TargetSummary[]): TargetSummary[] {
  return targets.filter((t) => t.type !== BELL_TARGET_TYPE);
}

// ─── The Search notification relay ───────────────────────────────────────────
/** `meter_reader_relay_<targetId>`, with anything outside [A-Za-z0-9_-] replaced by '_' (a stable, safe id). */
export function relayNotificationId(targetId: string): string {
  return `${RELAY_NOTIFICATION_PREFIX}${targetId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** The forwarded event's id: the prefix the notification service routes on, then a unique suffix. */
export function relayEventId(notificationId: string, suffix: string): string {
  return `${SEARCH_NOTIFICATION_ID_PREFIX}${notificationId}_${suffix.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

export const RELAY_DESCRIPTION =
  'Meter Reader alert relay. Never scheduled: Meter Reader forwards its alerts through the notifications on this saved search to the Cribl notification targets they name. Safe to delete; Meter Reader recreates it only when someone connects a target in its Settings.';

/** The saved search body (never scheduled; the query is a constant and never runs). */
export function relaySavedSearchBody(): Record<string, unknown> {
  return {
    id: RELAY_SAVED_SEARCH_ID,
    name: RELAY_SAVED_SEARCH_ID,
    description: RELAY_DESCRIPTION,
    query: 'print relay="meter-reader"',
    earliest: '-1m',
    latest: 'now',
    schedule: { enabled: false },
  };
}

/** The relay notification for one target: the measured configuration (condition 'search'). */
export function relayNotificationBody(targetId: string): Record<string, unknown> {
  return {
    id: relayNotificationId(targetId),
    condition: 'search',
    conf: { savedQueryId: RELAY_SAVED_SEARCH_ID, message: 'Meter Reader alert', triggerType: 'resultsCount', triggerComparator: '>', triggerCount: 0 },
    targets: [targetId],
  };
}

export type RelayState =
  | { state: 'ready'; notificationId: string }
  | { state: 'missing'; savedSearch: boolean; notification: boolean }
  | { state: 'error'; status: number; error: CriblNotifyError; detail?: string };

/** One GET: does the relay saved search exist, and does it carry this target's notification? */
export async function relayState(http: CriblHttp, targetId: string): Promise<RelayState> {
  const res = await call(http, 'GET', savedSearchPath());
  if (res.status === 404) return { state: 'missing', savedSearch: false, notification: false };
  const out = classifyCribl(res);
  if (!out.ok) return { state: 'error', status: out.status, error: out.error ?? 'network_error', ...(out.detail ? { detail: out.detail } : {}) };
  const saved = (res.json as { items?: unknown[] } | undefined)?.items?.[0] as { schedule?: { notifications?: { items?: unknown[] } } } | undefined;
  const wanted = relayNotificationId(targetId);
  const found = (saved?.schedule?.notifications?.items ?? []).some((n) => (n as { id?: unknown })?.id === wanted);
  return found ? { state: 'ready', notificationId: wanted } : { state: 'missing', savedSearch: true, notification: false };
}

export interface EnsureRelayResult {
  ok: boolean;
  status: number;
  /** Object ids this call created (nothing when the relay was already there). */
  created: string[];
  error?: CriblNotifyError;
  detail?: string;
}

/**
 * Creates what is missing of the relay for one target: the saved search, then its notification. Never
 * replaces or deletes anything; a 409 (created meanwhile) counts as present. CONFIGURATION WRITES: call it
 * only from an explicit, confirmed member action (AGENTS.md), never from a sweep or a render.
 */
export async function ensureRelay(http: CriblHttp, targetId: string): Promise<EnsureRelayResult> {
  if (!targetId) return { ok: false, status: 0, created: [], error: 'target_missing' };
  const state = await relayState(http, targetId);
  if (state.state === 'ready') return { ok: true, status: 200, created: [] };
  if (state.state === 'error') return { ok: false, status: state.status, created: [], error: state.error, ...(state.detail ? { detail: state.detail } : {}) };
  const created: string[] = [];
  if (!state.savedSearch) {
    const s = classifyCribl(await call(http, 'POST', SAVED_SEARCHES_PATH, relaySavedSearchBody()), true);
    if (!s.ok) return { ok: false, status: s.status, created, error: s.error, ...(s.detail ? { detail: s.detail } : {}) };
    if (s.status !== 409) created.push(`saved search ${RELAY_SAVED_SEARCH_ID}`);
  }
  const n = classifyCribl(await call(http, 'POST', relayNotificationsPath(), relayNotificationBody(targetId)), true);
  if (!n.ok) return { ok: false, status: n.status, created, error: n.error, ...(n.detail ? { detail: n.detail } : {}) };
  if (n.status !== 409) created.push(`notification ${relayNotificationId(targetId)}`);
  return { ok: true, status: n.status, created };
}

export interface ForwardMessage {
  targetId: string;
  /** Unique per delivery (incident id + event + time); the platform does not de-duplicate. */
  suffix: string;
  title: string;
  severity: Severity;
  /** Plain text: what a Slack, email or PagerDuty target shows. */
  message: string;
  /** epoch ms */
  now: number;
  /** Rides along to webhook targets as `meter_reader` (extra fields pass through, measured). */
  payload?: CanonicalPayload;
}

/** The SearchNotification body the relay forwards (docs/NOTIFICATIONS.md §2.4, measured minimal + context). */
export function forwardBody(m: ForwardMessage): Record<string, unknown> {
  const notificationId = relayNotificationId(m.targetId);
  const body: Record<string, unknown> = {
    id: relayEventId(notificationId, m.suffix),
    notificationId,
    savedQueryId: RELAY_SAVED_SEARCH_ID,
    group: SEARCH_GROUP,
    title: m.title,
    severity: BELL_SEVERITY[m.severity],
    message: m.message,
    _raw: m.message,
    now: m.now,
    _time: m.now,
  };
  if (m.payload) body.meter_reader = m.payload;
  return body;
}

/**
 * Hands one message to Cribl's notification service for delivery to `targetId`. A 200 means the service
 * accepted it; the target then delivers asynchronously (Cribl retries a webhook target's 5xx itself).
 * Not retried here: the platform does not de-duplicate, so a retry after a lost answer could double-send.
 */
export async function forwardViaTarget(http: CriblHttp, m: ForwardMessage): Promise<NotifyOutcome> {
  const res = await call(http, 'POST', SEARCH_NOTIFY_PATH, forwardBody(m));
  const out = classifyCribl(res);
  // 500 "Failed to process search notification." — measured when no search notification exists at all.
  if (res.status === 500) return { ...out, error: 'relay_missing', retry: false };
  return { ...out, retry: false };
}
