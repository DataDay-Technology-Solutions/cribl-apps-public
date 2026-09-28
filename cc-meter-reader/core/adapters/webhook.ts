// core/adapters/webhook.ts — webhook delivery with the SPEC 12.3 retry policy.
//
// POST through the platform proxy (a full-URL fetch from the App is routed via /a/<appId>/proxy/<host>/…;
// the host must be packaged in proxies.yml or authorized by an admin). Policy:
//   • timeout 10 s per attempt;
//   • network error (status 0) or 5xx → retry, at most 2 retries, after 2 s then 8 s;
//   • 4xx → no retry; a 403 means the proxy refused an unauthorized host → error 'host_not_authorized';
//   • no auth header is ever set from app code (the platform strips it; admins use headers.inject);
//   • only the configured https URL is posted to: a redirect is an error, never followed, and a host that is
//     loopback, private, link-local or carrier-grade NAT space (or a single-label or .local name) is refused
//     before any attempt, as is a host outside the sender's own list when it has one (the runner's
//     MR_WEBHOOK_HOSTS): the settings a member saves never point the runner at its own network.
// Every attempt yields one DeliveryLog for `notify/log`.

import type { Clock, DeliveryLog, NotifyEvent, WebhookSender } from '../types.ts';
import { defaultSleep, type FetchLike, type FetchInit } from '../http.ts';
import { urlHasCredentials } from '../settings.ts';

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_BACKOFF_MS: readonly number[] = [2_000, 8_000];

export interface DeliverParams {
  sender: WebhookSender;
  url: string;
  /** Sent verbatim when a string, JSON-encoded otherwise. */
  body: string | object;
  clock: Clock;
  sleep?: (ms: number) => Promise<void>;
  /** Log fields (DeliveryLog requires them). */
  endpointId: string;
  event: NotifyEvent | 'demo';
  incidentId?: string;
  kind?: 'notify' | 'demo';
  timeoutMs?: number;
  /** Waits before retry 1, 2, … (its length is the retry count). Default [2000, 8000]. */
  backoffMs?: readonly number[];
}

/** The four octets of a dotted IPv4 literal, else undefined. */
function ipv4(host: string): number[] | undefined {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return undefined;
  const o = host.split('.').map(Number);
  return o.every((n) => n <= 255) ? o : undefined;
}

function publicIpv4(o: readonly number[]): boolean {
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this network, private, loopback, multicast/reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT (tailnets live here)
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && o[2] === 0))) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  return true;
}

/**
 * True for a host a direct webhook may name: a public DNS name or a public IP. A URL's hostname as the WHATWG URL
 * parser gives it (so '0x7f.1' and '2130706433' already read 127.0.0.1, and IPv6 keeps its brackets).
 */
export function isPublicWebhookHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return false;
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    if (v6 === '::' || v6 === '::1') return false;
    if (/^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6)) return false; // unique local, link-local
    const mapped = /^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d{1,3}(?:\.\d{1,3}){3}))$/.exec(v6);
    if (mapped) {
      const o = mapped[3] ? ipv4(mapped[3]) : [parseInt(mapped[1], 16) >> 8, parseInt(mapped[1], 16) & 255, parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255];
      return o !== undefined && publicIpv4(o);
    }
    return true;
  }
  const o = ipv4(host);
  if (o) return publicIpv4(o);
  if (!host.includes('.')) return false; // a single label resolves on the runner's own network
  return !/(^|\.)(localhost|local|internal|home\.arpa|lan)$/.test(host);
}

/** The URL's hostname as fetch would use it, or undefined when it does not parse. */
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Classifies one attempt: its log error code and whether another attempt may help. */
export function classifyStatus(status: number): { ok: boolean; retry: boolean; error?: string } {
  if (status >= 200 && status < 300) return { ok: true, retry: false };
  if (status === 0) return { ok: false, retry: true, error: 'network_error' };
  if (status === 403) return { ok: false, retry: false, error: 'host_not_authorized' };
  if (status >= 500) return { ok: false, retry: true, error: `http_${status}` };
  return { ok: false, retry: false, error: `http_${status}` };
}

/** Any http(s) URL in a message, replaced by its host (DECISIONS D57: a webhook URL is a credential and never reaches KV). */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s'"<>)]+/gi, (u) => hostnameOf(u) ?? 'a URL');
}

