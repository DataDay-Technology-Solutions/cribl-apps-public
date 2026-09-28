// Every generated output treats a member-written label as text: the report card's CSV, HTML, email and PDF, the
// Slack weekly receipt; the direct-webhook sender posts only to the configured https URL on a public host; and the
// sweep lock never binds for longer than any owner writes it. Labels come from settings.humanize, which any member
// the App is shared with can save.

import { describe, expect, it, vi } from 'vitest';
import { buildReportCard } from '../../core/report.ts';
import { csvField, renderReportCsv, textCell } from '../../core/report-csv.ts';
import { renderReportHtml } from '../../core/report-html.ts';
import { renderReportEmail } from '../../core/report-email.ts';
import { renderReportPdf } from '../../core/report-pdf.ts';
import { slackPayload } from '../../core/payloads.ts';
import { createFetchWebhookSender, deliver, isPublicWebhookHost } from '../../core/adapters/webhook.ts';
import { MAX_LOCK_HOLD_MS, createKvDocs, createMemoryKvStore, lockBinds } from '../../core/kv.ts';
import { webCodec } from '../../core/codec.ts';
import type { CanonicalPayload, WebhookSender } from '../../core/types.ts';
import { webhookHosts } from '../../scripts/runner.ts';
import { liveInput } from './report-fixture.ts';

/** RFC 4180 with a chosen separator, as a spreadsheet in that locale reads the file. */
function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell]);
  return rows;
}

function cardWithLabel(label: string) {
  const input = liveInput({ kind: 'mtd' });
  const humanize: Record<string, string> = {};
  for (const d of input.snapshot?.destinations ?? []) humanize[d.outputId] = label;
  for (const f of input.snapshot?.flows ?? []) humanize[f.pipelineId] = label;
  return buildReportCard({ ...input, settings: { ...input.settings, humanize } });
}

const FORMULA_START = /^[=+\-@\t\r]/;

describe('report card CSV', () => {
  it('quotes a field holding a semicolon or a tab, as it does a comma', () => {
    expect(csvField('SIEM prod;=1+1;')).toBe('"SIEM prod;=1+1;"');
    expect(csvField('a\tb')).toBe('"a\tb"');
    expect(csvField('plain')).toBe('plain');
    expect(csvField(12.5)).toBe('12.5');
    expect(textCell('SIEM prod;=1+1;')).toBe(`"SIEM prod;'=1+1;"`);
    expect(textCell('=1+1')).toBe("'=1+1");
    expect(textCell('Windows event trimming')).toBe('Windows event trimming');
  });

  it('never yields a cell that starts like a formula, whatever the reader splits on', () => {
    for (const label of ['SIEM prod;=1+1;', 'x;@SUM(1+1)', '=HYPERLINK("https://example.com/x","open")', '+1', '-1+2', '@cmd', '\tx', 'a\t=1+1', 'a,=1']) {
      const csv = renderReportCsv(cardWithLabel(label)).replace(/^﻿/, '');
      for (const sep of [',', ';', '\t']) {
        const cells = parseCsv(csv, sep).flat();
        const offenders = cells.filter((c) => FORMULA_START.test(c) && !/^-?\d/.test(c));
        expect(offenders, `${JSON.stringify(label)} split on ${JSON.stringify(sep)}`).toEqual([]);
      }
    }
  });
});

