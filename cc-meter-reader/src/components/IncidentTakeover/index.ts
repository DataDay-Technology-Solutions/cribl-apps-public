// src/components/IncidentTakeover — the presenter takeover (connected) and its card (presentational).
export { IncidentTakeover, type IncidentTakeoverProps } from './IncidentTakeover.tsx';
export { TakeoverCard, TAKEOVER_ENTER_MS, TAKEOVER_FADE_MS, type TakeoverCardProps } from './TakeoverCard.tsx';
export {
  MAX_QUEUE,
  TAKEOVER_MS,
  createTracker,
  enqueue,
  observeIncidents,
  type TakeoverEvent,
  type TakeoverMode,
  type TakeoverTracker,
} from './tracker.ts';
