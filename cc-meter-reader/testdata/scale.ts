// testdata/scale.ts — the large synthetic estate for performance and scale tests.
//
// PRD 12 items 1 and 3, SPEC 16 "Performance": `runSweep()` against 2,000 flows, the Ledger at 2,000
// rows, detector tests over 30 days. Everything is built lazily from `syntheticWorld()` (gen.ts):
// a 2,000-flow × 30-day estate is ~86 M flow-minutes, so nothing here materializes a series — callers
// ask for the windows they need and the generator computes them on demand.

import {
  DAY_MS,
  GB,
  MINUTE_MS,
  ceilMinute,
  flowMinute,
  syntheticWorld,
  type Anomaly,
  type SyntheticOptions,
  type World,
} from './gen.ts';

/** The scale the PRD gates on: 2,000 flows over 30 days, across three worker groups. */
export const SCALE_DEFAULTS = {
  seed: 2026,
  flows: 2000,
  groups: 3,
  days: 30,
  hostsPerGroup: 3,
  processesPerHost: 4,
} as const satisfies SyntheticOptions;

/** The 2,000-flow estate (override any option, e.g. `{ flows: 500 }` for a quicker variant). */
export function scaleWorld(overrides: SyntheticOptions = {}): World {
  return syntheticWorld({ ...SCALE_DEFAULTS, ...overrides });
}

export interface EstateSummary {
  flows: number;
  groups: number;
  inputs: number;
  outputs: number;
  pipelines: number;
  routes: number;
  commits: number;
  anomalies: Record<Anomaly['kind'], number>;
  /** nominal source volume at multiplier 1, before shapes and weekends */
  nominalGbPerDay: number;
}

/** Counts and nominal volume, for test titles and the evidence report. */
export function estateSummary(world: World): EstateSummary {
  const count = (pick: (g: World['config'][string]) => unknown[]): number => Object.values(world.config).reduce((s, g) => s + pick(g).length, 0);
  const anomalies: Record<Anomaly['kind'], number> = { spike: 0, regression: 0, outage: 0 };
  for (const a of world.anomalies) anomalies[a.kind]++;
  return {
    flows: world.flows.length,
    groups: world.groups.length,
    inputs: count((g) => g.inputs),
    outputs: count((g) => g.outputs),
    pipelines: count((g) => g.pipelines),
    routes: count((g) => g.routes.routes),
    commits: world.commits.length,
    anomalies,
    nominalGbPerDay: Math.round(world.flows.reduce((s, f) => s + f.bytesPerDay, 0) / GB),
  };
}

export interface AnomalyWindow {
  anomaly: Anomaly;
  /** a window that opens before the anomaly (baseline) and closes after it (or after `tailMin`) */
  windowStart: number;
  windowEnd: number;
}

/**
 * Windows around every injected anomaly: `leadMin` minutes of baseline before it and `tailMin`
 * minutes after its end (or after its start when it never recovers). Detector tests replay these.
 */
export function anomalyWindows(world: World, leadMin = 60, tailMin = 30): AnomalyWindow[] {
  return world.anomalies.map((anomaly) => ({
    anomaly,
    windowStart: anomaly.start - leadMin * MINUTE_MS,
    windowEnd: (anomaly.end ?? anomaly.start) + tailMin * MINUTE_MS,
  }));
}

/**
 * Minute starts in [start, end), ascending — the sweep cadence. A generator, so a 30-day walk costs
 * nothing until iterated.
 */
export function* minutes(start: number, end: number): Generator<number> {
  for (let t = ceilMinute(start); t < end; t += MINUTE_MS) yield t;
}

/**
 * Total source bytes per UTC day for the whole estate, computed by sampling every `strideMin`-th
 * minute and scaling (exact when strideMin = 1). Cheap sanity numbers for 30-day scale tests.
 */
export function dailyVolume(world: World, day: number, strideMin = 15): { bytes: number; sampledMinutes: number } {
  const start = Math.floor(day / DAY_MS) * DAY_MS;
  let bytes = 0;
  let sampled = 0;
  for (let t = start; t < start + DAY_MS; t += strideMin * MINUTE_MS) {
    sampled++;
    for (const flow of world.flows) {
      const m = flowMinute(world, flow, t);
      if (m.present) bytes += m.srcB;
    }
  }
  return { bytes: Math.round(bytes * strideMin), sampledMinutes: sampled };
}
