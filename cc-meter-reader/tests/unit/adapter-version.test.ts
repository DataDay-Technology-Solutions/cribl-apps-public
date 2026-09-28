import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Commit, CriblHttp, HttpResult } from '../../core/types.ts';
import {
  commitAndDeploy,
  fetchCommits,
  filesFromDiff,
  filesFromTree,
  parseGitDate,
  pendingFiles,
  VersionApiError,
} from '../../core/adapters/version.ts';

interface Envelope {
  request: { method: string; path: string; body?: unknown };
  status: number;
  body: unknown;
}
const fixture = (name: string): Envelope =>
  JSON.parse(readFileSync(new URL(`../fixtures/cribl/${name}.json`, import.meta.url), 'utf8')) as Envelope;
const answer = (name: string): HttpResult => {
  const f = fixture(name);
  return { status: f.status, ok: f.status < 300, json: f.body };
};

const HASH = 'bbef631b46bd226130b80c43223a25645e919852';
const DEMO = 'a1f3c9e7b2d4f6a8c0e1a1f3c9e7b2d4f6a8c0e1';

/** Routes `METHOD path` to scripted answers (a function or a queue), recording requests and bodies. */
function http(routes: Record<string, HttpResult | HttpResult[]>) {
  const seen: { method: string; path: string; body: unknown }[] = [];
  const client: CriblHttp = {
    async request(method, path, body) {
      seen.push({ method, path, body });
      const r = routes[`${method} ${path}`];
      if (Array.isArray(r)) return r.shift() ?? { status: 599, ok: false };
      return r ?? { status: 404, ok: false, json: { status: 'error', message: 'not found' } };
    },
  };
  return { client, seen };
}

describe('parseGitDate', () => {
  it('normalizes the Leader format "YYYY-MM-DD HH:MM:SS +0000" to ISO UTC', () => {
    expect(parseGitDate('2026-09-24 00:09:51 +0000')).toBe('2026-09-24T00:09:51.000Z');
    expect(parseGitDate('2026-09-24 02:09:51 +0200')).toBe('2026-09-24T00:09:51.000Z');
    expect(parseGitDate('2026-09-23 19:09:51 -05:00')).toBe('2026-09-24T00:09:51.000Z');
  });
  it('accepts strict ISO, a naive timestamp (as UTC), epoch seconds and epoch ms', () => {
    expect(parseGitDate('2026-09-24T00:09:51.123Z')).toBe('2026-09-24T00:09:51.123Z');
    expect(parseGitDate('2026-09-24 00:09:51')).toBe('2026-09-24T00:09:51.000Z');
    expect(parseGitDate(1790208591)).toBe('2026-09-24T00:09:51.000Z');
    expect(parseGitDate(1790208591000)).toBe('2026-09-24T00:09:51.000Z');
    expect(parseGitDate('Thu, 24 Sep 2026 00:09:51 GMT')).toBe('2026-09-24T00:09:51.000Z');
  });
  it('returns null for anything unparseable', () => {
    for (const v of ['', '   ', 'yesterday', null, undefined, Number.NaN, {}]) expect(parseGitDate(v)).toBeNull();
  });
});

