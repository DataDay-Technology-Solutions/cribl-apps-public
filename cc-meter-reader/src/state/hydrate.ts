// src/state/hydrate.ts — first load (SPEC 13 "Hydration").
//
// On load, read `meta`, `settings`, `snapshot` and `prices` in one batched sequence (issued together,
// applied to the store in ONE update, so the first paint after hydration is complete and consistent),
// render from the snapshot immediately, and only then set `hasHydrated`, which gates every KV write.
//
// The "defaults never overwrite stored values" guarantee has two halves:
//   1. a stored settings document is merged OVER the defaults (stored values win: core mergeSettings);
//   2. if settings could not be read (403, 5xx, network), `hasHydrated` stays false — the store shows
//      defaults, but no save can run, so a transient failure can never replace real settings with them.
// A 404 (no document yet) is the genuine first run: hydrated, `settingsStored: false`.
//
// What the chrome learns from it (P1-D01, P1-D02): the most telling failed read becomes `status.live.lastError`
// (a 401 anywhere means the session expired; a 429 starts the same 60 s back-off live polling uses), so the
// status dot never says "Waiting for the first sweep" over reads that failed; and `lastOkAt` — "the last good
// data" the error notices quote — is set only when a snapshot was actually read.

import { buildFlows } from '../../core/flows.ts';
import type { InventoryDoc, Meta, PricesDoc, Settings, Snapshot } from '../../core/types.ts';
import type { AppDocs, MergeSettings } from './ports.ts';
import { BACKOFF_WINDOW_MS } from './live.ts';
import {
  classifyError,
  patchHydrate,
  patchLive,
  setDocError,
  type ApiErrorInfo,
  type AppState,
  type AppStore,
  type DocName,
  type InventorySummary,
} from './store.ts';

export interface HydrateDeps {
  store: AppStore;
  docs: AppDocs;
  mergeSettings: MergeSettings;
  now?: () => number;
}

export interface HydrateResult {
  /** settings are known (read OK or absent) — writes are now allowed */
  hydrated: boolean;
  errors: Partial<Record<DocName, ApiErrorInfo>>;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: ApiErrorInfo };

async function settle<T>(promise: Promise<T>, now: () => number): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: classifyError(error, now()) };
  }
}

/** Where fetched live values go: the visible fields, or the stash while a tour/replay is showing. */
function placeLiveValues(
  state: AppState,
  values: Partial<Pick<AppState, 'settings' | 'prices' | 'snapshot' | 'meta'>>,
): Partial<AppState> {
  if (state.source === 'live' || !state.liveStash) return values;
  return { liveStash: { ...state.liveStash, ...values } };
}

/** Which failed read the status line reports: an expired session first, then a 429, then the first in read order. */
export function hydrateError(errors: Partial<Record<DocName, ApiErrorInfo>>): ApiErrorInfo | undefined {
  const order: DocName[] = ['settings', 'snapshot', 'meta', 'prices'];
  const failed = order.map((doc) => errors[doc]).filter((e): e is ApiErrorInfo => e !== undefined && e.kind !== 'not-found');
  return failed.find((e) => e.kind === 'unauthorized') ?? failed.find((e) => e.kind === 'rate-limited') ?? failed[0];
}

export async function hydrate(deps: HydrateDeps): Promise<HydrateResult> {
  const { store, docs, mergeSettings } = deps;
  const now = deps.now ?? Date.now;
  patchHydrate(store, { phase: 'loading', startedAt: now() });

  // One batch: the four reads go out together; nothing is applied until all four have answered.
  const [meta, settings, snapshot, prices] = await Promise.all([
    settle<Meta | null>(docs.readMeta(), now),
    settle<Settings | null>(docs.readSettings(), now),
    settle<Snapshot | null>(docs.readSnapshot(), now),
    settle<PricesDoc | null>(docs.readPrices(), now),
  ]);

  const finishedAt = now();
  const outcomes: Record<'settings' | 'meta' | 'snapshot' | 'prices', Settled<unknown>> = { settings, meta, snapshot, prices };
  const errors: Partial<Record<DocName, ApiErrorInfo>> = {};
  for (const [doc, outcome] of Object.entries(outcomes) as [DocName, Settled<unknown>][]) {
    if (!outcome.ok) errors[doc] = outcome.error;
  }

  const live: Partial<Pick<AppState, 'settings' | 'prices' | 'snapshot' | 'meta'>> = {};
  if (settings.ok && settings.value) live.settings = mergeSettings(settings.value);
  if (meta.ok) live.meta = meta.value;
  if (snapshot.ok) live.snapshot = snapshot.value;
  if (prices.ok) live.prices = prices.value;

  store.setState((state) => {
    const nextErrors = { ...state.errors };
    for (const doc of Object.keys(outcomes) as DocName[]) {
      const error = errors[doc];
      if (error) nextErrors[doc] = error;
      else delete nextErrors[doc];
    }
    const patch: Partial<AppState> = settings.ok ? { hasHydrated: true, settingsStored: settings.value !== null } : {};
    const lastError = hydrateError(errors);
    const rateLimited = Object.values(errors).some((e) => e?.kind === 'rate-limited');
    const current = state.status.live;
    const hasSnapshot = snapshot.ok && snapshot.value !== null;
    return {
      ...patch,
      ...placeLiveValues(state, live),
      errors: nextErrors,
      status: {
        ...state.status,
        hydrate: { ...state.status.hydrate, phase: settings.ok ? 'done' : 'error', finishedAt },
        live: {
          ...current,
          lastPollAt: finishedAt,
          lastOkAt: hasSnapshot ? finishedAt : current.lastOkAt,
          lastError,
          pricesReadAt: finishedAt,
          ...(snapshot.ok && meta.ok ? { docsAt: finishedAt } : {}),
          ...(rateLimited ? { backoffUntil: finishedAt + BACKOFF_WINDOW_MS } : {}),
        },
      },
    };
  });

  return { hydrated: settings.ok, errors };
}

