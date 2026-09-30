// @vitest-environment jsdom
// Incident takeover (PRD 8.1): when it shows (tracker), how long it stays, how it goes, and the card itself.

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { Commit, Incident, Snapshot } from '../../core/types.ts';
import { IncidentTakeover } from '../../src/components/IncidentTakeover/IncidentTakeover.tsx';
import { TakeoverCard } from '../../src/components/IncidentTakeover/TakeoverCard.tsx';
import { lostAt, lostClock } from '../../src/components/IncidentTakeover/lost.ts';
import { freezeCard } from '../../src/components/IncidentTakeover/morph.ts';
import { restoringCommit } from '../../src/components/IncidentTakeover/restore.ts';
import {
  MAX_QUEUE,
  TAKEOVER_MS,
  createTracker,
  enqueue,
  observeIncidents,
  type TakeoverEvent,
} from '../../src/components/IncidentTakeover/tracker.ts';
import { StoreProvider } from '../../src/state/providers.tsx';
import { createAppStore, type AppStore } from '../../src/state/store.ts';

const T = Date.parse('2026-09-30T16:42:03.000Z');
const iso = (deltaSec: number) => new Date(T + deltaSec * 1000).toISOString();

function inc(id: string, over: Partial<Incident> = {}): Incident {
  return {
    id,
    type: 'regression',
    severity: 'high',
    objectKey: `pipe:default:${id}`,
    label: 'Payments API sampling',
    openedAt: iso(0),
    cause: 'commit',
    commit: {
      hash: 'a1f3c9e5b2',
      message: 'demo: break the trim on mrd_pay_sample',
      author: 's.koelpin',
      committedAt: iso(-180),
      deployedAt: iso(-171),
      groupId: 'default',
      match: 'message',
    },
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    caughtInSec: 171,
    notes: [],
    deliveries: [],
    ...over,
  };
}

