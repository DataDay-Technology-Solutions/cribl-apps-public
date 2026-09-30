// r1 ui-11, FOUNDER_PLAN row 11: the tour's regression beat lands the takeover card (src/tour/status.ts) beside its
// toast. Closing that toast by hand closes the card too; the toast timing out by itself leaves the card to its own 45 s.
// A spike (70 s) is a toast only. Silent (seek) beats land nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToastOptions } from '@capra/core';
import doc from '../../demo/sample/tour.json';
import type { Incident } from '../../core/types.ts';
import type { AppStore } from '../../src/state/store.ts';
import type { TourEngine } from '../../src/tour/engine.ts';
import type { TourEvent, TourFixture } from '../../src/tour/types.ts';

const shown: { kind: string; options?: ToastOptions }[] = [];
vi.mock('../../src/components/common/notify.tsx', () => {
  const push = (kind: string) => (_content: unknown, options?: ToastOptions) => {
    shown.push({ kind, options });
    return String(shown.length);
  };
  const kinds = { warning: push('warning'), success: push('success'), info: push('info'), error: push('error') };
  // r2 ui-6: the tour's toasts are tagged (notify.tagged), so any tour exit closes them (notify.clearTag).
  return { notify: { ...kinds, tagged: () => kinds, clearTag: () => undefined } };
});

const { narrate } = await import('../../src/tour/narration.ts');
const status = await import('../../src/tour/status.ts');

const TOUR = doc as unknown as TourFixture;
const regression = TOUR.script.find((s) => s.action === 'incident.open' && (s.payload as Incident).type === 'regression')!.payload as Incident;
const spike = TOUR.script.find((s) => s.action === 'incident.open' && (s.payload as Incident).type !== 'regression')!.payload as Incident;

const store = { getState: () => ({ settings: TOUR.settings, snapshot: TOUR.snapshot }) } as unknown as AppStore;
const ctx = { store, engine: {} as TourEngine };
const open = (payload: Incident, silent = false): TourEvent => ({ step: { at: 25, action: 'incident.open', payload }, payload, silent, iteration: 0 });

describe('the tour takeover card (row 11)', () => {
  beforeEach(() => {
    shown.length = 0;
    status.resetTourBeat();
    vi.useFakeTimers({ now: Date.parse('2026-09-28T15:00:25Z') });
  });
  afterEach(() => vi.useRealTimers());

  it('the regression beat lands the card, with its toast', () => {
    narrate(open(regression), ctx);
    expect(status.getTourTakeover()).toEqual({ incidentId: regression.id, landedAt: Date.now() });
    expect(shown.map((s) => s.kind)).toEqual(['warning']);
  });

  it('closing the toast by hand closes the card; its timing out does not', () => {
    narrate(open(regression), ctx);
    vi.advanceTimersByTime(3_000);
    shown[0].options!.onClose!();
    expect(status.getTourTakeover()).toBeNull();

    status.resetTourBeat();
    shown.length = 0;
    narrate(open(regression), ctx);
    vi.advanceTimersByTime(9_000); // the toast's own 9 s
    shown[0].options!.onClose!();
    expect(status.getTourTakeover()?.incidentId).toBe(regression.id);
  });

  it('a spike is a toast only, and a silent (seek) beat lands nothing', () => {
    narrate(open(spike), ctx);
    expect(status.getTourTakeover()).toBeNull();
    expect(shown).toHaveLength(1);
    narrate(open(regression, true), ctx);
    expect(status.getTourTakeover()).toBeNull();
  });

  it('dismissing names the incident it means; a stale id leaves a newer card alone', () => {
    status.showTourTakeover('a', 1);
    status.dismissTourTakeover('b');
    expect(status.getTourTakeover()?.incidentId).toBe('a');
    status.dismissTourTakeover('a');
    expect(status.getTourTakeover()).toBeNull();
    status.showTourTakeover('a', 2);
    status.dismissTourTakeover();
    expect(status.getTourTakeover()).toBeNull();
  });

  it('listeners hear it land and go; resetTourBeat clears it', () => {
    const heard = vi.fn();
    const off = status.subscribeTourTakeover(heard);
    status.showTourTakeover('a', 1);
    status.resetTourBeat();
    off();
    status.showTourTakeover('a', 3);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(status.TOUR_TAKEOVER_MS).toBe(45_000);
  });
});