describe('file extraction', () => {
  it('reads new and old names from the live DiffFiles, skipping /dev/null', () => {
    const show = fixture('version-show').body as { items: { diffJson: unknown }[] };
    expect(filesFromDiff(show.items[0].diffJson)).toEqual([
      'groups/default/data/lookups/model_relative_entropy_top_domains.csv',
      'groups/default/data/lookups/service_names_port_numbers.csv',
      'groups/default/data/lookups/xsiam_name_vendor_products.csv',
      'groups/default/data/protobuf-libraries/databricks-zerobus/lib/databricks/zerobus/zerobus_service.proto',
    ]);
  });
  it('covers modify, rename and delete entries', () => {
    const show = fixture('version-show-demo.synthetic').body as { items: { diffJson: unknown }[] };
    expect(filesFromDiff(show.items[0].diffJson)).toEqual([
      'groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml',
      'groups/default/local/cribl/pipelines/new_name/conf.yml',
      'groups/default/local/cribl/pipelines/old_name/conf.yml',
      'groups/default/local/cribl/pipelines/gone/conf.yml',
    ]);
    expect(filesFromDiff('nope')).toEqual([]);
    expect(filesFromDiff([null, { newName: '' }])).toEqual([]);
  });
  it('flattens the live GitFile tree, and flat name lists', () => {
    expect(filesFromTree(fixture('version-files').body)).toEqual([
      'groups/default/data/lookups/model_relative_entropy_top_domains.csv',
      'groups/default/default/cribl/inputs.yml',
      'groups/default/default/cribl/pipelines/main/conf.yml',
      'groups/default/default/cribl/pipelines/passthru/conf.yml',
      'groups/default/local/cribl/inputs.yml',
    ]);
    expect(filesFromTree({ items: [{ count: 2, items: [{ name: 'groups/default/local/cribl/routes.yml', state: 'M' }, { state: 'A' }, 'x'] }] })).toEqual([
      'groups/default/local/cribl/routes.yml',
    ]);
    expect(filesFromTree({ items: [] })).toEqual([]);
    expect(filesFromTree(null)).toEqual([]);
  });
});

describe('fetchCommits', () => {
  it('maps the live group log to Commit records (1 call without files)', async () => {
    const { client, seen } = http({ 'GET /m/default/version?count=50': answer('version-log') });
    const commits = await fetchCommits(client, 'default');
    expect(seen.map((s) => s.path)).toEqual(['/m/default/version?count=50']);
    expect(commits).toEqual([
      { hash: HASH, message: 'create group default', author: 'Cribl System', committedAt: '2026-09-24T00:09:51.000Z', groupId: 'default', files: [], source: 'api' },
    ]);
  });

  it('fetches changed files for the newest commits, capped by maxShow, reusing cached files', async () => {
    const log = {
      status: 200,
      ok: true,
      json: {
        items: [
          { hash: 'c3', date: '2026-09-26 03:10:00 +0000', message: 'demo: break the trim on mrd_pay_sample', author_name: 'steve' },
          { hash: 'c2', date: '2026-09-26 03:05:00 +0000', message: 'cached one', author_email: 'x@example.com' },
          { hash: 'c1', date: '2026-09-26 03:00:00 +0000', message: 'older' },
          { hash: 'c0', date: '2026-09-26 02:55:00 +0000', message: 'oldest' },
          { hash: 'bad-date', date: 'whenever', message: 'skipped' },
          { date: '2026-09-26 02:00:00 +0000', message: 'no hash: skipped' },
        ],
      },
    };
    const { client, seen } = http({
      'GET /m/default/version?count=10': log,
      'GET /m/default/version/show?commit=c3&diffLineLimit=200': answer('version-show-demo.synthetic'),
      'GET /m/default/version/show?commit=c1&diffLineLimit=200': { status: 500, ok: false, text: 'fatal: bad revision' },
      'GET /m/default/version/files?commit=c1': answer('version-files'),
    });
    const cached: Commit[] = [
      { hash: 'c2', message: 'cached one', author: 'x', committedAt: '2026-09-26T03:05:00.000Z', groupId: 'default', files: ['groups/default/local/cribl/routes.yml'], source: 'api' },
      { hash: 'c0', message: 'oldest', author: 'x', committedAt: '2026-09-26T02:55:00.000Z', groupId: 'default', files: [], source: 'api' },
    ];
    const commits = await fetchCommits(client, 'default', 10, { withFiles: true, maxShow: 2, cached });
    expect(commits.map((c) => c.hash)).toEqual(['c3', 'c2', 'c1', 'c0']);
    expect(commits[0].files[0]).toBe('groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml');
    expect(commits[1]).toMatchObject({ author: 'x@example.com', files: ['groups/default/local/cribl/routes.yml'] });
    expect(commits[2].files).toContain('groups/default/default/cribl/pipelines/main/conf.yml'); // show failed → files fallback
    expect(commits[3].files).toEqual([]); // maxShow exhausted
    expect(commits[2].author).toBe('unknown');
    expect(seen.map((s) => s.path)).toEqual([
      '/m/default/version?count=10',
      '/m/default/version/show?commit=c3&diffLineLimit=200',
      '/m/default/version/show?commit=c1&diffLineLimit=200',
      '/m/default/version/files?commit=c1',
    ]);
  });

  it('returns no files when both show and files fail (the root commit)', async () => {
    const { client } = http({
      'GET /m/default/version?count=5': answer('version-log'),
      [`GET /m/default/version/show?commit=${HASH}&diffLineLimit=200`]: { status: 200, ok: true, json: { items: [] } },
      [`GET /m/default/version/files?commit=${HASH}`]: { status: 500, ok: false },
    });
    const commits = await fetchCommits(client, 'default', 5, { withFiles: true });
    expect(commits[0].files).toEqual([]);
  });

  it('keeps an empty diff from show without calling files', async () => {
    const { client, seen } = http({
      'GET /m/default/version?count=5': answer('version-log'),
      [`GET /m/default/version/show?commit=${HASH}&diffLineLimit=200`]: { status: 200, ok: true, json: { items: [{ commitMessage: '', diffJson: [] }], count: 1 } },
    });
    expect((await fetchCommits(client, 'default', 5, { withFiles: true, maxShow: 0 }))[0].files).toEqual([]);
    expect((await fetchCommits(client, 'default', 5, { withFiles: true }))[0].files).toEqual([]);
    expect(seen.filter((s) => s.path.includes('/files')).length).toBe(0);
  });

  it('throws log_failed rather than returning an empty timeline', async () => {
    const { client } = http({ 'GET /m/default/version?count=50': { status: 403, ok: false, json: { status: 'error', message: 'Forbidden' } } });
    const err = await fetchCommits(client, 'default').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionApiError);
    expect(err).toMatchObject({ code: 'log_failed', status: 403 });
    expect((err as Error).message).toMatch(/Forbidden/);
    const empty = http({ 'GET /m/default/version?count=50': { status: 200, ok: true, json: { items: [], count: 0 } } });
    expect(await fetchCommits(empty.client, 'default')).toEqual([]);
  });
});

