// src/story/beats.ts — THE beat table for Story mode (PRD 8.9, SPEC 13 / 15 / 17, DESIGN_BRIEF §8).
//
// One table, three outputs, so they can never disagree:
//   · demo/sample/story.json   the in-app loop (`?story=1`, key Y), played by the tour engine
//   · VIDEO_SCRIPT.md          the narration, numbered, with target windows (src/story/render.ts)
//   · demo/sample/captions.srt the captions, to the second (src/story/render.ts); video/captions.srt is the
//                              filed v1 video's copy and changes only when that video is re-cut
// `scripts/story.ts` writes all three; tests/unit/story-*.test.ts refuse a stale file.
//
// Rules this module enforces by construction:
//   · caption WORDING comes from src/copy/en.ts (`story.captions.*`, SPEC 17's canonical lines) through
//     `tLines` — never retyped here;
//   · every NUMBER in a caption is formatted from the fixture at generation time with the same functions
//     the screen uses (core/format, the incident card's model), never typed;
//   · a beat's `actions` are the fixture's own script steps (or its own commit record), picked by what
//     they are, not by position, so a re-generated tour or a recorded replay yields the same story.
//
// Pure: no DOM, no React, no file system. `scripts/story.ts` runs it under tsx; the tests import it.

import type { Commit, DeliveryLog, Headline, Incident, StoryBeat, StoryCallout, StoryDoc, StoryView, TourDoc, TourStep } from '../../core/types.ts';
import { fmtDollars, fmtDuration, fmtPct, footMoney } from '../../core/format.ts';
import { incidentReadings } from '../../core/incidents.ts';
import { impactFigures, shortHash } from '../components/IncidentCard/model.ts';
import { tLines, type LinesKey } from '../copy/en.ts';
import { storyFlowGroup } from './select.ts';

// ─── Callout ids (DESIGN_BRIEF §8) ───────────────────────────────────────────

export const CALLOUT_IDS = [
  'whp',
  'paid',
  'saved',
  'change-marker',
  'commit',
  'author',
  'per-day',
  'slack-message',
  'receipt-total',
  'qr',
  // The dollar map (P2-W11): a ribbon's $ / day plate and the "$ saved" plate on its hatched wedge (named by the
  // story's FlowStage on the map's own elements).
  'flow-plate',
  'flow-saved',
] as const;
export type CalloutId = (typeof CALLOUT_IDS)[number];

/**
 * The `data-callout` ids each Story view puts on screen (the stage components in src/views/Story render
 * exactly these; the e2e spec checks every beat's targets are visible). A beat may only point at ids its
 * view carries — tests/unit/story-beats.test.ts holds the table to it.
 */
export const VIEW_CALLOUTS: Readonly<Record<StoryView, readonly CalloutId[]>> = {
  title: [],
  presenter: ['saved', 'per-day', 'commit', 'author'],
  how: [],
  receipt: ['saved', 'whp', 'paid'],
  flow: ['flow-plate', 'flow-saved'],
  ledger: ['change-marker'],
  slack: ['slack-message'],
  'receipt-weekly': ['receipt-total'],
  summary: [],
  ask: ['qr'],
};

// ─── What the story is made of, found in the fixture ─────────────────────────

/** The moments of the fixture the story tells, found by what they are (not by index). */
export interface StoryMoments {
  /** The regression that names a commit — the alert with a name on it. */
  incident: Incident;
  /** The full commit record behind it (files, deploy time), as the change timeline holds it. */
  commit: Commit;
  /** The fixture's steps that open it: the sweep's snapshot (same second), the open, its first delivery. */
  opened: TourStep[];
  /** The steps that restore it: the revert commit(s), the close, the closing delivery. */
  restored: TourStep[];
  /** The base snapshot's headline (what the Meter beat reads). */
  headline: Headline;
  /** What the dollar map's group saves a day (the flow beat), when the fixture has priced flows. */
  flowSavedPerDayM?: number;
}

function isRegressionWithCommit(step: TourStep): boolean {
  if (step.action !== 'incident.open') return false;
  const p = step.payload as Partial<Incident> | null;
  return !!p && p.type === 'regression' && !!p.commit;
}

