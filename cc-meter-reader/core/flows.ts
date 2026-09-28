// core/flows.ts — the routing table → priced paths (SPEC 7 steps 3 and 5).
// buildFlows walks each group's routes in order and turns them into Flow records;
// attributeWindow splits one metrics window's bytes across those flows without inventing any.

import type {
  Attribution,
  ByteEvent,
  Flow,
  FlowKey,
  GroupInventory,
  InputInfo,
  InventoryDoc,
  MetricsWindow,
  ObjectKey,
  ObjectKind,
  OutputInfo,
  RouteInfo,
  Settings,
} from './types.ts';

/** Input/output types that are Cribl-internal plumbing, hidden unless settings.includeInternal. */
export const INTERNAL_TYPES: readonly string[] = ['cribl', 'cribl_metrics', 'criblmetrics', 'cribl_internal', 'system_metrics', 'system_state'];
/** The demo-object tag (SPEC 2). */
export const DEMO_TAG = '[meter-reader-demo]';

// ─── Keys ────────────────────────────────────────────────────────────────────

const seg = (s: string | undefined): string => (s === undefined || s === null || s === '' ? '-' : s);

/** `${groupId}|${inputId}|${routeId}|${pipelineId}|${outputId}`; a missing segment is '-'. */
export function makeFlowKey(groupId: string, inputId: string, routeId: string, pipelineId: string, outputId: string): FlowKey {
  return [seg(groupId), seg(inputId), seg(routeId), seg(pipelineId), seg(outputId)].join('|');
}

export interface FlowKeyParts {
  groupId: string;
  inputId: string;
  routeId: string;
  pipelineId: string;
  outputId: string;
}

export function parseFlowKey(key: FlowKey): FlowKeyParts | null {
  const p = typeof key === 'string' ? key.split('|') : [];
  if (p.length !== 5) return null;
  return { groupId: p[0], inputId: p[1], routeId: p[2], pipelineId: p[3], outputId: p[4] };
}

/** `${kind}:${groupId}:${id}` e.g. 'pipe:default:mrd_pay_sample'. */
export function objectKey(kind: ObjectKind, groupId: string, id: string): ObjectKey {
  return `${kind}:${groupId}:${id}`;
}

const KINDS: readonly ObjectKind[] = ['in', 'route', 'pipe', 'out'];

export function parseObjectKey(key: ObjectKey): { kind: ObjectKind; groupId: string; id: string } | null {
  const m = typeof key === 'string' ? /^([a-z]+):([^:]*):(.+)$/.exec(key) : null;
  if (!m || !KINDS.includes(m[1] as ObjectKind)) return null;
  return { kind: m[1] as ObjectKind, groupId: m[2], id: m[3] };
}

/** The four object keys a flow touches (inputKey is absent for an unattributed '-' input). */
export function flowObjectKeys(flow: Pick<Flow, 'groupId' | 'inputId' | 'routeId' | 'pipelineId' | 'outputId'>): {
  input?: ObjectKey;
  route?: ObjectKey;
  pipeline?: ObjectKey;
  output?: ObjectKey;
} {
  const g = flow.groupId;
  return {
    input: flow.inputId !== '-' ? objectKey('in', g, flow.inputId) : undefined,
    route: flow.routeId !== '-' ? objectKey('route', g, flow.routeId) : undefined,
    pipeline: flow.pipelineId !== '-' ? objectKey('pipe', g, flow.pipelineId) : undefined,
    output: flow.outputId !== '-' ? objectKey('out', g, flow.outputId) : undefined,
  };
}

// ─── Route filters ───────────────────────────────────────────────────────────

/** A reference to an input in a route filter: an exact `__inputId` value or a startsWith prefix. */
export interface InputRef {
  value: string;
  prefix: boolean;
}
export type FilterMatch =
  | { kind: 'all' }
  /** `exact`: the filter is nothing but these input references (so a FINAL route claims them fully). */
  | { kind: 'inputs'; refs: InputRef[]; exact: boolean }
  | { kind: 'unknown' };

