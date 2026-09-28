// src/components/WhatIf/useWhatIf.ts — the What-if state (DESIGN_BRIEF 5.9) for one worker group.
//
// State lives in the URL only (SPEC 13 "Persistence"): ?stream=<stream key>&treatment=<id|custom>&drop=<pct>
// and, after "Apply for real" in the demo build, &applied=<epoch ms>&projected=<ratio | min~max>&was=<ratio> — the
// stream, treatment, projection and the ratio it ran before are frozen into the URL at that moment, because once the change lands the live
// estimate moves on (the stream now runs the treatment) and the default stream would move with it. Everything else is derived from the
// snapshot with core/whatif.ts, so the math is the tested math.
//
// The one exception is a dry run's measurement (core/adapters/preview.ts): it is an explicit, user-started
// read of the Leader, kept in memory for the stream + treatment it measured and dropped when either changes.
// It is never written anywhere. Offered only on live data (never on the sample tour) for a pack treatment
// the stream does not already run.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { FlowFigures, Snapshot } from '../../../core/types.ts';
import {
  applyProjection,
  byteRatio,
  clampDropPct,
  compareApplied,
  estimateTreatment,
  findSimilarStream,
  isPackTreatment,
  measureActual,
  pipelineMatchesTreatment,
  previewHeadline,
  streamKeyOf,
  streamsRunning,
  suggestTreatment,
  treatmentApplies,
  unclaimedSavings,
  type AppliedComparison,
  type Estimate,
  type HeadlinePreview,
  type MeasuredActual,
  type PackTreatment,
  type ProjectedFlow,
  type SimilarStream,
  type StreamKey,
  type Treatment,
  type UnclaimedSaving,
} from '../../../core/whatif.ts';
import { runDryRun as runPreviewDryRun, type DryRunResult } from '../../../core/adapters/preview.ts';
import { createFetchHttp, type FetchLike } from '../../../core/http.ts';
import { apiBaseUrl } from '../../lib/env.ts';
import { useAppState } from '../../state/react.tsx';
import { isDrawable } from '../FlowDiagram/layout.ts';
import { annualizedParts } from '../../views/Receipt/model.ts';
import { recordApplied } from './landing.ts';

export type TreatmentKey = PackTreatment | 'custom';
export const TREATMENT_KEYS: readonly TreatmentKey[] = ['pack-windows', 'pack-panos', 'pack-vpc', 'aggressive-windows', 'custom'];
export const DEFAULT_DROP_PCT = 20;

export interface StreamOption {
  key: StreamKey;
  flow: FlowFigures;
  suggested?: PackTreatment;
}

/** What a treatment tile says about this stream and this workspace (P2-W23). */
export interface TreatmentTileInfo {
  /** The treatment fits the stream's source (P1-F13). */
  applicable: boolean;
  /** Distinct streams in the group running it today. */
  runsOn: number;
  /** The measured ratio of the stream the estimate would borrow (the similar stream), when there is one. */
  similarRatio?: number;
}

/** The dry run of the current stream + treatment: not run, running, or its result (a measurement or why not). */
export type DryRunView = { status: 'idle' } | { status: 'running' } | { status: 'done'; result: DryRunResult };

export interface WhatIfModel {
  streams: StreamOption[];
  stream?: StreamOption;
  treatmentKey: TreatmentKey;
  dropPct: number;
  treatment: Treatment;
  similar: SimilarStream | null;
  estimate: Estimate | null;
  /** The group's flows with the stream projected (null when there is nothing to project). */
  projectedFlows: ProjectedFlow[] | null;
  preview: HeadlinePreview | null;
  /**
   * Today's annualized receipt bar (the Receipt hero's Annualized figures: would have paid, paid, saved), which
   * the What-if hero extends by the projection (P2-W08); null before the first run rate.
   */
  heroBar: { whpM: number; paidM: number; savedM: number } | null;
  /** The stream already runs this treatment's pipeline. */
  alreadyRuns: boolean;
  /** The treatment fits the stream's source (P1-F13); false → nothing is projected. */
  applicable: boolean;
  appliedAt?: number;
  /** The byte ratio projected when the change was applied (a range for a documented basis). */
  appliedProjection?: { min: number; max: number };
  measured: MeasuredActual | null;
  /** Before, projected and measured side by side once the change is applied (null before that). */
  applied: AppliedComparison | null;
  /** The workspace's annualized run rate right now (null before the first headline). */
  liveAnnualizedM: number | null;
  /** "Dry run on sample events" is offered (live data, a pack treatment the stream does not run yet). */
  dryRunAvailable: boolean;
  dryRun: DryRunView;
  /** Runs the treatment's pipeline over the Source's sample events through the Leader's preview API. */
  runDryRun(): void;
  /** P2-W26: the dry run on a sample the member picked from the group (a Source with none of its own). */
  runDryRunOn(sampleId: string): void;
  setStream(key: StreamKey): void;
  setTreatment(key: TreatmentKey): void;
  setDrop(pct: number): void;
  markApplied(atMs: number): void;
  /** P2-W23: per treatment, whether it fits this stream and how much of this workspace already runs it. */
  tiles: Record<TreatmentKey, TreatmentTileInfo>;
  /** P2-W23: the biggest savings not yet taken in this group, ranked (at most five). */
  unclaimed: UnclaimedSaving[];
  /** The in-app link that loads the calculator on a stream + treatment (keeps the other params). */
  linkFor(streamKey: StreamKey, treatment: TreatmentKey): string;
}

