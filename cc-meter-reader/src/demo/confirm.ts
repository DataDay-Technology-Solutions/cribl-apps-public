// src/demo/confirm.ts — what each Demo Console confirmation says (REVIEW-3a #7, AGENTS.md "Confirming
// Destructive Operations"). DEMO BUILD ONLY. Pure: no I/O, no DOM.
//
// Every volatile lever (apply / revert / aggressive / break / restore / spike / calm / reset / reset baselines
// / weekly receipt now) and every scene start asks first, from a button or a lever key alike. The question
// names exactly what will change: each object's id and the change made to it, and — when anything in Cribl
// changes — that the change is committed and deployed to the worker group. `actions.tsx` renders the spec
// into Capra's `Modal.confirm`.
//
// A spec builder returns null when the lever would change nothing (already in that state, nothing applied,
// no endpoint takes the weekly receipt): the console then says so instead of asking.

import type { DemoState } from '../../core/types.ts';
import { DEFAULT_MEASURED_LAG_SEC } from '../../core/demo/levers.ts';
import { PACK_ROUTE_KEYS, rigSource, rigSourcesUsingPipeline } from '../../core/demo/rig-ids.ts';
import { t, tn, type CopyKey } from '../copy/en.ts';
import { formatClock } from '../lib/format.ts';
import type { DemoJob } from './client.ts';
import { SCENES, TRIM_PIPELINE, sceneScript, type PackRouteKey, type PersistedScene, type SceneName } from './scenes.ts';

export interface ConfirmItem {
  /** What it is, in plain words: "Pipeline Payments API sampling". */
  label: string;
  /** Its id, shown in code style: "mrd_pay_sample". */
  id?: string;
  /** The change: "disable the [mr-trim] function". */
  action: string;
}

export interface ConfirmSpec {
  title: string;
  body: string;
  items: ConfirmItem[];
  /** The worker group the change is committed and deployed to; absent when nothing in Cribl changes. */
  deployGroup?: string;
  /** One more line under the list (the expected alert, "cannot be undone"). */
  note?: string;
  /** Danger styling for the confirm button (Break the trim, scenes that break it). */
  tone: 'default' | 'danger';
  confirmText: string;
}

export interface ConfirmContext {
  /** demo/state as the store holds it. */
  demoState: DemoState | null;
  /** Enabled endpoints with the weekly receipt on. */
  weeklyEndpoints: readonly { id: string; name: string }[];
  /** Worker group the rig lives in (the levers commit and deploy there). */
  groupId: string;
}

const streamName = (key: PackRouteKey): string => t(`demo.stream.${key}` as CopyKey);
const packName = (key: PackRouteKey): string => t(`demo.packName.${key}` as CopyKey);

/** The id a lever is given for a rig stream's route (the live rig names each route after its Source). */
export const routeIdOf = (key: PackRouteKey): string => rigSource(key)?.inputId ?? key;

/** "Payments API sampling" for the stage trim; otherwise the Source the pipeline trims, else its id. */
export function pipelineName(pipelineId: string): string {
  if (pipelineId === TRIM_PIPELINE) return t('demo.trimTarget');
  return rigSourcesUsingPipeline(pipelineId).find((s) => s.trimPipelineId === pipelineId)?.label ?? pipelineId;
}

const sourceName = (inputId: string): string => rigSource(inputId)?.label ?? inputId;

/** The expected alert after a break: the measured lag (demo/state.measuredLagSec), else the 4-minute estimate. */
export function alertEta(demo: DemoState | null): { sec: number; eta: string; measured: boolean } {
  const stored = demo?.measuredLagSec;
  const measured = typeof stored === 'number' && Number.isFinite(stored) && stored > 0 && stored !== DEFAULT_MEASURED_LAG_SEC;
  const sec = measured ? Math.round(stored) : DEFAULT_MEASURED_LAG_SEC;
  return { sec, eta: formatClock(sec), measured };
}

export const lagBasis = (measured: boolean): string => (measured ? t('demo.lagMeasured') : t('demo.lagEstimate'));

// ─── Items ───────────────────────────────────────────────────────────────────
/** The applied entry for a stream in demo/state.routes (keyed by route id, either spelling). */
function appliedRoute(demo: DemoState | null, key: PackRouteKey): { routeId: string; level: 'pack' | 'aggressive'; previous: string } | undefined {
  for (const [routeId, entry] of Object.entries(demo?.routes ?? {})) {
    if (rigSource(routeId)?.key !== key) continue;
    return { routeId, level: entry.level === 'aggressive' ? 'aggressive' : 'pack', previous: entry.previousPipelineId || rigSource(key)!.pipelineId };
  }
  return undefined;
}

