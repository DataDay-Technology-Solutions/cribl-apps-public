// Rules round (usefulness): "a savings drop arrives with a commit ID and a username" must name the commit that
// changed THIS route. Every route edit in Cribl rewrites the group's one pipelines/route.yml, so a commit's file list
// cannot say which route it changed; its version/show hunks can (core/timeline.ts routeTableEdits). On the live org a
// commit that reverted the pack on mrd_windows_workstations was credited to mrd_windows_dc as a "change to this
// route". Now a route-table commit is a change to a route only when its hunks show that route's entry changed.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Commit, CriblHttp, HttpResult } from '../../core/types.ts';
import { isGroupRouteTable, matchCommit, mergeCommits, routeEntryChanged, routeTableEdits } from '../../core/timeline.ts';
import { SHOW_DIFF_LINES, fetchCommits } from '../../core/adapters/version.ts';
import { objectContext } from '../../core/detector.ts';

const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/cribl/version-show-route-table.json'), 'utf8')) as {
  revertWorkstations: { hash: string; diffJson: unknown[] };
  applyPanPack: { hash: string; diffJson: unknown[] };
};
const TABLE = 'groups/default/local/cribl/pipelines/route.yml';

describe('routeTableEdits (the live hunks)', () => {
  it('names the entry a hunk edits by its name line when its id sits above the context (f727f09)', () => {
    expect(routeTableEdits(FIXTURE.revertWorkstations.diffJson)).toEqual({ ids: [], names: ['mrd_windows_workstations'] });
  });

  it("ignores top-level keys and the pack's own route table; names the route whose pipeline changed (5943ac6)", () => {
    const edits = routeTableEdits(FIXTURE.applyPanPack.diffJson);
    // The first hunk adds `groups: {}` and `comments: []` (top level, no route's) and shows mrd_windows_dc unchanged.
    expect(edits).toEqual({ ids: [], names: ['mrd_pan_firewall'] });
    expect(edits?.ids).not.toContain('default'); // the pack's `- id: default` is the pack's, not the group's
  });

  it('reads `- id:` entries, renames, filters, unresolved entries and too-big diffs', () => {
    const file = (lines: [string, string][], over: Record<string, unknown> = {}) => ({
      oldName: TABLE,
      newName: TABLE,
      addedLines: 1,
      deletedLines: 1,
      blocks: [{ header: '@@', lines: lines.map(([type, content]) => ({ type, content })) }],
      ...over,
    });
    // An entry named by its `- id:` line, one by a renamed name (both names kept), one only by its filter.
    expect(
      routeTableEdits([
        file([
          ['context', '   - id: r_a'],
          ['delete', '-    output: old'],
          ['insert', '+    output: new'],
          ['context', '   - id: r_b'],
          ['context', '     final: true'],
        ]),
      ]),
    ).toEqual({ ids: ['r_a'], names: [] });
    expect(
      routeTableEdits([
        file([
          ['delete', '-    name: Old name'],
          ['insert', '+    name: New name'],
          ['context', '     final: true'],
        ]),
      ]),
    ).toEqual({ ids: [], names: ['Old name', 'New name'] });
    expect(
      routeTableEdits([
        file([
          ['context', "     filter: __inputId=='syslog:in'"],
          ['context', '     clones: []'],
          ['delete', '-    output: a'],
          ['insert', '+    output: b'],
        ]),
      ]),
    ).toEqual({ ids: [], names: [], filters: ["__inputId=='syslog:in'"] });
    // Nothing names the entry (a catch-all filter says nothing): unresolved.
    expect(
      routeTableEdits([
        file([
          ['context', '     filter: "true"'],
          ['delete', '-    output: a'],
          ['insert', '+    output: b'],
        ]),
      ]),
    ).toEqual({ ids: [], names: [], unresolved: true });
    // A diff too big to show: unresolved; a commit that did not touch the group's table: undefined.
    expect(routeTableEdits([file([], { isTooBig: true, addedLines: 500 })])).toEqual({ ids: [], names: [], unresolved: true });
    expect(routeTableEdits([{ ...file([['insert', '+x']]), oldName: 'groups/default/local/cribl/outputs.yml', newName: 'groups/default/local/cribl/outputs.yml' }])).toBeUndefined();
    expect(routeTableEdits('junk')).toBeUndefined();
  });

  it("tells the group's route table from a pack's", () => {
    expect(isGroupRouteTable(TABLE)).toBe(true);
    expect(isGroupRouteTable('groups/default/default/cribl/pipelines/route.yml')).toBe(true);
    expect(isGroupRouteTable('groups/default/local/cribl/routes.yml')).toBe(true);
    expect(isGroupRouteTable('groups/default/default/cribl-palo-alto-networks/pipelines/route.yml')).toBe(false);
    expect(isGroupRouteTable('groups/default/local/cribl/outputs.yml')).toBe(false);
  });

  it('routeEntryChanged: by id, by name, by a distinctive filter; never on no evidence', () => {
    const edits = { ids: ['r_a'], names: ['Payments'], filters: ["__inputId=='x'"] };
    expect(routeEntryChanged(edits, { id: 'r_a' })).toBe(true);
    expect(routeEntryChanged(edits, { id: 'r_b', name: 'Payments' })).toBe(true);
    expect(routeEntryChanged({ ids: [], names: ['r_c'] }, { id: 'r_c' })).toBe(true); // the rig names routes by id
    expect(routeEntryChanged(edits, { id: 'r_d', filter: "__inputId=='x'" })).toBe(true);
    expect(routeEntryChanged(edits, { id: 'r_e', filter: 'true' })).toBe(false);
    expect(routeEntryChanged(edits, { id: 'r_f' })).toBe(false);
    expect(routeEntryChanged(undefined, { id: 'r_a' })).toBe(false);
    expect(routeEntryChanged({ ids: [], names: [], unresolved: true }, { id: 'r_a' })).toBe(false);
  });
});

