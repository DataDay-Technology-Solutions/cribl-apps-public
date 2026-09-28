// src/story/render.ts — the video's two text outputs, rendered from the story document (pure):
//
//   captionsSrt(doc)            demo/sample/captions.srt — one cue per caption line, the exact in-app windows
//   videoScript(doc, context)   VIDEO_SCRIPT.md — the narration as numbered lines with target windows,
//                               the beat sheet, the title and end cards, and the short cut
//
// Both come from the same beats the app plays (src/story/beats.ts → story.json), so the burned-in
// captions, the narration and the loop agree to the second. scripts/story.ts writes them; the unit
// tests hold the committed files equal to this output.

import type { Commit, DeliveryLog, StoryDoc, StoryView, TourStep } from '../../core/types.ts';
import { CREDIT_STRINGS, t, tLines } from '../copy/en.ts';
import { wordCount, type StoryFacts } from './beats.ts';
import { beatStarts, captionLines, captionWindows, storySeconds } from './timeline.ts';

// ─── Time formats ────────────────────────────────────────────────────────────

/** 00:01:04,500 */
export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

/** 1:04.5 (tenths only when needed) */
export function clockTime(sec: number): string {
  const tenths = Math.max(0, Math.round(sec * 10));
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  const d = tenths % 10;
  return `${m}:${String(s).padStart(2, '0')}${d ? `.${d}` : ''}`;
}

// ─── captions.srt ────────────────────────────────────────────────────────────

/** Subtitle line length a viewer reads comfortably (broadcast practice: ≤ 42 characters, ≤ 2 lines). */
export const SRT_LINE_CHARS = 42;

/**
 * Splits a caption into at most two balanced lines of ≤ 42 characters where it can. A no-break space is kept, so a
 * name the copy holds together ("Steve Koelpin") never parts across the two lines.
 */
export function wrapCaption(text: string, max = SRT_LINE_CHARS): string[] {
  const clean = text.replace(/[ \t\r\n]+/g, ' ').trim();
  if (clean.length <= max) return [clean];
  const words = clean.split(' ');
  let best: [string, string] = [clean, ''];
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    // Over-long halves cost the most; then prefer balance, a break at a sentence or clause end, and
    // never part a number from its unit ("25 / points").
    const over = Math.max(0, a.length - max) + Math.max(0, b.length - max);
    const pause = /[.?!]$/.test(a) ? 24 : /[,:;·—]$/.test(a) ? 10 : 0;
    const split = /\d$/.test(a) ? 15 : 0;
    const score = over * 1000 + Math.abs(a.length - b.length) - pause + split;
    if (score < bestScore) {
      bestScore = score;
      best = [a, b];
    }
  }
  return best;
}

export function captionsSrt(doc: StoryDoc): string {
  return `${captionWindows(doc)
    .map((w) => `${w.cue}\n${srtTime(w.start)} --> ${srtTime(w.end)}\n${wrapCaption(w.text).join('\n')}\n`)
    .join('\n')}`;
}

// ─── VIDEO_SCRIPT.md ─────────────────────────────────────────────────────────

/** What each beat shows (documentation for the editor; the app draws it from the view). */
const ON_SCREEN: Readonly<Record<string, string>> = {
  title: 'Title card: the one-line description of the App',
  hook: "The presenter view: Saved by Cribl as the annualized run rate, with what's saving the most",
  how: 'The four-step "How it works" strip, lighting step by step',
  flow: "The dollar map of the largest worker group: sources → pipelines → destinations, each ribbon priced at its destination, the pipeline's cut hatched in green",
  meter: 'The Meter with the receipt bar: would have paid, paid, saved',
  change: 'The savings-ratio chart of the changed pipeline; the commit diamond lands',
  watching: "The pipeline's savings ratio, minute by minute, bending down after the change; the shaded loss named in $ a day",
  alert: 'The incident card slides up under the presenter figure: before → after, $ a day and a year, the commit and who deployed it, caught in',
  slack: 'The Slack message the alert sent (Block Kit, as delivered)',
  restore: 'The same card, green, under the presenter figure: recovered, savings back, closed itself',
  receipt: "Monday's receipt in Slack: monospace lines with dot leaders, the total",
  summary: 'Four-line summary',
  ask: 'Saved by Cribl once more (the annualized figure the hook opened on) over the QR with the repository address; the ask',
};

