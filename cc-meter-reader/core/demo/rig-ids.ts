// core/demo/rig-ids.ts — the demo rig's identifiers and lever targets (SPEC 2, 11, 14.2).
//
// Mirrors demo/rig/sources.json (the rig applied live) and testdata/gen.ts RIG (the emulator's rig).
// Route ids have been spelled two ways — the live rig names each route after its Source
// (`mrd_payments_api`), the first emulator rig prefixed them (`mrd_rt_payments_api`) — so nothing here assumes
// a route id: a route is resolved to its rig source by id OR by the input its filter selects
// (`__inputId=='datagen:<inputId>'`). "Apply the pack" only swaps the route's pipeline: the rig keeps the
// Palo Alto syslog pre-processing inside mrd_pan_pack (sources.json `preProcessingOnApply: null`), so no lever
// touches a Source's pre-processing pipeline. Pure data and lookups; no I/O.

import { DEMO_TAG, objectKey, parseRouteFilter, splitInputValue } from '../flows.ts';
import type { ObjectKey } from '../types.ts';

export { DEMO_TAG };
/** Marks the one function per demo pipeline that "Break the trim" disables (SPEC 11). */
export const TRIM_TAG = '[mr-trim]';
/** Worker group the rig lives in. */
export const RIG_GROUP_ID = 'default';

export const RIG_PIPELINES = {
  passthrough: 'mrd_passthrough',
  winXmlPack: 'mrd_win_xml_pack',
  winDocsReduce: 'mrd_win_docs_reduce',
  syslogPre: 'mrd_syslog_pre',
  panPack: 'mrd_pan_pack',
  vpcPack: 'mrd_vpc_pack',
  paySample: 'mrd_pay_sample',
  k8sNoise: 'mrd_k8s_noise',
} as const;

export const RIG_OUTPUTS = {
  siem: 'mrd_siem_prod',
  /** The payments API's own SIEM destination (D21): priced like siem-prod. */
  siemApps: 'mrd_siem_apps',
  analytics: 'mrd_analytics',
  archive: 'mrd_archive_s3',
} as const;

/** One rig Source, its route and what each lever may point it at. */
export interface RigSourceIds {
  key: string;
  inputId: string;
  label: string;
  /** Route ids this Source's route may carry: the live rig's (= inputId) and the emulator's (`mrd_rt_<key>`). */
  routeIds: readonly string[];
  /** The route's steady-state pipeline (what "Revert the pack" returns to). */
  pipelineId: string;
  outputId: string;
  /** "Apply the pack" target; absent for Sources that are reduced all week. */
  packPipelineId?: string;
  /** "Go aggressive" target (Windows workstations only). */
  aggressivePipelineId?: string;
  /** Pipeline holding the `[mr-trim]` function "Break the trim" disables. */
  trimPipelineId?: string;
}

const source = (s: Omit<RigSourceIds, 'routeIds'>): RigSourceIds => ({
  ...s,
  routeIds: [s.inputId, `mrd_rt_${s.key}`],
});