/** Delivers one payload. Never throws; returns one DeliveryLog per attempt, in order. */
export async function deliver(p: DeliverParams): Promise<DeliveryLog[]> {
  const sleep = p.sleep ?? defaultSleep;
  const backoff = p.backoffMs ?? WEBHOOK_BACKOFF_MS;
  const timeoutMs = p.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const body = typeof p.body === 'string' ? p.body : JSON.stringify(p.body);
  const logs: DeliveryLog[] = [];
  const log = (attempt: number, at: number, status: number, error?: string, detail?: string): void => {
    const entry: DeliveryLog = { endpointId: p.endpointId, event: p.event, status, attempt, at: new Date(at).toISOString(), kind: p.kind ?? 'notify' };
    if (p.incidentId !== undefined) entry.incidentId = p.incidentId;
    if (error !== undefined) entry.error = error;
    // D57: a transport error can quote the URL it failed on; the log (KV notify/log, incident deliveries) keeps its host only.
    if (detail !== undefined) entry.detail = redactUrls(detail);
    logs.push(entry);
  };

  if (!/^https:\/\/[^\s/]+/i.test(p.url)) {
    log(1, p.clock.now(), 0, 'invalid_url', 'webhook URLs must be https://');
    return logs;
  }
  // P1-G04: a URL with a user name or password is never sent (its secret would sit in plain KV).
  if (urlHasCredentials(p.url)) {
    log(1, p.clock.now(), 0, 'invalid_url', 'webhook URLs must not carry credentials');
    return logs;
  }
  const hostname = hostnameOf(p.url);
  if (hostname === undefined || !isPublicWebhookHost(hostname)) {
    log(1, p.clock.now(), 0, 'host_not_authorized', 'webhook URLs must name a public host');
    return logs;
  }
  if (p.sender.allows && !p.sender.allows(p.url)) {
    log(1, p.clock.now(), 0, 'host_not_authorized', "the host is not on this runtime's webhook host list");
    return logs;
  }

  for (let attempt = 1; attempt <= backoff.length + 1; attempt++) {
    const at = p.clock.now();
    let status = 0;
    let transportError: string | undefined;
    try {
      const res = await p.sender.post(p.url, body, timeoutMs);
      status = res.status;
      transportError = res.error;
    } catch (e) {
      transportError = e instanceof Error ? e.message : String(e);
    }
    const verdict = classifyStatus(status);
    log(attempt, at, status, verdict.error, status === 0 ? transportError : undefined);
    if (verdict.ok || !verdict.retry || attempt > backoff.length) break;
    await sleep(backoff[attempt - 1]);
  }
  return logs;
}

/**
 * An attempt that got no answer within its timeout (the senders here report `timeout after N ms`): the endpoint is
 * taken as down for the rest of a sweep (EPIC_AUDIT P1-E07). A refused connection or a 5xx answers fast and is not one.
 */
export function isTimeoutAttempt(l: Pick<DeliveryLog, 'status' | 'detail'>): boolean {
  return l.status === 0 && /^timeout\b/i.test(l.detail ?? '');
}

/** The final outcome of a deliver() run, for the incident's `deliveries` and the Settings "test" line. */
export function lastAttempt(logs: readonly DeliveryLog[]): DeliveryLog | undefined {
  return logs[logs.length - 1];
}

/**
 * WebhookSender over fetch: a plain JSON POST with a timeout. The response body is drained and ignored.
 * Network failures and timeouts resolve to `{ status: 0, error }` rather than throwing.
 */
export function createFetchWebhookSender(fetchFn: FetchLike, opts: { allowHosts?: readonly string[] } = {}): WebhookSender {
  const allowHosts = opts.allowHosts?.map((h) => h.trim().toLowerCase()).filter(Boolean);
  return {
    ...(allowHosts && allowHosts.length > 0 ? { allows: (url: string) => allowHosts.includes((hostnameOf(url) ?? '').toLowerCase()) } : {}),
    async post(url, body, timeoutMs) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      // A redirect is an error: the configured URL is the only one ever posted to.
      const init: FetchInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error' };
      if (controller) init.signal = controller.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      try {
        const exchange = (async () => {
          const res = await (Reflect.apply(fetchFn, globalThis, [url, init]) as ReturnType<FetchLike>);
          await res.text().catch(() => '');
          return res.status;
        })();
        exchange.catch(() => undefined);
        const outcome = await Promise.race([exchange, timedOut]);
        if (outcome === 'timeout') {
          controller?.abort();
          return { status: 0, error: `timeout after ${timeoutMs} ms` };
        }
        return { status: outcome };
      } catch (e) {
        return { status: 0, error: e instanceof Error ? e.message : String(e) };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