/** The pipeline a stream's route runs at `level`. */
function pipelineAt(key: PackRouteKey, level: 'raw' | 'pack' | 'aggressive', previous?: string): string {
  const src = rigSource(key)!;
  if (level === 'aggressive') return src.aggressivePipelineId ?? src.packPipelineId ?? src.pipelineId;
  if (level === 'pack') return src.packPipelineId ?? src.pipelineId;
  return previous ?? src.pipelineId;
}

const routeItem = (key: PackRouteKey, routeId: string, action: string): ConfirmItem => ({
  label: t('demo.confirm.route', { stream: streamName(key) }),
  id: routeId,
  action,
});

const pipeChange = (from: string, to: string): string => t('demo.confirm.pipelineChange', { from, to });

const trimItem = (pipelineId: string, action: string): ConfirmItem => ({
  label: t('demo.breakAffects', { pipeline: pipelineName(pipelineId) }),
  id: pipelineId,
  action,
});

const sourceItem = (inputId: string, action: string): ConfirmItem => ({
  label: t('demo.rateAffects', { source: sourceName(inputId) }),
  id: inputId,
  action,
});

const rateChange = (from: number, to: number): string => t('demo.confirm.rateChange', { from: String(from), to: String(to) });

/** What "Reset everything" changes, from demo/state (core resetAll): the config part and the App-store part. */
function resetItems(demo: DemoState | null): { config: ConfirmItem[]; store: ConfirmItem[] } {
  const config: ConfirmItem[] = [];
  for (const pipelineId of Object.keys(demo?.trim ?? {})) config.push(trimItem(pipelineId, t('demo.confirm.restoreAction')));
  for (const [inputId, rate] of Object.entries(demo?.rates ?? {})) config.push(sourceItem(inputId, rateChange(rate.multiplier, 1)));
  const store: ConfirmItem[] = [];
  for (const outputId of Object.keys(demo?.budgetsOverride ?? {}))
    store.push({ label: t('demo.confirm.budget', { output: outputId }), id: outputId, action: t('demo.confirm.budgetAction') });
  store.push({ label: t('demo.confirm.alerts'), action: t('demo.confirm.alertsAction') });
  if (demo?.scene) store.push({ label: t('demo.confirm.scene'), action: t('demo.confirm.sceneAction') });
  return { config, store };
}

const withGroup = (spec: Omit<ConfirmSpec, 'deployGroup'>, deploys: boolean, groupId: string): ConfirmSpec =>
  deploys ? { ...spec, deployGroup: groupId } : spec;