const VIEW_NAMES: Readonly<Record<StoryView, string>> = {
  title: 'title',
  receipt: 'receipt',
  presenter: 'presenter',
  flow: 'flow',
  ledger: 'ledger',
  slack: 'slack',
  'receipt-weekly': 'weekly receipt',
  summary: 'summary',
  ask: 'ask',
  how: 'how it works',
};

function describeStep(step: TourStep): string {
  switch (step.action) {
    case 'snapshot':
      return 'the sweep lands';
    case 'incident.open':
      return 'the alert opens';
    case 'incident.close':
      return 'the alert closes itself';
    case 'delivery': {
      const d = step.payload as Partial<DeliveryLog> | null;
      return d?.event === 'incident.closed' ? 'the recovery is delivered' : 'the Slack delivery lands';
    }
    case 'commit': {
      const c = step.payload as Partial<Commit> | null;
      return `commit \`${(c?.hash ?? '').slice(0, 7)}\` lands`;
    }
    default:
      return step.action;
  }
}

const cell = (s: string): string => s.replace(/\|/g, '\\|');

export interface VideoScriptContext {
  facts: StoryFacts;
  /** repository-relative path of the fixture the numbers came from */
  fixturePath: string;
  /** beats the short cut drops (PRD 15: "the 60-second cut drops beats 1 and 4" = how it works, watching) */
  shortCutDrops?: readonly string[];
}

export const SHORT_CUT_DROPS: readonly string[] = ['how', 'watching'];