const Q = `(['"\`])((?:(?!\\1)[^\\\\]|\\\\.)*)\\1`; // a quoted string literal; group 1 quote, 2 body
const RE_EQ = new RegExp(`__inputId\\s*===?\\s*${Q}`, 'g');
const RE_EQ_REV = new RegExp(`${Q}\\s*===?\\s*__inputId\\b`, 'g');
const RE_STARTS = new RegExp(`__inputId\\s*\\.\\s*startsWith\\(\\s*${Q}\\s*\\)`, 'g');
const RE_INCLUDES = /\[([^\]]*)\]\s*\.\s*includes\(\s*__inputId\s*\)/g;
const RE_IN = /__inputId\s+in\s+\[([^\]]*)\]/g;
const RE_LIST_ITEM = new RegExp(Q, 'g');

/** Parses `'a', "b"` → ['a','b']; undefined when the list holds anything but string literals. */
function parseStringList(body: string): string[] | undefined {
  const items: string[] = [];
  const rest = body.replace(RE_LIST_ITEM, (_m, _q: string, v: string) => {
    items.push(v);
    return '';
  });
  return /^[\s,]*$/.test(rest) ? items : undefined;
}

/** Strips balanced outer parentheses: '((x))' → 'x'. */
function stripOuterParens(s: string): string {
  let out = s.trim();
  for (;;) {
    if (!out.startsWith('(') || !out.endsWith(')')) return out;
    let depth = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i] === '(') depth++;
      else if (out[i] === ')') depth--;
      if (depth === 0 && i < out.length - 1) return out; // the first '(' closes before the end
    }
    out = out.slice(1, -1).trim();
  }
}

/**
 * Classifies a route filter by the inputs it selects. Supported: `true`/empty (all inputs);
 * `__inputId=='datagen:x'` (== or ===, any quote, either operand order); `__inputId.startsWith('datagen:x')`;
 * `['a','b'].includes(__inputId)`; `__inputId in ['a','b']`; ORs of those (exact); and any of those
 * AND-ed with other conditions (a partial claim on the listed inputs). Everything else — negations,
 * ORs with non-input conditions, no input reference — is 'unknown' (route-only attribution).
 */
