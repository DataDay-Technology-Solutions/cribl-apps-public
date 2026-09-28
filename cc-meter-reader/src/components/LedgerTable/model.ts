// src/components/LedgerTable/model.ts — the Ledger's pure data model (PRD 8.3, SPEC 13, SPEC 17 columns).
//
// Snapshot flows → table rows with humanized labels, a single display status (incident > muted > state),
// then search / filter / sort. Everything here is pure so the unit tests can pin it; the view only wires
// URL params (SPEC 13 "Persistence": filters live in the URL, never in KV) to these functions.

import { humanize } from '../../../core/humanize.ts';
import { flowObjectKeys, parseFlowKey, parseObjectKey } from '../../../core/flows.ts';
import { severityRank } from '../../../core/incidents.ts';
import { INFLATION_NOISE } from '../../../core/pricing.ts';
import { OTHER_FLOW_KEY, diversionTarget } from '../../../core/snapshot.ts';
import type { FlowFigures, Incident, IncidentType, ObjectKey, Severity, Snapshot } from '../../../core/types.ts';

/** What the Status column shows for a row. Incident types come first, then the flow's own state. */
export type RowStatus = IncidentType | 'muted' | 'unpriced' | 'learning' | 'idle' | 'ok';

export const ROW_STATUSES: readonly RowStatus[] = [
  'regression',
  'spike',
  'budget',
  'goodnews',
  'muted',
  'unpriced',
  'learning',
  'ok',
  'idle',
];

export function isRowStatus(value: string | null | undefined): value is RowStatus {
  return typeof value === 'string' && (ROW_STATUSES as readonly string[]).includes(value);
}

export interface LedgerRow {
  /** the FlowKey — stable across sweeps, used as the React key */
  id: string;
  flow: FlowFigures;
  groupId: string;
  sourceId: string;
  routeId: string;
  pipelineId: string;
  outputId: string;
  source: string;
  route: string;
  pipeline: string;
  destination: string;
  /** the object keys this flow touches (in / route / pipe / out), for ?object= deep links */
  objectKeys: ObjectKey[];
  status: RowStatus;
  /** severity of the open incident that set `status`, if any */
  severity?: Severity;
  incident?: Incident;
  /** minutes left on a demo mute */
  mutedMinutes?: number;
  /** P1-F07: the mute is a member's (settings.mutes), not a demo change's */
  mutedByMember?: boolean;
  /**
   * byte reduction 1 − out/in over the last hour, per day; null when nothing came in. P1-F03: negative when a pipeline
   * sends out more than came in (enrichment, GeoIP) beyond the counting noise.
   */
  reduction: number | null;
  /** P1-F02: a diversion credit — the destination (in words) this flow's data is credited at */
  divertedTo?: string;
  /** priced? (unpriced rows show an em dash for money) */
  priced: boolean;
  /** lower-cased haystack for search */
  haystack: string;
  /**
   * The Receipt's custom range (P2-W14): this flow's money summed over the window (core/range.ts byFlow), present
   * only while a range is applied. The money columns, their sort, the bars and the totals read it instead of the
   * per-day rates.
   */
  window?: WindowMoney;
}

/** Money summed over a window, integer millicents (core/range.ts `Money`). */
export interface WindowMoney {
  whpM: number;
  paidM: number;
  savedM: number;
}

const NO_MONEY: WindowMoney = { whpM: 0, paidM: 0, savedM: 0 };

function hasMoney(m: WindowMoney | undefined): boolean {
  return !!m && (m.whpM !== 0 || m.paidM !== 0 || m.savedM !== 0);
}

/** Every row with its window money (a flow the window never metered sums to zero). */
export function withWindow(rows: readonly LedgerRow[], byFlow: Readonly<Record<string, WindowMoney>>): LedgerRow[] {
  return rows.map((r) => ({ ...r, window: byFlow[r.id] ?? NO_MONEY }));
}

