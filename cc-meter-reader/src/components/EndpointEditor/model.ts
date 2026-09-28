// src/components/EndpointEditor/model.ts — "Where to send alerts" logic (SPEC 5, 12, 12.5, 17).
//
// DECISIONS D57 (hackathon rule 4.5): the App stores no webhook URL in any build. A list endpoint is a Cribl
// notification target (only its target id is stored; the target's secrets stay in Cribl), and the Cribl bell is
// its own row (BellDraft), on by default and stored only once the member changes it. Direct webhooks are sent only
// by the runner, from URLs in its .env (core/env-webhooks.ts); Settings names them from meta.deliveryWebhooks.
// "Send a test alert" sends the SPEC 12.5 synthetic incident through the same delivery router the sweep uses
// (core/delivery.ts `sendChannelTest`; one attempt) and reports the exact status.

import type { CanonicalPayload, CriblHttp, DeliveryLog, NotificationEndpoint, Settings, Severity, WebhookSender } from '../../../core/types.ts';
import { MAX_NOTIFICATION_ENDPOINTS, normalizeEndpoint, validateSettings } from '../../../core/settings.ts';
import { testPayload } from '../../../core/payloads.ts';
import { channelOf, defaultBellEndpoint, renderAlert, sendChannelTest, BELL_ALREADY_STATUS } from '../../../core/delivery.ts';
import { t } from '../../copy/en.ts';
import { CHANNEL_COPY, cc } from './copy.ts';

export const MAX_ENDPOINTS = MAX_NOTIFICATION_ENDPOINTS;

/**
 * A Cribl notification target id (rule 4.5, DECISIONS D57): letters, digits, '_' and '-', as Cribl names its objects.
 * The field is typed by hand when the list is not loaded, so a pasted webhook URL (its token is its path) would
 * otherwise be stored in plain App KV as the "id". Nothing that fails this is stored, tested or connected.
 */
export const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

export function isTargetIdShaped(id: string): boolean {
  return TARGET_ID_PATTERN.test(id.trim());
}

/**
 * Whether text reads as a web address: a scheme ('https://', 'hooks://…') or a host with a path ('hooks.slack.com/
 * services/…'). An endpoint's name is shown, never followed, so it may not be one (rule 4.5: a URL can carry its secret).
 */
export function looksLikeUrl(text: string): boolean {
  const s = text.trim();
  return /[a-z][a-z0-9+.-]*:\/\//i.test(s) || /(?:^|[\s(<"'])[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\/\S/i.test(s);
}

/** The channel a list endpoint uses (the bell is its own row; D57: no direct webhook is ever a list endpoint). */
export type ListChannel = 'cribl-target';

export interface EndpointDraft {
  id: string;
  name: string;
  /** Always a Cribl notification target (D57). */
  channel: ListChannel;
  /** The chosen target id ('' until chosen). */
  criblTargetId: string;
  /** The endpoint is stored (it came from settings): removing it is confirmed. */
  saved: boolean;
  minSeverity: Severity;
  /** The Monday weekly receipt goes to this target too. */
  weeklyReceipt: boolean;
  enabled: boolean;
  lastTest?: NotificationEndpoint['lastTest'];
  /** The stored target id of a saved endpoint (lastTest survives only while it is unchanged). */
  savedTargetId?: string;
  /**
   * When a member confirmed a test arrived in the target, and which target id that was (core's
   * NotificationEndpoint.confirmedAt / confirmedTargetId, craft review round 2). Counts only while the id is unchanged.
   */
  confirmedAt?: string;
  confirmedTargetId?: string;
}

/** The confirmation fields a stored endpoint may carry (read structurally, so older settings simply have none). */
type Confirmation = { confirmedAt?: string; confirmedTargetId?: string };

/** Whether a member confirmed that a test reached this draft's current target. */
export function arrivalConfirmed(d: Pick<EndpointDraft, 'confirmedAt' | 'confirmedTargetId' | 'criblTargetId'>): boolean {
  const id = d.criblTargetId.trim();
  return !!d.confirmedAt && id !== '' && d.confirmedTargetId === id;
}

