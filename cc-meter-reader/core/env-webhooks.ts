// core/env-webhooks.ts — direct webhooks from the runner's environment (DECISIONS D57).
//
// No build stores a webhook URL in App KV (hackathon rule 4.5: a Slack incoming webhook's token is its path, and App
// KV has no encryption a tab or a backend can read back; core/settings.ts `storableSettings`). The one runtime that
// sends direct webhooks is the runner (scripts/runner.ts, D24), outside the platform proxy, and it reads their URLs
// from its own git-ignored .env, never from KV:
//
//   MR_WEBHOOKS="https://hooks.slack.com/services/…, generic:https://relay.example.com/hook"
//       comma-separated https URLs; an optional `slack:`, `generic:` or `servicenow:` prefix picks the payload format
//       (default: slack for hooks.slack.com, generic for any other host). Each becomes endpoint `env-webhook-<n>`,
//       named "Direct webhook (<host>)".
//   MR_DEMO_WEBHOOK_URL="https://webhook.site/…"
//       the demo rig's receiver (docs/RIG.md): endpoint `demo-webhook-site`, Slack format, as `runner --setup` used to
//       store it. Kept under its old id so incidents recorded before D57 still name it.
//
// Every env endpoint takes alerts of medium severity and up and the weekly receipt. What the App may know about them
// is `webhookDescriptor()`: id, name, host and format — never the URL. The runner writes those descriptors to meta
// (`deliveryWebhooks`) so Settings and the incident cards can name where an alert went.

import type { NotificationEndpoint, NotifyFormat, WebhookDescriptor } from './types.ts';
import { hostFromUrl } from './settings.ts';

const FORMATS: readonly NotifyFormat[] = ['slack', 'generic', 'servicenow'];

/** The demo receiver's endpoint id (the id `runner --setup` stored before D57). */
export const DEMO_WEBHOOK_ID = 'demo-webhook-site';

/** One env endpoint, or a reason it was left out (for the runner's start-up line; never the URL). */
export type EnvWebhookResult = { endpoints: NotificationEndpoint[]; skipped: string[] };

function endpoint(id: string, name: string, url: string, host: string, format: NotifyFormat): NotificationEndpoint {
  return { id, name, url, host, format, minSeverity: 'medium', weeklyReceipt: true, enabled: true, channel: 'webhook' };
}

/** Parses MR_WEBHOOKS and MR_DEMO_WEBHOOK_URL (see the header). Invalid entries are skipped and reported by position. */
export function webhooksFromEnv(env: Readonly<Record<string, string | undefined>>): EnvWebhookResult {
  const endpoints: NotificationEndpoint[] = [];
  const skipped: string[] = [];
  const entries = (env.MR_WEBHOOKS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  entries.forEach((entry, i) => {
    const m = /^(slack|generic|servicenow):(https:\/\/.*)$/i.exec(entry);
    const url = m ? m[2] : entry;
    const host = hostFromUrl(url);
    if (!host) {
      skipped.push(`MR_WEBHOOKS entry ${i + 1}: not an https URL without credentials`);
      return;
    }
    const prefixed = m ? (m[1].toLowerCase() as NotifyFormat) : undefined;
    const format: NotifyFormat = prefixed && FORMATS.includes(prefixed) ? prefixed : host === 'hooks.slack.com' ? 'slack' : 'generic';
    endpoints.push(endpoint(`env-webhook-${i + 1}`, `Direct webhook (${host})`, url, host, format));
  });
  const demo = (env.MR_DEMO_WEBHOOK_URL ?? '').trim();
  if (demo) {
    const host = hostFromUrl(demo);
    if (host) endpoints.push(endpoint(DEMO_WEBHOOK_ID, `Demo receiver (${host})`, demo, host, 'slack'));
    else skipped.push('MR_DEMO_WEBHOOK_URL: not an https URL without credentials');
  }
  return { endpoints, skipped };
}

/** What the App may store and show about an env endpoint: never its URL. */
export function webhookDescriptor(e: Pick<NotificationEndpoint, 'id' | 'name' | 'host' | 'format'>): WebhookDescriptor {
  return { id: e.id, name: e.name, host: e.host, format: e.format };
}

/**
 * Descriptors as the UI names deliveries with them: endpoint-shaped, channel 'webhook', with no URL. Anything not
 * well formed is dropped (meta is read from KV).
 */
export function descriptorEndpoints(list: readonly unknown[] | undefined): NotificationEndpoint[] {
  if (!Array.isArray(list)) return [];
  const out: NotificationEndpoint[] = [];
  for (const d of list) {
    if (typeof d !== 'object' || d === null) continue;
    const r = d as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.host !== 'string') continue;
    const format = FORMATS.includes(r.format as NotifyFormat) ? (r.format as NotifyFormat) : 'generic';
    out.push({ id: r.id, name: r.name, url: '', host: r.host, format, minSeverity: 'medium', weeklyReceipt: true, enabled: true, channel: 'webhook' });
  }
  return out;
}
