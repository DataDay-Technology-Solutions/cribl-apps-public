// core/kv.ts — the only module that reads or writes App KV keys (SPEC 4, DECISIONS D13/D15).
//
// Layers:
//   • KvStore implementations: createHttpKvStore (over CriblHttp, so a counting wrapper also counts and caps
//     KV calls), createFetchKvStore (convenience: fetch → CriblHttp → KvStore) and createMemoryKvStore
//     (tests; enforces the Leader's ~100 KB value cap with a 413 like the real store).
//   • createKvDocs: typed get/put for every KV document in core/types.ts, with runtime guards, schemaVersion
//     migration and transparent chunking.
//
// Platform facts this module encodes (measured, see SPIKE.md and docs/platform/kv-backend.md):
//   • values are capped at ~100 KB (HTTP 413 above) → any document whose JSON exceeds 90,000 UTF-8 bytes is
//     stored as gzip+base64 chunks of ≤ 90,000 characters at `<key>/c/<n>`, and `<key>` holds a small manifest;
//   • PUT bodies are JSON.stringify(...) sent as text/plain (application/json stores "[object Object]");
//   • keys use '/' separators; ':' and '|' are rejected (a '|' 404s even when percent-encoded);
//   • a missing key answers 404 {"status":"error","message":"Key not found"}; PUT answers 201 with no body.
//
// Chunked write protocol: every chunk first, the manifest last, stale chunks deleted after the manifest
// lands. A reader verifies the manifest's FNV-1a hash of the reassembled JSON; on a mismatch (a writer was
// mid-flight) it re-reads the manifest once and retries if it changed, else it reports the document as
// missing. The KV store has no compare-and-set, so a reader can transiently get null for a chunked document
// while a sweep rewrites it — UI pollers should keep their last good copy.

import type {
  BaselinesDoc,
  Clock,
  CriblHttp,
  DemoState,
  HttpResult,
  IncidentsDoc,
  InventoryDoc,
  ISO,
  KvStore,
  Logger,
  Meta,
  NotifyLogDoc,
  PricesDoc,
  RollDayDoc,
  RollHourDoc,
  RollMinuteDoc,
  Settings,
  Snapshot,
  TimelineDoc,
  TotalsDoc,
} from './types.ts';
import { fnv1a, fromBase64, identityCodec, toBase64, utf8ByteLength, type Codec } from './codec.ts';
import { createFetchHttp, retryAfterOf, type FetchLike } from './http.ts';
import { kvKey, kvKeys } from './adapters/cribl-urls.ts';
import { storableSettings } from './settings.ts';

// ─── Keys ────────────────────────────────────────────────────────────────────
/** Single-document keys (SPEC 4, with '/' separators per D13). */
export const KEYS = {
  settings: 'settings',
  prices: 'prices',
  snapshot: 'snapshot',
  inventory: 'inventory',
  baselines: 'baselines',
  timeline: 'timeline',
  notifyLog: 'notify/log',
  lock: 'lock/meter',
  demoState: 'demo/state',
  tour: 'tour/active',
  meta: 'meta',
  totals: 'totals',
} as const;

/** Families of dated keys. */
export const PREFIXES = {
  rollMin: 'roll/min/',
  rollHour: 'roll/hour/',
  rollDay: 'roll/day/',
  incidents: 'incidents/',
} as const;

/** Documents whose JSON is larger than this many UTF-8 bytes are chunked. */
export const CHUNK_THRESHOLD_BYTES = 90_000;
/** Base64 characters per chunk (plus 2 quote characters once JSON-encoded: 90,002 bytes). */
export const CHUNK_CHARS = 90_000;
/** The Leader's request-body cap for one KV value, as measured (1 MB → 413). */
export const KV_VALUE_CAP_BYTES = 100_000;
/** Refuse documents that would need more chunks than this (≈ 23 MB of base64; guards the 1,000-key cap). */
export const MAX_CHUNKS = 256;

const KEY_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const PREFIX_RE = /^(?:[A-Za-z0-9_.-]+\/?)*$/;
const CHUNK_KEY_RE = /\/c\/\d+$/;

/** Throws unless `key` is '/'-separated segments of [A-Za-z0-9_.-] (no ':' or '|', no empty segments). */
export function assertValidKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error(`invalid KV key "${key}": use '/'-separated segments of [A-Za-z0-9_.-]`);
}

function assertValidPrefix(prefix: string): void {
  if (!PREFIX_RE.test(prefix)) throw new Error(`invalid KV prefix "${prefix}"`);
}

export function chunkKey(key: string, index: number): string {
  return `${key}/c/${index}`;
}

/** True for `<key>/c/<n>` chunk keys, which listKeys() hides. */
export function isChunkKey(key: string): boolean {
  return CHUNK_KEY_RE.test(key);
}

function isoOf(t: number | string): string {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) throw new RangeError(`invalid time for a KV key: ${String(t)}`);
  return new Date(ms).toISOString();
}

