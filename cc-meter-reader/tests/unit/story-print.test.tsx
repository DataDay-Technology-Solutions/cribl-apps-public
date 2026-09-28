// @vitest-environment jsdom
// Story mode's Monday receipt prints a line at a time, its total last (P2-W12): SlackPreview's `revealLines` and
// the print order behind it (src/components/SlackPreview/mrkdwn.tsx). Omitted, the preview is exactly as before.

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SlackPreview } from '../../src/components/SlackPreview/SlackPreview.tsx';
import { printOrder } from '../../src/components/SlackPreview/mrkdwn.tsx';

afterEach(cleanup);

const RECEIPT = [
  'Meter Reader — weekly receipt    Sep 14–20, 2026',
  'VPC Flow aggregation ........   $27,798',
  'Palo Alto traffic ...........   $25,799',
  '---------------------------------------',
  'Saved by Cribl, last week      $177,198',
  'Would have paid $452,147 · Paid $274,949',
  '39% saved',
];
const MESSAGE = { blocks: [{ type: 'header', text: { type: 'plain_text', text: 'Weekly receipt' } }, { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`\n${RECEIPT.join('\n')}\n\`\`\`` } }] };

describe('the receipt prints a line at a time (P2-W12)', () => {
  it('orders the lines top to bottom with the total last', () => {
    expect(printOrder(RECEIPT)).toEqual([0, 1, 2, 3, 6, 4, 5]);
    expect(printOrder(['a', 'b'])).toEqual([0, 1]);
  });

  it('shows that many lines, keeps the others’ room hidden, and lands the total last', () => {
    const lines = (reveal?: number) => {
      cleanup();
      const { container } = render(<SlackPreview message={MESSAGE} revealLines={reveal} />);
      return [...container.querySelectorAll<HTMLElement>('.mr-slack-pre-line')];
    };
    const three = lines(3);
    expect(three).toHaveLength(RECEIPT.length);
    expect(three.map((l) => l.dataset.shown)).toEqual(['true', 'true', 'true', 'false', 'false', 'false', 'false']);
    expect(three[3].style.visibility).toBe('hidden');
    const six = lines(6);
    const total = six.find((l) => l.dataset.callout === 'receipt-total')!;
    expect(total.dataset.shown, 'the total waits for every other line').toBe('false');
    expect(six.filter((l) => l.dataset.shown === 'true')).toHaveLength(6);
    expect(lines(7).every((l) => l.dataset.shown === 'true')).toBe(true);
    // The header is not a code line: it shows from the start.
    const { container } = render(<SlackPreview message={MESSAGE} revealLines={0} />);
    expect(container.querySelector('.mr-slack-header')?.textContent).toContain('Weekly receipt');
  });

  it('without revealLines renders exactly as before: no reveal attributes, nothing hidden', () => {
    const { container } = render(<SlackPreview message={MESSAGE} />);
    const lines = [...container.querySelectorAll<HTMLElement>('.mr-slack-pre-line')];
    expect(lines).toHaveLength(RECEIPT.length);
    for (const l of lines) {
      expect(l.hasAttribute('data-shown')).toBe(false);
      expect(l.style.visibility).toBe('');
    }
  });
});