export function parseRouteFilter(filter: string | undefined): FilterMatch {
  const f = stripOuterParens(filter ?? '');
  if (f === '' || f === 'true') return { kind: 'all' };

  const refs: InputRef[] = [];
  let bad = false;
  let rest = f
    .replace(RE_STARTS, (_m, _q: string, v: string) => {
      refs.push({ value: v, prefix: true });
      return ' X ';
    })
    .replace(RE_EQ, (_m, _q: string, v: string) => {
      refs.push({ value: v, prefix: false });
      return ' X ';
    })
    .replace(RE_EQ_REV, (_m, _q: string, v: string) => {
      refs.push({ value: v, prefix: false });
      return ' X ';
    })
    .replace(RE_INCLUDES, (_m, body: string) => {
      const items = parseStringList(body);
      if (!items) bad = true;
      for (const v of items ?? []) refs.push({ value: v, prefix: false });
      return ' X ';
    })
    .replace(RE_IN, (_m, body: string) => {
      const items = parseStringList(body);
      if (!items) bad = true;
      for (const v of items ?? []) refs.push({ value: v, prefix: false });
      return ' X ';
    });

  if (bad || refs.length === 0) return { kind: 'unknown' };
  rest = rest.replace(/\s+/g, '');
  if (rest.includes('__inputId')) return { kind: 'unknown' };
  // Collapse parenthesized ORs of input references: '(X||X)' → 'X'.
  for (let prev = ''; prev !== rest; ) {
    prev = rest;
    rest = rest.replace(/\((?:X\|\|)*X\)/g, 'X');
  }
  if (/^X(\|\|X)*$/.test(rest)) return { kind: 'inputs', refs, exact: true };
  if (rest.includes('||') || /!\(|!X/.test(rest)) return { kind: 'unknown' };
  return { kind: 'inputs', refs, exact: false };
}

// ─── Flow building ───────────────────────────────────────────────────────────

/** Splits a metrics/filter input value '<type>:<id>' → { type, id }; a bare id has no type. */
export function splitInputValue(value: string): { type?: string; id: string } {
  const i = value.indexOf(':');
  return i > 0 ? { type: value.slice(0, i), id: value.slice(i + 1) } : { id: value };
}

function isDemoTagged(obj: { id: string; description?: string }): boolean {
  return obj.id.startsWith('mrd_') || (obj.description ?? '').includes(DEMO_TAG);
}

/**
 * Internal plumbing (hidden unless includeInternal): Cribl's own inputs/outputs, and Datagen
 * inputs that are not demo-tagged (SPEC 7 step 3: datagen counts as external only when tagged;
 * the `mrd_` id prefix is accepted as the tag too).
 */
export function isInternalInput(input: Pick<InputInfo, 'id' | 'type' | 'description'>): boolean {
  const t = (input.type ?? '').toLowerCase();
  if (INTERNAL_TYPES.includes(t)) return true;
  return t === 'datagen' && !isDemoTagged(input);
}
export function isInternalOutput(output: Pick<OutputInfo, 'type'>): boolean {
  return INTERNAL_TYPES.includes((output.type ?? '').toLowerCase());
}

/** The destination a route delivers to: route.output → the pipeline's conf.output → 'default', resolving 'default' through its defaultId. */
export function resolveRouteOutput(route: Pick<RouteInfo, 'output' | 'pipeline'>, group: GroupInventory): string {
  let id = route.output || group.pipelines?.find((p) => p.id === route.pipeline)?.output || 'default';
  for (let hops = 0; hops < 3; hops++) {
    const out = group.outputs?.find((o) => o.id === id);
    const isDefault = out ? out.type === 'default' : id === 'default';
    if (!isDefault || !out?.defaultId || out.defaultId === id) break;
    id = out.defaultId;
  }
  return id;
}

function resolveRefs(refs: InputRef[], inputs: InputInfo[]): InputInfo[] {
  const out = new Map<string, InputInfo>();
  for (const ref of refs) {
    if (ref.prefix) {
      for (const inp of inputs) {
        const full = `${inp.type}:${inp.id}`;
        if (full.startsWith(ref.value) || (!ref.value.includes(':') && inp.id.startsWith(ref.value))) out.set(inp.id, inp);
      }
      continue;
    }
    const { type, id } = splitInputValue(ref.value);
    const found = inputs.find((inp) => (type !== undefined ? inp.type === type && inp.id === id : inp.id === id));
    // Not in inventory (a pack input, or inventory not refreshed yet): keep it, typed from its prefix.
    out.set(found?.id ?? id, found ?? { id, type: type ?? 'unknown' });
  }
  return [...out.values()];
}

/**
 * Walks every group's routing table in order and returns one Flow per (input, route) path:
 * - disabled routes, inputs and outputs are skipped; internal ones unless settings.includeInternal;
 * - a route's inputs come from its filter (parseRouteFilter); `true` selects every eligible input
 *   not already fully claimed by an earlier FINAL route; an unknown filter yields one flow with
 *   input '-' and attribution 'route-only'; routes after a FINAL catch-all are dead;
 * - QuickConnect inputs (sendToRoutes false) produce their connection flows (routeId '-');
 * - any flow touching an object in settings.excludedObjectKeys is dropped.
 */
export function buildFlows(inventory: InventoryDoc, settings: Pick<Settings, 'includeInternal' | 'excludedObjectKeys'>): Flow[] {
  const flows = new Map<FlowKey, Flow>();
  const excluded = new Set(settings.excludedObjectKeys ?? []);
  const includeInternal = settings.includeInternal === true;

  for (const [gid, group] of Object.entries(inventory?.byGroup ?? {})) {
    const inputs = group.inputs ?? [];
    const outputsById = new Map((group.outputs ?? []).map((o) => [o.id, o]));
    const eligibleInput = (inp: InputInfo): boolean => !inp.disabled && (includeInternal || !isInternalInput(inp));
    const routable = inputs.filter((inp) => inp.sendToRoutes !== false);

    const emit = (inputId: string, routeId: string, pipelineId: string, outputId: string, attribution: Attribution): void => {
      const out = outputsById.get(outputId);
      if (out?.disabled) return;
      if (out && !includeInternal && isInternalOutput(out)) return;
      const f: Flow = {
        key: makeFlowKey(gid, inputId, routeId, pipelineId, outputId),
        groupId: gid,
        inputId: seg(inputId),
        routeId: seg(routeId),
        pipelineId: seg(pipelineId),
        outputId: seg(outputId),
        attribution,
      };
      const keys = flowObjectKeys(f);
      if ([keys.input, keys.route, keys.pipeline, keys.output].some((k) => k !== undefined && excluded.has(k))) return;
      if (!flows.has(f.key)) flows.set(f.key, f);
    };

    const fullyClaimed = new Set<string>();
    for (const route of group.routes ?? []) {
      if (route.disabled) continue;
      const isFinal = route.final !== false;
      const match = parseRouteFilter(route.filter);
      const outputId = resolveRouteOutput(route, group);
      const pipelineId = route.pipeline || '-';
      if (match.kind === 'unknown') {
        emit('-', route.id, pipelineId, outputId, 'route-only');
        continue;
      }
      const selected =
        match.kind === 'all' ? routable : resolveRefs(match.refs, routable).filter((i) => i.sendToRoutes !== false);
      for (const inp of selected) {
        if (fullyClaimed.has(inp.id) || !eligibleInput(inp)) continue;
        emit(inp.id, route.id, pipelineId, outputId, 'route');
      }
      if (isFinal && match.kind === 'all') break; // a FINAL catch-all: every later route is dead
      if (isFinal && match.kind === 'inputs' && match.exact) for (const inp of selected) fullyClaimed.add(inp.id);
    }

    for (const inp of inputs) {
      if (inp.sendToRoutes !== false || !eligibleInput(inp)) continue;
      for (const c of inp.connections ?? []) emit(inp.id, '-', c.pipeline ?? '-', c.output, 'proportional');
    }
  }
  return [...flows.values()];
}

// ─── Attribution of one metrics window ──────────────────────────────────────

export interface FlowWindow {
  inB: number;
  outB: number;
  inE: number;
  outE: number;
  attribution: Attribution;
}

/**
 * Splits an integer total across weights by largest remainder: Σ result = round(total) exactly,
 * so rounding never creates or loses a byte. Zero total weight splits evenly.
 */
export function apportion(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const T = Number.isFinite(total) && total > 0 ? Math.round(total) : 0;
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  let W = w.reduce((a, b) => a + b, 0);
  if (W <= 0) {
    w.fill(1);
    W = n;
  }
  const raw = w.map((x) => (T * x) / W);
  const out = raw.map((x) => Math.floor(x));
  let deficit = T - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; deficit > 0 && k < order.length; k++, deficit--) out[order[k].i] += 1;
  return out;
}