/**
 * Flows the window metered that the latest sweep no longer lists (a removed route, a renamed pipeline): how many
 * and what they add up to, so the table's totals plus this line equal the Receipt's figure for the same window.
 */
export function unlistedWindow(rows: readonly LedgerRow[], byFlow: Readonly<Record<string, WindowMoney>>): { flows: number; money: WindowMoney } {
  const listed = new Set(rows.map((r) => r.id));
  const money = { ...NO_MONEY };
  let flows = 0;
  for (const [key, m] of Object.entries(byFlow)) {
    if (listed.has(key) || !hasMoney(m)) continue;
    flows++;
    money.whpM += m.whpM;
    money.paidM += m.paidM;
    money.savedM += m.savedM;
  }
  return { flows, money };
}

/** Does this row show money? Its window's when a range is applied (any money summed), else its destination's price. */
export function showsMoney(row: Pick<LedgerRow, 'priced' | 'window'>): boolean {
  return row.window ? row.priced || hasMoney(row.window) : row.priced;
}

/** The row's would-have-paid / paid / saved: the window's sums under a range, else per day at the last hour's rate. */
export function rowMoney(row: Pick<LedgerRow, 'flow' | 'window'>): WindowMoney {
  return row.window ?? { whpM: row.flow.whpPerDayM, paidM: row.flow.paidPerDayM, savedM: row.flow.savedPerDayM };
}

const DASH_ID = '-';

// ─── Cribl's built-in objects, in words (BEAUTY F11) ─────────────────────────
//
// Every fresh Cribl worker group ships default Sources, the `default` route, the `main` pipeline and the
// `devnull` destination. The dictionary in core/humanize reads them as "In cribl http", "Main", "DevNull";
// these read like the product's own names. Per kind, because `default` is a route AND a destination. The
// member's own labels (settings.humanize) still win. (Candidate to move into core/humanize.)

type ObjectKind = 'input' | 'route' | 'pipeline' | 'output';

const BUILTIN_LABELS: Readonly<Record<ObjectKind, Readonly<Record<string, string>>>> = {
  input: {
    http: 'HTTP',
    open_telemetry: 'OpenTelemetry',
  },
  route: { default: 'Default route' },
  pipeline: { main: 'Main (default)', passthru: 'Passthrough' },
  output: { devnull: 'DevNull', default: 'Default destination' },
};

/** Tokens of Cribl's default Source ids (`in_splunk_hec`, `in_syslog_tls`, …). */
const SOURCE_TOKENS: Readonly<Record<string, string>> = {
  cribl: 'Cribl',
  http: 'HTTP',
  tcp: 'TCP',
  udp: 'UDP',
  tls: '(TLS)',
  json: 'JSON',
  hec: 'HEC',
  splunk: 'Splunk',
  elastic: 'Elasticsearch API',
  syslog: 'Syslog',
  otel: 'OpenTelemetry',
  kafka: 'Kafka',
  datadog: 'Datadog',
  agent: 'Agent',
  s3: 'S3',
};

/** "Splunk HEC" for `in_splunk_hec`; undefined when any token is unknown (the dictionary then decides). */
function builtinSourceLabel(id: string): string | undefined {
  const m = /^in_([a-z0-9_]+)$/.exec(id);
  if (!m) return undefined;
  const words = m[1].split('_').map((tok) => SOURCE_TOKENS[tok]);
  return words.every((w): w is string => w !== undefined) ? words.join(' ') : undefined;
}

/**
 * Override → built-in label → the object's own name in Cribl (`name`: a route's inventory name, carried on the
 * flow as `routeName`) → the id humanized. A route reads "VPC Flow", never "R VPC" (core/humanize.ts routeLabel).
 */
