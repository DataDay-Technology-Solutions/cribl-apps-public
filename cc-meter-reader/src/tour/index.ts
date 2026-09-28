// src/tour — the tour engine (SPEC 15) and the app's "Tour with sample data" (PRD 8.5). Story mode reuses
// `createTourEngine` with its own fixture and `loop: true`.
export { createTourEngine, applyStepToSnapshot, markFlowStates, metaForSnapshot, weeklyReceiptAt, withCommit, withDelivery, withIncident } from './engine.ts';
export type { TourEngine, TourEngineOptions } from './engine.ts';
export { planRebase, rebaseString, rebaseValue, type RebasePlan } from './rebase.ts';
export { firstRunGate, isWorkspacePriced, liveDocs, pathAfterTour, type FirstRunGate } from './selectors.ts';
export { getActiveTour, startSampleTour, stopSampleTour, subscribeTour, useActiveTour, type StartTourOptions } from './controller.ts';
export type { TourCaption, TourEvent, TourFixture, TourPhase, TourStatus, TourStopReason, TourWorkspaceFacts } from './types.ts';
export { SAMPLE_WORKSPACE } from './workspace.ts';
