// src/components/IncidentTakeover/tracker.ts — decides WHEN the presenter takeover shows (PRD 8.1), with no
// React and no timers so it can be tested exhaustively:
//
//   • The first snapshot the presenter sees is the baseline: nothing in it takes over (an alert that was
//     already open when the presenter opened is old news), but its open high-severity incidents are
//     remembered so their recovery can still show.
//   • After that, an incident that is open and high severity and has not taken over yet → an 'alert'
//     (this includes a medium incident upgraded to high when a later timeline refresh names the commit).
//   • A remembered high incident that gains `closedAt` → a 'recovery' (green, 10 s). The recovery carries the
//     last OPEN version the tracker saw (`was`): a closed incident's before/after are both back at baseline,
//     so only the open version still knows how far it fell ("50% → 75%" on the green card).
//   • P2-W06, only when the caller asks (`{ landed: true }`, see WhatIf/landing.ts landedAllowed): a NEW good-news
//     incident (born closed) → a 'landed' card (green, 15 s). It never pre-empts an alert: an alert goes ahead
//     of every waiting good-news card and replaces one that is showing.
//
// The tab's feed (EPIC_AUDIT P1-A01): the tracker lives as long as the tab, not the stage. The shell starts
// `takeoverFeed(store)` at mount, so the baseline is the first snapshot the TAB saw; a takeover that happens
// while the stage is closed waits in the feed with the time the tab saw it, and when P opens the stage the
// ones seen in the last 45 s (the alert's own time on stage) land at once. A fresh `?present=1` load still
// treats what was already open as old news. A change of data source (the tour, a replay, back to live)
// starts a new baseline, so clearing the tour never replays the live workspace's open alerts as new.

import type { Incident } from '../../../core/types.ts';

export type TakeoverMode = 'alert' | 'recovery' | 'landed';

export interface TakeoverEvent {
  /** `${mode}:${incident.id}` */
  key: string;
  mode: TakeoverMode;
  incident: Incident;
  /** recovery only: the last open version of the incident the tracker saw */
  was?: Incident;
}

export interface TakeoverTracker {
  initialized: boolean;
  /** incident ids that already took over (or were open-high at the baseline) */
  alerted: Set<string>;
  /** open high-severity incidents we are watching for recovery */
  watching: Set<string>;
  /** incident ids whose recovery already showed */
  recovered: Set<string>;
  /** the last open version of each watched incident (bounded by `watching`) */
  lastOpen: Map<string, Incident>;
}

export function createTracker(): TakeoverTracker {
  return {
    initialized: false,
    alerted: new Set(),
    watching: new Set(),
    recovered: new Set(),
    lastOpen: new Map(),
  };
}

function isTakeoverWorthy(i: Incident): boolean {
  return i.severity === 'high' && i.type !== 'goodnews';
}

/**
 * Feeds one snapshot's incident list to the tracker (mutating it) and returns the takeovers it triggers,
 * in the order they should show. `null` (no snapshot yet) is ignored and does not set the baseline.
 */
export function observeIncidents(tracker: TakeoverTracker, incidents: readonly Incident[] | null | undefined, opts: { landed?: boolean } = {}): TakeoverEvent[] {
  if (!incidents) return [];
  if (!tracker.initialized) {
    tracker.initialized = true;
    for (const i of incidents) {
      if (i.type === 'goodnews') tracker.alerted.add(i.id); // already landed before the presenter opened
      if (!isTakeoverWorthy(i)) continue;
      tracker.alerted.add(i.id);
      if (i.closedAt) tracker.recovered.add(i.id);
      else {
        tracker.watching.add(i.id);
        tracker.lastOpen.set(i.id, i);
      }
    }
    return [];
  }
  const events: TakeoverEvent[] = [];
  // Oldest first, so two alerts in one sweep queue in the order they opened.
  const ordered = [...incidents].sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  for (const i of ordered) {
    if (i.type === 'goodnews') {
      if (opts.landed && !tracker.alerted.has(i.id)) events.push({ key: `landed:${i.id}`, mode: 'landed', incident: i });
      tracker.alerted.add(i.id);
      continue;
    }
    if (!i.closedAt) {
      if (isTakeoverWorthy(i) && !tracker.alerted.has(i.id)) {
        tracker.alerted.add(i.id);
        tracker.watching.add(i.id);
        events.push({ key: `alert:${i.id}`, mode: 'alert', incident: i });
      }
      if (tracker.watching.has(i.id)) tracker.lastOpen.set(i.id, i);
      continue;
    }
    if (tracker.watching.has(i.id) && !tracker.recovered.has(i.id)) {
      const was = tracker.lastOpen.get(i.id);
      tracker.watching.delete(i.id);
      tracker.lastOpen.delete(i.id);
      tracker.recovered.add(i.id);
      events.push({ key: `recovery:${i.id}`, mode: 'recovery', incident: i, ...(was ? { was } : {}) });
    }
  }
  return events;
}

/** At most this many takeovers wait in line; older waiting ones are dropped (the moment has passed). */
export const MAX_QUEUE = 4;

/**
 * Adds events to the queue. A recovery replaces a still-queued (or showing) alert for the same incident in
 * place — the red card turns green instead of a stale alert showing after the fact.
 */
