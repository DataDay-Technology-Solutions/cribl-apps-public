// testdata/gen.ts — the synthetic Cribl estate: seeded, reproducible and pure.
//
// PRD 12 (test agent, item 1). One module answers every "what would Cribl say?" question the tests,
// the in-browser emulator (src/mock) and the perf bench need:
//   (a) configuration: groups, inputs, outputs, pipelines and route tables in the REAL API shapes,
//       plus the normalized `InventoryDoc` the core builds from them;
//   (b) throughput: `metricsQuery()` answers a `POST /system/metrics/query` body with rows in exactly
//       the shape the Leader returns (docs/platform/metrics.md): epoch-second `starttime`/`endtime`,
//       split keys and `.as()` aliases as sibling keys, rollup rows that repeat the sum of the split
//       rows, omitted aggregations instead of zeros, missing series instead of zero rows, explicit zero
//       rows for configured-but-idle inputs, 3-part syslog keys, per-host rows on host splits;
//   (c) change history: `/version` log rows, `/version/show` diffJson and `/version/files` trees;
//   (d) the demo rig (PRD 9.1 / SPEC 14.2) and the scripted break-the-trim scenario (SPEC 16 S15).
//
// Determinism: nothing here reads Date.now() or Math.random(). The value of any series at minute m is
// a hash of (seed, flow, m), never the state of a sequential PRNG, so asking for [a,b) and then [c,d)
// returns the same numbers on the overlap as asking for [a,d) once. `now` is always a parameter.
//
// Portability: no DOM and no Node APIs. This file is compiled by the app, backend and test projects.

import type {
  FlowKey,
  GroupInventory,
  InputInfo,
  InventoryDoc,
  MetricsWindow,
  OutputInfo,
  PipelineInfo,
  RouteInfo,
} from '../core/types.ts';

// ─── Units ───────────────────────────────────────────────────────────────────
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** Decimal gigabyte, the pricing unit (SPEC 8: 1 GB = 1,000,000,000 bytes). */
export const GB = 1_000_000_000;

/** A fixed, documented default "end of history" so seeds alone reproduce a world: Sat 2026-09-26 00:00Z. */
export const DEFAULT_END = Date.UTC(2026, 8, 26, 0, 0, 0);

export const floorMinute = (t: number): number => Math.floor(t / MINUTE_MS) * MINUTE_MS;
export const ceilMinute = (t: number): number => Math.ceil(t / MINUTE_MS) * MINUTE_MS;
export const floorHour = (t: number): number => Math.floor(t / HOUR_MS) * HOUR_MS;
export const iso = (t: number): string => new Date(t).toISOString();

// ─── Hashing and stateless noise ─────────────────────────────────────────────
/** FNV-1a over UTF-16 code units; a stable 32-bit id for any string. */
export function hashString(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3's 32-bit finalizer applied to a combination of two words. */
function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b ^ (b >>> 15), 0x2c1b3c6d)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A uniform number in [0, 1) that depends only on its integer arguments (order-sensitive). */
export function unit(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) h = mix(h, p | 0);
  return h / 4294967296;
}

/** 40 lowercase hex characters derived from `text` — a stand-in for a git SHA-1. */
export function hashHex40(text: string): string {
  let out = '';
  for (let i = 0; i < 5; i++) out += mix(hashString(text, 0x811c9dc5 + i * 0x9e37), i + 1).toString(16).padStart(8, '0');
  return out;
}

/** Short hex checksum, as the diff API reports for file contents. */
function checksum(text: string | null): string {
  return text === null ? '0000000' : hashString(text).toString(16).padStart(8, '0').slice(0, 7);
}

// Salts keep the independent noise streams uncorrelated.
const SALT = { noise: 11, ratio: 13, quiet: 17, burst: 19, burstSize: 23, part: 29, wobble: 31, pick: 37 } as const;

/**
 * Splits a non-negative integer into integer parts proportional to `weights` so the parts sum to
 * exactly `total` (largest remainder; ties go to the lower index). Exactness is what lets tests
 * assert "split rows sum to the flow" with `===`.
 */
export function splitInteger(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (n === 1) return [total];
  let sumW = 0;
  for (const w of weights) sumW += w;
  const out = new Array<number>(n);
  const rema = new Array<number>(n);
  let assigned = 0;
  for (let i = 0; i < n; i++) {
    const exact = sumW > 0 ? (total * weights[i]) / sumW : total / n;
    out[i] = Math.floor(exact);
    rema[i] = exact - out[i];
    assigned += out[i];
  }
  let left = total - assigned;
  const order = rema.map((r, i) => [r, i] as const).sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) out[order[k][1]]++;
  return out;
}

// ─── Raw Cribl configuration shapes (only what we read or write) ─────────────
export interface CriblFunction {
  id: string;
  filter?: string;
  disabled?: boolean;
  final?: boolean;
  description?: string;
  conf: Record<string, unknown>;
  [key: string]: unknown;
}
export interface CriblPipeline {
  id: string;
  conf: { functions: CriblFunction[]; description?: string; output?: string; asyncFuncTimeout?: number; [key: string]: unknown };
  [key: string]: unknown;
}
export interface CriblRoute {
  id: string;
  name: string;
  final: boolean;
  disabled?: boolean;
  pipeline: string;
  output?: string;
  filter: string;
  description?: string;
  clones?: Record<string, string>[];
  enableOutputExpression?: boolean;
  [key: string]: unknown;
}
export interface CriblRouteTable {
  id: string;
  routes: CriblRoute[];
  groups?: Record<string, unknown>;
  comments?: unknown[];
  [key: string]: unknown;
}
export interface CriblInput {
  id: string;
  type: string;
  disabled?: boolean;
  description?: string;
  pipeline?: string;
  sendToRoutes?: boolean;
  connections?: { output: string; pipeline?: string }[];
  samples?: { sample: string; eventsPerSec: number }[];
  [key: string]: unknown;
}
export interface CriblOutput {
  id: string;
  type: string;
  disabled?: boolean;
  description?: string;
  pipeline?: string;
  defaultId?: string;
  [key: string]: unknown;
}
/** One worker group's configuration, as the `/m/<gid>/...` endpoints return it. */
export interface GroupConfig {
  inputs: CriblInput[];
  outputs: CriblOutput[];
  pipelines: CriblPipeline[];
  routes: CriblRouteTable;
}
/** A `/master/groups` item. */
export interface GroupRecord {
  id: string;
  type: string;
  description?: string;
  [key: string]: unknown;
}

// ─── The world model ─────────────────────────────────────────────────────────
export type FlowShape = 'diurnal' | 'flat' | 'bursty' | 'quiet';

/**
 * One priced path: input → route → pipeline → output. Volumes are measured at the source; the route
 * sees `preRetention` of them (Source pre-processing), and `ratio` is the route-level byte savings.
 */
export interface FlowSpec {
  /** Stable id used by effects; the route id for the rig, `f<index>` for synthetic estates. */
  id: string;
  groupId: string;
  inputId: string;
  inputType: string;
  routeId: string;
  routeName: string;
  pipelineId: string;
  outputId: string;
  outputType: string;
  /** Source bytes per day at volume multiplier 1 (decimal bytes). */
  bytesPerDay: number;
  /** Average bytes per event at the source. */
  eventBytes: number;
  /** Route-level byte savings: outB = inB × (1 − ratio). */
  ratio: number;
  /** Route-level event savings: outE = inE × (1 − eventRatio). */
  eventRatio: number;
  /** Fraction of source bytes that reach the route (pre-processing pipeline). */
  preRetention: number;
  shape: FlowShape;
  /** Volume multiplier on Saturdays and Sundays (UTC). */
  weekendFactor: number;
  /** Relative per-minute volume jitter (±). */
  noise: number;
  /** Absolute per-minute jitter on a non-zero ratio (±). */
  ratioNoise: number;
  /** Shifts the diurnal peak (hours). */
  phaseHours: number;
  /** No series before this instant (e.g. the rig's apply time). */
  activeFrom?: number;
  /** Rig flows derive their state from configuration (see rigFlowState). */
  derived?: boolean;
  /** Rig retention model inputs (see functionRetention). */
  trimRetention?: number;
  dropRetention?: number;
  /** Datagen events/second that corresponds to volume multiplier 1 (rig flows). */
  baselineEps?: number;
}

/**
 * A change to a flow over [start, end). For each field, the active effect with the latest start wins
 * (ties go to the later array entry), so a restore after a break simply starts a newer effect.
 */
export type Effect =
  | { kind: 'state'; flowId: string; start: number; end?: number; ratio?: number; eventRatio?: number; preRetention?: number; pipelineId?: string; note?: string }
  | { kind: 'volume'; flowId: string; start: number; end?: number; multiplier: number; note?: string }
  | { kind: 'outage'; flowId: string; start: number; end: number; note?: string };

/** A per-file diff in the `/version/show` `diffJson` shape (openapi DiffFiles). */
export interface DiffLine {
  type: 'insert' | 'delete' | 'context';
  content: string;
  oldNumber?: number;
  newNumber?: number;
}
export interface DiffBlock {
  header: string;
  lines: DiffLine[];
  oldStartLine: number;
  newStartLine: number;
}
export interface DiffFile {
  blocks: DiffBlock[];
  addedLines: number;
  deletedLines: number;
  isGitDiff: boolean;
  isNew?: boolean;
  isDeleted?: boolean;
  newFileMode?: string;
  deletedFileMode?: string;
  checksumBefore: string;
  checksumAfter: string;
  oldName: string;
  newName: string;
  language: string;
  isCombined: boolean;
  isTooBig: boolean;
}

/** A commit as the generator and the emulator keep it; rendered into API shapes on demand. */
export interface SyntheticCommit {
  hash: string;
  /** epoch ms */
  at: number;
  message: string;
  body?: string;
  author: { name: string; email: string };
  /** repo-root-relative paths, e.g. `groups/default/local/cribl/pipelines/<id>/conf.yml` */
  files: string[];
  diff: DiffFile[];
}

/** Ground truth for injected anomalies, so detector tests can assert what should fire. */
export interface Anomaly {
  kind: 'spike' | 'regression' | 'outage';
  flowId: string;
  start: number;
  end?: number;
  /** regression: ratio before and after; spike: volume multiplier */
  before?: number;
  after?: number;
  multiplier?: number;
  /** regression: the commit that caused it, when one exists */
  commitHash?: string;
  withCommit?: boolean;
}

export interface World {
  seed: number;
  /** Intended history range (queries outside it are still answered deterministically). */
  start: number;
  end: number;
  groups: GroupRecord[];
  /** worker node hostnames per group */
  hosts: Record<string, string[]>;
  processesPerHost: number;
  flows: FlowSpec[];
  effects: Effect[];
  commits: SyntheticCommit[];
  config: Record<string, GroupConfig>;
  anomalies: Anomaly[];
}

// ─── Per-minute evaluation ───────────────────────────────────────────────────
/** One flow's totals for one minute, summed over every host and worker process. */
export interface FlowMinute {
  t: number;
  present: boolean;
  /** bytes/events at the source (total.in_*) */
  srcB: number;
  srcE: number;
  /** bytes/events entering the route (route.in_*) */
  inB: number;
  inE: number;
  /** bytes/events leaving the route pipeline toward the output (route.out_*, total.out_*) */
  outB: number;
  outE: number;
  pipelineId: string;
  ratio: number;
}

interface FlowRuntime {
  hash: number;
  states: Extract<Effect, { kind: 'state' }>[];
  volumes: Extract<Effect, { kind: 'volume' }>[];
  outages: Extract<Effect, { kind: 'outage' }>[];
}
const runtimeCache = new WeakMap<World, Map<string, FlowRuntime>>();

function runtimeFor(world: World, flow: FlowSpec): FlowRuntime {
  let byFlow = runtimeCache.get(world);
  if (!byFlow) {
    byFlow = new Map();
    for (const f of world.flows) byFlow.set(f.id, { hash: hashString(`${world.seed}|${f.id}`), states: [], volumes: [], outages: [] });
    world.effects.forEach((e) => {
      const rt = byFlow!.get(e.flowId);
      if (!rt) return;
      if (e.kind === 'state') rt.states.push(e);
      else if (e.kind === 'volume') rt.volumes.push(e);
      else rt.outages.push(e);
    });
    runtimeCache.set(world, byFlow);
  }
  return byFlow.get(flow.id) ?? { hash: hashString(`${world.seed}|${flow.id}`), states: [], volumes: [], outages: [] };
}

const active = (e: { start: number; end?: number }, t: number): boolean => e.start <= t && (e.end === undefined || t < e.end);

/** Latest-start-wins resolution of one state field at time t. */
function stateField<K extends 'ratio' | 'eventRatio' | 'preRetention' | 'pipelineId'>(
  states: Extract<Effect, { kind: 'state' }>[],
  field: K,
  t: number,
): Extract<Effect, { kind: 'state' }>[K] | undefined {
  let best: Extract<Effect, { kind: 'state' }> | undefined;
  for (const e of states) {
    if (e[field] === undefined || !active(e, t)) continue;
    if (!best || e.start >= best.start) best = e;
  }
  return best?.[field];
}

/** Day of week, 0 = Sunday (1970-01-01 was a Thursday). */
const dayOfWeek = (t: number): number => (Math.floor(t / DAY_MS) + 4) % 7;

