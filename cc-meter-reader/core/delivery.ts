// core/delivery.ts — where an alert goes: the delivery router (DECISIONS D23; docs/NOTIFICATIONS.md).
//
// Three channels, one call shape. Every channel returns one DeliveryLog per attempt, exactly like the
// webhook adapter, so the sweep, the incident's `deliveries`, notify/log and the Settings test line read
// them the same way.
//
//   • 'cribl-bell'   POST /system/messages — the Cribl notification bell. Always available, no setup, and
//                    ON by default: resolveEndpoints() adds it when no bell endpoint is stored (a stored
//                    one, e.g. switched off in Settings, wins). Title = the incident title; text = the one-line
//                    money and commit summary; severity high→error, medium→warn, info→info (recoveries info).
//                    Where the Leader has no bell API (404/405) or refuses it (401/403), the default bell is
//                    tried once per pass; an incident alert that nothing else delivered in the pass then logs
//                    one `not_available` / `not_permitted` line, so its card says why it went nowhere.
//                    Message ids are write-once on the Leader, so each alert STATE gets its own id
//                    (`meter-reader-<incident>-<severity|closed>`): a cooldown re-send of the same state
//                    answers 409, logged as 208 "already in the bell" (delivered).
//   • 'cribl-target' A Cribl Notification target (Slack, PagerDuty, email, SNS, webhook) configured by an
//                    administrator; the endpoint stores only the target id, the secrets stay in Cribl.
//                    Delivered through the Search notification relay (core/adapters/cribl-notify.ts).
//   • 'webhook'      Direct HTTPS POST (core/adapters/webhook.ts): the runner runtime, and Enterprise
//                    workspaces where an administrator authorized the host. A 403 is host_not_authorized.

import type { CanonicalPayload, Clock, CriblHttp, DeliveryLog, Logger, NotificationEndpoint, NotifyEvent, Severity, WebhookSender } from './types.ts';
import { WEBHOOK_BACKOFF_MS, deliver as deliverWebhook, lastAttempt } from './adapters/webhook.ts';
import { forwardViaTarget, postBell, relayState, BELL_SEVERITY, type NotifyOutcome, type RelayState } from './adapters/cribl-notify.ts';
import { defaultSleep } from './http.ts';
import { caughtLine, closedPrefix, impactPhrase, incidentPlainText, isCatchUp, payloadFor, testPayload } from './payloads.ts';
import { displayAuthor } from './humanize.ts';
import { coveragePct, partialCoverage, receiptText } from './receipt.ts';
import { fmtDollars, fmtPct, footMoney } from './format.ts';
import { fromIso } from './time.ts';
import { CREDIT_STRINGS, PAYLOAD_STRINGS, fill } from './strings.ts';

// ─── Channels ────────────────────────────────────────────────────────────────
export type Channel = NonNullable<NotificationEndpoint['channel']>;
export const CHANNELS: readonly Channel[] = ['cribl-bell', 'cribl-target', 'webhook'];

/** An endpoint's channel; anything stored before channels existed is a webhook. */
export function channelOf(ep: Pick<NotificationEndpoint, 'channel'>): Channel {
  return ep.channel === 'cribl-bell' || ep.channel === 'cribl-target' ? ep.channel : 'webhook';
}

/** Id of the bell endpoint that is on by default (resolveEndpoints) and of the one Settings stores. */
export const BELL_ENDPOINT_ID = 'cribl-bell';

/** The default bell endpoint: enabled, medium and up, with the weekly receipt (NOTIFY-3a issue 4). */
export function defaultBellEndpoint(): NotificationEndpoint {
  return {
    id: BELL_ENDPOINT_ID,
    name: 'Cribl notifications',
    url: '',
    host: '',
    format: 'generic',
    minSeverity: 'medium',
    weeklyReceipt: true,
    enabled: true,
    channel: 'cribl-bell',
  };
}

