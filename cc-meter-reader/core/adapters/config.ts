// core/adapters/config.ts — the config inventory the sweep walks (SPEC 7 step 3) and the worker-group list.
//
// Four GETs per group (inputs, outputs, pipelines, routes), each answering the `{ items, count }` envelope.
// Everything is normalized to the trimmed shapes in core/types.ts: runtime noise (`status`, TLS blocks, ports,
// function `conf`) is dropped so the inventory hash only moves when something that matters to pricing or
// attribution changes. Inputs, outputs and pipelines are sorted by id (their order carries no meaning);
// routes keep table order (it is the routing semantics).

import type {
  Clock,
  CriblHttp,
  GroupInventory,
  HttpResult,
  InputInfo,
  InventoryDoc,
  OutputInfo,
  PipelineFunctionInfo,
  PipelineInfo,
  RouteInfo,
} from '../types.ts';
import { fnv1a, stableStringify } from '../codec.ts';
import * as urls from './cribl-urls.ts';

/** A config read failed; the caller keeps its cached inventory instead of writing a partial one. */
export class ConfigApiError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(path: string, status: number, detail?: string) {
    super(`config read ${path} failed: HTTP ${status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
    this.name = 'ConfigApiError';
    this.status = status;
    this.path = path;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** `{ items: [...] }` → items; a bare array → itself; anything else → []. */
export function itemsOf(body: unknown): Obj[] {
  const list: unknown = Array.isArray(body) ? body : isObj(body) ? body.items : undefined;
  return Array.isArray(list) ? list.filter(isObj) : [];
}

/** Assigns only defined values, so optional fields stay absent (stable JSON, stable hash). */
function withDefined<T extends object>(base: T, extras: Record<string, unknown>): T {
  const out = base as Record<string, unknown>;
  for (const [k, v] of Object.entries(extras)) if (v !== undefined) out[k] = v;
  return base;
}

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function normalizeInputs(body: unknown): InputInfo[] {
  const out: InputInfo[] = [];
  for (const it of itemsOf(body)) {
    const id = str(it.id);
    if (!id) continue;
    const connections = Array.isArray(it.connections)
      ? it.connections
          .filter(isObj)
          .map((c) => withDefined({ output: str(c.output) ?? '' }, { pipeline: str(c.pipeline) }))
          .filter((c) => c.output.length > 0)
      : undefined;
    out.push(
      withDefined<InputInfo>(
        { id, type: str(it.type) ?? 'unknown' },
        {
          disabled: bool(it.disabled),
          description: str(it.description),
          pipeline: str(it.pipeline),
          connections: connections && connections.length > 0 ? connections : undefined,
          sendToRoutes: bool(it.sendToRoutes),
        },
      ),
    );
  }
  return out.sort(byId);
}

/** An Output Router's rules as the inventory keeps them (core-12, M12): each rule's output, filter, final and disabled flags. */
function routerRules(value: unknown): OutputInfo['rules'] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<OutputInfo['rules']> = [];
  for (const r of value) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const output = str(o.output);
    if (!output) continue;
    out.push(withDefined({ output }, { filter: str(o.filter), final: bool(o.final), disabled: bool(o.disabled) }));
  }
  return out;
}

export function normalizeOutputs(body: unknown): OutputInfo[] {
  const out: OutputInfo[] = [];
  for (const it of itemsOf(body)) {
    const id = str(it.id);
    if (!id) continue;
    const type = str(it.type) ?? 'unknown';
    out.push(
      withDefined<OutputInfo>(
        { id, type },
        {
          disabled: bool(it.disabled),
          description: str(it.description),
          pipeline: str(it.pipeline),
          defaultId: type === 'default' ? str(it.defaultId) : undefined,
          // Core-12 (M12): where a router sends (output ids and rule filters only; nothing else of its config).
          rules: type === 'router' ? routerRules(it.rules) : undefined,
        },
      ),
    );
  }
  return out.sort(byId);
}

export function normalizePipelines(body: unknown): PipelineInfo[] {
  const out: PipelineInfo[] = [];
  for (const it of itemsOf(body)) {
    const id = str(it.id);
    if (!id) continue;
    const conf = isObj(it.conf) ? it.conf : {};
    const functions: PipelineFunctionInfo[] = (Array.isArray(conf.functions) ? conf.functions.filter(isObj) : []).map((f) =>
      withDefined<PipelineFunctionInfo>(
        { id: str(f.id) ?? 'unknown' },
        { description: str(f.description), disabled: bool(f.disabled), filter: str(f.filter) },
      ),
    );
    // An installed Pack is listed here as `{ id: 'pack:<packId>', conf: { pack: true } }`: no functions of its own
    // (they live inside the Pack), so it must never read as a function-free passthrough (measured live 2026-09-27:
    // the Palo Alto Networks pack cut its route ~50 % while Meter Reader pinned it to out = in).
    const pack = /^pack:(.+)$/.exec(id);
    const packId = pack ? pack[1] : conf.pack === true ? id : undefined;
    out.push(withDefined<PipelineInfo>({ id, functions }, { description: str(conf.description), output: str(conf.output), packId }));
  }
  return out.sort(byId);
}

/** Routes GET returns the tables (`items: [{ id: 'default', routes: [...] }]`); the 'default' table wins. */
export function normalizeRoutes(body: unknown): { routes: RouteInfo[]; routeTableId?: string } {
  const tables = itemsOf(body);
  const table = tables.find((t) => t.id === 'default') ?? tables[0];
  if (!table) return { routes: [] };
  const routes: RouteInfo[] = [];
  for (const r of Array.isArray(table.routes) ? table.routes.filter(isObj) : []) {
    const id = str(r.id);
    if (!id) continue;
    routes.push(
      withDefined<RouteInfo>(
        { id, filter: typeof r.filter === 'string' ? r.filter : 'true', pipeline: str(r.pipeline) ?? '' },
        {
          name: str(r.name),
          output: str(r.output),
          final: bool(r.final),
          disabled: bool(r.disabled),
          description: str(r.description),
        },
      ),
    );
  }
  return { routes, routeTableId: str(table.id) };
}

/** Stable hash of the normalized inventory (key order insensitive; route order sensitive). */
export function inventoryHash(byGroup: Record<string, GroupInventory>): string {
  return fnv1a(stableStringify(byGroup));
}

async function getOk(http: CriblHttp, path: string): Promise<unknown> {
  const res: HttpResult = await http.request('GET', path);
  if (!res.ok) throw new ConfigApiError(path, res.status, res.text ?? (res.json === undefined ? undefined : JSON.stringify(res.json)));
  return res.json;
}

/** Inputs, outputs, pipelines and routes of one worker group (4 Leader calls). */
export async function fetchGroupInventory(http: CriblHttp, groupId: string): Promise<GroupInventory> {
  const [inputs, outputs, pipelines, routes] = await Promise.all([
    getOk(http, urls.inputs(groupId)),
    getOk(http, urls.outputs(groupId)),
    getOk(http, urls.pipelines(groupId)),
    getOk(http, urls.routes(groupId)),
  ]);
  const r = normalizeRoutes(routes);
  return withDefined<GroupInventory>(
    {
      inputs: normalizeInputs(inputs),
      outputs: normalizeOutputs(outputs),
      pipelines: normalizePipelines(pipelines),
      routes: r.routes,
    },
    { routeTableId: r.routeTableId },
  );
}

/**
 * The inventory document for `groupIds` (4 calls per group, groups fetched one after another so a large
 * workspace doesn't fire every read at once). Throws ConfigApiError if any read fails.
 */
export async function fetchInventory(http: CriblHttp, groupIds: readonly string[], opts: { clock?: Clock } = {}): Promise<InventoryDoc> {
  const byGroup: Record<string, GroupInventory> = {};
  for (const gid of groupIds) byGroup[gid] = await fetchGroupInventory(http, gid);
  const now = opts.clock ? opts.clock.now() : Date.now();
  return { schemaVersion: 1, updatedAt: new Date(now).toISOString(), hash: inventoryHash(byGroup), byGroup };
}

/**
 * Stream worker group ids: `type: 'stream'`, or no type at all (older Leaders) unless the group is an Edge
 * fleet or the search group. Edge fleets, `default_search` and outposts are excluded.
 */
export function workerGroupIds(body: unknown): string[] {
  const ids: string[] = [];
  for (const g of itemsOf(body)) {
    const id = str(g.id);
    if (!id || id === 'default_search' || g.isFleet === true || g.isSearch === true) continue;
    if (g.type === 'stream' || g.type === undefined) ids.push(id);
  }
  return ids;
}

/**
 * GET /products/stream/groups → the Stream worker group ids (1 Leader call). The same declared listing the
 * sweep uses; `workerGroupIds` still drops anything that is not a Stream group, whatever a Leader returns.
 */
export async function listWorkerGroups(http: CriblHttp): Promise<string[]> {
  return workerGroupIds(await getOk(http, urls.streamGroups()));
}