function shapeFactor(seed: number, fh: number, flow: FlowSpec, t: number): number {
  const minute = Math.floor(t / MINUTE_MS);
  let f = 1;
  if (flow.shape === 'diurnal') {
    const hour = (t % DAY_MS) / HOUR_MS + flow.phaseHours;
    f = 1 + 0.45 * Math.sin((2 * Math.PI * (hour - 9)) / 24); // peak ≈ 15:00 UTC, trough ≈ 03:00
  } else if (flow.shape === 'bursty') {
    const block = Math.floor(minute / 10);
    if (unit(seed, fh, block, SALT.burst) < 0.12) f = 2 + 3 * unit(seed, fh, block, SALT.burstSize);
  }
  const dow = dayOfWeek(t);
  if (dow === 0 || dow === 6) f *= flow.weekendFactor;
  return f;
}

/** The authoritative per-minute value of one flow (t is floored to the minute). */
export function flowMinute(world: World, flow: FlowSpec, time: number): FlowMinute {
  const t = floorMinute(time);
  const rt = runtimeFor(world, flow);
  const pipelineId = stateField(rt.states, 'pipelineId', t) ?? flow.pipelineId;
  const baseRatio = stateField(rt.states, 'ratio', t) ?? flow.ratio;
  const absent: FlowMinute = { t, present: false, srcB: 0, srcE: 0, inB: 0, inE: 0, outB: 0, outE: 0, pipelineId, ratio: baseRatio };
  if (flow.activeFrom !== undefined && t < flow.activeFrom) return absent;
  if (rt.outages.some((e) => active(e, t))) return absent;
  const minute = Math.floor(t / MINUTE_MS);
  if (flow.shape === 'quiet' && unit(world.seed, rt.hash, minute, SALT.quiet) < 0.45) return absent;

  let volume = 1;
  let volumeStart = -Infinity;
  for (const e of rt.volumes) {
    if (!active(e, t) || e.start < volumeStart) continue;
    volume = e.multiplier;
    volumeStart = e.start;
  }
  const jitter = 1 + flow.noise * (2 * unit(world.seed, rt.hash, minute, SALT.noise) - 1);
  const srcB = Math.round((flow.bytesPerDay / 1440) * shapeFactor(world.seed, rt.hash, flow, t) * jitter * volume);
  if (srcB <= 0) return absent;

  const pre = stateField(rt.states, 'preRetention', t) ?? flow.preRetention;
  const eventRatio = stateField(rt.states, 'eventRatio', t) ?? flow.eventRatio;
  const ratio =
    baseRatio > 0 ? Math.min(0.999, Math.max(0, baseRatio + flow.ratioNoise * (2 * unit(world.seed, rt.hash, minute, SALT.ratio) - 1))) : 0;
  const srcE = Math.max(1, Math.round(srcB / flow.eventBytes));
  const inB = Math.round(srcB * pre);
  const inE = srcE;
  const outB = Math.round(inB * (1 - ratio));
  const outE = Math.round(inE * (1 - eventRatio));
  return { t, present: true, srcB, srcE, inB, inE, outB, outE, pipelineId, ratio };
}

/** Per-minute arrays for one flow over [start, end) — the "series" view used by detector tests. */
export function flowSeries(world: World, flowId: string, start: number, end: number): FlowMinute[] {
  const flow = world.flows.find((f) => f.id === flowId);
  if (!flow) throw new Error(`unknown flow ${flowId}`);
  const out: FlowMinute[] = [];
  for (let t = ceilMinute(start); t < end; t += MINUTE_MS) out.push(flowMinute(world, flow, t));
  return out;
}

/** Sum of one flow's minutes over [start, end). */
export function flowTotals(world: World, flowId: string, start: number, end: number): Omit<FlowMinute, 't' | 'present' | 'pipelineId' | 'ratio'> & { minutes: number } {
  const acc = { srcB: 0, srcE: 0, inB: 0, inE: 0, outB: 0, outE: 0, minutes: 0 };
  for (const m of flowSeries(world, flowId, start, end)) {
    if (!m.present) continue;
    acc.srcB += m.srcB;
    acc.srcE += m.srcE;
    acc.inB += m.inB;
    acc.inE += m.inE;
    acc.outB += m.outB;
    acc.outE += m.outE;
    acc.minutes++;
  }
  return acc;
}

// ─── Metric points: how one minute of one flow lands in the metrics store ────
type Family = 'in' | 'out' | 'route' | 'pipe';
interface MetricDef {
  family: Family;
  pick: (v: PartValues) => number;
}
interface PartValues {
  srcB: number;
  srcE: number;
  inB: number;
  inE: number;
  outB: number;
  outE: number;
}
/** Every metric the synthetic store carries. Anything else has no data (its alias is omitted). */
export const METRIC_DEFS: Readonly<Record<string, MetricDef>> = {
  'total.in_bytes': { family: 'in', pick: (v) => v.srcB },
  'total.in_events': { family: 'in', pick: (v) => v.srcE },
  'total.out_bytes': { family: 'out', pick: (v) => v.outB },
  'total.out_events': { family: 'out', pick: (v) => v.outE },
  'route.in_bytes': { family: 'route', pick: (v) => v.inB },
  'route.out_bytes': { family: 'route', pick: (v) => v.outB },
  'route.in_events': { family: 'route', pick: (v) => v.inE },
  'route.out_events': { family: 'route', pick: (v) => v.outE },
  'route.dropped_events': { family: 'route', pick: (v) => v.inE - v.outE },
  'pipe.in_events': { family: 'pipe', pick: (v) => v.inE },
  'pipe.out_events': { family: 'pipe', pick: (v) => v.outE },
  'pipe.dropped_events': { family: 'pipe', pick: (v) => v.inE - v.outE },
};

/** The metrics-store dimension value for an input/output: `<type>:<id>`, syslog adds `:<protocol>`. */
export function inputDim(type: string, id: string, protocol?: string): string {
  return protocol ? `${type}:${id}:${protocol}` : `${type}:${id}`;
}
export const outputDim = (type: string, id: string): string => `${type}:${id}`;

interface Part {
  host: string;
  /** index of the worker process on its host */
  proc: number;
  weight: number;
}
const partCache = new WeakMap<World, Map<string, Part[]>>();

/** The (host, worker process) slices a flow's traffic is spread over, with stable uneven weights. */
function partsFor(world: World, flow: FlowSpec): Part[] {
  let byFlow = partCache.get(world);
  if (!byFlow) partCache.set(world, (byFlow = new Map()));
  let parts = byFlow.get(flow.id);
  if (!parts) {
    const fh = runtimeFor(world, flow).hash;
    const hosts = world.hosts[flow.groupId] ?? [`wn-${flow.groupId}-0`];
    parts = [];
    for (const [h, host] of hosts.entries())
      for (let p = 0; p < world.processesPerHost; p++) parts.push({ host, proc: p, weight: 0.6 + 0.8 * unit(fh, h, p, SALT.part) });
    byFlow.set(flow.id, parts);
  }
  return parts;
}

interface Point {
  family: Family;
  rollup: boolean;
  dims: Record<string, string>;
  values: PartValues;
}

function emptyValues(): PartValues {
  return { srcB: 0, srcE: 0, inB: 0, inE: 0, outB: 0, outE: 0 };
}

/** Configured, enabled inputs that carry no flow report explicit zero rows (as the live fixture shows). */
function idleInputDims(world: World): { groupId: string; dim: string }[] {
  const out: { groupId: string; dim: string }[] = [];
  for (const [groupId, cfg] of Object.entries(world.config)) {
    const busy = new Set(world.flows.filter((f) => f.groupId === groupId).map((f) => f.inputId));
    for (const input of cfg.inputs) {
      if (input.disabled === true || busy.has(input.id)) continue;
      if (input.type === 'cribl' || input.type === 'criblmetrics') continue;
      out.push({ groupId, dim: inputDim(input.type, input.id) });
      if (input.type === 'syslog') out.push({ groupId, dim: inputDim(input.type, input.id, 'tcp') });
    }
  }
  return out;
}
const idleCache = new WeakMap<World, { groupId: string; dim: string }[]>();

/**
 * Adds one minute of the store into `acc` (keyed by a dims signature): per-object points and the
 * group rollup point of every family in `families`, per host. Worker processes are summed here —
 * as the Leader does — except for syslog inputs, whose protocol listeners surface as separate
 * `:tcp` / `:udp` series (3-part keys the parser must fold).
 */
interface PointOptions {
  /** only this worker group's flows (a `__worker_group == '…'` conjunct in `where`) */
  group?: string;
  /**
   * Neither `splitBys` nor `where` mentions the host, so per-host points would only be summed again:
   * emit one point per flow (per protocol for syslog) without the host dimension. Totals are identical
   * because the per-part split is exact.
   */
  hostAgnostic?: boolean;
}

function addMinutePoints(world: World, t: number, families: ReadonlySet<Family>, acc: Map<string, Point>, opts: PointOptions = {}): void {
  const add = (family: Family, rollup: boolean, dims: Record<string, string>, v: PartValues): void => {
    let sig = family + (rollup ? '#' : '|');
    for (const k of Object.keys(dims)) sig += `${k}=${dims[k]};`;
    let p = acc.get(sig);
    if (!p) acc.set(sig, (p = { family, rollup, dims, values: emptyValues() }));
    p.values.srcB += v.srcB;
    p.values.srcE += v.srcE;
    p.values.inB += v.inB;
    p.values.inE += v.inE;
    p.values.outB += v.outB;
    p.values.outE += v.outE;
  };
  const emit = (flow: FlowSpec, pipelineId: string, common: Record<string, string>, inDim: string, v: PartValues): void => {
    if (families.has('in')) {
      add('in', false, { input: inDim, ...common }, v);
      add('in', true, common, v);
    }
    if (families.has('out')) {
      add('out', false, { output: outputDim(flow.outputType, flow.outputId), ...common }, v);
      add('out', true, common, v);
    }
    if (families.has('route')) {
      add('route', false, { route: flow.routeId, name: flow.routeName, input: inDim, ...common }, v);
      add('route', true, common, v);
    }
    if (families.has('pipe')) {
      add('pipe', false, { id: pipelineId, ...common }, v);
      add('pipe', true, common, v);
    }
  };
  for (const flow of world.flows) {
    if (opts.group !== undefined && flow.groupId !== opts.group) continue;
    const m = flowMinute(world, flow, t);
    if (!m.present) continue;
    const syslog = flow.inputType === 'syslog';
    if (opts.hostAgnostic && !syslog) {
      emit(flow, m.pipelineId, { __worker_group: flow.groupId, __dist_mode: 'worker' }, inputDim(flow.inputType, flow.inputId), m);
      continue;
    }
    const parts = partsFor(world, flow);
    const minute = Math.floor(t / MINUTE_MS);
    const fh = runtimeFor(world, flow).hash;
    const weights = parts.map((p, i) => p.weight * (0.95 + 0.1 * unit(fh, minute, i, SALT.wobble)));
    const split = {
      srcB: splitInteger(m.srcB, weights),
      srcE: splitInteger(m.srcE, weights),
      inB: splitInteger(m.inB, weights),
      inE: splitInteger(m.inE, weights),
      outB: splitInteger(m.outB, weights),
      outE: splitInteger(m.outE, weights),
    };
    parts.forEach((part, i) => {
      const v: PartValues = { srcB: split.srcB[i], srcE: split.srcE[i], inB: split.inB[i], inE: split.inE[i], outB: split.outB[i], outE: split.outE[i] };
      const common: Record<string, string> = opts.hostAgnostic
        ? { __worker_group: flow.groupId, __dist_mode: 'worker' }
        : { __worker_group: flow.groupId, __worker_node_hostname: part.host, __dist_mode: 'worker' };
      const inDim = syslog ? inputDim(flow.inputType, flow.inputId, part.proc % 2 === 0 ? 'tcp' : 'udp') : inputDim(flow.inputType, flow.inputId);
      emit(flow, m.pipelineId, common, inDim, v);
    });
  }
  if (families.has('in')) {
    let idle = idleCache.get(world);
    if (!idle) idleCache.set(world, (idle = idleInputDims(world)));
    for (const { groupId, dim } of idle) {
      if (opts.group !== undefined && groupId !== opts.group) continue;
      const common: Record<string, string> = opts.hostAgnostic
        ? { __worker_group: groupId, __dist_mode: 'worker' }
        : { __worker_group: groupId, __worker_node_hostname: (world.hosts[groupId] ?? [`wn-${groupId}-0`])[0], __dist_mode: 'worker' };
      add('in', false, { input: dim, ...common }, emptyValues());
      add('in', true, common, emptyValues());
    }
  }
}

// ─── The metrics query engine (POST /system/metrics/query) ───────────────────
export class MetricsQueryError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MetricsQueryError';
    this.status = status;
  }
}

export interface MetricsQueryBody {
  where?: string;
  earliest?: number | string;
  latest?: number | string;
  namespace?: string;
  alwaysBounds?: boolean;
  aggs?: { aggregations?: unknown; splitBys?: unknown; timeWindowSeconds?: unknown; cumulative?: unknown };
}
export type MetricsRow = Record<string, string | number>;
/** The Leader's full answer: rows plus the engine's own counters and the effective bucket (live envelope). */
export interface MetricsQueryResult {
  results: MetricsRow[];
  metrics: Record<string, number>;
  info: { timeWindowSeconds?: number; cumulative?: boolean };
}
export interface MetricsQueryOptions {
  /** The Leader's clock (epoch ms): only completed minutes before it have data. */
  now: number;
  /** Oldest data the store still holds, relative to `now` (default: unlimited). */
  retentionMs?: number;
}

