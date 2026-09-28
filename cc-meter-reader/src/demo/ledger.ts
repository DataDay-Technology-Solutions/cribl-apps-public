// src/demo/ledger.ts — the Demo Console's lever ledger (EPIC_AUDIT P2-W18, day-2 slice): the last five levers
// pulled, each a real commit with its id, who pulled it, whether it deployed, and — for the one that broke
// something — how fast Meter Reader caught it ("10:42 Break the trim · b3a6f5e · deployed · caught in 2:37").
// Pure; no I/O, no copy. DEMO BUILD ONLY.
//
// Sources, merged by commit hash (short or full, core/timeline.ts sameHash):
//   • the snapshot's change timeline — shared, so a lever pulled on the phone shows on the laptop; a lever's
//     own record (source 'demo') survives the version API's refresh with its author and deploy time;
//   • this tab's own lever results (src/demo/client.ts `recent`), so a lever shows the moment it lands
//     instead of after the next sweep writes the snapshot.
// Only commits whose message is one of the levers' own (core/demo/levers.ts) are levers; everything else in
// the timeline is somebody's configuration change and stays out.

import type { Commit, Incident } from '../../core/types.ts';
import { commitTimeMs, sameHash } from '../../core/timeline.ts';

/** How many levers the ledger lists. */
export const LEDGER_SIZE = 5;

export type LedgerLeverKind = 'applyPack' | 'revertPack' | 'breakTrim' | 'restoreTrim' | 'spike' | 'calm' | 'setRate' | 'resetAll';

export interface ParsedLever {
  kind: LedgerLeverKind;
  /** The route, pipeline or Source id the lever changed (absent for Reset everything). */
  target?: string;
  /** setRate: the new multiplier. */
  multiplier?: number;
}

/** The commit messages core/demo/levers.ts writes, one per lever. */
const MESSAGES: readonly [RegExp, (m: RegExpExecArray) => ParsedLever | undefined][] = [
  [/^demo: apply the pack on (\S+)$/, (m) => ({ kind: 'applyPack', target: m[1]! })],
  [/^demo: revert the pack on (\S+)$/, (m) => ({ kind: 'revertPack', target: m[1]! })],
  [/^demo: break the trim on (\S+)$/, (m) => ({ kind: 'breakTrim', target: m[1]! })],
  [/^demo: restore the trim on (\S+)$/, (m) => ({ kind: 'restoreTrim', target: m[1]! })],
  [
    /^demo: set (\S+) to (\d+(?:\.\d+)?)x$/,
    (m) => {
      const multiplier = Number(m[2]);
      if (!Number.isFinite(multiplier)) return undefined;
      const kind: LedgerLeverKind = multiplier > 1 ? 'spike' : multiplier === 1 ? 'calm' : 'setRate';
      return { kind, target: m[1]!, multiplier };
    },
  ],
  [/^demo: reset everything$/, () => ({ kind: 'resetAll' })],
];

/** The lever a commit message names, or undefined for any other commit. */
export function parseLeverMessage(message: string | undefined): ParsedLever | undefined {
  const text = (message ?? '').trim();
  for (const [re, build] of MESSAGES) {
    const m = re.exec(text);
    if (m) return build(m);
  }
  return undefined;
}

export interface LedgerEntry extends ParsedLever {
  /** The commit id as recorded (full or short). */
  hash: string;
  /** The first seven characters, as Cribl's UI shows commits. */
  short: string;
  /** When the lever went live: the deploy time, else the commit time (epoch ms). */
  atMs: number;
  /** Who pulled it, as recorded in the commit ("Steve Koelpin", or an API client id). */
  author: string;
  /** The deploy call returned (false: committed only). */
  deployed: boolean;
  /** Seconds from this commit to the alert that named it, when an incident names it. */
  caughtInSec?: number;
  /** That incident, when there is one. */
  incidentId?: string;
}

/** A record for the same commit from another source fills in what this one lacks (never overrides). */
function fill(a: Commit, b: Commit): Commit {
  const out: Commit = {
    ...a,
    hash: a.hash.length >= b.hash.length ? a.hash : b.hash,
    message: a.message || b.message,
    author: a.author && a.author !== 'unknown' ? a.author : b.author || a.author,
  };
  const deployedAt = a.deployedAt ?? b.deployedAt;
  if (deployedAt) out.deployedAt = deployedAt;
  return out;
}

/**
 * The last `limit` levers, newest first: the snapshot's timeline and this tab's own lever commits merged by
 * hash, keeping only lever commits, each matched to the incident that named it.
 */
export function leverLedger(
  timeline: readonly Commit[] | null | undefined,
  recent: readonly Commit[] | null | undefined,
  incidents: readonly Incident[] | null | undefined,
  limit = LEDGER_SIZE,
): LedgerEntry[] {
  const merged: Commit[] = [];
  for (const c of [...(timeline ?? []), ...(recent ?? [])]) {
    if (!c?.hash || !parseLeverMessage(c.message)) continue;
    const i = merged.findIndex((x) => sameHash(x.hash, c.hash));
    if (i >= 0) merged[i] = fill(merged[i]!, c);
    else merged.push(c);
  }
  const time = (c: Commit) => {
    const t = commitTimeMs(c);
    return Number.isFinite(t) ? t : 0;
  };
  merged.sort((a, b) => time(b) - time(a) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return merged.slice(0, Math.max(0, limit)).map((c) => {
    const parsed = parseLeverMessage(c.message)!;
    const entry: LedgerEntry = {
      ...parsed,
      hash: c.hash,
      short: c.hash.slice(0, 7),
      atMs: time(c),
      author: c.author || 'unknown',
      deployed: Boolean(c.deployedAt),
    };
    // The alert that names this commit (the detector's attribution, never a guess from timing). Good news that
    // names a lever (P2-W06: the pack it applied measured as projected) is not something that broke, so it is
    // never "caught".
    const named = (incidents ?? [])
      .filter((inc) => inc.type !== 'goodnews' && inc.commit && sameHash(inc.commit.hash, c.hash))
      .sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt))[0];
    if (named) {
      entry.incidentId = named.id;
      // The same measured figure the incident card and the takeover print beside it ("Caught in 2:22").
      if (named.caughtInSec !== undefined && Number.isFinite(named.caughtInSec)) entry.caughtInSec = Math.max(0, named.caughtInSec);
    }
    return entry;
  });
}