export function draftFromEndpoint(e: NotificationEndpoint): EndpointDraft {
  const d: EndpointDraft = {
    id: e.id,
    name: e.name,
    channel: 'cribl-target',
    criblTargetId: e.criblTargetId ?? '',
    saved: true,
    minSeverity: e.minSeverity,
    weeklyReceipt: e.weeklyReceipt,
    enabled: e.enabled,
  };
  if (e.lastTest) d.lastTest = e.lastTest;
  d.savedTargetId = d.criblTargetId;
  const c = e as NotificationEndpoint & Confirmation;
  if (c.confirmedAt && c.confirmedTargetId) {
    d.confirmedAt = c.confirmedAt;
    d.confirmedTargetId = c.confirmedTargetId;
  }
  return d;
}

/** A fresh endpoint: a Cribl notification target, medium severity, weekly receipt on, enabled (EPIC_AUDIT P0-10; D57). */
export function newEndpointDraft(id: string): EndpointDraft {
  return { id, name: '', channel: 'cribl-target', criblTargetId: '', saved: false, minSeverity: 'medium', weeklyReceipt: true, enabled: true };
}

export function isSaved(d: EndpointDraft): boolean {
  return d.saved;
}

/** The stored endpoint for a draft: only the target id, no URL, no secret. `lastTest` survives only while the target is unchanged. */
export function draftToEndpoint(d: EndpointDraft): NotificationEndpoint {
  const e = normalizeEndpoint({ id: d.id, name: d.name.trim(), url: '', format: 'generic', minSeverity: d.minSeverity, weeklyReceipt: d.weeklyReceipt, enabled: d.enabled, channel: 'cribl-target', criblTargetId: d.criblTargetId.trim() });
  if (d.lastTest && d.criblTargetId.trim() !== '' && d.criblTargetId === d.savedTargetId) e.lastTest = d.lastTest;
  // the confirmation travels only while it names the target the endpoint now uses
  if (arrivalConfirmed(d)) Object.assign(e as NotificationEndpoint & Confirmation, { confirmedAt: d.confirmedAt, confirmedTargetId: d.confirmedTargetId });
  return e;
}

/** The list endpoints (Cribl targets); the bell is edited as its own row, and no stored webhook reaches here (D57). */
export function draftsFromSettings(settings: Settings): EndpointDraft[] {
  return (settings.notifications ?? []).filter((e) => channelOf(e) === 'cribl-target').map(draftFromEndpoint);
}

/** Comparable form of a draft list (what would be stored). */
function storedForm(drafts: readonly EndpointDraft[]): string {
  return JSON.stringify(
    drafts.map((d) => {
      const { lastTest: _lastTest, ...e } = draftToEndpoint(d);
      return e;
    }),
  );
}

export function endpointsDirty(drafts: readonly EndpointDraft[], settings: Settings): boolean {
  return storedForm(drafts) !== storedForm(draftsFromSettings(settings));
}

/** Endpoints added, changed or removed relative to the stored list (the save bar's count). */
export function endpointDirtyCount(drafts: readonly EndpointDraft[], settings: Settings): number {
  const stored = new Map(draftsFromSettings(settings).map((d) => [d.id, storedForm([d])]));
  let n = 0;
  for (const d of drafts) if (stored.get(d.id) !== storedForm([d])) n++;
  const ids = new Set(drafts.map((d) => d.id));
  for (const id of stored.keys()) if (!ids.has(id)) n++;
  return n;
}

export interface EndpointFieldErrors {
  name?: string;
  criblTargetId?: string;
  minSeverity?: string;
}

