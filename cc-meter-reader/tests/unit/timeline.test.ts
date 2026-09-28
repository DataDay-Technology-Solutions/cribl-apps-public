import { describe, expect, it } from 'vitest';
import type { Commit, TimelineDoc } from '../../core/types.ts';
import {
  MAX_COMMITS_PER_GROUP,
  allCommits,
  commitFromLog,
  commitTimeMs,
  filesTouchObject,
  matchCommit,
  mergeCommits,
  messageNamesObject,
  normalizeGitDate,
  sameHash,
} from '../../core/timeline.ts';

const NOW = '2026-09-26T04:00:00.000Z';
const c = (hash: string, at: string, over: Partial<Commit> = {}): Commit => ({
  hash,
  message: `commit ${hash}`,
  author: 'someone',
  committedAt: at,
  groupId: 'default',
  files: [],
  source: 'api',
  ...over,
});

describe('dates and hashes', () => {
  it('normalizes git log dates', () => {
    expect(normalizeGitDate('2026-09-24 00:09:51 +0000')).toBe('2026-09-24T00:09:51.000Z');
    expect(normalizeGitDate('2026-09-24 02:09:51 +0200')).toBe('2026-09-24T00:09:51.000Z');
    expect(normalizeGitDate('2026-09-24T00:09:51Z')).toBe('2026-09-24T00:09:51.000Z');
    expect(normalizeGitDate('2026-09-24 00:09:51')).toBe('2026-09-24T00:09:51.000Z');
    expect(normalizeGitDate('Thu, 24 Sep 2026 00:09:51 GMT')).toBe('2026-09-24T00:09:51.000Z');
    expect(normalizeGitDate(1790208591)).toBe('2026-09-24T00:09:51.000Z');
    expect(normalizeGitDate(1790208591000)).toBe('2026-09-24T00:09:51.000Z');
    expect(normalizeGitDate('garbage')).toBeUndefined();
    expect(normalizeGitDate('')).toBeUndefined();
    expect(normalizeGitDate(null)).toBeUndefined();
  });
  it('matches short and full hashes', () => {
    expect(sameHash('a1f3c9e', 'a1f3c9e0123456789')).toBe(true);
    expect(sameHash('a1f3c9e0123456789', 'a1f3c9e')).toBe(true);
    expect(sameHash('a1f3c9', 'a1f3c9e0123')).toBe(false); // < 7 chars is too ambiguous
    expect(sameHash('abc', 'abc')).toBe(true);
    expect(sameHash('', 'abc')).toBe(false);
  });
  it('uses deploy time when known', () => {
    expect(commitTimeMs({ committedAt: '2026-09-26T00:00:00Z', deployedAt: '2026-09-26T00:01:00Z' })).toBe(Date.parse('2026-09-26T00:01:00Z'));
    expect(commitTimeMs({ committedAt: '2026-09-26T00:00:00Z', deployedAt: 'bad' })).toBe(Date.parse('2026-09-26T00:00:00Z'));
  });
});

describe('commitFromLog', () => {
  it('maps a version log row', () => {
    expect(
      commitFromLog(
        { hash: 'bbef631b46bd', date: '2026-09-24 00:09:51 +0000', message: 'create group default', author_name: 'Cribl System', author_email: 'cribl@x' },
        'default',
        ['groups/default/local/cribl/pipelines/route.yml'],
      ),
    ).toEqual({
      hash: 'bbef631b46bd',
      message: 'create group default',
      author: 'Cribl System',
      committedAt: '2026-09-24T00:09:51.000Z',
      groupId: 'default',
      files: ['groups/default/local/cribl/pipelines/route.yml'],
      source: 'api',
    });
    expect(commitFromLog({ hash: 'x', author_email: 'a@b' }, 'g')).toMatchObject({ author: 'a@b', message: '', committedAt: '1970-01-01T00:00:00.000Z', files: [] });
    expect(commitFromLog({ hash: 'x' }, 'g').author).toBe('unknown');
  });
});