describe('matchCommit: a route-table commit that edited route A never reads as a change to route B', () => {
  const T = Date.parse('2026-09-27T16:50:00Z');
  const revert: Commit = {
    hash: FIXTURE.revertWorkstations.hash,
    message: 'demo: revert the pack on mrd_windows_workstations',
    author: 'Steve Koelpin',
    committedAt: '2026-09-27T16:46:06.000Z',
    groupId: 'default',
    files: [TABLE],
    source: 'api',
    routeTable: routeTableEdits(FIXTURE.revertWorkstations.diffJson),
  };
  const inventory = {
    schemaVersion: 1 as const,
    updatedAt: '',
    hash: 'h',
    byGroup: {
      default: {
        inputs: [],
        outputs: [],
        pipelines: [],
        routes: [
          { id: 'mrd_windows_dc', name: 'mrd_windows_dc', filter: "__inputId=='datagen:mrd_windows_dc'", pipeline: 'mrd_win_xml_pack', output: 'mrd_siem_prod' },
          { id: 'mrd_windows_workstations', name: 'mrd_windows_workstations', filter: "__inputId=='datagen:mrd_windows_workstations'", pipeline: 'mrd_passthrough', output: 'mrd_siem_prod' },
          { id: 'mrd_other', name: 'Other feed', filter: "__inputId=='datagen:other'", pipeline: 'mrd_passthrough', output: 'mrd_siem_prod' },
        ],
      },
    },
  };
  const win = { sinceMs: T - 30 * 60_000, untilMs: T };

  it("the live case: mrd_windows_dc's ratio moved; f727f09 edited mrd_windows_workstations → a nearby change, not 'change to this route'", () => {
    const dc = matchCommit([revert], 'route:default:mrd_windows_dc', { ...win, ...objectContext('route:default:mrd_windows_dc', inventory) });
    expect(dc).toMatchObject({ hash: revert.hash, match: 'nearby' });
    // The route it did edit: its message names it anyway ('message'), and its hunks confirm it without the message.
    const ws = matchCommit([{ ...revert, message: 'route edit' }], 'route:default:mrd_windows_workstations', { ...win, ...objectContext('route:default:mrd_windows_workstations', inventory) });
    expect(ws).toMatchObject({ hash: revert.hash, match: 'files' });
  });

  it('a route named differently from its id is confirmed by its name', () => {
    const renamed: Commit = { ...revert, message: 'edit', routeTable: { ids: [], names: ['Other feed'] } };
    expect(matchCommit([renamed], 'route:default:mrd_other', { ...win, ...objectContext('route:default:mrd_other', inventory) })).toMatchObject({ match: 'files' });
    expect(matchCommit([renamed], 'route:default:mrd_windows_dc', { ...win, ...objectContext('route:default:mrd_windows_dc', inventory) })).toMatchObject({ match: 'nearby' });
  });

  it('an older confirmed route-table commit wins over a newer unconfirmed one', () => {
    const older: Commit = { ...revert, hash: 'aaaaaaa1', message: 'edit dc', committedAt: '2026-09-27T16:30:00.000Z', routeTable: { ids: ['mrd_windows_dc'], names: [] } };
    const newer: Commit = { ...revert, message: 'edit ws' };
    const ref = matchCommit([newer, older], 'route:default:mrd_windows_dc', { ...win, ...objectContext('route:default:mrd_windows_dc', inventory) });
    expect(ref).toMatchObject({ hash: 'aaaaaaa1', match: 'files' });
  });

  it('mergeCommits keeps the route edits a sighting read, whichever came first', () => {
    const bare: Commit = { ...revert, routeTable: undefined, source: 'demo' };
    const doc = mergeCommits(mergeCommits(null, 'default', [bare], 'x'), 'default', [revert], 'y');
    expect(doc.byGroup.default[0].routeTable).toEqual({ ids: [], names: ['mrd_windows_workstations'] });
    const back = mergeCommits(doc, 'default', [bare], 'z');
    expect(back.byGroup.default[0].routeTable).toEqual({ ids: [], names: ['mrd_windows_workstations'] });
  });
});

