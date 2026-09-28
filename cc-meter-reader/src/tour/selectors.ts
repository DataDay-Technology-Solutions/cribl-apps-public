// src/tour/selectors.ts — the first-run gate (PRD 8.5): who sees the first-run card, and where the app
// goes when the tour ends.
//
// ONE gate for both routes (EPIC_AUDIT P1-D06): `/first-run` shows the card exactly when `/` would send the
// member there (src/state/selectors.ts `homeTarget` → `isFirstRunWorkspace`): no prices document and no
// snapshot, both known absent. It used to decide on its own ("no stored price above $0"), so after saving
// all-$0 prices `/` showed a $0 Receipt while `/first-run` still showed the onboarding card. Since D33 nothing
// meters before a prices document exists, so a saved document — even all $0 — is the line: the Receipt then
// says that nothing can count as saved (MeteringNotice). It is asked of the member's LIVE documents, and never
// while a tour or replay owns the screen.

import type { PricesDoc, Snapshot } from '../../core/types.ts';
import { isFirstRunWorkspace } from '../state/selectors.ts';
import type { AppState } from '../state/store.ts';

/** The member's own documents, whether or not sample data is on screen right now. */
export function liveDocs(state: AppState): { prices: PricesDoc | null; snapshot: Snapshot | null } {
  if (state.source === 'live' || !state.liveStash) return { prices: state.prices, snapshot: state.snapshot };
  return { prices: state.liveStash.prices, snapshot: state.liveStash.snapshot };
}

/**
 * True when the live workspace is past first run: it holds a prices document (even one pricing everything at
 * $0) or a snapshot, or one of them is unreadable (an error is not "empty": the Receipt shows it).
 */
export function isWorkspacePriced(state: AppState): boolean {
  const { prices, snapshot } = liveDocs(state);
  return !isFirstRunWorkspace(prices, snapshot, state.source === 'live' ? state.errors : {});
}

export type FirstRunGate = 'loading' | 'show' | 'priced' | 'tour';

/**
 * 'loading' until hydration answers; 'tour' while sample or replay data is on screen; 'priced' once the
 * live workspace is past first run (the Receipt is the landing then); else 'show'. A failed hydration
 * (settings unreadable) still shows the card: the tour works without KV, and Settings explains itself.
 */
export function firstRunGate(state: AppState): FirstRunGate {
  if (state.source !== 'live') return 'tour';
  const phase = state.status.hydrate.phase;
  if (!state.hasHydrated && (phase === 'idle' || phase === 'loading')) return 'loading';
  if (!state.hasHydrated) return 'show';
  return isWorkspacePriced(state) ? 'priced' : 'show';
}

/** Where to land after the sample data is cleared: first run again, or the member's live Receipt. */
export function pathAfterTour(state: AppState): '/first-run' | '/' {
  return isWorkspacePriced(state) ? '/' : '/first-run';
}
