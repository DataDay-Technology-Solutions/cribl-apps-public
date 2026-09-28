// core/timeline.ts — the change timeline and commit matching (SPEC 10).
// Matching order for an object, most recent commit first within each rule:
//   1. files that touch THIS object specifically (a pipeline's own `pipelines/<id>/` directory);
//   2. the commit message naming the object (route id or its pipeline id — every demo commit does);
//   3. files that touch the shared table the object lives in (route.yml/routes.yml, inputs.yml, outputs.yml) —
//      for a ROUTE only when the commit's route.yml hunks show THIS route's entry changed (Commit.routeTable, read
//      from version/show): every route edit rewrites the group's one route.yml, so the file alone cannot say which
//      route a commit changed (rules round: a commit on mrd_windows_workstations was credited to mrd_windows_dc);
//   4. any commit in the window ("nearby change": the card says it may not be the cause).
// Rule 1 before 3 is what keeps S15 right: a pack apply on ANOTHER route rewrites the shared route
// table and may be newer, but the trim commit touched the payments pipeline itself.

import type { Commit, CommitMatch, CommitRef, ISO, RouteTableEdits, TimelineDoc } from './types.ts';
import { fromIso, toIso } from './time.ts';
import { parseObjectKey } from './flows.ts';

export const MAX_COMMITS_PER_GROUP = 200;

/** Commit instant used for windows and ordering: deployedAt when known, else committedAt. */
export function commitTimeMs(c: Pick<Commit, 'committedAt' | 'deployedAt'>): number {
  const d = c.deployedAt ? fromIso(c.deployedAt) : Number.NaN;
  return Number.isNaN(d) ? fromIso(c.committedAt) : d;
}

/** Two hashes name the same commit when one is a prefix of the other (≥ 7 chars: short vs full SHA). */
export function sameHash(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 7 && l.startsWith(s);
}

/**
 * Merges one existing record with a newly seen one for the same commit. The demo function's own
 * record (source 'demo') knows the caller's username and the deploy time; the version API knows the
 * changed files and the full hash. Keep the best of both.
 */
function mergeCommit(a: Commit, b: Commit): Commit {
  const demo = a.source === 'demo' ? a : b.source === 'demo' ? b : undefined;
  // Between two API records the newer sighting (b) wins.
  const api = b.source === 'api' ? b : a.source === 'api' ? a : undefined;
  const hash = a.hash.length >= b.hash.length ? a.hash : b.hash;
  const files = [...new Set([...(a.files ?? []), ...(b.files ?? [])])];
  const out: Commit = {
    hash,
    message: (demo ?? api ?? b).message || a.message,
    author: demo?.author || b.author || a.author,
    committedAt: (api ?? b).committedAt || a.committedAt,
    groupId: b.groupId,
    files,
    source: demo ? 'demo' : b.source,
  };
  const deployedAt = demo?.deployedAt ?? b.deployedAt ?? a.deployedAt;
  if (deployedAt) out.deployedAt = deployedAt;
  const routeTable = mergeRouteTable(a.routeTable, b.routeTable);
  if (routeTable) out.routeTable = routeTable;
  return out;
}

/** Two readings of one commit's route-table edits: their union (either may be absent). */
function mergeRouteTable(a: RouteTableEdits | undefined, b: RouteTableEdits | undefined): RouteTableEdits | undefined {
  if (!a || !b) return a ?? b;
  const out: RouteTableEdits = { ids: [...new Set([...a.ids, ...b.ids])], names: [...new Set([...a.names, ...b.names])] };
  const filters = [...new Set([...(a.filters ?? []), ...(b.filters ?? [])])];
  if (filters.length > 0) out.filters = filters;
  if (a.unresolved || b.unresolved) out.unresolved = true;
  return out;
}

/**
 * Adds commits to a group's timeline: deduped by hash (short/full prefix), newest first by commit
 * time, at most 200 per group. Returns a new document.
 */
