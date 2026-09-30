// src/components/ChangeTimeline/money.ts — a commit's dollars, signed both ways (P2-W07): "+$1,340" / "−$1,250"
// (core/format prints the real minus sign; lib/format adds the plus).

import { largestImpact, type CommitImpact } from '../../../core/commitImpacts.ts';
import { flowObjectKeys } from '../../../core/flows.ts';
import { sameHash } from '../../../core/timeline.ts';
import type { FlowFigures, Incident } from '../../../core/types.ts';
import { t } from '../../copy/en.ts';
import { formatMoney } from '../../lib/format.ts';

export function signedMoney(milliCents: number): string {
  return formatMoney(milliCents, { signed: true });
}

/**
 * Whether a commit's price is its own (usefulness review, round 1): an alert names it, or the flows it touches moved
 * ('alert', 'flows'). A 'workspace' or 'daily' price is every flow's shift around the deploy: an unattributed shift,
 * never promoted to the Receipt's or the timeline's "largest priced change", never summed into the net, and never a
 * dollar figure paired with the author as a claim.
 */
export function isAttributed(i: Pick<CommitImpact, 'status' | 'basis'>): boolean {
  return i.status === 'priced' && (i.basis === 'alert' || i.basis === 'flows');
}

/** A priced commit whose figure is the whole workspace's shift, not its own (see isAttributed). */
export function isUnattributedShift(i: Pick<CommitImpact, 'status' | 'basis'>): boolean {
  return i.status === 'priced' && !isAttributed(i);
}

// ─── Drops that recovered, and the changes that undid them (usefulness review, round 2) ───────────────────────
//
// A commit priced from its alert keeps that alert's figure after the alert closes (D47: the drop it reports is the
// drop that happened). Once the alert has closed by recovering, that figure no longer runs per day: the Ledger's
// "Largest priced change" and the timeline's callout must not headline it, and the net of the priced changes must not
// add a loss that stopped (nor the revert that stopped it, priced on another basis: the tour's −$1,250 break and its
// +$1,013 revert once netted to −$237 while the alert said "recovered to 75%"). Both rows stay listed, each saying
// what happened ("Recovered at 6:44 PM, reverted by 9a9a4c6" / "Undid 22d0a5e").

/** A drop priced from its alert whose every alert closed by recovering. */
export interface Undone {
  /** when its last alert closed (epoch ms) */
  recoveredAt: number;
  /** the full hash of the later change that moved the same flows back, when one did */
  by?: string;
}

export interface Reversals {
  /** by full hash: drops that recovered */
  undone: ReadonlyMap<string, Undone>;
  /** by full hash: a change that undid an earlier drop → that drop's full hash */
  undoes: ReadonlyMap<string, string>;
}

export const NO_REVERSALS: Reversals = { undone: new Map(), undoes: new Map() };

/** The object keys a change's "what moved" lines can name for an alert's object: its own, and each flow through it. */
function movedKeysFor(objectKey: string, flows: readonly FlowFigures[]): Set<string> {
  const keys = new Set<string>([objectKey]);
  for (const f of flows) {
    const k = flowObjectKeys(f);
    if (k.input !== objectKey && k.route !== objectKey && k.pipeline !== objectKey) continue;
    keys.add(f.key);
    if (k.route) keys.add(k.route);
    if (k.pipeline) keys.add(k.pipeline);
  }
  return keys;
}

/**
 * Which alert-priced drops recovered, and which later change undid each: the first change after the drop, deployed
 * before its alert closed, whose own flows moved back up on the alert's object. An alert a member closed (accepted as
 * the new normal, muted, excluded) is not a recovery: that drop stands. Pure.
 */
export function reversals(impacts: readonly CommitImpact[], snapshot: { incidents?: readonly Incident[]; flows?: readonly FlowFigures[] } | null | undefined): Reversals {
  const incidents = snapshot?.incidents ?? [];
  const flows = snapshot?.flows ?? [];
  const undone = new Map<string, Undone>();
  const undoes = new Map<string, string>();
  const byTime = [...impacts].sort((a, b) => a.t - b.t);
  for (const a of byTime) {
    if (a.status !== 'priced' || a.basis !== 'alert' || !(a.perDayM < 0)) continue;
    const alerts = incidents.filter((inc) => inc.type === 'regression' && inc.commit && sameHash(inc.commit.hash, a.commit.hash));
    if (alerts.length === 0) continue;
    const closed = alerts.map((inc) => (inc.closedAt && !inc.closedReason ? Date.parse(inc.closedAt) : Number.NaN));
    if (!closed.every(Number.isFinite)) continue;
    const recoveredAt = Math.max(...closed);
    const keys = new Set(alerts.flatMap((inc) => [...movedKeysFor(inc.objectKey, flows)]));
    const by = byTime.find(
      (r) =>
        r !== a &&
        r.t > a.t &&
        r.t <= recoveredAt &&
        isAttributed(r) &&
        r.perDayM > 0 &&
        !undoes.has(r.commit.hash) &&
        r.moved.some((m) => keys.has(m.key) && (m.perDayM ?? m.delta) > 0),
    );
    undone.set(a.commit.hash, { recoveredAt, ...(by ? { by: by.commit.hash } : {}) });
    if (by) undoes.set(by.commit.hash, a.commit.hash);
  }
  return { undone, undoes };
}

/** A priced change that recovered or undid one: listed, never headlined, never in the net. */
export function isSettled(i: Pick<CommitImpact, 'commit'>, rev: Reversals): boolean {
  return rev.undone.has(i.commit.hash) || rev.undoes.has(i.commit.hash);
}

/**
 * The largest change priced on its own flows in [from, to] (the Receipt's trend and the Ledger's timeline name it),
 * leaving out a drop that recovered and the change that undid it (`rev`).
 */
export function largestAttributed(impacts: readonly CommitImpact[], domain: [number, number], rev: Reversals = NO_REVERSALS): CommitImpact | undefined {
  return largestImpact(
    impacts.filter((i) => isAttributed(i) && !isSettled(i, rev)),
    domain,
  );
}

/** "Mon 2:04 AM" in the display zone: when a change landed or recovered (the Changes list's meta, the commit card). */
export function changeWhen(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(ms);
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * "Recovered Mon 2:04 AM, reverted by c8b6350" / "Undid 22d0a5e" for a settled change, else undefined — the Changes
 * list's row and (founder-build r2 ui-13, BO-15) the commit card both print it.
 */
export function settledText(i: CommitImpact, rev: Reversals, tz: string): string | undefined {
  const short = (hash: string): string => hash.slice(0, 7);
  const undone = rev.undone.get(i.commit.hash);
  if (undone) {
    const time = changeWhen(undone.recoveredAt, tz);
    return undone.by ? t('ledger.timeline.changes.recoveredBy', { time, hash: short(undone.by) }) : t('ledger.timeline.changes.recovered', { time });
  }
  const undid = rev.undoes.get(i.commit.hash);
  return undid ? t('ledger.timeline.changes.undid', { hash: short(undid) }) : undefined;
}
