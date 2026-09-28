// src/mock/emulator.ts — a framework-free emulation of the Cribl Leader API the app uses.
//
// One `handle(request) → response` router with every piece of state behind a MockStore; three thin
// adapters sit on top of it: MSW in the browser (src/mock/browser.ts), MSW in Node (src/mock/node.ts)
// and direct CriblHttp / KvStore / WebhookSender objects with no fetch at all (src/mock/direct.ts).
//
// Fidelity rules (docs/platform/*.md, SPIKE.md, tests/fixtures/cribl): KV values over 100 KB → 413,
// text/plain PUT → 201 with an empty body, an application/json object body stores "[object Object]",
// a '|' in a key 404s, `POST /kvstore/keys` answers a bare array; `/m/<gid>/system/metrics/*` 404s;
// relative metrics times answer nothing; `/version?limit` without `offset` is a 400; the root commit's
// `/version/files` is a 500; a commit without `files` sweeps in every pending file; deploys to a
// non-Stream group 404 on `/products/stream/…` so the `/master/…` fallback is exercisable.
//
// TIME MODEL. The emulator's clock is the wall clock plus `clockOffsetMs`. Metrics exist for completed
// minutes before that clock (and within `retentionHours`); commit dates, deploy times and the start of a
// deploy's effect (the next minute boundary after deploy + `deployLagSec`) all read it. `advance` moves
// the offset — use it together with Playwright's `page.clock` when the page's clock is faked. To see a
// lever's effect without waiting, give the control action `minutesAgo` (or `at`): the change is dated
// in the past, so the app's next sweep (or backfill) already reads regressed minutes.

import {
  HOUR_MS,
  MINUTE_MS,
  GitApiError,
  MetricsQueryError,
  RIG,
  RigRefusal,
  ceilMinute,
  commitSummary,
  deployEffects,
  diffFile,
  fileContent,
  findCommit,
  floorMinute,
  gitFiles,
  gitLog,
  gitShow,
  hashHex40,
  iso,
  metricsEnum,
  metricsQuery,
  pipelineRetention,
  rigApplyPack,
  rigBreakTrim,
  rigRestoreTrim,
  rigRevertPack,
  rigSetRate,
  toInventoryDoc,
  touchesGroup,
  type CriblInput,
  type CriblOutput,
  type CriblPipeline,
  type CriblRoute,
  type CriblRouteTable,
  type GroupConfig,
  type GroupRecord,
  type SyntheticCommit,
  type World,
} from '../../testdata/gen.ts';
import { SEED_PRICES, seedRollupDocs, seedToKv } from '../../testdata/rollups.ts';
import type { PricesDoc } from '../../core/types.ts';
import { NOTIFICATION_TARGETS, PREEXISTING_PENDING, RIG_SAMPLE_CONTENT, RIG_SOURCE, SYSTEM_INFO, baseWorld, type BaseWorld } from './fixtures.ts';
import type { MockStore } from './store.ts';
import {
  DEFAULT_OPTIONS,
  MOCK_BELL_PATH,
  MOCK_CALLS_PATH,
  MOCK_CONTROL_PATH,
  MOCK_SINK_PATH,
  MOCK_STATE_PATH,
  type BellMessage,
  type CallsSummary,
  type ControlAction,
  type Fault,
  type JournalEntry,
  type MockDoc,
  type MockOptions,
  type MockPreset,
  type MockRequest,
  type MockResponse,
  type Overlay,
  type SavedSearchDoc,
  type SearchNotificationDoc,
  type SinkEntry,
} from './types.ts';

const DOC_KEY = 'doc';
const JOURNAL_KEY = 'journal';
const SINK_KEY = 'sink';
const BELL_KEY = 'bell';
const SEARCH_KEY = 'search';
const KV_PREFIX = 'kv:';
const KV_ENC_PREFIX = 'kve:';
const JOURNAL_MAX = 500;
const SINK_MAX = 200;
const BELL_MAX = 200;
/** The measured bell severities (the spec's `success` answers 400 live). */
const BELL_SEVERITIES = ['info', 'warn', 'error', 'fatal'] as const;
/** The Search group every `/search/` path lives in (AGENTS.md; the relay's saved search is there). */
const SEARCH_GROUP = 'default_search';
/** The notification service routes a forwarded event only when its id carries this prefix + the notification id. */
const SEARCH_NOTIFICATION_PREFIX = 'SEARCH_NOTIFICATION_';
/** The paths `options.notificationApis` switches (bell, targets, the Search relay). */
const NOTIFICATION_API_PATH = /^(?:\/system\/messages(?:\/|$)|\/notification-targets(?:\/|$)|\/search\/notifications$|\/notifications$|\/m\/[^/]+\/(?:search\/|notifications$))/;
const INTERNAL_ORIGIN = 'http://mock.cribl.local';
const COMMIT_AUTHOR = RIG.author;