export function mergeCommits(doc: TimelineDoc | null | undefined, groupId: string, commits: Commit[], nowIso: ISO): TimelineDoc {
  const byGroup = { ...(doc?.byGroup ?? {}) };
  const list = [...(byGroup[groupId] ?? [])];
  for (const incoming of commits) {
    // A commit listed under a group belongs to it (matchCommit filters on groupId).
    const c: Commit = { ...incoming, groupId, files: incoming.files ?? [] };
    const i = list.findIndex((x) => sameHash(x.hash, c.hash));
    if (i >= 0) list[i] = mergeCommit(list[i], c);
    else list.push(c);
  }
  list.sort((a, b) => commitTimeMs(b) - commitTimeMs(a) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  byGroup[groupId] = list.slice(0, MAX_COMMITS_PER_GROUP);
  return { schemaVersion: 1, updatedAt: nowIso, byGroup };
}

/** Every group's commits, newest first. */
export function allCommits(doc: TimelineDoc | null | undefined): Commit[] {
  return Object.values(doc?.byGroup ?? {})
    .flat()
    .sort((a, b) => commitTimeMs(b) - commitTimeMs(a));
}

/**
 * Normalizes a git log date ('2026-09-24 00:09:51 +0000', not strict ISO) or an ISO string or epoch
 * number to ISO UTC. Returns undefined when unparseable.
 */
export function normalizeGitDate(date: unknown): ISO | undefined {
  if (typeof date === 'number' && Number.isFinite(date)) return toIso(date < 1e12 ? date * 1000 : date);
  if (typeof date !== 'string' || date.trim() === '') return undefined;
  const s = date.trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  let ms: number;
  if (m) {
    const zone = m[3] === undefined ? 'Z' : m[3] === 'Z' ? 'Z' : `${m[3].slice(0, 3)}:${m[3].slice(-2)}`;
    ms = Date.parse(`${m[1]}T${m[2]}${zone}`);
  } else {
    ms = Date.parse(s);
  }
  return Number.isNaN(ms) ? undefined : toIso(ms);
}

/** A row of `GET /m/<gid>/version?count=N` (GitLogResult). */
export interface GitLogItem {
  hash: string;
  date?: string | number;
  message?: string;
  body?: string;
  author_name?: string;
  author_email?: string;
}

/** Maps a version-API log row to a Commit (source 'api'). */
export function commitFromLog(item: GitLogItem, groupId: string, files: string[] = []): Commit {
  return {
    hash: item.hash,
    message: item.message ?? '',
    author: item.author_name || item.author_email || 'unknown',
    committedAt: normalizeGitDate(item.date) ?? toIso(0),
    groupId,
    files: [...files],
    source: 'api',
  };
}

// ─── Object matching ─────────────────────────────────────────────────────────

export type FileTouch = 'object' | 'table' | 'none';

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}
/** The routing table: `pipelines/route.yml` on disk (packs and groups); the SPEC's examples say `routes.yml`. */
const isRouteTable = (p: string): boolean => {
  const b = basename(p);
  return b === 'route.yml' || b === 'routes.yml';
};
const touchesPipeline = (p: string, pipelineId: string | undefined): boolean =>
  !!pipelineId && pipelineId !== '-' && p.includes(`pipelines/${pipelineId}/`);

/**
 * How a commit's changed files relate to an object:
 * 'object' — they touch the object itself (a pipeline's `pipelines/<id>/`; for a route, its pipeline's directory);
 * 'table'  — they touch the shared table holding it (route.yml / routes.yml for routes, inputs.yml, outputs.yml);
 * 'none'.
 */
export function filesTouchObject(files: string[], key: string, pipelineIdForRoute?: string): FileTouch {
  const parsed = parseObjectKey(key);
  if (!parsed || !files?.length) return 'none';
  const { kind, id } = parsed;
  switch (kind) {
    case 'pipe':
      return files.some((p) => touchesPipeline(p, id)) ? 'object' : 'none';
    case 'route':
      if (files.some((p) => touchesPipeline(p, pipelineIdForRoute))) return 'object';
      return files.some(isRouteTable) ? 'table' : 'none';
    case 'in':
      return files.some((p) => basename(p) === 'inputs.yml') ? 'table' : 'none';
    case 'out':
      return files.some((p) => basename(p) === 'outputs.yml') ? 'table' : 'none';
    default:
      return 'none';
  }
}

// ─── Which route a route-table commit changed ────────────────────────────────

/**
 * The group's own route table (`groups/<gid>/local/cribl/pipelines/route.yml`; the SPEC's examples say routes.yml),
 * not a pack's (`groups/<gid>/default/<pack>/pipelines/route.yml`, which routes inside the pack only).
 */
