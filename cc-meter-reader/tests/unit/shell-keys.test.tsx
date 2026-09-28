// @vitest-environment jsdom
// The shell after the epic audit's WP-A day 1: the keyboard map's guards and ranks (P0-05), the way to the
// stage and back (P0-06), toasts that never reach the stage and never repeat themselves (P0-09, P1-A03), and
// views that render without suspending once preloaded (P1-A02).

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastApi = vi.hoisted(() => {
  let next = 0;
  const shown: { id: string; kind: string; opts: Record<string, unknown> }[] = [];
  const make = (kind: string) =>
    vi.fn((_content: unknown, opts: Record<string, unknown> = {}) => {
      const id = `t${++next}`;
      shown.push({ id, kind, opts });
      return id;
    });
  return {
    shown,
    Toast: { success: make('success'), info: make('info'), warning: make('warning'), error: make('error'), destroy: vi.fn(), Provider: () => null },
  };
});
vi.mock('@capra/core', () => ({ Toast: toastApi.Toast }));

import { notify, TOAST_POSITION } from '../../src/components/common/notify.tsx';
import { originOf, stageHref } from '../../src/components/Shell/useShellEffects.ts';
import { isWidgetKeyTarget } from '../../src/lib/dom.ts';
import { preloadable } from '../../src/lib/preload.ts';
import { dispatchShortcut, isShortcutEvent, keysForEvent, normalizeKey, registerShortcut } from '../../src/lib/shortcuts.ts';

