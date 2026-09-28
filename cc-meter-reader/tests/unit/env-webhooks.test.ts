// tests/unit/env-webhooks.test.ts — DECISIONS D57 (hackathon rules 4.5 and 5.2: plain-text credentials in KV
// disqualify). No build stores a webhook URL: the runner reads its direct webhooks from its own .env
// (core/env-webhooks.ts), delivers them after the stored Cribl channels, and writes only their names and hosts to
// meta.deliveryWebhooks so the App can say where an alert went. Nothing a sweep writes to KV carries the URL.

import { describe, expect, it } from 'vitest';
import { DEMO_WEBHOOK_ID, descriptorEndpoints, webhookDescriptor, webhooksFromEnv } from '../../core/env-webhooks.ts';
import { deliver, redactUrls } from '../../core/adapters/webhook.ts';
import { storedWebhookCount, webhooksLine } from '../../scripts/runner.ts';
import { breakTrim } from '../../core/demo/levers.ts';
import { SINK_ENDPOINT, createWorld } from '../integration/harness.ts';

const SLACK = 'https://hooks.slack.com/services/T0ENV/B0ENV/envsecretenvsecret';
const RELAY = 'https://relay.example.com/hooks/meter-reader';
const DEMO = 'https://webhook.site/meter-reader-env-demo';

describe('webhooksFromEnv (the runner .env)', () => {
  it('reads MR_WEBHOOKS entries with an optional format prefix, and MR_DEMO_WEBHOOK_URL under its old id', () => {
    const r = webhooksFromEnv({ MR_WEBHOOKS: ` ${SLACK}, generic:${RELAY} ,servicenow:${RELAY}/sn`, MR_DEMO_WEBHOOK_URL: DEMO });
    expect(r.skipped).toEqual([]);
    expect(r.endpoints.map((e) => [e.id, e.name, e.host, e.format, e.channel])).toEqual([
      ['env-webhook-1', 'Direct webhook (hooks.slack.com)', 'hooks.slack.com', 'slack', 'webhook'],
      ['env-webhook-2', 'Direct webhook (relay.example.com)', 'relay.example.com', 'generic', 'webhook'],
      ['env-webhook-3', 'Direct webhook (relay.example.com)', 'relay.example.com', 'servicenow', 'webhook'],
      [DEMO_WEBHOOK_ID, 'Demo receiver (webhook.site)', 'webhook.site', 'slack', 'webhook'],
    ]);
    expect(r.endpoints[0]).toMatchObject({ url: SLACK, minSeverity: 'medium', weeklyReceipt: true, enabled: true });
  });

  it('skips what is not an https URL without credentials, by position, never echoing the value', () => {
    const r = webhooksFromEnv({ MR_WEBHOOKS: 'http://plain.example.com/x,https://user:pw@relay.example.com/y', MR_DEMO_WEBHOOK_URL: 'nope' });
    expect(r.endpoints).toEqual([]);
    expect(r.skipped).toEqual([
      'MR_WEBHOOKS entry 1: not an https URL without credentials',
      'MR_WEBHOOKS entry 2: not an https URL without credentials',
      'MR_DEMO_WEBHOOK_URL: not an https URL without credentials',
    ]);
    expect(JSON.stringify(r.skipped)).not.toContain('pw@');
  });

  it('nothing set: no endpoints; the start-up line says where alerts go instead', () => {
    const r = webhooksFromEnv({});
    expect(r).toEqual({ endpoints: [], skipped: [] });
    expect(webhooksLine(r)).toBe('direct webhooks: none in .env (alerts go to the Cribl bell and targets)');
  });

  it('the start-up line names each webhook by name and host, never its URL', () => {
    const line = webhooksLine(webhooksFromEnv({ MR_WEBHOOKS: SLACK, MR_DEMO_WEBHOOK_URL: DEMO }));
    expect(line).toBe('direct webhooks from .env: 2 (Direct webhook (hooks.slack.com) (hooks.slack.com), Demo receiver (webhook.site) (webhook.site))');
    expect(line).not.toContain('envsecret');
    expect(line).not.toContain('meter-reader-env-demo');
  });
});