describe('report card HTML, email and PDF', () => {
  const HOSTILE = '<img src=x onerror=alert(1)>) Tj ET BT /F1 99 Tf (x';

  it('escapes a label in the HTML file and the email', () => {
    const card = cardWithLabel(HOSTILE);
    const html = renderReportHtml(card);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const email = renderReportEmail(card);
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('writes a label into the PDF as one escaped string', () => {
    const pdf = Buffer.from(renderReportPdf(cardWithLabel(HOSTILE))).toString('latin1');
    expect(pdf).not.toMatch(/[^\\]\) Tj ET BT \/F1 99 Tf/);
    expect(pdf).toContain('\\) Tj ET BT /F1 99 Tf \\(x');
  });
});

describe('Slack weekly receipt', () => {
  const canonical = (label: string, title: string): CanonicalPayload =>
    ({
      schemaVersion: 1,
      app: 'meter-reader',
      event: 'receipt.weekly',
      sentAt: '2026-09-28T12:00:00.000Z',
      workspace: 'main',
      receipt: {
        periodStart: '2026-09-21T00:00:00.000Z',
        periodEnd: '2026-09-28T00:00:00.000Z',
        label: 'Sep 21–27, 2026',
        lines: [{ label, savedM: 2_500_000 }],
        savedM: 2_500_000,
        whpM: 5_000_000,
        paidM: 2_500_000,
        ratio: 0.5,
        openIncidents: [{ title }],
      },
    }) as unknown as CanonicalPayload;

  it('keeps every label inside its code block, with no mention or link Slack would act on', () => {
    const msg = slackPayload(canonical('```<!channel>', 'Savings dropped: ```<https://example.com/x|Sign in again>```'));
    const section = msg.blocks.find((b) => b.type === 'section') as { text: { text: string } };
    const text = section.text.text;
    expect(text.startsWith('```\n')).toBe(true);
    expect(text.endsWith('\n```')).toBe(true);
    const inner = text.slice(4, -4);
    expect(inner).not.toContain('`');
    expect(inner).not.toMatch(/<[!@#]|<https?:/);
    expect(inner).toContain('&lt;!channel&gt;');
  });
});

describe('direct webhooks', () => {
  it('names only public hosts', () => {
    for (const h of ['hooks.slack.com', 'webhook.site', 'example.com', '8.8.8.8', '[2606:4700::1111]']) expect(isPublicWebhookHost(h), h).toBe(true);
    for (const h of [
      'localhost',
      'app.localhost',
      'printer.local',
      'ops-box',
      'svc.internal',
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.20',
      '169.254.169.254',
      '100.64.0.10', // carrier-grade NAT, where tailnet addresses live
      '0.0.0.0',
      '[::1]',
      '[fd00::1]',
      '[fe80::1]',
      '[::ffff:7f00:1]',
      '',
    ])
      expect(isPublicWebhookHost(h), h).toBe(false);
    // The WHATWG parser's forms of a loopback address.
    for (const url of ['https://0x7f.0.0.1/x', 'https://2130706433/x', 'https://[::ffff:127.0.0.1]/x']) expect(isPublicWebhookHost(new URL(url).hostname), url).toBe(false);
  });

  const clock = { now: () => Date.parse('2026-09-27T03:00:00Z') };
  const base = { clock, endpointId: 'e1', event: 'test' as const, backoffMs: [] as number[] };

  it('refuses a private host before any attempt', async () => {
    const post = vi.fn(async () => ({ status: 200 }));
    const logs = await deliver({ ...base, sender: { post }, url: 'https://127.0.0.1:5291/hook', body: { a: 1 } });
    expect(post).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 0, error: 'host_not_authorized' });
  });

  it('never follows a redirect, and keeps to its own host list when it has one', async () => {
    const calls: { url: string; init: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init });
      return { status: 200, ok: true, text: async () => '' };
    }) as never;
    const open: WebhookSender = createFetchWebhookSender(fetchFn);
    expect(open.allows).toBeUndefined();
    await deliver({ ...base, sender: open, url: 'https://hooks.slack.com/services/x', body: {} });
    expect(calls[0].init.redirect).toBe('error');

    const narrow = createFetchWebhookSender(fetchFn, { allowHosts: webhookHosts(' Hooks.Slack.com , ') });
    expect(narrow.allows?.('https://hooks.slack.com/services/x')).toBe(true);
    const refused = await deliver({ ...base, sender: narrow, url: 'https://webhook.site/abc', body: {} });
    expect(refused[0]).toMatchObject({ status: 0, error: 'host_not_authorized' });
    expect(calls).toHaveLength(1);
    expect(webhookHosts(undefined)).toBeUndefined();
    expect(webhookHosts(' , ')).toBeUndefined();
  });
});

describe('sweep lock', () => {
  it('binds only while unexpired and no further ahead than any owner writes it', () => {
    const now = Date.parse('2026-09-27T03:00:00Z');
    expect(lockBinds({ owner: 'tab:a', expiresAt: new Date(now + 130_000).toISOString() }, now)).toBe(true);
    expect(lockBinds({ owner: 'tab:a', expiresAt: new Date(now - 1).toISOString() }, now)).toBe(false);
    expect(lockBinds({ owner: 'tab:a', expiresAt: new Date(now + MAX_LOCK_HOLD_MS + 1).toISOString() }, now)).toBe(false);
  });

  it('is taken over when it claims a far-future expiry, and still refuses a live holder', async () => {
    const kv = createMemoryKvStore();
    const clock = { now: () => Date.parse('2026-09-27T03:00:00Z') };
    const docs = createKvDocs({ kv, codec: webCodec, clock });
    await kv.put('lock/meter', JSON.stringify({ owner: 'tab:other', expiresAt: '9999-12-31T23:59:59.000Z' }));
    expect(await docs.acquireLock('runner:host:1', 130_000)).toBe(true);
    expect(await docs.acquireLock('tab:alice', 130_000)).toBe(false); // the runner holds it now, for 130 s
  });
});