/**
 * Re-reads settings after a failed hydration (live polling calls this until it succeeds). Never
 * touches settings once hydrated — after that, the store is the source of truth for this tab's writes.
 */
export async function retrySettings(deps: HydrateDeps): Promise<boolean> {
  const { store, docs, mergeSettings } = deps;
  if (store.getState().hasHydrated) return true;
  const now = deps.now ?? Date.now;
  const result = await settle<Settings | null>(docs.readSettings(), now);
  if (!result.ok) {
    setDocError(store, 'settings', result.error);
    return false;
  }
  store.setState((state) => {
    // Another path may have hydrated meanwhile; the first successful read wins.
    if (state.hasHydrated) return {};
    const nextErrors = { ...state.errors };
    delete nextErrors.settings;
    return {
      ...placeLiveValues(state, result.value ? { settings: mergeSettings(result.value) } : {}),
      hasHydrated: true,
      settingsStored: result.value !== null,
      errors: nextErrors,
      status: { ...state.status, hydrate: { ...state.status.hydrate, phase: 'done', finishedAt: now() } },
    };
  });
  return true;
}

/**
 * Condenses the inventory document to what the chrome and filters need; with `settings`, also what the sweep meters
 * from it (the flows, routes and sources a folded snapshot no longer lists one by one).
 */
export function summarizeInventory(doc: InventoryDoc, settings?: Pick<Settings, 'includeInternal' | 'excludedObjectKeys'>): InventorySummary {
  const groups = Object.keys(doc.byGroup).sort();
  const counts = { inputs: 0, outputs: 0, pipelines: 0, routes: 0 };
  for (const group of groups) {
    const inv = doc.byGroup[group];
    counts.inputs += inv.inputs.length;
    counts.outputs += inv.outputs.length;
    counts.pipelines += inv.pipelines.length;
    counts.routes += inv.routes.length;
  }
  if (!settings) return { updatedAt: doc.updatedAt, groups, counts };
  const flows = buildFlows(doc, settings);
  const routes = new Set<string>();
  const sources = new Set<string>();
  for (const f of flows) {
    if (f.routeId && f.routeId !== '-') routes.add(`${f.groupId}:${f.routeId}`);
    if (f.inputId && f.inputId !== '-') sources.add(`${f.groupId}:${f.inputId}`);
  }
  return { updatedAt: doc.updatedAt, groups, counts, metered: { flows: flows.length, routes: routes.size, sources: sources.size } };
}

/**
 * Second, non-blocking stage after the first render: the inventory summary always, and the demo
 * state in the demo build when demo mode is on. Failures are recorded per document and never block.
 */
export async function hydrateSecondary(deps: HydrateDeps & { includeDemoState: boolean }): Promise<void> {
  const { store, docs } = deps;
  const now = deps.now ?? Date.now;
  const inventory = settle<InventoryDoc | null>(docs.readInventory(), now);
  const demo = deps.includeDemoState ? settle(docs.readDemoState(), now) : null;

  const inv = await inventory;
  if (inv.ok) {
    store.setState({ inventory: inv.value ? summarizeInventory(inv.value, store.getState().settings) : null });
    setDocError(store, 'inventory', undefined);
  } else setDocError(store, 'inventory', inv.error);

  if (demo) {
    const result = await demo;
    patchLive(store, { demoReadAt: now() });
    if (result.ok) {
      store.setState({ demoState: result.value });
      setDocError(store, 'demoState', undefined);
    } else setDocError(store, 'demoState', result.error);
  }
}