describe('descriptors: what the App may know of a runner webhook', () => {
  it('carries id, name, host and format only; the UI rebuilds URL-less endpoints from them', () => {
    const [e] = webhooksFromEnv({ MR_WEBHOOKS: SLACK }).endpoints;
    const d = webhookDescriptor(e);
    expect(d).toEqual({ id: 'env-webhook-1', name: 'Direct webhook (hooks.slack.com)', host: 'hooks.slack.com', format: 'slack' });
    expect(JSON.stringify(d)).not.toContain('services');
    expect(descriptorEndpoints([d, { id: 3 }, null, 'x'])).toEqual([
      { id: 'env-webhook-1', name: 'Direct webhook (hooks.slack.com)', url: '', host: 'hooks.slack.com', format: 'slack', minSeverity: 'medium', weeklyReceipt: true, enabled: true, channel: 'webhook' },
    ]);
    expect(descriptorEndpoints(undefined)).toEqual([]);
  });
});

describe('storedWebhookCount (the runner purges what an older build stored)', () => {
  it('counts direct webhooks and any endpoint carrying a URL', () => {
    const base = { name: 'x', host: '', format: 'generic' as const, minSeverity: 'medium' as const, weeklyReceipt: true, enabled: true };
    expect(
      storedWebhookCount({
        notifications: [
          { ...base, id: 'a', url: SLACK },
          { ...base, id: 'b', url: '', channel: 'cribl-target', criblTargetId: 't' },
          { ...base, id: 'c', url: RELAY, channel: 'cribl-target', criblTargetId: 't' },
          { ...base, id: 'd', url: '', channel: 'cribl-bell' },
        ],
      }),
    ).toBe(2);
    expect(storedWebhookCount({ notifications: [] })).toBe(0);
  });
});

describe('a delivery log never quotes a webhook URL', () => {
  it('redacts any URL in a transport error to its host', async () => {
    expect(redactUrls(`request to ${SLACK} failed, reason: ECONNRESET`)).toBe('request to hooks.slack.com failed, reason: ECONNRESET');
    const logs = await deliver({
      sender: {
        post: async (url) => {
          throw new Error(`fetch failed for ${url}`);
        },
      },
      url: SLACK,
      body: {},
      clock: { now: () => 0 },
      endpointId: 'env-webhook-1',
      event: 'test',
      backoffMs: [],
    });
    expect(logs[0]).toMatchObject({ status: 0, detail: 'fetch failed for hooks.slack.com' });
    expect(JSON.stringify(logs)).not.toContain('envsecret');
  });
});

describe('the sweep: env webhooks delivered, their URLs never written to KV', () => {
  it("delivers an opened regression to the runner's webhook and records only its name and host in meta", async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(2);
    await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' });
    const results = await w.sweepMinutes(4);
    const opened = results.find((r) => r.opened > 0);
    expect(opened?.notified).toBeGreaterThan(0);
    expect(w.em.sink().some((d) => d.host === 'webhook.site')).toBe(true);
    const meta = await w.meta();
    expect(meta?.deliveryWebhooks).toEqual([{ id: SINK_ENDPOINT.id, name: SINK_ENDPOINT.name, host: SINK_ENDPOINT.host, format: SINK_ENDPOINT.format }]);
    // No KV value anywhere holds the URL: settings, meta, incidents, the notify log, the snapshot.
    const all = JSON.stringify(w.em.kvDump());
    expect(all.length).toBeGreaterThan(1000);
    expect(all).not.toContain(SINK_ENDPOINT.url);
  });

  it('a sweep with no env webhooks (a tab) carries the runner’s list forward', async () => {
    const w = await createWorld();
    await w.sweep();
    const tab = await w.sweep('ui', { envWebhooks: undefined, owner: 'tab-b' });
    expect(tab.error).toBeUndefined();
    await w.sweepMinutes(1, { envWebhooks: undefined });
    expect((await w.meta())?.deliveryWebhooks?.map((d) => d.id)).toEqual([SINK_ENDPOINT.id]);
  });
});