interface AggSpec {
  fn: 'sum' | 'max' | 'min' | 'avg' | 'count';
  metric: string;
  alias: string;
}
const AGG_RE =
  /^\s*(sum|max|min|avg|count)\(\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w.]*))\s*\)\s*(?:\.as\(\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w]*))\s*\))?\s*$/;

function parseAggregation(text: string): AggSpec {
  const m = AGG_RE.exec(text);
  if (!m) throw new MetricsQueryError(400, `invalid aggregation: ${text}`);
  const metric = m[2] ?? m[3] ?? m[4];
  return { fn: m[1] as AggSpec['fn'], metric, alias: m[5] ?? m[6] ?? m[7] ?? text.trim() };
}

// A small parser for the `where` filter subset shipped apps use (metrics.md 4.3): ==, !=, &&, ||, !,
// parentheses, string/number literals, true/false, the bare `has_no_dimensions` predicate, and
// .startsWith/.endsWith/.includes on a dimension. Anything else is a 400, so an app that relies on
// unsupported syntax fails loudly in tests instead of silently matching nothing.
type Token = { k: 'id' | 'str' | 'num' | 'op' | 'eof'; v: string };
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (three === '===' || three === '!==') {
      out.push({ k: 'op', v: three.slice(0, 2) });
      i += 3;
    } else if (two === '==' || two === '!=' || two === '&&' || two === '||') {
      out.push({ k: 'op', v: two });
      i += 2;
    } else if ('()!.,'.includes(c)) {
      out.push({ k: 'op', v: c });
      i++;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        s += src[j++];
      }
      if (j >= src.length) throw new MetricsQueryError(400, `unterminated string in where: ${src}`);
      out.push({ k: 'str', v: s });
      i = j + 1;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][\w]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0] });
      i += m[0].length;
    } else throw new MetricsQueryError(400, `unsupported character '${c}' in where: ${src}`);
  }
  out.push({ k: 'eof', v: '' });
  return out;
}

type Val = string | number | boolean | undefined;
interface PointView {
  dims: Record<string, string>;
  rollup: boolean;
}
type Pred = (p: PointView) => Val;

function compileWhere(src: string): (p: PointView) => boolean {
  const toks = tokenize(src);
  let pos = 0;
  const peek = (): Token => toks[pos];
  const eat = (v?: string): Token => {
    const t = toks[pos];
    if (v !== undefined && t.v !== v) throw new MetricsQueryError(400, `expected '${v}' near '${t.v}' in where: ${src}`);
    pos++;
    return t;
  };
  const truthy = (v: Val): boolean => v !== undefined && v !== false && v !== '' && v !== 0;
  const parseOr = (): Pred => {
    let left = parseAnd();
    while (peek().v === '||') {
      eat();
      const l = left;
      const r = parseAnd();
      left = (p) => truthy(l(p)) || truthy(r(p));
    }
    return left;
  };
  const parseAnd = (): Pred => {
    let left = parseUnary();
    while (peek().v === '&&') {
      eat();
      const l = left;
      const r = parseUnary();
      left = (p) => truthy(l(p)) && truthy(r(p));
    }
    return left;
  };
  const parseUnary = (): Pred => {
    if (peek().v === '!' && peek().k === 'op') {
      eat();
      const inner = parseUnary();
      return (p) => !truthy(inner(p));
    }
    return parseComparison();
  };
  const parseComparison = (): Pred => {
    const left = parsePrimary();
    const op = peek();
    if (op.k === 'op' && (op.v === '==' || op.v === '!=')) {
      eat();
      const right = parsePrimary();
      return op.v === '==' ? (p) => left(p) !== undefined && left(p) == right(p) : (p) => left(p) != right(p);
    }
    return left;
  };
  const parsePrimary = (): Pred => {
    const t = eat();
    if (t.k === 'op' && t.v === '(') {
      const e = parseOr();
      eat(')');
      return e;
    }
    if (t.k === 'str') return () => t.v;
    if (t.k === 'num') return () => Number(t.v);
    if (t.k === 'id') {
      if (t.v === 'true') return () => true;
      if (t.v === 'false') return () => false;
      if (t.v === 'has_no_dimensions') return (p) => p.rollup;
      const name = t.v;
      if (peek().v === '.') {
        eat('.');
        const method = eat();
        if (method.k !== 'id' || !['startsWith', 'endsWith', 'includes'].includes(method.v))
          throw new MetricsQueryError(400, `unsupported method '${method.v}' in where: ${src}`);
        eat('(');
        const arg = eat();
        if (arg.k !== 'str') throw new MetricsQueryError(400, `expected a string argument in where: ${src}`);
        eat(')');
        const fn = method.v as 'startsWith' | 'endsWith' | 'includes';
        return (p) => {
          const v = p.dims[name];
          return typeof v === 'string' && v[fn](arg.v);
        };
      }
      return (p) => p.dims[name];
    }
    throw new MetricsQueryError(400, `unexpected '${t.v || 'end of input'}' in where: ${src}`);
  };
  const expr = parseOr();
  if (peek().k !== 'eof') throw new MetricsQueryError(400, `unexpected '${peek().v}' in where: ${src}`);
  return (p) => truthy(expr(p));
}

/** Parses earliest/latest. Returns null for relative strings like '-1h', which the live Leader answers with nothing. */
function parseBound(v: number | string | undefined, now: number, fallback: number): number | null {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (s === 'now') return now;
  const rel = /^(\d+)s$/.exec(s); // criblvision's shipped "21600s" form: that many seconds before now
  if (rel) return now - Number(rel[1]) * 1000;
  if (/^-\d+[smhdw]$/.test(s)) return null;
  throw new MetricsQueryError(400, `invalid time bound: ${s}`);
}

interface Stat {
  sum: number;
  max: number;
  min: number;
  count: number;
}

/**
 * Answers a `POST /system/metrics/query` body from the world, in the Leader's response shape:
 * `{ results: Row[] }`. Rows are per (bucket, split-key); a split dimension a point lacks is omitted
 * from the row, which is exactly how rollup rows appear.
 */
