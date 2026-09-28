// core/adapters/cribl-urls.ts — every Cribl API path Meter Reader calls, and the only place they live.
//
// Paths are relative to the API base (window.CRIBL_API_URL in the UI, '/api/v1' in the backend) and are
// handed to CriblHttp.request(). Group-scoped config lives under `/m/<groupId>`; metrics are Leader-level
// and unprefixed (the `/m/<gid>/system/metrics/*` form 404s — scope with `__worker_group` instead).
// Every id segment is percent-encoded so an odd id can never change the path shape.

const seg = encodeURIComponent;
const group = (gid: string): string => `/m/${seg(gid)}`;

// ─── Worker groups ───────────────────────────────────────────────────────────
/**
 * Stream worker groups (the current product path, and the only group listing config/policies.yml grants).
 * The deprecated `/master/groups` is never listed: a member the App is shared with has no grant for it (403),
 * which once cost a non-admin the Prices page of a fresh install (EPIC_AUDIT P0-03).
 */
export const streamGroups = (): string => '/products/stream/groups';

// ─── Group config (read) ─────────────────────────────────────────────────────
export const inputs = (gid: string): string => `${group(gid)}/system/inputs`;
export const input = (gid: string, id: string): string => `${inputs(gid)}/${seg(id)}`;
export const outputs = (gid: string): string => `${group(gid)}/system/outputs`;
export const output = (gid: string, id: string): string => `${outputs(gid)}/${seg(id)}`;
export const pipelines = (gid: string): string => `${group(gid)}/pipelines`;
export const pipeline = (gid: string, id: string): string => `${pipelines(gid)}/${seg(id)}`;
/** The routing tables of a group (one table, id 'default'). */
export const routes = (gid: string): string => `${group(gid)}/routes`;
/** One routing table; PATCH replaces the whole table. */
export const route = (gid: string, tableId: string): string => `${routes(gid)}/${seg(tableId)}`;
export const packs = (gid: string): string => `${group(gid)}/packs`;
export const samples = (gid: string): string => `${group(gid)}/system/samples`;

// ─── Version control (per group) ─────────────────────────────────────────────
/** Newest-first commit log touching this group. `count` alone is accepted; `limit` requires `offset`. */
export const versionLog = (gid: string, count: number): string => `${group(gid)}/version?count=${Math.max(1, Math.floor(count))}`;
/**
 * One commit's diff. `diffLineLimit=1` keeps the payload to file headers (0 would mean "unlimited"), which is
 * all Meter Reader reads: the changed paths in `diffJson[].newName/oldName`.
 */
export const versionShow = (gid: string, hash: string, diffLineLimit = 1): string =>
  `${group(gid)}/version/show?commit=${seg(hash)}&diffLineLimit=${Math.max(1, Math.floor(diffLineLimit))}`;
/** Files of one commit (a GitFile tree). Cheaper than show; used as the fallback when show fails. */
export const versionFiles = (gid: string, hash: string): string => `${group(gid)}/version/files?commit=${seg(hash)}`;
/** Uncommitted files in this group. */
export const versionStatus = (gid: string): string => `${group(gid)}/version/status`;
/** Commit in group context: POST { message, files, effective: true }. */
export const versionCommit = (gid: string): string => `${group(gid)}/version/commit`;
/** Deploy a commit to a Stream group: PATCH { version }. */
export const deploy = (gid: string): string => `/products/stream/groups/${seg(gid)}/deploy`;
/** Deprecated deploy path; used only when `deploy()` answers 404. */
export const deployLegacy = (gid: string): string => `/master/groups/${seg(gid)}/deploy`;

// ─── Metrics (Leader-level) ──────────────────────────────────────────────────
export const metricsQuery = (): string => '/system/metrics/query';
export const metricsEnum = (): string => '/system/metrics/enum';

// ─── App-scoped KV + endpoints (rewritten to /a/<appId>/… by the platform) ───
/** One KV key. Each '/'-separated segment is encoded; the slashes stay (they are the KV namespace). */
export const kvKey = (key: string): string => `/kvstore/${key.split('/').map(seg).join('/')}`;
/** POST { prefix } → the key names under a prefix. */
export const kvKeys = (): string => '/kvstore/keys';
/** A backend endpoint of this App (backend runtime only). */
export const endpoint = (name: string): string => `/endpoints/${seg(name)}`;
