// src/lib/author.ts — a commit's author as the App shows it (usefulness review, round 2).
//
// "A commit ID and a username on it" breaks down for GitOps or CI-managed Cribl: a commit made through the API
// carries its OAuth client id as the author ("<id>@clients"), so a card named a machine string, not a person or a
// team. Such an author reads "API client ··1a2b" (the id's last four characters, enough to tell two apart), or the
// name a member gave that client under Settings → Alerts → API clients, kept in the workspace's labels
// (settings.humanize) under "client:<last four>" — never the id itself, and a label, never a credential
// (core/settings.ts screens every label). Anyone else reads as Cribl recorded them.

import { t } from '../copy/en.ts';

const API_CLIENT = /^([^@\s]+)@clients$/i;
/** The prefix of an API client's name in settings.humanize. */
export const API_CLIENT_LABEL_PREFIX = 'client:';

/** Whether a commit author is an API client ("<client id>@clients"), not a person. */
export function isApiClientAuthor(author: string | undefined | null): boolean {
  return typeof author === 'string' && API_CLIENT.test(author.trim());
}

/** The label key an API client's name is kept under ("client:1r2s"), or undefined for a person. */
export function apiClientKey(author: string | undefined | null): string | undefined {
  const m = typeof author === 'string' ? API_CLIENT.exec(author.trim()) : null;
  return m ? `${API_CLIENT_LABEL_PREFIX}${m[1].slice(-4)}` : undefined;
}

/** "API client ··1r2s": how an unnamed API client reads, from its label key. */
export function apiClientFallback(key: string): string {
  return t('commits.apiClient', { tail: key.slice(API_CLIENT_LABEL_PREFIX.length) });
}

/** The author as the cards, the timeline and the Changes list print it. */
export function commitAuthor(author: string | undefined | null, labels?: Readonly<Record<string, string>>): string {
  const a = typeof author === 'string' ? author.trim() : '';
  const key = apiClientKey(a);
  if (!key) return a === '' ? t('commits.unknownAuthor') : a;
  const named = labels?.[key]?.trim();
  return named ? named : apiClientFallback(key);
}
