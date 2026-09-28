// @vitest-environment jsdom
// The tab's takeover feed (EPIC_AUDIT P1-A01): the tracker lives as long as the tab, so an incident that opened
// while the laptop was on Flow still lands on the stage when P is pressed within 45 s, and a fresh
// `?present=1` load still treats what was already open as old news.

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { Incident, Snapshot } from '../../core/types.ts';
import { IncidentTakeover } from '../../src/components/IncidentTakeover/IncidentTakeover.tsx';
import {
  LATE_ENTRY_MS,
  addPending,
  freshPending,
  takeoverFeed,
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
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    caughtInSec: 171,
    notes: [],
    deliveries: [],
    ...over,
  };
}

const snapshot = (incidents: Incident[]) => ({ incidents }) as unknown as Snapshot;
const alert = (id: string): TakeoverEvent => ({ key: `alert:${id}`, mode: 'alert', incident: inc(id) });
const recovery = (id: string): TakeoverEvent => ({ key: `recovery:${id}`, mode: 'recovery', incident: inc(id, { closedAt: iso(60) }) });

describe('pending takeovers', () => {
  it('addPending: a recovery replaces its waiting alert in place with its own time; a key waits once', () => {
    let p = addPending([], [alert('a'), alert('b')], 1_000);
    p = addPending(p, [alert('a')], 2_000);
    expect(p.map((x) => [x.event.key, x.seenAt])).toEqual([
      ['alert:a', 1_000],
      ['alert:b', 1_000],
    ]);
    p = addPending(p, [recovery('a')], 5_000);
    expect(p.map((x) => [x.event.key, x.seenAt])).toEqual([
      ['recovery:a', 5_000],
      ['alert:b', 1_000],
    ]);
  });

  it('freshPending: only what was seen in the last 45 s, boundary included', () => {
    const p = addPending(addPending([], [alert('old')], 0), [alert('new')], 10_000);
    expect(freshPending(p, LATE_ENTRY_MS).map((e) => e.key)).toEqual(['alert:old', 'alert:new']);
    expect(freshPending(p, LATE_ENTRY_MS + 1).map((e) => e.key)).toEqual(['alert:new']);
    expect(freshPending(p, 10_000 + LATE_ENTRY_MS + 1)).toEqual([]);
    expect(LATE_ENTRY_MS).toBe(45_000);
  });
});

describe('takeoverFeed', () => {
  let store: AppStore;
  let now: number;
  const clock = () => now;
  beforeEach(() => {
    now = T;
    store = createAppStore(defaultSettings(iso(0), 'UTC'));
  });

  it('is one feed per store', () => {
    expect(takeoverFeed(store, clock)).toBe(takeoverFeed(store, clock));
    expect(takeoverFeed(createAppStore(defaultSettings(iso(0), 'UTC')), clock)).not.toBe(takeoverFeed(store, clock));
  });

  it('the tab’s first snapshot is the baseline: an alert open then is old news when the stage opens', () => {
    const feed = takeoverFeed(store, clock);
    store.setState({ snapshot: snapshot([inc('open-at-load')]) });
    now += 5_000;
    const heard: string[] = [];
    feed.subscribe((events) => heard.push(...events.map((e) => e.key)));
    expect(heard).toEqual([]);
  });

  it('a late P: an alert the tab saw open in the last 45 s lands when the stage subscribes; then live', () => {
    const feed = takeoverFeed(store, clock);
    store.setState({ snapshot: snapshot([]) }); // baseline (on Flow)
    now += 1_000;
    store.setState({ snapshot: snapshot([inc('a')]) }); // opens while the laptop is on Flow
    now += 44_000; // P, 44 s later
    const heard: string[][] = [];
    const off = feed.subscribe((events) => heard.push(events.map((e) => e.key)));
    expect(heard).toEqual([['alert:a']]);
    store.setState({ snapshot: snapshot([inc('a'), inc('b', { openedAt: iso(50) })]) });
    expect(heard).toEqual([['alert:a'], ['alert:b']]);
    off();
    // Closed stage: the next one waits instead of going to a listener that left.
    store.setState({ snapshot: snapshot([inc('a'), inc('b'), inc('c', { openedAt: iso(60) })]) });
    expect(heard).toHaveLength(2);
  });

  it('an alert seen more than 45 s before P never lands; its recovery still can', () => {
    const feed = takeoverFeed(store, clock);
    store.setState({ snapshot: snapshot([]) });
    store.setState({ snapshot: snapshot([inc('a')]) });
    now += LATE_ENTRY_MS + 1;
    const heard: string[] = [];
    const off = feed.subscribe((events) => heard.push(...events.map((e) => e.key)));
    expect(heard).toEqual([]);
    store.setState({ snapshot: snapshot([inc('a', { closedAt: iso(120) })]) });
    expect(heard).toEqual(['recovery:a']);
    off();
  });

  it('what the stage already took is not handed over again when it reopens', () => {
    const feed = takeoverFeed(store, clock);
    store.setState({ snapshot: snapshot([]) });
    store.setState({ snapshot: snapshot([inc('a')]) });
    const first: string[] = [];
    feed.subscribe((events) => first.push(...events.map((e) => e.key)))();
    expect(first).toEqual(['alert:a']);
    const second: string[] = [];
    feed.subscribe((events) => second.push(...events.map((e) => e.key)))();
    expect(second).toEqual([]);
  });

  it('a new data source is a new baseline: clearing the tour never replays live alerts as new', () => {
    const feed = takeoverFeed(store, clock);
    store.setState({ source: 'sample', snapshot: snapshot([]) });
    store.setState({ source: 'sample', snapshot: snapshot([inc('tour')]) });
    store.setState({ source: 'live', snapshot: snapshot([inc('live-open')]) });
    const heard: string[] = [];
    feed.subscribe((events) => heard.push(...events.map((e) => e.key)))();
    expect(heard).toEqual([]);
  });
});

describe('<IncidentTakeover> on the tab’s feed', () => {
  let store: AppStore;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
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

  it('mounting the stage 30 s after the incident opened shows the card at once, for a full 45 s', () => {
    takeoverFeed(store); // the shell, at mount
    act(() => store.setState({ snapshot: snapshot([]) }));
    act(() => store.setState({ snapshot: snapshot([inc('a')]) }));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    mount(); // P
    expect(screen.getByRole('alert').getAttribute('data-incident-id')).toBe('a');
    act(() => {
      vi.advanceTimersByTime(44_000);
    });
    expect(screen.queryByRole('alert')).not.toBeNull();
  });

  it('mounting the stage 46 s after shows nothing', () => {
    takeoverFeed(store);
    act(() => store.setState({ snapshot: snapshot([]) }));
    act(() => store.setState({ snapshot: snapshot([inc('a')]) }));
    act(() => {
      vi.advanceTimersByTime(46_000);
    });
    mount();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