export function metricsQuery(world: World, body: MetricsQueryBody, opts: MetricsQueryOptions): MetricsQueryResult {
  if (!body || typeof body !== 'object') throw new MetricsQueryError(400, 'body must be a JSON object');
  const aggs = body.aggs;
  if (!aggs || !Array.isArray(aggs.aggregations) || aggs.aggregations.length === 0)
    throw new MetricsQueryError(400, 'aggs.aggregations must be a non-empty array');
  const specs = aggs.aggregations.map((a) => {
    if (typeof a !== 'string') throw new MetricsQueryError(400, 'aggregations must be strings');
    return parseAggregation(a);
  });
  const splitBys = aggs.splitBys === undefined ? [] : aggs.splitBys;
  if (!Array.isArray(splitBys) || splitBys.some((s) => typeof s !== 'string')) throw new MetricsQueryError(400, 'aggs.splitBys must be an array of strings');
  const cumulative = aggs.cumulative === true;
  const tws = aggs.timeWindowSeconds;
  if (!cumulative && (typeof tws !== 'number' || !Number.isFinite(tws)))
    throw new MetricsQueryError(400, 'aggs requires timeWindowSeconds (number) or cumulative: true');
  const envelope = (results: MetricsRow[], matched = 0, info: MetricsQueryResult['info'] = cumulative ? { cumulative: true } : { timeWindowSeconds: tws as number }): MetricsQueryResult => ({
    results,
    metrics: {
      'metrics_aggregator.referenced_metrics': new Set(specs.map((s) => s.metric)).size,
      'metrics_reader.execution_time': 0,
      'metrics_reader.matched': matched,
      'metrics_reader.invalid_series': 0,
      'metrics_aggregator.results': results.length,
      'metrics_aggregator.execution_time': 0,
    },
    info,
  });
  if (body.namespace !== undefined && body.namespace !== '' && body.namespace !== 'default') return envelope([]);
  const pred = body.where && body.where.trim() !== '' ? compileWhere(body.where) : () => true;

  const now = opts.now;
  const earliest = parseBound(body.earliest, now, now - HOUR_MS);
  const latest = parseBound(body.latest, now, now);
  if (earliest === null || latest === null) return envelope([]);
  const horizon = floorMinute(now); // only completed minutes exist
  const oldest = opts.retentionMs !== undefined ? now - opts.retentionMs : -Infinity;
  const from = Math.max(ceilMinute(earliest), ceilMinute(oldest));
  const to = Math.min(latest, horizon);

  const rangeSec = Math.max(60, (latest - earliest) / 1000);
  const width = cumulative ? 0 : (tws as number) > 0 ? Math.max(60, Math.round(tws as number)) : rangeSec <= 2 * 3600 ? 60 : 600;

  const families = new Set<Family>();
  for (const s of specs) {
    const def = METRIC_DEFS[s.metric];
    if (def) families.add(def.family);
  }
  const info: MetricsQueryResult['info'] = cumulative ? { cumulative: true } : { timeWindowSeconds: width };
  if (families.size === 0) return envelope([], 0, info); // no metric this store carries: no rows at all

  // bucketStartMs → groupKey → { dims, stats per alias, minT, maxT }
  interface Cell {
    dims: Record<string, string>;
    stats: Map<string, Stat>;
    minT: number;
    maxT: number;
  }
  const buckets = new Map<number, Map<string, Cell>>();
  const predCache = new Map<string, boolean>();
  const points = new Map<string, Point>();
  let matched = 0;
  // Two exact shortcuts: a pure conjunction naming one worker group skips every other group's flows,
  // and a query that never looks at the host skips the per-host split.
  const whereText = body.where ?? '';
  const groupPin = /\|\|/.test(whereText) ? null : /(?:^|[\s(&])__worker_group\s*===?\s*(?:'([^']*)'|"([^"]*)")/.exec(whereText);
  const pointOpts: PointOptions = {
    ...(groupPin && !/!\s*\(/.test(whereText) ? { group: groupPin[1] ?? groupPin[2] } : {}),
    hostAgnostic: !(splitBys as string[]).includes('__worker_node_hostname') && !whereText.includes('__worker_node_hostname'),
  };
  for (let t = from; t < to; t += MINUTE_MS) {
    points.clear();
    addMinutePoints(world, t, families, points, pointOpts);
    const bucketStart = cumulative ? earliest : Math.floor(t / (width * 1000)) * width * 1000;
    for (const [sig, point] of points) {
      let ok = predCache.get(sig);
      if (ok === undefined) predCache.set(sig, (ok = pred({ dims: point.dims, rollup: point.rollup })));
      if (!ok) continue;
      matched++;
      const keyDims: Record<string, string> = {};
      let key = '';
      for (const k of splitBys as string[]) {
        const v = point.dims[k];
        key += v === undefined ? '\u0000|' : `${v}|`;
        if (v !== undefined) keyDims[k] = v;
      }
      let cells = buckets.get(bucketStart);
      if (!cells) buckets.set(bucketStart, (cells = new Map()));
      let cell = cells.get(key);
      for (const spec of specs) {
        const def = METRIC_DEFS[spec.metric];
        if (!def || def.family !== point.family) continue;
        if (!cell) cells.set(key, (cell = { dims: keyDims, stats: new Map(), minT: t, maxT: t }));
        const value = def.pick(point.values);
        const st = cell.stats.get(spec.alias);
        if (!st) cell.stats.set(spec.alias, { sum: value, max: value, min: value, count: 1 });
        else {
          st.sum += value;
          st.max = Math.max(st.max, value);
          st.min = Math.min(st.min, value);
          st.count++;
        }
      }
      if (cell) {
        cell.minT = Math.min(cell.minT, t);
        cell.maxT = Math.max(cell.maxT, t);
      }
    }
  }

  const rows: MetricsRow[] = [];
  const bucketKeys = [...buckets.keys()].sort((a, b) => a - b);
  for (const b of bucketKeys) {
    const cells = buckets.get(b)!;
    const ordered = [...cells.entries()].sort((x, y) => hashString(x[0]) - hashString(y[0]) || (x[0] < y[0] ? -1 : 1));
    for (const [, cell] of ordered) {
      const row: MetricsRow = {};
      if (cumulative) row._time = Math.floor(Math.min(latest, horizon) / 1000);
      else {
        row.starttime = b / 1000;
        row.endtime = b / 1000 + width;
      }
      Object.assign(row, cell.dims);
      for (const spec of specs) {
        if (spec.metric === '_time') {
          if (spec.fn === 'min') row[spec.alias] = Math.floor(cell.minT / 1000);
          else if (spec.fn === 'max') row[spec.alias] = Math.floor(cell.maxT / 1000);
          continue;
        }
        const st = cell.stats.get(spec.alias);
        if (!st) continue; // no data for this aggregation: the key is omitted, never 0
        row[spec.alias] = spec.fn === 'sum' ? st.sum : spec.fn === 'max' ? st.max : spec.fn === 'min' ? st.min : spec.fn === 'avg' ? st.sum / st.count : st.count;
      }
      rows.push(row);
    }
  }
  return envelope(rows, matched, info);
}

/** Answers `POST /system/metrics/enum` ({count, items:[{name, dims:[{name,count,values}]}]}). */
export function metricsEnum(
  world: World,
  body: { metricNameFilter?: string | string[]; dimKeyFilter?: string | string[]; maxValues?: number },
): { count: number; items: { name: string; dims: { name: string; count: number; values: string[] }[] }[] } {
  const toRegexes = (f: string | string[] | undefined): RegExp[] | null => {
    if (f === undefined) return null;
    try {
      return (Array.isArray(f) ? f : [f]).map((s) => new RegExp(s));
    } catch {
      throw new MetricsQueryError(400, 'invalid filter regex');
    }
  };
  const nameRes = toRegexes(body.metricNameFilter);
  const dimRes = toRegexes(body.dimKeyFilter);
  const maxValues = typeof body.maxValues === 'number' && body.maxValues > 0 ? body.maxValues : 10;
  const valuesByFamily: Record<Family, Map<string, Set<string>>> = { in: new Map(), out: new Map(), route: new Map(), pipe: new Map() };
  const note = (family: Family, dims: Record<string, string>): void => {
    for (const [k, v] of Object.entries(dims)) {
      let set = valuesByFamily[family].get(k);
      if (!set) valuesByFamily[family].set(k, (set = new Set()));
      set.add(v);
    }
  };
  for (const f of world.flows) {
    const common = { __worker_group: f.groupId, __dist_mode: 'worker' };
    const hosts = world.hosts[f.groupId] ?? [];
    const inDims = f.inputType === 'syslog' ? [inputDim(f.inputType, f.inputId, 'tcp'), inputDim(f.inputType, f.inputId, 'udp')] : [inputDim(f.inputType, f.inputId)];
    for (const host of hosts) {
      for (const input of inDims) {
        note('in', { input, ...common, __worker_node_hostname: host });
        note('route', { route: f.routeId, name: f.routeName, input, ...common, __worker_node_hostname: host });
      }
      note('out', { output: outputDim(f.outputType, f.outputId), ...common, __worker_node_hostname: host });
      note('pipe', { id: f.pipelineId, ...common, __worker_node_hostname: host });
    }
  }
  for (const idle of idleInputDims(world)) note('in', { input: idle.dim, __worker_group: idle.groupId });
  const items = Object.entries(METRIC_DEFS)
    .filter(([name]) => !nameRes || nameRes.some((r) => r.test(name)))
    .map(([name, def]) => ({
      name,
      dims: [...valuesByFamily[def.family].entries()]
        .filter(([k]) => !dimRes || dimRes.some((r) => r.test(k)))
        .map(([k, set]) => {
          const values = [...set].sort();
          return { name: k, count: values.length, values: values.slice(0, maxValues) };
        }),
    }));
  return { count: items.length, items };
}

/**
 * The oracle: the `MetricsWindow` a correct adapter must build from `metricsQuery` rows for
 * [start, end) — rollup rows dropped, hosts/processes/protocol variants/buckets summed, keys
 * `${groupId}:${id}` with bare ids. A key is present exactly when the query returns a row for it
 * (idle inputs appear with explicit zeros). Pipelines have events only (bytes 0).
 */
export function expectedMetricsWindow(world: World, start: number, end: number): MetricsWindow {
  const w: MetricsWindow = {
    windowStart: iso(start),
    windowEnd: iso(end),
    inputs: {},
    outputs: {},
    routesIn: {},
    routesOut: {},
    pipelinesIn: {},
    pipelinesOut: {},
    has: { routeBytes: true, pipelineBytes: false },
  };
  const bump = (rec: Record<string, { bytes: number; events: number }>, key: string, bytes: number, events: number): void => {
    const cur = rec[key] ?? (rec[key] = { bytes: 0, events: 0 });
    cur.bytes += bytes;
    cur.events += events;
  };
  let idle = idleCache.get(world);
  if (!idle) idleCache.set(world, (idle = idleInputDims(world)));
  for (let t = ceilMinute(start); t < end; t += MINUTE_MS) {
    for (const flow of world.flows) {
      const m = flowMinute(world, flow, t);
      if (!m.present) continue;
      const g = flow.groupId;
      bump(w.inputs, `${g}:${flow.inputId}`, m.srcB, m.srcE);
      bump(w.outputs, `${g}:${flow.outputId}`, m.outB, m.outE);
      bump(w.routesIn!, `${g}:${flow.routeId}`, m.inB, m.inE);
      bump(w.routesOut!, `${g}:${flow.routeId}`, m.outB, m.outE);
      bump(w.pipelinesIn!, `${g}:${m.pipelineId}`, 0, m.inE);
      bump(w.pipelinesOut!, `${g}:${m.pipelineId}`, 0, m.outE);
    }
    for (const z of idle) bump(w.inputs, `${z.groupId}:${z.dim.split(':')[1]}`, 0, 0);
  }
  return w;
}

// ─── Inventory ───────────────────────────────────────────────────────────────
export function flowKeyOf(f: Pick<FlowSpec, 'groupId' | 'inputId' | 'routeId' | 'pipelineId' | 'outputId'>): FlowKey {
  return [f.groupId, f.inputId, f.routeId, f.pipelineId, f.outputId].map((s) => s || '-').join('|');
}

/** The normalized `InventoryDoc` (core/types.ts) a correct config adapter builds from these API objects. */
export function inventoryFromConfig(config: Record<string, GroupConfig>, updatedAt: string): InventoryDoc {
  const byGroup: Record<string, GroupInventory> = {};
  for (const [gid, cfg] of Object.entries(config)) {
    const inputs: InputInfo[] = cfg.inputs.map((i) => ({
      id: i.id,
      type: i.type,
      ...(i.disabled !== undefined ? { disabled: i.disabled } : {}),
      ...(i.description !== undefined ? { description: i.description } : {}),
      ...(i.pipeline !== undefined ? { pipeline: i.pipeline } : {}),
      ...(i.connections !== undefined ? { connections: i.connections } : {}),
      ...(i.sendToRoutes !== undefined ? { sendToRoutes: i.sendToRoutes } : {}),
    }));
    const outputs: OutputInfo[] = cfg.outputs.map((o) => ({
      id: o.id,
      type: o.type,
      ...(o.disabled !== undefined ? { disabled: o.disabled } : {}),
      ...(o.description !== undefined ? { description: o.description } : {}),
      ...(o.pipeline !== undefined ? { pipeline: o.pipeline } : {}),
      ...(o.defaultId !== undefined ? { defaultId: o.defaultId } : {}),
    }));
    const pipelines: PipelineInfo[] = cfg.pipelines.map((p) => ({
      id: p.id,
      ...(p.conf.description !== undefined ? { description: p.conf.description } : {}),
      functions: (p.conf.functions ?? []).map((fn) => ({
        id: fn.id,
        ...(fn.description !== undefined ? { description: fn.description } : {}),
        ...(fn.disabled !== undefined ? { disabled: fn.disabled } : {}),
        ...(fn.filter !== undefined ? { filter: fn.filter } : {}),
      })),
    }));
    const routes: RouteInfo[] = cfg.routes.routes.map((r) => ({
      id: r.id,
      name: r.name,
      filter: r.filter,
      pipeline: r.pipeline,
      ...(r.output !== undefined ? { output: r.output } : {}),
      final: r.final,
      ...(r.disabled !== undefined ? { disabled: r.disabled } : {}),
      ...(r.description !== undefined ? { description: r.description } : {}),
    }));
    byGroup[gid] = { inputs, outputs, pipelines, routes, routeTableId: cfg.routes.id };
  }
  return { schemaVersion: 1, updatedAt, hash: hashString(JSON.stringify(byGroup)).toString(16).padStart(8, '0'), byGroup };
}

export const toInventoryDoc = (world: World, now: number): InventoryDoc => inventoryFromConfig(world.config, iso(now));

// ─── Config files, YAML and diffs (for /version/show) ────────────────────────
export const groupFile = (groupId: string, rel: string): string => `groups/${groupId}/local/cribl/${rel}`;
export const pipelineFile = (groupId: string, pipelineId: string): string => groupFile(groupId, `pipelines/${pipelineId}/conf.yml`);
/** The route table's file. Cribl keeps it under pipelines/ (matchers should also accept `routes.yml`). */
export const routesFile = (groupId: string): string => groupFile(groupId, 'pipelines/route.yml');
export const inputsFile = (groupId: string): string => groupFile(groupId, 'inputs.yml');
export const outputsFile = (groupId: string): string => groupFile(groupId, 'outputs.yml');

const YAML_PLAIN = /^[A-Za-z_/][\w .\-/]*$/;
function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (YAML_PLAIN.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s) && !/\s$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}
function yamlLines(value: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (item !== null && typeof item === 'object' && Object.keys(item).length > 0) {
        const inner = yamlLines(item, indent + 2);
        inner[0] = `${pad}- ${inner[0].slice(indent + 2)}`;
        out.push(...inner);
      } else out.push(`${pad}- ${Array.isArray(item) ? '[]' : item !== null && typeof item === 'object' ? '{}' : yamlScalar(item)}`);
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const out: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      const key = YAML_PLAIN.test(k) ? k : `'${k.replace(/'/g, "''")}'`;
      if (Array.isArray(v)) {
        if (v.length === 0) out.push(`${pad}${key}: []`);
        else out.push(`${pad}${key}:`, ...yamlLines(v, indent + 2));
      } else if (v !== null && typeof v === 'object') {
        if (Object.keys(v).length === 0) out.push(`${pad}${key}: {}`);
        else out.push(`${pad}${key}:`, ...yamlLines(v, indent + 2));
      } else out.push(`${pad}${key}: ${yamlScalar(v)}`);
    }
    return out;
  }
  return [`${pad}${yamlScalar(value)}`];
}
/** Deterministic YAML for config objects (what the Leader's git repo stores). */
export function toYaml(value: unknown): string {
  return yamlLines(value, 0).join('\n') + '\n';
}

const stripStatus = <T extends Record<string, unknown>>(o: T): Omit<T, 'status'> => {
  const { status: _status, ...rest } = o;
  void _status;
  return rest;
};

/** The contents of a repo file for a group's config, or null when that file does not exist. */
export function fileContent(config: GroupConfig | undefined, path: string): string | null {
  if (!config) return null;
  const pm = /^groups\/[^/]+\/local\/cribl\/pipelines\/([^/]+)\/conf\.yml$/.exec(path);
  if (pm) {
    const p = config.pipelines.find((x) => x.id === pm[1]);
    return p ? toYaml(p.conf) : null;
  }
  if (/\/local\/cribl\/(pipelines\/route|routes)\.yml$/.test(path)) return toYaml(config.routes);
  if (path.endsWith('/local/cribl/inputs.yml'))
    return toYaml({ inputs: Object.fromEntries(config.inputs.map((i) => [i.id, stripStatus({ ...i, id: undefined })])) });
  if (path.endsWith('/local/cribl/outputs.yml'))
    return toYaml({ outputs: Object.fromEntries(config.outputs.map((o) => [o.id, stripStatus({ ...o, id: undefined })])) });
  return null;
}

/** Myers-free LCS line diff (files here are a few hundred lines at most). */
function lineOps(a: string[], b: string[]): { op: ' ' | '-' | '+'; text: string; ai: number; bi: number }[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: { op: ' ' | '-' | '+'; text: string; ai: number; bi: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    // Deletions before insertions within a change, as `git diff` prints them.
    if (i < n && j < m && a[i] === b[j]) ops.push({ op: ' ', text: a[i], ai: ++i, bi: ++j });
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ op: '-', text: a[i], ai: ++i, bi: j });
    else ops.push({ op: '+', text: b[j], ai: i, bi: ++j });
  }
  return ops;
}

/** One `diffJson` entry for a file that went from `before` to `after` (null = absent). */
export function diffFile(path: string, before: string | null, after: string | null, context = 3): DiffFile {
  const a = before === null ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === null ? [] : after.replace(/\n$/, '').split('\n');
  const ops = lineOps(a, b);
  const changed = ops.map((o, idx) => (o.op === ' ' ? -1 : idx)).filter((x) => x >= 0);
  const blocks: DiffBlock[] = [];
  let k = 0;
  while (k < changed.length) {
    const lo = Math.max(0, changed[k] - context);
    let hi = Math.min(ops.length - 1, changed[k] + context);
    while (k + 1 < changed.length && changed[k + 1] - context <= hi + 1) hi = Math.min(ops.length - 1, changed[++k] + context);
    k++;
    const slice = ops.slice(lo, hi + 1);
    const first = slice[0];
    const oldStart = first.op === '+' ? first.ai : first.ai - 1;
    const newStart = first.op === '-' ? first.bi : first.bi - 1;
    const oldLen = slice.filter((o) => o.op !== '+').length;
    const newLen = slice.filter((o) => o.op !== '-').length;
    const oldStartLine = oldLen === 0 ? oldStart : oldStart + 1;
    const newStartLine = newLen === 0 ? newStart : newStart + 1;
    blocks.push({
      header: `@@ -${oldStartLine},${oldLen} +${newStartLine},${newLen} @@`,
      oldStartLine,
      newStartLine,
      lines: slice.map((o) =>
        o.op === ' '
          ? { type: 'context', content: ` ${o.text}`, oldNumber: o.ai, newNumber: o.bi }
          : o.op === '+'
            ? { type: 'insert', content: `+${o.text}`, newNumber: o.bi }
            : { type: 'delete', content: `-${o.text}`, oldNumber: o.ai },
      ),
    });
  }
  const file: DiffFile = {
    blocks,
    addedLines: ops.filter((o) => o.op === '+').length,
    deletedLines: ops.filter((o) => o.op === '-').length,
    isGitDiff: true,
    checksumBefore: checksum(before),
    checksumAfter: checksum(after),
    oldName: before === null ? '/dev/null' : path,
    newName: after === null ? '/dev/null' : path,
    language: path.endsWith('.yml') || path.endsWith('.yaml') ? 'yaml' : path.endsWith('.json') ? 'json' : 'txt',
    isCombined: false,
    isTooBig: false,
  };
  if (before === null) Object.assign(file, { isNew: true, newFileMode: '100644' });
  if (after === null) Object.assign(file, { isDeleted: true, deletedFileMode: '100644' });
  return file;
}

