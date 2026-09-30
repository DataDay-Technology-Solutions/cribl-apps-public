// core/whatif.ts — the What-if dry run (DESIGN_BRIEF 5.9, DECISIONS D16): project what a treatment would save
// on one stream before anyone touches config. Pure: no I/O, no DOM, no demo-rig ids (this module ships in the
// release bundle, so it recognizes pipelines by pattern, never by the rig's literal ids).
//
// Vocabulary
//   stream      one priced path minus its pipeline: `${groupId}|${inputId}|${routeId}|${outputId}`. Applying a
//               pack swaps the route's pipeline, so the stream key is what survives the change.
//   ratio       the BYTE savings ratio, 1 − out/in (0.33 = the pipeline removes a third of the bytes). This is
//               what a pack does; money follows from it at the destination's price.
//   treatment   'pack-windows' (Windows XML events → JSON pack), 'pack-panos' (syslog pre-processing + Palo Alto
//               pack), 'pack-vpc' (VPC Flow aggregation pack), 'aggressive-windows' (the Cribl Docs "Reducing
//               Windows XML Events" pipeline), or `{ dropPct }` — a custom slider.
//
// Semantics
//   • A pack REPLACES the stream's pipeline: projected out-bytes = in-bytes × (1 − r).
//   • A custom `{ dropPct }` drops that share of what the stream sends TODAY, on top of its current pipeline:
//     projected out-bytes = current out-bytes × (1 − dropPct / 100).
//   • Would-have-paid never changes (it is the counterfactual); paid = projected out-bytes × the price per byte
//     the stream pays today (paid / out), or — for a stream that sends nothing out today — whp / in.
//
// Basis (named in the math, strongest first — DESIGN_BRIEF 5.9)
//   1. 'dry-run'     the treatment's pipeline run on real sample events of this source (bytes in vs out,
//                    measured through the Leader's preview API by core/adapters/preview.ts);
//   2. 'similar'     the live ratio of another stream in this workspace already running the treatment;
//   3. 'documented'  the pack README / Cribl Docs range, carried as a range (low / mid / high);
//   'custom'         the user's own drop percentage.
//   With none of these the estimate is `{ ok: false, reason: 'no-basis' }` — never a guessed number. The VPC
//   Flow pack documents only "significantly reduce", so it has no documented range (SPEC 14.1).

import type { FlowFigures, Headline, ObjectKey, Snapshot } from './types.ts';
import { makeFlowKey, objectKey } from './flows.ts';
import { perYear } from './format.ts';

// ─── Treatments ──────────────────────────────────────────────────────────────

export type PackTreatment = 'pack-windows' | 'pack-panos' | 'pack-vpc' | 'aggressive-windows';
export type CustomTreatment = { dropPct: number };
export type Treatment = PackTreatment | CustomTreatment;
export type Basis = 'dry-run' | 'similar' | 'documented' | 'custom';

export const PACK_TREATMENTS: readonly PackTreatment[] = ['pack-windows', 'pack-panos', 'pack-vpc', 'aggressive-windows'];

export function isPackTreatment(t: unknown): t is PackTreatment {
  return typeof t === 'string' && (PACK_TREATMENTS as readonly string[]).includes(t);
}

export function isCustomTreatment(t: unknown): t is CustomTreatment {
  return typeof t === 'object' && t !== null && typeof (t as { dropPct?: unknown }).dropPct === 'number';
}