describe('fetchCommits reads the route edits in the same version/show call', () => {
  const ok = (json: unknown): HttpResult => ({ status: 200, ok: true, json }) as HttpResult;
  function client(routes: Record<string, HttpResult>): { http: CriblHttp; seen: string[] } {
    const seen: string[] = [];
    return {
      seen,
      http: {
        request: async (method: string, path: string) => {
          seen.push(`${method} ${path}`);
          return routes[`${method} ${path}`] ?? ({ status: 404, ok: false } as HttpResult);
        },
      } as CriblHttp,
    };
  }
  const log = ok({ items: [{ hash: 'f727f09', date: '2026-09-27 16:46:06 +0000', message: 'demo: revert the pack on mrd_windows_workstations', author_name: 'x' }] });

  it(`asks for ${SHOW_DIFF_LINES} diff lines and records the edits`, async () => {
    const { http, seen } = client({
      'GET /m/default/version?count=5': log,
      [`GET /m/default/version/show?commit=f727f09&diffLineLimit=${SHOW_DIFF_LINES}`]: ok({ items: [{ commitMessage: '', diffJson: FIXTURE.revertWorkstations.diffJson }] }),
    });
    const [c] = await fetchCommits(http, 'default', 5, { withFiles: true });
    expect(c.files).toEqual([TABLE]);
    expect(c.routeTable).toEqual({ ids: [], names: ['mrd_windows_workstations'] });
    expect(seen).toHaveLength(2);
  });

  it('reuses stored edits, and reads a stored route-table commit again only when its edits were never read', async () => {
    const stored: Commit = { hash: 'f727f09', message: '', author: 'x', committedAt: '2026-09-27T16:46:06.000Z', groupId: 'default', files: [TABLE], source: 'api' };
    const withEdits = client({ 'GET /m/default/version?count=5': log });
    const [kept] = await fetchCommits(withEdits.http, 'default', 5, { withFiles: true, cached: [{ ...stored, routeTable: { ids: ['a'], names: [] } }] });
    expect(kept.routeTable).toEqual({ ids: ['a'], names: [] });
    expect(withEdits.seen).toHaveLength(1);
    const unread = client({
      'GET /m/default/version?count=5': log,
      [`GET /m/default/version/show?commit=f727f09&diffLineLimit=${SHOW_DIFF_LINES}`]: ok({ items: [{ commitMessage: '', diffJson: FIXTURE.revertWorkstations.diffJson }] }),
    });
    const [upgraded] = await fetchCommits(unread.http, 'default', 5, { withFiles: true, cached: [stored] });
    expect(upgraded.routeTable).toEqual({ ids: [], names: ['mrd_windows_workstations'] });
    // When show fails, the files fallback records the edits as unresolved (so the next refresh does not retry for nothing).
    const failing = client({
      'GET /m/default/version?count=5': log,
      'GET /m/default/version/files?commit=f727f09': ok({ items: [{ items: [{ name: TABLE, state: 'M' }] }] }),
    });
    const [fallback] = await fetchCommits(failing.http, 'default', 5, { withFiles: true });
    expect(fallback.files).toEqual([TABLE]);
    expect(fallback.routeTable).toEqual({ ids: [], names: [], unresolved: true });
  });
});