function label(id: string, overrides: Record<string, string> | undefined, kind?: ObjectKind, name?: string): string {
  if (!id || id === DASH_ID) return '';
  const own = overrides?.[id];
  if (own !== undefined && own.trim() !== '') return own;
  if (kind) {
    const builtin = BUILTIN_LABELS[kind][id] ?? (kind === 'input' ? builtinSourceLabel(id) : undefined);
    if (builtin) return builtin;
  }
  const named = name?.trim();
  if (named) return humanize(named, overrides) || named;
  return humanize(id, overrides) || id;
}

/** Open incidents indexed by object key; the most severe (then newest) wins per key. */
function openIncidentsByKey(incidents: readonly Incident[]): Map<ObjectKey, Incident> {
  const map = new Map<ObjectKey, Incident>();
  for (const inc of incidents) {
    if (inc.closedAt) continue;
    const prev = map.get(inc.objectKey);
    if (
      !prev ||
      severityRank(inc.severity) > severityRank(prev.severity) ||
      (severityRank(inc.severity) === severityRank(prev.severity) && Date.parse(inc.openedAt) > Date.parse(prev.openedAt))
    ) {
      map.set(inc.objectKey, inc);
    }
  }
  return map;
}

/** Which incident types can colour a row, looked up on which of its objects (detector conventions). */
const INCIDENT_LOOKUP: readonly {
  type: IncidentType;
  keys: ('route' | 'pipeline' | 'input' | 'output')[];
}[] = [
  { type: 'regression', keys: ['route', 'pipeline'] },
  { type: 'spike', keys: ['input', 'route'] },
  { type: 'budget', keys: ['output'] },
  { type: 'goodnews', keys: ['route', 'pipeline'] },
];

export interface BuildRowsOptions {
  humanize?: Record<string, string>;
  /** epoch ms "now", for mute countdowns */
  now?: number;
  /** The source name of a folded snapshot's 'Other' flow ("Other · 300 smaller flows"; usefulness review, round 2). */
  otherLabel?: string;
}

/** Snapshot → table rows (unsorted, unfiltered). */
/** P1-F03: 1 − out/in, at most 1; below 0 only past the counting noise (a passthrough's few extra bytes read 0%). */
export function byteReduction(inB: number, outB: number): number | null {
  if (!(inB > 0)) return null;
  const r = 1 - outB / inB;
  return r > 1 ? 1 : r < 0 && r > -INFLATION_NOISE ? 0 : r;
}