export function isGroupRouteTable(path: unknown): boolean {
  return typeof path === 'string' && isRouteTable(path) && !/(?:^|\/)default\/(?!cribl\/)[^/]+\/pipelines\/routes?\.yml$/.test(path);
}

type DiffObj = Record<string, unknown>;
const isDiffObj = (v: unknown): v is DiffObj => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A route entry's first line: `  - id: <id>` (entries sit at the top of `routes:`, never deeper than 4 spaces). */
const ENTRY_LINE = /^\s{0,4}-\s+id:\s*(.+?)\s*$/;
/** A top-level key (`routes:`, `groups: {}`, `comments: []`, `id: default`): no route's entry. */
const TOP_LINE = /^\S/;
const NAME_LINE = /^\s{2,6}name:\s*(.+?)\s*$/;
const FILTER_LINE = /^\s{2,6}filter:\s*(.+?)\s*$/;
/** Filters that say nothing about which route they belong to (a catch-all). */
const TRIVIAL_FILTER = /^(?:true|)$/;
const unquote = (v: string): string => v.replace(/^(['"])(.*)\1$/, '$2');

/**
 * What a commit changed in its group's route table, from a `version/show` diffJson (diff2html DiffFiles: blocks of
 * lines typed 'context' | 'insert' | 'delete', each `content` with its '+', '-' or ' ' prefix). The hunk's lines
 * are cut into route entries at each `- id:` line; a changed line belongs to the entry around it, named by its
 * `- id:` line, else by its `name:` line (the id is often just above the hunk's three lines of context), else by
 * its `filter:` line; a changed entry with none of them, or a diff too big to show, marks the edits `unresolved`.
 * Changes to top-level keys belong to no route. Undefined when the commit did not touch the group's route table.
 */
export function routeTableEdits(diffJson: unknown): RouteTableEdits | undefined {
  const ids = new Set<string>();
  const names = new Set<string>();
  const filters = new Set<string>();
  let unresolved = false;
  let touched = false;
  for (const f of Array.isArray(diffJson) ? diffJson.filter(isDiffObj) : []) {
    if (!isGroupRouteTable(f.newName) && !isGroupRouteTable(f.oldName)) continue;
    touched = true;
    const blocks = Array.isArray(f.blocks) ? f.blocks.filter(isDiffObj) : [];
    const lineCount = blocks.reduce((n, b) => n + (Array.isArray(b.lines) ? b.lines.length : 0), 0);
    const changedCount = (typeof f.addedLines === 'number' ? f.addedLines : 0) + (typeof f.deletedLines === 'number' ? f.deletedLines : 0);
    if (f.isTooBig === true || (lineCount === 0 && changedCount > 0)) {
      unresolved = true;
      continue;
    }
    for (const b of blocks) {
      let seg: { top: boolean; changed: boolean; id?: string; names: string[]; filter?: string } = { top: false, changed: false, names: [] };
      const close = (): void => {
        if (!seg.changed || seg.top) return;
        if (seg.id !== undefined) ids.add(seg.id);
        else if (seg.names.length > 0) for (const n of seg.names) names.add(n);
        else if (seg.filter !== undefined && !TRIVIAL_FILTER.test(seg.filter)) filters.add(seg.filter);
        else unresolved = true;
      };
      for (const l of Array.isArray(b.lines) ? b.lines.filter(isDiffObj) : []) {
        const raw = typeof l.content === 'string' ? l.content : '';
        const text = /^[ +-]/.test(raw) ? raw.slice(1) : raw;
        const changed = l.type === 'insert' || l.type === 'delete';
        const entry = ENTRY_LINE.exec(text);
        if (entry) {
          close();
          seg = { top: false, changed, id: unquote(entry[1]), names: [] };
          continue;
        }
        if (TOP_LINE.test(text)) {
          close();
          seg = { top: true, changed: false, names: [] };
          continue;
        }
        const name = NAME_LINE.exec(text);
        // A renamed entry names itself twice (the deleted and the inserted line): both are kept.
        if (name && !seg.names.includes(unquote(name[1]))) seg.names.push(unquote(name[1]));
        const filter = FILTER_LINE.exec(text);
        if (filter && seg.filter === undefined) seg.filter = unquote(filter[1]);
        if (changed) seg.changed = true;
      }
      close();
    }
  }
  if (!touched) return undefined;
  const out: RouteTableEdits = { ids: [...ids], names: [...names] };
  if (filters.size > 0) out.filters = [...filters];
  if (unresolved) out.unresolved = true;
  return out;
}

/** The route a table match is judged for: its id, and the name and filter the inventory gives it. */
export interface RouteIdentity {
  id: string;
  name?: string;
  filter?: string;
}

/**
 * Whether a commit's route-table edits show THIS route's entry changed: by id, by name (the rig names routes by
 * id), or by a distinctive filter. No edits read (older records, a diff too big) is not a yes: it is unconfirmed.
 */
export function routeEntryChanged(edits: RouteTableEdits | undefined, route: RouteIdentity): boolean {
  if (!edits) return false;
  if (edits.ids.includes(route.id)) return true;
  if (edits.names.some((n) => n === route.id || (route.name !== undefined && route.name !== '' && n === route.name))) return true;
  const filter = route.filter?.trim();
  return filter !== undefined && !TRIVIAL_FILTER.test(filter) && (edits.filters ?? []).includes(filter);
}

/** True when `message` names one of `ids` as a whole token (so 'mrd_pay' never matches 'mrd_pay_sample'). */
export function messageNamesObject(message: string, ids: (string | undefined)[]): boolean {
  if (!message) return false;
  for (const id of ids) {
    if (!id || id === '-') continue;
    let from = 0;
    for (;;) {
      const i = message.indexOf(id, from);
      if (i < 0) break;
      const before = i === 0 ? '' : message[i - 1];
      const after = message[i + id.length] ?? '';
      if (!/[A-Za-z0-9_.-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) return true;
      from = i + 1;
    }
  }
  return false;
}

export interface MatchOptions {
  sinceMs: number;
  untilMs: number;
  /** the route's pipeline (route objects) — its directory counts as touching the route */
  pipelineId?: string;
  /** the route id when matching a pipeline object through its route */
  routeId?: string;
  /** route objects: the route's name and filter (inventory), which confirm a route-table commit changed its entry */
  routeName?: string;
  routeFilter?: string;
  /** restrict to one worker group (defaults to the object's group) */
  groupId?: string;
}

function toRef(c: Commit, match: CommitMatch): CommitRef {
  const ref: CommitRef = { hash: c.hash, message: c.message, author: c.author, committedAt: c.committedAt, groupId: c.groupId, match };
  if (c.deployedAt) ref.deployedAt = c.deployedAt;
  return ref;
}

/**
 * The commit most likely to explain a change on `objectKey` within [sinceMs, untilMs] (by deploy
 * time, else commit time), per the order at the top of this file. 'table' file matches report
 * as 'files' — for a route, only a route-table commit whose hunks show this route's entry changed; any other
 * route-table commit is at best the nearby change. Commits from other worker groups are ignored.
 */
export function matchCommit(commits: Commit[], key: string, opts: MatchOptions): CommitRef | undefined {
  const parsed = parseObjectKey(key);
  const groupId = opts.groupId ?? parsed?.groupId;
  const inWindow = commits
    .filter((c) => (groupId === undefined || c.groupId === groupId) && commitTimeMs(c) >= opts.sinceMs && commitTimeMs(c) <= opts.untilMs)
    .sort((a, b) => commitTimeMs(b) - commitTimeMs(a));
  if (inWindow.length === 0) return undefined;

  const pipelineId = parsed?.kind === 'pipe' ? parsed.id : opts.pipelineId;
  const ids = [parsed?.id, parsed?.kind === 'route' ? opts.pipelineId : opts.routeId];

  const object = inWindow.find((c) => filesTouchObject(c.files, key, pipelineId) === 'object');
  if (object) return toRef(object, 'files');
  const named = inWindow.find((c) => messageNamesObject(c.message, ids));
  if (named) return toRef(named, 'message');
  const route: RouteIdentity | undefined =
    parsed?.kind === 'route'
      ? { id: parsed.id, ...(opts.routeName !== undefined ? { name: opts.routeName } : {}), ...(opts.routeFilter !== undefined ? { filter: opts.routeFilter } : {}) }
      : undefined;
  const table = inWindow.find((c) => filesTouchObject(c.files, key, pipelineId) === 'table' && (!route || routeEntryChanged(c.routeTable, route)));
  if (table) return toRef(table, 'files');
  return toRef(inWindow[0], 'nearby');
}