describe('mergeCommits', () => {
  it('dedupes by hash prefix, keeps newest first, merges demo and api records', () => {
    const demo = c('a1f3c9e', '2026-09-26T03:39:00.000Z', {
      source: 'demo',
      author: 's.koelpin',
      deployedAt: '2026-09-26T03:39:12.000Z',
      files: ['groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml'],
      message: 'demo: break the trim on mrd_pay_sample',
    });
    let doc = mergeCommits(null, 'default', [demo], NOW);
    doc = mergeCommits(doc, 'default', [c('0000001', '2026-09-26T01:00:00.000Z')], NOW);
    const api = c('a1f3c9e0123456789abcdef', '2026-09-26T03:39:01.000Z', {
      author: 'Steve Koelpin',
      message: 'demo: break the trim on mrd_pay_sample',
      files: ['groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml', 'groups/default/local/cribl/pipelines/route.yml'],
    });
    doc = mergeCommits(doc, 'default', [api], NOW);
    const list = doc.byGroup.default;
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      hash: 'a1f3c9e0123456789abcdef',
      message: 'demo: break the trim on mrd_pay_sample',
      author: 's.koelpin',
      committedAt: '2026-09-26T03:39:01.000Z',
      deployedAt: '2026-09-26T03:39:12.000Z',
      groupId: 'default',
      files: ['groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml', 'groups/default/local/cribl/pipelines/route.yml'],
      source: 'demo',
    });
    expect(list[1].hash).toBe('0000001');
    expect(doc.updatedAt).toBe(NOW);
  });
  it('merges two demo records and records without files or groups', () => {
    const a = c('d000001', '2026-09-26T03:00:00.000Z', { source: 'demo', author: 'first', files: undefined as unknown as string[] });
    const b = c('d000001', '2026-09-26T03:00:00.000Z', { source: 'demo', author: '', message: '', committedAt: '', groupId: '', files: ['x'] });
    const doc = mergeCommits(mergeCommits(null, 'g', [a], NOW), 'g', [b], NOW);
    expect(doc.byGroup.g[0]).toMatchObject({ author: 'first', message: 'commit d000001', committedAt: '2026-09-26T03:00:00.000Z', groupId: 'g', files: ['x'], source: 'demo' });
    const tie = mergeCommits(null, 'g', [c('bbbbbbb', NOW), c('aaaaaaa', NOW), c('ccccccc', NOW)], NOW);
    expect(tie.byGroup.g.map((x) => x.hash)).toEqual(['aaaaaaa', 'bbbbbbb', 'ccccccc']);
  });
  it('merges two api records and caps each group at 200', () => {
    let doc: TimelineDoc | null = null;
    const many = Array.from({ length: 230 }, (_, i) => c(`h${String(i).padStart(6, '0')}`, new Date(Date.parse(NOW) - i * 60_000).toISOString()));
    doc = mergeCommits(doc, 'default', many, NOW);
    expect(doc.byGroup.default).toHaveLength(MAX_COMMITS_PER_GROUP);
    expect(doc.byGroup.default[0].hash).toBe('h000000');
    doc = mergeCommits(doc, 'default', [c('h000000', NOW, { message: 'amended', groupId: '' })], NOW);
    expect(doc.byGroup.default[0].message).toBe('amended');
    doc = mergeCommits(doc, 'other', [c('zz00000', NOW, { groupId: '', files: undefined as unknown as string[] })], NOW);
    expect(doc.byGroup.other[0]).toMatchObject({ groupId: 'other', files: [] });
    const all = allCommits(doc);
    expect(all).toHaveLength(201);
    expect(allCommits(null)).toEqual([]);
  });
});

describe('filesTouchObject and messageNamesObject', () => {
  const pipe = 'groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml';
  const table = 'groups/default/local/cribl/pipelines/route.yml';
  it('classifies file paths per object kind', () => {
    expect(filesTouchObject([pipe], 'pipe:default:mrd_pay_sample')).toBe('object');
    expect(filesTouchObject([pipe], 'pipe:default:mrd_pay')).toBe('none');
    expect(filesTouchObject([pipe], 'route:default:r_pay', 'mrd_pay_sample')).toBe('object');
    expect(filesTouchObject([table], 'route:default:r_pay', 'mrd_pay_sample')).toBe('table');
    expect(filesTouchObject(['groups/default/local/cribl/routes.yml'], 'route:default:r_pay')).toBe('table');
    expect(filesTouchObject([pipe], 'route:default:r_pay')).toBe('none');
    expect(filesTouchObject(['groups/default/local/cribl/inputs.yml'], 'in:default:x')).toBe('table');
    expect(filesTouchObject(['groups/default/local/cribl/outputs.yml'], 'out:default:x')).toBe('table');
    expect(filesTouchObject([table], 'in:default:x')).toBe('none');
    expect(filesTouchObject([table], 'out:default:x')).toBe('none');
    expect(filesTouchObject([], 'pipe:default:x')).toBe('none');
    expect(filesTouchObject([pipe], 'garbage')).toBe('none');
    expect(filesTouchObject(['route.yml'], 'route:default:r')).toBe('table');
  });
  it('matches ids as whole tokens', () => {
    expect(messageNamesObject('demo: break the trim on mrd_pay_sample', ['mrd_pay_sample'])).toBe(true);
    expect(messageNamesObject('demo: break the trim on mrd_pay_sample', ['mrd_pay'])).toBe(false);
    expect(messageNamesObject('fix mrd_pay_sample.', ['mrd_pay_sample'])).toBe(true);
    expect(messageNamesObject('touch x.mrd_pay', ['mrd_pay'])).toBe(false);
    expect(messageNamesObject('mrd_pay_samples and mrd_pay_sample', ['mrd_pay_sample'])).toBe(true);
    expect(messageNamesObject('', ['x'])).toBe(false);
    expect(messageNamesObject('a - b', ['-', undefined])).toBe(false);
  });
});

