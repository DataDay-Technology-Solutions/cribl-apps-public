// tests/unit/r1-core-author.test.ts — founder-build r1 core-4 (FOUNDER_PLAN row 10, F3; contract C5): one author
// function. A commit made with an API credential carries its OAuth client id as the author ("<id>@clients"). Rules
// round 4 masked it on the cards, the timeline and Changes (src/lib/author.ts, with the member's own name for that
// client from Settings → Alerts), but the bell, a notification target, Slack, ServiceNow and the Report used
// core/humanize.ts displayAuthor, which had no label lookup. displayAuthor is now the one function (it takes the
// labels); src/lib/author.ts delegates to it with its API unchanged. This changes delivered text: a labelled client
// prints its label in the bell and Slack.

import { describe, expect, it } from 'vitest';
import type { CanonicalPayload, Incident } from '../../core/types.ts';
import { API_CLIENT_LABEL_PREFIX as CORE_PREFIX, apiClientKey as coreKey, displayAuthor, isApiClientAuthor as coreIsClient } from '../../core/humanize.ts';
import { canonicalPayload, incidentPlainText, servicenowPayload, slackPayload } from '../../core/payloads.ts';
import { renderAlert } from '../../core/delivery.ts';
import { buildReportCard } from '../../core/report.ts';
import { renderReportHtml } from '../../core/report-html.ts';
import { renderReportEmail } from '../../core/report-email.ts';
import { renderReportCsv } from '../../core/report-csv.ts';
import { API_CLIENT_LABEL_PREFIX, apiClientFallback, apiClientKey, commitAuthor, isApiClientAuthor } from '../../src/lib/author.ts';
import { t } from '../../src/copy/en.ts';
import { liveInput } from './report-fixture.ts';

const CLIENT = 'k3xq9Zt0aBcDeF7w1r2s@clients';
const LABELS = { 'client:1r2s': 'GitOps pipeline' };

const incident = (author: string): Incident => ({
  id: 'inc_author',
  type: 'regression',
  severity: 'high',
  objectKey: 'pipe:default:mrd_pay_sample',
  label: 'Payments API sampling',
  outputId: 'mrd_siem_prod',
  openedAt: '2026-09-28T15:02:25.000Z',
  cause: 'commit',
  commit: { hash: 'a1f3c9e0b2', message: 'break the trim', author, committedAt: '2026-09-28T15:00:00.000Z', deployedAt: '2026-09-28T15:00:10.000Z', groupId: 'default', match: 'files' },
  before: 0.75,
  after: 0.5,
  impactPerDayM: 2_500_000,
  caughtInSec: 135,
  notes: [],
  deliveries: [],
});

/** Every rendered string a person reads outside the App for one alert: bell title/line, target text, Slack, ServiceNow, the JSON a webhook or target receives. */
function channels(c: CanonicalPayload): Record<string, string> {
  const bell = renderAlert(c);
  const slack = slackPayload(c, { labels: LABELS });
  return {
    bellTitle: bell.title,
    bellLine: bell.line,
    target: bell.text,
    plain: incidentPlainText(c.incident!),
    slack: JSON.stringify(slack),
    servicenow: JSON.stringify(servicenowPayload(c)),
    canonical: JSON.stringify(c),
  };
}