export function buildRows(
  snapshot: (Pick<Snapshot, 'flows' | 'incidents'> & Partial<Pick<Snapshot, 'destinations'>>) | null | undefined,
  opts: BuildRowsOptions = {},
): LedgerRow[] {
  if (!snapshot) return [];
  const byKey = openIncidentsByKey(snapshot.incidents ?? []);
  const now = opts.now ?? Date.now();
  return snapshot.flows.map((flow) => {
    const keys = flowObjectKeys(flow);
    const objectKeys = [keys.input, keys.route, keys.pipeline, keys.output].filter((k): k is ObjectKey => k !== undefined);

    let incident: Incident | undefined;
    for (const { type, keys: which } of INCIDENT_LOOKUP) {
      for (const w of which) {
        const k = keys[w];
        const found = k ? byKey.get(k) : undefined;
        if (found && found.type === type) {
          if (!incident || severityRank(found.severity) > severityRank(incident.severity)) incident = found;
        }
      }
      if (incident) break;
    }

    let status: RowStatus;
    let mutedMinutes: number | undefined;
    if (flow.muted) {
      status = 'muted';
      const until = flow.mutedUntil ? Date.parse(flow.mutedUntil) : Number.NaN;
      mutedMinutes = Number.isFinite(until) ? Math.max(1, Math.ceil((until - now) / 60_000)) : undefined;
    } else if (incident) {
      status = incident.type;
    } else if ((flow.state === 'learning' || flow.state === 'ok') && flow.inBPerDay === 0 && flow.whpPerDayM === 0) {
      // A configured flow with no traffic in the last hour: nothing to learn, nothing to price.
      status = 'idle';
    } else {
      status = flow.state;
    }

    const source = opts.otherLabel !== undefined && flow.key === OTHER_FLOW_KEY ? opts.otherLabel : label(flow.inputId, opts.humanize, 'input');
    const route = label(flow.routeId, opts.humanize, 'route', flow.routeName);
    const pipeline = label(flow.pipelineId, opts.humanize, 'pipeline');
    const destination = label(flow.outputId, opts.humanize, 'output');
    const reduction = byteReduction(flow.inBPerDay, flow.outBPerDay);
    const divertedTo = diversionTarget(flow, snapshot.destinations);
    const haystack = [source, route, pipeline, destination, flow.inputId, flow.routeId, flow.pipelineId, flow.outputId, flow.groupId]
      .join(' ')
      .toLowerCase();

    const row: LedgerRow = {
      id: flow.key,
      flow,
      groupId: flow.groupId,
      sourceId: flow.inputId,
      routeId: flow.routeId,
      pipelineId: flow.pipelineId,
      outputId: flow.outputId,
      source,
      route,
      pipeline,
      destination,
      objectKeys,
      status,
      reduction,
      priced: flow.state !== 'unpriced',
      haystack,
    };
    if (incident && status === incident.type) {
      row.incident = incident;
      row.severity = incident.severity;
    } else if (status === 'regression') {
      row.severity = 'high';
    } else if (status === 'spike') {
      row.severity = 'medium';
    }
    if (mutedMinutes !== undefined) row.mutedMinutes = mutedMinutes;
    if (flow.muted && flow.mutedByMember) row.mutedByMember = true;
    if (divertedTo !== undefined) row.divertedTo = label(divertedTo, opts.humanize, 'output');
    return row;
  });
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export interface LedgerFilters {
  q?: string;
  state?: RowStatus;
  destination?: string;
  group?: string;
}

/** Search terms: whitespace-separated, all must match (case-insensitive), against labels and raw ids. */
export function matchesSearch(row: Pick<LedgerRow, 'haystack'>, q: string | undefined): boolean {
  const terms = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => row.haystack.includes(term));
}

export function filterRows(rows: readonly LedgerRow[], f: LedgerFilters): LedgerRow[] {
  return rows.filter(
    (r) =>
      (!f.state || r.status === f.state) &&
      (!f.destination || r.outputId === f.destination) &&
      (!f.group || r.groupId === f.group) &&
      matchesSearch(r, f.q),
  );
}

export function hasActiveFilters(f: LedgerFilters): boolean {
  return !!((f.q && f.q.trim()) || f.state || f.destination || f.group);
}

// ─── Quiet flows (BEAUTY F11) ────────────────────────────────────────────────

/**
 * A flow with no traffic in the last hour and nothing else to say: no bytes, no money, no open alert, not
 * muted. The Ledger hides these by default behind one summary row, so the table is the flows that matter.
 */
export function isQuiet(row: Pick<LedgerRow, 'flow' | 'incident' | 'status' | 'window'>): boolean {
  const f = row.flow;
  if (row.incident || row.status === 'muted' || row.status === 'regression' || row.status === 'spike' || row.status === 'budget') return false;
  // Under a range a flow that carried money in the window is listed, whatever its last hour did (P2-W14).
  if (hasMoney(row.window)) return false;
  return f.inBPerDay === 0 && f.outBPerDay === 0 && f.whpPerDayM === 0 && f.paidPerDayM === 0;
}

export interface QuietOptions {
  /** the member asked to see them (the summary row's "Show") */
  show?: boolean;
  /** the status filter — "No traffic" shows exactly these rows, so nothing is hidden */
  state?: RowStatus;
  /** row ids that stay visible regardless (a ?object= deep link) */
  keep?: ReadonlySet<string>;
}

