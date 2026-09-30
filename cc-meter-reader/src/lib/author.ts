// src/lib/author.ts — a commit's author as the App shows it (usefulness review, round 2).
//
// "A commit ID and a username on it" breaks down for GitOps or CI-managed Cribl: a commit made through the API
// carries its OAuth client id as the author ("<id>@clients"), so a card named a machine string, not a person or a
// team. Such an author reads "API client ··1a2b" (the id's last four characters, enough to tell two apart), or the
// name a member gave that client under Settings → Alerts → API clients, kept in the workspace's labels
// (settings.humanize) under "client:<last four>" — never the id itself, and a label, never a credential
// (core/settings.ts screens every label). Anyone else reads as Cribl recorded them.
//
// Founder-build r1 core-4 (FOUNDER_PLAN row 10, contract C5): the rule lives once, in core/humanize.ts displayAuthor,
// which the bell, notification targets, Slack, ServiceNow and the Report print too. This module keeps its exported
// API (every card, the timeline, Changes and the Story import it) and delegates.

import {
  API_CLIENT_LABEL_PREFIX as CORE_API_CLIENT_LABEL_PREFIX,
  apiClientFallback as coreApiClientFallback,
  apiClientKey as coreApiClientKey,
  displayAuthor,
  isApiClientAuthor as coreIsApiClientAuthor,
} from '../../core/humanize.ts';

/** The prefix of an API client's name in settings.humanize. */
export const API_CLIENT_LABEL_PREFIX = CORE_API_CLIENT_LABEL_PREFIX;

/** Whether a commit author is an API client ("<client id>@clients"), not a person. */
export function isApiClientAuthor(author: string | undefined | null): boolean {
  return coreIsApiClientAuthor(author);
}

/** The label key an API client's name is kept under ("client:1r2s"), or undefined for a person. */
export function apiClientKey(author: string | undefined | null): string | undefined {
  return coreApiClientKey(author);
}

/** "API client ··1r2s": how an unnamed API client reads, from its label key. */
export function apiClientFallback(key: string): string {
  return coreApiClientFallback(key);
}

/** The author as the cards, the timeline and the Changes list print it: core/humanize.ts displayAuthor. */
export function commitAuthor(author: string | undefined | null, labels?: Readonly<Record<string, string>>): string {
  return displayAuthor(author, labels);
}
