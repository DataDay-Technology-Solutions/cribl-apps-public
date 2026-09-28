// core/adapters/version.ts — commit history per worker group, changed files, and commit + deploy (SPEC 10, 11).
//
// Live facts (docs/platform/version.md, fixtures in tests/fixtures/cribl):
//   • GET /m/<gid>/version?count=N → newest-first `items: [{ hash, date, message, body, refs, author_name,
//     author_email }]`, scoped to commits that touch the group. `date` is "2026-09-24 00:09:51 +0000"
//     (space instead of 'T', offset without a colon) and is normalized to ISO here.
//   • GET /m/<gid>/version/show?commit=<hash> → `items[0] = { commitMessage (URL-encoded git-show header),
//     diffJson: DiffFiles }`; changed paths are diffJson[].newName / oldName ('/dev/null' on create/delete).
//     Read with diffLineLimit SHOW_DIFF_LINES: a file with more changed lines comes back `isTooBig` with no hunk
//     lines (MEASURED), while a route.yml edit (one or two changed lines) keeps its hunks, which say WHICH route's
//     entry the commit changed (Commit.routeTable, core/timeline.ts routeTableEdits).
//     Files are repo-relative, e.g. `groups/default/local/cribl/pipelines/<id>/conf.yml`.
//   • POST /m/<gid>/version/commit { message, files, effective: true } → `items[0].commit` (full SHA-1);
//     "nothing to commit" answers `items: [{}]`. The org carries hundreds of pending files, so a commit
//     without an explicit file list would sweep them all in: this module refuses to.
//   • PATCH /products/stream/groups/<gid>/deploy { version } (fall back to /master/groups/<gid>/deploy only on
//     404 — never on 403 or 5xx). There is no deploy-history API, so `deployedAt` is recorded by us.

import type { Clock, Commit, CriblHttp, HttpResult, ISO, RouteTableEdits } from '../types.ts';
import { isGroupRouteTable, routeTableEdits } from '../timeline.ts';
import * as urls from './cribl-urls.ts';

export type VersionErrorCode = 'log_failed' | 'status_failed' | 'commit_failed' | 'nothing_to_commit' | 'deploy_failed' | 'invalid_files';

export class VersionApiError extends Error {
  readonly code: VersionErrorCode;
  readonly status: number;
  /** Set on 'deploy_failed': the commit exists but is not deployed. */
  readonly commit?: string;
  constructor(code: VersionErrorCode, status: number, message: string, commit?: string) {
    super(message);
    this.name = 'VersionApiError';
    this.code = code;
    this.status = status;
    if (commit !== undefined) this.commit = commit;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function items(body: unknown): Obj[] {
  const list: unknown = Array.isArray(body) ? body : isObj(body) ? body.items : undefined;
  return Array.isArray(list) ? list.filter(isObj) : [];
}

function detail(res: HttpResult): string {
  const t = res.text ?? (res.json === undefined ? '' : JSON.stringify(res.json));
  return t.slice(0, 200);
}

/**
 * Normalizes a git date to ISO-8601 UTC. Accepts the Leader's "YYYY-MM-DD HH:MM:SS +0000", strict ISO, and
 * epoch seconds or milliseconds. Returns null when unparseable.
 */
export function parseGitDate(raw: unknown): ISO | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return new Date(ms).toISOString();
  }
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const s = raw.trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  let ms: number;
  if (m) {
    let zone = m[3] ?? 'Z';
    if (zone !== 'Z' && !zone.includes(':')) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
    ms = Date.parse(`${m[1]}T${m[2]}${zone}`);
  } else ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Changed paths from a DiffFiles array (new and old names, '/dev/null' skipped), de-duplicated in order. */
export function filesFromDiff(diffJson: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: unknown) => {
    const path = str(p);
    if (!path || path === '/dev/null' || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };
  for (const d of Array.isArray(diffJson) ? diffJson.filter(isObj) : []) {
    push(d.newName);
    push(d.oldName);
  }
  return out;
}

/**
 * Paths from a `/version/files` answer: `items[0].items` is a GitFile tree (one node per path segment, leaves
 * carry `state`), or a flat list whose `name` is already the full path.
 */
export function filesFromTree(body: unknown): string[] {
  const first = items(body)[0];
  const roots: unknown = first && Array.isArray(first.items) ? first.items : undefined;
  const out: string[] = [];
  const walk = (nodes: unknown, prefix: string) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes.filter(isObj)) {
      const name = str(n.name);
      if (!name) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (Array.isArray(n.children) && n.children.length > 0) walk(n.children, path);
      else out.push(path);
    }
  };
  walk(roots, '');
  return [...new Set(out)];
}