/** Settings with this endpoint list, plus inline errors per draft index (core validateSettings + SPEC 17 copy). */
export function applyEndpoints(
  current: Settings,
  drafts: readonly EndpointDraft[],
  bell?: BellDraft,
): { next: Settings; errors: Record<number, EndpointFieldErrors>; listError?: string } {
  // List endpoints first (their indices are the drafts' indices), then the bell when it is stored.
  const bellEndpoint = bell ? bellToEndpoint(bell) : (current.notifications ?? []).find((e) => channelOf(e) === 'cribl-bell');
  const next: Settings = { ...current, notifications: [...drafts.map(draftToEndpoint), ...(bellEndpoint ? [bellEndpoint] : [])] };
  const errors: Record<number, EndpointFieldErrors> = {};
  let listError: string | undefined;
  for (const e of validateSettings(next).errors) {
    if (e.field === 'notifications') {
      listError = e.message;
      continue;
    }
    const m = /^notifications\[(\d+)\]\.(\w+)$/.exec(e.field);
    if (!m) continue;
    const i = Number(m[1]);
    const key = m[2] as keyof EndpointFieldErrors;
    if (key !== 'name' && key !== 'minSeverity' && key !== 'criblTargetId') continue;
    errors[i] = { ...errors[i], [key]: e.message };
  }
  // Rule 4.5 (D57), checked here whatever core's validation says, and after it so the message is always this one: a
  // target id that is not id-shaped, or a name that is a web address, never reaches App KV from this editor.
  drafts.forEach((d, i) => {
    const id = d.criblTargetId.trim();
    if (id !== '' && !isTargetIdShaped(id)) errors[i] = { ...errors[i], criblTargetId: t('settings.notify.channels.target.idShape') };
    if (looksLikeUrl(d.name)) errors[i] = { ...errors[i], name: t('settings.notify.nameNoUrl') };
  });
  return listError ? { next, errors, listError } : { next, errors };
}

/** The fields an endpoint editor can flag. */
export type EndpointField = keyof EndpointFieldErrors;

/** Fields the member has left (blurred), per draft id. */
export type TouchedFields = Readonly<Record<string, readonly EndpointField[]>>;

/**
 * The errors to show (EPIC_AUDIT P1-G05): a new endpoint is not red before a keystroke. An error shows once its
 * field was left (blurred), or everywhere after a Save attempt (`revealAll`). A saved endpoint keeps showing
 * its errors as they appear.
 */
export function visibleEndpointErrors(
  drafts: readonly EndpointDraft[],
  errors: Readonly<Record<number, EndpointFieldErrors>>,
  touched: TouchedFields,
  revealAll: boolean,
): Record<number, EndpointFieldErrors> {
  if (revealAll) return { ...errors };
  const out: Record<number, EndpointFieldErrors> = {};
  drafts.forEach((d, i) => {
    const e = errors[i];
    if (!e) return;
    const left = new Set(touched[d.id] ?? []);
    const shown: EndpointFieldErrors = {};
    for (const [field, message] of Object.entries(e) as [EndpointField, string | undefined][]) {
      if (message === undefined) continue;
      if (left.has(field) || isSaved(d)) shown[field] = message;
    }
    if (Object.keys(shown).length > 0) out[i] = shown;
  });
  return out;
}

/** Counts the inline errors in a per-index error map. */
export function countEndpointErrors(errors: Readonly<Record<number, EndpointFieldErrors>>): number {
  return Object.values(errors).reduce((n, e) => n + Object.keys(e).length, 0);
}

/** The "Last test …" caption for a saved endpoint (EPIC_AUDIT P1-G09): a sent or failed test, never a bare number. */
export function lastTestCaption(lastTest: NonNullable<NotificationEndpoint['lastTest']>, ago: string): string {
  const { status } = lastTest;
  if (status >= 200 && status < 300) return t('settings.notify.lastTestOk', { status, ago });
  if (status === 0) return t('settings.notify.lastTestNoResponse', { ago });
  return t('settings.notify.lastTestFailed', { status, ago });
}