/** Builds a commit whose diff is computed from two versions of a group's config. */
export function buildCommit(args: {
  seed: number;
  at: number;
  message: string;
  author: { name: string; email: string };
  files: string[];
  before?: GroupConfig;
  after?: GroupConfig;
  body?: string;
  salt?: string;
}): SyntheticCommit {
  const files = [...new Set(args.files)];
  const diff = files.map((f) => {
    const before = fileContent(args.before, f);
    const after = fileContent(args.after, f);
    // Files whose contents we do not model (secrets.yml, samples.yml…) still show a one-line change.
    return before === null && after === null ? diffFile(f, null, `# ${f.split('/').pop()} (managed by Cribl)\n`) : diffFile(f, before, after);
  });
  return {
    hash: hashHex40(`${args.seed}|${args.at}|${args.message}|${files.join(',')}|${args.salt ?? ''}`),
    at: args.at,
    message: args.message,
    ...(args.body ? { body: args.body } : {}),
    author: args.author,
    files,
    diff,
  };
}

// ─── Git API shapes (/version, /version/show, /version/files) ────────────────
export class GitApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitApiError';
    this.status = status;
  }
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** `/version` rows carry `"2026-09-24 00:09:51 +0000"`: a space for `T` and no colon in the offset (MEASURED). */
export function gitLogDate(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} +0000`;
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `git show` header date, e.g. `Thu Sep 24 00:09:51 2026 +0000`. */
export function gitShowDate(t: number): string {
  const d = new Date(t);
  return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} ${d.getUTCFullYear()} +0000`;
}

/** Whether a commit touches a group (the `/m/<gid>/version*` family is scoped this way — MEASURED). */
export const touchesGroup = (c: SyntheticCommit, groupId: string): boolean => c.files.some((f) => f.startsWith(`groups/${groupId}/`));

const newestFirst = (commits: readonly SyntheticCommit[]): SyntheticCommit[] =>
  [...commits].sort((a, b) => b.at - a.at || (a.hash < b.hash ? -1 : 1));

export function findCommit(commits: readonly SyntheticCommit[], ref: string): SyntheticCommit | undefined {
  const r = ref.trim().toLowerCase();
  if (r.length < 4) return undefined;
  return commits.find((c) => c.hash === r) ?? commits.find((c) => c.hash.startsWith(r));
}

export interface GitLogRow {
  hash: string;
  date: string;
  message: string;
  refs: string;
  body: string;
  author_name: string;
  author_email: string;
}

/**
 * `GET [/m/<gid>]/version` — newest first; `refs` is `HEAD -> master` only on the repo-wide newest
 * commit; `count` alone returns `{items,count}`, `offset`+`limit` adds `offset,limit,totalCount`,
 * and `limit` without `offset` is the measured 400.
 */
export function gitLog(
  commits: readonly SyntheticCommit[],
  q: { groupId?: string; count?: number; offset?: number; limit?: number },
): { items: GitLogRow[]; count: number; offset?: number; limit?: number; totalCount?: number } {
  if (q.limit !== undefined && q.offset === undefined)
    throw new GitApiError(400, "missing 'offset' parameter, 'offset' is required when 'limit' is provided");
  const all = newestFirst(commits);
  const head = all[0]?.hash;
  const scoped = q.groupId ? all.filter((c) => touchesGroup(c, q.groupId!)) : all;
  const rows = scoped.map<GitLogRow>((c) => ({
    hash: c.hash,
    date: gitLogDate(c.at),
    message: c.message.split('\n')[0],
    refs: c.hash === head ? 'HEAD -> master' : '',
    body: c.body ?? '',
    author_name: c.author.name,
    author_email: c.author.email,
  }));
  if (q.offset !== undefined) {
    const limit = q.limit ?? rows.length;
    const items = rows.slice(q.offset, q.offset + limit);
    return { items, count: items.length, offset: q.offset, limit, totalCount: rows.length };
  }
  const items = q.count !== undefined ? rows.slice(0, q.count) : rows;
  return { items, count: items.length };
}

/** `GET [/m/<gid>]/version/show?commit=` — `commitMessage` is the URL-encoded `git show` header (MEASURED). */
export function gitShow(
  commits: readonly SyntheticCommit[],
  ref: string,
  groupId?: string,
  diffLineLimit = 1000,
): { items: { commitMessage: string; diffJson: DiffFile[] }[]; count: number } {
  const c = findCommit(commits, ref);
  if (!c) throw new GitApiError(500, `fatal: bad revision '${ref}'\n`);
  if (groupId && !touchesGroup(c, groupId)) return { items: [{ commitMessage: '', diffJson: [] }], count: 1 };
  const indented = c.message
    .split('\n')
    .concat(c.body ? ['', ...c.body.split('\n')] : [])
    .map((l) => `    ${l}`)
    .join('\n');
  const header = `commit ${c.hash}\nAuthor: ${c.author.name} <${c.author.email}>\nDate:   ${gitShowDate(c.at)}\n\n${indented}\n`;
  const scoped = groupId ? c.diff.filter((d) => (d.newName !== '/dev/null' ? d.newName : d.oldName).startsWith(`groups/${groupId}/`)) : c.diff;
  // Over `diffLineLimit` changed lines (0 = unlimited) the Leader drops the hunks and says so (MEASURED).
  const diffJson = scoped.map((d): DiffFile =>
    diffLineLimit > 0 && d.addedLines + d.deletedLines > diffLineLimit
      ? {
          ...d,
          isTooBig: true,
          blocks: [
            {
              oldStartLine: 0,
              newStartLine: 0,
              header: `Diff too big to be displayed, showing at most ${diffLineLimit} lines. For advanced git use, see: https://docs.cribl.io/stream/version-control/#git-api`,
              lines: [],
            },
          ],
        }
      : d,
  );
  return { items: [{ commitMessage: encodeURIComponent(header), diffJson }], count: 1 };
}

export interface GitFileNode {
  name: string;
  state?: 'M' | 'A' | 'D';
  children?: GitFileNode[];
}

/**
 * `GET [/m/<gid>]/version/files?commit=` — the files of that ONE commit as a nested tree, one node per
 * path segment (MEASURED); the root commit answers 500 because the server runs `X~..X`.
 */
export function gitFiles(
  commits: readonly SyntheticCommit[],
  ref: string,
  groupId?: string,
): { items: { count: number; items: GitFileNode[]; commitMessage: string }[]; count: number } {
  const c = findCommit(commits, ref);
  if (!c) throw new GitApiError(500, `fatal: bad revision '${ref}'\n`);
  const oldest = [...commits].sort((a, b) => a.at - b.at)[0];
  if (oldest && oldest.hash === c.hash) throw new GitApiError(500, `fatal: bad revision '${ref.slice(0, 7)}~..${ref.slice(0, 7)}'\n`);
  const roots: GitFileNode[] = [];
  let count = 0;
  for (const d of c.diff) {
    const path = d.newName !== '/dev/null' ? d.newName : d.oldName;
    if (groupId && !path.startsWith(`groups/${groupId}/`)) continue;
    count++;
    const segs = path.split('/');
    let level = roots;
    segs.forEach((seg, i) => {
      let node = level.find((n) => n.name === seg);
      if (!node) {
        node = i === segs.length - 1 ? { name: seg, state: d.isNew ? 'A' : d.isDeleted ? 'D' : 'M' } : { name: seg, children: [] };
        level.push(node);
      }
      level = node.children ?? [];
    });
  }
  return { items: [{ count, items: roots, commitMessage: c.message }], count: 1 };
}

/** Flattens a `/version/files` tree back into paths (what a matcher does). */
export function flattenGitFiles(nodes: readonly GitFileNode[], prefix = ''): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const p = prefix ? `${prefix}/${n.name}` : n.name;
    if (n.children && n.children.length > 0) out.push(...flattenGitFiles(n.children, p));
    else out.push(p);
  }
  return out;
}

/** The `POST /version/commit` item (openapi GitCommitSummary). */
export function commitSummary(c: SyntheticCommit): {
  author: { email: string; name: string };
  branch: string;
  commit: string;
  files: { created: string[]; modified: string[]; deleted: string[]; renamed: { from: string; to: string }[] };
  summary: { changes: number; insertions: number; deletions: number };
} {
  const created = c.diff.filter((d) => d.isNew).map((d) => d.newName);
  const deleted = c.diff.filter((d) => d.isDeleted).map((d) => d.oldName);
  const modified = c.diff.filter((d) => !d.isNew && !d.isDeleted).map((d) => d.newName);
  const insertions = c.diff.reduce((s, d) => s + d.addedLines, 0);
  const deletions = c.diff.reduce((s, d) => s + d.deletedLines, 0);
  return {
    author: { email: c.author.email, name: c.author.name },
    branch: 'master',
    commit: c.hash,
    files: { created, modified, deleted, renamed: [] },
    summary: { changes: insertions + deletions, insertions, deletions },
  };
}

// ─── The demo rig (PRD 9 / 9.1, SPEC 14.2) ───────────────────────────────────
export const DEMO_TAG = '[meter-reader-demo]';
export const TRIM_TAG = '[mr-trim]';

export interface RigSource {
  key: string;
  /** Datagen Source id; the route has the same id (metrics: `datagen:<id>` and `route=<id>`). */
  inputId: string;
  routeId: string;
  /** the route's `name` (the live rig names each route after its id) */
  routeName: string;
  /** human label used in descriptions and the Demo Console */
  label: string;
  gbPerDay: number;
  /** average event size of the bundled sample (demo/rig/samples/manifest.json, measured) */
  eventBytes: number;
  /** sample-library id the Datagen reads (`samples[].sample`) */
  sample: string;
  outputId: string;
  /** steady-state pipeline */
  pipelineId: string;
  /**
   * Apply-the-pack targets for the three raw streams. Only the route's pipeline changes: the live rig
   * never sets a Source pre-processing pipeline (mrd_pan_pack chains mrd_syslog_pre itself), because
   * pre-processing would shrink route in-bytes and hide the savings (docs/RIG.md).
   */
  pack?: { pipelineId: string; aggressivePipelineId?: string };
  trimRetention?: number;
  dropRetention?: number;
}

/**
 * Every id in the demo rig — the same spellings as the live rig in demo/rig/*.json (docs/RIG.md):
 * Sources and their routes share an id; metrics keys are `datagen:<id>`, route `<id>`, output
 * `devnull:<id>`. The demo levers and the commit matcher must use these exact spellings.
 */
export const RIG = {
  groupId: 'default',
  outputs: {
    siem: { id: 'mrd_siem_prod', label: 'SIEM (prod)', preset: 'splunk_cloud' },
    analytics: { id: 'mrd_analytics', label: 'Analytics', preset: 'datadog' },
    archive: { id: 'mrd_archive_s3', label: 'Archive (S3)', preset: 's3' },
  },
  pipelines: {
    passthrough: 'mrd_passthrough',
    winXmlPack: 'mrd_win_xml_pack',
    winDocsReduce: 'mrd_win_docs_reduce',
    syslogPre: 'mrd_syslog_pre',
    panPack: 'mrd_pan_pack',
    vpcPack: 'mrd_vpc_pack',
    paySample: 'mrd_pay_sample',
    k8sNoise: 'mrd_k8s_noise',
  },
  /** The Dispensary packs whose functions the pack pipelines carry (SPEC 14.1, docs/RIG.md). */
  packs: {
    windowsXml: 'cribl_splunk_forwarder_windows_xml_events_to_json',
    syslogInput: 'cribl-syslog-input',
    paloAlto: 'cribl-palo-alto-networks',
    vpcFlow: 'cribl-vpc-flow-for-security-teams',
  },
  sources: [
    { key: 'windows_dc', inputId: 'mrd_windows_dc', routeId: 'mrd_windows_dc', routeName: 'mrd_windows_dc', label: 'Windows domain controllers', gbPerDay: 150, eventBytes: 2529, sample: 'mrd_windows_security_xml', outputId: 'mrd_siem_prod', pipelineId: 'mrd_win_xml_pack' },
    { key: 'windows_workstations', inputId: 'mrd_windows_workstations', routeId: 'mrd_windows_workstations', routeName: 'mrd_windows_workstations', label: 'Windows workstations', gbPerDay: 80, eventBytes: 2529, sample: 'mrd_windows_security_xml', outputId: 'mrd_siem_prod', pipelineId: 'mrd_passthrough', pack: { pipelineId: 'mrd_win_xml_pack', aggressivePipelineId: 'mrd_win_docs_reduce' } },
    { key: 'pan_firewall', inputId: 'mrd_pan_firewall', routeId: 'mrd_pan_firewall', routeName: 'mrd_pan_firewall', label: 'Palo Alto firewalls', gbPerDay: 60, eventBytes: 826, sample: 'mrd_pan_traffic', outputId: 'mrd_siem_prod', pipelineId: 'mrd_passthrough', pack: { pipelineId: 'mrd_pan_pack' } },
    { key: 'vpc_flow', inputId: 'mrd_vpc_flow', routeId: 'mrd_vpc_flow', routeName: 'mrd_vpc_flow', label: 'AWS VPC Flow Logs', gbPerDay: 60, eventBytes: 112, sample: 'mrd_vpc_flow_v2', outputId: 'mrd_archive_s3', pipelineId: 'mrd_passthrough', pack: { pipelineId: 'mrd_vpc_pack' } },
    { key: 'payments_api', inputId: 'mrd_payments_api', routeId: 'mrd_payments_api', routeName: 'mrd_payments_api', label: 'Payments API', gbPerDay: 40, eventBytes: 1138, sample: 'mrd_api_access', outputId: 'mrd_siem_prod', pipelineId: 'mrd_pay_sample', trimRetention: 0.5 },
    { key: 'k8s_prod', inputId: 'mrd_k8s_prod', routeId: 'mrd_k8s_prod', routeName: 'mrd_k8s_prod', label: 'Kubernetes (prod)', gbPerDay: 60, eventBytes: 782, sample: 'mrd_k8s_container', outputId: 'mrd_analytics', pipelineId: 'mrd_k8s_noise', trimRetention: 0.5, dropRetention: 0.6 },
  ] as readonly RigSource[],
  /** Commit author for demo levers when none is given (the mock user). */
  author: { name: 'Steve Koelpin', email: 's.koelpin@example.com' },
} as const;

