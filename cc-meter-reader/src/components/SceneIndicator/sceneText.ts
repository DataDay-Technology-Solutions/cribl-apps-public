// src/components/SceneIndicator/sceneText.ts — the indicator sentence (demo build only; copy is demo-gated).

import type { DemoState } from '../../../core/types.ts';
import { fmtDuration } from '../../../core/format.ts';
import { humanize } from '../../../core/humanize.ts';
import { t, type CopyKey } from '../../copy/en.ts';
import { currentStep, parseSceneName } from '../../demo/scenes.ts';

export type Scene = NonNullable<DemoState['scene']>;

const SCENE_KEYS: Record<string, CopyKey> = {
  savings: 'scene.names.savings',
  regression: 'scene.names.regression',
  spike: 'scene.names.spike',
  budget: 'scene.names.budget',
  receipt: 'scene.names.receipt',
  full: 'scene.names.full',
};

/**
 * The indicator sentence for a scene at `nowMs`. The alert countdown only while the scene waits for that alert
 * (`expectedAlertAt` stays on the record after it lands: "alert due any moment" during the hold would be
 * false); otherwise the step in words ("Savings scene · Waiting for the ribbon to narrow"), never its id
 * ("1:wait"). A step id in an older format keeps the countdown or the humanized id.
 */
export function sceneText(scene: Scene, nowMs: number): string {
  const parsed = parseSceneName(scene.name);
  const key = SCENE_KEYS[parsed?.name ?? scene.name];
  const name = key ? t(key) : parsed ? t(`demo.scene.${parsed.name}.title` as CopyKey) : humanize(scene.name);
  const step = /^\d+:/.test(String(scene.step)) && parsed ? currentStep(scene) : undefined;
  const expected = scene.expectedAlertAt ? Date.parse(scene.expectedAlertAt) : Number.NaN;
  const waitsForAlert = step?.kind === 'wait' && step.until.kind === 'alert';
  if (Number.isFinite(expected) && (waitsForAlert || !step)) {
    const left = (expected - nowMs) / 1000;
    return left > 0 ? t('scene.indicator', { scene: name, eta: fmtDuration(left) }) : t('scene.indicatorDue', { scene: name });
  }
  if (step) return t('scene.indicatorNoEta', { scene: name, step: t(`demo.step.${step.label}` as CopyKey) });
  return t('scene.indicatorNoEta', { scene: name, step: humanize(scene.step) });
}
