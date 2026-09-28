// src/components/WhatIf/leverTarget.ts — which demo lever "Apply for real" pulls for a stream + treatment.
// DEMO BUILD ONLY: imported by ApplyForReal.tsx (a lazy chunk behind the inline build flag) and by tests.

import { PACK_ROUTE_KEYS, rigSource } from '../../../core/demo/rig-ids.ts';

export type PackRouteKey = (typeof PACK_ROUTE_KEYS)[number];

export interface LeverTarget {
  routeKey: PackRouteKey;
  level: 'pack' | 'aggressive';
  /** the pipeline the route will point at */
  pipelineId: string;
}

/**
 * The rig route and lever level for a stream + treatment, or undefined when the demo lever can't apply it
 * (not a rig stream, not one of the three raw streams, or a pack that doesn't fit the source).
 */
export function leverTarget(inputId: string, routeId: string, treatment: string): LeverTarget | undefined {
  const src = rigSource(routeId) ?? rigSource(inputId);
  if (!src || !(PACK_ROUTE_KEYS as readonly string[]).includes(src.key) || !src.packPipelineId) return undefined;
  const key = src.key as PackRouteKey;
  if (treatment === 'aggressive-windows') return src.aggressivePipelineId ? { routeKey: key, level: 'aggressive', pipelineId: src.aggressivePipelineId } : undefined;
  const fits =
    (treatment === 'pack-windows' && key === 'windows_workstations') ||
    (treatment === 'pack-panos' && key === 'pan_firewall') ||
    (treatment === 'pack-vpc' && key === 'vpc_flow');
  return fits ? { routeKey: key, level: 'pack', pipelineId: src.packPipelineId } : undefined;
}