const parseTreatment = (raw: string | null): TreatmentKey | undefined =>
  raw !== null && (TREATMENT_KEYS as readonly string[]).includes(raw) ? (raw as TreatmentKey) : undefined;

/** `0.33` or `0.3~0.35` → a projected ratio range. */
export function parseProjected(raw: string | null): { min: number; max: number } | undefined {
  if (raw === null) return undefined;
  const parts = raw.split('~').map(Number);
  if (parts.length < 1 || parts.length > 2 || parts.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) return undefined;
  return { min: Math.min(...parts), max: Math.max(...parts) };
}

/** The stream the view opens on: the biggest raw stream a pack fits, else the biggest stream. */
export function defaultStream(streams: readonly StreamOption[]): StreamOption | undefined {
  return streams.find((s) => s.suggested !== undefined && byteRatio(s.flow) < 0.05) ?? streams[0];
}

/** Priced streams with traffic in a group, largest would-have-paid first. */
export function streamOptions(snapshot: Snapshot | null, groupId: string): StreamOption[] {
  if (!snapshot) return [];
  const seen = new Set<string>();
  return snapshot.flows
    .filter((f) => f.groupId === groupId && isDrawable(f))
    .sort((a, b) => b.whpPerDayM - a.whpPerDayM || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .filter((f) => {
      const key = streamKeyOf(f);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((f) => ({ key: streamKeyOf(f), flow: f, suggested: suggestTreatment(f.inputId) }));
}

export function useWhatIf(snapshot: Snapshot | null, groupId: string): WhatIfModel {
  const [search, setSearch] = useSearchParams();
  const streams = useMemo(() => streamOptions(snapshot, groupId), [snapshot, groupId]);
  const requested = search.get('stream');
  const stream = streams.find((s) => s.key === requested) ?? defaultStream(streams);
  const treatmentKey: TreatmentKey = parseTreatment(search.get('treatment')) ?? stream?.suggested ?? 'custom';
  const dropRaw = Number(search.get('drop'));
  const dropPct = search.get('drop') !== null && Number.isFinite(dropRaw) ? clampDropPct(dropRaw) : DEFAULT_DROP_PCT;
  const appliedRaw = Number(search.get('applied'));
  const appliedAt = search.get('applied') !== null && Number.isFinite(appliedRaw) && appliedRaw > 0 ? appliedRaw : undefined;
  const projectedRaw = search.get('projected');
  const appliedProjection = useMemo(() => parseProjected(projectedRaw), [projectedRaw]);
  const appliedBefore = parseProjected(search.get('was'))?.min;
  const live = useAppState((s) => s.source === 'live');
  const tz = useAppState((s) => s.settings.displayTimezone);

  // The dry run belongs to one stream + treatment in one group; any other key shows as not run.
  const dryRunKey = `${groupId}|${stream?.key ?? ''}|${treatmentKey}`;
  const [dryRunState, setDryRunState] = useState<{ key: string; view: DryRunView } | null>(null);
  const dryRun: DryRunView = dryRunState && dryRunState.key === dryRunKey ? dryRunState.view : { status: 'idle' };
  const measuredDryRun = dryRun.status === 'done' && dryRun.result.ok ? dryRun.result : undefined;
  const inFlight = useRef<string | null>(null);

  const derived = useMemo(() => {
    const treatment: Treatment = treatmentKey === 'custom' ? { dropPct } : treatmentKey;
    if (!stream || !snapshot) {
      return { treatment, similar: null, estimate: null, projectedFlows: null, preview: null, heroBar: null, alreadyRuns: false, applicable: true, measured: null, applied: null, liveAnnualizedM: null };
    }
    const alreadyRuns = isPackTreatment(treatment) && pipelineMatchesTreatment(stream.flow.pipelineId, treatment);
    const applicable = treatmentApplies(treatment, stream.flow);
    // A pack that does not fit this source borrows no one's ratio (P1-F13): its estimate is refused.
    const similar = applicable ? findSimilarStream(snapshot, treatment, { excludeStreamKey: stream.key, groupId }) : null;
    const estimate = estimateTreatment({
      flow: stream.flow,
      treatment,
      ...(similar ? { measuredSimilar: { ratio: similar.ratio, fromObject: similar.fromObject } } : {}),
      ...(measuredDryRun
        ? {
            dryRun: {
              inBytes: measuredDryRun.inBytes,
              outBytes: measuredDryRun.outBytes,
              events: measuredDryRun.events,
              pipelineId: measuredDryRun.pipelineId,
              sampleId: measuredDryRun.sampleId,
              ...(measuredDryRun.picked ? { picked: true } : {}),
            },
          }
        : {}),
    });
    const groupFlows = snapshot.flows.filter((f) => f.groupId === groupId);
    // Re-route to the pipeline the basis measured (a dry run's, or the one a similar stream already runs),
    // so the map shows where the bytes would go.
    const target =
      estimate.ok && estimate.basis === 'dry-run' && measuredDryRun
        ? measuredDryRun.pipelineId
        : estimate.ok && estimate.basis === 'similar' && similar
          ? similar.pipelineId
          : undefined;
    const projectedFlows = estimate.ok && !alreadyRuns && appliedAt === undefined ? applyProjection(groupFlows, stream.key, estimate, target) : null;
    const measured = appliedAt !== undefined ? measureActual(snapshot, stream.key, appliedAt) : null;
    // The frozen projection, else the live estimate's (an ?applied= URL without &projected=).
    const projected = appliedProjection ?? (estimate.ok ? { min: estimate.low.ratio, max: estimate.high.ratio } : undefined);
    const applied =
      appliedAt !== undefined && projected
        ? compareApplied(stream.flow, { projected, measuredRatio: measured?.ratio ?? null, ...(appliedBefore !== undefined ? { beforeRatio: appliedBefore } : {}) })
        : null;
    const annualized = snapshot.headline?.annualizedM;
    const runRate = typeof annualized === 'number' && Number.isFinite(annualized) && annualized > 0;
    const parts = runRate ? annualizedParts(snapshot, tz) : null;
    return {
      treatment,
      similar,
      estimate,
      projectedFlows,
      preview: previewHeadline(snapshot.headline, estimate),
      heroBar: parts ? { whpM: parts.whpM, paidM: parts.paidM, savedM: Math.round(annualized) } : null,
      alreadyRuns,
      applicable,
      measured,
      applied,
      liveAnnualizedM: typeof annualized === 'number' && Number.isFinite(annualized) ? Math.round(annualized) : null,
    };
  }, [snapshot, stream, treatmentKey, dropPct, groupId, appliedAt, appliedProjection, appliedBefore, measuredDryRun, tz]);

  // P2-W06: the forecast this apply made, in memory for the good-news takeover (landing.ts). The URL is the
  // record; this re-reads it whenever it changes (a reload of an ?applied= URL re-records it).
  const appliedStream = appliedAt !== undefined ? stream : undefined;
  const appliedForecast = derived.applied ? { min: derived.applied.projectedLow.ratio, max: derived.applied.projectedHigh.ratio } : undefined;
  const forecastMin = appliedProjection?.min ?? appliedForecast?.min;
  const forecastMax = appliedProjection?.max ?? appliedForecast?.max;
  useEffect(() => {
    if (appliedAt === undefined || !appliedStream || forecastMin === undefined || forecastMax === undefined) return;
    const f = appliedStream.flow;
    recordApplied({
      streamKey: appliedStream.key,
      groupId: f.groupId,
      inputId: f.inputId,
      routeId: f.routeId,
      outputId: f.outputId,
      treatment: treatmentKey,
      projected: { min: Math.min(forecastMin, forecastMax), max: Math.max(forecastMin, forecastMax) },
      ...(appliedBefore !== undefined ? { was: appliedBefore } : {}),
      appliedAt,
    });
  }, [appliedAt, appliedStream, forecastMin, forecastMax, treatmentKey, appliedBefore]);

  // P2-W23: the tiles and the unclaimed list (pure core, recomputed per snapshot / stream).
  const tiles = useMemo(() => {
    const out = {} as Record<TreatmentKey, TreatmentTileInfo>;
    for (const k of TREATMENT_KEYS) {
      if (k === 'custom') {
        out[k] = { applicable: true, runsOn: 0 };
        continue;
      }
      const similar = stream && snapshot ? findSimilarStream(snapshot, k, { excludeStreamKey: stream.key, groupId }) : null;
      out[k] = {
        applicable: stream ? treatmentApplies(k, stream.flow) : true,
        runsOn: streamsRunning(snapshot, k, groupId),
        ...(similar ? { similarRatio: similar.ratio } : {}),
      };
    }
    return out;
  }, [snapshot, stream, groupId]);
  const unclaimed = useMemo(() => (snapshot ? unclaimedSavings(streams.map((s) => s.flow), snapshot, { groupId, limit: 5 }) : []), [snapshot, streams, groupId]);
  const linkFor = useCallback(
    (streamKey: StreamKey, treatment: TreatmentKey): string => {
      const next = new URLSearchParams(search);
      for (const k of ['applied', 'projected', 'was', 'drop']) next.delete(k);
      next.set('stream', streamKey);
      next.set('treatment', treatment);
      return `?${next.toString()}`;
    },
    [search],
  );

  const dryRunAvailable =
    live && !!stream && !!snapshot && isPackTreatment(derived.treatment) && derived.applicable && !derived.alreadyRuns && appliedAt === undefined;

  const startDryRun = useCallback((sampleId?: string) => {
    if (!dryRunAvailable || !stream || !isPackTreatment(derived.treatment) || inFlight.current === dryRunKey) return;
    const key = dryRunKey;
    const treatment = derived.treatment;
    inFlight.current = key;
    setDryRunState({ key, view: { status: 'running' } });
    let baseUrl = '';
    try {
      baseUrl = apiBaseUrl();
    } catch {
      baseUrl = ''; // outside Cribl: every call then fails visibly as a network error
    }
    const http = createFetchHttp({ fetch: window.fetch as unknown as FetchLike, baseUrl });
    // The similar stream's pipeline only when it lives in this group (the preview runs group-scoped);
    // otherwise runDryRun looks the treatment's pipeline up in this group.
    const pipelineId = derived.similar && derived.similar.groupId === groupId ? derived.similar.pipelineId : undefined;
    void runPreviewDryRun(http, { groupId, inputId: stream.flow.inputId, treatment, pipelineId, ...(sampleId ? { sampleId } : {}) }).then((result) => {
      if (inFlight.current === key) inFlight.current = null;
      setDryRunState((cur) => (cur && cur.key !== key && cur.view.status === 'running' ? cur : { key, view: { status: 'done', result } }));
    });
  }, [dryRunAvailable, stream, derived.treatment, derived.similar, dryRunKey, groupId]);

  const patch = useCallback(
    (entries: Record<string, string | null>) => {
      setSearch(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [k, v] of Object.entries(entries)) {
            if (v === null) next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearch],
  );

  return {
    streams,
    stream,
    treatmentKey,
    dropPct,
    appliedAt,
    ...derived,
    dryRunAvailable,
    dryRun,
    // "Dry run again" re-measures on the sample the last measurement used when the member picked it.
    runDryRun: () => startDryRun(measuredDryRun?.picked ? measuredDryRun.sampleId : undefined),
    runDryRunOn: (sampleId: string) => startDryRun(sampleId),
    setStream: (key) => {
      const next = streams.find((s) => s.key === key);
      // A new stream starts on its own suggested treatment (the one that fits its source).
      patch({ stream: key, treatment: next?.suggested ?? 'custom', applied: null, projected: null, was: null });
    },
    setTreatment: (key) => patch({ treatment: key, applied: null, projected: null, was: null }),
    setDrop: (pct) => patch({ drop: String(clampDropPct(pct)), applied: null, projected: null, was: null }),
    appliedProjection,
    tiles,
    unclaimed,
    linkFor,
    markApplied: (atMs) => {
      const e = derived.estimate;
      const projected = e && e.ok ? (e.range ? `${e.low.ratio}~${e.high.ratio}` : String(e.mid.ratio)) : null;
      patch({
        applied: String(Math.round(atMs)),
        stream: stream?.key ?? null,
        treatment: treatmentKey,
        ...(treatmentKey === 'custom' ? { drop: String(dropPct) } : {}),
        projected,
        was: e && e.ok ? String(e.current.ratio) : null,
      });
    },
  };
}