/** Byte/event retention of a Cribl Pack reached through a `chain` function (illustrative; SPEC 14.1). */
export const PACK_RETENTION: Readonly<Record<string, { bytes: number; events: number }>> = {
  [RIG.packs.windowsXml]: { bytes: 0.67, events: 1 },
  [RIG.packs.syslogInput]: { bytes: 0.85, events: 1 },
  [RIG.packs.paloAlto]: { bytes: 0.62, events: 1 },
  [RIG.packs.vpcFlow]: { bytes: 0.12, events: 0.02 },
};

/**
 * Whole-pipeline retention for the rig's imported pack pipelines, whose many parse/flatten/serialize
 * functions have no per-function model: the targets of docs/RIG.md (Windows XML pack 0.30–0.35,
 * Docs reduction 0.60–0.75, syslog + Palo Alto pack 0.35–0.50, VPC aggregation ≫ 0.6). Hand-built
 * pipelines (payments, k8s) are modelled per function so disabling their `[mr-trim]` step moves the ratio.
 */
export const PIPELINE_RETENTION: Readonly<Record<string, { bytes: number; events: number }>> = {
  [RIG.pipelines.winXmlPack]: { bytes: 0.67, events: 1 },
  [RIG.pipelines.winDocsReduce]: { bytes: 0.35, events: 1 },
  [RIG.pipelines.syslogPre]: { bytes: 0.85, events: 1 },
  [RIG.pipelines.panPack]: { bytes: 0.57, events: 1 },
  [RIG.pipelines.vpcPack]: { bytes: 0.12, events: 0.02 },
};

const rigSource = (inputOrRouteId: string): RigSource | undefined =>
  RIG.sources.find((s) => s.inputId === inputOrRouteId || s.routeId === inputOrRouteId || s.key === inputOrRouteId);

const baselineEps = (s: RigSource): number => Math.max(1, Math.round((s.gbPerDay * GB) / 86_400 / s.eventBytes));

/**
 * The rig's Cribl objects, in API shapes, every one tagged `[meter-reader-demo]` — the same ids,
 * roles and function outlines as demo/rig/*.json (the imported pack pipelines are abbreviated to
 * their characteristic steps; the emulator can overlay the full definitions, see src/mock/fixtures.ts).
 */
export function rigConfigObjects(): GroupConfig {
  const fn = (id: string, description: string, conf: Record<string, unknown>, filter = 'true'): CriblFunction => ({ id, filter, disabled: false, description, conf });
  const serializeJson = fn('serialize', 'Serialize the remaining fields back into _raw as compact JSON', { type: 'json', dstField: '_raw', fields: ['!_*', '!cribl_*', '*'] });
  const keepRaw = fn('eval', 'Keep only _raw and _time so the byte estimate is the serialized event', { keep: ['_raw', '_time'], remove: ['*'] });
  const pipeline = (id: string, description: string, functions: CriblFunction[]): CriblPipeline => ({
    id,
    conf: { output: 'default', asyncFuncTimeout: 1000, streamtags: ['meter-reader-demo'], description: `${DEMO_TAG} ${description}`, functions },
  });
  const pipelines: CriblPipeline[] = [
    pipeline(RIG.pipelines.passthrough, 'Passthrough: no functions. Raw streams run through this at full price until "Apply the pack".', []),
    pipeline(RIG.pipelines.paySample, 'Payments API: sample 1:2, then trim headers, user_agent and request_body. Steady ratio ≈ 0.75; trim broken ≈ 0.50.', [
      fn('sampling', 'Keep 1 of every 2 events', { rules: [{ filter: 'true', rate: 2 }] }),
      fn('serde', 'Parse the JSON access log into fields', { mode: 'extract', type: 'json', srcField: '_raw', remove: [], keep: [] }),
      fn('eval', `${TRIM_TAG} Remove headers, user_agent and request_body`, { remove: ['headers', 'user_agent', 'request_body'] }),
      serializeJson,
      keepRaw,
    ]),
    pipeline(RIG.pipelines.k8sNoise, 'Kubernetes: drop debug lines, then trim pod labels. Steady ratio ≈ 0.70.', [
      fn('drop', 'Drop debug-level lines (matched on _raw before parsing, so dropped events cost no parse)', {}, `_raw.indexOf('"level":"debug"') > -1`),
      fn('serde', 'Parse the container JSON into fields', { mode: 'extract', type: 'json', srcField: '_raw', remove: [], keep: [] }),
      fn('eval', `${TRIM_TAG} Remove labels`, { remove: ['labels'] }),
      serializeJson,
      keepRaw,
    ]),
    pipeline(RIG.pipelines.winXmlPack, 'Windows XML → JSON: the pipeline of the Dispensary pack "Splunk Forwarder Windows XML Events to JSON" (keeps the Splunk Windows TA and CIM working; pack README: 30–35% smaller).', [
      fn('eval', 'Parse _raw XML to a JSON & remove fields with values in brackets', { add: [{ name: '_raw', value: "C.Text.parseWinEvent(_raw, ['-'])" }] }),
      fn('flatten', 'Flatten fields to top level', { fields: ['_raw'], prefix: '', depth: 5, delimiter: '_' }),
      fn('rename', 'Rename expression', { wildcardDepth: 5, renameExpr: "name.replace(/_raw_.+_/,'')", rename: [] }),
      fn('serialize', 'Serialize fields into _raw', { type: 'json', dstField: '_raw', fields: ['!_*', '!cribl_*', '*'] }),
    ]),
    pipeline(RIG.pipelines.winDocsReduce, 'Windows XML, aggressive ("Go aggressive"): parse, drop RenderingInfo, provider GUID, correlation and empty values, flatten to compact JSON (Cribl Docs "Reducing Windows XML Events", documented 34–70%).', [
      fn('eval', 'Parse the XML event; values in the list are treated as empty and dropped', { add: [{ name: '_raw', value: "C.Text.parseWinEvent(_raw, ['-', '0x0', '%%1843', 'S-1-0-0', 'NULL SID', ''])" }] }),
      fn('eval', 'Drop RenderingInfo (the Message repeats EventData), the provider GUID, correlation, version and opcode', { remove: ['_raw.Event.RenderingInfo', '_raw.Event.System.Provider.Guid', '_raw.Event.System.Correlation'] }),
      fn('flatten', 'Flatten the event to top-level fields', { fields: ['_raw'], prefix: '', depth: 5, delimiter: '_' }),
      serializeJson,
      fn('eval', 'Keep only _raw and _time', { keep: ['_raw', '_time'], remove: ['*'] }),
    ]),
    pipeline(RIG.pipelines.syslogPre, 'Syslog pre-processing: strip the RFC 3164 header (<pri>, timestamp, host) from _raw and keep the sender as host. Chained from mrd_pan_pack, never set on the Source (route in-bytes must stay raw).', [
      fn('eval', 'Header present: host = sender, _raw = message body', { add: [{ name: 'host', value: '__hdr[1]' }] }, '/^<\\d{1,3}>/.test(_raw)'),
    ]),
    pipeline(RIG.pipelines.panPack, 'Palo Alto TRAFFIC: syslog pre-processing (mrd_syslog_pre) + the pan_traffic pipeline of the Dispensary pack "Palo Alto Networks" (remove future_use and unused fields, reserialize for the Splunk TA).', [
      fn('chain', 'Syslog pre-processing: strip the RFC 3164 header and keep the sender as host (mrd_syslog_pre)', { processor: RIG.pipelines.syslogPre }),
      fn('serde', 'Extract the PAN-OS 11.x TRAFFIC fields (pack pan_traffic step 3)', { mode: 'extract', type: 'csv', srcField: '_raw' }),
      fn('eval', 'Remove future_use, redundant times and fields the Splunk TA does not extract (pack pan_traffic step 12)', { remove: ['future_use*', 'generated_time', 'receive_time'] }),
      fn('serialize', 'Reserialize to CSV in the Splunk TA field order (pack pan_traffic step 13)', { type: 'csv', dstField: '_raw' }),
    ]),
    pipeline(RIG.pipelines.vpcPack, 'AWS VPC Flow: extract the v2 fields, drop NODATA/SKIPDATA, aggregate per minute by src, dst, dstport and action (sum bytes and packets, count flows).', [
      fn('serde', 'Extract the VPC Flow Logs v2 fields (space-delimited)', { mode: 'extract', type: 'delim', srcField: '_raw', delimChar: ' ' }),
      fn('drop', 'Remove records with no data', {}, "log_status == 'NODATA' || log_status == 'SKIPDATA'"),
      fn('aggregation', 'One event per conversation per minute', { timeWindow: '60s', aggregations: ['sum(bytes).as(bytes)', 'sum(packets).as(packets)', 'count().as(flows)'], groupbys: ['srcaddr', 'dstaddr', 'dstport', 'action'] }),
      serializeJson,
      fn('eval', 'Keep only _raw and _time', { keep: ['_raw', '_time'], remove: ['*'] }),
    ]),
  ];
  const inputs: CriblInput[] = RIG.sources.map((s) => ({
    id: s.inputId,
    type: 'datagen',
    disabled: false,
    sendToRoutes: true,
    pqEnabled: false,
    streamtags: ['meter-reader-demo'],
    description: `${DEMO_TAG} ${s.label} (Datagen, synthetic ${s.sample.replace(/^mrd_/, '')} sample).`,
    samples: [{ sample: s.sample, eventsPerSec: baselineEps(s) }],
  }));
  const outputs: CriblOutput[] = Object.values(RIG.outputs).map((o) => ({
    id: o.id,
    type: 'devnull',
    systemFields: ['cribl_pipe'],
    streamtags: ['meter-reader-demo'],
    description: `${DEMO_TAG} Simulated ${o.label} destination (DevNull). Priced with the ${o.preset} preset in Meter Reader.`,
  }));
  const routes: CriblRoute[] = RIG.sources.map((s) => ({
    id: s.routeId,
    name: s.routeName,
    final: true,
    disabled: false,
    pipeline: s.pipelineId,
    output: s.outputId,
    filter: `__inputId=='${inputDim('datagen', s.inputId)}'`,
    description: `${DEMO_TAG} ${s.label}: Datagen ${s.inputId} → ${s.pipelineId} → ${s.outputId}`,
    clones: [],
    enableOutputExpression: false,
  }));
  return { inputs, outputs, pipelines, routes: { id: 'default', routes } };
}

/** Byte/event retention of one pipeline function for a flow (the per-function reduction model). */
export function functionRetention(
  fn: CriblFunction,
  flow: Pick<FlowSpec, 'trimRetention' | 'dropRetention'>,
  config?: GroupConfig,
  depth = 0,
): { bytes: number; events: number } {
  if (fn.disabled === true) return { bytes: 1, events: 1 };
  const conf = fn.conf ?? {};
  switch (fn.id) {
    case 'sampling': {
      const rules = Array.isArray(conf.rules) ? (conf.rules as { rate?: unknown }[]) : [];
      const rate = Math.max(1, Number(rules[0]?.rate) || 1);
      return { bytes: 1 / rate, events: 1 / rate };
    }
    case 'drop': {
      const r = flow.dropRetention ?? 0.5;
      return { bytes: r, events: r };
    }
    case 'eval':
      return (fn.description ?? '').includes(TRIM_TAG) ? { bytes: flow.trimRetention ?? 0.5, events: 1 } : { bytes: 1, events: 1 };
    case 'aggregation':
      return { bytes: 0.12, events: 0.02 };
    case 'chain': {
      const target = String(conf.processor);
      // A chain to another pipeline in the group runs that pipeline; a chain to a Pack uses its table.
      if (config && depth < 5 && config.pipelines.some((p) => p.id === target)) return pipelineRetention(config, target, flow, depth + 1);
      return PACK_RETENTION[target] ?? { bytes: 0.8, events: 1 };
    }
    default:
      return { bytes: 1, events: 1 };
  }
}

/** A pipeline's retention: the whole-pipeline table for the imported packs, else the product of its functions. */
export function pipelineRetention(config: GroupConfig, pipelineId: string | undefined, flow: Pick<FlowSpec, 'trimRetention' | 'dropRetention'>, depth = 0): { bytes: number; events: number } {
  if (!pipelineId) return { bytes: 1, events: 1 };
  const table = PIPELINE_RETENTION[pipelineId];
  if (table) return table;
  const p = config.pipelines.find((x) => x.id === pipelineId);
  let bytes = 1;
  let events = 1;
  for (const fn of p?.conf.functions ?? []) {
    const r = functionRetention(fn, flow, config, depth);
    bytes *= r.bytes;
    events *= r.events;
  }
  return { bytes, events };
}