// ─── responses ───────────────────────────────────────────────────────────────
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const json = (status: number, body: unknown, headers: Record<string, string> = {}): MockResponse => ({ status, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
const text = (status: number, body: string, contentType = 'text/plain; charset=utf-8'): MockResponse => ({ status, headers: { 'content-type': contentType }, body });
const empty = (status: number): MockResponse => ({ status, headers: {}, body: null });
const apiError = (status: number, message: string): MockResponse => json(status, { status: 'error', message });
const counted = <T>(items: T[]): { items: T[]; count: number } => ({ items, count: items.length });

/** Thrown inside handlers to answer early; converted by the router. */
class Reply extends Error {
  response: MockResponse;
  constructor(response: MockResponse) {
    super(`reply ${response.status}`);
    this.response = response;
  }
}
const fail = (status: number, message: string): never => {
  throw new Reply(apiError(status, message));
};

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

// ─── config overlays ─────────────────────────────────────────────────────────
function applyById<T extends { id: string }>(items: T[], over: Record<string, T | null> | undefined): T[] {
  if (!over) return items;
  const out = items.filter((x) => over[x.id] !== null).map((x) => over[x.id] ?? x);
  for (const [id, v] of Object.entries(over)) if (v && !items.some((x) => x.id === id)) out.push(v);
  return out;
}
/** base ⊕ overlay. The result shares objects with its inputs: clone before mutating. */
export function materialize(base: GroupConfig, overlay: Overlay | undefined): GroupConfig {
  if (!overlay) return base;
  return {
    inputs: applyById(base.inputs, overlay.inputs),
    outputs: applyById(base.outputs, overlay.outputs),
    pipelines: applyById(base.pipelines, overlay.pipelines),
    routes: overlay.routes ?? base.routes,
  };
}

type FileRef =
  | { gid: string; kind: 'pipeline'; id: string }
  | { gid: string; kind: 'routes' | 'inputs' | 'outputs' | 'other' };
function parseFile(path: string): FileRef | null {
  const m = /^groups\/([^/]+)\/(.*)$/.exec(path);
  if (!m) return null;
  const [, gid, rest] = m;
  const p = /^local\/cribl\/pipelines\/([^/]+)\/conf\.yml$/.exec(rest);
  if (p) return { gid, kind: 'pipeline', id: p[1] };
  if (rest === 'local/cribl/pipelines/route.yml' || rest === 'local/cribl/routes.yml') return { gid, kind: 'routes' };
  if (rest === 'local/cribl/inputs.yml') return { gid, kind: 'inputs' };
  if (rest === 'local/cribl/outputs.yml') return { gid, kind: 'outputs' };
  return { gid, kind: 'other' };
}
/** Copies what one repo file covers from one overlay to another (working → committed on commit). */
function copyFile(from: Overlay, to: Overlay, ref: FileRef): void {
  if (ref.kind === 'pipeline') {
    if (from.pipelines && ref.id in from.pipelines) (to.pipelines ??= {})[ref.id] = clone(from.pipelines[ref.id]);
  } else if (ref.kind === 'routes') {
    if (from.routes) to.routes = clone(from.routes);
  } else if (ref.kind === 'inputs') {
    if (from.inputs) to.inputs = clone(from.inputs);
  } else if (ref.kind === 'outputs') {
    if (from.outputs) to.outputs = clone(from.outputs);
  }
}
/** Records the objects `files` cover in a full config as overlay entries. */
function overlayFrom(overlay: Overlay, base: GroupConfig, cfg: GroupConfig, files: string[]): Overlay {
  const next = clone(overlay);
  const whole = <T extends { id: string }>(baseItems: T[], items: T[]): Record<string, T | null> => {
    const rec: Record<string, T | null> = Object.fromEntries(items.map((x) => [x.id, clone(x)]));
    for (const b of baseItems) if (!(b.id in rec)) rec[b.id] = null;
    return rec;
  };
  for (const f of files) {
    const ref = parseFile(f);
    if (!ref) continue;
    if (ref.kind === 'pipeline') (next.pipelines ??= {})[ref.id] = clone(cfg.pipelines.find((p) => p.id === ref.id) ?? null);
    else if (ref.kind === 'routes') next.routes = clone(cfg.routes);
    else if (ref.kind === 'inputs') next.inputs = whole(base.inputs, cfg.inputs);
    else if (ref.kind === 'outputs') next.outputs = whole(base.outputs, cfg.outputs);
  }
  return next;
}

const pipelinePath = (gid: string, id: string): string => `groups/${gid}/local/cribl/pipelines/${id}/conf.yml`;
const routesPath = (gid: string): string => `groups/${gid}/local/cribl/pipelines/route.yml`;
const inputsPath = (gid: string): string => `groups/${gid}/local/cribl/inputs.yml`;
const outputsPath = (gid: string): string => `groups/${gid}/local/cribl/outputs.yml`;

// ─── routes (method + path pattern → handler) ────────────────────────────────
interface Ctx {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string | null;
  headers: Record<string, string>;
  match: RegExpExecArray;
  doc: MockDoc;
  now: number;
}
type Handler = (ctx: Ctx) => MockResponse;

/** Normalized route for call counting, e.g. `PATCH /m/:gid/pipelines/:id`. */
export function normalizeRoute(method: string, apiPath: string): string {
  let p = apiPath.split('?')[0];
  if (/^\/kvstore\/(?!keys$)./.test(p)) p = '/kvstore/*';
  p = p
    .replace(/^\/m\/[^/]+/, '/m/:gid')
    .replace(/^(\/m\/:gid\/(?:pipelines|routes|packs|system\/inputs|system\/outputs|system\/samples))\/[^/]+/, '$1/:id')
    .replace(/^\/(master|products\/stream)\/groups\/[^/]+/, '/$1/groups/:gid')
    .replace(/^(\/m\/:gid\/search\/saved)\/[^/]+/, '$1/:id')
    .replace(/^\/system\/messages\/[^/]+/, '/system/messages/:id')
    .replace(/^\/notification-targets\/[^/]+/, '/notification-targets/:id')
    .replace(/^\/endpoints\/[^/]+/, '/endpoints/:name')
    .replace(/^\/proxy\/.*/, '/proxy/*');
  return `${method.toUpperCase()} ${p}`;
}

export interface EmulatorOptions {
  store: MockStore;
  /** wall clock (epoch ms); the emulator adds its own offset on top */
  clock?: () => number;
  /** path prefixes that address the Cribl API (default ['/mock-api/v1']) */
  apiPrefixes?: string[];
}

export interface JournalDoc {
  counters: { total: number; byRoute: Record<string, number>; endpointCalls: number };
  recent: JournalEntry[];
}

/**
 * The emulated Leader. Stateless between requests apart from its store, so several instances (tabs)
 * over the same store agree, and a reload continues exactly where it left off.
 */
export class CriblEmulator {
  readonly store: MockStore;
  private readonly wallClock: () => number;
  private readonly apiPrefixes: string[];
  private docCache: { raw: string; doc: MockDoc } | null = null;
  private viewCache: { key: string; view: View } | null = null;
  private rate = { minute: -1, calls: 0 };
  private readonly routes: [RegExp, Partial<Record<string, Handler>>][];

  constructor(opts: EmulatorOptions) {
    this.store = opts.store;
    this.wallClock = opts.clock ?? (() => Date.now());
    this.apiPrefixes = opts.apiPrefixes ?? ['/mock-api/v1'];
    this.routes = this.buildRoutes();
  }

  // ── state ─────────────────────────────────────────────────────────────────
  /** The emulated Leader's clock (wall clock + offset). */
  now(): number {
    return this.wallClock() + this.loadDoc().clockOffsetMs;
  }

  private newDoc(preset: MockPreset = 'demo', seed = 42, flows?: number, options?: Partial<MockOptions>, offset = 0): MockDoc {
    return {
      v: 1,
      rev: 0,
      preset,
      seed,
      ...(flows ? { flows } : {}),
      createdAt: floorMinute(this.wallClock() + offset),
      clockOffsetMs: offset,
      options: { ...DEFAULT_OPTIONS, ...(options ?? {}) },
      working: {},
      committed: {},
      running: {},
      snapshots: {},
      pending: [...PREEXISTING_PENDING],
      commits: [],
      effects: [],
      deployed: {},
      faults: [],
      violations: [],
    };
  }

  /** The persisted document, re-read on every request so other tabs' changes are seen. */
  loadDoc(): MockDoc {
    const raw = this.store.get(DOC_KEY);
    if (raw && this.docCache && this.docCache.raw === raw) return this.docCache.doc;
    if (raw) {
      try {
        const doc = JSON.parse(raw) as MockDoc;
        if (doc && doc.v === 1) {
          doc.options = { ...DEFAULT_OPTIONS, ...doc.options };
          this.docCache = { raw, doc };
          return doc;
        }
      } catch {
        // fall through: a corrupt document is replaced by a fresh world
      }
    }
    const doc = this.newDoc();
    this.saveDoc(doc);
    return doc;
  }

  private saveDoc(doc: MockDoc): void {
    doc.rev++;
    const raw = JSON.stringify(doc);
    this.store.set(DOC_KEY, raw);
    this.docCache = { raw, doc };
  }

  private base(doc: MockDoc): BaseWorld {
    return baseWorld(doc.preset, doc.seed, doc.createdAt, doc.flows);
  }

  /** The world metrics are computed from: the preset plus every deploy's effects, cached per revision. */
  private view(doc: MockDoc): View {
    const key = `${doc.preset}|${doc.seed}|${doc.createdAt}|${doc.flows ?? ''}|${doc.rev}`;
    if (this.viewCache?.key === key) return this.viewCache.view;
    const base = this.base(doc);
    const world: World = doc.effects.length ? { ...base.world, effects: [...base.world.effects, ...doc.effects] } : base.world;
    const view: View = { base, world, commits: [...base.world.commits, ...doc.commits] };
    this.viewCache = { key, view };
    return view;
  }

  private groupRecord(doc: MockDoc, gid: string): GroupRecord | undefined {
    return this.base(doc).world.groups.find((g) => g.id === gid);
  }
  private requireGroup(doc: MockDoc, gid: string): GroupRecord {
    return this.groupRecord(doc, gid) ?? fail(404, `Group ${gid} not found`);
  }
  private working(doc: MockDoc, gid: string): GroupConfig {
    return materialize(this.base(doc).configs[gid], doc.working[gid]);
  }

  // ── journal and sink ──────────────────────────────────────────────────────
  private journal(): JournalDoc {
    const raw = this.store.get(JOURNAL_KEY);
    if (raw) {
      try {
        return JSON.parse(raw) as JournalDoc;
      } catch {
        // replaced below
      }
    }
    return { counters: { total: 0, byRoute: {}, endpointCalls: 0 }, recent: [] };
  }
  private record(entry: JournalEntry): void {
    const j = this.journal();
    j.counters.total++;
    j.counters.byRoute[entry.route] = (j.counters.byRoute[entry.route] ?? 0) + 1;
    if (/^\S+ \/endpoints\//.test(entry.route)) j.counters.endpointCalls++;
    j.recent.push(entry);
    if (j.recent.length > JOURNAL_MAX) j.recent.splice(0, j.recent.length - JOURNAL_MAX);
    this.store.set(JOURNAL_KEY, JSON.stringify(j));
  }
  /** Calls made to the emulated Leader (and captured external hosts) since the last reset. */
  calls(): CallsSummary {
    const j = this.journal();
    return { total: j.counters.total, byRoute: { ...j.counters.byRoute }, endpointCalls: j.counters.endpointCalls, recent: [...j.recent].reverse() };
  }
  resetCalls(): void {
    this.store.delete(JOURNAL_KEY);
  }
  /** Webhook deliveries captured from sink hosts, newest first. */
  sink(): SinkEntry[] {
    const raw = this.store.get(SINK_KEY);
    if (!raw) return [];
    try {
      return [...(JSON.parse(raw) as SinkEntry[])].reverse();
    } catch {
      return [];
    }
  }
  private capture(entry: Omit<SinkEntry, 'id'>): void {
    const items = [...this.sink()].reverse();
    items.push({ ...entry, id: (items.at(-1)?.id ?? 0) + 1 });
    if (items.length > SINK_MAX) items.splice(0, items.length - SINK_MAX);
    this.store.set(SINK_KEY, JSON.stringify(items));
  }

  // ── entry point ───────────────────────────────────────────────────────────
  /** Answers one request. Never throws: an internal failure is a 500 with a JSON body. */
  async handle(req: MockRequest): Promise<MockResponse> {
    let res: { response: MockResponse; latency: number };
    try {
      res = this.dispatch(req);
    } catch (e) {
      res = { response: this.errorResponse(e), latency: 0 };
    }
    if (res.latency > 0) await new Promise((resolve) => setTimeout(resolve, res.latency));
    return res.response;
  }

  private dispatch(req: MockRequest): { response: MockResponse; latency: number } {
    let url: URL;
    try {
      url = new URL(req.url, INTERNAL_ORIGIN);
    } catch {
      return { response: apiError(400, `bad url ${req.url}`), latency: 0 };
    }
    const method = req.method.toUpperCase();
    const path = url.pathname;
    try {
      if (path === MOCK_CONTROL_PATH) return { response: this.controlRoute(method, req.body), latency: 0 };
      if (path === MOCK_SINK_PATH) return { response: this.sinkRoute(method), latency: 0 };
      if (path === MOCK_CALLS_PATH) return { response: this.callsRoute(method), latency: 0 };
      if (path === MOCK_BELL_PATH) return { response: this.bellRoute(method), latency: 0 };
      if (path === MOCK_STATE_PATH) return { response: json(200, this.state()), latency: 0 };
    } catch (e) {
      return { response: this.errorResponse(e), latency: 0 };
    }
    const prefix = this.apiPrefixes.find((p) => path === p || path.startsWith(`${p}/`));
    const doc = this.loadDoc();
    if (prefix === undefined) {
      if (path.startsWith('/mock-api/')) return { response: apiError(404, 'Not Found'), latency: 0 };
      return { response: this.external(method, url, req, doc), latency: 0 };
    }
    let apiPath = path.slice(prefix.length) || '/';
    const scoped = /^\/a\/[^/]+(\/(?:kvstore|proxy|endpoints)(?:\/.*)?)$/.exec(apiPath);
    if (scoped) apiPath = scoped[1];
    const fullPath = apiPath + url.search;
    const now = this.wallClock() + doc.clockOffsetMs;
    const route = normalizeRoute(method, apiPath);
    let response: MockResponse;
    try {
      response = this.fault(doc, method, fullPath) ?? this.rateLimit(doc, now) ?? this.route(method, apiPath, url.searchParams, req, doc, now);
    } catch (e) {
      response = this.errorResponse(e);
    }
    this.record({ at: now, method, path: fullPath, route, status: response.status, kind: 'api' });
    return { response, latency: doc.options.latencyMs };
  }

  private errorResponse(e: unknown): MockResponse {
    if (e instanceof Reply) return e.response;
    if (e instanceof MetricsQueryError || e instanceof GitApiError || e instanceof RigRefusal) return apiError(e.status, e.message);
    return apiError(500, `mock: ${e instanceof Error ? e.message : String(e)}`);
  }

  private fault(doc: MockDoc, method: string, target: string): MockResponse | null {
    const i = doc.faults.findIndex((f) => (!f.method || f.method.toUpperCase() === method) && faultMatches(f, target));
    if (i < 0) return null;
    const f = doc.faults[i];
    if (f.times > 0) {
      f.times--;
      if (f.times === 0) doc.faults.splice(i, 1);
      this.saveDoc(doc);
    }
    return f.body === undefined ? apiError(f.status, `mock fault ${f.status}`) : typeof f.body === 'string' ? text(f.status, f.body) : json(f.status, f.body);
  }

  private rateLimit(doc: MockDoc, now: number): MockResponse | null {
    const limit = doc.options.rateLimitPerMinute;
    if (!limit) return null;
    const minute = Math.floor(now / MINUTE_MS);
    if (this.rate.minute !== minute) this.rate = { minute, calls: 0 };
    this.rate.calls++;
    if (this.rate.calls <= limit) return null;
    return json(429, { status: 'error', message: 'Too many requests' }, { 'retry-after': String(Math.ceil(((minute + 1) * MINUTE_MS - now) / 1000)) });
  }

  private route(method: string, apiPath: string, query: URLSearchParams, req: MockRequest, doc: MockDoc, now: number): MockResponse {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
    // A Leader without Cribl.Cloud's notification APIs (options.notificationApis false) knows none of their paths.
    if (!doc.options.notificationApis && NOTIFICATION_API_PATH.test(apiPath)) return apiError(404, 'Not Found');
    let pathKnown = false;
    for (const [re, byMethod] of this.routes) {
      const match = re.exec(apiPath);
      if (!match) continue;
      pathKnown = true;
      const handler = byMethod[method] ?? byMethod['*'];
      if (handler) return handler({ method, path: apiPath, query, body: req.body, headers, match, doc, now });
    }
    return pathKnown ? apiError(405, `Method ${method} not allowed on ${apiPath}`) : apiError(404, 'Not Found');
  }

  // ── the API surface ───────────────────────────────────────────────────────
  private buildRoutes(): [RegExp, Partial<Record<string, Handler>>][] {
    return [
      [/^\/kvstore\/keys$/, { POST: (c) => this.kvList(c) }],
      [/^\/kvstore\/(.+)$/, { GET: (c) => this.kvGet(c), PUT: (c) => this.kvPut(c), DELETE: (c) => this.kvDelete(c) }],
      [/^\/proxy\/([^/]+)(\/.*)?$/, { '*': (c) => this.proxy(c) }],
      [/^\/endpoints\/([^/]+)/, { '*': (c) => apiError(404, `No backend endpoint "${decodeURIComponent(c.match[1])}": App backend compute is not available in this workspace (mock: ui runtime)`) }],
      [/^\/system\/info$/, { GET: () => json(200, SYSTEM_INFO) }],
      [/^\/system\/metrics\/query$/, { POST: (c) => this.metrics(c) }],
      [/^\/system\/metrics\/enum$/, { POST: (c) => json(200, metricsEnum(this.view(c.doc).world, parseJsonBody(c.body) as Parameters<typeof metricsEnum>[1])) }],
      [/^\/m\/[^/]+\/system\/metrics(\/.*)?$/, { '*': () => apiError(404, 'Not Found') }],
      [/^\/master\/groups$/, { GET: (c) => json(200, counted(this.groups(c.doc, c.query.get('fields')))) }],
      [/^\/products\/stream\/groups$/, { GET: (c) => json(200, counted(this.groups(c.doc, c.query.get('fields')).filter((g) => g.type === 'stream'))) }],
      [/^\/(master|products\/stream)\/groups\/([^/]+)$/, { GET: (c) => this.groupGet(c) }],
      [/^\/(master|products\/stream)\/groups\/([^/]+)\/configVersion$/, { GET: (c) => this.configVersion(c) }],
      [/^\/(master|products\/stream)\/groups\/([^/]+)\/deploy$/, { PATCH: (c) => this.deployRoute(c) }],
      [/^\/m\/([^/]+)\/system\/inputs$/, { GET: (c) => this.list(c, 'inputs') }],
      [/^\/m\/([^/]+)\/system\/inputs\/([^/]+)$/, { GET: (c) => this.getOne(c, 'inputs'), PATCH: (c) => this.patchOne(c, 'inputs') }],
      [/^\/m\/([^/]+)\/system\/outputs$/, { GET: (c) => this.list(c, 'outputs') }],
      [/^\/m\/([^/]+)\/system\/outputs\/([^/]+)$/, { GET: (c) => this.getOne(c, 'outputs'), PATCH: (c) => this.patchOne(c, 'outputs') }],
      [/^\/m\/([^/]+)\/pipelines$/, { GET: (c) => this.list(c, 'pipelines') }],
      [/^\/m\/([^/]+)\/pipelines\/([^/]+)$/, { GET: (c) => this.getOne(c, 'pipelines'), PATCH: (c) => this.patchOne(c, 'pipelines') }],
      [/^\/m\/([^/]+)\/routes$/, { GET: (c) => this.routesGet(c) }],
      [/^\/m\/([^/]+)\/routes\/([^/]+)$/, { GET: (c) => this.routesGet(c), PATCH: (c) => this.routesPatch(c) }],
      // MEASURED: the org has no packs installed — the rig imports pack functions into mrd_ pipelines (docs/RIG.md).
      [
        /^\/m\/([^/]+)\/packs$/,
        {
          GET: (c) => {
            this.requireGroup(c.doc, c.match[1]);
            return json(200, counted([]));
          },
        },
      ],
      [/^\/m\/([^/]+)\/system\/samples$/, { GET: (c) => this.samples(c) }],
      [/^\/m\/([^/]+)\/system\/samples\/([^/]+)\/content$/, { GET: (c) => this.sampleContent(c) }],
      [/^\/m\/([^/]+)\/preview$/, { POST: (c) => this.preview(c) }],
      // Alert delivery through Cribl (docs/NOTIFICATIONS.md §2).
      [/^\/system\/messages$/, { GET: () => json(200, counted(this.bell())), POST: (c) => this.bellPost(c) }],
      [
        /^\/system\/messages\/([^/]+)$/,
        {
          GET: (c) => this.bellGet(c),
          PATCH: () => apiError(405, 'Updating messages is not supported.'),
          DELETE: (c) => this.bellDelete(c),
        },
      ],
      [/^\/notification-targets$/, { GET: () => json(200, counted(NOTIFICATION_TARGETS.map((t) => clone(t)))) }],
      [/^\/notification-targets\/([^/]+)$/, { GET: (c) => this.targetGet(c) }],
      [/^\/notification-targets\/([^/]+)\/test$/, { POST: () => apiError(405, 'Target does not support connection check') }],
      [/^\/m\/([^/]+)\/search\/saved$/, { GET: (c) => this.savedList(c), POST: (c) => this.savedPost(c) }],
      [/^\/m\/([^/]+)\/search\/saved\/([^/]+)$/, { GET: (c) => this.savedGet(c) }],
      [/^\/m\/([^/]+)\/search\/saved\/([^/]+)\/notifications$/, { GET: (c) => this.savedNotificationsGet(c), POST: (c) => this.savedNotificationsPost(c) }],
      // MEASURED: the group-scoped form has no route (Express 404); only the Leader-level path exists.
      [/^\/m\/[^/]+\/search\/notifications$/, { '*': (c) => text(404, `Cannot ${c.method} /api/v1/search/notifications`, 'text/html; charset=utf-8') }],
      [/^\/search\/notifications$/, { POST: (c) => this.searchNotify(c) }],
      [/^(?:\/m\/[^/]+)?\/notifications$/, { GET: () => json(200, counted(this.searchNotifications())) }],
      [/^(?:\/m\/([^/]+))?\/version$/, { GET: (c) => json(200, gitLog(this.view(c.doc).commits, { groupId: c.match[1], ...numParams(c.query, 'count', 'offset', 'limit') })) }],
      [/^(?:\/m\/([^/]+))?\/version\/show$/, { GET: (c) => json(200, gitShow(this.view(c.doc).commits, requiredParam(c.query, 'commit'), c.match[1], numParam(c.query, 'diffLineLimit') ?? 1000)) }],
      [/^(?:\/m\/([^/]+))?\/version\/files$/, { GET: (c) => this.versionFiles(c) }],
      [/^(?:\/m\/([^/]+))?\/version\/status$/, { GET: (c) => this.versionStatus(c) }],
      [/^(?:\/m\/([^/]+))?\/version\/commit$/, { POST: (c) => this.commitRoute(c) }],
    ];
  }

  // KV ─────────────────────────────────────────────────────────────────────
  private kvKeyFrom(c: Ctx): string {
    let key: string;
    try {
      key = c.match[1].split('/').map(decodeURIComponent).join('/');
    } catch {
      return fail(400, 'invalid key encoding');
    }
    if (key.includes('|')) fail(404, 'Not Found'); // MEASURED: a '|' 404s even when percent-encoded
    if (key === '' || key.split('/').some((s) => s === '')) fail(400, `invalid key "${key}"`);
    if (c.doc.options.strictKeys && key.includes(':')) fail(400, `mock: ':' is not allowed in KV keys ("${key}"); use '/' separators (DECISIONS D13)`);
    return key;
  }
  private kvGet(c: Ctx): MockResponse {
    const key = this.kvKeyFrom(c);
    if (this.store.get(KV_ENC_PREFIX + key) !== null) return apiError(403, 'Forbidden: encrypted values cannot be read back');
    const value = this.store.get(KV_PREFIX + key);
    return value === null ? apiError(404, 'Key not found') : text(200, value);
  }
  private kvPut(c: Ctx): MockResponse {
    const key = this.kvKeyFrom(c);
    const body = c.body ?? '';
    const size = new TextEncoder().encode(body).length;
    if (size > c.doc.options.kvMaxBodyBytes) return text(413, 'PayloadTooLargeError: request entity too large');
    let stored = body;
    if ((c.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
      // MEASURED: the Leader's JSON body parser rejects non-object JSON and stringifies objects.
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return apiError(400, 'invalid JSON body');
      }
      if (parsed === null || typeof parsed !== 'object') return apiError(400, 'request body must be a JSON object');
      stored = String(parsed);
    }
    if (c.query.get('encrypted') === 'true') {
      this.store.set(KV_ENC_PREFIX + key, stored);
      this.store.delete(KV_PREFIX + key);
    } else {
      this.store.set(KV_PREFIX + key, stored);
      this.store.delete(KV_ENC_PREFIX + key);
    }
    return empty(201); // MEASURED: 201 with an empty body — never parse it
  }
  private kvDelete(c: Ctx): MockResponse {
    const key = this.kvKeyFrom(c);
    const had = this.store.get(KV_PREFIX + key) !== null || this.store.get(KV_ENC_PREFIX + key) !== null;
    if (!had) return apiError(404, 'Key not found');
    this.store.delete(KV_PREFIX + key);
    this.store.delete(KV_ENC_PREFIX + key);
    return empty(200);
  }
  private kvList(c: Ctx): MockResponse {
    const body = c.body ? parseJsonBody(c.body) : {};
    const prefix = typeof (body as { prefix?: unknown })?.prefix === 'string' ? (body as { prefix: string }).prefix : '';
    const keys = new Set<string>();
    for (const k of this.store.keys(KV_PREFIX + prefix)) keys.add(k.slice(KV_PREFIX.length));
    for (const k of this.store.keys(KV_ENC_PREFIX + prefix)) keys.add(k.slice(KV_ENC_PREFIX.length));
    return json(200, [...keys].sort()); // MEASURED: a bare array of full key names
  }
  /** Every KV key and value (tests/diagnostics). */
  kvDump(prefix = ''): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of this.store.keys(KV_PREFIX + prefix).sort()) out[k.slice(KV_PREFIX.length)] = this.store.get(k) ?? '';
    return out;
  }
  private clearKv(): void {
    for (const k of this.store.keys(KV_PREFIX)) this.store.delete(k);
    for (const k of this.store.keys(KV_ENC_PREFIX)) this.store.delete(k);
  }

  // external hosts (webhooks) ────────────────────────────────────────────────
  private proxy(c: Ctx): MockResponse {
    const host = decodeURIComponent(c.match[1]).toLowerCase();
    const rest = c.match[2] ?? '/';
    const url = new URL(`https://${host}${rest}${c.query.toString() ? `?${c.query}` : ''}`);
    return this.deliver(c.method, url, c.body, c.headers, 'proxy', c.doc, c.now);
  }
  private external(method: string, url: URL, req: MockRequest, doc: MockDoc): MockResponse {
    const now = this.wallClock() + doc.clockOffsetMs;
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
    let response: MockResponse;
    try {
      response = this.fault(doc, method, url.href) ?? this.deliver(method, url, req.body, headers, 'direct', doc, now);
    } catch (e) {
      response = this.errorResponse(e);
    }
    this.record({ at: now, method, path: url.href, route: `${method} ${url.host}`, status: response.status, kind: 'external' });
    return response;
  }
  private deliver(method: string, url: URL, body: string | null, headers: Record<string, string>, via: SinkEntry['via'], doc: MockDoc, now: number): MockResponse {
    const host = url.hostname.toLowerCase();
    if (!doc.options.sinkHosts.includes(host)) return apiError(403, `host_not_authorized: ${host} is not an authorized external host for this App`);
    const contentType = headers['content-type'] ?? '';
    let parsed: unknown;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      parsed = undefined;
    }
    const status = 200;
    this.capture({ at: now, method, url: url.href, host, via, contentType, body: body ?? '', ...(parsed !== undefined ? { json: parsed } : {}), status });
    return host === 'hooks.slack.com' ? text(status, 'ok', 'text/html') : text(status, '');
  }

  // metrics ──────────────────────────────────────────────────────────────────
  private metrics(c: Ctx): MockResponse {
    const body = parseJsonBody(c.body);
    return json(200, metricsQuery(this.view(c.doc).world, body as Parameters<typeof metricsQuery>[1], { now: c.now, retentionMs: c.doc.options.retentionHours * HOUR_MS }));
  }

  // groups ───────────────────────────────────────────────────────────────────
  private groups(doc: MockDoc, fields: string | null): Record<string, unknown>[] {
    const view = this.view(doc);
    const wanted = new Set((fields ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    return view.base.world.groups.map((g) => {
      const rec: Record<string, unknown> = { ...g };
      const dep = doc.deployed[g.id];
      if (dep) rec.configVersion = dep.version.slice(0, 7);
      if ([...wanted].some((f) => f.startsWith('git'))) {
        const log = gitLog(view.commits, { groupId: g.id, count: 10 }).items;
        const git: Record<string, unknown> = {};
        if (wanted.has('git') || wanted.has('git.commit')) git.commit = log[0]?.hash.slice(0, 7) ?? '';
        if (wanted.has('git') || wanted.has('git.localChanges')) git.localChanges = doc.pending.filter((p) => p.startsWith(`groups/${g.id}/`)).length;
        if (wanted.has('git') || wanted.has('git.log')) git.log = log;
        rec.git = git;
      }
      return rec;
    });
  }
  private groupGet(c: Ctx): MockResponse {
    const gid = decodeURIComponent(c.match[2]);
    const g = this.groups(c.doc, c.query.get('fields')).find((x) => x.id === gid && (c.match[1] === 'master' || x.type === 'stream'));
    return g ? json(200, counted([g])) : apiError(404, `Group ${gid} not found`);
  }
  private configVersion(c: Ctx): MockResponse {
    const gid = decodeURIComponent(c.match[2]);
    this.requireGroup(c.doc, gid);
    const latest = gitLog(this.view(c.doc).commits, { groupId: gid, count: 1 }).items[0];
    return json(200, counted(latest ? [latest.hash.slice(0, 7)] : []));
  }
  private deployRoute(c: Ctx): MockResponse {
    const gid = decodeURIComponent(c.match[2]);
    const g = this.groupRecord(c.doc, gid);
    if (!g || (c.match[1] === 'products/stream' && g.type !== 'stream')) return apiError(404, `Group ${gid} not found`);
    const body = parseJsonBody(c.body) as { version?: unknown };
    if (typeof body?.version !== 'string' || body.version === '') return apiError(400, "'version' is required");
    const record = this.deploy(c.doc, gid, body.version, c.now);
    this.saveDoc(c.doc);
    return json(200, counted([record]));
  }

  /** Moves a group to a commit: its running config becomes that commit's, and metrics follow. */
  private deploy(doc: MockDoc, gid: string, version: string, at: number): Record<string, unknown> {
    // Read commits from the doc itself, not the cached view: a lever deploys the commit it just made.
    const base = this.base(doc);
    const commit = findCommit([...base.world.commits, ...doc.commits], version) ?? fail(400, `invalid version: ${version}`);
    const target = doc.snapshots[commit.hash]?.[gid] ?? {};
    const before = materialize(base.configs[gid], doc.running[gid]);
    const after = materialize(base.configs[gid], target);
    const effectiveAt = ceilMinute(at + doc.options.deployLagSec * 1000);
    doc.effects.push(...deployEffects(base.world.flows, before, after, effectiveAt, `deploy ${commit.hash.slice(0, 7)}`));
    doc.running[gid] = clone(target);
    doc.deployed[gid] = { version: commit.hash, at };
    const g = base.world.groups.find((x) => x.id === gid)!;
    return { ...g, configVersion: commit.hash.slice(0, 7), workerCount: base.world.hosts[gid]?.length ?? 1, incompatibleWorkerCount: 0, deployingWorkerCount: 0, lookupDeployments: [] };
  }

  // group config ─────────────────────────────────────────────────────────────
  private list(c: Ctx, kind: 'inputs' | 'outputs' | 'pipelines'): MockResponse {
    const gid = decodeURIComponent(c.match[1]);
    this.requireGroup(c.doc, gid);
    const items = this.working(c.doc, gid)[kind] as unknown[];
    const offset = numParam(c.query, 'offset');
    const limit = numParam(c.query, 'limit');
    if (offset === undefined && limit === undefined) return json(200, counted(items));
    const page = items.slice(offset ?? 0, (offset ?? 0) + (limit ?? items.length));
    return json(200, { items: page, count: page.length, offset: offset ?? 0, ...(limit !== undefined ? { limit, totalCount: items.length } : {}) });
  }
  private getOne(c: Ctx, kind: 'inputs' | 'outputs' | 'pipelines'): MockResponse {
    const gid = decodeURIComponent(c.match[1]);
    const id = decodeURIComponent(c.match[2]);
    this.requireGroup(c.doc, gid);
    const item = (this.working(c.doc, gid)[kind] as { id: string }[]).find((x) => x.id === id);
    return item ? json(200, counted([item])) : apiError(404, `${kind === 'inputs' ? 'Source' : kind === 'outputs' ? 'Destination' : 'Pipeline'} ${id} not found`);
  }
  /** Full-replacement PATCH (the API does not merge: omitted fields are removed). */
  private patchOne(c: Ctx, kind: 'inputs' | 'outputs' | 'pipelines'): MockResponse {
    const gid = decodeURIComponent(c.match[1]);
    const id = decodeURIComponent(c.match[2]);
    this.requireGroup(c.doc, gid);
    const body = parseJsonBody(c.body) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'body must be a JSON object');
    if (body.id !== undefined && body.id !== id) return apiError(400, `id in body (${String(body.id)}) does not match the path (${id})`);
    const exists = (this.working(c.doc, gid)[kind] as { id: string }[]).some((x) => x.id === id);
    if (!exists) return apiError(404, `${id} not found`);
    const next = { ...body, id } as Record<string, unknown>;
    if (kind === 'pipelines') {
      const conf = next.conf as { functions?: unknown } | undefined;
      if (!conf || typeof conf !== 'object' || !Array.isArray(conf.functions)) return apiError(400, "pipeline requires conf.functions (an array); PATCH replaces the whole pipeline");
    } else if (typeof next.type !== 'string') return apiError(400, `${kind === 'inputs' ? 'source' : 'destination'} requires 'type'; PATCH replaces the whole object`);
    const overlay = (c.doc.working[gid] ??= {});
    if (kind === 'pipelines') (overlay.pipelines ??= {})[id] = next as unknown as CriblPipeline;
    else if (kind === 'inputs') (overlay.inputs ??= {})[id] = next as unknown as CriblInput;
    else (overlay.outputs ??= {})[id] = next as unknown as CriblOutput;
    this.markPending(c.doc, kind === 'pipelines' ? pipelinePath(gid, id) : kind === 'inputs' ? inputsPath(gid) : outputsPath(gid));
    this.saveDoc(c.doc);
    return json(200, counted([next]));
  }
  private routesGet(c: Ctx): MockResponse {
    const gid = decodeURIComponent(c.match[1]);
    this.requireGroup(c.doc, gid);
    const table = this.working(c.doc, gid).routes;
    if (c.match[2] !== undefined && decodeURIComponent(c.match[2]) !== table.id) return apiError(404, `Routes ${decodeURIComponent(c.match[2])} not found`);
    return json(200, counted([table]));
  }
  private routesPatch(c: Ctx): MockResponse {
    const gid = decodeURIComponent(c.match[1]);
    const tableId = decodeURIComponent(c.match[2]);
    this.requireGroup(c.doc, gid);
    if (tableId !== 'default') return apiError(404, `Routes ${tableId} not found`);
    const body = parseJsonBody(c.body) as { routes?: unknown };
    if (!body || typeof body !== 'object' || !Array.isArray(body.routes)) return apiError(400, "body must be the whole routing table: { id, routes: [...] }");
    const routes = (body.routes as Record<string, unknown>[]).map((r, i): CriblRoute => {
      if (typeof r?.name !== 'string' || typeof r?.pipeline !== 'string') fail(400, `routes[${i}] requires name and pipeline`);
      return { ...r, id: typeof r.id === 'string' && r.id ? r.id : hashHex40(`${r.name}|${i}`).slice(0, 6), final: r.final === undefined ? true : Boolean(r.final), filter: typeof r.filter === 'string' ? r.filter : 'true' } as CriblRoute;
    });
    const table = { ...(body as object), id: tableId, routes } as CriblRouteTable;
    (c.doc.working[gid] ??= {}).routes = table;
    this.markPending(c.doc, routesPath(gid));
    this.saveDoc(c.doc);
    return json(200, counted([table]));
  }
  private samples(c: Ctx): MockResponse {
    const gid = decodeURIComponent(c.match[1]);
    this.requireGroup(c.doc, gid);
    const names = gid === RIG.groupId && c.doc.preset === 'demo' ? [...new Set(RIG.sources.map((s) => s.sample))] : [];
    return json(200, counted(names.map((n) => ({ id: n.replace(/\.[a-z]+$/, '').replace(/[^a-z0-9]+/gi, '_'), sampleName: n, size: 0, numEvents: 0 }))));
  }

  /** The rig's Datagen sample events (a JSON array of { _raw, _time }), by the id the Source names. */
  private sampleContent(c: Ctx): MockResponse {
    const gid = decodeURIComponent(c.match[1]);
    const id = decodeURIComponent(c.match[2]);
    this.requireGroup(c.doc, gid);
    const content = gid === RIG.groupId && c.doc.preset === 'demo' ? RIG_SAMPLE_CONTENT[id] : undefined;
    return content === undefined ? apiError(404, `Sample ${id} not found`) : text(200, content, 'application/json; charset=utf-8');
  }

  /**
   * `POST /m/<gid>/preview` in pipe mode: the events after the pipeline, by the pipeline's modelled retention
   * (testdata/gen.ts pipelineRetention — the same model the metrics follow): the events fraction is kept
   * deterministically by index and each kept `_raw` is cut (or, for an aggregation, padded) so the `_raw`
   * bytes out ≈ bytes in × the bytes retention. Nothing is stored. Any other mode is refused: the App only
   * ever previews a pipeline (tests/compliance.test.ts DRY_RUN_POSTS).
   */
  private preview(c: Ctx): MockResponse {
    const gid = decodeURIComponent(c.match[1]);
    this.requireGroup(c.doc, gid);
    const size = new TextEncoder().encode(c.body ?? '').length;
    if (size > c.doc.options.kvMaxBodyBytes) return text(413, 'PayloadTooLargeError: request entity too large');
    const body = parseJsonBody(c.body) as { mode?: unknown; pipelineId?: unknown; events?: unknown };
    if (body?.mode !== 'pipe') return apiError(400, "mock: only mode 'pipe' is emulated (the App previews a pipeline, nothing else)");
    if (typeof body.pipelineId !== 'string' || body.pipelineId === '') return apiError(400, "'pipelineId' is required");
    if (!Array.isArray(body.events)) return apiError(400, "'events' must be an array");
    const config = this.working(c.doc, gid);
    const pipelineId = body.pipelineId;
    if (!config.pipelines.some((p) => p.id === pipelineId)) return apiError(404, `Pipeline ${pipelineId} not found`);
    const source = RIG.sources.find((s) => s.pipelineId === pipelineId);
    const retention = pipelineRetention(config, pipelineId, { ...(source?.trimRetention !== undefined ? { trimRetention: source.trimRetention } : {}), ...(source?.dropRetention !== undefined ? { dropRetention: source.dropRetention } : {}) });
    const items = previewEvents(body.events, retention, pipelineId);
    return json(200, { count: items.length, items });
  }

  // alert delivery through Cribl ─────────────────────────────────────────────
  /** Bell messages, newest first (the order `GET /system/messages` lists them live). */
  bell(): BellMessage[] {
    return readJson<BellMessage[]>(this.store.get(BELL_KEY)) ?? [];
  }
  private saveBell(items: BellMessage[]): void {
    this.store.set(BELL_KEY, JSON.stringify(items.slice(0, BELL_MAX)));
  }
  private bellPost(c: Ctx): MockResponse {
    const body = parseJsonBody(c.body) as Partial<BellMessage> & Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'body must be a JSON object');
    if (!BELL_SEVERITIES.includes(body.severity as BellMessage['severity'])) {
      return json(400, { status: 'error', message: 'invalid BulletinMessage', errors: [{ instancePath: '/severity', params: { allowedValues: [...BELL_SEVERITIES] } }] });
    }
    const items = this.bell();
    const id = typeof body.id === 'string' && body.id !== '' ? body.id : hashHex40(`bell|${c.now}|${items.length}`).slice(0, 32);
    // MEASURED: an id is write-once — re-posting it (any severity or text) answers 409 and changes nothing.
    if (items.some((m) => m.id === id)) return apiError(409, `Entity with "${id}" ID already exists.`);
    const msg: BellMessage = {
      id,
      severity: body.severity as BellMessage['severity'],
      title: typeof body.title === 'string' ? body.title : '',
      text: typeof body.text === 'string' ? body.text : '',
      time: typeof body.time === 'number' && Number.isFinite(body.time) ? body.time : c.now, // MEASURED: filled when omitted
    };
    this.saveBell([msg, ...items]);
    return json(200, counted([msg]));
  }
  private bellGet(c: Ctx): MockResponse {
    const id = decodeURIComponent(c.match[1]);
    const msg = this.bell().find((m) => m.id === id);
    return msg ? json(200, counted([msg])) : apiError(404, `Item '${id}' not found`);
  }
  private bellDelete(c: Ctx): MockResponse {
    const id = decodeURIComponent(c.match[1]);
    const items = this.bell();
    const gone = items.filter((m) => m.id === id);
    if (gone.length) this.saveBell(items.filter((m) => m.id !== id));
    return json(200, counted(gone)); // MEASURED: idempotent — a second DELETE answers 200 with no items
  }
  private bellRoute(method: string): MockResponse {
    if (method === 'DELETE') {
      this.store.delete(BELL_KEY);
      return json(200, { ok: true });
    }
    return json(200, { items: this.bell() });
  }
  private targetGet(c: Ctx): MockResponse {
    const id = decodeURIComponent(c.match[1]);
    const t = NOTIFICATION_TARGETS.find((x) => x.id === id);
    return t ? json(200, counted([clone(t)])) : apiError(404, `Notification target ${id} not found`);
  }

  // the Search relay: saved searches and their notifications, in `default_search` only
  private savedSearches(): Record<string, SavedSearchDoc> {
    return readJson<Record<string, SavedSearchDoc>>(this.store.get(SEARCH_KEY)) ?? {};
  }
  private saveSavedSearches(all: Record<string, SavedSearchDoc>): void {
    this.store.set(SEARCH_KEY, JSON.stringify(all));
  }
  private searchNotifications(): SearchNotificationDoc[] {
    return Object.values(this.savedSearches()).flatMap((s) => s.schedule.notifications?.items ?? []);
  }
  private requireSearchGroup(c: Ctx): void {
    const gid = decodeURIComponent(c.match[1]);
    if (gid !== SEARCH_GROUP) fail(404, `Group ${gid} has no saved searches (Search lives in ${SEARCH_GROUP})`);
  }
  private savedList(c: Ctx): MockResponse {
    this.requireSearchGroup(c);
    return json(200, counted(Object.values(this.savedSearches())));
  }
  private savedGet(c: Ctx): MockResponse {
    this.requireSearchGroup(c);
    const id = decodeURIComponent(c.match[2]);
    const saved = this.savedSearches()[id];
    return saved ? json(200, counted([saved])) : apiError(404, `Saved search ${id} not found`);
  }
  private savedPost(c: Ctx): MockResponse {
    this.requireSearchGroup(c);
    const body = parseJsonBody(c.body) as Partial<SavedSearchDoc>;
    if (!body || typeof body !== 'object' || typeof body.id !== 'string' || body.id === '') return apiError(400, "'id' is required");
    const all = this.savedSearches();
    if (all[body.id]) return apiError(409, `Entity with "${body.id}" ID already exists.`);
    const schedule = (body.schedule && typeof body.schedule === 'object' ? body.schedule : {}) as SavedSearchDoc['schedule'];
    const saved: SavedSearchDoc = { ...(body as SavedSearchDoc), id: body.id, schedule: { ...schedule, notifications: { items: [] } } };
    all[body.id] = saved;
    this.saveSavedSearches(all);
    return json(200, counted([saved]));
  }
  private savedNotificationsGet(c: Ctx): MockResponse {
    this.requireSearchGroup(c);
    const saved = this.savedSearches()[decodeURIComponent(c.match[2])];
    return saved ? json(200, counted(saved.schedule.notifications?.items ?? [])) : apiError(404, `Saved search ${decodeURIComponent(c.match[2])} not found`);
  }
  private savedNotificationsPost(c: Ctx): MockResponse {
    this.requireSearchGroup(c);
    const savedId = decodeURIComponent(c.match[2]);
    const all = this.savedSearches();
    const saved = all[savedId];
    if (!saved) return apiError(404, `Saved search ${savedId} not found`);
    const body = parseJsonBody(c.body) as Partial<SearchNotificationDoc>;
    if (!body || typeof body !== 'object' || typeof body.id !== 'string' || body.id === '') return apiError(400, "'id' is required");
    if (!Array.isArray(body.targets) || body.targets.some((t) => typeof t !== 'string')) return apiError(400, "'targets' must be an array of target ids");
    if (this.searchNotifications().some((n) => n.id === body.id)) return apiError(409, `Entity with "${body.id}" ID already exists.`);
    const notification: SearchNotificationDoc = {
      id: body.id,
      condition: typeof body.condition === 'string' ? body.condition : 'search',
      conf: body.conf && typeof body.conf === 'object' ? body.conf : {},
      targets: body.targets,
      group: SEARCH_GROUP,
      savedQueryId: savedId,
    };
    const items = saved.schedule.notifications?.items ?? [];
    all[savedId] = { ...saved, schedule: { ...saved.schedule, notifications: { items: [...items, notification] } } };
    this.saveSavedSearches(all);
    return json(201, counted([notification])); // MEASURED: 201
  }

  /**
   * `POST /search/notifications` (Leader-level). MEASURED: 500 until any search notification exists; then 200
   * for every body, delivering only when `id` starts with `SEARCH_NOTIFICATION_<notificationId>_` and that
   * notification exists (every other id is accepted and silently dropped). A delivery reaches each target of
   * the notification — captured in the sink when the target's URL is on a sink host — and upserts one bell
   * entry whose id is the notification id (replaced on each send, never accumulated).
   */
  private searchNotify(c: Ctx): MockResponse {
    const notifications = this.searchNotifications();
    if (notifications.length === 0) return apiError(500, 'Failed to process search notification.');
    const body = parseJsonBody(c.body) as Record<string, unknown>;
    const notificationId = typeof body?.notificationId === 'string' ? body.notificationId : '';
    const id = typeof body?.id === 'string' ? body.id : '';
    const notification = notifications.find((n) => n.id === notificationId);
    if (notification && id.startsWith(`${SEARCH_NOTIFICATION_PREFIX}${notificationId}_`)) {
      const message = typeof body.message === 'string' ? body.message : '';
      const event = { ...body, cribl_notification: notificationId, cribl_pipe: notificationId };
      for (const targetId of notification.targets) {
        const target = NOTIFICATION_TARGETS.find((t) => t.id === targetId);
        const url = typeof target?.url === 'string' ? target.url : undefined;
        if (!url) continue;
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          continue;
        }
        const host = parsed.hostname.toLowerCase();
        if (!c.doc.options.sinkHosts.includes(host)) continue;
        const slack = target?.type === 'slack';
        const payload = slack ? { text: message } : event;
        const raw = JSON.stringify(payload);
        this.capture({ at: c.now, method: 'POST', url, host, via: 'cribl-target', contentType: slack ? 'application/json' : 'application/x-ndjson', body: raw, json: payload, status: 200 });
      }
      const severity = BELL_SEVERITIES.includes(body.severity as BellMessage['severity']) ? (body.severity as BellMessage['severity']) : 'info';
      const entry: BellMessage = { id: notificationId, severity, title: 'Notification', text: message, time: c.now };
      this.saveBell([entry, ...this.bell().filter((m) => m.id !== notificationId)]);
    }
    return json(200, counted([{ message: 'Search notification request forwarded.' }]));
  }

  // version control ──────────────────────────────────────────────────────────
  private markPending(doc: MockDoc, path: string): void {
    if (!doc.pending.includes(path)) doc.pending.push(path);
  }
  private versionFiles(c: Ctx): MockResponse {
    const ref = c.query.get('commit');
    if (ref) return json(200, gitFiles(this.view(c.doc).commits, ref, c.match[1]));
    // Without `commit`: the uncommitted working-tree files (MEASURED equal to /version/status).
    const files = this.pendingIn(c.doc, c.match[1]);
    return json(200, { items: [{ count: files.length, items: fileTree(files), commitMessage: '' }], count: 1 });
  }
  private pendingIn(doc: MockDoc, gid: string | undefined): string[] {
    return gid ? doc.pending.filter((p) => p.startsWith(`groups/${gid}/`)) : [...doc.pending];
  }
  private versionStatus(c: Ctx): MockResponse {
    if (c.match[1]) this.requireGroup(c.doc, c.match[1]);
    const files = this.pendingIn(c.doc, c.match[1]);
    const preexisting = new Set(PREEXISTING_PENDING);
    const untracked = files.filter((f) => preexisting.has(f));
    const modified = files.filter((f) => !preexisting.has(f));
    return json(
      200,
      counted([
        {
          not_added: untracked,
          conflicted: [],
          created: [],
          deleted: [],
          modified,
          renamed: [],
          files: files.map((path) => (preexisting.has(path) ? { path, index: '?', working_dir: '?' } : { path, index: ' ', working_dir: 'M' })),
          staged: [],
          ahead: 0,
          behind: 0,
          current: 'master',
          detached: false,
        },
      ]),
    );
  }
  private commitRoute(c: Ctx): MockResponse {
    const gid = c.match[1];
    if (gid) this.requireGroup(c.doc, gid);
    const body = parseJsonBody(c.body) as { message?: unknown; files?: unknown; effective?: unknown };
    if (!body || typeof body.message !== 'string' || body.message.trim() === '') return apiError(400, "'message' is required");
    if (body.effective === true && !gid) return apiError(400, '"effective" param must be used with "group"');
    if (body.files !== undefined && (!Array.isArray(body.files) || body.files.some((f) => typeof f !== 'string'))) return apiError(400, "'files' must be an array of paths");
    const result = this.commit(c.doc, { message: body.message, files: body.files as string[] | undefined, scope: gid, at: c.now });
    this.saveDoc(c.doc);
    return json(200, result ? counted([commitSummary(result)]) : { count: 1, items: [{}] });
  }

  /** Commits pending files (explicit list, or — like the platform — everything pending in scope). */
  private commit(doc: MockDoc, args: { message: string; files?: string[]; scope?: string; at: number }): SyntheticCommit | null {
    const inScope = this.pendingIn(doc, args.scope);
    let selected: string[];
    if (args.files === undefined) {
      if (doc.options.strictCommits) fail(400, 'mock (strictCommits): pass an explicit files list; never commit everything pending');
      selected = inScope;
      if (selected.length > 0) doc.violations.push({ at: args.at, message: `commit "${args.message}" had no files list and swept in ${selected.length} pending file(s): ${selected.join(', ')}` });
    } else selected = [...new Set(args.files)].filter((f) => doc.pending.includes(f));
    if (selected.length === 0) return null;
    const base = this.base(doc);
    const touched = [...new Set(selected.map((f) => parseFile(f)?.gid).filter((g): g is string => !!g && !!base.configs[g]))];
    const before: Record<string, GroupConfig> = {};
    const after: Record<string, GroupConfig> = {};
    for (const g of touched) {
      before[g] = materialize(base.configs[g], doc.committed[g]);
      const committed = clone(doc.committed[g] ?? {});
      for (const f of selected) {
        const ref = parseFile(f);
        if (ref && ref.gid === g) copyFile(doc.working[g] ?? {}, committed, ref);
      }
      doc.committed[g] = committed;
      after[g] = materialize(base.configs[g], committed);
    }
    const diff = selected.map((f) => {
      const g = parseFile(f)?.gid;
      const b = g && before[g] ? fileContent(before[g], f) : null;
      const a = g && after[g] ? fileContent(after[g], f) : null;
      return b === null && a === null ? diffFile(f, null, `# ${f.split('/').pop()} (managed by Cribl)\n`) : diffFile(f, b, a);
    });
    const commit: SyntheticCommit = {
      hash: hashHex40(`${doc.seed}|${doc.createdAt}|${args.at}|${args.message}|${selected.join(',')}|${doc.commits.length}`),
      at: args.at,
      message: args.message,
      author: { ...COMMIT_AUTHOR },
      files: selected,
      diff,
    };
    doc.commits.push(commit);
    doc.snapshots[commit.hash] = clone(doc.committed);
    doc.pending = doc.pending.filter((p) => !selected.includes(p));
    return commit;
  }

  // ── levers (what a member does in the Cribl UI, or the demo backend does) ──
  private lever(doc: MockDoc, gid: string, at: number, mutate: (cfg: GroupConfig) => { config: GroupConfig; files: string[]; message: string }): SyntheticCommit | null {
    const base = this.base(doc);
    const working = this.working(doc, gid);
    const r = mutate(working);
    if (r.files.every((f) => fileContent(working, f) === fileContent(r.config, f))) return null; // already in that state
    doc.working[gid] = overlayFrom(doc.working[gid] ?? {}, base.configs[gid], r.config, r.files);
    for (const f of r.files) this.markPending(doc, f);
    const commit = this.commit(doc, { message: r.message, files: r.files, scope: gid, at });
    if (commit) this.deploy(doc, gid, commit.hash, at);
    return commit;
  }

  // ── control API ───────────────────────────────────────────────────────────
  private controlRoute(method: string, body: string | null): MockResponse {
    if (method === 'GET') return json(200, this.state());
    if (method !== 'POST') return apiError(405, 'POST a control action');
    const action = parseJsonBody(body) as ControlAction;
    return json(200, this.control(action));
  }
  private sinkRoute(method: string): MockResponse {
    if (method === 'DELETE') {
      this.store.delete(SINK_KEY);
      return json(200, { ok: true });
    }
    return json(200, { items: this.sink() });
  }
  private callsRoute(method: string): MockResponse {
    if (method === 'DELETE') {
      this.resetCalls();
      return json(200, { ok: true });
    }
    return json(200, this.calls());
  }

  /** Drives the emulated org. Returns what changed (commits made, the time the effect starts). */
  control(action: ControlAction): Record<string, unknown> {
    if (!action || typeof action !== 'object' || typeof (action as { action?: unknown }).action !== 'string') fail(400, 'body must be { action: ... }');
    const doc = this.loadDoc();
    const now = this.wallClock() + doc.clockOffsetMs;
    const when = (a: { at?: number; minutesAgo?: number }): number => (typeof a.at === 'number' ? a.at : typeof a.minutesAgo === 'number' ? now - a.minutesAgo * MINUTE_MS : now);
    const gid = RIG.groupId;
    const commits: SyntheticCommit[] = [];
    const push = (c: SyntheticCommit | null): void => void (c && commits.push(c));
    const requireDemo = (): void => {
      if (doc.preset !== 'demo') fail(400, `the ${action.action} lever needs the demo preset`);
    };
    switch (action.action) {
      case 'reset': {
        const fresh = this.newDoc(action.preset ?? 'demo', action.seed ?? 42, action.flows, action.options, 0);
        this.saveDoc(fresh);
        if (!action.keepKv) this.clearKv();
        this.store.delete(SINK_KEY);
        this.store.delete(BELL_KEY);
        this.store.delete(SEARCH_KEY);
        this.resetCalls();
        this.rate = { minute: -1, calls: 0 };
        return { ok: true, ...this.state() };
      }
      case 'advance':
        if (typeof action.minutes !== 'number' || !Number.isFinite(action.minutes)) fail(400, 'advance needs { minutes }');
        doc.clockOffsetMs += action.minutes * MINUTE_MS;
        break;
      case 'setClock':
        if (typeof action.at !== 'number') fail(400, 'setClock needs { at } (epoch ms)');
        doc.clockOffsetMs = action.at - this.wallClock();
        break;
      case 'breakTrim': {
        requireDemo();
        const at = when(action);
        if (action.withPacks)
          for (const [dt, routeId] of [[70_000, 'mrd_windows_workstations'], [55_000, 'mrd_pan_firewall'], [40_000, 'mrd_vpc_flow']] as const)
            push(this.lever(doc, gid, at - dt, (cfg) => rigApplyPack(cfg, gid, routeId)));
        push(this.lever(doc, gid, at, (cfg) => rigBreakTrim(cfg, gid, action.pipelineId)));
        break;
      }
      case 'restore':
        requireDemo();
        push(this.lever(doc, gid, when(action), (cfg) => rigRestoreTrim(cfg, gid, action.pipelineId)));
        break;
      case 'applyPack':
        requireDemo();
        push(this.lever(doc, gid, when(action), (cfg) => rigApplyPack(cfg, gid, action.routeId, action.level ?? 'pack')));
        break;
      case 'revertPack':
        requireDemo();
        push(this.lever(doc, gid, when(action), (cfg) => rigRevertPack(cfg, gid, action.routeId)));
        break;
      case 'setRate':
      case 'spike':
      case 'calm': {
        requireDemo();
        const inputId = action.inputId ?? 'mrd_payments_api';
        const multiplier = action.action === 'setRate' ? action.multiplier : action.action === 'spike' ? (action.multiplier ?? 5) : 1;
        push(this.lever(doc, gid, when(action), (cfg) => rigSetRate(cfg, gid, inputId, multiplier)));
        break;
      }
      case 'fault': {
        if ((typeof action.path !== 'string' && typeof action.pattern !== 'string') || typeof action.status !== 'number') fail(400, 'fault needs { path | pattern, status }');
        if (typeof action.pattern === 'string') {
          try {
            new RegExp(action.pattern);
          } catch {
            fail(400, `invalid fault pattern ${action.pattern}`);
          }
        }
        const f: Fault = {
          status: action.status,
          times: action.times ?? 1,
          ...(typeof action.path === 'string' ? { path: action.path } : {}),
          ...(typeof action.pattern === 'string' ? { pattern: action.pattern } : {}),
          ...(action.method ? { method: action.method } : {}),
          ...(action.body !== undefined ? { body: action.body } : {}),
        };
        doc.faults.push(f);
        break;
      }
      case 'clearFaults':
        doc.faults = [];
        break;
      case 'config':
        doc.options = { ...doc.options, ...(action.options ?? {}) };
        break;
      case 'clearKv':
        this.clearKv();
        return { ok: true };
      case 'seedRollups': {
        // Rollup history for a custom range on the Receipt (testdata/rollups.ts), written straight into KV.
        const at = typeof action.at === 'number' ? action.at : now;
        const prices = isPricesDoc(action.prices) ? action.prices : SEED_PRICES;
        const seed = seedRollupDocs({
          world: this.view(doc).world,
          at,
          prices,
          ...(typeof action.since === 'number' ? { since: action.since } : {}),
          ...(typeof action.tz === 'string' ? { tz: action.tz } : {}),
          ...(typeof action.dayDays === 'number' ? { dayDays: action.dayDays } : {}),
        });
        const entries = Object.entries(seedToKv(seed));
        let bytes = 0;
        for (const [key, value] of entries) {
          this.store.set(KV_PREFIX + key, value);
          this.store.delete(KV_ENC_PREFIX + key);
          bytes += value.length;
        }
        return { ok: true, at, keys: entries.length, bytes, firstRowMs: seed.firstRowMs, lastRowMs: seed.lastRowMs };
      }
      case 'seedInventory': {
        const at = when(action);
        const inventory = toInventoryDoc(this.view(doc).world, at);
        this.store.set(`${KV_PREFIX}inventory`, JSON.stringify(inventory));
        this.store.delete(`${KV_ENC_PREFIX}inventory`);
        return { ok: true, at, groups: Object.keys(inventory.byGroup).length };
      }
      case 'runnerSweep': {
        const at = when(action);
        const owner = typeof action.owner === 'string' && action.owner !== '' ? action.owner : 'runner:workhorse:1';
        const meta = readJson<Record<string, unknown>>(this.store.get(`${KV_PREFIX}meta`));
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return fail(409, 'runnerSweep needs a plain JSON meta document in KV');
        const minute = floorMinute(at);
        const through = typeof meta.meteredThrough === 'string' ? Date.parse(meta.meteredThrough) : Number.NaN;
        const next = {
          ...meta,
          lastSweepAt: iso(at),
          lastSweepOwner: owner,
          lastSweepMode: 'scheduled',
          lastSweepCalls: 23,
          sweepCount: (typeof meta.sweepCount === 'number' ? meta.sweepCount : 0) + 1,
          meteredThrough: iso(Math.max(Number.isFinite(through) ? through : 0, minute)),
        };
        this.store.set(`${KV_PREFIX}meta`, JSON.stringify(next));
        const snapshot = readJson<Record<string, unknown>>(this.store.get(`${KV_PREFIX}snapshot`));
        if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
          this.store.set(`${KV_PREFIX}snapshot`, JSON.stringify({ ...snapshot, sweepAt: iso(at), windowStart: iso(minute - MINUTE_MS), windowEnd: iso(minute), mode: 'scheduled' }));
        }
        return { ok: true, at, owner, meteredThrough: next.meteredThrough };
      }
      case 'clearSink':
        this.store.delete(SINK_KEY);
        return { ok: true };
      case 'resetCalls':
        this.resetCalls();
        return { ok: true };
      case 'state':
        return this.state();
      default:
        fail(400, `unknown action ${(action as { action: string }).action}`);
    }
    this.saveDoc(doc);
    const effectiveAt = commits.length ? ceilMinute(commits[commits.length - 1].at + doc.options.deployLagSec * 1000) : undefined;
    return {
      ok: true,
      now: this.wallClock() + doc.clockOffsetMs,
      commits: commits.map((c) => ({ hash: c.hash, message: c.message, at: c.at, files: c.files })),
      ...(effectiveAt !== undefined ? { effectiveAt } : {}),
    };
  }

  /** A readable summary of the emulated org (GET /mock-api/_state). */
  state(): Record<string, unknown> {
    const doc = this.loadDoc();
    const view = this.view(doc);
    const now = this.wallClock() + doc.clockOffsetMs;
    return {
      preset: doc.preset,
      seed: doc.seed,
      rigSource: doc.preset === 'demo' ? RIG_SOURCE : undefined,
      rev: doc.rev,
      now,
      nowIso: new Date(now).toISOString(),
      clockOffsetMs: doc.clockOffsetMs,
      createdAt: doc.createdAt,
      historyFrom: view.base.world.start,
      options: doc.options,
      flows: view.world.flows.length,
      groups: view.base.world.groups.map((g) => g.id),
      pending: doc.pending,
      commits: doc.commits.map((c) => ({ hash: c.hash, message: c.message, at: c.at, files: c.files })),
      deployed: doc.deployed,
      effects: doc.effects,
      faults: doc.faults,
      violations: doc.violations,
      kvKeys: this.store.keys(KV_PREFIX).length,
      sink: this.sink().length,
      bell: this.bell().length,
      relay: this.searchNotifications().map((n) => ({ id: n.id, savedQueryId: n.savedQueryId, targets: n.targets })),
    };
  }

  /** Commits touching a group, newest first (diagnostics). */
  commitsFor(gid: string): SyntheticCommit[] {
    return this.view(this.loadDoc()).commits.filter((c) => touchesGroup(c, gid)).sort((a, b) => b.at - a.at);
  }
}

