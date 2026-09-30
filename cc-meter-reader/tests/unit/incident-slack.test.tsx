// @vitest-environment jsdom
// Slack message preview (DESIGN_BRIEF 5.8, PRD 8.8 item 10): a faithful Block Kit renderer, rendered from
// the payloads the app really sends (core/payloads.ts) and from arbitrary Block Kit JSON.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalPayload, slackPayload, testPayload } from '../../core/payloads.ts';
import type { WeeklyReceipt } from '../../core/types.ts';
import { SlackPreview } from '../../src/components/SlackPreview/SlackPreview.tsx';
import { decodeEntities, renderInline, renderMrkdwn } from '../../src/components/SlackPreview/mrkdwn.tsx';
import { toSlackMessage } from '../../src/components/SlackPreview/message.ts';

afterEach(cleanup);

const MC = 100_000;
const RECEIPT: WeeklyReceipt = {
  periodStart: '2026-09-21T05:00:00.000Z',
  periodEnd: '2026-09-28T05:00:00.000Z',
  label: 'Sep 21–27, 2026',
  lines: [
    { label: 'Windows event trimming', savedM: 9_380 * MC },
    { label: 'Firewall duplicate suppression', savedM: 6_384 * MC },
    { label: 'CDN log aggregation', savedM: 847 * MC },
  ],
  savedM: 23_807 * MC,
  whpM: 39_678 * MC,
  paidM: 15_871 * MC,
  ratio: 0.6,
  trendPct: 4,
  openIncidents: [{ title: 'Savings dropped: Payments API sampling' }],
};

function renderToHost(nodes: ReturnType<typeof renderMrkdwn>) {
  return render(<div>{nodes}</div>).container.firstElementChild as HTMLElement;
}

describe('mrkdwn', () => {
  it('formats bold, italic, strike and code — only at word boundaries', () => {
    const host = renderToHost(renderInline('*Lost per day* and _soon_ ~gone~ `a1f3c9e` mrd_pay_sample 2*3*4'));
    expect(host.querySelector('strong')?.textContent).toBe('Lost per day');
    expect(host.querySelector('em')?.textContent).toBe('soon');
    expect(host.querySelector('s')?.textContent).toBe('gone');
    expect(host.querySelector('code')?.textContent).toBe('a1f3c9e');
    expect(host.textContent).toContain('mrd_pay_sample');
    expect(host.textContent).toContain('2*3*4');
  });

  it('nests formatting and keeps its place across recursion', () => {
    const host = renderToHost(renderInline('*bold _inner_ text* then _after_'));
    expect(host.querySelector('strong em')?.textContent).toBe('inner');
    expect(host.querySelectorAll('em')).toHaveLength(2);
    expect(host.textContent).toBe('bold inner text then after');
  });

  it('decodes entities, draws links as text, keeps unknown shortcodes and draws known glyphs', () => {
    expect(decodeEntities('a &lt;b&gt; &amp; c')).toBe('a <b> & c');
    const host = renderToHost(renderInline(':red_circle: <https://x.io/y|Open it> <https://x.io/z> :unknown_thing: &lt;tag&gt;'));
    expect(host.querySelector('.mr-slack-glyph--red')?.getAttribute('aria-label')).toBe('Red circle');
    expect(host.querySelectorAll('.mr-slack-link')[0].textContent).toBe('Open it');
    expect(host.querySelectorAll('.mr-slack-link')[1].textContent).toBe('https://x.io/z');
    expect(host.textContent).toContain(':unknown_thing:');
    expect(host.textContent).toContain('<tag>');
    expect(host.querySelector('a')).toBeNull(); // a preview never navigates
  });

  it('plain_text only renders emoji', () => {
    const host = renderToHost(renderInline(':receipt: *not bold*', true));
    expect(host.querySelector('svg[aria-label="Receipt"]')).not.toBeNull();
    expect(host.querySelector('strong')).toBeNull();
    expect(host.textContent).toContain('*not bold*');
  });

  it('keeps code blocks verbatim, one line per span, and tags the receipt total', () => {
    const host = renderToHost(renderMrkdwn('before\n```\nA ....  $1\nSaved by Cribl, last week   $9\n```\nafter'));
    const pre = host.querySelector('pre')!;
    expect(pre.textContent).toBe('A ....  $1\nSaved by Cribl, last week   $9');
    expect(pre.querySelector('[data-callout="receipt-total"]')?.textContent).toContain('Saved by Cribl');
    expect(host.querySelectorAll('br')).toHaveLength(2);
    // An unmatched fence is literal.
    expect(renderToHost(renderMrkdwn('a ``` b')).textContent).toBe('a ``` b');
  });
});

