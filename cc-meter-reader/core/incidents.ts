// core/incidents.ts — incident identity, titles, notification gating and the per-day incident docs (SPEC 9.4, 12, 17).

import type { BaselinesDoc, DeliveryRef, ISO, Incident, IncidentType, NotificationEndpoint, Severity, Snapshot } from './types.ts';
import { classifyStatus } from './adapters/webhook.ts';
import type { KvDocs } from './kv.ts';
import { reseedBaseline } from './baseline.ts';
import { flowObjectKeys, parseObjectKey } from './flows.ts';
import { fromIso, toIso, utcDayKey } from './time.ts';

export const MAX_INCIDENTS = 500;
export const INCIDENTS_PREFIX = 'incidents/';
/** Recovery band for regressions: back within this many points of the frozen baseline (core/detector.ts). */
export const RECOVERY_POINTS = 5;

const SEVERITY_RANK: Record<Severity, number> = { info: 0, medium: 1, high: 2 };

export function severityRank(s: Severity | undefined): number {
  return s === undefined ? -1 : (SEVERITY_RANK[s] ?? -1);
}

/** 32-bit FNV-1a. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable short id 'inc_xxxxxx' (6 hex) from (type, objectKey, openedAt). */
export function incidentId(type: IncidentType, objectKey: string, openedAtMs: number): string {
  const h = fnv1a(`${type}|${objectKey}|${Math.round(openedAtMs)}`);
  return `inc_${(h & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** 'incidents/YYYY-MM-DD' — the UTC day an incident opened. */
export function incidentsDocKey(ms: number): string {
  return `${INCIDENTS_PREFIX}${utcDayKey(ms)}`;
}

/** SPEC 17 titles. */
export function titleFor(incident: Pick<Incident, 'type' | 'label'>): string {
  switch (incident.type) {
    case 'regression':
      return `Savings dropped: ${incident.label}`;
    case 'spike':
      return `Cost spike: ${incident.label}`;
    case 'budget':
      return `Over budget pace: ${incident.label}`;
    case 'goodnews':
      return `Savings improved: ${incident.label}`;
    default:
      return incident.label;
  }
}

export function isOpen(i: Pick<Incident, 'closedAt'>): boolean {
  return !i.closedAt;
}

export interface IncidentReadings {
  before: number;
  /** the worst reading while open; undefined for an incident closed before D47 (the drop was not kept) */
  after?: number;
  /** the reading at close */
  recoveredTo?: number;
  /** closed before D47: `after` held the reading at close, so the drop is unknown */
  legacy: boolean;
}

/**
 * The figures a renderer may print for an incident (DECISIONS D47); nothing reads `inc.after` for display
 * except through here. Open: `before` and the worst `after`. Closed: the same drop plus `recoveredTo`.
 * Before D47 the detector rewrote `after` with the reading at close, so a closed incident without
 * `recoveredTo` whose `after` sits on the recovered side of `before` — a regression back within the recovery
 * band, a spike or budget under its baseline — reports that reading as `recoveredTo` with the drop unknown.
 * One that still sits on the wrong side (closed by a demo reset, or below the D26 floor) keeps its drop and
 * has no recovery reading. Good news is one-shot and closes as it opens: its `after` is the improvement.
 */
export function incidentReadings(inc: Pick<Incident, 'type' | 'before' | 'after' | 'recoveredTo' | 'closedAt'>): IncidentReadings {
  const { before, after } = inc;
  if (!inc.closedAt || inc.type === 'goodnews') return { before, after, legacy: false };
  if (inc.recoveredTo !== undefined) return { before, after, recoveredTo: inc.recoveredTo, legacy: false };
  const recoveredSide = inc.type === 'regression' ? (before - after) * 100 <= RECOVERY_POINTS : after < before;
  if (!recoveredSide) return { before, after, legacy: false };
  return { before, recoveredTo: after, legacy: true };
}

/** Core-9 (M8): a failed endpoint waits this long before its first retry (core/sweep.ts FAILED_ATTEMPT_COOLDOWN_MS). */
export const ENDPOINT_FAILED_RETRY_MS = 2 * 60_000;
/**
 * Founder-build r2 core-1 (FINDINGS_R2 #1): the back-off ladder a retryable failure climbs, in multiples of the first
 * wait: 2 → 4 → 8 minutes. After it, an endpoint whose incident another endpoint delivered waits for the reminder
 * cadence (the cooldown: the member was told); one nobody has delivered keeps doubling, capped at the cooldown.
 */
export const ENDPOINT_RETRY_LADDER_STEPS = 3;
/** Delivery records kept on one incident (core/sweep.ts). */
export const MAX_INCIDENT_DELIVERIES = 20;

type EndpointRecord = NonNullable<Incident['notified']>[string];

/** A 2xx. */
function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * A failed attempt no retry can fix (SPEC 12.3): a 4xx (403 an unauthorized host, 404, 429 …) or a URL refused before
 * any attempt (`final`, set by the sweep). A network error or a 5xx is retryable. An r1 record (no `final`) is read
 * by its status.
 */
export function isFinalFailure(own: Pick<EndpointRecord, 'status' | 'final'>): boolean {
  if (isOkStatus(own.status)) return false;
  return own.final === true || !classifyStatus(own.status).retry;
}

/**
 * How long an endpoint whose last `fails` attempts in a row failed (retryably) waits before the next: 2, 4, 8 minutes
 * (`firstWaitMs` doubling), then the cooldown once another endpoint delivered the incident, else doubling on; never
 * more than the cooldown.
 */
export function endpointRetryWaitMs(fails: number, cooldownMinutes: number, anotherDelivered: boolean, firstWaitMs = ENDPOINT_FAILED_RETRY_MS): number {
  const cap = Math.max(firstWaitMs, cooldownMinutes * 60_000);
  const n = Math.max(1, Math.floor(fails) || 1);
  if (n > ENDPOINT_RETRY_LADDER_STEPS && anotherDelivered) return cap;
  return Math.min(cap, firstWaitMs * 2 ** Math.min(n - 1, 30));
}

/**
 * Whether `endpoint` should hear about `incident` now (SPEC 9.4 / 12):
 * the endpoint is enabled and the severity meets its minSeverity; then a first notification always
 * goes, a closed incident (recovery) always goes, a severity rise over `prevSeverity` goes, and
 * otherwise only once `cooldownMinutes` have passed since lastNotifiedAt.
 *
 * With the endpoint's own record (r1 core-9, M8): its last attempt failed → a final failure (a 4xx) waits for the
 * cooldown or a severity rise; a retryable one waits its back-off (endpointRetryWaitMs, r2 core-1). A closure goes
 * once to each endpoint that has not delivered since the close; one it failed since the close is retried on the same
 * back-off when retryable, never when final.
 */
export function shouldNotify(
  incident: Incident,
  endpoint: Pick<NotificationEndpoint, 'enabled' | 'minSeverity'> & { id?: string },
  nowMs: number,
  cooldownMinutes: number,
  prevSeverity?: Severity,
  failedRetryMs = ENDPOINT_FAILED_RETRY_MS,
): boolean {
  if (!endpoint.enabled) return false;
  if (severityRank(incident.severity) < severityRank(endpoint.minSeverity ?? 'medium')) return false;
  const rose = prevSeverity !== undefined && severityRank(incident.severity) > severityRank(prevSeverity);
  // Founder-build r1 core-9 (M8): the endpoint's own record, when it has one.
  const own = endpoint.id ? incident.notified?.[endpoint.id] : undefined;
  if (own) {
    const okAt = own.ok ? fromIso(own.ok) : Number.NaN;
    const at = fromIso(own.at);
    const closed = incident.closedAt ? fromIso(incident.closedAt) : Number.NaN;
    const failed = !isOkStatus(own.status);
    const others = Object.entries(incident.notified ?? {}).filter(([id]) => id !== endpoint.id);
    if (Number.isFinite(closed)) {
      // A closure goes once to each endpoint that has not delivered since it closed.
      if (okAt >= closed) return false;
      // Tried since the close and failed: a final failure is not retried; a retryable one waits its back-off.
      if (failed && at >= closed) {
        if (isFinalFailure(own)) return false;
        const toldOfClose = others.some(([, r]) => r.ok !== undefined && fromIso(r.ok) >= closed);
        return !(nowMs - at < endpointRetryWaitMs(own.fails ?? 1, cooldownMinutes, toldOfClose, failedRetryMs));
      }
      return true;
    }
    if (failed) {
      // Its last attempt failed: news (a severity rise) goes at once; otherwise a final failure waits for the reminder
      // cadence and a retryable one for its back-off (r2 core-1: r1 re-posted every 2 minutes whatever it answered).
      if (rose) return true;
      if (isFinalFailure(own)) return !(nowMs - at < cooldownMinutes * 60_000);
      // Another endpoint delivered it (its own record, or the incident-wide last 2xx newer than this endpoint's own).
      const lastAny = incident.lastNotifiedAt ? fromIso(incident.lastNotifiedAt) : Number.NaN;
      const anotherDelivered = others.some(([, r]) => r.ok !== undefined) || (Number.isFinite(lastAny) && !(okAt >= lastAny));
      return !(nowMs - at < endpointRetryWaitMs(own.fails ?? 1, cooldownMinutes, anotherDelivered, failedRetryMs));
    }
    if (rose) return true;
    return !Number.isFinite(okAt) || nowMs - okAt >= cooldownMinutes * 60_000;
  }
  if (!incident.lastNotifiedAt) return true;
  if (incident.closedAt) return true;
  if (rose) return true;
  const last = fromIso(incident.lastNotifiedAt);
  return Number.isNaN(last) || nowMs - last >= cooldownMinutes * 60_000;
}

/**
 * The endpoint's record after one more attempt (r2 core-1): a 2xx clears the failure count; a failure counts one more
 * (restarting at a closure's first attempt, which is a new event) and is marked `final` when no retry can fix it.
 */
export function nextEndpointRecord(
  prev: EndpointRecord | undefined,
  last: { at: ISO; status: number; error?: string },
  closedAt?: ISO,
): EndpointRecord {
  if (isOkStatus(last.status)) return { at: last.at, status: last.status, ok: last.at };
  const closed = closedAt ? fromIso(closedAt) : Number.NaN;
  const prevAt = prev ? fromIso(prev.at) : Number.NaN;
  // A closure's first attempt starts a new count; an r1 record without `fails` that failed counts as one.
  const carried = prev && !isOkStatus(prev.status) && !(Number.isFinite(closed) && !(prevAt >= closed)) ? (prev.fails ?? 1) : 0;
  const final = !classifyStatus(last.status).retry || last.error === 'invalid_url' || last.error === 'host_not_authorized';
  return { at: last.at, status: last.status, ...(prev?.ok ? { ok: prev.ok } : {}), fails: carried + 1, ...(final ? { final: true as const } : {}) };
}

/**
 * An incident's delivery refs after one more attempt (r2 core-1): an endpoint keeps one failed ref (a new failure
 * replaces its last one, never appends), and beyond `max` the oldest refs go — failed ones before delivered ones —
 * never an endpoint's last delivered ref or its newest ref. Chronological order is kept.
 */
export function recordDeliveryRef(list: readonly DeliveryRef[] | undefined, ref: DeliveryRef, max = MAX_INCIDENT_DELIVERIES): DeliveryRef[] {
  let out = (list ?? []).slice();
  if (!isOkStatus(ref.status)) out = out.filter((d) => d.endpointId !== ref.endpointId || isOkStatus(d.status));
  out.push(ref);
  if (out.length <= max) return out;
  const keep = new Set<number>();
  const lastOk = new Map<string, number>();
  const newest = new Map<string, number>();
  out.forEach((d, idx) => {
    if (isOkStatus(d.status)) lastOk.set(d.endpointId, idx);
    newest.set(d.endpointId, idx);
  });
  for (const idx of [...lastOk.values(), ...newest.values()]) keep.add(idx);
  let excess = out.length - max;
  const drop = new Set<number>();
  for (const okPass of [false, true]) {
    for (let idx = 0; idx < out.length && excess > 0; idx++) {
      if (keep.has(idx) || drop.has(idx) || isOkStatus(out[idx].status) !== okPass) continue;
      drop.add(idx);
      excess--;
    }
  }
  return out.filter((_, idx) => !drop.has(idx));
}

function recency(i: Incident): number {
  const t = fromIso(i.closedAt ?? i.openedAt);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Applies a detector pass to one incidents document: `opened` are added, `updated` and `closed`
 * replace the item with the same id (or are added when absent — pass only incidents that belong in
 * this doc, see incidentsDocKey(openedAt)). Newest first by openedAt; beyond 500 items the oldest
 * closed incidents go first, then the oldest open ones.
 */
export function mergeIncidentUpdates(docItems: Incident[], opened: Incident[], updated: Incident[], closed: Incident[]): Incident[] {
  const byId = new Map<string, Incident>();
  for (const i of docItems ?? []) byId.set(i.id, i);
  for (const i of [...opened, ...updated, ...closed]) byId.set(i.id, i);
  let items = [...byId.values()];
  if (items.length > MAX_INCIDENTS) {
    const drop = items
      .slice()
      .sort((a, b) => Number(isOpen(a)) - Number(isOpen(b)) || recency(a) - recency(b))
      .slice(0, items.length - MAX_INCIDENTS);
    const dropIds = new Set(drop.map((i) => i.id));
    items = items.filter((i) => !dropIds.has(i.id));
  }
  return items.sort((a, b) => fromIso(b.openedAt) - fromIso(a.openedAt) || (a.id < b.id ? -1 : 1));
}

/** Groups incidents by the document they belong in (the UTC day they opened). */
export function partitionByDocKey(incidents: Incident[]): Record<string, Incident[]> {
  const out: Record<string, Incident[]> = {};
  for (const i of incidents) {
    const t = fromIso(i.openedAt);
    const key = incidentsDocKey(Number.isNaN(t) ? 0 : t);
    (out[key] ??= []).push(i);
  }
  return out;
}

const DEMO_NOTES = ['demo', 'demo-profile', 'sample'];

/** demoReset (SPEC 11): closes every open incident a demo caused (notes 'demo', 'demo-profile' or 'sample'). */
export function closeDemoIncidents(items: Incident[], nowIso: string): Incident[] {
  return items.map((i) => (isOpen(i) && i.notes?.some((n) => DEMO_NOTES.includes(n)) ? { ...i, closedAt: nowIso } : i));
}

// ─── A member's actions on an open incident (P1-F07) ─────────────────────────
// "Accept as the new normal" closes the incident and re-seats its object's baseline at the level it holds now,
// so the next sweep judges that level ordinary; "Mute for 24 hours" and "Stop alerting on this" close it and write
// settings.mutes / settings.excludedObjectKeys (the caller saves those), which keep anything new from opening.
// Every write is App KV (incidents, baselines, the snapshot); nothing touches Cribl configuration.

export type IncidentAction = 'accept' | 'mute' | 'exclude';
/** "Mute for 24 hours". */
export const MEMBER_MUTE_MS = 24 * 60 * 60_000;
/** The action holds the sweep lock this long at most (a few KV reads and writes). */
export const ACTION_LOCK_TTL_MS = 30_000;
/** A sweep holding the lock is done within a few seconds: the action tries this many times, this far apart. */
export const ACTION_LOCK_TRIES = 5;
export const ACTION_LOCK_RETRY_MS = 1_500;

const CLOSED_REASON: Record<IncidentAction, NonNullable<Incident['closedReason']>> = { accept: 'accepted', mute: 'muted', exclude: 'excluded' };

/**
 * What a member may do with an incident: nothing once it is closed (or with one-shot good news); a drop or a spike
 * can be accepted as the new normal (a level the baseline can learn); a budget pace cannot (the month still ends
 * where it ends), so it offers mute and stop only.
 */
export function incidentActions(inc: Pick<Incident, 'type' | 'closedAt'>): IncidentAction[] {
  if (inc.closedAt || inc.type === 'goodnews') return [];
  return inc.type === 'budget' ? ['mute', 'exclude'] : ['accept', 'mute', 'exclude'];
}

/** The incident closed by a member: when, why and by whom. The drop it reported stays (D47); nothing recovered. */
export function closeByMember(inc: Incident, action: IncidentAction, by: string, nowIso: ISO): Incident {
  const out: Incident = { ...inc, closedAt: nowIso, closedReason: CLOSED_REASON[action] };
  delete out.recoveredTo;
  if (by) out.closedBy = by;
  return out;
}

/**
 * The level an incident's object holds in the snapshot's last minute — what "Accept as the new normal" seats the
 * baseline at, in the detector's own units: a regression's savings ratio (Σ saved ÷ Σ would-have-paid over the
 * object's flows, the sweep's formula), a spike's paid $/hour (Σ paid × 60). Undefined without flows or traffic.
 */
export function currentReading(snapshot: Pick<Snapshot, 'flows'> | null | undefined, inc: Pick<Incident, 'type' | 'objectKey'>): number | undefined {
  const p = parseObjectKey(inc.objectKey);
  if (!p || !snapshot) return undefined;
  const mine = (snapshot.flows ?? []).filter((f) => {
    const k = flowObjectKeys(f);
    return k.route === inc.objectKey || k.pipeline === inc.objectKey || k.input === inc.objectKey || k.output === inc.objectKey;
  });
  if (mine.length === 0) return undefined;
  if (inc.type === 'spike') return mine.reduce((s, f) => s + (f.ratePerHourM || 0), 0);
  const whp = mine.reduce((s, f) => s + (f.whpM || 0), 0);
  const saved = mine.reduce((s, f) => s + (f.savedM || 0), 0);
  return whp > 0 ? Math.min(1, Math.max(0, saved / whp)) : undefined;
}

/**
 * The baselines after accepting `inc` at `reading` (else the incident's own latest reading, `after`): the object's
 * baseline re-seated there and warm, the rule counting towards it cleared — a regression's frozen baseline and any
 * good-news streak; a spike keeps when it last opened (one per object per 24 h still holds).
 */
export function acceptIntoBaselines(
  baselines: BaselinesDoc | null | undefined,
  inc: Pick<Incident, 'type' | 'objectKey' | 'after' | 'openedAt'>,
  reading: number | undefined,
  warmupSamples: number,
  nowIso: ISO,
): BaselinesDoc {
  const byObject = { ...(baselines?.byObject ?? {}) };
  const rules = { ...(baselines?.rules ?? {}) };
  const level = reading !== undefined && Number.isFinite(reading) ? reading : inc.after;
  byObject[inc.objectKey] = reseedBaseline(level, warmupSamples, byObject[inc.objectKey]);
  if (inc.type === 'spike') rules[`spike|${inc.objectKey}`] = { streak: 0, recoveryStreak: 0, lastOpenedAt: inc.openedAt };
  else {
    delete rules[`regression|${inc.objectKey}`];
    delete rules[`goodnews|${inc.objectKey}`];
  }
  const out: BaselinesDoc = { schemaVersion: 1, updatedAt: nowIso, byObject, rules };
  if (baselines?.budgetEvaluatedAt !== undefined) out.budgetEvaluatedAt = baselines.budgetEvaluatedAt;
  return out;
}

/**
 * The snapshot with a member's close applied, so every card reads it on the next poll instead of after the next
 * sweep: the incident replaced, the open count re-counted, the object's flows no longer flagged by it, and — for a
 * mute — marked muted until it ends. The next sweep rebuilds all of this from the incident docs.
 */
export function closeInSnapshot(snapshot: Snapshot, closed: Incident, opts: { mutedUntil?: ISO } = {}): Snapshot {
  const incidents = (snapshot.incidents ?? []).some((i) => i.id === closed.id)
    ? snapshot.incidents.map((i) => (i.id === closed.id ? closed : i))
    : [closed, ...(snapshot.incidents ?? [])];
  const stillOpen = new Set(incidents.filter((i) => !i.closedAt).map((i) => `${i.type}|${i.objectKey}`));
  const flows = (snapshot.flows ?? []).map((f) => {
    const k = flowObjectKeys(f);
    const hit = [k.route, k.pipeline, k.input, k.output].includes(closed.objectKey);
    if (!hit) return f;
    let next = f;
    const flagged =
      (f.state === 'regression' && ![k.route, k.pipeline].some((x) => x && stillOpen.has(`regression|${x}`))) ||
      (f.state === 'spike' && !(k.input && stillOpen.has(`spike|${k.input}`)));
    if (flagged) next = { ...next, state: 'ok' };
    if (opts.mutedUntil) next = { ...next, muted: true, mutedUntil: opts.mutedUntil, mutedByMember: true };
    return next;
  });
  return { ...snapshot, incidents, flows, openIncidents: incidents.filter((i) => !i.closedAt).length };
}

export interface IncidentActionRequest {
  action: IncidentAction;
  /** the incident as the caller shows it (its doc's copy wins when the doc holds it) */
  incident: Incident;
  /** the member, for "Accepted by …" (getCriblUser: full name, else username) */
  by: string;
  /** the lock owner (the tab's id) */
  owner: string;
  nowMs: number;
  /** accept: the level to learn (currentReading), else the incident's `after` */
  reading?: number;
  /** accept: settings.thresholds.warmupSamples */
  warmupSamples?: number;
  /** mute: when it ends (the flows read muted until then) */
  mutedUntil?: ISO;
  /** between lock attempts (tests pass a no-op) */
  sleep?: (ms: number) => Promise<void>;
}

export type IncidentActionResult =
  | { ok: true; incident: Incident }
  /** 'locked': a sweep held the lock through every try; 'closed': it was already closed (recovered, or by someone else) */
  | { ok: false; reason: 'locked' | 'closed' | 'error'; incident?: Incident; error?: string };

type ActionDocs = Pick<KvDocs, 'acquireLock' | 'releaseLock' | 'getIncidents' | 'putIncidents' | 'getBaselines' | 'putBaselines' | 'getSnapshot' | 'putSnapshot'>;

/**
 * Runs a member's action under the sweep lock, so a sweep in progress can't write back the open copy: closes the
 * incident in the doc of the day it opened, re-seats the baseline (accept), and patches the snapshot. Settings
 * (mutes, exclusions) are the caller's to save first: should the lock stay busy, the detector closes the
 * incident on the next sweep from them.
 */
export async function runIncidentAction(docs: ActionDocs, req: IncidentActionRequest): Promise<IncidentActionResult> {
  const sleep = req.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let locked = false;
  for (let i = 0; i < ACTION_LOCK_TRIES && !locked; i++) {
    if (i > 0) await sleep(ACTION_LOCK_RETRY_MS);
    locked = await docs.acquireLock(req.owner, ACTION_LOCK_TTL_MS);
  }
  if (!locked) return { ok: false, reason: 'locked' };
  try {
    const nowIso = toIso(req.nowMs);
    const openedMs = fromIso(req.incident.openedAt);
    const key = incidentsDocKey(Number.isNaN(openedMs) ? req.nowMs : openedMs);
    const doc = await docs.getIncidents(key);
    const stored = (doc?.items ?? []).find((i) => i.id === req.incident.id);
    if (stored?.closedAt) return { ok: false, reason: 'closed', incident: stored };
    const closed = closeByMember(stored ?? req.incident, req.action, req.by, nowIso);
    await docs.putIncidents(key, { schemaVersion: 1, items: mergeIncidentUpdates(doc?.items ?? [], [], [], [closed]) });
    if (req.action === 'accept') {
      const baselines = await docs.getBaselines();
      await docs.putBaselines(acceptIntoBaselines(baselines, closed, req.reading, req.warmupSamples ?? 10, nowIso));
    }
    const snapshot = await docs.getSnapshot();
    if (snapshot) await docs.putSnapshot(closeInSnapshot(snapshot, closed, req.action === 'mute' && req.mutedUntil ? { mutedUntil: req.mutedUntil } : {}));
    return { ok: true, incident: closed };
  } catch (e) {
    return { ok: false, reason: 'error', error: e instanceof Error ? e.message : String(e) };
  } finally {
    await docs.releaseLock(req.owner).catch(() => false);
  }
}