/** What a derived flow looks like under a given config: pipeline, ratios, pre-processing, volume. */
export interface DerivedFlowState {
  pipelineId: string;
  ratio: number;
  eventRatio: number;
  preRetention: number;
  volume: number;
}
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

export function rigFlowState(config: GroupConfig, flow: FlowSpec): DerivedFlowState {
  const route = config.routes.routes.find((r) => r.id === flow.routeId);
  const input = config.inputs.find((i) => i.id === flow.inputId);
  const pipelineId = route?.pipeline ?? flow.pipelineId;
  const main = pipelineRetention(config, pipelineId, flow);
  const pre = input?.pipeline ? pipelineRetention(config, input.pipeline, flow).bytes : 1;
  const eps = input?.samples?.[0]?.eventsPerSec;
  const volume = !input || input.disabled || route?.disabled ? 0 : flow.baselineEps && typeof eps === 'number' ? eps / flow.baselineEps : 1;
  return { pipelineId, ratio: round4(1 - main.bytes), eventRatio: round4(1 - main.events), preRetention: round4(pre), volume: round4(volume) };
}

/**
 * The effects a deploy produces: every derived flow whose state differs between the running config
 * and the newly deployed one changes from `effectiveAt` (callers pass the next minute boundary).
 */
export function deployEffects(flows: readonly FlowSpec[], before: GroupConfig, after: GroupConfig, effectiveAt: number, note?: string): Effect[] {
  const out: Effect[] = [];
  for (const flow of flows) {
    if (!flow.derived) continue;
    const a = rigFlowState(before, flow);
    const b = rigFlowState(after, flow);
    if (a.pipelineId !== b.pipelineId || a.ratio !== b.ratio || a.eventRatio !== b.eventRatio || a.preRetention !== b.preRetention)
      out.push({ kind: 'state', flowId: flow.id, start: effectiveAt, pipelineId: b.pipelineId, ratio: b.ratio, eventRatio: b.eventRatio, preRetention: b.preRetention, ...(note ? { note } : {}) });
    if (a.volume !== b.volume) out.push({ kind: 'volume', flowId: flow.id, start: effectiveAt, multiplier: b.volume, ...(note ? { note } : {}) });
  }
  return out;
}

const cloneConfig = (c: GroupConfig): GroupConfig => JSON.parse(JSON.stringify(c)) as GroupConfig;

export class RigRefusal extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'RigRefusal';
    this.status = status;
  }
}
const requireTag = (description: string | undefined, id: string): void => {
  if (!(description ?? '').includes(DEMO_TAG)) throw new RigRefusal(403, `not_demo_tagged: ${id}`);
};

/** The lever mutations (pure: they return a new config). Each also names the files it dirties. */
export function rigApplyPack(config: GroupConfig, groupId: string, routeId: string, level: 'pack' | 'aggressive' = 'pack'): { config: GroupConfig; files: string[]; message: string } {
  const src = rigSource(routeId);
  if (!src?.pack) throw new RigRefusal(400, `no pack for route ${routeId}`);
  const next = cloneConfig(config);
  const route = next.routes.routes.find((r) => r.id === src.routeId);
  if (!route) throw new RigRefusal(404, `route ${src.routeId} not found`);
  requireTag(route.description, route.id);
  route.pipeline = level === 'aggressive' && src.pack.aggressivePipelineId ? src.pack.aggressivePipelineId : src.pack.pipelineId;
  return { config: next, files: [routesFile(groupId)], message: `demo: apply the pack on ${src.routeId}` };
}

export function rigRevertPack(config: GroupConfig, groupId: string, routeId: string): { config: GroupConfig; files: string[]; message: string } {
  const src = rigSource(routeId);
  if (!src?.pack) throw new RigRefusal(400, `no pack for route ${routeId}`);
  const next = cloneConfig(config);
  const route = next.routes.routes.find((r) => r.id === src.routeId);
  if (!route) throw new RigRefusal(404, `route ${src.routeId} not found`);
  requireTag(route.description, route.id);
  route.pipeline = src.pipelineId;
  return { config: next, files: [routesFile(groupId)], message: `demo: revert the pack on ${src.routeId}` };
}

function setTrim(config: GroupConfig, groupId: string, pipelineId: string, disabled: boolean): { config: GroupConfig; files: string[]; message: string } {
  const next = cloneConfig(config);
  const p = next.pipelines.find((x) => x.id === pipelineId);
  if (!p) throw new RigRefusal(404, `pipeline ${pipelineId} not found`);
  requireTag(p.conf.description, p.id);
  const fn = p.conf.functions.find((f) => (f.description ?? '').includes(TRIM_TAG));
  if (!fn) throw new RigRefusal(400, `pipeline ${pipelineId} has no ${TRIM_TAG} function`);
  fn.disabled = disabled;
  return { config: next, files: [pipelineFile(groupId, pipelineId)], message: `demo: ${disabled ? 'break' : 'restore'} the trim on ${pipelineId}` };
}
export const rigBreakTrim = (config: GroupConfig, groupId: string, pipelineId: string = RIG.pipelines.paySample) => setTrim(config, groupId, pipelineId, true);
export const rigRestoreTrim = (config: GroupConfig, groupId: string, pipelineId: string = RIG.pipelines.paySample) => setTrim(config, groupId, pipelineId, false);

export function rigSetRate(config: GroupConfig, groupId: string, inputId: string, multiplier: number): { config: GroupConfig; files: string[]; message: string } {
  const src = rigSource(inputId);
  if (!src) throw new RigRefusal(404, `input ${inputId} is not a rig source`);
  if (!(multiplier >= 0.1 && multiplier <= 10)) throw new RigRefusal(400, 'multiplier must be within 0.1..10');
  const next = cloneConfig(config);
  const input = next.inputs.find((i) => i.id === src.inputId);
  if (!input) throw new RigRefusal(404, `input ${src.inputId} not found`);
  requireTag(input.description, input.id);
  const eps = Math.max(1, Math.round(baselineEps(src) * multiplier));
  input.samples = [{ sample: input.samples?.[0]?.sample ?? src.sample, eventsPerSec: eps }];
  return { config: next, files: [inputsFile(groupId)], message: `demo: set ${src.inputId} to ${multiplier}x` };
}

function rigFlows(groupId: string, activeFrom: number): FlowSpec[] {
  return RIG.sources.map((s): FlowSpec => ({
    id: s.routeId,
    groupId,
    inputId: s.inputId,
    inputType: 'datagen',
    routeId: s.routeId,
    routeName: s.routeName,
    pipelineId: s.pipelineId,
    outputId: s.outputId,
    outputType: 'devnull',
    bytesPerDay: s.gbPerDay * GB,
    eventBytes: s.eventBytes,
    ratio: 0,
    eventRatio: 0,
    preRetention: 1,
    shape: 'flat',
    weekendFactor: 1,
    noise: 0.02,
    ratioNoise: 0.004,
    phaseHours: 0,
    activeFrom,
    derived: true,
    ...(s.trimRetention !== undefined ? { trimRetention: s.trimRetention } : {}),
    ...(s.dropRetention !== undefined ? { dropRetention: s.dropRetention } : {}),
    baselineEps: baselineEps(s),
  }));
}

export interface RigOptions {
  /** World creation instant; the rig was applied `historyDays` earlier (floored to the hour). */
  now: number;
  seed?: number;
  historyDays?: number;
  groupId?: string;
  hosts?: string[];
  processesPerHost?: number;
  /** Extra objects merged into the rig's group (e.g. the live org's inputs/pipelines); rig routes go first. */
  extraConfig?: Partial<GroupConfig>;
  /** The rig's own objects (default `rigConfigObjects()`); e.g. the full definitions from demo/rig/*.json. */
  rigConfig?: GroupConfig;
  groups?: GroupRecord[];
  /** Commits that predate the rig (e.g. the live `create group default`). */
  baseCommits?: SyntheticCommit[];
  author?: { name: string; email: string };
  /**
   * The S15 script: pack applies on the three raw routes at breakAt − 70 s, − 55 s and − 40 s
   * (the closest exactly 40 s before), then break the payments trim at `breakAt`; optional restore.
   */
  script?: { breakAt: number; withPacks?: boolean; restoreAt?: number; deployLagSec?: number };
}

/** Merges extra objects into a group config; rig routes stay ahead of any catch-all. */
export function mergeGroupConfig(rig: GroupConfig, extra?: Partial<GroupConfig>): GroupConfig {
  if (!extra) return cloneConfig(rig);
  const byId = <T extends { id: string }>(first: T[], second: T[] | undefined): T[] => {
    const seen = new Set(first.map((x) => x.id));
    return [...first, ...(second ?? []).filter((x) => !seen.has(x.id))];
  };
  const extraRoutes = extra.routes?.routes ?? [];
  return cloneConfig({
    inputs: byId(extra.inputs ?? [], rig.inputs),
    outputs: byId(extra.outputs ?? [], rig.outputs),
    pipelines: byId(extra.pipelines ?? [], rig.pipelines),
    routes: { ...(extra.routes ?? {}), id: extra.routes?.id ?? rig.routes.id, routes: byId(rig.routes.routes, extraRoutes) },
  });
}

/**
 * The demo rig world: six Datagen sources (≈ 450 GB/day), three DevNull destinations, route ratios
 * 0.33 / 0 / 0 / 0 / 0.75 / 0.70 derived from the configured pipelines, and optionally the S15
 * scenario. `config` is the state after every scripted step.
 */
export function demoRigWorld(opts: RigOptions): World {
  const seed = opts.seed ?? 42;
  const groupId = opts.groupId ?? RIG.groupId;
  const rigStart = floorHour(opts.now - (opts.historyDays ?? 7) * DAY_MS);
  const author = opts.author ?? RIG.author;
  const flows = rigFlows(groupId, rigStart);
  let config = mergeGroupConfig(opts.rigConfig ?? rigConfigObjects(), opts.extraConfig);
  // Seed each flow's static state from the configuration it starts under.
  for (const f of flows) {
    const s = rigFlowState(config, f);
    f.pipelineId = s.pipelineId;
    f.ratio = s.ratio;
    f.eventRatio = s.eventRatio;
    f.preRetention = s.preRetention;
  }
  const rigFiles = [
    ...RIG.sources.map((s) => s.pipelineId),
    RIG.pipelines.winDocsReduce,
    RIG.pipelines.syslogPre,
    RIG.pipelines.panPack,
    RIG.pipelines.vpcPack,
  ].map((p) => pipelineFile(groupId, p));
  const commits: SyntheticCommit[] = [
    ...(opts.baseCommits ?? [
      buildCommit({ seed, at: rigStart - DAY_MS, message: `create group ${groupId}`, author: { name: 'Cribl System', email: 'cribl@leader.example' }, files: [groupFile(groupId, 'cribl.yml')] }),
    ]),
    buildCommit({
      seed,
      at: rigStart,
      message: 'demo: apply the rig',
      author,
      files: [...new Set([...rigFiles, routesFile(groupId), inputsFile(groupId), outputsFile(groupId)])],
      before: { inputs: [], outputs: [], pipelines: [], routes: { id: 'default', routes: [] } },
      after: config,
    }),
  ];
  const effects: Effect[] = [];
  const step = (at: number, mutate: (c: GroupConfig) => { config: GroupConfig; files: string[]; message: string }): void => {
    const r = mutate(config);
    commits.push(buildCommit({ seed, at, message: r.message, author, files: r.files, before: config, after: r.config }));
    const lag = (opts.script?.deployLagSec ?? 0) * 1000;
    effects.push(...deployEffects(flows, config, r.config, ceilMinute(at + lag), r.message));
    config = r.config;
  };
  if (opts.script) {
    const { breakAt, withPacks, restoreAt } = opts.script;
    if (withPacks) {
      step(breakAt - 70_000, (c) => rigApplyPack(c, groupId, 'mrd_windows_workstations'));
      step(breakAt - 55_000, (c) => rigApplyPack(c, groupId, 'mrd_pan_firewall'));
      step(breakAt - 40_000, (c) => rigApplyPack(c, groupId, 'mrd_vpc_flow'));
    }
    step(breakAt, (c) => rigBreakTrim(c, groupId));
    if (restoreAt !== undefined) step(restoreAt, (c) => rigRestoreTrim(c, groupId));
  }
  const hosts = opts.hosts ?? [`wn-${groupId}-0`];
  return {
    seed,
    start: rigStart,
    end: opts.now,
    groups: opts.groups ?? [{ id: groupId, type: 'stream', description: 'Default Worker Group', name: groupId, onPrem: false, provisioned: true }],
    hosts: { [groupId]: hosts },
    processesPerHost: opts.processesPerHost ?? 2,
    flows,
    effects,
    commits,
    config: { [groupId]: config },
    anomalies: [],
  };
}

// ─── Synthetic estates (up to 2,000 flows × 30 days) ─────────────────────────
export interface SyntheticOptions {
  seed?: number;
  flows?: number;
  groups?: number;
  days?: number;
  /** End of the intended history (default DEFAULT_END). */
  end?: number;
  hostsPerGroup?: number;
  processesPerHost?: number;
  anomalies?: { spikes?: number; regressionsWithCommit?: number; regressionsWithoutCommit?: number; outages?: number; benignCommits?: number };
}

