// src/views/Demo/useIncidentCue.ts — the phone remote's cue when an alert lands (EPIC_AUDIT P2-W18): one
// short vibration (navigator.vibrate([40, 60, 40]), where the device has it) and a 1.2 s flash of the pinned
// status line, so the person holding the remote feels the moment the room sees the red card.
//
// Once per incident, and only for incidents that open while the console is on screen: whatever is already
// open when the first snapshot arrives is old news (a console opened mid-incident must not buzz). One cue,
// never a loop (DESIGN_BRIEF 4: nothing pulses for attention); reduced motion keeps the flash static
// (DemoConsole.css).

import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../core/types.ts';
import { newlyOpenedIncidents } from '../../demo/derive.ts';

export const CUE_FLASH_MS = 1_200;
export const CUE_VIBRATION: readonly number[] = [40, 60, 40];

/** Vibrates where the platform allows it (never throws: iOS Safari has no vibrate, some frames refuse it). */
export function vibrate(pattern: readonly number[] = CUE_VIBRATION): boolean {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
    return navigator.vibrate([...pattern]);
  } catch {
    return false;
  }
}

/** True for CUE_FLASH_MS after an incident opens while mounted; buzzes once per new incident. */
export function useIncidentCue(snapshot: Snapshot | null): boolean {
  const seen = useRef<Set<string> | null>(null);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (!snapshot) return;
    if (seen.current === null) {
      // The first snapshot this console sees: everything open in it was open before we arrived.
      seen.current = new Set(snapshot.incidents.filter((i) => !i.closedAt).map((i) => i.id));
      return;
    }
    const fresh = newlyOpenedIncidents(seen.current, snapshot);
    if (fresh.length === 0) return;
    for (const incident of fresh) seen.current.add(incident.id);
    vibrate();
    setFlashing(true);
  }, [snapshot]);

  useEffect(() => {
    if (!flashing) return;
    const timer = window.setTimeout(() => setFlashing(false), CUE_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashing]);

  return flashing;
}