// ─── Levers ──────────────────────────────────────────────────────────────────
/** The confirmation for a lever job, or null when it would change nothing. */
export function confirmSpecForJob(job: DemoJob, ctx: ConfirmContext): ConfirmSpec | null {
  const demo = ctx.demoState;
  const g = ctx.groupId;
  switch (job.kind) {
    case 'applyPack': {
      const applied = appliedRoute(demo, job.routeKey);
      const from = applied ? pipelineAt(job.routeKey, applied.level) : pipelineAt(job.routeKey, 'raw');
      const to = pipelineAt(job.routeKey, job.level);
      if (from === to) return null;
      const stream = streamName(job.routeKey);
      const aggressive = job.level === 'aggressive';
      return withGroup(
        {
          title: aggressive ? t('demo.confirm.aggressiveTitle', { stream }) : t('demo.confirm.applyTitle', { pack: packName(job.routeKey), stream }),
          body: aggressive ? t('demo.confirm.aggressiveBody') : t('demo.confirm.applyBody'),
          items: [routeItem(job.routeKey, applied?.routeId ?? routeIdOf(job.routeKey), pipeChange(from, to))],
          tone: 'default',
          confirmText: aggressive ? t('demo.confirm.aggressiveConfirm') : t('demo.confirm.applyConfirm'),
        },
        true,
        g,
      );
    }
    case 'revertPack': {
      const applied = appliedRoute(demo, job.routeKey);
      if (!applied) return null;
      return withGroup(
        {
          title: t('demo.confirm.revertTitle', { stream: streamName(job.routeKey) }),
          body: t('demo.confirm.revertBody'),
          items: [routeItem(job.routeKey, applied.routeId, pipeChange(pipelineAt(job.routeKey, applied.level), applied.previous))],
          tone: 'default',
          confirmText: t('demo.confirm.revertConfirm'),
        },
        true,
        g,
      );
    }
    case 'revertAll': {
      const items: ConfirmItem[] = [];
      for (const key of PACK_ROUTE_KEYS) {
        const applied = appliedRoute(demo, key);
        if (applied) items.push(routeItem(key, applied.routeId, pipeChange(pipelineAt(key, applied.level), applied.previous)));
      }
      if (items.length === 0) return null;
      return withGroup(
        {
          title: t('demo.confirm.revertAllTitle'),
          body: t('demo.confirm.revertBody'),
          items,
          tone: 'default',
          confirmText: t('demo.confirm.revertAllConfirm'),
        },
        true,
        g,
      );
    }
    case 'breakTrim': {
      if (demo?.trim?.[job.pipelineId]) return null;
      const lag = alertEta(demo);
      return withGroup(
        {
          title: t('demo.breakTitle', { pipeline: pipelineName(job.pipelineId) }),
          body: t('demo.breakBody'),
          items: [trimItem(job.pipelineId, t('demo.breakAction'))],
          note: t('demo.confirm.breakNote', { eta: lag.eta, basis: lagBasis(lag.measured) }),
          tone: 'danger',
          confirmText: t('demo.breakConfirm'),
        },
        true,
        g,
      );
    }
    case 'restoreTrim': {
      // Same targets as the client: the named trim, else every broken one, else the stage trim.
      const broken = Object.keys(demo?.trim ?? {});
      const targets = job.pipelineId ? [job.pipelineId] : broken.length > 0 ? broken : [TRIM_PIPELINE];
      if (demo && !targets.some((id) => demo.trim?.[id])) return null;
      return withGroup(
        {
          title: t('demo.confirm.restoreTitle', { pipeline: pipelineName(targets[0]!) }),
          body: t('demo.confirm.restoreBody'),
          items: targets.map((id) => trimItem(id, t('demo.confirm.restoreAction'))),
          tone: 'default',
          confirmText: t('demo.confirm.restoreConfirm'),
        },
        true,
        g,
      );
    }
    case 'setRate': {
      const current = demo?.rates?.[job.inputId]?.multiplier ?? 1;
      if (current === job.multiplier) return null;
      const source = sourceName(job.inputId);
      const up = job.multiplier > 1;
      return withGroup(
        {
          title: up ? t('demo.confirm.spikeTitle', { source, multiplier: String(job.multiplier) }) : t('demo.confirm.calmTitle', { source }),
          body: up ? t('demo.confirm.spikeBody') : t('demo.confirm.calmBody'),
          items: [sourceItem(job.inputId, rateChange(current, job.multiplier))],
          tone: 'default',
          confirmText: up ? t('demo.confirm.spikeConfirm', { multiplier: String(job.multiplier) }) : t('demo.confirm.calmConfirm'),
        },
        true,
        g,
      );
    }
    case 'resetAll': {
      const { config, store } = resetItems(demo);
      return withGroup(
        {
          title: t('demo.confirm.resetTitle'),
          body: t('demo.confirm.resetBody'),
          items: [...config, ...store],
          tone: 'default',
          confirmText: t('demo.confirm.resetConfirm'),
        },
        config.length > 0,
        g,
      );
    }
    case 'resetBaselines':
      return {
        title: t('demo.confirm.baselinesTitle'),
        body: t('demo.confirm.baselinesBody'),
        items: [{ label: t('demo.confirm.baselines'), id: 'baselines', action: t('demo.confirm.baselinesAction') }],
        note: t('confirm.cannotUndo'),
        tone: 'default',
        confirmText: t('demo.confirm.baselinesConfirm'),
      };
    case 'weekly': {
      if (ctx.weeklyEndpoints.length === 0) return null;
      return {
        title: t('demo.confirm.weeklyTitle'),
        body: t('demo.confirm.weeklyBody'),
        items: ctx.weeklyEndpoints.map((e) => ({ label: t('demo.confirm.endpoint', { name: e.name }), action: t('demo.confirm.weeklyAction') })),
        tone: 'default',
        confirmText: t('demo.confirm.weeklyConfirm'),
      };
    }
  }
}

