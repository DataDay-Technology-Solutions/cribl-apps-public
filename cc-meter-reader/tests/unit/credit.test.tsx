// @vitest-environment jsdom
// tests/unit/credit.test.tsx — Meter Reader is signed by its builder, Steve Koelpin, wherever a builder signs his work,
// and every surface signs with ONE name (core/strings.ts CREDIT_STRINGS.builder):
//
//   • the App: the shell footer, the first-run card, Settings → Runtime's About line, the presenter's wordmark, Story
//     mode's title and summary (src/copy/en.ts `credit.*`, filled by src/components/common/Credit.tsx), and the ask's
//     caption, which holds the name together with a no-break space;
//   • the report card: every PDF page, the HTML file's footer and the email (HTML and plain text);
//   • every receipt and alert message: Copy receipt and the weekly receipt end with a centred sign-off; Slack's
//     context line, the bell's line, the ServiceNow description and a Cribl target's text end with the signature;
//   • the package: package.json and the LICENSE name him.
//
// The release bundle's copy of the footer and report card words is held by tests/compliance.test.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CREDIT_STRINGS } from '../../core/strings.ts';
import { canonicalPayload, servicenowPayload, slackPayload } from '../../core/payloads.ts';
import { renderAlert } from '../../core/delivery.ts';
import { RECEIPT_WIDTH, receiptSignOff, receiptText } from '../../core/receipt.ts';
import { buildReportCard } from '../../core/report.ts';
import { renderReportHtml } from '../../core/report-html.ts';
import { renderReportEmail } from '../../core/report-email.ts';
import { renderReportPdf } from '../../core/report-pdf.ts';
import type { Incident, WeeklyReceipt } from '../../core/types.ts';
import { defaultSettings } from '../../core/settings.ts';
import { Credit } from '../../src/components/common/Credit.tsx';
import { Footer } from '../../src/components/Shell/Footer.tsx';
import { statementText } from '../../src/components/DestinationStatement/text.ts';
import { en, t, tLines } from '../../src/copy/en.ts';
import { StoreProvider } from '../../src/state/providers.tsx';
import { createAppStore } from '../../src/state/store.ts';
import { liveInput, sampleCard } from './report-fixture.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const NAME = 'Steve Koelpin';
const SIGNATURE = 'Meter Reader by Steve Koelpin';

afterEach(cleanup);

describe('one name, everywhere', () => {
  it('core holds the builder and the signature', () => {
    expect(CREDIT_STRINGS.builder).toBe(NAME);
    expect(CREDIT_STRINGS.signature).toBe(SIGNATURE);
  });

  it("every credit string in en.ts takes core's name through {name}; the ask caption spells it out, unbroken", () => {
    const { aboutLabel, ...signed } = en.credit;
    expect(aboutLabel).toBe('About');
    for (const [key, text] of Object.entries(signed)) {
      expect(text, `credit.${key}`).toContain('{name}');
      expect(text, `credit.${key} must not spell the name out`).not.toContain('Koelpin');
    }
    expect(en.report.doc.credit).toBe('Made with Meter Reader, built by {name}');
    // D54: the release's ask (this test runs without the demo flag) joins the network; the vote ask is demo-only.
    expect(tLines('story.captions.ask')).toEqual([`Meter Reader by ${NAME.replace(' ', '\u00a0')}.`, 'Join the Cribl Innovators Network.']);
  });

  it('package.json and the LICENSE name him', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { author?: string };
    expect(pkg.author).toBe(NAME);
    expect(readFileSync(join(ROOT, 'LICENSE'), 'utf8')).toMatch(/^ {3}Copyright 2026 Steve Koelpin$/m);
  });
});

describe('<Credit>: the words from the copy key, the name set apart', () => {
  it('fills {name} with the builder and keeps the words around it', () => {
    render(<Credit copyKey="credit.footer" testId="c" />);
    const el = screen.getByTestId('c');
    expect(el.textContent).toBe(`Meter Reader · built by ${NAME}`);
    expect(el.querySelector('.mr-credit-name')?.textContent).toBe(NAME);
  });

  it('fills the other placeholders the key carries', () => {
    render(<Credit copyKey="credit.about" vars={{ version: 'v9.9.9' }} testId="c" />);
    expect(screen.getByTestId('c').textContent).toBe(`Meter Reader v9.9.9 · built by ${NAME} · Apache 2.0 license`);
  });

  it('every credit key renders the name exactly once', () => {
    for (const key of ['credit.footer', 'credit.firstRun', 'credit.byline', 'credit.storyTitle', 'credit.signature'] as const) {
      cleanup();
      render(<Credit copyKey={key} testId="c" />);
      const text = screen.getByTestId('c').textContent ?? '';
      expect(text.split(NAME).length - 1, key).toBe(1);
      expect(text, key).toBe(t(key, { name: NAME }));
    }
  });

  it('the shell footer is signed beside the version', () => {
    const store = createAppStore(defaultSettings('2026-09-26T00:00:00.000Z', 'UTC'), { hasHydrated: true });
    render(
      <StoreProvider store={store}>
        <Footer />
      </StoreProvider>,
    );
    expect(screen.getByTestId('footer-credit').textContent).toBe(`Meter Reader · built by ${NAME}`);
    // The version line keeps its own words (tests/e2e/shell.spec.ts holds its shape).
    expect(screen.getByTestId('footer-build').textContent).not.toContain(NAME);
  });
});