/** Fresh endpoint id (uuid when the platform has one). */
export function createEndpointId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `ep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Test alert (SPEC 12.5) ──────────────────────────────────────────────────

export type TestResultKind = 'sent' | 'failed';

export interface TestResult {
  kind: TestResultKind;
  status: number;
  host: string;
  /** SPEC 17 inline line */
  message: string;
  at: string;
}

export interface TestMessageOptions {
  workspace: string;
  linkBase: string;
  nowIso: string;
  tz: string;
}

/** The canonical test payload (SPEC 12.5). */
export function testCanonical(opts: TestMessageOptions): CanonicalPayload {
  return testPayload(opts.workspace, opts.nowIso, opts.linkBase);
}

// ─── The Cribl bell row (on by default; DECISIONS D23) ───────────────────────

/** The bell as Settings edits it. `stored`: a bell endpoint is already in settings (else it is the implicit default). */
export interface BellDraft {
  enabled: boolean;
  minSeverity: Severity;
  stored: boolean;
}

export function bellFromSettings(settings: Settings): BellDraft {
  const e = (settings.notifications ?? []).find((n) => channelOf(n) === 'cribl-bell');
  return e ? { enabled: e.enabled, minSeverity: e.minSeverity, stored: true } : { enabled: true, minSeverity: 'medium', stored: false };
}

/** The bell endpoint to store: only once it is stored already or differs from the default (no noise in settings). */
export function bellToEndpoint(b: BellDraft): NotificationEndpoint | undefined {
  const def = defaultBellEndpoint();
  if (!b.stored && b.enabled === def.enabled && b.minSeverity === def.minSeverity) return undefined;
  return { ...def, enabled: b.enabled, minSeverity: b.minSeverity };
}

export function bellDirty(b: BellDraft, settings: Settings): boolean {
  const cur = bellFromSettings(settings);
  return b.enabled !== cur.enabled || b.minSeverity !== cur.minSeverity;
}

// ─── Tests through Cribl (bell, notification target) ────────────────────────

/** The inline line for a Cribl-channel test. 208 = the bell already held that message. */
export function describeCriblTest(channel: 'cribl-bell' | 'cribl-target', last: DeliveryLog | undefined, target: string, at: string): TestResult {
  const status = last?.status ?? 0;
  const base = { status, host: '', at };
  if (status >= 200 && status < 300) {
    const message =
      channel === 'cribl-bell'
        ? status === BELL_ALREADY_STATUS
          ? CHANNEL_COPY.bell.already
          : cc(CHANNEL_COPY.bell.sent, { status })
        : cc(CHANNEL_COPY.target.sent, { target, status });
    return { ...base, kind: 'sent', message };
  }
  const error = last?.error;
  let message: string;
  if (error === 'relay_missing') message = CHANNEL_COPY.target.notConnected;
  else if (error === 'target_missing') message = CHANNEL_COPY.target.chooseFirst;
  else if (error === 'not_permitted') message = cc(CHANNEL_COPY.notPermitted, { status });
  else if (error === 'not_available') message = cc(CHANNEL_COPY.notAvailable, { status });
  else if (status === 0) message = CHANNEL_COPY.noResponse;
  else message = cc(CHANNEL_COPY.failed, { status });
  return { ...base, kind: 'failed', message };
}

export interface CriblTestParams extends TestMessageOptions {
  /** Leader API as the member (CRIBL_API_URL). */
  http: CriblHttp;
  sender: WebhookSender;
  /** A bell or Cribl-target endpoint (draftToEndpoint / bellToEndpoint output, or the default bell). */
  endpoint: NotificationEndpoint;
  now?: () => number;
}

/** Sends ONE test through the bell or a Cribl target and describes the outcome. Never throws. */
export async function sendCriblTest(p: CriblTestParams): Promise<{ result: TestResult; logs: DeliveryLog[] }> {
  const now = p.now ?? Date.now;
  const channel = channelOf(p.endpoint) === 'cribl-bell' ? 'cribl-bell' : 'cribl-target';
  const { logs, last } = await sendChannelTest({ http: p.http, webhook: p.sender, clock: { now } }, p.endpoint, {
    workspace: p.workspace,
    linkBase: p.linkBase,
    tz: p.tz,
    nowIso: p.nowIso,
  });
  return { result: describeCriblTest(channel, last, p.endpoint.criblTargetId ?? '', last?.at ?? new Date(now()).toISOString()), logs };
}

/** The plain text a Cribl target receives for the test alert (the preview under a target test). */
export function testTargetText(opts: TestMessageOptions): string {
  return renderAlert(testCanonical(opts)).text;
}
