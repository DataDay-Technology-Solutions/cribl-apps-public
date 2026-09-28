// @vitest-environment jsdom
// Usefulness review, round 2: for GitOps or CI-managed Cribl the author of an API-made commit is an OAuth client id
// ("<id>@clients"), and the cards printed it as if it were a person. The App now reads such an author as
// "API client ··<last 4>", or the name a member gave that client in the workspace's labels.

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommitImpact } from '../../core/commitImpacts.ts';
import { ChangesList } from '../../src/components/ChangeTimeline/ChangesList.tsx';
import { apiClientKey, commitAuthor, isApiClientAuthor } from '../../src/lib/author.ts';

afterEach(cleanup);

const CLIENT = 'k3xq9Zt0aBcDeF7w1r2s@clients';

describe('commitAuthor', () => {
  it('a person reads as Cribl recorded them', () => {
    expect(commitAuthor('Steve Koelpin')).toBe('Steve Koelpin');
    expect(commitAuthor('  jdoe  ')).toBe('jdoe');
    expect(isApiClientAuthor('Steve Koelpin')).toBe(false);
  });

  it('an API client reads as one, by the last four characters of its id', () => {
    expect(isApiClientAuthor(CLIENT)).toBe(true);
    expect(commitAuthor(CLIENT)).toBe('API client ··1r2s');
    expect(commitAuthor(CLIENT)).not.toContain('k3xq9Zt0');
  });

  it('a name a member gave the client wins, kept under its last four characters, never the id', () => {
    expect(apiClientKey(CLIENT)).toBe('client:1r2s');
    expect(apiClientKey('Steve Koelpin')).toBeUndefined();
    expect(commitAuthor(CLIENT, { 'client:1r2s': 'GitOps pipeline (platform team)' })).toBe('GitOps pipeline (platform team)');
    expect(commitAuthor(CLIENT, { 'client:1r2s': '   ' })).toBe('API client ··1r2s');
    expect(commitAuthor(CLIENT, { [CLIENT]: 'by the whole id' })).toBe('API client ··1r2s');
  });

  it('no author at all says so', () => {
    expect(commitAuthor('')).toBe('unknown author');
    expect(commitAuthor(undefined)).toBe('unknown author');
  });
});

describe('<ChangesList> names the API client, not its id', () => {
  it('in the row and its accessible name', () => {
    const T = Date.parse('2026-09-27T12:00:00.000Z');
    const impact = {
      commit: { hash: 'abcdef1000000000', message: 'sync from git', author: CLIENT, committedAt: new Date(T).toISOString(), deployedAt: new Date(T).toISOString(), files: [] },
      t: T,
      status: 'priced',
      basis: 'flows',
      perDayM: -2_200_000,
      perYearM: -2_200_000 * 365,
      moved: [],
    } as unknown as CommitImpact;
    const { container } = render(<ChangesList impacts={[impact]} timeZone="UTC" />);
    const row = container.querySelector('[data-commit="abcdef1"]')!;
    expect(row.textContent).toContain('API client ··1r2s');
    expect(row.textContent).not.toContain('@clients');
    expect(row.getAttribute('aria-label')).toContain('API client ··1r2s');
  });
});