describe('commitAndDeploy', () => {
  const FILE = 'groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml';
  const clock = { now: () => Date.parse('2026-09-26T03:10:05Z') };

  it('commits exactly the given files with effective:true, then deploys that commit', async () => {
    const { client, seen } = http({
      'POST /m/default/version/commit': answer('version-commit.synthetic'),
      'PATCH /products/stream/groups/default/deploy': answer('deploy.synthetic'),
    });
    const r = await commitAndDeploy(client, 'default', 'demo: break the trim on mrd_pay_sample', [FILE], { clock });
    expect(r).toEqual({ commit: DEMO, deployedAt: '2026-09-26T03:10:05.000Z' });
    expect(seen).toEqual([
      { method: 'POST', path: '/m/default/version/commit', body: { message: 'demo: break the trim on mrd_pay_sample', files: [FILE], effective: true } },
      { method: 'PATCH', path: '/products/stream/groups/default/deploy', body: { version: DEMO } },
    ]);
    expect(seen[0].body).toEqual(fixture('version-commit.synthetic').request.body);
  });

  it('falls back to the legacy deploy path only on 404, and accepts a top-level commit field', async () => {
    const { client, seen } = http({
      'POST /m/default/version/commit': { status: 200, ok: true, json: { commit: 'abc1234' } },
      'PATCH /products/stream/groups/default/deploy': { status: 404, ok: false },
      'PATCH /master/groups/default/deploy': answer('deploy.synthetic'),
    });
    const r = await commitAndDeploy(client, 'default', 'm', [FILE]);
    expect(r.commit).toBe('abc1234');
    expect(Number.isFinite(Date.parse(r.deployedAt))).toBe(true);
    expect(seen.map((s) => s.path)).toEqual(['/m/default/version/commit', '/products/stream/groups/default/deploy', '/master/groups/default/deploy']);
  });

  it('does not fall back on 403 or 5xx; reports the undeployed commit', async () => {
    for (const status of [403, 500]) {
      const { client, seen } = http({
        'POST /m/default/version/commit': answer('version-commit.synthetic'),
        'PATCH /products/stream/groups/default/deploy': { status, ok: false, text: 'no' },
      });
      const err = await commitAndDeploy(client, 'default', 'm', [FILE]).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: 'VersionApiError', code: 'deploy_failed', status, commit: DEMO });
      expect(seen).toHaveLength(2);
    }
  });

  it('refuses to commit without an explicit, safe file list', async () => {
    const { client, seen } = http({});
    for (const files of [[], [''], ['.'], ['groups/*'], ['  ']]) {
      await expect(commitAndDeploy(client, 'default', 'm', files)).rejects.toMatchObject({ code: 'invalid_files' });
    }
    await expect(commitAndDeploy(client, 'default', 'm', [7 as unknown as string])).rejects.toMatchObject({ code: 'invalid_files' });
    await expect(commitAndDeploy(client, 'default', '   ', [FILE])).rejects.toMatchObject({ code: 'commit_failed' });
    expect(seen).toHaveLength(0);
  });

  it('reports nothing_to_commit and commit_failed', async () => {
    const nothing = http({ 'POST /m/default/version/commit': answer('version-commit-nothing.synthetic') });
    await expect(commitAndDeploy(nothing.client, 'default', 'm', [FILE])).rejects.toMatchObject({ code: 'nothing_to_commit' });
    expect(nothing.seen).toHaveLength(1);
    const failed = http({ 'POST /m/default/version/commit': { status: 400, ok: false, json: { status: 'error', message: '"effective" param must be used with "group"' } } });
    await expect(commitAndDeploy(failed.client, 'default', 'm', [FILE])).rejects.toMatchObject({ code: 'commit_failed', status: 400 });
  });
});