export interface FetchCommitsOptions {
  /** Fetch changed file paths for the newest commits. Default false (1 extra call per commit). */
  withFiles?: boolean;
  /** At most this many `version/show` calls per refresh. Default 5. */
  maxShow?: number;
  /**
   * Previously stored commits of this group: their non-empty `files` (and `routeTable`) are reused instead of
   * re-fetched — except a commit that touched the group's route table with no routeTable read yet (stored before
   * it was recorded), which is read again within `maxShow`.
   */
  cached?: readonly Commit[];
}

/**
 * Changed lines per file `version/show` returns hunks for (larger files come back isTooBig, their paths intact):
 * room for any route.yml edit short of rewriting the table, without shipping a pack's lookups.
 */
export const SHOW_DIFF_LINES = 200;

async function fetchFiles(http: CriblHttp, groupId: string, hash: string): Promise<{ files: string[]; routeTable?: RouteTableEdits }> {
  const show = await http.request('GET', urls.versionShow(groupId, hash, SHOW_DIFF_LINES));
  if (show.ok) {
    const first = items(show.json)[0];
    if (first) {
      const routeTable = routeTableEdits(first.diffJson);
      return { files: filesFromDiff(first.diffJson), ...(routeTable ? { routeTable } : {}) };
    }
  }
  // show can fail on huge or root commits; the files endpoint is lighter (paths only: which route a route.yml
  // change touched stays unknown). Root commits fail both: no files.
  const res = await http.request('GET', urls.versionFiles(groupId, hash));
  const files = res.ok ? filesFromTree(res.json) : [];
  // Recorded as unresolved, so a later refresh does not read the same commit again for nothing.
  return files.some(isGroupRouteTable) ? { files, routeTable: { ids: [], names: [], unresolved: true } } : { files };
}

/**
 * The newest `count` commits touching `groupId`, newest first (1 call, plus ≤ maxShow file lookups).
 * Throws VersionApiError('log_failed') if the log cannot be read — never returns a silently empty timeline.
 */
export async function fetchCommits(http: CriblHttp, groupId: string, count = 50, opts: FetchCommitsOptions = {}): Promise<Commit[]> {
  const res = await http.request('GET', urls.versionLog(groupId, count));
  if (!res.ok) throw new VersionApiError('log_failed', res.status, `version log for ${groupId} failed: HTTP ${res.status} ${detail(res)}`);
  const cachedFiles = new Map<string, Pick<Commit, 'files' | 'routeTable'>>();
  for (const c of opts.cached ?? []) if (c.files.length > 0) cachedFiles.set(c.hash, c.routeTable ? { files: c.files, routeTable: c.routeTable } : { files: c.files });

  const commits: Commit[] = [];
  for (const row of items(res.json)) {
    const hash = str(row.hash);
    const committedAt = parseGitDate(row.date);
    if (!hash || !committedAt) continue;
    const cached = cachedFiles.get(hash);
    const commit: Commit = {
      hash,
      message: typeof row.message === 'string' ? row.message : '',
      author: str(row.author_name) ?? str(row.author_email) ?? 'unknown',
      committedAt,
      groupId,
      files: cached?.files ?? [],
      source: 'api',
    };
    if (cached?.routeTable) commit.routeTable = cached.routeTable;
    commits.push(commit);
  }

  if (opts.withFiles) {
    let budget = Math.max(0, opts.maxShow ?? 5);
    // Newest first: commits never read, then stored route-table commits whose route edits were never read.
    const neverRead = commits.filter((c) => c.files.length === 0);
    const routeEditsUnread = commits.filter((c) => c.files.length > 0 && c.routeTable === undefined && c.files.some(isGroupRouteTable));
    for (const c of [...neverRead, ...routeEditsUnread]) {
      if (budget === 0) break;
      budget--;
      const read = await fetchFiles(http, groupId, c.hash);
      if (read.files.length > 0 || c.files.length === 0) c.files = read.files;
      if (read.routeTable) c.routeTable = read.routeTable;
    }
  }
  return commits;
}