describe('the report card is signed on every page and in every format', () => {
  const card = sampleCard();

  it('carries the line and the name', () => {
    expect(card.credit).toBe(`Made with Meter Reader, built by ${NAME}`);
    expect(card.builder).toBe(NAME);
    expect(buildReportCard(liveInput()).credit).toBe(card.credit);
  });

  it('the HTML file and the email set the name in bold; the plain text ends with the line', () => {
    expect(renderReportHtml(card)).toContain(`<span class="credit">Made with Meter Reader, built by <strong>${NAME}</strong></span>`);
    const email = renderReportEmail(card);
    expect(email.html).toContain(`Made with Meter Reader, built by <b style="color:#1c2024;">${NAME}</b>`);
    expect(email.text.split('\n').at(-1)).toBe(card.credit);
  });

  it('the PDF draws the line on every page', () => {
    const pdf = new TextDecoder('latin1').decode(renderReportPdf(card));
    const pages = (pdf.match(/\/Type\s*\/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(2);
    // The words and the bold name are separate runs: each appears once per page.
    expect(pdf.split('(Made with Meter Reader, built by )').length - 1).toBe(pages);
    expect(pdf.split(`(${NAME})`).length - 1).toBeGreaterThanOrEqual(pages);
  });
});

describe('every receipt and alert message ends with the signature', () => {
  const receipt: WeeklyReceipt = {
    periodStart: '2026-09-21T00:00:00.000Z',
    periodEnd: '2026-09-28T00:00:00.000Z',
    label: 'Sep 21–27, 2026',
    lines: [{ label: 'Windows event trimming', savedM: 938_000_000 }],
    savedM: 938_000_000,
    whpM: 1_500_000_000,
    paidM: 562_000_000,
    ratio: 0.625,
    openIncidents: [],
  };

  it('a receipt closes on a blank line and the signature, centred on its width', () => {
    const [blank, sig] = receiptSignOff();
    expect(blank).toBe('');
    expect(sig.trim()).toBe(SIGNATURE);
    const pad = sig.length - SIGNATURE.length;
    expect(Math.abs(pad - (RECEIPT_WIDTH - sig.length))).toBeLessThanOrEqual(1);
    expect(receiptText(receipt).split('\n').slice(-2)).toEqual(receiptSignOff());
    const statement = statementText({ title: 'Meter Reader — statement', destination: 'SIEM', months: ['Sep', 'Aug'], rows: [['Paid', 1, 2]], notes: [] });
    expect(statement.split('\n').slice(-2)).toEqual(receiptSignOff());
  });

  const incident: Incident = {
    id: 'inc_1',
    type: 'regression',
    severity: 'high',
    objectKey: 'pipe:default:mrd_pay_sample',
    label: 'Payments API sampling',
    outputId: 'mrd_siem_prod',
    openedAt: '2026-09-30T16:42:03.000Z',
    cause: 'commit',
    commit: { hash: '22d0a5e0123', message: 'Keep full payload on payments API errors', author: NAME, committedAt: '2026-09-30T16:39:00.000Z', groupId: 'default', match: 'files' },
    before: 0.75,
    after: 0.5,
    impactPerDayM: 125_000_000,
    caughtInSec: 171,
    notes: [],
    deliveries: [],
  };
  const opened = canonicalPayload('incident.opened', { incident, workspace: 'w', linkBase: 'https://x/' });

  it("Slack's context line opens with it", () => {
    const slack = slackPayload(opened);
    const context = slack.blocks.find((b) => b.type === 'context');
    expect(context && 'elements' in context ? context.elements[0].text : '').toMatch(new RegExp(`^${SIGNATURE} · `));
  });

  it('the bell line, the ServiceNow description and the target text end with it', () => {
    const r = renderAlert(opened);
    expect(r.line.endsWith(` · ${SIGNATURE}`)).toBe(true);
    expect(r.text.split('\n').at(-1)).toBe(SIGNATURE);
    expect(servicenowPayload(opened).description.split('\n').at(-1)).toBe(SIGNATURE);
    const weekly = renderAlert(canonicalPayload('receipt.weekly', { receipt, workspace: 'w', linkBase: '' }));
    expect(weekly.line.endsWith(` · ${SIGNATURE}`)).toBe(true);
    expect(weekly.text.split('\n').at(-1)?.trim()).toBe(SIGNATURE);
  });
});
