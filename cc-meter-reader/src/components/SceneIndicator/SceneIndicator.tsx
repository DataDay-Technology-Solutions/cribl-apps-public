// src/components/SceneIndicator/SceneIndicator.tsx — "Regression scene · alert expected in ~1:30" in the
// presenter's bottom-left corner while a Demo Console scene runs (PRD 8.7 "Presenter sync"), so the audience
// sees anticipation, not dead air. Secondary text, no motion beyond the countdown digits. An abandoned scene
// (no step for 30 minutes, src/demo/scenes.ts) shows nothing.
//
// DEMO BUILD ONLY. Render it behind an inline `import.meta.env.VITE_MR_BUILD === 'demo'` test at the call
// site so the release bundle drops it (its copy is demo-gated in en.ts, and its styles live in the
// Presenter stylesheet, because a CSS import here would be a side effect the bundler keeps).

import { Play } from '@capra/icons';
import type { DemoState } from '../../../core/types.ts';
import { t } from '../../copy/en.ts';
import { isSceneAbandoned } from '../../demo/scenes.ts';
import { useNow } from '../../lib/ticker.ts';
import { useAppState } from '../../state/react.tsx';
import { sceneText } from './sceneText.ts';

type Scene = NonNullable<DemoState['scene']>;

export interface SceneIndicatorProps {
  /** Override the store's demo scene (tests, Story). */
  scene?: Scene | null;
  nowMs?: number;
}

export function SceneIndicator(props: SceneIndicatorProps) {
  const stored = useAppState((s) => s.demoState?.scene ?? null);
  const tick = useNow();
  const scene = props.scene === undefined ? stored : props.scene;
  const nowMs = props.nowMs ?? tick;
  // A scene nobody has moved for 30 minutes was left behind (REVIEW-3a #8): the Demo Console offers to
  // restore or dismiss it, and the stage never announces it as running.
  if (!scene || isSceneAbandoned(scene, nowMs)) return null;
  const text = sceneText(scene, nowMs);
  return (
    <p className="mr-scene" role="status" aria-label={t('scene.label')}>
      <Play size="sm" aria-hidden="true" />
      <span className="mr-scene-text">{text}</span>
    </p>
  );
}