function validateFiles(files: readonly string[]): void {
  if (!Array.isArray(files) || files.length === 0) {
    throw new VersionApiError('invalid_files', 0, 'refusing to commit without an explicit list of files');
  }
  for (const f of files) {
    if (typeof f !== 'string' || f.trim() === '' || f.trim() === '.' || f.includes('*')) {
      throw new VersionApiError('invalid_files', 0, `refusing to commit an unsafe file entry: ${JSON.stringify(f)}`);
    }
  }
}

/**
 * Commits exactly `files` in `groupId` and deploys that commit (3 calls; 4 on the legacy deploy fallback).
 * Volatile: callers must have the user's explicit confirmation (AGENTS.md) before calling this.
 */
export async function commitAndDeploy(
  http: CriblHttp,
  groupId: string,
  message: string,
  files: readonly string[],
  opts: { clock?: Clock } = {},
): Promise<{ commit: string; deployedAt: ISO }> {
  validateFiles(files);
  if (message.trim() === '') throw new VersionApiError('commit_failed', 0, 'a commit needs a message');

  const res = await http.request('POST', urls.versionCommit(groupId), { message, files: [...files], effective: true });
  if (!res.ok) throw new VersionApiError('commit_failed', res.status, `commit in ${groupId} failed: HTTP ${res.status} ${detail(res)}`);
  const first = items(res.json)[0];
  const commit = str(first?.commit) ?? (isObj(res.json) ? str(res.json.commit) : undefined);
  if (!commit) throw new VersionApiError('nothing_to_commit', res.status, `nothing to commit in ${groupId} for ${files.join(', ')}`);

  let dep = await http.request('PATCH', urls.deploy(groupId), { version: commit });
  if (dep.status === 404) dep = await http.request('PATCH', urls.deployLegacy(groupId), { version: commit });
  if (!dep.ok) {
    throw new VersionApiError('deploy_failed', dep.status, `commit ${commit.slice(0, 7)} made but deploy to ${groupId} failed: HTTP ${dep.status} ${detail(dep)}`, commit);
  }
  const now = opts.clock ? opts.clock.now() : Date.now();
  return { commit, deployedAt: new Date(now).toISOString() };
}

/** Uncommitted files in `groupId` that satisfy `match` (1 call). */
export async function pendingFiles(http: CriblHttp, groupId: string, match: (path: string) => boolean): Promise<string[]> {
  const res = await http.request('GET', urls.versionStatus(groupId));
  if (!res.ok) throw new VersionApiError('status_failed', res.status, `version status for ${groupId} failed: HTTP ${res.status} ${detail(res)}`);
  const status = items(res.json)[0] ?? (isObj(res.json) ? res.json : {});
  const paths: string[] = [];
  if (Array.isArray(status.files)) for (const f of status.files.filter(isObj)) if (str(f.path)) paths.push(f.path as string);
  for (const k of ['not_added', 'created', 'modified', 'deleted', 'staged', 'conflicted'] as const) {
    const list = status[k];
    if (Array.isArray(list)) for (const p of list) if (str(p)) paths.push(p as string);
  }
  if (Array.isArray(status.renamed)) for (const r of status.renamed.filter(isObj)) if (str(r.to)) paths.push(r.to as string);
  return [...new Set(paths)].filter((p) => match(p));
}