/** An endpoint as a delivery pass sees it. `implicit`: the default bell, not stored in settings. */
export type ResolvedEndpoint = NotificationEndpoint & { implicit?: boolean };

/** The stored endpoints plus the default-on bell, unless a bell endpoint is stored. The implicit bell goes last. */
export function resolveEndpoints(stored: readonly NotificationEndpoint[] | undefined): ResolvedEndpoint[] {
  const list: ResolvedEndpoint[] = [...(stored ?? [])];
  if (!list.some((e) => channelOf(e) === 'cribl-bell')) list.push({ ...defaultBellEndpoint(), implicit: true });
  return list;
}

/**
 * The order a sweep delivers in (EPIC_AUDIT P1-E07): Cribl channels first (a stored bell, notification targets: fast,
 * through the Leader), then direct webhooks (a dead host costs a timeout), and the implicit bell last — the router
 * logs "not available" for an alert only after every other endpoint has answered. Stable within each rank.
 */
export function deliveryOrder<T extends ResolvedEndpoint>(endpoints: readonly T[]): T[] {
  const rank = (e: ResolvedEndpoint): number => (e.implicit ? 2 : channelOf(e) === 'webhook' ? 1 : 0);
  return endpoints
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
    .map((x) => x.e);
}

/**
 * Whether an endpoint gets the weekly receipt (NOTIFY-3a issue 4): every channel honours its own
 * `weeklyReceipt`, which defaults to on when unset — the bell and Cribl targets included (the receipt goes
 * through this router like any alert). Only an explicit `false` opts out.
 */
export function wantsWeeklyReceipt(ep: Pick<NotificationEndpoint, 'enabled' | 'weeklyReceipt'>): boolean {
  return ep.enabled && ep.weeklyReceipt !== false;
}

// ─── Rendering (bell text, target message) ───────────────────────────────────
export interface RenderedAlert {
  /** Bell title / target title: 'Savings dropped: Payments API sampling' (with 'Recovered: ' / 'Test: '). */
  title: string;
  /** One line: '$25 a day · $9,125 a year if left · commit a1f3c9e by s.koelpin · Meter Reader by Steve Koelpin' (payloads.ts impactPhrase). */
  line: string;
  /** Plain-text body for a Slack, email or PagerDuty target: title, the math, the commit, the link. */
  text: string;
  /** Recoveries, good news and receipts are info. */
  severity: Severity;
}

type CanonicalIncident = NonNullable<CanonicalPayload['incident']>;

function isRecovered(c: CanonicalPayload, i: CanonicalIncident): boolean {
  return c.event === 'incident.closed' || !!i.closedAt;
}

function commitLine(i: CanonicalIncident): string {
  if (!i.commit) return 'no configuration change found nearby';
  const nearby = i.commit.match === 'nearby' ? ' (nearby change)' : '';
  return `commit ${i.commit.hash.slice(0, 7)} by ${displayAuthor(i.commit.author)}${nearby}`;
}