describe('core-4 · one author function (C5, row 10 F3)', () => {
  it('an unlabelled API client reads "API client ··1r2s" on the bell, the target, Slack, ServiceNow and the JSON', () => {
    const c = canonicalPayload('incident.opened', { incident: incident(CLIENT), workspace: 'w', linkBase: 'https://org.cribl.cloud/apps/a/meter-reader', labels: {} });
    const s = channels(c);
    for (const [k, v] of Object.entries(s)) {
      expect(v, k).not.toContain('@clients');
      expect(v, k).not.toContain('k3xq9Zt0');
    }
    expect(s.bellLine).toContain('commit a1f3c9e by API client ··1r2s');
    expect(s.target).toContain('by API client ··1r2s');
    expect(s.slack).toContain('*By*\\nAPI client ··1r2s');
    expect(c.incident!.commit!.author).toBe('API client ··1r2s');
  });

  it("a labelled API client prints the member's own name for it on every channel", () => {
    const c = canonicalPayload('incident.opened', { incident: incident(CLIENT), workspace: 'w', linkBase: 'https://org.cribl.cloud/apps/a/meter-reader', labels: LABELS });
    const s = channels(c);
    for (const [k, v] of Object.entries(s)) {
      expect(v, k).not.toContain('@clients');
      expect(v, k).not.toContain('API client ··1r2s');
    }
    expect(s.bellLine).toContain('commit a1f3c9e by GitOps pipeline');
    expect(s.target).toContain('by GitOps pipeline');
    expect(s.plain).toContain('by GitOps pipeline');
    expect(s.slack).toContain('*By*\\nGitOps pipeline');
    expect(c.incident!.commit!.author).toBe('GitOps pipeline');
    // A canonical built elsewhere with the raw author still renders masked, never the id.
    const raw = { ...c, incident: { ...c.incident!, commit: { ...c.incident!.commit!, author: CLIENT } } };
    // (The canonical JSON, and ServiceNow's copy of it, carry what canonicalPayload wrote: that path is the one above.)
    for (const [k, v] of Object.entries(channels(raw))) if (k !== 'canonical' && k !== 'servicenow') expect(v, k).not.toContain('@clients');
  });

  it('a person reads as Cribl recorded them, labels or not', () => {
    const c = canonicalPayload('incident.opened', { incident: incident('Steve Koelpin'), workspace: 'w', linkBase: '', labels: LABELS });
    expect(renderAlert(c).line).toContain('by Steve Koelpin');
    expect(displayAuthor('s.koelpin', LABELS)).toBe('s.koelpin');
  });

  it('the Report card names the client by its label, or masked; never the id (HTML, email, CSV)', () => {
    // report-fixture's open regression was committed by 'Zx9QgE@clients' (label key client:9QgE).
    const plain = buildReportCard(liveInput({ kind: 'today' }));
    const labelled = liveInput({ kind: 'today' });
    labelled.settings = { ...labelled.settings, humanize: { ...labelled.settings.humanize, 'client:9QgE': 'CI job' } };
    const named = buildReportCard(labelled);
    const reg = (card: typeof plain) => card.protection.rows.find((r) => r.id === 'reg-open')!;
    expect(reg(plain).commit?.author).toBe('API client ··9QgE');
    expect(reg(named).commit?.author).toBe('CI job');
    for (const card of [plain, named]) {
      const out = [renderReportHtml(card), renderReportEmail(card).html, renderReportEmail(card).text, renderReportCsv(card)].join('\n');
      expect(out).not.toContain('@clients');
      expect(out).not.toContain('Zx9QgE');
    }
    expect(renderReportHtml(named)).toContain('CI job');
  });

  it('src/lib/author.ts delegates: the App and the channels print the same author for every input', () => {
    const authors = [CLIENT, 'Zx9QvK3mTt0pLr7bN2cW5yH8dJ4aF6gE@clients', ' abc@CLIENTS ', 's.koelpin', 'jane@example.com', 'two words@clients', '', '   ', undefined, null];
    for (const a of authors) {
      expect(commitAuthor(a), String(a)).toBe(displayAuthor(a));
      expect(commitAuthor(a, LABELS), String(a)).toBe(displayAuthor(a, LABELS));
    }
    expect(commitAuthor(CLIENT, LABELS)).toBe('GitOps pipeline');
    expect(commitAuthor(CLIENT, { 'client:1r2s': '   ' })).toBe('API client ··1r2s');
    // The label helpers are core's too, re-exported with the same names.
    expect(API_CLIENT_LABEL_PREFIX).toBe(CORE_PREFIX);
    expect(apiClientKey(CLIENT)).toBe(coreKey(CLIENT));
    expect(apiClientKey('Steve Koelpin')).toBeUndefined();
    expect(isApiClientAuthor(CLIENT)).toBe(coreIsClient(CLIENT));
    // en.ts still carries the words the App printed before (read-only here): core's are the same.
    expect(apiClientFallback('client:1r2s')).toBe(t('commits.apiClient', { tail: '1r2s' }));
    expect(displayAuthor(undefined)).toBe(t('commits.unknownAuthor'));
  });
});