/** Normalizes a metrics map so `${gid}:${type}:${id}` keys are also reachable as `${gid}:${id}`. */
function normalizeKeys(rec: Record<string, ByteEvent> | undefined): Map<string, ByteEvent> {
  const out = new Map<string, ByteEvent>();
  for (const [k, v] of Object.entries(rec ?? {})) {
    const first = k.indexOf(':');
    if (first < 0) continue;
    const gid = k.slice(0, first);
    const rest = k.slice(first + 1);
    const second = rest.indexOf(':');
    const norm = second > 0 ? `${gid}:${rest.slice(second + 1)}` : k;
    const prev = out.get(norm);
    out.set(norm, prev ? { bytes: prev.bytes + v.bytes, events: prev.events + v.events } : { bytes: v.bytes, events: v.events });
  }
  return out;
}

const ZERO: ByteEvent = { bytes: 0, events: 0 };

/**
 * Attributes one metrics window to flows (SPEC 7 step 5, adapted to the measured series):
 * 1. route bytes when the window has them: a route's in/out bytes split across its flows by each
 *    input's share of total.in_bytes (evenly when unknown). route.* counts are pre-FINAL-cascade,
 *    so a flow never receives more than its input produced: it is capped at the input's bytes and
 *    its out-bytes/events scale by the same factor;
 * 2. else pipeline bytes, split the same way across the flows using the pipeline;
 * 3. else proportional: each input's bytes split evenly across its flows, and each output's bytes
 *    across the flows feeding it in proportion to their in-bytes.
 * Flows without route series (QuickConnect) take the proportional remainder of their input and
 * output after the route-attributed flows. Missing series are 0; bytes are never invented.
 */