describe('pendingFiles', () => {
  it('filters the live status file list', async () => {
    const { client, seen } = http({ 'GET /m/default/version/status': answer('version-status') });
    expect(await pendingFiles(client, 'default', (p) => p.includes('/auth/'))).toEqual([
      'groups/default/local/cribl/auth/cribl.secret',
      'groups/default/local/cribl/auth/users.json',
    ]);
    expect(seen).toHaveLength(1);
    const all = await pendingFiles(http({ 'GET /m/default/version/status': answer('version-status') }).client, 'default', () => true);
    expect(all).toHaveLength(4); // files[] and not_added[] de-duplicated
  });

  it('includes staged, modified, created, deleted and renamed-to paths; tolerates a bare status object', async () => {
    const status = {
      files: [{ path: 'groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml' }, { index: 'M' }],
      modified: ['groups/default/local/cribl/routes.yml'],
      staged: ['groups/default/local/cribl/inputs.yml'],
      created: [7],
      deleted: ['groups/default/local/cribl/pipelines/gone/conf.yml'],
      renamed: [{ from: 'a', to: 'groups/default/local/cribl/pipelines/new/conf.yml' }, { from: 'b' }],
    };
    const { client } = http({ 'GET /m/default/version/status': { status: 200, ok: true, json: status } });
    expect(await pendingFiles(client, 'default', (p) => p.includes('/pipelines/'))).toEqual([
      'groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml',
      'groups/default/local/cribl/pipelines/gone/conf.yml',
      'groups/default/local/cribl/pipelines/new/conf.yml',
    ]);
  });

  it('throws status_failed', async () => {
    const { client } = http({ 'GET /m/default/version/status': { status: 500, ok: false } });
    await expect(pendingFiles(client, 'default', () => true)).rejects.toMatchObject({ code: 'status_failed', status: 500 });
  });
});
