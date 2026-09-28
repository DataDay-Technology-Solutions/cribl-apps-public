// src/components/WhatIf/landing.ts — "flip it on, watch it land" (P2-W06): what the good-news takeover knows
// about the What-if that forecast it.
//
// When the What-if applies a treatment (demo build: Apply for real), the projection it made is frozen into the
// URL (useWhatIf.ts ?applied=&projected=&was=) and recorded HERE, in memory, keyed by stream. When the detector
// then announces the improvement (a good-news incident on the stream's route, carrying the commit the lever
// made), the presenter's takeover looks the forecast up and prints "Projected 30–35%, measured 33% after 3 min"
// on the green card. Nothing is written anywhere (no browser storage, no KV): a reload re-records it from the
// URL when the What-if mounts, and a card with no matching forecast simply leaves the line out — it never
// substitutes a documented range the member did not see.

import type { Incident, Settings } from '../../../core/types.ts';
import { goodNewsActive } from '../../../core/settings.ts';
import { parseObjectKey } from '../../../core/flows.ts';
import { IS_DEMO_BUILD } from '../../lib/env.ts';

/** One What-if apply: the stream, the forecast frozen at that moment, and when it was applied. */
export interface AppliedForecast {
  streamKey: string;
  groupId: string;
  inputId: string;
  routeId: string;
  outputId: string;
  /** The treatment key the What-if applied (TreatmentKey). */
  treatment: string;
  /** The projected byte savings ratio (equal ends for a point estimate). */
  projected: { min: number; max: number };
  /** The ratio the stream ran before (when recorded). */
  was?: number;
  appliedAt: number;
}

/** A forecast is matched to good news that opens within this long after the apply. */
export const LANDING_WINDOW_MS = 60 * 60_000;
/** …and whose commit was deployed within this long of the apply (the lever's own commit). */
export const COMMIT_SLACK_MS = 5 * 60_000;

const forecasts = new Map<string, AppliedForecast>();

export function recordApplied(f: AppliedForecast): void {
  if (!Number.isFinite(f.appliedAt) || f.appliedAt <= 0) return;
  forecasts.set(f.streamKey, { ...f, projected: { ...f.projected } });
}

/** Every recorded forecast, newest first. */
export function appliedForecasts(): AppliedForecast[] {
  return [...forecasts.values()].sort((a, b) => b.appliedAt - a.appliedAt);
}

/** Tests only. */
export function clearAppliedForecasts(): void {
  forecasts.clear();
}

/**
 * The forecast a good-news incident proves: same worker group, the incident's route (or source / destination)
 * is the stream's, it opened after the apply (within the hour), and its commit — when it names one — was
 * deployed within minutes of the apply. The newest such forecast; undefined when none matches.
 */
export function forecastFor(
  incident: Pick<Incident, 'objectKey' | 'openedAt' | 'commit'>,
  list: readonly AppliedForecast[] = appliedForecasts(),
): AppliedForecast | undefined {
  const obj = parseObjectKey(incident.objectKey);
  const opened = Date.parse(incident.openedAt);
  if (!obj || !Number.isFinite(opened)) return undefined;
  const deployedIso = incident.commit ? (incident.commit.deployedAt ?? incident.commit.committedAt) : undefined;
  const deployed = deployedIso ? Date.parse(deployedIso) : Number.NaN;
  const sameObject = (f: AppliedForecast): boolean => {
    if (f.groupId !== obj.groupId) return false;
    if (obj.kind === 'route') return f.routeId === obj.id;
    if (obj.kind === 'in') return f.inputId === obj.id;
    if (obj.kind === 'out') return f.outputId === obj.id;
    return false;
  };
  return [...list]
    .filter(sameObject)
    .filter((f) => opened >= f.appliedAt - 60_000 && opened - f.appliedAt <= LANDING_WINDOW_MS)
    .filter((f) => !Number.isFinite(deployed) || Math.abs(deployed - f.appliedAt) <= COMMIT_SLACK_MS)
    .sort((a, b) => b.appliedAt - a.appliedAt)[0];
}

/** Whole minutes from the apply to the sweep that announced it (at least 1: a landing is never "after 0 min"). */
export function minutesToLand(forecast: Pick<AppliedForecast, 'appliedAt'>, incident: Pick<Incident, 'openedAt'>): number {
  const opened = Date.parse(incident.openedAt);
  if (!Number.isFinite(opened)) return 1;
  return Math.max(1, Math.round((opened - forecast.appliedAt) / 60_000));
}

/**
 * Whether good news may take over the stage: the member's switch, or — in the demo build only — the demo
 * profile (core/settings.ts goodNewsActive). The release build never shows one unless goodNewsEnabled is on,
 * even when a stored demo profile (or the runner) opened the incident.
 */
export function landedAllowed(settings: Pick<Settings, 'goodNewsEnabled' | 'demo'> | null | undefined): boolean {
  if (!settings) return false;
  return settings.goodNewsEnabled === true || (IS_DEMO_BUILD && goodNewsActive(settings));
}