/** Splits already-filtered rows into what the table shows and how many quiet flows it folded away. */
export function partitionQuiet(rows: readonly LedgerRow[], opts: QuietOptions = {}): { visible: LedgerRow[]; quiet: number } {
  const quietCount = rows.reduce((n, r) => n + (isQuiet(r) ? 1 : 0), 0);
  if (opts.show || opts.state === 'idle' || quietCount === 0) return { visible: [...rows], quiet: quietCount };
  const visible = rows.filter((r) => !isQuiet(r) || opts.keep?.has(r.id));
  return { visible, quiet: rows.length - visible.length };
}

// ─── Sort ────────────────────────────────────────────────────────────────────

export type SortKey =
  'source' | 'route' | 'pipeline' | 'destination' | 'group' | 'in' | 'out' | 'reduction' | 'whp' | 'paid' | 'saved' | 'status';
export const SORT_KEYS: readonly SortKey[] = [
  'source',
  'route',
  'pipeline',
  'destination',
  'group',
  'in',
  'out',
  'reduction',
  'whp',
  'paid',
  'saved',
  'status',
];
export interface SortSpec {
  key: SortKey;
  dir: 'asc' | 'desc';
}
export const DEFAULT_SORT: SortSpec = { key: 'saved', dir: 'desc' };

/** `?sort=saved` (ascending) / `?sort=-saved` (descending). Unknown → the default. */
export function parseSort(raw: string | null | undefined): SortSpec {
  if (!raw) return DEFAULT_SORT;
  const desc = raw.startsWith('-');
  const key = desc ? raw.slice(1) : raw;
  return (SORT_KEYS as readonly string[]).includes(key) ? { key: key as SortKey, dir: desc ? 'desc' : 'asc' } : DEFAULT_SORT;
}

export function formatSort(s: SortSpec): string | null {
  if (s.key === DEFAULT_SORT.key && s.dir === DEFAULT_SORT.dir) return null;
  return s.dir === 'desc' ? `-${s.key}` : s.key;
}

/** Text columns start ascending (A→Z), figures start descending (biggest first). */
export function defaultDirFor(key: SortKey): 'asc' | 'desc' {
  return key === 'source' || key === 'route' || key === 'pipeline' || key === 'destination' || key === 'group' ? 'asc' : 'desc';
}

/** Clicking a header: same column flips, another column starts at its natural direction. */
export function nextSort(current: SortSpec, key: SortKey): SortSpec {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: defaultDirFor(key) };
}

/** How urgent a status is (Status column sort, descending = most urgent first). */
const STATUS_WEIGHT: Record<RowStatus, number> = {
  regression: 70,
  spike: 60,
  budget: 50,
  goodnews: 40,
  muted: 30,
  unpriced: 20,
  learning: 10,
  ok: 5,
  idle: 0,
};

function statusWeight(r: LedgerRow): number {
  return STATUS_WEIGHT[r.status] + (r.severity ? severityRank(r.severity) : 0);
}

function sortValue(r: LedgerRow, key: SortKey): number | string {
  switch (key) {
    case 'source':
      return r.source.toLowerCase();
    case 'route':
      return r.route.toLowerCase();
    case 'pipeline':
      return r.pipeline.toLowerCase();
    case 'destination':
      return r.destination.toLowerCase();
    case 'group':
      return r.groupId.toLowerCase();
    case 'in':
      return r.flow.inBPerDay;
    case 'out':
      return r.flow.outBPerDay;
    case 'reduction':
      return r.reduction ?? -1;
    case 'whp':
      return showsMoney(r) ? rowMoney(r).whpM : -1;
    case 'paid':
      return showsMoney(r) ? rowMoney(r).paidM : -1;
    case 'saved':
      return showsMoney(r) ? rowMoney(r).savedM : -1;
    case 'status':
      return statusWeight(r);
  }
}

/** Stable sort; ties fall back to saved / day (desc), then the flow key, so the order never jitters. */
export function sortRows(rows: readonly LedgerRow[], s: SortSpec): LedgerRow[] {
  const sign = s.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, s.key);
    const vb = sortValue(b, s.key);
    if (va < vb) return -sign;
    if (va > vb) return sign;
    const sa = showsMoney(a) ? rowMoney(a).savedM : -1;
    const sb = showsMoney(b) ? rowMoney(b).savedM : -1;
    if (sa !== sb) return sb - sa;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ─── Columns (P1-K01) ────────────────────────────────────────────────────────