export interface AttributeOptions {
  /** `${groupId}:${pipelineId}` of pipelines with no enabled functions: out = in by construction. */
  passthroughPipelines?: ReadonlySet<string>;
  /** Reconcile to the exact Source/Destination counters (default true; false = raw route estimates). */
  reconcile?: boolean;
}

/** Tolerance within which a Source's routed bytes are treated as the same events (final routes). */
const INPUT_RECONCILE_TOLERANCE = 0.1;
/**
 * DECISIONS D56: a Destination counts the same events its flows sent (Cribl's route and destination event counters
 * are exact counts, not size estimates) within this share, or one event, whichever is larger. Measured on the live
 * rig 9/27 (147 minutes, four destinations): equal to the event in every minute.
 */
const DEST_EVENT_TOLERANCE = 0.01;
/**
 * Rules round 2 (usefulness): a passthrough pipeline is pinned to out = in only while the minute's own series agree.
 * The inventory is the COMMITTED configuration: a route moved off a pack reads as passthrough from the commit on, while
 * the workers keep running the pack until the deploy reaches them (live, 27 Sep 16:43–16:46Z: mrd_siem_prod still
 * received pack-reduced bytes for three minutes). Pinning those minutes overstated the pinned flows, and the
 * destination's leftover bytes re-split onto an untouched sibling (mrd_windows_dc read 0.354 → 0.67 → 0.342, and
 * opened a +$103/day good-news alert credited to the neighbour's commit). A passthrough route's estimate reads a few
 * bytes HIGH (docs/RIG.md §9), so a route or pipeline estimate whose bytes out fall more than 5 % under its bytes in
 * says the flow is still being reduced: that minute it is split like any reshaped flow, by its estimate.
 */
const PIN_MIN_OUT_SHARE = 0.95;

/** The minute's own route or pipeline series say a flow is still reduced (the inventory's passthrough is not running yet). */
function stillReduced(w: FlowWindow | undefined): boolean {
  if (!w || (w.attribution !== 'route' && w.attribution !== 'pipeline')) return false;
  return w.inB > 0 && w.outB < w.inB * PIN_MIN_OUT_SHARE;
}

export function attributeWindow(flows: Flow[], metrics: MetricsWindow, options: AttributeOptions = {}): Record<FlowKey, FlowWindow> {
  const estimated = attributeEstimates(flows, metrics);
  if (options.reconcile === false) return estimated;
  return reconcileWindow(flows, metrics, estimated, options.passthroughPipelines ?? new Set());
}