describe('tracker', () => {
  it('uses the first snapshot as the baseline and ignores a missing snapshot', () => {
    const tr = createTracker();
    expect(observeIncidents(tr, null)).toEqual([]);
    expect(tr.initialized).toBe(false);
    expect(observeIncidents(tr, [inc('old')])).toEqual([]);
    expect(tr.initialized).toBe(true);
    expect(observeIncidents(tr, [inc('old')])).toEqual([]);
  });

  it('takes over for a new open high incident, once', () => {
    const tr = createTracker();
    observeIncidents(tr, []);
    const events = observeIncidents(tr, [inc('a')]);
    expect(events.map((e) => e.key)).toEqual(['alert:a']);
    expect(
      observeIncidents(tr, [
        inc('a', {
          deliveries: [{ endpointId: 'e', status: 200, at: iso(2) }],
        }),
      ]),
    ).toEqual([]);
  });

  it('skips medium, info and good news; takes over when a medium is upgraded to high', () => {
    const tr = createTracker();
    observeIncidents(tr, []);
    expect(
      observeIncidents(tr, [
        inc('m', { severity: 'medium' }),
        inc('g', { type: 'goodnews', severity: 'high' }),
        inc('i', { severity: 'info' }),
      ]),
    ).toEqual([]);
    expect(observeIncidents(tr, [inc('m')]).map((e) => e.key)).toEqual(['alert:m']);
  });

  it('shows a recovery when a watched incident closes — including one open at the baseline', () => {
    const tr = createTracker();
    observeIncidents(tr, [inc('old')]);
    observeIncidents(tr, [inc('old'), inc('new')]);
    const events = observeIncidents(tr, [inc('old', { closedAt: iso(60) }), inc('new', { closedAt: iso(61) })]);
    expect(events.map((e) => e.key)).toEqual(['recovery:old', 'recovery:new']);
    expect(observeIncidents(tr, [inc('old', { closedAt: iso(60) })])).toEqual([]);
    // A medium that closes was never watched.
    const tr2 = createTracker();
    observeIncidents(tr2, []);
    observeIncidents(tr2, [inc('m', { severity: 'medium' })]);
    expect(observeIncidents(tr2, [inc('m', { severity: 'medium', closedAt: iso(9) })])).toEqual([]);
  });

  it('a recovery carries the last open version it saw, so the green card knows how far it fell', () => {
    const tr = createTracker();
    observeIncidents(tr, []);
    observeIncidents(tr, [inc('a', { after: 0.55 })]);
    observeIncidents(tr, [inc('a', { after: 0.5, deliveries: [{ endpointId: 'e', status: 200, at: iso(2) }] })]);
    const [ev] = observeIncidents(tr, [inc('a', { closedAt: iso(90), after: 0.75 })]);
    expect(ev.mode).toBe('recovery');
    expect(ev.was?.after).toBe(0.5);
    expect(ev.incident.after).toBe(0.75);
    expect(tr.lastOpen.has('a')).toBe(false);
    // Open at the baseline counts as seen; a medium incident is never remembered.
    const tr2 = createTracker();
    observeIncidents(tr2, [inc('b', { after: 0.4 }), inc('m', { severity: 'medium' })]);
    expect([...tr2.lastOpen.keys()]).toEqual(['b']);
    expect(observeIncidents(tr2, [inc('b', { closedAt: iso(5), after: 0.75 })])[0].was?.after).toBe(0.4);
  });

  it('queues alerts oldest first in one sweep', () => {
    const tr = createTracker();
    observeIncidents(tr, []);
    const events = observeIncidents(tr, [inc('b', { openedAt: iso(5) }), inc('a', { openedAt: iso(1) })]);
    expect(events.map((e) => e.key)).toEqual(['alert:a', 'alert:b']);
  });

  it('enqueue: a recovery replaces its pending alert, duplicates are dropped, the queue is capped', () => {
    const alert = (id: string): TakeoverEvent => ({
      key: `alert:${id}`,
      mode: 'alert',
      incident: inc(id),
    });
    const recovery = (id: string): TakeoverEvent => ({
      key: `recovery:${id}`,
      mode: 'recovery',
      incident: inc(id, { closedAt: iso(1) }),
    });
    expect(enqueue([alert('a'), alert('b')], [recovery('b')]).map((e) => e.key)).toEqual(['alert:a', 'recovery:b']);
    expect(enqueue([alert('a')], [alert('a')]).map((e) => e.key)).toEqual(['alert:a']);
    const many = enqueue([], ['a', 'b', 'c', 'd', 'e', 'f'].map(alert));
    expect(many).toHaveLength(MAX_QUEUE);
    expect(many[0].key).toBe('alert:a');
    expect(many.at(-1)?.key).toBe('alert:f');
  });
});

// ─── The connected takeover ──────────────────────────────────────────────────

function snapshot(incidents: Incident[]): Snapshot {
  return { incidents } as unknown as Snapshot;
}