/** `roll/min/YYYY-MM-DDTHH` — the UTC hour holding this instant's minute rows. */
export function rollMinuteKey(t: number | string): string {
  return PREFIXES.rollMin + isoOf(t).slice(0, 13);
}
/** `roll/hour/YYYY-MM-DD` (UTC day). */
export function rollHourKey(t: number | string): string {
  return PREFIXES.rollHour + isoOf(t).slice(0, 10);
}
/** `roll/day/YYYY-MM` (UTC month). */
export function rollDayKey(t: number | string): string {
  return PREFIXES.rollDay + isoOf(t).slice(0, 7);
}
/** `incidents/YYYY-MM-DD` (UTC day the incident opened). */
export function incidentsKey(t: number | string): string {
  return PREFIXES.incidents + isoOf(t).slice(0, 10);
}

// ─── Errors ──────────────────────────────────────────────────────────────────
/** A KV call answered with an unexpected status (0 = network error / timeout). 413 = value too large. */
export class KvHttpError extends Error {
  readonly op: 'GET' | 'PUT' | 'DELETE' | 'LIST';
  readonly key: string;
  readonly status: number;
  /** A 429's Retry-After in ms, when the Leader sent one (EPIC_AUDIT P1-E01: the sweep's retry waits it out). */
  readonly retryAfterMs: number | undefined;
  constructor(op: 'GET' | 'PUT' | 'DELETE' | 'LIST', key: string, status: number, detail?: string, retryAfterMs?: number) {
    super(`KV ${op} ${key} failed: HTTP ${status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
    this.name = 'KvHttpError';
    this.op = op;
    this.key = key;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A KvHttpError for a failed answer, carrying a 429's Retry-After. */
function kvError(op: KvHttpError['op'], key: string, res: HttpResult): KvHttpError {
  return new KvHttpError(op, key, res.status, res.text, res.status === 429 ? retryAfterOf(res, Date.now()) : undefined);
}

/** A document too large even for chunking (more than MAX_CHUNKS chunks). */
export class KvDocTooLarge extends Error {
  readonly key: string;
  readonly bytes: number;
  readonly chunks: number;
  constructor(key: string, bytes: number, chunks: number, maxChunks: number) {
    super(`KV document ${key} is ${bytes} bytes → ${chunks} chunks (max ${maxChunks}); compact it before writing`);
    this.name = 'KvDocTooLarge';
    this.key = key;
    this.bytes = bytes;
    this.chunks = chunks;
  }
}

// ─── KvStore over CriblHttp ──────────────────────────────────────────────────
/**
 * If the Leader hands back the stored value wrapped as a JSON string (a double-encoded document), unwrap it.
 * A plain JSON document or a JSON-string chunk comes back unchanged.
 */
export function unwrapKvText(text: string): string {
  const t = text.trim();
  if (!t.startsWith('"')) return text;
  try {
    const inner: unknown = JSON.parse(t);
    if (typeof inner === 'string') {
      const s = inner.trim();
      if (s.startsWith('{') || s.startsWith('[') || s.startsWith('"')) return inner;
    }
  } catch {
    /* not a JSON string — return as stored */
  }
  return text;
}

/** Accepts string[] | {items|keys: string[]} | {items: [{key|name|id}]} and returns full key names. */
export function normalizeKeyList(body: unknown, prefix: string): string[] {
  const obj = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
  const list: unknown = Array.isArray(body) ? body : (obj?.items ?? obj?.keys ?? obj?.data);
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const entry of list) {
    let name: unknown = entry;
    if (entry !== null && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      name = e.key ?? e.name ?? e.id;
    }
    if (typeof name !== 'string') continue;
    const clean = name.replace(/^\/+/, '');
    if (clean.length > 0 && clean.startsWith(prefix)) out.add(clean);
  }
  return [...out].sort();
}

/**
 * Some App UI proxy builds reject the fetch for a never-written key instead of answering 404, with
 * "Failed to execute 'close' on 'ReadableStreamDefaultController': … is not valid JSON" (observed live by
 * cc-cribl-executive-dashboard, docs/platform/kv-backend.md §1.3). createFetchHttp turns that rejection into
 * a status-0 result; only that exact signature is read as "missing" — any other network failure throws.
 */
function isProxyMissingKey(res: HttpResult): boolean {
  return res.status === 0 && /ReadableStreamDefaultController/.test(res.text ?? '') && /not valid JSON/.test(res.text ?? '');
}

/** App-scoped KV over any CriblHttp. Build it on the sweep's counting transport so KV calls count too. */
export function createHttpKvStore(http: CriblHttp): KvStore {
  return {
    async get(key) {
      const res = await http.request('GET', kvKey(key), undefined, { raw: true });
      if (res.status === 404 || isProxyMissingKey(res)) return null;
      if (!res.ok) throw kvError('GET', key, res);
      return unwrapKvText(res.text ?? (res.json === undefined ? '' : JSON.stringify(res.json)));
    },
    async put(key, value) {
      // raw: the value is already JSON text; it goes out verbatim as text/plain. Never parse the 201 body.
      const res = await http.request('PUT', kvKey(key), value, { raw: true });
      if (!res.ok) throw kvError('PUT', key, res);
    },
    async del(key) {
      const res = await http.request('DELETE', kvKey(key), undefined, { raw: true });
      if (res.status === 404) return; // already gone
      if (!res.ok) throw kvError('DELETE', key, res);
    },
    async list(prefix) {
      const res = await http.request('POST', kvKeys(), { prefix });
      if (!res.ok) throw kvError('LIST', prefix, res);
      let body: unknown = res.json;
      if (body === undefined && res.text) {
        try {
          body = JSON.parse(res.text);
        } catch {
          body = undefined;
        }
      }
      return normalizeKeyList(body, prefix);
    },
  };
}

export interface FetchKvStoreOptions {
  fetch: FetchLike;
  /** window.CRIBL_API_URL (UI) or '/api/v1' (backend). */
  baseUrl: string;
  timeoutMs?: number;
}

/** KvStore straight over fetch. Prefer createHttpKvStore(countingHttp) inside a sweep. */
export function createFetchKvStore(options: FetchKvStoreOptions): KvStore {
  return createHttpKvStore(createFetchHttp(options));
}

// ─── In-memory KvStore (tests, demo tour) ────────────────────────────────────
export interface KvOp {
  op: 'get' | 'put' | 'del' | 'list';
  key: string;
}
export interface MemoryKvStore extends KvStore {
  /** Live contents. */
  readonly data: Map<string, string>;
  /** Every call in order (for ordering and budget assertions). */
  readonly ops: KvOp[];
}
export interface MemoryKvOptions {
  /** Values larger than this many UTF-8 bytes throw KvHttpError 413. Default KV_VALUE_CAP_BYTES. */
  maxValueBytes?: number;
  initial?: Record<string, string>;
}

export function createMemoryKvStore(options: MemoryKvOptions = {}): MemoryKvStore {
  const cap = options.maxValueBytes ?? KV_VALUE_CAP_BYTES;
  const data = new Map<string, string>(Object.entries(options.initial ?? {}));
  const ops: KvOp[] = [];
  return {
    data,
    ops,
    async get(key) {
      ops.push({ op: 'get', key });
      return data.get(key) ?? null;
    },
    async put(key, value) {
      ops.push({ op: 'put', key });
      const bytes = utf8ByteLength(value);
      if (bytes > cap) throw new KvHttpError('PUT', key, 413, `PayloadTooLargeError: request entity too large (${bytes} > ${cap})`);
      data.set(key, value);
    },
    async del(key) {
      ops.push({ op: 'del', key });
      data.delete(key);
    },
    async list(prefix) {
      ops.push({ op: 'list', key: prefix });
      return [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

// ─── Chunk manifest ──────────────────────────────────────────────────────────
export type ChunkEncoding = 'gzip-base64' | 'identity-base64';
export interface ChunkManifest {
  schemaVersion: 1;
  chunked: true;
  encoding: ChunkEncoding;
  /** Number of chunk keys, `<key>/c/0` … `<key>/c/<chunks-1>`. */
  chunks: number;
  /** UTF-8 byte length of the document JSON. */
  bytes: number;
  /** FNV-1a (hex) of the document JSON. */
  sha: string;
  updatedAt?: ISO;
}

export function isChunkManifest(v: unknown): v is ChunkManifest {
  if (!isObj(v) || v.chunked !== true) return false;
  return (
    (v.encoding === 'gzip-base64' || v.encoding === 'identity-base64') &&
    Number.isInteger(v.chunks) &&
    (v.chunks as number) >= 1 &&
    typeof v.sha === 'string' &&
    typeof v.bytes === 'number'
  );
}

// ─── Runtime guards ──────────────────────────────────────────────────────────
type Obj = Record<string, unknown>;
function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isArr = Array.isArray;
function allValues(v: unknown, pred: (x: unknown) => boolean): boolean {
  return isObj(v) && Object.values(v).every(pred);
}

type Warn = (msg: string, data?: unknown) => void;

interface DocSpec {
  name: string;
  /** Newest schemaVersion this build writes. */
  latest: number;
  guard(doc: Obj): boolean;
  /** In-place repair of salvageable damage (e.g. drop non-object list entries). Runs before the guard. */
  repair?(doc: Obj, warn: Warn): void;
  /** Upgrades from version N to N+1. Version 0 = a document written without schemaVersion. */
  migrations?: Record<number, (doc: Obj) => Obj>;
}

/** Every v1 document: an unversioned legacy copy is accepted by stamping schemaVersion 1. */
const V1_MIGRATIONS: Record<number, (doc: Obj) => Obj> = { 0: (doc) => ({ ...doc, schemaVersion: 1 }) };

function dropBadItems(list: unknown[], ok: (x: unknown) => boolean, where: string, warn: Warn): unknown[] {
  const kept = list.filter(ok);
  if (kept.length !== list.length) warn(`dropped ${list.length - kept.length} malformed entries from ${where}`);
  return kept;
}

const flowsOk = (v: unknown): boolean => allValues(v, isArr);

const SPECS = {
  settings: {
    name: 'settings',
    latest: 1,
    migrations: V1_MIGRATIONS,
    guard: (d) =>
      isStr(d.displayTimezone) &&
      isObj(d.thresholds) &&
      isObj(d.budgets) &&
      isArr(d.notifications) &&
      isArr(d.excludedObjectKeys) &&
      isObj(d.humanize) &&
      isObj(d.demo) &&
      isObj(d.live) &&
      isObj(d.presenter) &&
      (d.runtime === undefined || d.runtime === 'backend' || d.runtime === 'ui'),
  },
  prices: {
    name: 'prices',
    latest: 1,
    migrations: V1_MIGRATIONS,
    guard: (d) => isArr(d.versions) && d.versions.every((v) => isObj(v) && isStr(v.effectiveFrom) && isObj(v.byOutputId)),
  },
  snapshot: {
    name: 'snapshot',
    latest: 1,
    migrations: V1_MIGRATIONS,
    guard: (d) => isStr(d.sweepAt) && isObj(d.headline) && isArr(d.flows) && isArr(d.destinations),
  },
  inventory: {
    name: 'inventory',
    latest: 1,
    migrations: V1_MIGRATIONS,
    guard: (d) =>
      isStr(d.hash) &&
      allValues(d.byGroup, (g) => isObj(g) && isArr(g.inputs) && isArr(g.outputs) && isArr(g.pipelines) && isArr(g.routes)),
  },
  baselines: {
    name: 'baselines',
    latest: 1,
    migrations: V1_MIGRATIONS,
    guard: (d) => isObj(d.byObject) && isObj(d.rules),
  },
  timeline: {
    name: 'timeline',
    latest: 1,
    migrations: V1_MIGRATIONS,
    repair(d, warn) {
      if (!isObj(d.byGroup)) return;
      for (const [gid, list] of Object.entries(d.byGroup)) {
        if (isArr(list)) d.byGroup[gid] = dropBadItems(list, (c) => isObj(c) && isStr(c.hash), `timeline.byGroup.${gid}`, warn);
      }
    },
    guard: (d) => allValues(d.byGroup, isArr),
  },
  notifyLog: {
    name: 'notify/log',
    latest: 1,
    migrations: V1_MIGRATIONS,
    repair(d, warn) {
      if (isArr(d.items)) d.items = dropBadItems(d.items, (x) => isObj(x) && isStr(x.endpointId), 'notify/log.items', warn);
    },
    guard: (d) => isArr(d.items),
  },
  demoState: {
    name: 'demo/state',
    latest: 1,
    migrations: V1_MIGRATIONS,
    guard: (d) => isObj(d.routes) && isObj(d.trim) && isObj(d.rates) && isObj(d.muted) && isNum(d.measuredLagSec),
  },
  meta: {
    name: 'meta',
    latest: 1,
    migrations: V1_MIGRATIONS,
    guard: (d) => isStr(d.installedAt) && isStr(d.collectingSince) && isNum(d.sweepErrors) && isNum(d.sweepCount),
  },
  totals: {
    name: 'totals',
    latest: 1,
    migrations: V1_MIGRATIONS,
    guard: (d) => isObj(d.byDay),
  },
  rollMinute: {
    name: 'roll/min',
    latest: 1,
    migrations: V1_MIGRATIONS,
    guard: (d) => isStr(d.bucketStart) && flowsOk(d.flows),
  },
  rollHour: {
    name: 'roll/hour',
    latest: 1,
    migrations: V1_MIGRATIONS,
    guard: (d) => isStr(d.day) && flowsOk(d.flows),
  },
  rollDay: {
    name: 'roll/day',
    latest: 1,
    migrations: V1_MIGRATIONS,
    guard: (d) => isStr(d.month) && flowsOk(d.flows),
  },
  incidents: {
    name: 'incidents',
    latest: 1,
    migrations: V1_MIGRATIONS,
    repair(d, warn) {
      if (isArr(d.items)) d.items = dropBadItems(d.items, (x) => isObj(x) && isStr(x.id), 'incidents.items', warn);
    },
    guard: (d) => isArr(d.items),
  },
} satisfies Record<string, DocSpec>;

/** Migrates, repairs and validates a parsed document. Returns null (after a warning) when unusable. */
function upgradeDoc(spec: DocSpec, value: unknown, key: string, warn: Warn): Obj | null {
  if (!isObj(value)) {
    warn(`KV ${key}: ${spec.name} is not a JSON object; treating as missing`);
    return null;
  }
  let doc: Obj = value;
  let version = doc.schemaVersion === undefined ? 0 : doc.schemaVersion;
  if (!Number.isInteger(version) || (version as number) < 0) {
    warn(`KV ${key}: ${spec.name} has an invalid schemaVersion; treating as missing`, { schemaVersion: doc.schemaVersion });
    return null;
  }
  if ((version as number) > spec.latest) {
    warn(`KV ${key}: ${spec.name} schemaVersion ${String(version)} is newer than this build (${spec.latest}); treating as missing`);
    return null;
  }
  while ((version as number) < spec.latest) {
    const step = spec.migrations?.[version as number];
    if (!step) {
      warn(`KV ${key}: no migration for ${spec.name} from schemaVersion ${String(version)}; treating as missing`);
      return null;
    }
    doc = step(doc);
    version = (version as number) + 1;
  }
  spec.repair?.(doc, (msg, data) => warn(`KV ${key}: ${msg}`, data));
  if (!spec.guard(doc)) {
    warn(`KV ${key}: ${spec.name} failed shape validation; treating as missing`);
    return null;
  }
  return doc;
}

// ─── Lock document ───────────────────────────────────────────────────────────
/**
 * The furthest ahead of now a lock may legitimately expire: the longest owner TTL is the sweep's 130 s (D50), so ten
 * minutes leaves room for clock skew between runtimes. A lock that claims more (a hand-written `lock/meter` with a
 * far-future expiry) would stop every runtime for as long as it says; it is treated as stale and taken over.
 */
export const MAX_LOCK_HOLD_MS = 10 * 60_000;
/** True while a lock held by someone else still binds at `now` (unexpired, and not further ahead than any owner writes). */
export function lockBinds(lock: LockDoc, now: number): boolean {
  const expires = Date.parse(lock.expiresAt);
  return expires > now && expires - now <= MAX_LOCK_HOLD_MS;
}
/** `lock/meter` (SPEC 4): the sweep lock. Released by expiring it in place, never by DELETE. */
export interface LockDoc {
  owner: string;
  expiresAt: ISO;
}

// ─── Typed documents ─────────────────────────────────────────────────────────
export interface KvDocsDeps {
  kv: KvStore;
  codec: Codec;
  clock: Clock;
  logger?: Logger;
  /** Overrides for tests. */
  chunkThresholdBytes?: number;
  chunkChars?: number;
  maxChunks?: number;
  /** Parallel chunk reads/writes. Default 4. */
  concurrency?: number;
}

export interface AcquireLockOptions {
  /** Re-read after writing and succeed only if we still own it (catches the two-tab race). Default true. */
  verify?: boolean;
}

export interface KvDocs {
  getSettings(): Promise<Settings | null>;
  putSettings(doc: Settings): Promise<void>;
  getPrices(): Promise<PricesDoc | null>;
  putPrices(doc: PricesDoc): Promise<void>;
  getSnapshot(): Promise<Snapshot | null>;
  putSnapshot(doc: Snapshot): Promise<void>;
  getInventory(): Promise<InventoryDoc | null>;
  putInventory(doc: InventoryDoc): Promise<void>;
  getBaselines(): Promise<BaselinesDoc | null>;
  putBaselines(doc: BaselinesDoc): Promise<void>;
  getTimeline(): Promise<TimelineDoc | null>;
  putTimeline(doc: TimelineDoc): Promise<void>;
  getNotifyLog(): Promise<NotifyLogDoc | null>;
  putNotifyLog(doc: NotifyLogDoc): Promise<void>;
  getDemoState(): Promise<DemoState | null>;
  putDemoState(doc: DemoState): Promise<void>;
  getMeta(): Promise<Meta | null>;
  putMeta(doc: Meta): Promise<void>;
  getTotals(): Promise<TotalsDoc | null>;
  putTotals(doc: TotalsDoc): Promise<void>;
  /** `key` is the full key (`roll/min/2026-09-26T03`) or just its date suffix (`2026-09-26T03`). */
  getRollMinute(key: string): Promise<RollMinuteDoc | null>;
  putRollMinute(key: string, doc: RollMinuteDoc): Promise<void>;
  getRollHour(key: string): Promise<RollHourDoc | null>;
  putRollHour(key: string, doc: RollHourDoc): Promise<void>;
  getRollDay(key: string): Promise<RollDayDoc | null>;
  putRollDay(key: string, doc: RollDayDoc): Promise<void>;
  getIncidents(key: string): Promise<IncidentsDoc | null>;
  putIncidents(key: string, doc: IncidentsDoc): Promise<void>;
  /** Document keys under `prefix`, sorted; chunk keys are hidden. */
  listKeys(prefix: string): Promise<string[]>;
  /**
   * listKeys() plus, from the same one listing, the chunk indexes stored under each document key (`<key>/c/<n>`):
   * enough to delete a document with no pre-read (EPIC_AUDIT P1-E08). A key with no entry was listed plain.
   */
  listKeysWithChunks(prefix: string): Promise<{ keys: string[]; chunks: Record<string, number[]> }>;
  /**
   * Deletes a document and, if it was chunked, its chunks. Without `listed` it first reads the key for a chunk
   * manifest (two calls for a plain document). With `listed` — the chunk indexes a listing just showed under it, []
   * for a plain key — it deletes straight away: one call for a plain document (P1-E08).
   */
  del(key: string, opts?: { listed?: readonly number[] }): Promise<void>;
  /** Takes `lock/meter` for `ttlMs` unless another owner holds an unexpired lock. Re-entrant for `owner`. */
  acquireLock(owner: string, ttlMs: number, opts?: AcquireLockOptions): Promise<boolean>;
  /** Expires the lock if `owner` holds it. Returns whether it did. */
  releaseLock(owner: string): Promise<boolean>;
  /**
   * Extends `owner`'s lock to `ttlMs` from now (a read, then a write): false, writing nothing, when the lock names
   * another owner (it expired and was taken) or is gone. A lock that expired but still names `owner` is renewed
   * and re-read, as acquireLock does, since another runtime may be taking it at that moment (EPIC_AUDIT P1-E02).
   */
  renewLock(owner: string, ttlMs: number): Promise<boolean>;
  getLock(): Promise<LockDoc | null>;
  /** Escape hatch for keys without a typed accessor (e.g. `tour/active`): same chunking, caller's guard. */
  getDoc<T>(key: string, guard: (v: unknown) => v is T): Promise<T | null>;
  putDoc(key: string, doc: unknown): Promise<void>;
  /** KV calls made through this instance (each is a Leader API request). */
  calls(): number;
  resetCalls(): void;
}

const NOOP_LOGGER: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
/** Sentinel for "present but unusable" (already warned about); distinct from null = "not stored". */
const CORRUPT: unique symbol = Symbol('corrupt');
/** A parsed document, null (missing) or CORRUPT. Spelled out for readers; TypeScript widens it to unknown. */
type Loaded = unknown;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Parses a stored value. '[object Object]' (an application/json PUT) and invalid JSON are CORRUPT. */
function parseStored(raw: string): unknown | typeof CORRUPT {
  if (raw.trim() === '[object Object]') return CORRUPT;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return CORRUPT;
  }
  // Tolerate one level of legacy double encoding: a JSON string that itself holds a JSON object/array.
  if (typeof v === 'string') {
    const inner = v.trim();
    if (inner.startsWith('{') || inner.startsWith('[')) {
      try {
        return JSON.parse(inner);
      } catch {
        /* a string that merely starts with a bracket: keep it as the value */
      }
    }
  }
  return v;
}

/** A chunk is stored as a JSON string of base64; tolerate a bare base64 value too. */
function chunkText(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"')) {
    const v: unknown = JSON.parse(t);
    if (typeof v !== 'string') throw new Error('chunk is not a string');
    return v;
  }
  return t;
}

function splitEvery(s: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
  return parts.length > 0 ? parts : [''];
}

export function createKvDocs(deps: KvDocsDeps): KvDocs {
  const logger = deps.logger ?? NOOP_LOGGER;
  const threshold = deps.chunkThresholdBytes ?? CHUNK_THRESHOLD_BYTES;
  const chunkChars = deps.chunkChars ?? CHUNK_CHARS;
  const maxChunks = deps.maxChunks ?? MAX_CHUNKS;
  const concurrency = deps.concurrency ?? 4;
  const warn: Warn = (msg, data) => logger.warn(msg, data);

  // Every call through `store` is counted: each one is a Leader API request.
  let calls = 0;
  const store: KvStore = {
    get(k) {
      calls++;
      return deps.kv.get(k);
    },
    put(k, v) {
      calls++;
      return deps.kv.put(k, v);
    },
    del(k) {
      calls++;
      return deps.kv.del(k);
    },
    list(p) {
      calls++;
      return deps.kv.list(p);
    },
  };

  /** Chunk count last seen for each key (0 = stored plain). Absent = unknown → a chunked write lists. */
  const knownChunks = new Map<string, number>();

  function codecFor(encoding: ChunkEncoding): Codec | null {
    if (encoding === 'identity-base64') return identityCodec;
    return deps.codec.encoding === 'identity' ? null : deps.codec;
  }

  async function assemble(key: string, m: ChunkManifest): Promise<{ text: string } | { reason: string }> {
    const raws = await mapLimit(
      Array.from({ length: m.chunks }, (_, i) => i),
      concurrency,
      (i) => store.get(chunkKey(key, i)),
    );
    const missing = raws.findIndex((r) => r === null);
    if (missing >= 0) return { reason: `chunk ${missing} of ${m.chunks} is missing` };
    const codec = codecFor(m.encoding);
    if (!codec) return { reason: `cannot decode ${m.encoding} with an identity codec` };
    let text: string;
    try {
      const b64 = (raws as string[]).map(chunkText).join('');
      text = await codec.gunzip(fromBase64(b64));
    } catch (e) {
      return { reason: `chunks do not decode: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (fnv1a(text) !== m.sha) return { reason: 'hash mismatch' };
    return { text };
  }

  async function readChunked(key: string, m: unknown, allowRetry: boolean): Promise<Loaded> {
    if (!isChunkManifest(m) || m.chunks > maxChunks) {
      warn(`KV ${key}: malformed chunk manifest; treating as missing`, m);
      return CORRUPT;
    }
    knownChunks.set(key, m.chunks);
    const got = await assemble(key, m);
    if ('text' in got) {
      const parsed = parseStored(got.text);
      if (parsed === CORRUPT) warn(`KV ${key}: reassembled document is not valid JSON; treating as missing`);
      return parsed;
    }
    if (allowRetry) {
      // A writer may have been mid-flight. If the manifest moved on, read the new generation once.
      const again = await store.get(key);
      if (again === null) return null;
      const next = parseStored(again);
      if (isObj(next) && next.chunked === true) {
        if (isChunkManifest(next) && next.sha !== m.sha) return readChunked(key, next, false);
      } else if (next !== CORRUPT) {
        knownChunks.set(key, 0);
        return next;
      }
    }
    warn(`KV ${key}: chunked document failed verification (${got.reason}); treating as missing`);
    return CORRUPT;
  }

  async function load(key: string): Promise<Loaded> {
    const raw = await store.get(key);
    if (raw === null) return null;
    const parsed = parseStored(raw);
    if (parsed === CORRUPT) {
      warn(`KV ${key}: stored value is not valid JSON; treating as missing`);
      return CORRUPT;
    }
    if (isObj(parsed) && parsed.chunked === true) return readChunked(key, parsed, true);
    knownChunks.set(key, 0);
    return parsed;
  }

  async function deleteChunkIndexes(key: string, indexes: number[]): Promise<void> {
    if (indexes.length === 0) return;
    try {
      await mapLimit(indexes, concurrency, (i) => store.del(chunkKey(key, i)));
    } catch (e) {
      warn(`KV ${key}: could not delete stale chunks (${indexes.join(',')}); they are unreferenced`, e);
    }
  }

  function range(from: number, to: number): number[] {
    return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
  }

  async function save(key: string, doc: unknown): Promise<void> {
    const json = JSON.stringify(doc);
    if (json === undefined) throw new TypeError(`KV ${key}: refusing to write a non-JSON value`);
    const bytes = utf8ByteLength(json);

    // A write never DELETEs (rules round 2, craft: AGENTS.md "Confirming Destructive Operations" never triggers a
    // DELETE from a background timer). Chunks a shorter or plain write leaves behind are unreferenced: a reader reads
    // exactly the manifest's `chunks` and verifies the hash, the next longer write overwrites them by PUT, and a dated
    // document's expiry (the one DELETE core issues, sweep.ts expireKeys) lists and removes every chunk it has.
    if (bytes <= threshold) {
      await store.put(key, json);
      knownChunks.set(key, 0);
      return;
    }

    const encoding: ChunkEncoding = deps.codec.encoding === 'identity' ? 'identity-base64' : 'gzip-base64';
    const parts = splitEvery(toBase64(await deps.codec.gzip(json)), chunkChars);
    if (parts.length > maxChunks) throw new KvDocTooLarge(key, bytes, parts.length, maxChunks);

    // 1) chunks, 2) manifest — a reader never sees a manifest whose chunks aren't written.
    await mapLimit(parts, concurrency, (p, i) => store.put(chunkKey(key, i), JSON.stringify(p)));
    const manifest: ChunkManifest = {
      schemaVersion: 1,
      chunked: true,
      encoding,
      chunks: parts.length,
      bytes,
      sha: fnv1a(json),
      updatedAt: new Date(deps.clock.now()).toISOString(),
    };
    await store.put(key, JSON.stringify(manifest));
    knownChunks.set(key, parts.length);
  }

  async function getTyped<T>(key: string, spec: DocSpec): Promise<T | null> {
    assertValidKey(key);
    const loaded = await load(key);
    if (loaded === null || loaded === CORRUPT) return null;
    return upgradeDoc(spec, loaded, key, warn) as T | null;
  }

  async function putTyped(key: string, spec: DocSpec, doc: unknown): Promise<void> {
    assertValidKey(key);
    if (!isObj(doc) || doc.schemaVersion !== spec.latest || !spec.guard(doc)) {
      throw new TypeError(`KV ${key}: refusing to write an invalid ${spec.name} document`);
    }
    await save(key, doc);
  }

  function familyKey(prefix: string, key: string): string {
    return key.startsWith(prefix) ? key : prefix + key.replace(/^\/+/, '');
  }

  function parseLock(v: Loaded): LockDoc | null {
    if (v === null || v === CORRUPT) return null;
    if (isObj(v) && isStr(v.owner) && isStr(v.expiresAt) && Number.isFinite(Date.parse(v.expiresAt))) {
      return { owner: v.owner, expiresAt: v.expiresAt };
    }
    warn(`KV ${KEYS.lock}: malformed lock; treating as free`, v);
    return null;
  }

  const readLock = async (): Promise<LockDoc | null> => parseLock(await load(KEYS.lock));
  const writeLock = (lock: LockDoc): Promise<void> => save(KEYS.lock, lock);

  return {
    getSettings: () => getTyped<Settings>(KEYS.settings, SPECS.settings),
    // D57: whatever the caller built, the stored document holds no webhook URL (rule 4.5; core/settings.ts).
    putSettings: (doc) => putTyped(KEYS.settings, SPECS.settings, storableSettings(doc)),
    getPrices: () => getTyped<PricesDoc>(KEYS.prices, SPECS.prices),
    putPrices: (doc) => putTyped(KEYS.prices, SPECS.prices, doc),
    getSnapshot: () => getTyped<Snapshot>(KEYS.snapshot, SPECS.snapshot),
    putSnapshot: (doc) => putTyped(KEYS.snapshot, SPECS.snapshot, doc),
    getInventory: () => getTyped<InventoryDoc>(KEYS.inventory, SPECS.inventory),
    putInventory: (doc) => putTyped(KEYS.inventory, SPECS.inventory, doc),
    getBaselines: () => getTyped<BaselinesDoc>(KEYS.baselines, SPECS.baselines),
    putBaselines: (doc) => putTyped(KEYS.baselines, SPECS.baselines, doc),
    getTimeline: () => getTyped<TimelineDoc>(KEYS.timeline, SPECS.timeline),
    putTimeline: (doc) => putTyped(KEYS.timeline, SPECS.timeline, doc),
    getNotifyLog: () => getTyped<NotifyLogDoc>(KEYS.notifyLog, SPECS.notifyLog),
    putNotifyLog: (doc) => putTyped(KEYS.notifyLog, SPECS.notifyLog, doc),
    getDemoState: () => getTyped<DemoState>(KEYS.demoState, SPECS.demoState),
    putDemoState: (doc) => putTyped(KEYS.demoState, SPECS.demoState, doc),
    getMeta: () => getTyped<Meta>(KEYS.meta, SPECS.meta),
    putMeta: (doc) => putTyped(KEYS.meta, SPECS.meta, doc),
    getTotals: () => getTyped<TotalsDoc>(KEYS.totals, SPECS.totals),
    putTotals: (doc) => putTyped(KEYS.totals, SPECS.totals, doc),
    getRollMinute: (key) => getTyped<RollMinuteDoc>(familyKey(PREFIXES.rollMin, key), SPECS.rollMinute),
    putRollMinute: (key, doc) => putTyped(familyKey(PREFIXES.rollMin, key), SPECS.rollMinute, doc),
    getRollHour: (key) => getTyped<RollHourDoc>(familyKey(PREFIXES.rollHour, key), SPECS.rollHour),
    putRollHour: (key, doc) => putTyped(familyKey(PREFIXES.rollHour, key), SPECS.rollHour, doc),
    getRollDay: (key) => getTyped<RollDayDoc>(familyKey(PREFIXES.rollDay, key), SPECS.rollDay),
    putRollDay: (key, doc) => putTyped(familyKey(PREFIXES.rollDay, key), SPECS.rollDay, doc),
    getIncidents: (key) => getTyped<IncidentsDoc>(familyKey(PREFIXES.incidents, key), SPECS.incidents),
    putIncidents: (key, doc) => putTyped(familyKey(PREFIXES.incidents, key), SPECS.incidents, doc),

    async listKeys(prefix) {
      assertValidPrefix(prefix);
      const names = await store.list(prefix);
      return [...new Set(names.map((k) => k.replace(/^\/+/, '')))].filter((k) => k.startsWith(prefix) && !isChunkKey(k)).sort();
    },

    async listKeysWithChunks(prefix) {
      assertValidPrefix(prefix);
      const names = [...new Set((await store.list(prefix)).map((k) => k.replace(/^\/+/, '')))].filter((k) => k.startsWith(prefix));
      const chunks: Record<string, number[]> = {};
      const keys: string[] = [];
      for (const k of names) {
        if (!isChunkKey(k)) {
          keys.push(k);
          continue;
        }
        const at = k.lastIndexOf('/c/');
        const index = Number(k.slice(at + 3));
        if (Number.isInteger(index) && index >= 0) (chunks[k.slice(0, at)] ??= []).push(index);
      }
      for (const list of Object.values(chunks)) list.sort((a, b) => a - b);
      return { keys: keys.sort(), chunks };
    },

    async del(key, opts) {
      assertValidKey(key);
      if (opts?.listed) {
        // The caller's listing says what is stored under the key: no pre-read (P1-E08).
        await store.del(key); // manifest first: a reader then sees "missing", never a half-deleted doc
        await deleteChunkIndexes(key, [...opts.listed]);
        knownChunks.delete(key);
        return;
      }
      let chunks = knownChunks.get(key) ?? 0;
      const raw = await store.get(key);
      if (raw !== null) {
        const parsed = parseStored(raw);
        if (isChunkManifest(parsed)) chunks = Math.max(chunks, Math.min(parsed.chunks, maxChunks));
        await store.del(key); // manifest first: a reader then sees "missing", never a half-deleted doc
      }
      await deleteChunkIndexes(key, range(0, chunks));
      knownChunks.delete(key);
    },

    async acquireLock(owner, ttlMs, opts = {}) {
      if (!owner) throw new Error('acquireLock needs a non-empty owner');
      const now = deps.clock.now();
      const current = await readLock();
      if (current && current.owner !== owner && lockBinds(current, now)) return false;
      await writeLock({ owner, expiresAt: new Date(now + Math.max(0, ttlMs)).toISOString() });
      if (opts.verify === false) return true;
      const back = await readLock();
      return back !== null && back.owner === owner;
    },

    async releaseLock(owner) {
      const current = await readLock();
      if (!current || current.owner !== owner) return false;
      // Expire in place (a PUT) rather than DELETE: the next acquirer overwrites it anyway.
      await writeLock({ owner, expiresAt: new Date(deps.clock.now()).toISOString() });
      return true;
    },

    async renewLock(owner, ttlMs) {
      if (!owner) throw new Error('renewLock needs a non-empty owner');
      const now = deps.clock.now();
      const current = await readLock();
      if (!current || current.owner !== owner) return false;
      await writeLock({ owner, expiresAt: new Date(now + Math.max(0, ttlMs)).toISOString() });
      if (Date.parse(current.expiresAt) > now) return true;
      const back = await readLock();
      return back !== null && back.owner === owner;
    },

    getLock: readLock,

    async getDoc<T>(key: string, guard: (v: unknown) => v is T): Promise<T | null> {
      assertValidKey(key);
      const loaded = await load(key);
      if (loaded === null || loaded === CORRUPT) return null;
      if (!guard(loaded)) {
        warn(`KV ${key}: document failed its guard; treating as missing`);
        return null;
      }
      return loaded;
    },

    async putDoc(key, doc) {
      assertValidKey(key);
      await save(key, doc);
    },

    calls: () => calls,
    resetCalls() {
      calls = 0;
    },
  };
}