function element(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

function keydown(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('keyboard map: which keys are shortcuts (P0-05)', () => {
  it('normalizes letters, Escape and Shift chords', () => {
    expect(normalizeKey('p')).toBe('P');
    expect(normalizeKey('Esc')).toBe('Escape');
    expect(normalizeKey('Escape')).toBe('Escape');
    expect(normalizeKey('shift+d')).toBe('Shift+D');
    expect(keysForEvent(keydown({ key: 'D', shiftKey: true }))).toEqual(['Shift+D', 'D']);
    expect(keysForEvent(keydown({ key: '?', shiftKey: true }))).toEqual(['?']);
    expect(keysForEvent(keydown({ key: 'p' }))).toEqual(['P']);
  });

  it('accepts Escape but no other named key; never a chord with Ctrl, ⌘ or Alt', () => {
    expect(isShortcutEvent(keydown({ key: 'Escape' }))).toBe(true);
    for (const key of ['Tab', 'ArrowLeft', 'Enter', 'F5', 'Shift']) expect(isShortcutEvent(keydown({ key })), key).toBe(false);
    expect(isShortcutEvent(keydown({ key: 'D', shiftKey: true, metaKey: true }))).toBe(false);
    expect(isShortcutEvent(keydown({ key: 'D', shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(isShortcutEvent(keydown({ key: 'p', altKey: true }))).toBe(false);
    expect(isShortcutEvent(keydown({ key: 'p', repeat: true }))).toBe(false);
  });

  it('leaves keys to an open listbox, a select trigger, a menu, a dialog or a modal', () => {
    const option = element('<div role="listbox"><div role="option" tabindex="0">OK</div></div>').querySelector('[role="option"]')!;
    expect(isShortcutEvent(keydown({ key: 'p' }, option))).toBe(false);
    document.body.innerHTML = '';
    const trigger = element('<button aria-haspopup="listbox">All statuses</button>');
    expect(isShortcutEvent(keydown({ key: 'p' }, trigger))).toBe(false);
    const inDialog = element('<div role="dialog"><button>Apply</button></div>').querySelector('button')!;
    expect(isShortcutEvent(keydown({ key: 'p' }, inDialog))).toBe(false);
    document.body.innerHTML = '';
    // A popup that is open somewhere else owns the keyboard wherever focus sits.
    const outside = element('<button>Elsewhere</button>');
    expect(isShortcutEvent(keydown({ key: 'p' }, outside))).toBe(true);
    element('<div role="listbox"></div>');
    expect(isWidgetKeyTarget(outside)).toBe(true);
    expect(isShortcutEvent(keydown({ key: 'p' }, outside))).toBe(false);
  });

  it('still fires from a nav tab link, a menu button and a hover-card marker', () => {
    expect(isShortcutEvent(keydown({ key: 'p' }, element('<a href="/ledger" aria-current="page">Ledger</a>')))).toBe(true);
    expect(isShortcutEvent(keydown({ key: 'p' }, element('<button aria-haspopup="menu">More</button>')))).toBe(true);
    expect(isShortcutEvent(keydown({ key: 'p' }, element('<button aria-haspopup="true">More</button>')))).toBe(true);
    expect(isShortcutEvent(keydown({ key: 'p' }, element('<g tabindex="0" aria-haspopup="dialog"></g>')))).toBe(true);
  });
});

describe('keyboard map: dispatch (P0-05)', () => {
  it('a Shift chord wins over its plain letter, and Shift+letter falls back to the letter', () => {
    const plain = vi.fn();
    const chord = vi.fn();
    const offPlain = registerShortcut('D', plain);
    expect(dispatchShortcut(keydown({ key: 'D', shiftKey: true }))).toBe(true);
    expect(plain).toHaveBeenCalledTimes(1);
    const offChord = registerShortcut('Shift+D', chord);
    expect(dispatchShortcut(keydown({ key: 'D', shiftKey: true }))).toBe(true);
    expect(chord).toHaveBeenCalledTimes(1);
    expect(plain).toHaveBeenCalledTimes(1);
    // Story mode dispatches chords only: the plain letter is not reached.
    offChord();
    expect(dispatchShortcut(keydown({ key: 'D', shiftKey: true }), { chordsOnly: true })).toBe(false);
    offPlain();
  });

  it('a higher priority wins whenever it registered; a declining handler passes the key down', () => {
    const overlay = vi.fn(() => undefined);
    const stage = vi.fn(() => undefined);
    const offOverlay = registerShortcut('Escape', overlay, { priority: 1 });
    const offStage = registerShortcut('Escape', stage); // registered later, lower rank
    expect(dispatchShortcut(keydown({ key: 'Escape' }))).toBe(true);
    expect(overlay).toHaveBeenCalledTimes(1);
    expect(stage).not.toHaveBeenCalled();
    offOverlay();
    expect(dispatchShortcut(keydown({ key: 'Escape' }))).toBe(true);
    expect(stage).toHaveBeenCalledTimes(1);
    offStage();

    const declines = vi.fn(() => false as const);
    const takes = vi.fn();
    const offTakes = registerShortcut('P', takes);
    const offDeclines = registerShortcut('P', declines);
    expect(dispatchShortcut(keydown({ key: 'p' }))).toBe(true);
    expect(declines).toHaveBeenCalledTimes(1);
    expect(takes).toHaveBeenCalledTimes(1);
    offDeclines();
    offTakes();
    expect(dispatchShortcut(keydown({ key: 'p' }))).toBe(false);
  });

  it('consumes the key it handles: default prevented and propagation stopped', () => {
    const off = registerShortcut('Y', () => undefined);
    const event = keydown({ key: 'y' });
    const stop = vi.spyOn(event, 'stopPropagation');
    expect(dispatchShortcut(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalled();
    off();
  });
});

describe('the stage and the way back (P0-06)', () => {
  it('opens on / with the sticky params only', () => {
    expect(stageHref('?period=30d&object=input:mrd_pay_sample&timeline=7d')).toBe('/?period=30d&present=1');
    expect(stageHref('')).toBe('/?present=1');
    expect(stageHref('?group=default&range=6h')).toBe('/?group=default&range=6h&present=1');
  });

  it('remembers where it was opened, without present', () => {
    expect(originOf('/flow', '?present=1&group=default')).toEqual({ pathname: '/flow', search: '?group=default' });
    expect(originOf('/ledger', '?present=1')).toEqual({ pathname: '/ledger', search: '' });
  });
});

describe('toasts (P0-09, P1-A03)', () => {
  beforeEach(() => {
    // Entering the stage closes every open toast: a clean slate for each case (an error stays up until closed).
    notify.setStage(true);
    notify.setStage(false);
    toastApi.shown.length = 0;
    vi.clearAllMocks();
  });

  it('land bottom-right; errors stay until closed', () => {
    notify.success('Saved.');
    notify.error('Save failed (HTTP 500).');
    expect(TOAST_POSITION).toBe('bottom-right');
    expect(toastApi.shown.map((s) => s.opts.position)).toEqual(['bottom-right', 'bottom-right']);
    expect(toastApi.shown[1].opts.duration).toBe(0);
  });

  it('show one toast per message while it is up: a double click, four identical failures', () => {
    const first = notify.success('Receipt copied.');
    expect(notify.success('Receipt copied.')).toBe(first);
    for (let i = 0; i < 4; i++) notify.error('Save failed (HTTP 500).');
    expect(toastApi.Toast.success).toHaveBeenCalledTimes(1);
    expect(toastApi.Toast.error).toHaveBeenCalledTimes(1);
    // Closed (by the user or its timer): the same message may show again.
    (toastApi.shown[0].opts.onClose as () => void)();
    notify.success('Receipt copied.');
    expect(toastApi.Toast.success).toHaveBeenCalledTimes(2);
  });

  it('keyed toasts stay once per key and can be dismissed', () => {
    const id = notify.once('live-server-error', 'error', 'Couldn’t reach the Leader (503).');
    expect(notify.once('live-server-error', 'error', 'Couldn’t reach the Leader (502).')).toBe(id);
    notify.dismiss('live-server-error');
    expect(toastApi.Toast.destroy).toHaveBeenCalledWith(id);
    notify.once('live-server-error', 'error', 'Couldn’t reach the Leader (503).');
    expect(toastApi.Toast.error).toHaveBeenCalledTimes(2);
  });

  it('never show on the stage, and entering the stage clears what is up', () => {
    const up = notify.info('Scene started.');
    notify.setStage(true);
    expect(toastApi.Toast.destroy).toHaveBeenCalledWith(up);
    expect(notify.warning('Savings dropped: Payments API sampling')).toBe('');
    expect(notify.success('Sent to Slack at 11:44:03')).toBe('');
    expect(notify.once('live-server-error', 'error', 'Couldn’t reach the Leader (503).')).toBe('');
    expect(toastApi.Toast.warning).not.toHaveBeenCalled();
    expect(toastApi.Toast.success).not.toHaveBeenCalled();
    expect(toastApi.Toast.error).not.toHaveBeenCalled();
    notify.setStage(false);
    notify.once('live-server-error', 'error', 'Couldn’t reach the Leader (503).');
    expect(toastApi.Toast.error).toHaveBeenCalledTimes(1);
  });
});

describe('preloadable views (P1-A02)', () => {
  it('render synchronously once preloaded, and only fetch once', async () => {
    const factory = vi.fn(async () => ({ default: () => <p>Ledger</p> }));
    const view = preloadable(factory);
    expect(view.isLoaded()).toBe(false);
    await Promise.all([view.preload(), view.preload()]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(view.isLoaded()).toBe(true);
    // No Suspense boundary and no await: a suspending render could not produce markup here.
    expect(renderToStaticMarkup(<view.Component />)).toBe('<p>Ledger</p>');
  });

  it('retries a failed fetch on the next ask, and a failed preload stays quiet', async () => {
    let fail = true;
    const factory = vi.fn(async () => {
      if (fail) throw new Error('chunk gone');
      return { default: () => <p>Flow</p> };
    });
    const view = preloadable(factory);
    await expect(view.preload()).resolves.toBeUndefined();
    expect(view.isLoaded()).toBe(false);
    fail = false;
    await view.preload();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(renderToStaticMarkup(<view.Component />)).toBe('<p>Flow</p>');
  });

});