/** The bell title, the one-line summary and the target text for one canonical payload. */
export function renderAlert(c: CanonicalPayload, tz = 'UTC'): RenderedAlert {
  if (c.event === 'receipt.weekly' && c.receipt) {
    const r = c.receipt;
    // The bell line prints the same footed triple as the receipt text (W3-RECEIPT-1): would have paid − paid = saved.
    const f = footMoney({ whpM: r.whpM, paidM: r.paidM, savedM: r.savedM });
    // Founder-build r3 core-2 (FINDINGS_R3 #1): a week metered in part says how much, as the receipt's own Basis does.
    const cov = r.basis?.coverage;
    const coverage = partialCoverage(cov) ? ` · ${fill(PAYLOAD_STRINGS.weeklyCoverage, { pct: coveragePct(cov) })}` : '';
    return {
      title: `Weekly receipt · ${r.label}`,
      line: `Saved by Cribl ${fmtDollars(f.savedM)} · would have paid ${fmtDollars(f.whpM)} · paid ${fmtDollars(f.paidM)} · ${fmtPct(r.ratio)} saved${coverage} · ${CREDIT_STRINGS.signature}`,
      text: receiptText(r),
      severity: 'info',
    };
  }
  const i = c.incident;
  if (!i) {
    const title = c.event === 'test' ? 'Meter Reader test notification' : `Meter Reader ${c.event}`;
    return { title, line: title, text: title, severity: 'info' };
  }
  // Good news is a one-shot announcement, never a recovery (row 9, PACK_PAYOFF F1); its bell id keeps isRecovered's form.
  const recovered = isRecovered(c, i) && i.type !== 'goodnews';
  const prefix = c.event === 'test' ? 'Test: ' : recovered ? closedPrefix(i) : '';
  const title = `${prefix}${i.title}`;
  // D62 (rules round 2): the same money wording as the incident card and every other channel (payloads.ts impactPhrase).
  const money = impactPhrase(i);
  const caught = !recovered && isCatchUp(i) ? ` · ${caughtLine(i)}` : '';
  // The bell names its sender, as Slack's context line does: the builder's signature ends the line.
  const line = `${i.type === 'budget' ? money : `${money} · ${commitLine(i)}`}${caught} · ${CREDIT_STRINGS.signature}`;
  const body = incidentPlainText(i, tz).split('\n').slice(1);
  return {
    title,
    line,
    text: [title, ...body].join('\n'),
    // Core-11 (m2, #5): a test posts as info, whatever its sample's severity (README: tests post as info).
    severity: c.event === 'test' || recovered || i.type === 'goodnews' ? 'info' : i.severity,
  };
}

/** Bell message id: one per alert STATE (so a cooldown re-send is a 409, not a second bell entry). */
export function bellMessageId(c: CanonicalPayload): string {
  const sent = fromIso(c.sentAt);
  const stamp = Number.isNaN(sent) ? '0' : String(sent);
  if (c.event === 'receipt.weekly' && c.receipt) return `meter-reader-receipt-${c.receipt.periodStart.slice(0, 10)}`;
  const i = c.incident;
  if (!i) return `meter-reader-${c.event.replace(/\W/g, '-')}-${stamp}`;
  if (c.event === 'test') return `meter-reader-test-${stamp}`;
  return `meter-reader-${i.id}-${isRecovered(c, i) ? 'closed' : i.severity}`;
}