describe('matchCommit (S15 ordering)', () => {
  const T = Date.parse('2026-09-26T03:45:00Z');
  const trim = c('trim001', '2026-09-26T03:40:00.000Z', {
    deployedAt: '2026-09-26T03:40:10.000Z',
    message: 'demo: break the trim on mrd_pay_sample',
    files: ['groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml'],
  });
  const packAfter = c('pack001', '2026-09-26T03:40:40.000Z', {
    deployedAt: '2026-09-26T03:40:50.000Z',
    message: 'demo: apply the pack on r_ws',
    files: ['groups/default/local/cribl/pipelines/route.yml'],
  });
  const packBefore = { ...packAfter, hash: 'pack000', committedAt: '2026-09-26T03:39:20.000Z', deployedAt: '2026-09-26T03:39:30.000Z' };
  const opts = { sinceMs: T - 30 * 60_000, untilMs: T, pipelineId: 'mrd_pay_sample' };

  it('names the trim commit even when a newer pack commit touched the route table', () => {
    expect(matchCommit([packAfter, trim], 'route:default:r_pay', opts)).toMatchObject({ hash: 'trim001', match: 'files' });
    expect(matchCommit([trim, packBefore], 'route:default:r_pay', opts)).toMatchObject({ hash: 'trim001', match: 'files' });
  });
  it('falls back to the message when the API returned no files', () => {
    const bare = [{ ...trim, files: [] }, { ...packAfter, files: [] }];
    expect(matchCommit(bare, 'route:default:r_pay', opts)).toMatchObject({ hash: 'trim001', match: 'message' });
    expect(matchCommit(bare, 'pipe:default:mrd_pay_sample', { sinceMs: opts.sinceMs, untilMs: T })).toMatchObject({ hash: 'trim001', match: 'message' });
  });
  it('then the shared table, then the most recent nearby change', () => {
    // A route-table commit is a change to THIS route only when its hunks show this route's entry changed
    // (rules round): unread hunks, or hunks that edited another route, leave it the nearby change.
    expect(matchCommit([packAfter], 'route:default:r_pay', opts)).toMatchObject({ hash: 'pack001', match: 'nearby' });
    expect(matchCommit([{ ...packAfter, routeTable: { ids: ['r_ws'], names: [] } }], 'route:default:r_pay', opts)).toMatchObject({ hash: 'pack001', match: 'nearby' });
    expect(matchCommit([{ ...packAfter, routeTable: { ids: ['r_pay'], names: [] } }], 'route:default:r_pay', opts)).toMatchObject({ hash: 'pack001', match: 'files' });
    const other = c('other01', '2026-09-26T03:41:00.000Z', { files: ['groups/default/local/cribl/pipelines/other/conf.yml'] });
    const older = c('other00', '2026-09-26T03:30:00.000Z');
    expect(matchCommit([older, other], 'route:default:r_pay', opts)).toMatchObject({ hash: 'other01', match: 'nearby' });
  });
  it('respects the window and the group', () => {
    expect(matchCommit([trim], 'route:default:r_pay', { ...opts, untilMs: Date.parse('2026-09-26T03:40:00Z') })).toBeUndefined();
    expect(matchCommit([{ ...trim, groupId: 'other' }], 'route:default:r_pay', opts)).toBeUndefined();
    expect(matchCommit([{ ...trim, groupId: 'other' }], 'route:default:r_pay', { ...opts, groupId: 'other' })?.hash).toBe('trim001');
    expect(matchCommit([], 'route:default:r_pay', opts)).toBeUndefined();
  });
  it('carries deployedAt into the ref only when known', () => {
    const ref = matchCommit([{ ...trim, deployedAt: undefined }], 'pipe:default:mrd_pay_sample', { sinceMs: opts.sinceMs, untilMs: T });
    expect(ref).toEqual({ hash: 'trim001', message: trim.message, author: 'someone', committedAt: trim.committedAt, groupId: 'default', match: 'files' });
  });
  it('matches pipeline objects by their route id in the message', () => {
    const msg = c('route01', '2026-09-26T03:41:00.000Z', { message: 'demo: apply the pack on r_pay' });
    expect(matchCommit([msg], 'pipe:default:mrd_pay_sample', { sinceMs: opts.sinceMs, untilMs: T, routeId: 'r_pay' })).toMatchObject({ match: 'message' });
    expect(matchCommit([msg], 'garbage', { sinceMs: opts.sinceMs, untilMs: T })).toMatchObject({ match: 'nearby' });
  });
});