function deliveryFor(step: TourStep, incidentId: string, event: DeliveryLog['event']): boolean {
  if (step.action !== 'delivery') return false;
  const p = step.payload as Partial<DeliveryLog> | null;
  return !!p && p.incidentId === incidentId && p.event === event;
}

/** Finds the story in a tour (or replay) fixture. Throws with a plain reason when a moment is missing. */
export function storyMoments(doc: Pick<TourDoc, 'script' | 'snapshot' | 'timeline'>): StoryMoments {
  const script = doc.script.map((s, i) => ({ s, i })).sort((a, b) => a.s.at - b.s.at || a.i - b.i).map((x) => x.s);
  const openStep = script.find(isRegressionWithCommit);
  if (!openStep) throw new Error('story: the fixture has no regression that names a commit');
  const incident = openStep.payload as Incident;
  const named = incident.commit;
  if (!named) throw new Error('story: the regression names no commit');

  const sweep = script.find((s) => s.action === 'snapshot' && s.at === openStep.at);
  const firstDelivery = script.find((s) => s.at >= openStep.at && deliveryFor(s, incident.id, 'incident.opened'));
  if (!firstDelivery) throw new Error(`story: incident ${incident.id} has no delivery`);
  const closeStep = script.find((s) => s.action === 'incident.close' && (s.payload as Incident | null)?.id === incident.id);
  if (!closeStep) throw new Error(`story: incident ${incident.id} never closes`);
  const closeDelivery = script.find((s) => s.at >= closeStep.at && deliveryFor(s, incident.id, 'incident.closed'));
  const reverts = script.filter((s) => s.action === 'commit' && s.at > openStep.at && s.at <= closeStep.at);

  const commit =
    doc.snapshot.timeline.find((c) => c.hash === named.hash) ??
    doc.timeline.find((c) => c.hash === named.hash) ??
    ({
      hash: named.hash,
      message: named.message,
      author: named.author,
      committedAt: named.committedAt,
      ...(named.deployedAt ? { deployedAt: named.deployedAt } : {}),
      groupId: named.groupId,
      files: [],
      source: 'api',
    } satisfies Commit);

  return {
    incident,
    commit,
    opened: [sweep, openStep, firstDelivery].filter((s): s is TourStep => s !== undefined),
    restored: [...reverts, closeStep, ...(closeDelivery ? [closeDelivery] : [])],
    headline: doc.snapshot.headline,
    ...(() => {
      const group = storyFlowGroup(doc.snapshot);
      return group ? { flowSavedPerDayM: group.savedPerDayM } : {};
    })(),
  };
}

// ─── The numbers a caption may say ───────────────────────────────────────────

/** Every caption variable, formatted exactly as the screen formats it. */
export interface StoryFacts {
  [name: string]: string;
  /** Meter beat: the base snapshot's month to date (ReceiptBar + Meter) */
  whp: string;
  paid: string;
  saved: string;
  /** Alert beat: the takeover card's figures */
  points: string;
  hash: string;
  user: string;
  perDay: string;
  perYear: string;
  caughtIn: string;
  /** Flow beat: the dollar map's group, saved a day */
  flowSaved: string;
}

/** Integer percent exactly as `fmtPct` prints it ('75%' → 75). */
function pctOf(ratio: number): number {
  return Number.parseInt(fmtPct(ratio).replace('−', '-'), 10);
}

export function storyFacts(m: StoryMoments): StoryFacts {
  const h = m.headline;
  const i = m.incident;
  const { perDay, perYear } = impactFigures(i);
  const readings = incidentReadings(i);
  // The meter beat's three figures add up in whole dollars, as the report card prints them (core/format.ts
  // footMoney): would have paid and saved as the Meter and the bar show them, paid their difference.
  const shown = footMoney({ whpM: h.whpMtdM, paidM: h.paidMtdM, savedM: h.mtdM });
  return {
    whp: fmtDollars(shown.whpM),
    paid: fmtDollars(shown.paidM),
    saved: fmtDollars(shown.savedM),
    // The drop the card shows: its two integer percentages, subtracted (75% → 50% is 25 points).
    points: String(Math.abs(pctOf(readings.before) - pctOf(readings.after ?? readings.before))),
    hash: shortHash(i.commit?.hash ?? ''),
    user: i.commit?.author ?? '',
    perDay,
    perYear,
    caughtIn: fmtDuration(i.caughtInSec ?? 0),
    flowSaved: fmtDollars(m.flowSavedPerDayM ?? 0),
  };
}

