// @vitest-environment jsdom
// The presenter's scene indicator (demo build): a running scene is announced; a scene nobody has moved for
// 30 minutes (REVIEW-3a #8, src/demo/scenes.ts isSceneAbandoned) is not, whether it comes from the store or
// from props.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { DemoState } from '../../core/types.ts';
import { SCENE_ABANDON_MS } from '../../src/demo/scenes.ts';

type Scene = NonNullable<DemoState['scene']>;

const NOW = Date.parse('2026-09-30T16:40:00.000Z');
const scene = (startedAgoMs: number, over: Partial<Scene> = {}): Scene => ({
  name: 'regression',
  step: 'waiting-incident',
  startedAt: new Date(NOW - startedAgoMs).toISOString(),
  expectedAlertAt: new Date(NOW + 90_000).toISOString(),
  changed: { trims: [], rates: [], budgets: [], routes: [] },
  ...over,
});

async function renderIndicator(stored: Scene | null, props: { scene?: Scene | null; nowMs?: number } = {}) {
  // The demo-gated copy is read at import, so everything React-side is imported after the env stub (one
  // module graph: the provider and the component must share the store context).
  const { SceneIndicator } = await import('../../src/components/SceneIndicator/SceneIndicator.tsx');
  const { StoreProvider } = await import('../../src/state/providers.tsx');
  const { createAppStore } = await import('../../src/state/store.ts');
  const demoState = stored ? ({ schemaVersion: 1, scene: stored } as unknown as DemoState) : null;
  const store = createAppStore(defaultSettings('2026-09-01T00:00:00.000Z', 'UTC'), { demoState });
  return render(
    <StoreProvider store={store}>
      <SceneIndicator nowMs={NOW} {...props} />
    </StoreProvider>,
  );
}

describe('SceneIndicator', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_MR_BUILD', 'demo');
    vi.resetModules();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('announces a scene that is running', async () => {
    await renderIndicator(scene(60_000));
    expect(screen.getByRole('status').textContent).toBe('Regression scene · alert expected in ~1:30');
  });

  it('says the step in words, never its id, and counts down only while the scene waits for that alert', async () => {
    // Savings on a stream, waiting for the ribbon: the step in words, the stream-qualified name resolved.
    await renderIndicator(scene(60_000, { name: 'savings:pan_firewall', step: '1:wait', expectedAlertAt: undefined }));
    expect(screen.getByRole('status').textContent).toBe('Savings scene · Waiting for the ribbon to narrow');
    cleanup();
    // Regression waiting for its alert: the countdown.
    await renderIndicator(scene(60_000, { step: '1:wait' }));
    expect(screen.getByRole('status').textContent).toBe('Regression scene · alert expected in ~1:30');
    cleanup();
    // The alert landed and the scene holds: expectedAlertAt is still on the record, but nothing is "due".
    await renderIndicator(scene(60_000, { step: '2:hold', expectedAlertAt: new Date(NOW - 30_000).toISOString() }));
    expect(screen.getByRole('status').textContent).toBe('Regression scene · Holding');
    cleanup();
    await renderIndicator(scene(60_000, { name: 'savingsX3', step: '0:lever', expectedAlertAt: undefined }));
    expect(screen.getByRole('status').textContent).toBe('Savings ×3 scene · Applying the pack');
  });

  it('shows nothing for a stored scene left for 30 minutes', async () => {
    const { container } = await renderIndicator(scene(SCENE_ABANDON_MS, { expectedAlertAt: undefined }));
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('counts the last step, not the start: an old scene that just stepped still shows', async () => {
    await renderIndicator(scene(SCENE_ABANDON_MS * 2, { stepAt: new Date(NOW - 60_000).toISOString() }));
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('applies the same rule to a scene passed in props', async () => {
    const { container } = await renderIndicator(null, { scene: scene(SCENE_ABANDON_MS + 1) });
    expect(container.textContent).toBe('');
  });
});