interface View {
  base: BaseWorld;
  world: World;
  commits: SyntheticCommit[];
}

// ─── the preview model ───────────────────────────────────────────────────────
/** Repeats `s` (or cuts it) to exactly `n` characters. */
function fitTo(s: string, n: number): string {
  if (n <= 0 || s === '') return '';
  if (s.length >= n) return s.slice(0, n);
  return s.repeat(Math.ceil(n / s.length)).slice(0, n);
}
/**
 * The events a pipe-mode preview returns under a retention: `events` of them kept, evenly by index, and their
 * `_raw` resized so the total `_raw` length is the input's × `bytes` (largest remainder, so it is exact).
 */
export function previewEvents(events: readonly unknown[], retention: { bytes: number; events: number }, pipelineId: string): Record<string, unknown>[] {
  const objs = events.filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object' && !Array.isArray(e));
  const rawOf = (e: Record<string, unknown>): string => (typeof e._raw === 'string' ? e._raw : JSON.stringify(e));
  const inChars = objs.reduce((n, e) => n + rawOf(e).length, 0);
  const keepRatio = Math.min(1, Math.max(0, retention.events));
  const kept = objs.filter((_, i) => Math.floor((i + 1) * keepRatio) > Math.floor(i * keepRatio));
  const target = Math.round(inChars * Math.min(1, Math.max(0, retention.bytes)));
  const weights = kept.map((e) => rawOf(e).length);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || target === 0) return [];
  const exact = weights.map((w) => (target * w) / total);
  const shares = exact.map(Math.floor);
  let left = target - shares.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i]++;
    left--;
  }
  return kept
    .map((e, i) => ({ ...e, _raw: fitTo(rawOf(e), shares[i]), cribl_pipe: pipelineId }))
    .filter((e) => (e._raw as string).length > 0);
}