describe('toSlackMessage', () => {
  it('accepts a message body or a blocks array and rejects anything else', () => {
    expect(toSlackMessage({ text: 'hi' })).toEqual({
      text: 'hi',
      blocks: undefined,
    });
    expect(toSlackMessage([{ type: 'divider' }, 3, null])).toEqual({
      blocks: [{ type: 'divider' }],
    });
    expect(toSlackMessage({ blocks: [{ type: 'header' }, 'x'] })?.blocks).toHaveLength(1);
    expect(toSlackMessage(null)).toBeNull();
    expect(toSlackMessage('text')).toBeNull();
    expect(toSlackMessage({ nope: 1 })).toBeNull();
  });
});

describe('<SlackPreview>', () => {
  it('draws the incident message the app sends: glyph header, two-column fields, context, one button', () => {
    const message = slackPayload(testPayload('main', '2026-09-30T16:44:03.000Z', 'https://org.cribl.cloud/apps/a/meter-reader'), {
      tz: 'UTC',
    });
    const { container } = render(<SlackPreview message={message} time="4:44 PM" />);
    const frame = container.querySelector('[data-callout="slack-message"]')!;
    expect(frame.getAttribute('aria-label')).toBe('Slack message preview');
    expect(screen.getByText('Meter Reader')).toBeTruthy();
    expect(screen.getByText('App')).toBeTruthy();
    expect(screen.getByText('4:44 PM')).toBeTruthy();
    expect(container.querySelector('.mr-slack-header')?.textContent).toBe('Test: Savings dropped: Example pipeline');
    expect(container.querySelector('.mr-slack-header .mr-slack-glyph--red')).not.toBeNull();
    const fields = [...container.querySelectorAll('.mr-slack-field')].map((f) => f.textContent);
    expect(fields).toEqual([
      'Lost per day$25',
      'Per year if left$9,125',
      'Commita1f3c9e Example: a pipeline change',
      'Bymeter-reader',
      'Before75%',
      'After50%',
    ]);
    expect(container.querySelector('.mr-slack-context')?.textContent).toBe('Meter Reader by Steve Koelpin · Example destination · 4:44 PM UTC · caught in 2:51');
    expect(container.querySelector('.mr-slack-button')?.textContent).toBe('Open in Ledger');
  });

  it('draws the weekly receipt as a monospace block with aligned dot leaders', () => {
    const message = slackPayload(
      canonicalPayload('receipt.weekly', {
        receipt: RECEIPT,
        workspace: 'main',
        linkBase: '',
      }),
    );
    const { container } = render(<SlackPreview message={message} callout="slack-receipt" />);
    expect(container.querySelector('[data-callout="slack-receipt"]')).not.toBeNull();
    expect(container.querySelector('.mr-slack-header svg[aria-label="Receipt"]')).not.toBeNull();
    const lines = [...container.querySelectorAll('.mr-slack-pre-line')].map((l) => (l.textContent ?? '').replace(/\n$/, ''));
    const itemLines = lines.filter((l) => / \.{2,}/.test(l));
    expect(itemLines).toHaveLength(3);
    for (const l of itemLines) expect(l).toHaveLength(48); // SPEC 12.4: every amount ends in column 48
    expect(container.querySelector('[data-callout="receipt-total"]')?.textContent).toMatch(/^Saved by Cribl, last week +\$23,807/);
  });

  it('draws a text-only message and says when there is nothing to show', () => {
    const { container } = render(<SlackPreview message={{ text: 'hello *world*' }} />);
    expect(container.querySelector('.mr-slack-section-text strong')?.textContent).toBe('world');
    cleanup();
    render(<SlackPreview message={{ foo: 1 }} />);
    expect(screen.getByText('Nothing to preview')).toBeTruthy();
    cleanup();
    const { container: c2 } = render(
      <SlackPreview
        message={{
          blocks: [
            { type: 'divider' },
            { type: 'image', image_url: 'x' },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  style: 'primary',
                  text: { type: 'plain_text', text: 'Go' },
                },
              ],
            },
          ],
        }}
      />,
    );
    expect(c2.querySelector('hr.mr-slack-divider')).not.toBeNull();
    expect(c2.querySelector('.mr-slack-button--primary')?.textContent).toBe('Go');
  });
});