/**
 * Does a Route column say anything? Only where some listed route is named differently from both its source and its
 * pipeline: on most rigs each source has a route of its own name (and some routes are named for their pipeline, the
 * tour's "DNS to Cribl Lake"), and a column repeating another name column costs the names their room. (A flow
 * without a route label shows an em dash under Route, which is not news either.)
 */
export function routeAddsInfo(rows: readonly LedgerRow[]): boolean {
  return rows.some((r) => r.route !== '' && r.route !== r.source && r.route !== r.pipeline);
}

/**
 * Where a row's route name goes when the table has a Route column: printed once, never beside an equal name
 * (leftovers: "DNS to Cribl Lake" read twice). Named like its pipeline, it is left to the Pipeline cell (the one
 * with the link; the Route cell stays blank on screen); else, named like its source, the Source cell spans the
 * Route column (P1-K01); else it keeps its own cell (null).
 */
export function routeFold(row: Pick<LedgerRow, 'source' | 'route' | 'pipeline'>): 'pipeline' | 'source' | null {
  if (row.route === '') return null;
  if (row.route === row.pipeline) return 'pipeline';
  if (row.route === row.source) return 'source';
  return null;
}

/**
 * The rows whose names size the Source and Route columns (W3-LS-2 sizes each name column by its labels). With a
 * Route column, a route folded into its source spans both columns and asks nothing of either; a route left to its
 * pipeline asks nothing of Route, while its Source cell is its own. Without one, every row sizes Source.
 */
export function nameColumnRows<R extends Pick<LedgerRow, 'source' | 'route' | 'pipeline'>>(rows: readonly R[], route: boolean): { source: R[]; route: R[] } {
  if (!route) return { source: [...rows], route: [...rows] };
  return { source: rows.filter((r) => routeFold(r) !== 'source'), route: rows.filter((r) => routeFold(r) === null) };
}

/** Do the listed rows span two or more worker groups (so a Worker group column tells them apart)? */
export function spansGroups(rows: readonly LedgerRow[]): boolean {
  return rows.some((r) => r.groupId !== rows[0].groupId);
}

// ─── Deep links (?object=) ───────────────────────────────────────────────────

/** Rows the object key points at (a pipeline can feed several flows). A FlowKey also matches its row. */
export function rowsForObject(rows: readonly LedgerRow[], object: string | undefined): LedgerRow[] {
  if (!object) return [];
  return rows.filter((r) => r.id === object || r.objectKeys.includes(object));
}

/** The object key a click on a row selects: its route (what incidents and top savers name), else pipeline. */
export function primaryObjectKey(row: Pick<LedgerRow, 'objectKeys' | 'id'>): string {
  return (
    row.objectKeys.find((k) => k.startsWith('route:')) ?? row.objectKeys.find((k) => k.startsWith('pipe:')) ?? row.objectKeys[0] ?? row.id
  );
}

/**
 * Humanized label for any object key (the "hidden by filters" notice, the rail). A flow key
 * ('default|in_x|route_x|pipe_x|out_x', what a row click on a flow without a route selects) reads as its pipeline,
 * never as the raw pipe-separated key (P1-K05).
 */
export function objectLabel(object: string, overrides?: Record<string, string>): string {
  const parsed = parseObjectKey(object);
  if (parsed) return humanize(parsed.id, overrides);
  const flow = parseFlowKey(object);
  if (flow) {
    if (flow.pipelineId && flow.pipelineId !== DASH_ID) return label(flow.pipelineId, overrides, 'pipeline');
    if (flow.routeId && flow.routeId !== DASH_ID) return label(flow.routeId, overrides, 'route');
    return label(flow.inputId, overrides, 'input') || object;
  }
  return object;
}