// ─── small parsing helpers ───────────────────────────────────────────────────
function readJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
function isPricesDoc(v: unknown): v is PricesDoc {
  return typeof v === 'object' && v !== null && Array.isArray((v as { versions?: unknown }).versions);
}
function parseJsonBody(body: string | null): unknown {
  if (body === null || body.trim() === '') return {};
  try {
    return JSON.parse(body);
  } catch {
    return fail(400, 'request body is not valid JSON');
  }
}
function numParam(q: URLSearchParams, name: string): number | undefined {
  const v = q.get(name);
  if (v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(400, `invalid '${name}' parameter`);
  return Math.floor(n);
}
function numParams(q: URLSearchParams, ...names: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of names) {
    const v = numParam(q, n);
    if (v !== undefined) out[n] = v;
  }
  return out;
}
function requiredParam(q: URLSearchParams, name: string): string {
  const v = q.get(name);
  return v === null || v === '' ? fail(400, `missing '${name}' parameter`) : v;
}
interface TreeNode {
  name: string;
  state?: string;
  children?: TreeNode[];
}
/** Paths → the Leader's GitFile tree (one node per path segment). */
function fileTree(paths: string[]): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const path of paths) {
    const segs = path.split('/');
    let level = roots;
    segs.forEach((seg, i) => {
      let node = level.find((n) => n.name === seg);
      if (!node) level.push((node = i === segs.length - 1 ? { name: seg, state: 'M' } : { name: seg, children: [] }));
      level = node.children ?? [];
    });
  }
  return roots;
}
function faultMatches(f: Fault, target: string): boolean {
  if (f.pattern !== undefined) {
    try {
      return new RegExp(f.pattern).test(target);
    } catch {
      return false;
    }
  }
  return f.path !== undefined && target.includes(f.path);
}