export function videoScript(doc: StoryDoc, ctx: VideoScriptContext): string {
  const total = storySeconds(doc);
  const starts = beatStarts(doc);
  const windows = captionWindows(doc);
  const drops = new Set(ctx.shortCutDrops ?? SHORT_CUT_DROPS);
  const out: string[] = [];

  out.push('# VIDEO_SCRIPT.md — Meter Reader, the 90-second and 60-second cuts');
  out.push('');
  out.push(
    '_Generated by `npx tsx scripts/story.ts` from the Story mode beat table (`src/story/beats.ts`). Do not edit by hand. ' +
      'The in-app loop (`?story=1`, key `Y`), this script and `demo/sample/captions.srt` come from that one table, so those three ' +
      'cannot disagree. The produced video is edited from captures of the App, not generated from this table (see "The produced video" ' +
      `at the end). Every number below is formatted from \`${ctx.fixturePath}\` at generation time._`,
  );
  out.push('');
  out.push(`- **Length:** ${clockTime(total)} per pass (${doc.beats.length} beats); the App loops it until any key.`);
  out.push(
    `- **Source:** \`${ctx.fixturePath}\` (${doc.source === 'tour' ? 'the sample enterprise workspace, marked by the Sample data chip' : 'the recorded run from the demo org'}).`,
  );
  out.push(
    '- **Capture:** Playwright at 1920 × 1080, dark theme, `/?story=1`, cursor hidden. `beatAt(t)` (`src/story/doc.ts`) says which beat, caption line and callouts are on screen at any second.',
  );
  out.push('- **Captions:** bottom-center, the UI face, sentence case; the same lines the App shows, at the same seconds.');
  out.push('');

  out.push(`## Title card (${clockTime(0)}–${clockTime(doc.beats[0]?.seconds ?? 0)})`);
  out.push('');
  out.push(`> ${t('story.title')}`);
  out.push('>');
  out.push(`> ${t('credit.storyTitle', { name: CREDIT_STRINGS.builder })}`);
  out.push('');

  out.push('## Narration');
  out.push('');
  out.push('Numbered lines with their target windows. The voice reads exactly these lines; the burned-in captions are the same text.');
  out.push('');
  out.push('| # | Window | Beat | Line | Words |');
  out.push('|---|---|---|---|---|');
  for (const w of windows) {
    out.push(`| ${w.cue} | ${clockTime(w.start)}–${clockTime(w.end)} | ${w.beatId} | ${cell(w.text)} | ${wordCount(w.text)} |`);
  }
  out.push('');

  out.push('## Beats');
  out.push('');
  out.push('A callout is a label with a leader line onto the element named; it appears at its second and stays while the caption line it arrived with is on screen.');
  out.push('');
  out.push('| Beat | Window | Seconds | View | On screen | Callouts (label → element) | What happens |');
  out.push('|---|---|---|---|---|---|---|');
  doc.beats.forEach((b, i) => {
    const callouts = b.callouts.length
      ? b.callouts.map((c) => `"${cell(c.label)}" → \`${c.target}\` at +${clockTime(c.at ?? 0)}`).join('; ')
      : '—';
    const actions = b.actions.length ? b.actions.map((a) => `+${clockTime(a.at)} ${describeStep(a)}`).join('; ') : '—';
    const lines = captionLines(b);
    const shown = ON_SCREEN[b.id] ?? VIEW_NAMES[b.view];
    out.push(
      `| ${b.id} | ${clockTime(starts[i])}–${clockTime(starts[i] + b.seconds)} | ${b.seconds} | ${VIEW_NAMES[b.view]} | ${cell(shown)}${lines.length ? '' : ' (no caption: the screen carries the words)'} | ${callouts} | ${actions} |`,
    );
  });
  out.push('');

  const summaryIndex = doc.beats.findIndex((b) => b.view === 'summary');
  const summaryStart = summaryIndex >= 0 ? starts[summaryIndex] : total;
  out.push(`## End card (${clockTime(summaryStart)}–${clockTime(total)})`);
  out.push('');
  out.push('The four-line summary, then the ask with the QR:');
  out.push('');
  out.push(`- ${t('story.summary.line1')}`);
  out.push(`- ${t('story.summary.line2', { caughtIn: ctx.facts.caughtIn })}`);
  out.push(`- ${t('story.summary.line3')}`);
  out.push(`- ${t('story.summary.line4')}`);
  out.push('');
  out.push(`> ${tLines('story.captions.ask').join(' ')} (QR → the repository)`);
  out.push('');

  // The short cut: the same beats minus the dropped ones, re-timed end to end.
  const kept = doc.beats.filter((b) => !drops.has(b.id));
  const shortDoc: StoryDoc = { ...doc, beats: kept };
  const shortTotal = storySeconds(shortDoc);
  out.push('## The short cut');
  out.push('');
  out.push(
    `PRD 15: the tighter cut drops ${[...drops].map((d) => `"${d}"`).join(' and ')}. From this table that runs **${clockTime(shortTotal)}**, not 60 s: ` +
      'trim further in the edit (the title and summary cards are the first candidates) rather than shortening a caption below 2.5 s.',
  );
  out.push('');
  out.push('| # | Window | Beat | Line |');
  out.push('|---|---|---|---|');
  for (const w of captionWindows(shortDoc)) out.push(`| ${w.cue} | ${clockTime(w.start)}–${clockTime(w.end)} | ${w.beatId} | ${cell(w.text)} |`);
  out.push('');

  out.push('## Facts used in the captions');
  out.push('');
  out.push('| Name | Value |');
  out.push('|---|---|');
  for (const [k, v] of Object.entries(ctx.facts)) out.push(`| ${k} | ${cell(v)} |`);
  out.push('');

  // The rendered cut (EPIC_AUDIT P1-N03): the filed video is an edit, so this script says where it differs.
  out.push('## The produced video');
  out.push('');
  out.push(
    'The filed video (`video/README.md`, built by `video/production/BUILD.md`) is edited from captures of the App, so its windows, ' +
      'its narration and its length are its own, not the seconds above. The first filed cut (v1, 87.9 s on YouTube) plays the beats of ' +
      'this loop as hard cuts between a title card, a live-proof card and an end card, times each beat to its voice-over, and adds one ' +
      'narration line this script does not have: the live-proof card\'s "Recorded live in Cribl Cloud: a real commit, caught in one ' +
      'minute fifty-five, with a name on it." (run 7 of `docs/LIVE_VALIDATION.md`). A later cut is storyboarded on its own. What the loop ' +
      'shows, this script and `demo/sample/captions.srt` stay in step; `video/captions.srt` is the filed cut\'s own copy.',
  );
  out.push('');
  return `${out.join('\n')}`;
}
