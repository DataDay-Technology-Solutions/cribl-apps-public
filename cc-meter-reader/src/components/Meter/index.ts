// src/components/Meter — the ticking hero number and its pure arithmetic (reused by the Presenter view).
export { Meter, type MeterProps, type MeterSize } from './Meter.tsx';
export {
  ARIA_THROTTLE_MS,
  DEFAULT_MAX_EXTRAPOLATION_SEC,
  EASE_MS,
  ROLL_DOWN_THRESHOLD_M,
  beginMotion,
  displayAt,
  jumpMotion,
  targetAt,
  wheelPosition,
  type MeterAnchor,
  type MeterMotion,
} from './meterMath.ts';
