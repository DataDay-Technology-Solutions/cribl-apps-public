// src/lib/params.ts — the URL is the only home for view state (SPEC 13 "Persistence"): filters and
// the selected group live in query params, never in KV, so deep links are shareable and cost nothing.
//
// Query params (SPEC 13): ?present=1 · ?story=1 · ?period=mtd|today|30d|annualized · ?object=<ObjectKey>
// · ?group=<groupId> · ?range=6h|7d|<from>Z..<to>Z (a custom range on the Receipt, core/range.ts; while it
// is set the hero shows 'custom' regardless of ?period) · ?tour=1 (the sample tour is on screen: sticky, so
// a reload, the presenter or a shared link resume it; src/tour/TourParamSync.tsx) · ?vs=prev|week|<commit hash>
// (compares the range with the previous period, the same window a week earlier, or the time before a commit;
// P2-W13).

import { useCallback, useMemo } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { HeadlinePeriod, ObjectKey } from '../../core/types.ts';
import { parseCompareParam, parseRangeParam, type CompareSpec, type RangeSpec } from '../../core/range.ts';

export const HEADLINE_PERIODS: readonly HeadlinePeriod[] = ['mtd', 'today', '30d', 'annualized'];

export function parsePeriod(raw: string | null): HeadlinePeriod | undefined {
  return raw !== null && (HEADLINE_PERIODS as readonly string[]).includes(raw) ? (raw as HeadlinePeriod) : undefined;
}

export function parseFlag(raw: string | null): boolean {
  return raw === '1' || raw === 'true';
}

export interface AppParams {
  present: boolean;
  story: boolean;
  /** ?story=live — the demo build's recorded real run instead of the enterprise sample (D44). */
  storyLive: boolean;
  /** ?story=1&stage=1 — Story on a booth screen: dark, full screen on the first click, the cursor hidden (P2-W22). */
  stage: boolean;
  period?: HeadlinePeriod;
  /** ?range= — a custom range on the Receipt hero; absent or unparseable → no range. */
  range?: RangeSpec;
  /** ?vs= — what the custom range is compared with (only while ?range= is set). */
  vs?: CompareSpec;
  object?: ObjectKey;
  group?: string;
  /** ?tour=1 — the "Tour with sample data" is on screen (in memory only; the URL carries it across a reload). */
  tour: boolean;
}

export function readAppParams(search: URLSearchParams): AppParams {
  return {
    present: parseFlag(search.get('present')),
    story: parseFlag(search.get('story')) || search.get('story') === 'live',
    storyLive: search.get('story') === 'live',
    stage: parseFlag(search.get('stage')),
    period: parsePeriod(search.get('period')),
    range: parseRangeParam(search.get('range')),
    vs: parseCompareParam(search.get('vs')),
    object: search.get('object') ?? undefined,
    group: search.get('group') ?? undefined,
    tour: parseFlag(search.get('tour')),
  };
}

/** Params that follow the user from tab to tab (the rest belong to one view). */
const STICKY_PARAMS = ['group', 'period', 'range', 'tour', 'vs'] as const;

/** Builds an in-app href that carries the sticky params of the current URL. */
export function hrefWithStickyParams(path: string, current: URLSearchParams): string {
  const next = new URLSearchParams();
  for (const key of STICKY_PARAMS) {
    const value = current.get(key);
    if (value !== null) next.set(key, value);
  }
  const query = next.toString();
  return query ? `${path}?${query}` : path;
}

export type ParamPatch = Partial<Record<keyof AppParams, string | boolean | null | undefined>>;

/** Applies a patch to search params: `false`/`null`/`undefined`/'' delete the key, `true` sets '1'. */
export function patchSearchParams(current: URLSearchParams, patch: ParamPatch): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === false || value === '') next.delete(key);
    else next.set(key, value === true ? '1' : String(value));
  }
  return next;
}

/** Reads the app's query params and returns a setter that patches them (replace by default). */
export function useAppParams(): [AppParams, (patch: ParamPatch, opts?: { push?: boolean }) => void] {
  const [search, setSearch] = useSearchParams();
  const params = useMemo(() => readAppParams(search), [search]);
  const update = useCallback(
    (patch: ParamPatch, opts?: { push?: boolean }) => {
      setSearch((current) => patchSearchParams(current, patch), { replace: !opts?.push });
    },
    [setSearch],
  );
  return [params, update];
}

export type SettingsSection = 'general' | 'prices' | 'notifications' | 'demo';

/** Which Settings sub-page the current route is (`/settings/prices` → 'prices'). */
export function useSettingsSection(): SettingsSection {
  const { pathname } = useLocation();
  const last = pathname.replace(/\/+$/, '').split('/').pop();
  if (last === 'prices' || last === 'notifications' || last === 'demo') return last;
  return 'general';
}