/** Clamps a custom drop to a whole percent in [0, 100]. */
export function clampDropPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** A documented savings range (ratios in [0, 1]) and where it is written down. */
export interface DocumentedRange {
  min: number;
  max: number;
  source: string;
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Two reductions applied one after the other: 1 − (1 − a)(1 − b). */
export function stackRatios(a: number, b: number): number {
  return round4(1 - (1 - a) * (1 - b));
}

/**
 * SPEC 14.1 (re-verified in the spike): the numbers the pack authors publish. `null` = no number published,
 * so a documented basis is not available and the estimate needs a similar stream or a dry run.
 */
export const DOCUMENTED: Readonly<Record<PackTreatment, DocumentedRange | null>> = {
  'pack-windows': {
    min: 0.3,
    max: 0.35,
    source: 'cribl-splunk-forwarder-windows-xml-events-to-json pack README',
  },
  'pack-panos': {
    min: stackRatios(0.2, 0.15),
    max: stackRatios(0.3, 0.3),
    source: 'cribl-syslog-input README (20–30%) + cribl-palo-alto-networks README (15–30%), stacked',
  },
  'pack-vpc': null,
  'aggressive-windows': {
    min: 0.34,
    max: 0.7,
    source: 'Cribl Docs "Reducing Windows XML Events"',
  },
};

/**
 * Whether a pipeline id looks like the treatment's pipeline. Matches both a route that points at a Pack
 * (`pack:cribl-palo-alto-networks`) and a local pipeline carrying the pack's functions (`mrd_pan_pack`).
 */
export function pipelineMatchesTreatment(pipelineId: string, treatment: PackTreatment): boolean {
  if (typeof pipelineId !== 'string' || pipelineId === '' || pipelineId === '-') return false;
  const id = pipelineId.toLowerCase();
  const windows = /windows[-_]?xml|win[-_]?xml|xml[-_]events[-_]to[-_]json/.test(id) || /(^|[_:-])win(dows)?([_-]|$)/.test(id);
  const reduction = /reduc|docs|aggress/.test(id);
  switch (treatment) {
    case 'pack-windows':
      return /windows[-_]?xml|win[-_]?xml|xml[-_]events[-_]to[-_]json/.test(id) && !reduction;
    case 'aggressive-windows':
      return windows && reduction;
    case 'pack-panos':
      return /palo[-_ ]?alto|pan[-_]?os|(^|[_:-])pan([_-]|$)/.test(id);
    case 'pack-vpc':
      return /vpc/.test(id) && /pack|agg|security/.test(id);
  }
}

/**
 * How much of a treatment a pipeline runs (founder-build r1 ui-4, FOUNDER_PLAN row 2b). The Palo Alto treatment is two
 * packs (the syslog pre-processing pack, then the Palo Alto Networks pack): a route whose pipeline is a Pack attached
 * alone (`pack:cribl-palo-alto-networks`, Cribl's own pack applied in the Routes editor) runs only PART of it, so the
 * tile must not say it runs "this treatment". A local pipeline carrying the treatment's functions (the rig's imported
 * `mrd_pan_pack`, behind a syslog header strip) runs all of it, as does a single-pack treatment attached as its Pack.
 */
export type TreatmentRunState = { state: 'none' } | { state: 'all' } | { state: 'part'; packId: string };

/** The treatments made of more than one pack (a Pack attached alone is only part of them). */
const MULTI_PACK_TREATMENTS: ReadonlySet<PackTreatment> = new Set(['pack-panos']);

export function treatmentRunState(pipelineId: string, treatment: PackTreatment): TreatmentRunState {
  if (!pipelineMatchesTreatment(pipelineId, treatment)) return { state: 'none' };
  const pack = /^pack:(.+)$/i.exec(pipelineId);
  if (pack && MULTI_PACK_TREATMENTS.has(treatment)) return { state: 'part', packId: pack[1] };
  return { state: 'all' };
}

/** The pack treatment a source most likely wants, from its id (the picker's default): the pack written for its kind. */
export function suggestTreatment(inputId: string): PackTreatment | undefined {
  switch (sourceKind({ inputId: typeof inputId === 'string' ? inputId : '' })) {
    case 'windows':
      return 'pack-windows';
    case 'panos':
      return 'pack-panos';
    case 'vpc':
      return 'pack-vpc';
    default:
      return undefined;
  }
}

// ─── Applicability (P1-F13) ──────────────────────────────────────────────────

/**
 * What a source is, as far as the packs care, read from its ids (a snapshot carries no input type, and every
 * rig and tour source is named for what it carries): Windows event logs, Palo Alto firewall syslog, VPC Flow
 * Logs, or something no pack here is written for.
 */
export type SourceKind = 'windows' | 'panos' | 'vpc' | 'other';

const WINDOWS_SOURCE = /windows|(^|[_:-])win([_-]|$)|wineventlog|winevent|(^|[_:-])wef([_-]|$)|sysmon/;
const PANOS_SOURCE = /palo[-_ ]?alto|(^|[_:-])pan([_-]|$)|pan[-_]?os|firewall/;
const VPC_SOURCE = /vpc/;

/** The kind of source a stream reads, from its source id and then its route id. */
export function sourceKind(flow: { inputId?: string; routeId?: string }): SourceKind {
  for (const raw of [flow.inputId, flow.routeId]) {
    const id = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (id === '' || id === '-') continue;
    if (VPC_SOURCE.test(id)) return 'vpc';
    if (WINDOWS_SOURCE.test(id)) return 'windows';
    if (PANOS_SOURCE.test(id)) return 'panos';
  }
  return 'other';
}

/** The source each pack is written for (a custom drop fits any stream). */
export const TREATMENT_FITS: Readonly<Record<PackTreatment, SourceKind>> = {
  'pack-windows': 'windows',
  'aggressive-windows': 'windows',
  'pack-panos': 'panos',
  'pack-vpc': 'vpc',
};

/**
 * Whether a treatment fits the stream's source: a pack only on the source it is written for (the Windows XML
 * pack on a Palo Alto firewall would project savings from events it never sees), a custom drop anywhere. A
 * stream whose ids are unknown (a bare figure set) is not judged.
 */
export function treatmentApplies(treatment: Treatment, flow: { inputId?: string; routeId?: string }): boolean {
  if (!isPackTreatment(treatment)) return true;
  if (flow.inputId === undefined && flow.routeId === undefined) return true;
  return sourceKind(flow) === TREATMENT_FITS[treatment];
}

// ─── Streams ─────────────────────────────────────────────────────────────────

export type StreamKey = string;

/** A flow's stream key: the flow key without its pipeline. */
export function streamKeyOf(f: Pick<FlowFigures, 'groupId' | 'inputId' | 'routeId' | 'outputId'>): StreamKey {
  return [f.groupId, f.inputId, f.routeId, f.outputId].map((s) => (s === undefined || s === '' ? '-' : s)).join('|');
}

/** 1 − out/in over the per-day figures (0 when nothing flows in). */
export function byteRatio(f: Pick<FlowFigures, 'inBPerDay' | 'outBPerDay'>): number {
  if (!(f.inBPerDay > 0)) return 0;
  return 1 - Math.max(0, f.outBPerDay) / f.inBPerDay;
}

export interface SimilarStream {
  /** Byte savings ratio the similar stream achieves (60-minute average). */
  ratio: number;
  /** The object named in the basis line: the similar stream's route (its source when it has no route). */
  fromObject: ObjectKey;
  flowKey: string;
  streamKey: StreamKey;
  groupId: string;
  inputId: string;
  routeId: string;
  /** The route's own name in Cribl, when the flow carries one (FlowFigures.routeName). */
  routeName?: string;
  pipelineId: string;
  inBPerDay: number;
}

export interface FindSimilarOptions {
  /** The stream being projected — never its own evidence. */
  excludeStreamKey?: StreamKey;
  /** Prefer streams in this worker group. */
  groupId?: string;
}

/**
 * The strongest live evidence for a pack treatment: another stream in this workspace whose pipeline is that
 * treatment, preferring the same worker group, then the most bytes (the steadiest measurement). Custom
 * treatments have no similar stream.
 */
export function findSimilarStream(snapshot: Pick<Snapshot, 'flows'> | null | undefined, treatment: Treatment, opts: FindSimilarOptions = {}): SimilarStream | null {
  if (!snapshot || !isPackTreatment(treatment)) return null;
  const candidates = snapshot.flows.filter(
    (f) => f.inBPerDay > 0 && pipelineMatchesTreatment(f.pipelineId, treatment) && streamKeyOf(f) !== opts.excludeStreamKey,
  );
  if (candidates.length === 0) return null;
  const sameGroup = (f: FlowFigures): number => (opts.groupId !== undefined && f.groupId === opts.groupId ? 1 : 0);
  candidates.sort((a, b) => sameGroup(b) - sameGroup(a) || b.inBPerDay - a.inBPerDay || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const best = candidates[0];
  const hasRoute = best.routeId !== '-' && best.routeId !== '';
  return {
    ratio: round4(byteRatio(best)),
    fromObject: objectKey(hasRoute ? 'route' : 'in', best.groupId, hasRoute ? best.routeId : best.inputId),
    flowKey: best.key,
    streamKey: streamKeyOf(best),
    groupId: best.groupId,
    inputId: best.inputId,
    routeId: best.routeId,
    ...(best.routeName ? { routeName: best.routeName } : {}),
    pipelineId: best.pipelineId,
    inBPerDay: best.inBPerDay,
  };
}

// ─── Estimates ───────────────────────────────────────────────────────────────

/** The per-day figures an estimate reads (a FlowFigures, or a sum of several). */
export type WhatIfFlow = Pick<FlowFigures, 'inBPerDay' | 'outBPerDay' | 'whpPerDayM' | 'paidPerDayM' | 'savedPerDayM'>;

export interface EstimateInput {
  /** The stream's per-day figures; with its ids (a FlowFigures), a pack that does not fit its source is refused. */
  flow: WhatIfFlow & { inputId?: string; routeId?: string };
  treatment: Treatment;
  /** Live ratio of a stream already running the treatment (see findSimilarStream). */
  measuredSimilar?: { ratio: number; fromObject: string };
  /** Bytes in / out of the treatment's pipeline over real sample events of this source (core/adapters/preview.ts). */
  dryRun?: DryRunMeasure;
  /** Overrides the DOCUMENTED table (tests, or a range read from an installed pack's README). */
  documented?: { min: number; max: number; source?: string };
}

/** Per-day and per-year money for one state of the stream. Money is integer millicents. */
export interface Projection {
  /** byte savings ratio, 1 − out/in */
  ratio: number;
  inBPerDay: number;
  outBPerDay: number;
  whpPerDayM: number;
  paidPerDayM: number;
  savedPerDayM: number;
  whpPerYearM: number;
  paidPerYearM: number;
  savedPerYearM: number;
  /** saved − today's saved */
  deltaSavedPerDayM: number;
  deltaSavedPerYearM: number;
}

/** What a dry run measured: `_raw` bytes in and out over `events` sample events, through `pipelineId`. */
export interface DryRunMeasure {
  inBytes: number;
  outBytes: number;
  events?: number;
  pipelineId?: string;
  sampleId?: string;
  /** The sample was picked from the group's library, not the Source's own (P2-W26). */
  picked?: boolean;
}

export interface BasisDetail {
  /** similar: the object whose live ratio is borrowed */
  fromObject?: string;
  /** documented: where the range is written down */
  source?: string;
  /** dry-run: what was measured */
  dryRun?: DryRunMeasure;
  /** custom: the share of today's out-bytes dropped */
  dropPct?: number;
}

export interface EstimateOk {
  ok: true;
  treatment: Treatment;
  basis: Basis;
  /** The byte ratio the math applied: a point, or a range for a documented basis. */
  ratio: number | { min: number; max: number };
  range: boolean;
  current: Projection;
  /** low / high bound the projection (equal for a point estimate); mid is what the map draws. */
  low: Projection;
  mid: Projection;
  high: Projection;
  detail: BasisDetail;
}
export interface EstimateNone {
  ok: false;
  treatment: Treatment;
  reason: 'no-basis' | 'no-traffic' | 'not-applicable';
  /** false when the treatment does not fit the stream's source (P1-F13): nothing is projected. */
  applicable?: false;
}
export type Estimate = EstimateOk | EstimateNone;

const clampRatio = (r: number): number => (Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 0);

/** The price the stream pays per byte it sends (millicents per byte). */
function paidPerByte(flow: WhatIfFlow): number {
  if (flow.outBPerDay > 0) return Math.max(0, flow.paidPerDayM) / flow.outBPerDay;
  if (flow.inBPerDay > 0) return Math.max(0, flow.whpPerDayM) / flow.inBPerDay;
  return 0;
}

function projection(flow: WhatIfFlow, outBPerDay: number, paidPerDayM: number): Projection {
  const whp = Math.round(flow.whpPerDayM);
  const saved = whp - paidPerDayM;
  const delta = saved - Math.round(flow.savedPerDayM);
  return {
    ratio: round4(byteRatio({ inBPerDay: flow.inBPerDay, outBPerDay })),
    inBPerDay: flow.inBPerDay,
    outBPerDay,
    whpPerDayM: whp,
    paidPerDayM,
    savedPerDayM: saved,
    whpPerYearM: perYear(whp),
    paidPerYearM: perYear(paidPerDayM),
    savedPerYearM: perYear(saved),
    deltaSavedPerDayM: delta,
    deltaSavedPerYearM: perYear(delta),
  };
}

/** Today's figures in the same shape as a projection (delta 0). */
export function currentProjection(flow: WhatIfFlow): Projection {
  const whp = Math.round(flow.whpPerDayM);
  const paid = Math.round(flow.paidPerDayM);
  const saved = Math.round(flow.savedPerDayM);
  return {
    ratio: round4(byteRatio(flow)),
    inBPerDay: flow.inBPerDay,
    outBPerDay: flow.outBPerDay,
    whpPerDayM: whp,
    paidPerDayM: paid,
    savedPerDayM: saved,
    whpPerYearM: perYear(whp),
    paidPerYearM: perYear(paid),
    savedPerYearM: perYear(saved),
    deltaSavedPerDayM: 0,
    deltaSavedPerYearM: 0,
  };
}

/** Projects a pack that removes `r` of the in-bytes (replacing today's pipeline). */
function projectPack(flow: WhatIfFlow, r: number): Projection {
  const out = Math.round(flow.inBPerDay * (1 - clampRatio(r)));
  return projection(flow, out, Math.round(out * paidPerByte(flow)));
}

/**
 * The stream at byte ratio `r`: its in-bytes × (1 − r) sent, at the price it pays per byte today. The same
 * pricing every pack projection uses, so a measured ratio and a projected one are compared like for like.
 */
export function projectRatio(flow: WhatIfFlow, r: number): Projection {
  return projectPack(flow, r);
}

/** Projects dropping `pct` % of what the stream sends today (on top of today's pipeline). */
function projectDrop(flow: WhatIfFlow, pct: number): Projection {
  const out = Math.round(Math.max(0, flow.outBPerDay) * (1 - clampDropPct(pct) / 100));
  return projection(flow, out, Math.round(out * paidPerByte(flow)));
}

function validDryRun(d: EstimateInput['dryRun']): d is DryRunMeasure {
  return !!d && Number.isFinite(d.inBytes) && d.inBytes > 0 && Number.isFinite(d.outBytes) && d.outBytes >= 0;
}

function validRange(d: { min: number; max: number } | null | undefined): d is { min: number; max: number } {
  return !!d && Number.isFinite(d.min) && Number.isFinite(d.max) && d.min >= 0 && d.max <= 1 && d.min <= d.max;
}

/**
 * What the treatment would do to this stream, on the strongest basis available (dry run → similar stream →
 * documented range; custom treatments are their own basis). Never invents a ratio, and never projects a pack
 * on a source it is not written for (P1-F13: `{ ok: false, reason: 'not-applicable', applicable: false }`).
 */
export function estimateTreatment(input: EstimateInput): Estimate {
  const { flow, treatment } = input;
  if (!treatmentApplies(treatment, flow)) return { ok: false, treatment, reason: 'not-applicable', applicable: false };
  if (!(flow.inBPerDay > 0)) return { ok: false, treatment, reason: 'no-traffic' };
  const current = currentProjection(flow);

  if (isCustomTreatment(treatment)) {
    const pct = clampDropPct(treatment.dropPct);
    const p = projectDrop(flow, pct);
    return { ok: true, treatment, basis: 'custom', ratio: p.ratio, range: false, current, low: p, mid: p, high: p, detail: { dropPct: pct } };
  }

  if (validDryRun(input.dryRun)) {
    const r = round4(clampRatio(1 - input.dryRun.outBytes / input.dryRun.inBytes));
    const p = projectPack(flow, r);
    return { ok: true, treatment, basis: 'dry-run', ratio: r, range: false, current, low: p, mid: p, high: p, detail: { dryRun: { ...input.dryRun } } };
  }

  if (input.measuredSimilar && Number.isFinite(input.measuredSimilar.ratio)) {
    const r = round4(clampRatio(input.measuredSimilar.ratio));
    const p = projectPack(flow, r);
    return { ok: true, treatment, basis: 'similar', ratio: r, range: false, current, low: p, mid: p, high: p, detail: { fromObject: input.measuredSimilar.fromObject } };
  }

  const doc = input.documented ?? (isPackTreatment(treatment) ? DOCUMENTED[treatment] : null);
  if (validRange(doc)) {
    const min = round4(doc.min);
    const max = round4(doc.max);
    const source = (doc as { source?: string }).source ?? (isPackTreatment(treatment) ? DOCUMENTED[treatment]?.source : undefined);
    return {
      ok: true,
      treatment,
      basis: 'documented',
      ratio: min === max ? min : { min, max },
      range: min !== max,
      current,
      low: projectPack(flow, min),
      mid: projectPack(flow, round4((min + max) / 2)),
      high: projectPack(flow, max),
      detail: source !== undefined ? { source } : {},
    };
  }

  return { ok: false, treatment, reason: 'no-basis' };
}

// ─── The map's after-state and the hero preview ─────────────────────────────

export interface ProjectedFlow extends FlowFigures {
  /** true on the stream the What-if changed (drawn dashed / ghosted). */
  projected?: boolean;
}

/**
 * The snapshot's flows with one stream replaced by the estimate's mid projection. When `targetPipelineId` is
 * given (a similar stream already runs the treatment's pipeline), the stream is re-routed to it so the map
 * shows where the bytes would go.
 */
export function applyProjection(flows: readonly FlowFigures[], stream: StreamKey, estimate: Estimate, targetPipelineId?: string): ProjectedFlow[] {
  if (!estimate.ok) return flows.map((f) => ({ ...f }));
  const p = estimate.mid;
  return flows.map((f) => {
    if (streamKeyOf(f) !== stream) return { ...f };
    const pipelineId = targetPipelineId && targetPipelineId !== '' ? targetPipelineId : f.pipelineId;
    const ratio = p.whpPerDayM > 0 ? p.savedPerDayM / p.whpPerDayM : 0;
    // "Now $/hour" follows the projected spend: today's rate scaled by paid after / paid now.
    const ratePerHourM = f.paidPerDayM > 0 ? Math.round(f.ratePerHourM * (p.paidPerDayM / f.paidPerDayM)) : Math.round(p.paidPerDayM / 24);
    return {
      ...f,
      pipelineId,
      ratePerHourM,
      key: makeFlowKey(f.groupId, f.inputId, f.routeId, pipelineId, f.outputId),
      outBPerDay: p.outBPerDay,
      paidPerDayM: p.paidPerDayM,
      savedPerDayM: p.savedPerDayM,
      ratio,
      projected: true,
    };
  });
}

export interface HeadlinePreview {
  /** saved a year today on the preview's basis (millicents per year) */
  beforeM: number;
  /** after the treatment (mid) */
  afterM: number;
  /** after − before */
  deltaM: number;
  /** false when there is no basis yet (fresh install): show the stream's own per-year figure instead */
  hasBasis: boolean;
  /**
   * What `beforeM` is (founder-build r2 ui-7, IC-2): 'current' — the workspace at today's rates, the strip's own basis,
   * so the hero, its bar and the strip agree; 'annualized' — the Receipt's run rate, when no flow is priced at current
   * rates yet.
   */
  basis: 'current' | 'annualized';
  /** The hero bar today on the same basis (a year of would have paid, paid and saved): 'current' only. */
  bar?: { whpM: number; paidM: number; savedM: number };
}

/** The workspace at today's rates, a year of it (founder-build r2 ui-7): Σ flows' per-day figures × 365. */
export interface CurrentRateBasis {
  whpPerYearM: number;
  paidPerYearM: number;
  /** Σ of each flow's saving (never below zero, as the Receipt's "A day at current rates" sums it) */
  savedPerYearM: number;
}

/**
 * The What if hero's basis (founder-build r2 ui-7, FINDINGS_EXTRA IC-2): every flow at today's rates (the last hour ×
 * 24, the strip's and the Receipt's "A day at current rates" basis), a year of it. Undefined when nothing is priced yet.
 */
export function currentRateBasis(flows: readonly Pick<FlowFigures, 'whpPerDayM' | 'paidPerDayM' | 'savedPerDayM'>[]): CurrentRateBasis | undefined {
  let whp = 0;
  let paid = 0;
  let saved = 0;
  for (const f of flows) {
    if (Number.isFinite(f.whpPerDayM) && f.whpPerDayM > 0) whp += Math.round(f.whpPerDayM);
    if (Number.isFinite(f.paidPerDayM) && f.paidPerDayM > 0) paid += Math.round(f.paidPerDayM);
    if (Number.isFinite(f.savedPerDayM) && f.savedPerDayM > 0) saved += Math.round(f.savedPerDayM);
  }
  return whp > 0 ? { whpPerYearM: perYear(whp), paidPerYearM: perYear(paid), savedPerYearM: perYear(saved) } : undefined;
}

/**
 * "Saved by Cribl would read $X a year at current rates, +$Y" — the workspace at today's rates plus the stream's delta,
 * the strip's own basis (founder-build r2 ui-7, IC-2: the trailing run rate is diluted for a stream younger than its
 * window, so adding a current-rate delta to it read 74 % beside a strip that said 50 % → 60 %). Without a current basis
 * (nothing priced at current rates), today's annualized run rate plus the delta, as before.
 */
export function previewHeadline(headline: Pick<Headline, 'annualizedM'> | null | undefined, estimate: Estimate, current?: CurrentRateBasis): HeadlinePreview | null {
  if (!estimate.ok) return null;
  const delta = estimate.mid.deltaSavedPerYearM;
  if (current && current.whpPerYearM > 0) {
    const before = Math.round(current.savedPerYearM);
    return {
      beforeM: before,
      afterM: before + delta,
      deltaM: delta,
      hasBasis: true,
      basis: 'current',
      bar: { whpM: Math.round(current.whpPerYearM), paidM: Math.round(current.paidPerYearM), savedM: before },
    };
  }
  const before = headline && Number.isFinite(headline.annualizedM) ? Math.round(headline.annualizedM) : 0;
  return { beforeM: before, afterM: before + delta, deltaM: delta, hasBasis: before > 0, basis: 'annualized' };
}

// ─── Projected vs actual (after "Apply for real") ────────────────────────────

export interface MeasuredActual {
  /** byte ratio of the stream's last completed minute */
  ratio: number;
  /** whole minutes between the apply and the snapshot's window end */
  minutes: number;
  pipelineId: string;
}

/**
 * The stream's measured ratio once a sweep has metered a minute that started after the change was applied.
 * Reads the last completed minute (inB/outB), not the hour average, which still mixes the old pipeline in.
 */
export function measureActual(snapshot: Pick<Snapshot, 'flows' | 'windowStart' | 'windowEnd'> | null | undefined, stream: StreamKey, appliedAtMs: number): MeasuredActual | null {
  if (!snapshot || !Number.isFinite(appliedAtMs)) return null;
  const windowStart = Date.parse(snapshot.windowStart);
  const windowEnd = Date.parse(snapshot.windowEnd);
  if (!Number.isFinite(windowStart) || windowStart < appliedAtMs) return null;
  const flow = snapshot.flows.filter((f) => streamKeyOf(f) === stream && f.inB > 0).sort((a, b) => b.inB - a.inB)[0];
  if (!flow) return null;
  return {
    ratio: round4(1 - Math.max(0, flow.outB) / flow.inB),
    minutes: Math.max(0, Math.floor((windowEnd - appliedAtMs) / 60_000)),
    pipelineId: flow.pipelineId,
  };
}

/** Before, projected and measured, side by side, once the change is applied (DESIGN_BRIEF 5.9 "Flip it on"). */
export interface AppliedComparison {
  /** The stream at the ratio it ran before the change (null when that was not recorded). */
  before: Projection | null;
  /** The projection frozen when the change was applied: low and high end (equal for a point estimate). */
  projectedLow: Projection;
  projectedHigh: Projection;
  /** The measured ratio priced the same way (null until a sweep has metered a minute after the change). */
  measured: Projection | null;
  /** Saved per year, measured minus before (null until both exist). */
  measuredDeltaPerYearM: number | null;
  /** Saved per year at the middle of the projection, minus before (null without a before). */
  projectedDeltaPerYearM: number | null;
  /**
   * The measured ratio saves more than the stream did before, in whole points as printed (without a recorded
   * before: it saves anything at all). False until measured — a change that has not landed is never "saved".
   */
  measuredSaves: boolean;
}

/**
 * Prices the before ratio, the frozen projection and the measured ratio on the stream's current volume and
 * price per byte (projectRatio), so the three columns differ only by the ratio — never by traffic noise.
 */
export function compareApplied(
  flow: WhatIfFlow,
  input: { beforeRatio?: number; projected: { min: number; max: number }; measuredRatio?: number | null },
): AppliedComparison {
  const valid = (r: number | null | undefined): r is number => typeof r === 'number' && Number.isFinite(r);
  const before = valid(input.beforeRatio) ? projectRatio(flow, input.beforeRatio) : null;
  const projectedLow = projectRatio(flow, input.projected.min);
  const projectedHigh = projectRatio(flow, input.projected.max);
  const measured = valid(input.measuredRatio) ? projectRatio(flow, input.measuredRatio) : null;
  const mid = projectRatio(flow, round4((input.projected.min + input.projected.max) / 2));
  return {
    before,
    projectedLow,
    projectedHigh,
    measured,
    measuredDeltaPerYearM: before && measured ? measured.savedPerYearM - before.savedPerYearM : null,
    projectedDeltaPerYearM: before ? mid.savedPerYearM - before.savedPerYearM : null,
    measuredSaves: measured !== null && (before ? Math.round(measured.ratio * 100) > Math.round(before.ratio * 100) : measured.savedPerDayM > 0),
  };
}

// ─── The biggest unclaimed savings (P2-W23) ──────────────────────────────────

/**
 * The pack written for a stream's source, when it does not run it yet (nor, for Windows, the stronger reduction):
 * the saving "not taken yet". Going aggressive is a compatibility trade-off the member chooses in the calculator,
 * never an unclaimed saving. Undefined when no pack fits the source or it already runs one.
 */
export function nextTreatment(flow: Pick<FlowFigures, 'inputId' | 'routeId' | 'pipelineId'>): PackTreatment | undefined {
  switch (sourceKind(flow)) {
    case 'windows':
      return pipelineMatchesTreatment(flow.pipelineId, 'pack-windows') || pipelineMatchesTreatment(flow.pipelineId, 'aggressive-windows') ? undefined : 'pack-windows';
    case 'panos':
      return pipelineMatchesTreatment(flow.pipelineId, 'pack-panos') ? undefined : 'pack-panos';
    case 'vpc':
      return pipelineMatchesTreatment(flow.pipelineId, 'pack-vpc') ? undefined : 'pack-vpc';
    default:
      return undefined;
  }
}

export interface UnclaimedSaving {
  streamKey: StreamKey;
  flow: FlowFigures;
  treatment: PackTreatment;
  estimate: EstimateOk;
  /** What the change would add a year, at the middle of the estimate (the ranking key). */
  deltaPerYearM: number;
}

/**
 * Where the biggest saving not yet taken is: every stream × the next pack that fits it, estimated on the same
 * bases as the calculator (a similar stream in this workspace, else the documented range — never a guess; a
 * pack with neither is left out), ranked by what it would add a year. `streams` are the candidate streams (one
 * flow per stream); `snapshot` supplies the similar streams.
 */
export function unclaimedSavings(
  streams: readonly FlowFigures[],
  snapshot: Pick<Snapshot, 'flows'>,
  opts: { groupId?: string; limit?: number } = {},
): UnclaimedSaving[] {
  const out: UnclaimedSaving[] = [];
  const seen = new Set<StreamKey>();
  for (const flow of streams) {
    const key = streamKeyOf(flow);
    if (seen.has(key)) continue;
    seen.add(key);
    const treatment = nextTreatment(flow);
    if (!treatment) continue;
    const similar = findSimilarStream(snapshot, treatment, { excludeStreamKey: key, ...(opts.groupId !== undefined ? { groupId: opts.groupId } : { groupId: flow.groupId }) });
    const estimate = estimateTreatment({ flow, treatment, ...(similar ? { measuredSimilar: { ratio: similar.ratio, fromObject: similar.fromObject } } : {}) });
    if (!estimate.ok || !(estimate.mid.deltaSavedPerYearM > 0)) continue;
    out.push({ streamKey: key, flow, treatment, estimate, deltaPerYearM: estimate.mid.deltaSavedPerYearM });
  }
  out.sort((a, b) => b.deltaPerYearM - a.deltaPerYearM || (a.streamKey < b.streamKey ? -1 : a.streamKey > b.streamKey ? 1 : 0));
  return out.slice(0, Math.max(0, opts.limit ?? 5));
}

/**
 * Why "Biggest unclaimed savings" is empty (founder-build r1 ui-4, FOUNDER_PLAN row 2, HUNGER #5), so the page never
 * claims "every stream here already runs the pack written for it" on a workspace no pack fits:
 *   noneFit    no stream here is one the packs are written for (Windows event logs, Palo Alto firewall syslog, VPC Flow
 *              Logs): the clean-install Datagen → DevNull workspace, and most real estates;
 *   noBasis    a stream a pack fits does not run it, and nothing here can estimate it (no similar stream runs the pack,
 *              and the pack publishes no range);
 *   savesMore  the streams a pack fits and that don't run it already save at least what the pack would;
 *   none       every stream a pack fits runs it (the Palo Alto Networks pack attached alone counts as running).
 * Undefined when unclaimedSavings has a line. Same candidates and bases as unclaimedSavings.
 */
export type UnclaimedEmptyReason = 'noneFit' | 'noBasis' | 'savesMore' | 'none';

export function unclaimedEmptyReason(
  streams: readonly FlowFigures[],
  snapshot: Pick<Snapshot, 'flows'>,
  opts: { groupId?: string } = {},
): UnclaimedEmptyReason | undefined {
  if (unclaimedSavings(streams, snapshot, { ...opts, limit: 1 }).length > 0) return undefined;
  let fitting = 0;
  let noBasis = 0;
  let savesMore = 0;
  const seen = new Set<StreamKey>();
  for (const flow of streams) {
    const key = streamKeyOf(flow);
    if (seen.has(key)) continue;
    seen.add(key);
    if (sourceKind(flow) === 'other') continue;
    fitting++;
    const treatment = nextTreatment(flow);
    if (!treatment) continue;
    const similar = findSimilarStream(snapshot, treatment, { excludeStreamKey: key, ...(opts.groupId !== undefined ? { groupId: opts.groupId } : { groupId: flow.groupId }) });
    const estimate = estimateTreatment({ flow, treatment, ...(similar ? { measuredSimilar: { ratio: similar.ratio, fromObject: similar.fromObject } } : {}) });
    if (!estimate.ok) noBasis++;
    else savesMore++;
  }
  if (fitting === 0) return 'noneFit';
  if (noBasis > 0) return 'noBasis';
  if (savesMore > 0) return 'savesMore';
  return 'none';
}

/** How many distinct streams in `groupId` run the treatment's pipeline today (the tile's "runs on N streams here"). */
export function streamsRunning(snapshot: Pick<Snapshot, 'flows'> | null | undefined, treatment: PackTreatment, groupId?: string): number {
  if (!snapshot) return 0;
  const keys = new Set<StreamKey>();
  for (const f of snapshot.flows) {
    if (groupId !== undefined && f.groupId !== groupId) continue;
    if (f.inBPerDay > 0 && pipelineMatchesTreatment(f.pipelineId, treatment)) keys.add(streamKeyOf(f));
  }
  return keys.size;
}