// ─── The router ──────────────────────────────────────────────────────────────
export interface DeliveryDeps {
  /** Leader API (the sweep passes its metered transport so these calls count toward its budget). */
  http: CriblHttp;
  webhook: WebhookSender;
  clock: Clock;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export interface DeliverRequest {
  endpoint: ResolvedEndpoint;
  event: NotifyEvent;
  canonical: CanonicalPayload;
  incidentId?: string;
  /** Slack formatting for the webhook channel. */
  tz?: string;
  labels?: Record<string, string>;
  /** Waits before retry 1, 2, … for the webhook and bell channels (default 2 s, 8 s); [] = one attempt. */
  backoffMs?: readonly number[];
}

export interface DeliveryRouter {
  /**
   * One DeliveryLog per attempt, in order. The implicit bell on a Leader without the bell API (or refusing
   * it) calls the Leader once per pass; after that it logs one `not_available` / `not_permitted` line for an
   * incident alert no other endpoint delivered in this pass, and [] for anything else. Never throws.
   */
  deliver(req: DeliverRequest): Promise<DeliveryLog[]>;
}

/** Log status for a bell 409: 208 Already Reported (delivered; the detail says the Leader answered 409). */
export const BELL_ALREADY_STATUS = 208;

/** The logged reason when the default bell could not be used; the card prints its own copy from the error code. */
export const BELL_UNAVAILABLE_DETAIL = 'Cribl notification API unavailable';

/**
 * A router for one delivery pass (one sweep, one Settings test). It remembers, for its lifetime, each
 * target's relay state (one GET per target) and whether this Leader has a bell API at all.
 */
export function createDeliveryRouter(deps: DeliveryDeps): DeliveryRouter {
  const sleep = deps.sleep ?? defaultSleep;
  const relays = new Map<string, Promise<RelayState>>();
  /** The Leader's answer when the default bell turned out unusable in this pass (404/405, 401/403). */
  let bellUnavailable: NotifyOutcome | undefined;
  /** Incident alerts (`<incident>|<event>`) some endpoint delivered (2xx) in this pass. */
  const deliveredAlerts = new Set<string>();
  const alertKey = (req: DeliverRequest): string | undefined => (req.incidentId !== undefined && req.event !== 'receipt.weekly' && req.event !== 'test' ? `${req.incidentId}|${req.event}` : undefined);

  const logEntry = (req: DeliverRequest, attempt: number, at: number, out: Pick<NotifyOutcome, 'status' | 'error' | 'detail'>): DeliveryLog => {
    const entry: DeliveryLog = {
      endpointId: req.endpoint.id,
      event: req.event,
      status: out.status,
      attempt,
      at: new Date(at).toISOString(),
      kind: 'notify',
    };
    if (req.incidentId !== undefined) entry.incidentId = req.incidentId;
    if (out.error !== undefined) entry.error = out.error;
    if (out.detail !== undefined) entry.detail = out.detail;
    return entry;
  };

  /**
   * The default bell could not be used. An incident alert that no other endpoint delivered in this pass gets
   * one line saying so (the card's "Not delivered: …"); receipts, tests and alerts that reached someone else
   * get nothing, as before. The endpoints resolve with the implicit bell last, so the others have answered.
   */
  const bellSkipped = (req: DeliverRequest, at: number, out: NotifyOutcome): DeliveryLog[] => {
    const key = alertKey(req);
    if (key === undefined || deliveredAlerts.has(key)) return [];
    return [logEntry(req, 1, at, { status: out.status, ...(out.error !== undefined ? { error: out.error } : {}), detail: out.detail ?? BELL_UNAVAILABLE_DETAIL })];
  };

  async function bell(req: DeliverRequest): Promise<DeliveryLog[]> {
    const ep = req.endpoint;
    if (ep.implicit && bellUnavailable) return bellSkipped(req, deps.clock.now(), bellUnavailable);
    const r = renderAlert(req.canonical, req.tz ?? 'UTC');
    const msg = {
      id: bellMessageId(req.canonical),
      severity: BELL_SEVERITY[r.severity],
      title: r.title,
      text: r.line,
      time: deps.clock.now(),
    };
    const backoff = req.backoffMs ?? WEBHOOK_BACKOFF_MS;
    const logs: DeliveryLog[] = [];
    for (let attempt = 1; attempt <= backoff.length + 1; attempt++) {
      const at = deps.clock.now();
      const out = await postBell(deps.http, msg);
      // The default bell is best effort: a Leader without the API (or a member without the grant) is not a
      // failed delivery the member ever asked for. It is tried once per pass; the rest of the pass skips it
      // without a call, and only an alert that reached nobody records why (bellSkipped).
      if (ep.implicit && (out.error === 'not_available' || out.error === 'not_permitted')) {
        bellUnavailable = out;
        deps.logger?.info('delivery: default bell skipped', { status: out.status, error: out.error });
        return bellSkipped(req, at, out);
      }
      const logged = out.ok && out.status === 409 ? { status: BELL_ALREADY_STATUS, detail: 'already in the bell (409)' } : out;
      logs.push(logEntry(req, attempt, at, logged));
      if (out.ok || !out.retry || attempt > backoff.length) break;
      await sleep(backoff[attempt - 1]);
    }
    return logs;
  }

  async function target(req: DeliverRequest): Promise<DeliveryLog[]> {
    const targetId = req.endpoint.criblTargetId ?? '';
    const at = deps.clock.now();
    if (!targetId) return [logEntry(req, 1, at, { status: 0, error: 'target_missing', detail: 'no Cribl notification target chosen' })];
    let state = relays.get(targetId);
    if (!state) {
      state = relayState(deps.http, targetId);
      relays.set(targetId, state);
    }
    const s = await state;
    if (s.state === 'missing') {
      return [logEntry(req, 1, at, { status: 404, error: 'relay_missing', detail: 'connect this target in Settings → Where to send alerts' })];
    }
    if (s.state === 'error') return [logEntry(req, 1, at, { status: s.status, error: s.error, ...(s.detail ? { detail: s.detail } : {}) })];
    const r = renderAlert(req.canonical, req.tz ?? 'UTC');
    const sendAt = deps.clock.now();
    const out = await forwardViaTarget(deps.http, {
      targetId,
      suffix: `${req.incidentId ?? 'mr'}_${req.event}_${sendAt}`,
      title: r.title,
      severity: r.severity,
      message: r.text,
      now: sendAt,
      payload: req.canonical,
    });
    return [logEntry(req, 1, sendAt, out)];
  }

  async function webhook(req: DeliverRequest): Promise<DeliveryLog[]> {
    const ep = req.endpoint;
    const opts: { tz?: string; labels?: Record<string, string> } = {};
    if (req.tz !== undefined) opts.tz = req.tz;
    if (req.labels !== undefined) opts.labels = req.labels;
    return deliverWebhook({
      sender: deps.webhook,
      url: ep.url,
      body: payloadFor(ep.format, req.canonical, opts),
      clock: deps.clock,
      sleep,
      endpointId: ep.id,
      event: req.event,
      ...(req.incidentId !== undefined ? { incidentId: req.incidentId } : {}),
      ...(req.backoffMs !== undefined ? { backoffMs: req.backoffMs } : {}),
    });
  }

  const route = (req: DeliverRequest): Promise<DeliveryLog[]> => {
    switch (channelOf(req.endpoint)) {
      case 'cribl-bell':
        return bell(req);
      case 'cribl-target':
        return target(req);
      default:
        return webhook(req);
    }
  };

  return {
    async deliver(req) {
      try {
        const logs = await route(req);
        const key = alertKey(req);
        if (key !== undefined && logs.some((l) => l.status >= 200 && l.status < 300)) deliveredAlerts.add(key);
        return logs;
      } catch (e) {
        // Unreachable by design (the adapters never throw); a delivery must never break a sweep.
        return [logEntry(req, 1, deps.clock.now(), { status: 0, error: 'network_error', detail: e instanceof Error ? e.message : String(e) })];
      }
    },
  };
}

// ─── Settings test (SPEC 12.5, per channel) ──────────────────────────────────
export interface TestContext {
  workspace: string;
  linkBase: string;
  tz: string;
  nowIso: string;
}

/** Sends ONE test alert (no retries: a test answers fast and shows a 5xx rather than hiding it). Never throws. */
export async function sendChannelTest(deps: DeliveryDeps, endpoint: NotificationEndpoint, ctx: TestContext): Promise<{ logs: DeliveryLog[]; last?: DeliveryLog }> {
  const canonical = testPayload(ctx.workspace, ctx.nowIso, ctx.linkBase);
  const router = createDeliveryRouter(deps);
  const { implicit: _implicit, ...explicit } = endpoint as ResolvedEndpoint;
  const incidentId = canonical.incident?.id;
  const logs = await router.deliver({ endpoint: explicit, event: 'test', canonical, ...(incidentId ? { incidentId } : {}), tz: ctx.tz, backoffMs: [] });
  const last = lastAttempt(logs);
  return last ? { logs, last } : { logs };
}
