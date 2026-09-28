// @vitest-environment jsdom
// The single-key shortcuts off switch (WCAG 2.1.4, EPIC_AUDIT P1-A09): the keyboard map ignores every
// character key while it is off (Escape still works), and the setting survives a round trip through KV.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, mergeSettings } from '../../core/settings.ts';
import { dispatchShortcut, registerShortcut, setSingleKeyShortcuts, singleKeyShortcutsEnabled } from '../../src/lib/shortcuts.ts';

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, cancelable: true, ...init });

describe('single-key shortcuts off switch', () => {
  afterEach(() => setSingleKeyShortcuts(true));

  it('off: P, ?, /, 1 and Shift+D do nothing; Escape still runs', () => {
    const handlers = { p: vi.fn(), q: vi.fn(), slash: vi.fn(), one: vi.fn(), d: vi.fn(), esc: vi.fn() };
    const off = [
      registerShortcut('P', handlers.p),
      registerShortcut('?', handlers.q),
      registerShortcut('/', handlers.slash),
      registerShortcut('1', handlers.one),
      registerShortcut('Shift+D', handlers.d),
      registerShortcut('Escape', handlers.esc),
    ];
    try {
      setSingleKeyShortcuts(false);
      expect(singleKeyShortcutsEnabled()).toBe(false);
      for (const e of [key('p'), key('?', { shiftKey: true }), key('/'), key('1'), key('D', { shiftKey: true })]) expect(dispatchShortcut(e)).toBe(false);
      expect(dispatchShortcut(key('Escape'))).toBe(true);
      expect(handlers.esc).toHaveBeenCalledTimes(1);
      for (const h of [handlers.p, handlers.q, handlers.slash, handlers.one, handlers.d]) expect(h).not.toHaveBeenCalled();
      setSingleKeyShortcuts(true);
      expect(dispatchShortcut(key('p'))).toBe(true);
      expect(handlers.p).toHaveBeenCalledTimes(1);
    } finally {
      off.forEach((f) => f());
    }
  });

  it('the setting is kept by mergeSettings only as a boolean; absent stays absent (on)', () => {
    const defaults = defaultSettings('2026-09-30T00:00:00.000Z', 'UTC');
    expect(mergeSettings({ keyboard: { singleKeyShortcuts: false } }, defaults).keyboard).toEqual({ singleKeyShortcuts: false });
    expect(mergeSettings({ keyboard: { singleKeyShortcuts: 'no' } }, defaults).keyboard).toBeUndefined();
    expect(mergeSettings({}, defaults).keyboard).toBeUndefined();
  });
});
