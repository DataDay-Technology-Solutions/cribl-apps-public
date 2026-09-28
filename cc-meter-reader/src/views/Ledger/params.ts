// src/views/Ledger/params.ts — the Ledger's view state lives in the URL only (SPEC 13 "Persistence": filters and
// the selected group persist in the URL, never in KV, so deep links are shareable and the KV budget is untouched).
//
//   ?q=<search>  ?state=<RowStatus>  ?dest=<outputId>  ?group=<groupId>  ?sort=[-]<SortKey>
//   ?timeline=24h|7d (change timeline; `?range=` belongs to the Receipt's custom range, src/lib/params.ts)
//   ?object=<ObjectKey> (deep link: scroll to + highlight the row)
//   ?quiet=show (list the flows with no traffic, which are folded into one summary row by default)
//   ?commit=<short hash> (the change timeline's open commit card; a "Changes" row sets it, P2-W07)

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatSort, isRowStatus, parseSort, type RowStatus, type SortSpec } from '../../components/LedgerTable/model.ts';
import { parseRange, type TimelineRange } from '../../components/ChangeTimeline/model.ts';

export interface LedgerParams {
  q: string;
  state?: RowStatus;
  dest?: string;
  group?: string;
  sort: SortSpec;
  range: TimelineRange;
  object?: string;
  /** true when the member chose to list flows with no traffic (absent otherwise, never `false`). */
  showQuiet?: true;
  /** the open commit card (a short hash) */
  commit?: string;
}

export function readLedgerParams(search: URLSearchParams): LedgerParams {
  const nonEmpty = (k: string) => {
    const v = search.get(k);
    return v !== null && v.trim() !== '' ? v : undefined;
  };
  const state = search.get('state');
  return {
    q: search.get('q') ?? '',
    state: isRowStatus(state) ? state : undefined,
    dest: nonEmpty('dest'),
    group: nonEmpty('group'),
    sort: parseSort(search.get('sort')),
    range: parseRange(search.get('timeline')),
    object: nonEmpty('object'),
    ...(search.get('quiet') === 'show' ? { showQuiet: true as const } : {}),
    ...(/^[0-9a-f]{4,40}$/i.test(search.get('commit') ?? '') ? { commit: (search.get('commit') ?? '').slice(0, 7).toLowerCase() } : {}),
  };
}

export interface LedgerParamPatch {
  q?: string | null;
  state?: RowStatus | null;
  dest?: string | null;
  group?: string | null;
  sort?: SortSpec | null;
  range?: TimelineRange | null;
  object?: string | null;
  showQuiet?: boolean | null;
  commit?: string | null;
}

/** Applies a patch; null / '' / defaults remove the key so URLs stay short. */
export function patchLedgerParams(current: URLSearchParams, patch: LedgerParamPatch): URLSearchParams {
  const next = new URLSearchParams(current);
  const put = (key: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === '') next.delete(key);
    else next.set(key, value);
  };
  if ('q' in patch) put('q', patch.q?.trim() ? patch.q : null);
  if ('state' in patch) put('state', patch.state ?? null);
  if ('dest' in patch) put('dest', patch.dest ?? null);
  if ('group' in patch) put('group', patch.group ?? null);
  if ('sort' in patch) put('sort', patch.sort ? formatSort(patch.sort) : null);
  if ('range' in patch) put('timeline', patch.range && patch.range !== '24h' ? patch.range : null);
  if ('object' in patch) put('object', patch.object ?? null);
  if ('showQuiet' in patch) put('quiet', patch.showQuiet ? 'show' : null);
  if ('commit' in patch) put('commit', patch.commit ?? null);
  return next;
}

/** The Ledger's URL state and a setter (history replace by default, push on request). */
export function useLedgerParams(): [LedgerParams, (patch: LedgerParamPatch, opts?: { push?: boolean }) => void] {
  const [search, setSearch] = useSearchParams();
  const params = useMemo(() => readLedgerParams(search), [search]);
  const update = useCallback(
    (patch: LedgerParamPatch, opts?: { push?: boolean }) => {
      setSearch((current) => patchLedgerParams(current, patch), {
        replace: !opts?.push,
      });
    },
    [setSearch],
  );
  return [params, update];
}