/** The six rig Sources (SPEC 14.2 / demo/rig/sources.json). */
export const RIG_SOURCES: readonly RigSourceIds[] = [
  source({
    key: 'windows_dc',
    inputId: 'mrd_windows_dc',
    label: 'Windows domain controllers',
    pipelineId: RIG_PIPELINES.winXmlPack,
    outputId: RIG_OUTPUTS.siem,
  }),
  source({
    key: 'windows_workstations',
    inputId: 'mrd_windows_workstations',
    label: 'Windows workstations',
    pipelineId: RIG_PIPELINES.passthrough,
    outputId: RIG_OUTPUTS.siem,
    packPipelineId: RIG_PIPELINES.winXmlPack,
    aggressivePipelineId: RIG_PIPELINES.winDocsReduce,
  }),
  source({
    key: 'pan_firewall',
    inputId: 'mrd_pan_firewall',
    label: 'Palo Alto firewalls',
    pipelineId: RIG_PIPELINES.passthrough,
    outputId: RIG_OUTPUTS.siem,
    packPipelineId: RIG_PIPELINES.panPack,
  }),
  source({
    key: 'vpc_flow',
    inputId: 'mrd_vpc_flow',
    label: 'AWS VPC Flow Logs',
    pipelineId: RIG_PIPELINES.passthrough,
    outputId: RIG_OUTPUTS.archive,
    packPipelineId: RIG_PIPELINES.vpcPack,
  }),
  source({
    key: 'payments_api',
    inputId: 'mrd_payments_api',
    label: 'Payments API',
    pipelineId: RIG_PIPELINES.paySample,
    outputId: RIG_OUTPUTS.siem,
    trimPipelineId: RIG_PIPELINES.paySample,
  }),
  source({
    key: 'k8s_prod',
    inputId: 'mrd_k8s_prod',
    label: 'Kubernetes (prod)',
    pipelineId: RIG_PIPELINES.k8sNoise,
    outputId: RIG_OUTPUTS.analytics,
    trimPipelineId: RIG_PIPELINES.k8sNoise,
  }),
];

/** The rig's routes as the demo script names them (keyboard 1/2/3 apply the pack to these). */
export const PACK_ROUTE_KEYS = ['windows_workstations', 'pan_firewall', 'vpc_flow'] as const;

/** True when a Cribl object's description carries the demo token (SPEC 2: the enforced check). */
export function isDemoTagged(description: unknown): boolean {
  return typeof description === 'string' && description.includes(DEMO_TAG);
}

/** The rig Source with this input id, route id (either spelling) or key. */
export function rigSource(id: string): RigSourceIds | undefined {
  return RIG_SOURCES.find((s) => s.inputId === id || s.key === id || s.routeIds.includes(id));
}

/**
 * The single input a route filter selects (`__inputId=='datagen:mrd_x'`), or undefined when the
 * filter selects none, several, or is not a plain input match.
 */
export function inputIdFromFilter(filter: string | undefined): string | undefined {
  const m = parseRouteFilter(filter);
  if (m.kind !== 'inputs' || m.refs.length !== 1 || m.refs[0].prefix) return undefined;
  return splitInputValue(m.refs[0].value).id;
}

/** Resolves a route to its rig Source: by the route id first, else by the input its filter selects. */
export function rigSourceForRoute(route: { id: string; filter?: string }): RigSourceIds | undefined {
  const byId = RIG_SOURCES.find((s) => s.routeIds.includes(route.id));
  if (byId) return byId;
  const inputId = inputIdFromFilter(route.filter);
  return inputId ? RIG_SOURCES.find((s) => s.inputId === inputId) : undefined;
}

/**
 * Object keys detection may evaluate for a rig Source (every route-id spelling, its input, and the
 * given pipelines). Muting all of them after Revert/Restore/Reset is harmless for keys that don't exist.
 */
export function rigObjectKeys(src: RigSourceIds, groupId: string, pipelineIds: readonly (string | undefined)[] = []): ObjectKey[] {
  const keys = new Set<ObjectKey>([objectKey('in', groupId, src.inputId), ...src.routeIds.map((r) => objectKey('route', groupId, r))]);
  for (const p of [src.pipelineId, ...pipelineIds]) if (p && p !== '-') keys.add(objectKey('pipe', groupId, p));
  return [...keys];
}

/** Rig Sources whose route runs (or ran) `pipelineId` — the objects a trim change affects. */
export function rigSourcesUsingPipeline(pipelineId: string): RigSourceIds[] {
  return RIG_SOURCES.filter(
    (s) =>
      s.pipelineId === pipelineId ||
      s.trimPipelineId === pipelineId ||
      s.packPipelineId === pipelineId ||
      s.aggressivePipelineId === pipelineId,
  );
}