export function enqueue(queue: readonly TakeoverEvent[], events: readonly TakeoverEvent[]): TakeoverEvent[] {
  let next = [...queue];
  for (const e of events) {
    if (e.mode === 'alert' && !next.some((q) => q.key === e.key)) {
      // Good news never stands in an alert's way: a showing one yields, waiting ones queue behind it.
      const at = next.findIndex((q) => q.mode === 'landed');
      if (at === 0) {
        next[0] = e;
        continue;
      }
      if (at > 0) {
        next.splice(at, 0, e);
        continue;
      }
    }
    if (e.mode === 'recovery') {
      const at = next.findIndex((q) => q.mode === 'alert' && q.incident.id === e.incident.id);
      if (at >= 0) {
        next[at] = e;
        continue;
      }
    }
    if (next.some((q) => q.key === e.key)) continue;
    next.push(e);
  }
  if (next.length > MAX_QUEUE) next = [next[0], ...next.slice(next.length - (MAX_QUEUE - 1))];
  return next;
}

/** How long each mode stays up by itself (PRD 8.1: 45 s, recovery 10 s; good news 15 s, P2-W06). */
export const TAKEOVER_MS: Record<TakeoverMode, number> = {
  alert: 45_000,
  recovery: 10_000,
  landed: 15_000,
};

// ─── The tab's feed (P1-A01) ─────────────────────────────────────────────────

/** What the feed watches: the app store satisfies it (structural, so this file stays React-free). */
export interface IncidentSource {
  getState(): { snapshot: { incidents: readonly Incident[] } | null; source?: string };
  subscribe(listener: () => void): () => void;
}

/** A takeover the tab saw while no stage was listening, and when it saw it (epoch ms). */
export interface PendingTakeover {
  event: TakeoverEvent;
  seenAt: number;
}

/** How long a takeover seen off stage is still worth landing when the stage opens: an alert's own 45 s. */
export const LATE_ENTRY_MS = TAKEOVER_MS.alert;

/**
 * Adds events to the waiting list with the time they were seen; the same rules as `enqueue` (a recovery
 * replaces its incident's waiting alert in place, a key waits once).
 */
export function addPending(pending: readonly PendingTakeover[], events: readonly TakeoverEvent[], at: number): PendingTakeover[] {
  const next = [...pending];
  for (const event of events) {
    if (event.mode === 'recovery') {
      const i = next.findIndex((p) => p.event.mode === 'alert' && p.event.incident.id === event.incident.id);
      if (i >= 0) {
        next[i] = { event, seenAt: at };
        continue;
      }
    }
    if (next.some((p) => p.event.key === event.key)) continue;
    next.push({ event, seenAt: at });
  }
  return next;
}

/** The waiting takeovers still fresh at `now` (seen at most `windowMs` ago), in the order they were seen. */
export function freshPending(pending: readonly PendingTakeover[], now: number, windowMs = LATE_ENTRY_MS): TakeoverEvent[] {
  return pending.filter((p) => now - p.seenAt <= windowMs).map((p) => p.event);
}

export interface TakeoverFeed {
  /**
   * The stage listens: it is handed every takeover seen in the last 45 s at once (if any), then each new one
   * as the tab sees it. While nobody listens, takeovers wait (and age out).
   */
  subscribe(listener: (events: TakeoverEvent[]) => void): () => void;
}

function createFeed(source: IncidentSource, now: () => number): TakeoverFeed {
  let tracker = createTracker();
  let lastList: readonly Incident[] | null | undefined;
  let lastSource: string | undefined;
  let pending: PendingTakeover[] = [];
  const listeners = new Set<(events: TakeoverEvent[]) => void>();

  const observe = () => {
    const state = source.getState();
    if (state.source !== lastSource) {
      // A new data source is a new baseline (see the header).
      if (lastSource !== undefined) {
        tracker = createTracker();
        pending = [];
        lastList = undefined;
      }
      lastSource = state.source;
    }
    const list = state.snapshot?.incidents ?? null;
    if (list === lastList) return;
    lastList = list;
    // Good news is always tracked here (P2-W06); the stage drops a 'landed' card unless landing is allowed
    // (WhatIf/landing.ts landedAllowed), so an id seen while it was not allowed never lands later either.
    const events = observeIncidents(tracker, list, { landed: true });
    if (events.length === 0) return;
    if (listeners.size > 0) for (const listener of [...listeners]) listener(events);
    else pending = addPending(pending, events, now());
  };

  observe();
  source.subscribe(observe); // for the store's lifetime: one feed per store, never torn down

  return {
    subscribe(listener) {
      observe();
      const fresh = freshPending(pending, now());
      pending = [];
      listeners.add(listener);
      if (fresh.length > 0) listener(fresh);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const feeds = new WeakMap<IncidentSource, TakeoverFeed>();

/**
 * The one feed for this store, started on first use: by the shell at mount (so the baseline is the first
 * snapshot the tab saw), or by the stage itself where no shell runs (a unit test, the dev gallery).
 */
export function takeoverFeed(source: IncidentSource, now: () => number = Date.now): TakeoverFeed {
  let feed = feeds.get(source);
  if (!feed) {
    feed = createFeed(source, now);
    feeds.set(source, feed);
  }
  return feed;
}