describe('<IncidentTakeover>', () => {
  let store: AppStore;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T + 9_000);
    store = createAppStore(defaultSettings(iso(0), 'UTC'));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const mount = () =>
    render(
      <StoreProvider store={store}>
        <IncidentTakeover />
      </StoreProvider>,
    );

  it('shows nothing for the baseline, then the card for a new high alert; the key that dismisses it is consumed', () => {
    // The shell's one shortcut dispatcher: a bubble-phase window listener registered BEFORE the takeover
    // mounts (REVIEW-3a #7) — it must never see the dismissing key, so that key never pulls a lever.
    const shell = vi.fn();
    window.addEventListener('keydown', shell);
    try {
      act(() => store.setState({ snapshot: snapshot([inc('old')]) }));
      mount();
      expect(screen.queryByRole('alert')).toBeNull();
      act(() => store.setState({ snapshot: snapshot([inc('old'), inc('new')]) }));
      expect(screen.getByRole('alert').getAttribute('data-incident-id')).toBe('new');
      expect(screen.getByText('Savings dropped: Payments API sampling')).toBeTruthy();

      for (const k of ['0', 'r']) {
        // '0' (reset everything) dismisses the card and is swallowed; with no card up, 'r' reaches the shell.
        const key = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
        act(() => {
          document.body.dispatchEvent(key);
        });
        if (k === '0') {
          expect(key.defaultPrevented).toBe(true);
          expect(shell).not.toHaveBeenCalled();
          act(() => {
            vi.advanceTimersByTime(250);
          });
          expect(screen.queryByRole('alert')).toBeNull();
        } else {
          expect(key.defaultPrevented).toBe(false);
          expect(shell).toHaveBeenCalledTimes(1);
        }
      }
    } finally {
      window.removeEventListener('keydown', shell);
    }
  });

  it('leaves keys aimed at a text field or an open dialog alone', () => {
    const shell = vi.fn();
    window.addEventListener('keydown', shell);
    try {
      mount();
      act(() => store.setState({ snapshot: snapshot([]) }));
      act(() => store.setState({ snapshot: snapshot([inc('a')]) }));
      expect(screen.getByRole('alert')).toBeTruthy();

      const input = document.createElement('input');
      document.body.appendChild(input);
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      const button = document.createElement('button');
      dialog.appendChild(button);
      document.body.appendChild(dialog);
      for (const target of [input, button]) {
        const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        act(() => {
          target.dispatchEvent(key);
          vi.advanceTimersByTime(250);
        });
        expect(key.defaultPrevented).toBe(false);
      }
      expect(shell).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('alert')).toBeTruthy();
      input.remove();
      dialog.remove();
    } finally {
      window.removeEventListener('keydown', shell);
    }
  });

  it('modifier keys do not dismiss; 45 s does', () => {
    mount();
    act(() => store.setState({ snapshot: snapshot([]) }));
    act(() => store.setState({ snapshot: snapshot([inc('a')]) }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
      vi.advanceTimersByTime(TAKEOVER_MS.alert - 1_000);
    });
    expect(screen.queryByRole('alert')).not.toBeNull();
    // A delivery landing does not restart the 45 s.
    act(() =>
      store.setState({
        snapshot: snapshot([
          inc('a', {
            deliveries: [{ endpointId: 'e', status: 200, at: iso(2) }],
          }),
        ]),
      }),
    );
    act(() => {
      vi.advanceTimersByTime(1_300);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('flips the showing alert to the green recovery, which leaves after 10 s', () => {
    mount();
    act(() => store.setState({ snapshot: snapshot([]) }));
    act(() => store.setState({ snapshot: snapshot([inc('a')]) }));
    act(() =>
      store.setState({
        snapshot: snapshot([inc('a', { closedAt: iso(60), after: 0.75 })]),
      }),
    );
    const card = screen.getByRole('status');
    expect(card.getAttribute('data-mode')).toBe('recovery');
    expect(screen.getByText('Recovered · savings back to 75% · closed itself.')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(TAKEOVER_MS.recovery + 300);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});

// ─── The card ────────────────────────────────────────────────────────────────

describe('<TakeoverCard>', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('is live (at the measured catch) until the delivery lands, then settles with "Sent to Slack ✓" and seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T + 9_000);
    const endpoints = [
      {
        id: 'ep',
        name: 'Slack',
        url: 'https://hooks.slack.com/x',
        host: 'hooks.slack.com',
        format: 'slack' as const,
        minSeverity: 'medium' as const,
        weeklyReceipt: true,
        enabled: true,
      },
    ];
    const { rerender, container } = render(
      <TakeoverCard incident={inc('a', { notes: ['demo-profile'] })} mode="alert" endpoints={endpoints} tz="UTC" placement="inline" />,
    );
    const clock = container.querySelector('.mr-tk-caught')!;
    expect(clock.getAttribute('data-live')).toBe('true');
    // r2 ui-11 (R2 #14): the measured catch, still, while the delivery is on its way (it used to count on to 3:00).
    expect(container.querySelector('.mr-tk-caught-text')!.textContent).toBe('Caught in 2:51');
    // Assistive tech hears the measured number once, not a ticking clock.
    expect(container.querySelector('.mr-tk-caught-text')!.getAttribute('aria-hidden')).toBe('true');
    expect(clock.querySelector('.mr-visually-hidden')!.textContent).toBe('Caught in 2:51');
    expect(container.querySelector('[data-callout="per-day"]')!.textContent).toBe('$25 a day · $9,125 a year if left');
    expect(container.querySelector('[data-callout="commit"]')!.textContent).toBe('a1f3c9e');
    expect(container.querySelector('[data-callout="author"]')!.textContent).toBe('s.koelpin');
    expect(screen.getByText('1-minute confirmation (demo profile). Default is 3.')).toBeTruthy();
    expect(screen.getByText('change naming this pipeline')).toBeTruthy();

    rerender(
      <TakeoverCard
        incident={inc('a', {
          deliveries: [{ endpointId: 'ep', status: 200, at: iso(2) }],
        })}
        mode="alert"
        endpoints={endpoints}
        tz="UTC"
        placement="inline"
      />,
    );
    expect(container.querySelector('.mr-tk-caught')!.getAttribute('data-live')).toBe('false');
    expect(container.querySelector('.mr-tk-caught-text')!.textContent).toBe('Caught in 2:51');
    expect(container.querySelector('.mr-tk-delivery')!.textContent).toBe('Sent to Slack ✓ 4:42:05 PM');
    // No dismiss affordance without onDismiss.
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('renders the recovery variant and the unknown-cause alert', () => {
    render(
      <TakeoverCard
        incident={inc('a', {
          type: 'spike',
          closedAt: iso(9),
          recoveredTo: 41_000_000,
        })}
        mode="recovery"
        onDismiss={() => {}}
        placement="inline"
      />,
    );
    expect(screen.getByText('Recovered · cost back to $410 an hour · closed itself.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    cleanup();
    render(<TakeoverCard incident={inc('b', { cause: 'unknown', commit: undefined })} mode="alert" placement="inline" />);
    expect(screen.getByText('No configuration change found nearby')).toBeTruthy();
    expect(document.querySelector('[data-callout="commit"]')).toBeNull();
  });

  it('BEAUTY F3: the recovery is the same card in green — how far it fell → now, no "Savings dropped" sub-line', () => {
    // D47: the closed incident keeps its drop (`after` 0.5) and carries where it recovered to.
    const closed = inc('a', {
      closedAt: iso(96),
      recoveredTo: 0.75,
      deliveries: [
        { endpointId: 'ep', status: 200, at: iso(2) },
        { endpointId: 'ep', status: 200, at: iso(97) },
      ],
    });
    const endpoints = [
      {
        id: 'ep',
        name: 'Slack',
        url: 'https://hooks.slack.com/x',
        host: 'hooks.slack.com',
        format: 'slack' as const,
        minSeverity: 'medium' as const,
        weeklyReceipt: true,
        enabled: true,
      },
    ];
    const { container } = render(<TakeoverCard incident={closed} mode="recovery" endpoints={endpoints} tz="UTC" placement="inline" />);
    const card = container.querySelector('.mr-takeover')!;
    expect(card.className).toContain('mr-takeover--recovered');
    expect(card.getAttribute('role')).toBe('status');
    // The header band carries the glyph and the title; no stripe element, no sub-line repeating the alert.
    const head = card.querySelector('.mr-tk-head')!;
    expect(head.querySelector('[aria-label="Recovered"]')).not.toBeNull();
    expect(head.querySelector('.mr-tk-title')!.textContent).toBe('Recovered · savings back to 75% · closed itself.');
    expect(container.querySelector('.mr-tk-recovery-sub')).toBeNull();
    expect(container.querySelector('.mr-tk-before')!.textContent).toBe('50%');
    expect(container.querySelector('.mr-tk-after')!.textContent).toBe('75%');
    expect(container.querySelector('.mr-tk-after')!.className).toContain('mr-tk-after--saved');
    expect(container.querySelector('.mr-tk-object')!.textContent).toBe('Payments API sampling');
    expect(card.textContent).not.toContain('Savings dropped');
    expect(container.querySelector('[data-callout="per-day"]')!.textContent).toBe('Saving $25 a day again · $9,125 a year');
    expect(container.querySelector('.mr-tk-caught-text')!.textContent).toBe('Alert open for 1:36');
    // P1-B02: no bare kind chip; with no restoring change on the timeline, it says the savings are back.
    expect(screen.getByText('Back at its baseline since 4:43:39 PM')).toBeTruthy();
    expect(container.querySelector('.mr-tk-chip')).toBeNull();
    // Only the recovery message's own delivery shows (the alert's landed before the close).
    expect(container.querySelector('.mr-tk-delivery')!.textContent).toBe('Sent to Slack ✓ 4:43:40 PM');
    expect(card.getAttribute('data-delivered')).toBe('true');
  });

  it('D47: the drop comes from the incident itself; one closed before D47 needs the last open version, else shows only where it is now', () => {
    const { container, rerender } = render(<TakeoverCard incident={inc('a', { closedAt: iso(96), recoveredTo: 0.75 })} mode="recovery" placement="inline" />);
    expect(container.querySelector('.mr-tk-before')!.textContent).toBe('50%');
    expect(container.querySelector('.mr-tk-after')!.textContent).toBe('75%');
    // Nothing was delivered after the close: no delivery line.
    expect(container.querySelector('.mr-tk-delivery')).toBeNull();
    // Closed before D47 (`after` held the reading at close), placed directly, e.g. the Story: no low to show.
    rerender(<TakeoverCard incident={inc('a', { closedAt: iso(96), after: 0.75 })} mode="recovery" placement="inline" />);
    expect(container.querySelector('.mr-tk-before')).toBeNull();
    expect(container.querySelector('.mr-tk-after')!.textContent).toBe('75%');
    // …and with the last open version the presenter saw, the low it kept.
    rerender(<TakeoverCard incident={inc('a', { closedAt: iso(96), after: 0.75 })} was={inc('a', { after: 0.5 })} mode="recovery" placement="inline" />);
    expect(container.querySelector('.mr-tk-before')!.textContent).toBe('50%');
    expect(container.querySelector('.mr-tk-after')!.textContent).toBe('75%');
    // Closed with no reading at all (a demo reset): no figures, and never "back to" the low.
    rerender(<TakeoverCard incident={inc('a', { closedAt: iso(96) })} mode="recovery" placement="inline" />);
    expect(container.querySelector('.mr-tk-ratio')).toBeNull();
    expect(container.querySelector('.mr-tk-title')!.textContent).toBe('Recovered · closed itself.');
    expect(container.textContent).not.toContain('50%');
  });

  it('NOTIFY-3a issue 1: the implicit bell reads "Cribl notifications", and a landed webhook wins the one status line', () => {
    const bellOnly = inc('a', { deliveries: [{ endpointId: 'cribl-bell', status: 200, at: iso(2) }] });
    const { container, rerender } = render(<TakeoverCard incident={bellOnly} mode="alert" endpoints={[]} tz="UTC" placement="inline" />);
    expect(container.querySelector('.mr-tk-delivery')!.textContent).toBe('Sent to Cribl notifications ✓ 4:42:05 PM');
    expect(container.querySelector('.mr-tk-delivery')!.textContent).not.toContain('cribl-bell');
    const endpoints = [
      {
        id: 'ep',
        name: 'Slack',
        url: 'https://hooks.slack.com/x',
        host: 'hooks.slack.com',
        format: 'slack' as const,
        minSeverity: 'medium' as const,
        weeklyReceipt: true,
        enabled: true,
      },
    ];
    // The bell landed a second later than Slack (newest first would pick it); Slack still wins.
    rerender(
      <TakeoverCard
        incident={inc('a', {
          deliveries: [
            { endpointId: 'ep', status: 200, at: iso(2) },
            { endpointId: 'cribl-bell', status: 200, at: iso(3) },
          ],
        })}
        mode="alert"
        endpoints={endpoints}
        tz="UTC"
        placement="inline"
      />,
    );
    expect(container.querySelector('.mr-tk-delivery')!.textContent).toBe('Sent to Slack ✓ 4:42:05 PM');
    // A failing webhook next to a landed bell: the landed one shows, not the red line.
    rerender(
      <TakeoverCard
        incident={inc('a', {
          deliveries: [
            { endpointId: 'ep', status: 503, at: iso(4) },
            { endpointId: 'cribl-bell', status: 200, at: iso(3) },
          ],
        })}
        mode="alert"
        endpoints={endpoints}
        tz="UTC"
        placement="inline"
      />,
    );
    expect(container.querySelector('.mr-tk-delivery')!.textContent).toBe('Sent to Cribl notifications ✓ 4:42:06 PM');
  });
});

// ─── P1-B01 / P1-B02: the hand-off, the restoring change, the polish ─────────


const RESTORE: Commit = {
  hash: '9b1c2f3d4e',
  message: 'demo: restore the trim on a',
  author: 'r.okafor',
  committedAt: iso(40),
  deployedAt: iso(45),
  groupId: 'default',
  files: ['groups/default/pipelines/a/conf.yml'],
  source: 'demo',
};

describe('restoringCommit (P1-B02)', () => {
  const closed = inc('a', { closedAt: iso(96), recoveredTo: 0.75 });
  it('names the change on the same object between the break and the close', () => {
    const ref = restoringCommit(closed, [RESTORE]);
    expect(ref?.hash).toBe('9b1c2f3d4e');
    expect(ref?.author).toBe('r.okafor');
    expect(ref?.match).toBe('files');
  });
  it('matches by the message naming the object when the files are unknown', () => {
    expect(restoringCommit(closed, [{ ...RESTORE, files: [] }])?.match).toBe('message');
  });
  it('never claims the breaking commit, a merely nearby change, one after the close or before the break', () => {
    expect(restoringCommit(closed, [{ ...RESTORE, hash: 'a1f3c9e5b2' }])).toBeUndefined();
    expect(restoringCommit(closed, [{ ...RESTORE, files: ['groups/default/pipelines/other/conf.yml'], message: 'tune other' }])).toBeUndefined();
    expect(restoringCommit(closed, [{ ...RESTORE, committedAt: iso(120), deployedAt: iso(121) }])).toBeUndefined();
    expect(restoringCommit(closed, [{ ...RESTORE, committedAt: iso(-400), deployedAt: iso(-390) }])).toBeUndefined();
  });
  it('an open incident or an empty timeline has none', () => {
    expect(restoringCommit(inc('a'), [RESTORE])).toBeUndefined();
    expect(restoringCommit(closed, [])).toBeUndefined();
    expect(restoringCommit(closed, null)).toBeUndefined();
  });
});

describe('the takeover card polish (P1-B02)', () => {
  it('the green card names the change that restored it, with no callouts of its own', () => {
    const closed = inc('a', { closedAt: iso(96), recoveredTo: 0.75 });
    const { container } = render(<TakeoverCard incident={closed} mode="recovery" restoredBy={restoringCommit(closed, [RESTORE])} tz="UTC" placement="inline" />);
    expect(container.querySelector('.mr-tk-commit-text')!.textContent).toBe('Restored in 9b1c2f3 by r.okafor');
    expect(container.querySelector('.mr-tk-message')!.textContent).toBe('"demo: restore the trim on a"');
    expect(container.querySelector('[data-callout="commit"], [data-callout="author"]')).toBeNull();
    expect(container.querySelector('.mr-tk-chip')).toBeNull();
    expect(container.textContent).not.toContain('Back at its baseline');
  });
  it('the alert names the person on their own line at the money scale, the message under it', () => {
    const { container } = render(<TakeoverCard incident={inc('a')} mode="alert" tz="UTC" placement="inline" />);
    expect(container.querySelector('.mr-tk-commit-text')!.textContent).toBe('a1f3c9e by s.koelpin');
    expect(container.querySelector('[data-callout="author"]')!.textContent).toBe('s.koelpin');
    expect(container.querySelector('[data-callout="commit"]')!.textContent).toBe('a1f3c9e');
    expect(container.querySelector('.mr-tk-message')!.textContent).toBe('"demo: break the trim on mrd_pay_sample"');
  });
  it('the money line keeps whole parts with the separator leading the second one', () => {
    const { container } = render(<TakeoverCard incident={inc('a')} mode="alert" tz="UTC" placement="inline" />);
    const money = container.querySelector('[data-callout="per-day"]')!;
    expect(money.textContent).toBe('$25 a day · $9,125 a year if left');
    const parts = [...money.querySelectorAll(':scope > .mr-tk-part')];
    expect(parts.map((p) => p.textContent)).toEqual(['$25 a day', ' · $9,125 a year if left']);
    expect(parts[1].firstElementChild!.className).toBe('mr-tk-sep');
  });
  it('the foot keeps the delivery slot while nothing has landed, and the delivery line in it once it has', () => {
    const { container, rerender } = render(<TakeoverCard incident={inc('a')} mode="alert" tz="UTC" placement="inline" />);
    expect(container.querySelector('.mr-tk-foot > .mr-tk-slot')).not.toBeNull();
    rerender(<TakeoverCard incident={inc('a', { deliveries: [{ endpointId: 'ep', status: 200, at: iso(2) }] })} mode="alert" tz="UTC" placement="inline" />);
    expect(container.querySelector('.mr-tk-foot > .mr-tk-slot')).toBeNull();
    expect(container.querySelector('.mr-tk-foot > .mr-tk-delivery')).not.toBeNull();
  });
});

describe('freezeCard (P1-B01)', () => {
  it('copies the look and drops every identity: block class, roles, ids, callouts, incident id', () => {
    const { container } = render(<TakeoverCard incident={inc('a')} mode="alert" tz="UTC" placement="overlay" animate={false} />);
    const card = container.querySelector<HTMLElement>('.mr-takeover')!;
    const ghost = freezeCard(card);
    expect(ghost.classList.contains('mr-takeover')).toBe(false);
    expect(ghost.classList.contains('mr-tk-ghost')).toBe(true);
    expect(ghost.classList.contains('mr-takeover--overlay')).toBe(true);
    expect(ghost.getAttribute('role')).toBeNull();
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.hasAttribute('data-incident-id')).toBe(false);
    expect(ghost.querySelector('[id], [data-callout]')).toBeNull();
    expect(ghost.textContent).toBe(card.textContent);
  });
});


// ─── P2-W03: the lost counter ─────────────────────────────────────────────────


describe('the lost counter (P2-W03)', () => {
  it('counts from the deploy at the incident rate: $2,386 a day, 60 s → about $1.66', () => {
    const now = Date.parse(iso(0));
    const incident = inc('a', { impactPerDayM: 238_600_000, commit: { ...inc('a').commit!, deployedAt: new Date(now - 60_000).toISOString() } });
    const clock = lostClock(incident)!;
    expect(clock.sinceDeploy).toBe(true);
    expect(lostAt(clock, now)).toBe(165_694); // $1.66
    expect(lostAt(clock, now + 10_000)).toBeGreaterThan(lostAt(clock, now));
    expect(lostAt(clock, clock.startMs - 5_000)).toBe(0);
  });
  it('starts where the "Caught in" clock starts when there is no commit, and names it so', () => {
    const clock = lostClock(inc('a', { commit: undefined, cause: 'unknown', caughtInSec: 90 }))!;
    expect(clock.sinceDeploy).toBe(false);
    expect(clock.startMs).toBe(Date.parse(iso(-90)));
  });
  it('only a savings drop or a cost spike loses money; no rate, no counter', () => {
    expect(lostClock(inc('a', { type: 'budget' }))).toBeNull();
    expect(lostClock(inc('a', { type: 'goodnews' }))).toBeNull();
    expect(lostClock(inc('a', { impactPerDayM: 0 }))).toBeNull();
    expect(lostClock(inc('a', { type: 'spike' }))).not.toBeNull();
  });
  it('the red card shows the counter under the money line; the green card the frozen cost at the close', () => {
    const { container, rerender } = render(<TakeoverCard incident={inc('a')} mode="alert" tz="UTC" placement="inline" nowMs={Date.parse(iso(10))} />);
    const counter = container.querySelector('.mr-tk-detail [data-testid="lost-counter"]')!;
    expect(counter.textContent).toContain('Lost since the deploy');
    expect(counter.getAttribute('aria-hidden')).toBe('true');
    expect(counter.querySelector('[data-callout]')).toBeNull();
    // Closed 96 s after opening; the deploy was 171 s before opening: 267 s at $25 a day = $0.08.
    rerender(<TakeoverCard incident={inc('a', { closedAt: iso(96), recoveredTo: 0.75 })} mode="recovery" tz="UTC" placement="inline" />);
    expect(container.querySelector('[data-testid="lost-counter"]')).toBeNull();
    expect(container.querySelector('[data-testid="lost-frozen"]')!.textContent).toBe('Cost $0.08 before it recovered');
  });
  it('Story turns the live counter off (D52): its compressed clock would make a wall-clock counter jump at the close', () => {
    const { container } = render(<TakeoverCard incident={inc('a')} mode="alert" tz="UTC" placement="inline" lostCounter={false} nowMs={Date.parse(iso(10))} />);
    expect(container.querySelector('[data-testid="lost-counter"]')).toBeNull();
    expect(container.querySelector('.mr-tk-money')).not.toBeNull(); // the rate itself stays
  });
});