// ─── Options and totals ──────────────────────────────────────────────────────

export interface Option {
  id: string;
  label: string;
  count: number;
}

/** Destinations and groups present in the rows, with counts, sorted by label. */
export function destinationOptions(rows: readonly LedgerRow[]): Option[] {
  const map = new Map<string, Option>();
  for (const r of rows) {
    if (!r.outputId || r.outputId === DASH_ID) continue;
    const o = map.get(r.outputId) ?? {
      id: r.outputId,
      label: r.destination || r.outputId,
      count: 0,
    };
    o.count++;
    map.set(r.outputId, o);
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function groupOptions(rows: readonly LedgerRow[]): Option[] {
  const map = new Map<string, Option>();
  for (const r of rows) {
    const o = map.get(r.groupId) ?? {
      id: r.groupId,
      label: r.groupId,
      count: 0,
    };
    o.count++;
    map.set(r.groupId, o);
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function statusCounts(rows: readonly LedgerRow[]): Record<RowStatus, number> {
  const counts = Object.fromEntries(ROW_STATUSES.map((s) => [s, 0])) as Record<RowStatus, number>;
  for (const r of rows) counts[r.status]++;
  return counts;
}

export interface Totals {
  flows: number;
  inBPerDay: number;
  outBPerDay: number;
  whpPerDayM: number;
  paidPerDayM: number;
  savedPerDayM: number;
  /** byte reduction over the summed volumes; null when nothing came in */
  reduction: number | null;
  /** P1-F03: per day, the cost added by flows that grow bytes, and how many of them (0 when none) */
  addedPerDayM?: number;
  addedFlows?: number;
  /** under a range (P2-W14): the listed rows' window money, summed */
  window?: WindowMoney;
}

/** Sums over the (filtered) rows; unpriced rows add volume but no money. Under a range, the window's money too. */
export function totals(rows: readonly LedgerRow[]): Totals {
  const t: Totals = {
    flows: rows.length,
    inBPerDay: 0,
    outBPerDay: 0,
    whpPerDayM: 0,
    paidPerDayM: 0,
    savedPerDayM: 0,
    reduction: null,
    addedPerDayM: 0,
    addedFlows: 0,
  };
  for (const r of rows) {
    t.inBPerDay += r.flow.inBPerDay;
    t.outBPerDay += r.flow.outBPerDay;
    if (r.priced) {
      t.whpPerDayM += r.flow.whpPerDayM;
      t.paidPerDayM += r.flow.paidPerDayM;
      t.savedPerDayM += r.flow.savedPerDayM;
      if ((r.flow.addedPerDayM ?? 0) > 0) {
        t.addedPerDayM = (t.addedPerDayM ?? 0) + (r.flow.addedPerDayM ?? 0);
        t.addedFlows = (t.addedFlows ?? 0) + 1;
      }
    }
  }
  t.reduction = byteReduction(t.inBPerDay, t.outBPerDay);
  if (rows.some((r) => r.window)) {
    const w = { ...NO_MONEY };
    for (const r of rows) {
      if (!r.window) continue;
      w.whpM += r.window.whpM;
      w.paidM += r.window.paidM;
      w.savedM += r.window.savedM;
    }
    t.window = w;
  }
  return t;
}

// ─── Links out to Cribl ──────────────────────────────────────────────────────

/**
 * The Cribl UI page of a pipeline: '/stream/m/<groupId>/pipelines/<pipelineId>'. The Leader serves the
 * app at its own origin, so the path is opened with target="_top" (AGENTS.md "Linking Out of Your App").
 */
export function pipelineHref(groupId: string, pipelineId: string): string | undefined {
  if (!groupId || !pipelineId || pipelineId === DASH_ID) return undefined;
  return `/stream/m/${encodeURIComponent(groupId)}/pipelines/${encodeURIComponent(pipelineId)}`;
}