/**
 * DECISIONS D20. Cribl's per-route byte counters are an ESTIMATE of event size: exact for events a
 * pipeline leaves whole, but 24–68 % low for events a pipeline reshapes, and a few bytes high per event
 * on passthrough routes (measured on the live rig, docs/RIG.md §9). The per-Source (`total.in_bytes`)
 * and per-Destination (`total.out_bytes`) counters are exact (within 0.16 % of delivered bytes). So:
 *   1. each Source's flows are scaled to sum to that Source's measured bytes (when they are the same
 *      events: routed total within ±10 % of the Source, i.e. final routes, no cloning);
 *   2. flows through a passthrough pipeline are pinned to out = in;
 *   3. the rest of each Destination's measured bytes is split across its other flows by their route
 *      estimates (by bytes in when no estimate exists).
 * Per-Source and per-Destination figures are therefore exact; only the split inside a destination that
 * receives several reshaped flows relies on the estimate, and Show the math says so.
 *
 * DECISIONS D56: whether a Destination's traffic is these flows is decided by its EVENT counter, which is an exact
 * count on both sides: the same events (±1 %) → reconcile, whatever the byte estimate says (a reshaping pipeline's
 * route estimate can drift past half the delivered bytes, and the old 0.5–2× byte guard then priced a flow at half
 * what its destination received); more events than the flows sent → other traffic reaches it, keep the estimates.
 * Without event counts, or with fewer events than routed (drops), the 0.5–2× byte band still decides. A flow is
 * labelled 'reconciled' only when its bytes OUT were reconciled: that is the side Paid prices and the side the
 * Receipt's "Where the bytes come from" calls exact.
 */
export function reconcileWindow(
  flows: Flow[],
  metrics: MetricsWindow,
  estimated: Record<FlowKey, FlowWindow>,
  passthrough: ReadonlySet<string>,
): Record<FlowKey, FlowWindow> {
  const inputs = normalizeKeys(metrics.inputs);
  const outputs = normalizeKeys(metrics.outputs);
  const out: Record<FlowKey, FlowWindow> = {};
  for (const [k, w] of Object.entries(estimated)) out[k] = { ...w };

  // 1. Sources.
  const bySource = new Map<string, Flow[]>();
  for (const f of flows) {
    if (f.inputId === '-' || !out[f.key]) continue;
    const k = `${f.groupId}:${f.inputId}`;
    (bySource.get(k) ?? bySource.set(k, []).get(k)!).push(f);
  }
  for (const [k, group] of bySource) {
    const measured = inputs.get(k);
    if (!measured || measured.bytes <= 0) continue;
    const routed = group.reduce((a, f) => a + out[f.key].inB, 0);
    if (routed <= 0) continue;
    if (Math.abs(routed - measured.bytes) > measured.bytes * INPUT_RECONCILE_TOLERANCE) continue;
    const inB = apportion(measured.bytes, group.map((f) => out[f.key].inB));
    const inE = apportion(measured.events, group.map((f) => out[f.key].inE || out[f.key].inB));
    group.forEach((f, i) => {
      out[f.key].inB = inB[i];
      out[f.key].inE = inE[i];
    });
  }

  // 2–3. Destinations.
  const byDest = new Map<string, Flow[]>();
  for (const f of flows) {
    if (!out[f.key]) continue;
    const k = `${f.groupId}:${f.outputId}`;
    (byDest.get(k) ?? byDest.set(k, []).get(k)!).push(f);
  }
  for (const [k, group] of byDest) {
    const measured = outputs.get(k);
    if (!measured) continue;
    // A passthrough flow the minute's series still show reduced (a deploy on its way to the workers) is not pinned.
    const isPinned = (f: Flow): boolean => passthrough.has(`${f.groupId}:${f.pipelineId}`) && !stillReduced(estimated[f.key]);
    const pinned = group.filter(isPinned);
    const rest = group.filter((f) => !isPinned(f));
    const estTotal = group.reduce((a, f) => a + (isPinned(f) ? out[f.key].inB : out[f.key].outB), 0);
    const estEvents = group.reduce((a, f) => a + (isPinned(f) ? out[f.key].inE : out[f.key].outE), 0);
    // Only reconcile when the destination's traffic is (essentially) these flows: a destination that also
    // receives unmetered traffic (excluded or internal Sources) would otherwise be over-attributed. The event
    // counters decide when both sides have them (D56); the byte band is the fallback.
    const eventsKnown = measured.events > 0 && estEvents > 0;
    const slack = Math.max(1, measured.events * DEST_EVENT_TOLERANCE);
    const sameEvents = eventsKnown && Math.abs(measured.events - estEvents) <= slack;
    const extraEvents = eventsKnown && measured.events - estEvents > slack;
    const inByteBand = estTotal > 0 && measured.bytes <= estTotal * 2 && measured.bytes >= estTotal * 0.5;
    if (!sameEvents && (extraEvents || !inByteBand)) continue;
    let pinnedBytes = 0;
    for (const f of pinned) {
      out[f.key].outB = out[f.key].inB;
      out[f.key].outE = out[f.key].inE;
      out[f.key].attribution = 'reconciled';
      pinnedBytes += out[f.key].inB;
    }
    let remaining = measured.bytes - pinnedBytes;
    if (remaining < 0) {
      // Pinned flows alone exceed the destination (timing skew between counters): scale them to fit.
      const scaled = apportion(measured.bytes, pinned.map((f) => out[f.key].outB));
      pinned.forEach((f, i) => (out[f.key].outB = scaled[i]));
      remaining = 0;
    }
    if (rest.length === 0) continue;
    const weights = rest.map((f) => (out[f.key].outB > 0 ? out[f.key].outB : out[f.key].inB));
    const outB = apportion(remaining, weights);
    const pinnedEvents = pinned.reduce((a, f) => a + out[f.key].outE, 0);
    const outE = apportion(Math.max(0, measured.events - pinnedEvents), rest.map((f) => out[f.key].outE || 1));
    rest.forEach((f, i) => {
      out[f.key].outB = outB[i];
      out[f.key].outE = outE[i];
      out[f.key].attribution = 'reconciled';
    });
  }
  return out;
}