const INPUT_TYPES = ['splunk_hec', 'syslog', 'http', 'kafka', 'datagen', 'tcpjson', 'open_telemetry', 's3', 'wef', 'cribl_http'] as const;
const OUTPUT_TYPES = ['splunk_hec', 's3', 'sentinel', 'datadog', 'cribl_lake', 'elastic', 'crowdstrike_next_gen_siem', 'google_chronicle', 'sumo_logic', 'newrelic', 'azure_blob', 'snowflake_streaming', 'databricks', 'devnull'] as const;
const GROUP_IDS = ['default', 'wg_east', 'wg_west', 'wg_emea', 'wg_apac'];
const AUTHORS = [
  { name: 'Steve Koelpin', email: 's.koelpin@example.com' },
  { name: 'Jun Chen', email: 'j.chen@example.com' },
  { name: 'Maya Okafor', email: 'm.okafor@example.com' },
  { name: 'Priya Singh', email: 'p.singh@example.com' },
];
const pad5 = (n: number): string => String(n).padStart(5, '0');

/**
 * A synthetic estate: `flows` input→route→pipeline→output paths over `groups` worker groups, with
 * diurnal, flat, bursty and quiet sources, weekend dips, and injected spikes, regressions (with and
 * without a commit in the 30 minutes before), recoveries and outages. `anomalies` is the ground truth.
 */
export function syntheticWorld(opts: SyntheticOptions = {}): World {
  const seed = opts.seed ?? 1;
  const nFlows = Math.max(1, Math.floor(opts.flows ?? 50));
  const nGroups = Math.max(1, Math.min(nFlows, Math.floor(opts.groups ?? 1)));
  const end = opts.end ?? DEFAULT_END;
  const start = end - (opts.days ?? 30) * DAY_MS;
  const hostsPerGroup = Math.max(1, opts.hostsPerGroup ?? 2);
  const r = (...k: number[]): number => unit(seed, ...k);
  const groupIds = Array.from({ length: nGroups }, (_, g) => GROUP_IDS[g] ?? `wg_${g + 1}`);

  const groups: GroupRecord[] = groupIds.map((id) => ({ id, name: id, type: 'stream', description: `Synthetic worker group ${id}`, onPrem: false, provisioned: true }));
  const hosts: Record<string, string[]> = Object.fromEntries(groupIds.map((g) => [g, Array.from({ length: hostsPerGroup }, (_, h) => `wn-${g}-${h}`)]));
  const config: Record<string, GroupConfig> = {};
  const flows: FlowSpec[] = [];
  const commits: SyntheticCommit[] = [];

  for (const [g, gid] of groupIds.entries()) {
    const lo = Math.floor((g * nFlows) / nGroups);
    const hi = Math.floor(((g + 1) * nFlows) / nGroups);
    const n = hi - lo;
    const nOut = Math.max(3, Math.ceil(n / 12));
    const nPipe = Math.max(2, Math.ceil(n / 4));
    const outputs: CriblOutput[] = [
      { id: 'default', type: 'default', defaultId: 'devnull' },
      { id: 'devnull', type: 'devnull' },
      ...Array.from({ length: nOut }, (_, k): CriblOutput => {
        const type = OUTPUT_TYPES[(k + g) % OUTPUT_TYPES.length];
        return { id: `out_${type}_${k}`, type, description: `${type} destination ${k}`, systemFields: [] };
      }),
    ];
    const pipeRatio: number[] = [];
    const pipelines: CriblPipeline[] = [{ id: 'main', conf: { functions: [{ id: 'eval', filter: 'true', conf: { add: [{ name: 'cribl_breaker', value: "'main'" }] } }] } }];
    for (let k = 0; k < nPipe; k++) {
      const ratio = r(g, k, 101) < 0.15 ? 0 : 0.1 + 0.75 * r(g, k, 102);
      pipeRatio.push(ratio);
      const functions: CriblFunction[] = [];
      if (ratio > 0.5) functions.push({ id: 'sampling', filter: 'true', disabled: false, description: 'sample noisy events', conf: { rules: [{ filter: 'true', rate: 2 }] } });
      if (ratio > 0.2) functions.push({ id: 'eval', filter: 'true', disabled: false, description: 'trim unused fields', conf: { remove: ['raw_headers', 'debug_*'] } });
      if (ratio > 0) functions.push({ id: 'drop', filter: "severity=='debug'", disabled: false, description: 'drop debug', conf: {} });
      pipelines.push({ id: `pl_${gid}_${k}`, conf: { description: ratio === 0 ? 'passthrough' : `reduces ≈${Math.round(ratio * 100)}%`, functions } });
    }
    const inputs: CriblInput[] = [
      { id: `in_disabled_${gid}`, type: 'syslog', disabled: true, description: 'retired syslog listener' },
      { id: `in_idle_${gid}`, type: 'tcp', disabled: false, description: 'configured, no traffic yet' },
    ];
    const routes: CriblRoute[] = [];
    for (let i = lo; i < hi; i++) {
      const u = (k: number): number => r(i, k);
      const type = INPUT_TYPES[i % INPUT_TYPES.length];
      const inputId = `in_${type}_${pad5(i)}`;
      const out = outputs[2 + Math.floor(u(1) * nOut)];
      const pk = Math.floor(u(2) * nPipe);
      const pipelineId = `pl_${gid}_${pk}`;
      const shapeRoll = u(3);
      const shape: FlowShape = shapeRoll < 0.45 ? 'diurnal' : shapeRoll < 0.7 ? 'flat' : shapeRoll < 0.85 ? 'bursty' : 'quiet';
      const bytesPerDay = shape === 'quiet' ? 5e6 * Math.pow(40, u(4)) : 5e7 * Math.pow(8000, u(4)); // 50 MB … 400 GB/day
      const ratio = pipeRatio[pk] === 0 ? 0 : Math.min(0.95, Math.max(0.02, pipeRatio[pk] + (u(5) - 0.5) * 0.1));
      const routeId = `rt_${pad5(i)}`;
      inputs.push({ id: inputId, type, disabled: false, sendToRoutes: true, description: `synthetic ${type} source ${i}` });
      const routeOnly = i % 40 === 39;
      routes.push({
        id: routeId,
        name: `route ${i}`,
        final: true,
        disabled: false,
        pipeline: pipelineId,
        output: out.id,
        filter: routeOnly ? `__inputId.startsWith('${type}:') && sourcetype=='app_${i}'` : `__inputId=='${inputDim(type, inputId)}'`,
        description: routeOnly ? 'matches by sourcetype (attribution: route-only)' : '',
        clones: [],
        enableOutputExpression: false,
      });
      flows.push({
        id: `f${pad5(i)}`,
        groupId: gid,
        inputId,
        inputType: type,
        routeId,
        routeName: `route ${i}`,
        pipelineId,
        outputId: out.id,
        outputType: out.type,
        bytesPerDay: Math.round(bytesPerDay),
        eventBytes: Math.round(200 + 2800 * u(6)),
        ratio: round4(ratio),
        eventRatio: round4(ratio * (0.2 + 0.6 * u(7))),
        preRetention: 1,
        shape,
        weekendFactor: shape === 'diurnal' ? 0.55 + 0.25 * u(8) : shape === 'flat' ? 1 : shape === 'bursty' ? 0.7 + 0.3 * u(8) : 0.5,
        noise: shape === 'flat' ? 0.02 : 0.08,
        ratioNoise: 0.01,
        phaseHours: (u(9) - 0.5) * 6,
        activeFrom: start,
      });
    }
    routes.push({ id: 'default', name: 'default', final: true, disabled: false, pipeline: 'main', output: 'default', filter: 'true', description: '', clones: [], enableOutputExpression: false });
    config[gid] = { inputs, outputs, pipelines, routes: { id: 'default', routes } };
    commits.push(
      buildCommit({ seed, at: start - DAY_MS + g * 13_000, message: `create group ${gid}`, author: { name: 'Cribl System', email: 'cribl@leader.example' }, files: [groupFile(gid, 'cribl.yml')] }),
    );
  }

  // ── anomalies, placed deterministically in [start + 1 day, end − 2 h] ─────
  const a = opts.anomalies ?? {};
  const want = {
    spikes: a.spikes ?? Math.max(1, Math.round(nFlows / 100)),
    withCommit: a.regressionsWithCommit ?? Math.max(1, Math.round(nFlows / 150)),
    withoutCommit: a.regressionsWithoutCommit ?? Math.max(1, Math.round(nFlows / 200)),
    outages: a.outages ?? Math.max(1, Math.round(nFlows / 100)),
    benign: a.benignCommits ?? Math.max(2, Math.round(nFlows / 50)),
  };
  const windowLo = start + DAY_MS;
  const span = Math.max(HOUR_MS, end - 2 * HOUR_MS - windowLo);
  const when = (i: number, salt: number): number => floorMinute(windowLo + r(i, salt, 201) * span);
  const pickFlow = (i: number, salt: number, ok: (f: FlowSpec) => boolean = () => true): FlowSpec => {
    const eligible = flows.filter(ok);
    const pool = eligible.length > 0 ? eligible : flows;
    return pool[Math.floor(r(i, salt, 202) * pool.length)];
  };
  const effects: Effect[] = [];
  const anomalies: Anomaly[] = [];
  const quietWindows: [number, number][] = []; // no commit may land here (regressions without a commit)
  const author = (i: number): { name: string; email: string } => AUTHORS[Math.floor(r(i, 203) * AUTHORS.length)];
  const pipeConf = (f: FlowSpec): { cfg: GroupConfig; pipeline: CriblPipeline } => {
    const cfg = config[f.groupId];
    return { cfg, pipeline: cfg.pipelines.find((p) => p.id === f.pipelineId)! };
  };

  for (let i = 0; i < want.spikes; i++) {
    const f = pickFlow(i, 1, (x) => x.shape !== 'quiet');
    const s = when(i, 1);
    const e = s + (5 + Math.floor(r(i, 2) * 55)) * MINUTE_MS;
    const multiplier = round4(3 + 5 * r(i, 3));
    effects.push({ kind: 'volume', flowId: f.id, start: s, end: e, multiplier, note: 'spike' });
    anomalies.push({ kind: 'spike', flowId: f.id, start: s, end: e, multiplier });
  }
  for (let i = 0; i < want.withCommit + want.withoutCommit; i++) {
    const withCommit = i < want.withCommit;
    const f = pickFlow(i, 4, (x) => x.ratio >= 0.3 && x.shape !== 'quiet');
    let s = when(i, 4);
    // A regression "without a change" must have no commit anywhere in the 45 minutes before it.
    if (!withCommit)
      for (let guard = 0; guard < 50 && commits.some((c) => c.at >= s - 45 * MINUTE_MS && c.at <= s + MINUTE_MS); guard++) s += 3 * HOUR_MS;
    const recovers = r(i, 5) < 0.6;
    const e = recovers ? s + (30 + Math.floor(r(i, 6) * 210)) * MINUTE_MS : undefined;
    const after = round4(Math.max(0, f.ratio - (0.2 + 0.2 * r(i, 7))));
    effects.push({ kind: 'state', flowId: f.id, start: s, ...(e !== undefined ? { end: e } : {}), ratio: after, note: 'regression' });
    const anomaly: Anomaly = { kind: 'regression', flowId: f.id, start: s, ...(e !== undefined ? { end: e } : {}), before: f.ratio, after, withCommit };
    if (withCommit) {
      const { cfg, pipeline } = pipeConf(f);
      const broken = cloneConfig(cfg);
      const bp = broken.pipelines.find((p) => p.id === pipeline.id)!;
      if (bp.conf.functions.length > 0) bp.conf.functions[bp.conf.functions.length - 1].disabled = true;
      else bp.conf.functions.push({ id: 'comment', filter: 'true', conf: { comment: 'temporarily passthrough' } });
      const c = buildCommit({
        seed,
        at: s - (1 + Math.floor(r(i, 8) * 20)) * MINUTE_MS - Math.floor(r(i, 9) * 50_000),
        message: `update ${pipeline.id}: disable a reduction step`,
        author: author(i),
        files: [pipelineFile(f.groupId, pipeline.id)],
        before: cfg,
        after: broken,
        salt: `reg${i}`,
      });
      commits.push(c);
      anomaly.commitHash = c.hash;
    } else quietWindows.push([s - 45 * MINUTE_MS, s + MINUTE_MS]);
    anomalies.push(anomaly);
  }
  for (let i = 0; i < want.outages; i++) {
    const f = pickFlow(i, 10, (x) => x.shape !== 'quiet');
    const s = when(i, 10);
    const e = s + (10 + Math.floor(r(i, 11) * 110)) * MINUTE_MS;
    effects.push({ kind: 'outage', flowId: f.id, start: s, end: e, note: 'outage' });
    anomalies.push({ kind: 'outage', flowId: f.id, start: s, end: e });
  }
  for (let i = 0; i < want.benign; i++) {
    const f = pickFlow(i, 12);
    let at = when(i, 12) + Math.floor(r(i, 13) * 59_000);
    for (let guard = 0; guard < 50 && quietWindows.some(([x, y]) => at >= x && at <= y); guard++) at += 2 * HOUR_MS;
    const { cfg, pipeline } = pipeConf(f);
    const tweaked = cloneConfig(cfg);
    const tp = tweaked.pipelines.find((p) => p.id === pipeline.id)!;
    tp.conf.description = `${tp.conf.description ?? ''} (reviewed)`.trim();
    commits.push(
      buildCommit({ seed, at, message: `docs: describe ${pipeline.id}`, author: author(i + 100), files: [pipelineFile(f.groupId, pipeline.id)], before: cfg, after: tweaked, salt: `benign${i}` }),
    );
  }

  return { seed, start, end, groups, hosts, processesPerHost: Math.max(1, opts.processesPerHost ?? 2), flows, effects, commits, config, anomalies };
}