// ─── The beat table ──────────────────────────────────────────────────────────

/** Positions steps at seconds within their beat (the engine plays them compressed into it). */
function at(sec: number, steps: readonly TourStep[]): TourStep[] {
  return steps.map((s) => ({ at: sec, action: s.action, payload: s.payload }));
}

export interface BeatDef {
  id: string;
  seconds: number;
  view: StoryView;
  /** Caption copy (src/copy/en.ts). None: the view carries its own words (title card, summary). */
  caption?: LinesKey;
  /**
   * Label + leader line onto a `data-callout` element (PRD 15.3a: plain words, in the caption face).
   * NOTE: these labels are user-facing strings kept here because SPEC 15 makes them story.json data;
   * they belong in src/copy/en.ts (`story.callouts.*`) once that file's owner adds the section.
   */
  callouts: readonly (StoryCallout & { target: CalloutId })[];
  actions?: (m: StoryMoments) => TourStep[];
}

/**
 * ≈ 90 s, the cut the video uses (PRD 8.9 / 15): title → hook → how it works → the dollar map → the Meter → a change
 * ships → watching → the alert → Slack → Restore → the receipt → summary → the ask, then loop.
 */
export const BEATS: readonly BeatDef[] = [
  { id: 'title', seconds: 4, view: 'title', callouts: [] },
  { id: 'hook', seconds: 5, view: 'presenter', caption: 'story.captions.hook', callouts: [] },
  // The strip says how in three seconds; the dollar map shows it (P2-W11: the one picture that answers "isn't
  // this just Insights?" — the same map, priced at each destination, with what the pipeline removed hatched in).
  { id: 'how', seconds: 3, view: 'how', caption: 'story.captions.howItWorks', callouts: [] },
  {
    id: 'flow',
    seconds: 7,
    view: 'flow',
    caption: 'story.captions.flow',
    callouts: [
      { target: 'flow-plate', label: 'priced at the destination', at: 0.6 },
      { target: 'flow-saved', label: 'what the pipeline removed', at: 3.9 },
    ],
  },
  {
    id: 'meter',
    seconds: 8,
    view: 'receipt',
    caption: 'story.captions.meter',
    callouts: [
      { target: 'whp', label: 'would have paid', at: 0.4 },
      { target: 'paid', label: 'you paid', at: 1.6 },
      { target: 'saved', label: 'saved by Cribl', at: 4 },
    ],
  },
  {
    id: 'change',
    seconds: 6,
    view: 'ledger',
    caption: 'story.captions.change',
    callouts: [{ target: 'change-marker', label: 'the change', at: 1.4 }],
    actions: (m) => [{ at: 0.8, action: 'commit', payload: m.commit }],
  },
  {
    id: 'watching',
    seconds: 10,
    view: 'ledger',
    caption: 'story.captions.watching',
    callouts: [{ target: 'change-marker', label: 'the change', at: 0 }],
  },
  {
    id: 'alert',
    seconds: 12,
    view: 'presenter',
    caption: 'story.captions.alert',
    callouts: [
      { target: 'commit', label: 'the commit', at: 4 },
      { target: 'author', label: 'who deployed it', at: 4.4 },
      { target: 'per-day', label: '$ per day', at: 8 },
    ],
    // The sweep, the open and its delivery land together: the card arrives already "Sent to Slack ✓",
    // so its "Caught in" reads the measured number the caption says (a live clock would count from
    // the deploy, minutes earlier in fixture time).
    actions: (m) => at(0.4, m.opened),
  },
  {
    id: 'slack',
    seconds: 6,
    view: 'slack',
    caption: 'story.captions.slack',
    callouts: [{ target: 'slack-message', label: 'the Slack alert', at: 0.6 }],
  },
  {
    id: 'restore',
    seconds: 8,
    view: 'presenter',
    caption: 'story.captions.restore',
    callouts: [],
    actions: (m) => {
      const commits = m.restored.filter((s) => s.action === 'commit');
      const rest = m.restored.filter((s) => s.action !== 'commit');
      // The red card is still up as the line starts; it turns green as the viewer reads it.
      return [...at(0.3, commits), ...at(2.4, rest)];
    },
  },
  {
    id: 'receipt',
    seconds: 8,
    view: 'receipt-weekly',
    caption: 'story.captions.receipt',
    // After the receipt has printed, its total last (P2-W12: src/views/Story/stages.tsx PRINT_START / PRINT_STEP).
    callouts: [{ target: 'receipt-total', label: 'saved last week', at: 4.6 }],
  },
  { id: 'summary', seconds: 6, view: 'summary', callouts: [] },
  {
    id: 'ask',
    seconds: 8,
    view: 'ask',
    caption: 'story.captions.ask',
    callouts: [{ target: 'qr', label: 'scan for Meter Reader', at: 0.8 }],
  },
];

