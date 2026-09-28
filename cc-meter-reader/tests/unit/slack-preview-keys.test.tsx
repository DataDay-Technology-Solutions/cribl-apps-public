// @vitest-environment jsdom
// The Slack preview keeps its nodes across re-renders (leftovers: Safari's first click on "Send a test alert").
//
// The mrkdwn renderer used to key every inline node from a counter shared across renders, so each render of the
// same message produced new keys and React remounted the whole preview. On Settings a field's first blur
// re-renders the list; with a test preview on screen WebKit then moved a page scrolled to its end mid-click, and
// the press that began on the button ended off it. Keys are now each node's place in its own output: the same
// text gives the same keys, a re-render updates the nodes in place, and siblings never share a key.

import { cleanup, render } from '@testing-library/react';
import { isValidElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { slackPayload, testPayload } from '../../core/payloads.ts';
import { SlackPreview } from '../../src/components/SlackPreview/SlackPreview.tsx';
import { renderInline, renderMrkdwn } from '../../src/components/SlackPreview/mrkdwn.tsx';

afterEach(cleanup);

const TEXT = [
  ':red_circle: *Savings dropped* on _Payments API sampling_ · `a1f3c9e` <https://x.io/y|Open it> ~gone~',
  '*Lost per day* $25 · *Per year* $9,125',
  '```',
  'Windows event trimming ....  $9,380',
  'Saved by Cribl, last week   $23,807',
  '```',
  'after the block :receipt:',
].join('\n');

/** The keys of a node list, top level only (siblings: what React matches across renders). */
const keysOf = (nodes: ReactNode[]): (string | null)[] => nodes.map((n) => (isValidElement(n) ? n.key : null));

describe('Slack preview keys', () => {
  it('the same text yields the same keys on every render', () => {
    expect(keysOf(renderMrkdwn(TEXT))).toEqual(keysOf(renderMrkdwn(TEXT)));
    expect(keysOf(renderInline(TEXT.split('\n')[0]))).toEqual(keysOf(renderInline(TEXT.split('\n')[0])));
    // Plain text (emoji only) too.
    expect(keysOf(renderInline(':receipt: Weekly receipt', true))).toEqual(keysOf(renderInline(':receipt: Weekly receipt', true)));
  });

  it('siblings never share a key, across the lines that join one list', () => {
    const keys = keysOf(renderMrkdwn(TEXT)).filter((k): k is string => k !== null);
    expect(keys.length).toBeGreaterThan(8);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a re-render of the same message keeps every DOM node (nothing remounts)', () => {
    // The message Settings previews after a test alert (the preview that sat above the second endpoint).
    // The runner's Slack-format test alert (D57: the Settings editor no longer previews a direct webhook).
    const message = slackPayload(testPayload('Example workspace', '2026-09-27T12:00:00.000Z', ''), { tz: 'UTC' });
    const { container, rerender } = render(<SlackPreview message={message} />);
    const before = [...container.querySelectorAll('*')];
    expect(before.length).toBeGreaterThan(10);
    rerender(<SlackPreview message={structuredClone(message)} />);
    const after = [...container.querySelectorAll('*')];
    expect(after.length).toBe(before.length);
    after.forEach((el, i) => expect(el, `node ${i} (${el.tagName})`).toBe(before[i]));
  });
});
