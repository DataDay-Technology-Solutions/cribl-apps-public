// @vitest-environment jsdom
// The shell's keyboard map must stay quiet while the range picker's inputs have focus (src/lib/dom.ts
// isTypingTarget; src/lib/shortcuts.ts isShortcutEvent): native datetime-local inputs, and react-aria date
// segments (role="spinbutton") should a Capra date field ever replace them.

import { describe, expect, it } from 'vitest';
import { isTypingTarget } from '../../src/lib/dom.ts';
import { isShortcutEvent } from '../../src/lib/shortcuts.ts';

function element(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

describe('shortcut guard over the range picker', () => {
  it('treats datetime-local, date and time inputs as typing targets', () => {
    for (const type of ['datetime-local', 'date', 'time', 'text']) expect(isTypingTarget(element(`<input type="${type}">`)), type).toBe(true);
  });

  it('treats react-aria date segments (role spinbutton) as typing targets', () => {
    expect(isTypingTarget(element('<div role="spinbutton" tabindex="0" contenteditable="false">09</div>'))).toBe(true);
    expect(isTypingTarget(element('<div role="presentation">09</div>'))).toBe(false);
  });

  it('still lets shortcuts fire from the toggle buttons and the popover’s buttons', () => {
    expect(isTypingTarget(element('<button type="button">Custom</button>'))).toBe(false);
    expect(isTypingTarget(element('<input type="button" value="Apply">'))).toBe(false);
  });

  it('isShortcutEvent follows the guard', () => {
    const input = element('<input type="datetime-local">');
    input.focus();
    const inField = new KeyboardEvent('keydown', { key: 'p', bubbles: true });
    Object.defineProperty(inField, 'target', { value: input });
    expect(isShortcutEvent(inField)).toBe(false);
    const button = element('<button type="button">Custom</button>');
    const onButton = new KeyboardEvent('keydown', { key: 'p', bubbles: true });
    Object.defineProperty(onButton, 'target', { value: button });
    expect(isShortcutEvent(onButton)).toBe(true);
  });
});
