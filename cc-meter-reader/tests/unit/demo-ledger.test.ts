// tests/unit/demo-ledger.test.ts — the Demo Console's lever ledger (EPIC_AUDIT P2-W18, day-2 slice): the last
// five levers, each a real commit with its id and author, merged from the shared timeline and this tab's own
// lever results, and the one an alert named carries "caught in".

import { describe, expect, it } from 'vitest';
import type { Commit, Incident } from '../../core/types.ts';
import { LEDGER_SIZE, leverLedger, parseLeverMessage } from '../../src/demo/ledger.ts';

const T0 = Date.UTC(2026, 8, 28, 15, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function commit(hash: string, message: string, atMs: number, extra: Partial<Commit> = {}): Commit {
  return {
    hash,
    message,
    author: 'Steve Koelpin',
    committedAt: iso(atMs - 2_000),
    deployedAt: iso(atMs),
    groupId: 'default',
    files: ['groups/default/conf/pipelines/mrd_pay_sample/conf.yml'],
    source: 'demo',
    ...extra,
  };
}

function incident(partial: Partial<Incident> = {}): Incident {
  return {
    id: 'i1',
    type: 'regression',
    severity: 'high',
    objectKey: 'pipe:default:mrd_pay_sample',
    label: 'Payments API sampling',
    openedAt: iso(T0 + 142_000),
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    caughtInSec: 142,
    notes: [],
    deliveries: [],
    ...partial,
  };
}

describe('parseLeverMessage', () => {
  it('reads every lever message core/demo/levers.ts writes', () => {
    expect(parseLeverMessage('demo: apply the pack on mrd_windows_workstations')).toEqual({ kind: 'applyPack', target: 'mrd_windows_workstations' });
    expect(parseLeverMessage('demo: revert the pack on mrd_rt_pan_firewall')).toEqual({ kind: 'revertPack', target: 'mrd_rt_pan_firewall' });
    expect(parseLeverMessage('demo: break the trim on mrd_pay_sample')).toEqual({ kind: 'breakTrim', target: 'mrd_pay_sample' });
    expect(parseLeverMessage('demo: restore the trim on mrd_pay_sample')).toEqual({ kind: 'restoreTrim', target: 'mrd_pay_sample' });
    expect(parseLeverMessage('demo: set mrd_payments_api to 5x')).toEqual({ kind: 'spike', target: 'mrd_payments_api', multiplier: 5 });
    expect(parseLeverMessage('demo: set mrd_payments_api to 1x')).toEqual({ kind: 'calm', target: 'mrd_payments_api', multiplier: 1 });
    expect(parseLeverMessage('demo: set mrd_payments_api to 0.5x')).toEqual({ kind: 'setRate', target: 'mrd_payments_api', multiplier: 0.5 });
    expect(parseLeverMessage('demo: reset everything')).toEqual({ kind: 'resetAll' });
  });

  it('is not a lever: anyone else’s commit, an empty message', () => {
    expect(parseLeverMessage('Update routes for the new SIEM')).toBeUndefined();
    expect(parseLeverMessage('demo: rig apply')).toBeUndefined();
    expect(parseLeverMessage('')).toBeUndefined();
    expect(parseLeverMessage(undefined)).toBeUndefined();
  });
});

describe('leverLedger', () => {
  it('lists the last five levers newest first, with short ids, and leaves other commits out', () => {
    const timeline = [
      commit('a'.repeat(40), 'demo: apply the pack on mrd_windows_workstations', T0 - 60_000),
      commit('b'.repeat(40), 'Update outputs', T0 - 50_000, { source: 'api', author: 'someone' }),
      commit('c'.repeat(40), 'demo: break the trim on mrd_pay_sample', T0),
      commit('d'.repeat(40), 'demo: set mrd_payments_api to 5x', T0 + 400_000),
      commit('e'.repeat(40), 'demo: set mrd_payments_api to 1x', T0 + 500_000),
      commit('f'.repeat(40), 'demo: restore the trim on mrd_pay_sample', T0 + 300_000),
      commit('0'.repeat(40), 'demo: reset everything', T0 + 600_000),
    ];
    const ledger = leverLedger(timeline, [], []);
    expect(ledger).toHaveLength(LEDGER_SIZE);
    expect(ledger.map((e) => e.kind)).toEqual(['resetAll', 'calm', 'spike', 'restoreTrim', 'breakTrim']);
    expect(ledger.map((e) => e.short)).toEqual(['0000000', 'eeeeeee', 'ddddddd', 'fffffff', 'ccccccc']);
    expect(ledger.every((e) => e.deployed)).toBe(true);
    expect(ledger[0]!.atMs).toBe(T0 + 600_000);
  });

  it("shows this tab's lever at once, before a sweep puts it in the snapshot, and never twice after", () => {
    const local = commit('1234567890abcdef1234567890abcdef12345678', 'demo: break the trim on mrd_pay_sample', T0);
    expect(leverLedger([], [local], []).map((e) => e.short)).toEqual(['1234567']);
    // The sweep's copy carries the short hash only and an API author: one entry, the full id kept, the member named.
    const swept = commit('1234567', 'demo: break the trim on mrd_pay_sample', T0, { author: 'unknown', deployedAt: undefined });
    delete (swept as Partial<Commit>).deployedAt;
    const ledger = leverLedger([swept], [local], []);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ hash: local.hash, short: '1234567', author: 'Steve Koelpin', deployed: true });
  });

  it('a lever the alert named carries caught in: the detector’s attribution, never a guess from timing', () => {
    const brk = commit('c'.repeat(40), 'demo: break the trim on mrd_pay_sample', T0);
    const pack = commit('a'.repeat(40), 'demo: apply the pack on mrd_windows_workstations', T0 - 40_000);
    const named = incident({ commit: { hash: 'ccccccc', message: brk.message, author: brk.author, committedAt: brk.committedAt, groupId: 'default', match: 'files' } });
    const ledger = leverLedger([brk, pack], [], [named]);
    expect(ledger[0]).toMatchObject({ kind: 'breakTrim', caughtInSec: 142, incidentId: 'i1' });
    expect(ledger[1]!.caughtInSec).toBeUndefined();
    // An incident with no commit named (a nearby change unmatched) attributes nothing.
    expect(leverLedger([brk], [], [incident()])[0]!.caughtInSec).toBeUndefined();
  });

  it('good news that names the pack commit (P2-W06) is not a catch: the pack apply carries no caught in', () => {
    const pack = commit('a'.repeat(40), 'demo: apply the pack on mrd_windows_workstations', T0 - 40_000);
    const good = incident({
      id: 'g1',
      type: 'goodnews',
      severity: 'info',
      closedAt: iso(T0 + 100_000),
      caughtInSec: 140,
      commit: { hash: 'aaaaaaa', message: pack.message, author: pack.author, committedAt: pack.committedAt, groupId: 'default', match: 'files' },
    });
    const [entry] = leverLedger([pack], [], [good]);
    expect(entry).toMatchObject({ kind: 'applyPack' });
    expect(entry!.caughtInSec).toBeUndefined();
    expect(entry!.incidentId).toBeUndefined();
  });

  it('a commit without a deploy time reads as committed', () => {
    const c = commit('9'.repeat(40), 'demo: revert the pack on mrd_vpc_flow', T0);
    delete (c as Partial<Commit>).deployedAt;
    expect(leverLedger([c], [], [])[0]).toMatchObject({ deployed: false, atMs: T0 - 2_000 });
  });

  it('nothing yet: an empty ledger', () => {
    expect(leverLedger(undefined, undefined, undefined)).toEqual([]);
    expect(leverLedger([], [], [])).toEqual([]);
  });
});