/** The pre-D20 attribution from route/pipeline series and proportional fallbacks (estimates). */
function attributeEstimates(flows: Flow[], metrics: MetricsWindow): Record<FlowKey, FlowWindow> {
  const inputs = normalizeKeys(metrics.inputs);
  const outputs = normalizeKeys(metrics.outputs);
  const routesIn = metrics.routesIn ?? {};
  const routesOut = metrics.routesOut ?? {};
  const pipesIn = metrics.pipelinesIn ?? {};
  const pipesOut = metrics.pipelinesOut ?? {};
  const routeMode = metrics.has?.routeBytes === true;
  const pipeMode = !routeMode && metrics.has?.pipelineBytes === true;

  const result: Record<FlowKey, FlowWindow> = {};
  const shared = new Map<string, Flow[]>();
  const proportional: Flow[] = [];
  for (const f of flows) {
    if (routeMode && f.routeId !== '-') {
      const k = `r|${f.groupId}:${f.routeId}`;
      (shared.get(k) ?? shared.set(k, []).get(k)!).push(f);
    } else if (pipeMode && f.pipelineId !== '-' && f.routeId !== '-') {
      const k = `p|${f.groupId}:${f.pipelineId}`;
      (shared.get(k) ?? shared.set(k, []).get(k)!).push(f);
    } else {
      proportional.push(f);
    }
  }

  // 1–2. Route or pipeline series, split by input share and capped at the input's bytes.
  for (const [k, group] of shared) {
    const isRoute = k.startsWith('r|');
    const key = k.slice(2);
    const sIn = (isRoute ? routesIn[key] : pipesIn[key]) ?? ZERO;
    const sOut = (isRoute ? routesOut[key] : pipesOut[key]) ?? ZERO;
    const weights = group.map((f) => (f.inputId === '-' ? 0 : (inputs.get(`${f.groupId}:${f.inputId}`)?.bytes ?? 0)));
    const inB = apportion(sIn.bytes, weights);
    const outB = apportion(sOut.bytes, weights);
    const inE = apportion(sIn.events, weights);
    const outE = apportion(sOut.events, weights);
    group.forEach((f, i) => {
      let w: FlowWindow = {
        inB: inB[i],
        outB: outB[i],
        inE: inE[i],
        outE: outE[i],
        attribution: f.inputId === '-' ? 'route-only' : isRoute ? 'route' : 'pipeline',
      };
      const input = f.inputId === '-' ? undefined : inputs.get(`${f.groupId}:${f.inputId}`);
      if (input && w.inB > input.bytes) {
        const factor = w.inB > 0 ? input.bytes / w.inB : 0;
        w = {
          ...w,
          inB: input.bytes,
          outB: Math.round(w.outB * factor),
          inE: Math.round(w.inE * factor),
          outE: Math.round(w.outE * factor),
        };
      }
      result[f.key] = w;
    });
  }

  // 3. Proportional flows share what the attributed flows left of each input and output.
  const usedIn = new Map<string, ByteEvent>();
  const usedOut = new Map<string, ByteEvent>();
  for (const f of flows) {
    const w = result[f.key];
    if (!w) continue;
    const ik = `${f.groupId}:${f.inputId}`;
    const ok = `${f.groupId}:${f.outputId}`;
    const ui = usedIn.get(ik) ?? { bytes: 0, events: 0 };
    usedIn.set(ik, { bytes: ui.bytes + w.inB, events: ui.events + w.inE });
    const uo = usedOut.get(ok) ?? { bytes: 0, events: 0 };
    usedOut.set(ok, { bytes: uo.bytes + w.outB, events: uo.events + w.outE });
  }
  const remaining = (m: Map<string, ByteEvent>, used: Map<string, ByteEvent>, k: string): ByteEvent => {
    const total = m.get(k) ?? ZERO;
    const u = used.get(k) ?? ZERO;
    return { bytes: Math.max(0, total.bytes - u.bytes), events: Math.max(0, total.events - u.events) };
  };

  const byInput = new Map<string, Flow[]>();
  for (const f of proportional) {
    result[f.key] = { inB: 0, outB: 0, inE: 0, outE: 0, attribution: 'proportional' };
    if (f.inputId === '-') continue;
    const k = `${f.groupId}:${f.inputId}`;
    (byInput.get(k) ?? byInput.set(k, []).get(k)!).push(f);
  }
  for (const [k, group] of byInput) {
    const left = remaining(inputs, usedIn, k);
    const even = group.map(() => 1);
    const b = apportion(left.bytes, even);
    const e = apportion(left.events, even);
    group.forEach((f, i) => {
      result[f.key].inB = b[i];
      result[f.key].inE = e[i];
    });
  }
  const byOutput = new Map<string, Flow[]>();
  for (const f of proportional) {
    const k = `${f.groupId}:${f.outputId}`;
    (byOutput.get(k) ?? byOutput.set(k, []).get(k)!).push(f);
  }
  for (const [k, group] of byOutput) {
    const left = remaining(outputs, usedOut, k);
    const weights = group.map((f) => result[f.key].inB);
    const b = apportion(left.bytes, weights);
    const e = apportion(left.events, weights);
    group.forEach((f, i) => {
      result[f.key].outB = b[i];
      result[f.key].outE = e[i];
    });
  }
  return result;
}

/** `${groupId}:${pipelineId}` of every pipeline with no enabled functions (passthrough by construction). */
export function passthroughPipelines(inventory: InventoryDoc | null | undefined): Set<string> {
  const set = new Set<string>();
  for (const [gid, g] of Object.entries(inventory?.byGroup ?? {})) {
    for (const p of g.pipelines ?? []) {
      if (p.packId || p.id.startsWith('pack:')) continue; // a Pack's functions live inside it: never a passthrough
      if ((p.functions ?? []).every((fn) => fn.disabled === true)) set.add(`${gid}:${p.id}`);
    }
  }
  return set;
}