// ─── Scenes ──────────────────────────────────────────────────────────────────
/** Everything a scene will change, one row per object, read off its script. */
export function sceneItems(name: SceneName, routeKey: PackRouteKey | undefined, ctx: ConfirmContext): ConfirmItem[] {
  const items: ConfirmItem[] = [];
  const seen = new Set<string>();
  const once = (key: string, item: () => ConfirmItem | ConfirmItem[]) => {
    if (seen.has(key)) return;
    seen.add(key);
    const out = item();
    items.push(...(Array.isArray(out) ? out : [out]));
  };
  for (const step of sceneScript(name, routeKey)) {
    if (step.kind === 'receipt') {
      once('receipt', () =>
        ctx.weeklyEndpoints.map((e) => ({ label: t('demo.confirm.endpoint', { name: e.name }), action: t('demo.confirm.sceneReceipt') })),
      );
      continue;
    }
    if (step.kind !== 'lever') continue;
    const call = step.call;
    switch (call.kind) {
      case 'applyPack':
        once(`route:${call.routeKey}`, () =>
          routeItem(
            call.routeKey,
            routeIdOf(call.routeKey),
            t('demo.confirm.sceneRoute', { from: pipelineAt(call.routeKey, 'raw'), to: pipelineAt(call.routeKey, call.level) }),
          ),
        );
        break;
      case 'breakTrim':
        once(`trim:${call.pipelineId}`, () => trimItem(call.pipelineId, t('demo.confirm.sceneTrim')));
        break;
      case 'setRate':
        if (call.multiplier > 1)
          once(`rate:${call.inputId}`, () => sourceItem(call.inputId, t('demo.confirm.sceneRate', { to: String(call.multiplier) })));
        break;
      default:
        break;
    }
  }
  return items;
}

/** The confirmation for starting a scene. */
export function confirmSpecForScene(name: SceneName, routeKey: PackRouteKey | undefined, ctx: ConfirmContext): ConfirmSpec {
  const script = sceneScript(name, routeKey);
  const breaks = script.some((s) => s.kind === 'lever' && s.call.kind === 'breakTrim');
  const items = sceneItems(name, routeKey, ctx);
  const spec: ConfirmSpec = {
    title: t('demo.confirm.sceneTitle', { scene: t(`demo.scene.${name}.title` as CopyKey) }),
    body: tn('demo.confirm.sceneBody', SCENES[name].approxMinutes, { steps: t(`demo.scene.${name}.body` as CopyKey) }),
    items,
    deployGroup: ctx.groupId,
    tone: breaks ? 'danger' : 'default',
    confirmText: t('demo.confirm.sceneConfirm'),
  };
  if (breaks) {
    const lag = alertEta(ctx.demoState);
    spec.note = t('demo.confirm.breakNote', { eta: lag.eta, basis: lagBasis(lag.measured) });
  }
  return spec;
}

// ─── A scene left behind ─────────────────────────────────────────────────────
/**
 * What "Abandon and restore" (scene runner `abort`) undoes: the packs the scene applied, then — when it broke
 * a trim or changed a rate — Reset everything, which restores every broken trim and rate in demo/state.
 */
export function abandonItems(scene: PersistedScene, ctx: ConfirmContext): { items: ConfirmItem[]; deployGroup?: string } {
  const items: ConfirmItem[] = [];
  let deploys = false;
  for (const key of [...(scene.changed.routes ?? [])].reverse()) {
    if (!(PACK_ROUTE_KEYS as readonly string[]).includes(key)) continue;
    const routeKey = key as PackRouteKey;
    const applied = appliedRoute(ctx.demoState, routeKey);
    const from = applied ? pipelineAt(routeKey, applied.level) : pipelineAt(routeKey, 'pack');
    items.push(routeItem(routeKey, applied?.routeId ?? routeIdOf(routeKey), pipeChange(from, applied?.previous ?? pipelineAt(routeKey, 'raw'))));
    deploys = true;
  }
  const resets = scene.changed.trims.length > 0 || scene.changed.rates.length > 0 || scene.changed.budgets.length > 0;
  if (resets) {
    // Reset everything works from demo/state; fall back to the scene's own record when the store has none.
    const demo: DemoState | null = ctx.demoState ?? null;
    const fromScene: ConfirmItem[] = [
      ...scene.changed.trims.map((id) => trimItem(id, t('demo.confirm.restoreAction'))),
      ...scene.changed.rates.map((id) => sourceItem(id, t('demo.confirm.rateBack'))),
    ];
    const { config } = resetItems(demo);
    const list = config.length > 0 ? config : fromScene;
    items.push(...list);
    if (list.length > 0) deploys = true;
  }
  return deploys ? { items, deployGroup: ctx.groupId } : { items };
}