/** A caption line never carries more than this many words (SPEC 15, PRD 15.3a). */
export const MAX_CAPTION_WORDS = 12;
/** Nor is it on screen for less than this (PRD 15.3a). */
export const MIN_LINE_SECONDS = 2.5;
/** Up to three caption lines per beat, shown in sequence. */
export const MAX_LINES_PER_BEAT = 3;

/** Words as a viewer reads them: punctuation-only tokens ('·', '—') do not count. */
export function wordCount(line: string): number {
  return line.split(/\s+/).filter((w) => /[\p{L}\p{N}$]/u.test(w)).length;
}

// ─── Building the document ───────────────────────────────────────────────────

export type StorySource = StoryDoc['source'];

/** The story document for a fixture: captions formatted from its numbers, actions picked from its script. */
export function buildStoryDoc(fixture: Pick<TourDoc, 'script' | 'snapshot' | 'timeline'>, source: StorySource, beats: readonly BeatDef[] = BEATS): StoryDoc {
  const moments = storyMoments(fixture);
  const facts = storyFacts(moments);
  return {
    schemaVersion: 1,
    source,
    loop: true,
    beats: beats.map((b): StoryBeat => {
      const lines = b.caption ? tLines(b.caption, facts) : [];
      return {
        id: b.id,
        seconds: b.seconds,
        view: b.view,
        caption: lines.length === 1 ? lines[0] : lines,
        callouts: b.callouts.map((c) => ({ target: c.target, label: c.label, ...(c.at !== undefined ? { at: c.at } : {}) })),
        actions: b.actions ? b.actions(moments) : [],
      };
    }),
  };
}

/**
 * story.json on disk: one compact line per beat (actions last), so the beat list and its captions read
 * at a glance while the bulky snapshot payloads stay on their own lines.
 */
export function serializeStory(doc: StoryDoc): string {
  const beats = doc.beats.map((b) => {
    const ordered = { id: b.id, seconds: b.seconds, view: b.view, caption: b.caption, callouts: b.callouts, actions: b.actions };
    return `    ${JSON.stringify(ordered)}`;
  });
  return `{\n  "schemaVersion": ${doc.schemaVersion},\n  "source": ${JSON.stringify(doc.source)},\n  "loop": ${doc.loop},\n  "beats": [\n${beats.join(',\n')}\n  ]\n}\n`;
}

/** Where the generated documents live, relative to the repository root. */
export const STORY_PATHS = {
  tour: 'demo/sample/tour.json',
  replay: 'demo/sample/replay.json',
  story: 'demo/sample/story.json',
  storyLive: 'demo/sample/story-live.json',
  videoScript: 'VIDEO_SCRIPT.md',
  captions: 'demo/sample/captions.srt',
} as const;
