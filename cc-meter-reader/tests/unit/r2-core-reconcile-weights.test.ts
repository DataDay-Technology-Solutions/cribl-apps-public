// tests/unit/r2-core-reconcile-weights.test.ts — founder-build r2 core-8: BO-2 (major) + BO-8 (minor), the destination
// reconciliation's weights (core/flows.ts reconcileWindow; AA/extra/fuzz FUZZ.md §1, §3, results/examples.json EX1/EX2,
// the harness's R3 and R3b properties).
//
// BO-2: `weights = outB > 0 ? outB : inB` gave a flow whose route series read 0 out (its pipeline dropped everything)
// a share of its destination by its bytes in: EX1's r_debug took 3.33 GB of SIEM's 5 GB ($10,800/day of phantom paid)
// and r_windows 1.67 GB. BO-8: an idle flow (0 in, 0 out) next to a passthrough sibling was handed the leftover by an
// even split (all weights 0). Now a present out series that reads 0 is a real 0; the fallback to bytes in stays only
// for a flow with no out series (QuickConnect / proportional, or a route the minute's series lack); the events weight
// follows the same rule; when every weight is 0 the leftover stays unattributed; an idle flow with no estimate is not
// in the split at all.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { attributeWindow, makeFlowKey } from "../../core/flows.ts";
import { priceMinute } from "../../core/pricing.ts";
import { fmtDollars } from "../../core/format.ts";
import type {
  Attribution,
  ByteEvent,
  Flow,
  MetricsWindow,
} from "../../core/types.ts";

const PRICE = 225_000; // $2.25/GB
const perDay = (m: number) => fmtDollars(m * 1440);
const flow = (
  inputId: string,
  routeId: string,
  pipelineId: string,
  outputId = "siem",
  attribution: Attribution = "route",
): Flow => ({
  key: makeFlowKey("default", inputId, routeId, pipelineId, outputId),
  groupId: "default",
  inputId,
  routeId,
  pipelineId,
  outputId,
  attribution,
});
const W = {
  windowStart: "2026-09-27T15:32:00.000Z",
  windowEnd: "2026-09-27T15:33:00.000Z",
};

describe("r2 core-8 · BO-2: a present out series that reads 0 is a real 0", () => {
  it("EX1: r_debug (10 GB in, 0 B out) gets 0 B; r_windows gets SIEM’s whole 5 GB", () => {
    const a = flow("win", "r_windows", "win_trim");
    const b = flow("fw", "r_debug", "drop_debug");
    const metrics: MetricsWindow = {
      ...W,
      inputs: {
        "default:syslog:win": { bytes: 10e9, events: 1_000_000 },
        "default:syslog:fw": { bytes: 10e9, events: 1_000_000 },
      },
      outputs: { "default:siem": { bytes: 5e9, events: 500_000 } },
      routesIn: {
        "default:r_windows": { bytes: 10e9, events: 1_000_000 },
        "default:r_debug": { bytes: 10e9, events: 1_000_000 },
      },
      routesOut: {
        "default:r_windows": { bytes: 5e9, events: 500_000 },
        "default:r_debug": { bytes: 0, events: 0 },
      },
      has: { routeBytes: true, pipelineBytes: false },
    };
    const w = attributeWindow([a, b], metrics);
    expect(w[a.key]).toMatchObject({
      outB: 5e9,
      outE: 500_000,
      attribution: "reconciled",
    });
    expect(w[b.key]).toMatchObject({ outB: 0, outE: 0 });
    const ma = priceMinute(
      { inB: w[a.key].inB, outB: w[a.key].outB },
      PRICE,
      PRICE,
      "same",
    );
    const mb = priceMinute(
      { inB: w[b.key].inB, outB: w[b.key].outB },
      PRICE,
      PRICE,
      "same",
    );
    expect([perDay(ma.paidM), perDay(ma.savedM)]).toEqual([
      "$16,200",
      "$16,200",
    ]);
    expect([perDay(mb.paidM), perDay(mb.savedM)]).toEqual(["$0", "$32,400"]);
  });

  it("pipeline mode: the same rule for a pipeline series that reads 0", () => {
    const a = flow("win", "r_windows", "win_trim");
    const b = flow("fw", "r_debug", "drop_debug");
    const metrics: MetricsWindow = {
      ...W,
      inputs: {
        "default:syslog:win": { bytes: 10e9, events: 1_000_000 },
        "default:syslog:fw": { bytes: 10e9, events: 1_000_000 },
      },
      outputs: { "default:siem": { bytes: 5e9, events: 500_000 } },
      pipelinesIn: {
        "default:win_trim": { bytes: 10e9, events: 1_000_000 },
        "default:drop_debug": { bytes: 10e9, events: 1_000_000 },
      },
      pipelinesOut: {
        "default:win_trim": { bytes: 5e9, events: 500_000 },
        "default:drop_debug": { bytes: 0, events: 0 },
      },
      has: { routeBytes: false, pipelineBytes: true },
    };
    const w = attributeWindow([a, b], metrics);
    expect(w[a.key].outB).toBe(5e9);
    expect(w[b.key].outB).toBe(0);
  });

  it("QuickConnect (no route, no out series): still weighted by its bytes in", () => {
    const r = flow("win", "r_windows", "win_trim");
    const qc = flow("qc", "-", "qc_pipe", "siem", "proportional");
    const metrics: MetricsWindow = {
      ...W,
      inputs: {
        "default:syslog:win": { bytes: 6e9, events: 600_000 },
        "default:syslog:qc": { bytes: 4e9, events: 400_000 },
      },
      outputs: { "default:siem": { bytes: 7e9, events: 700_000 } },
      routesIn: { "default:r_windows": { bytes: 6e9, events: 600_000 } },
      // The route estimate claims every byte the destination counted, so the QuickConnect flow's own estimate is 0 out.
      routesOut: { "default:r_windows": { bytes: 7e9, events: 700_000 } },
      has: { routeBytes: true, pipelineBytes: false },
    };
    const est = attributeWindow([r, qc], metrics, { reconcile: false });
    expect(est[qc.key].outB).toBe(0);
    const w = attributeWindow([r, qc], metrics);
    // 7 GB split by [7 GB estimate, 4 GB in]: the QuickConnect flow keeps its share.
    expect(w[qc.key].outB).toBe(Math.round((7e9 * 4) / 11));
    expect(w[r.key].outB + w[qc.key].outB).toBe(7e9);
    expect(w[qc.key].outE).toBeGreaterThan(0);
  });

  it("a route the minute’s out series lack (absent, not 0) falls back to its bytes in", () => {
    const a = flow("win", "r_windows", "win_trim");
    const b = flow("fw", "r_new", "fw_trim");
    const metrics: MetricsWindow = {
      ...W,
      inputs: {
        "default:syslog:win": { bytes: 10e9, events: 1_000_000 },
        "default:syslog:fw": { bytes: 10e9, events: 1_000_000 },
      },
      // No event count at the destination: the 0.5–2× byte band decides (D56's fallback).
      outputs: { "default:siem": { bytes: 10e9, events: 0 } },
      routesIn: {
        "default:r_windows": { bytes: 10e9, events: 1_000_000 },
        "default:r_new": { bytes: 10e9, events: 1_000_000 },
      },
      routesOut: { "default:r_windows": { bytes: 5e9, events: 500_000 } },
      has: { routeBytes: true, pipelineBytes: false },
    };
    const w = attributeWindow([a, b], metrics);
    expect(w[b.key].outB).toBe(Math.round((10e9 * 10) / 15));
    expect(w[a.key].outB + w[b.key].outB).toBe(10e9);
  });
});

describe("r2 core-8 · BO-8: an idle flow is never handed a sibling’s leftover", () => {
  it("EX2: r_fw (0 in, 0 out) next to a passthrough r_windows gets 0 B; the 16 MB of overhead stays unattributed", () => {
    const a = flow("win", "r_windows", "passthru");
    const b = flow("fw", "r_fw", "fw_trim");
    const metrics: MetricsWindow = {
      ...W,
      inputs: { "default:syslog:win": { bytes: 10e9, events: 1_000_000 } },
      outputs: { "default:siem": { bytes: 10.016e9, events: 1_000_000 } },
      routesIn: { "default:r_windows": { bytes: 10e9, events: 1_000_000 } },
      routesOut: {
        "default:r_windows": { bytes: 10.004e9, events: 1_000_000 },
      },
      has: { routeBytes: true, pipelineBytes: false },
    };
    const w = attributeWindow([a, b], metrics, {
      passthroughPipelines: new Set(["default:passthru"]),
    });
    expect(w[a.key]).toMatchObject({
      inB: 10e9,
      outB: 10e9,
      attribution: "reconciled",
    });
    expect(w[b.key]).toMatchObject({ inB: 0, outB: 0 });
    expect(w[b.key].attribution).not.toBe("reconciled");
    const mb = priceMinute(
      { inB: w[b.key].inB, outB: w[b.key].outB },
      PRICE,
      PRICE,
      "same",
    );
    expect(perDay(mb.paidM)).toBe("$0");
  });

  it("the minimal case: pinned 900 B (estimate 980), an idle sibling with a 0 series, 980 B measured → the idle flow gets 0 B", () => {
    const a = flow("win", "r_windows", "passthru");
    const b = flow("fw", "r_fw", "fw_trim");
    const metrics: MetricsWindow = {
      ...W,
      inputs: { "default:syslog:win": { bytes: 900, events: 9 } },
      outputs: { "default:siem": { bytes: 980, events: 9 } },
      routesIn: {
        "default:r_windows": { bytes: 900, events: 9 },
        "default:r_fw": { bytes: 0, events: 0 },
      },
      routesOut: {
        "default:r_windows": { bytes: 980, events: 9 },
        "default:r_fw": { bytes: 0, events: 0 },
      },
      has: { routeBytes: true, pipelineBytes: false },
    };
    const w = attributeWindow([a, b], metrics, {
      passthroughPipelines: new Set(["default:passthru"]),
    });
    expect(w[a.key].outB).toBe(900);
    expect(w[b.key].outB).toBe(0);
    expect(w[b.key].outE).toBe(0);
    // The control without the idle sibling leaves the same 80 B unattributed.
    const alone = attributeWindow([a], metrics, {
      passthroughPipelines: new Set(["default:passthru"]),
    });
    expect(alone[a.key].outB).toBe(900);
  });
});

// ─── The fuzz properties R3 and R3b (AA/extra/fuzz/harness/flows.fuzz.test.ts), fixed seed ──────────────────────────
interface Topo {
  flows: Flow[];
  passthrough: Set<string>;
  metrics: MetricsWindow;
  truthOut: Record<string, number>;
}
const G = "g";
const topoArb: fc.Arbitrary<Topo> = fc
  .record({
    nIn: fc.integer({ min: 1, max: 6 }),
    nRoute: fc.integer({ min: 1, max: 7 }),
    nPipe: fc.integer({ min: 1, max: 5 }),
    nOut: fc.integer({ min: 1, max: 4 }),
    passMask: fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }),
    routeMode: fc.boolean(),
    pipeMode: fc.boolean(),
    seedFlows: fc.array(
      fc.record({
        input: fc.integer({ min: -1, max: 5 }),
        route: fc.integer({ min: -1, max: 6 }),
        pipe: fc.integer({ min: 0, max: 4 }),
        out: fc.integer({ min: 0, max: 3 }),
        inB: fc.oneof(
          fc.constant(0),
          fc.integer({ min: 1, max: 1000 }),
          fc.integer({ min: 1000, max: 5e9 }),
        ),
        keep: fc.oneof(
          fc.constant(1),
          fc.constant(0),
          fc.double({ min: 0, max: 1.3, noNaN: true }),
        ),
        est: fc.oneof(
          fc.constant(1),
          fc.double({ min: 0.3, max: 1.1, noNaN: true }),
        ),
        evSize: fc.integer({ min: 50, max: 3000 }),
      }),
      { minLength: 1, maxLength: 14 },
    ),
    srcNoise: fc.double({ min: 0.9, max: 1.12, noNaN: true }),
    dstNoise: fc.double({ min: 0.98, max: 1.03, noNaN: true }),
    extra: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 2e9 })),
    extraEvents: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 5e5 })),
    idleHeavy: fc.boolean(),
  })
  .map((r) => {
    const flows = new Map<string, Flow>();
    const inByInput = new Map<string, ByteEvent>();
    const outByOut = new Map<string, ByteEvent>();
    const rIn = new Map<string, ByteEvent>();
    const rOut = new Map<string, ByteEvent>();
    const pIn = new Map<string, ByteEvent>();
    const pOut = new Map<string, ByteEvent>();
    const truthOut: Record<string, number> = {};
    const add = (
      m: Map<string, ByteEvent>,
      k: string,
      b: number,
      e: number,
    ) => {
      const p = m.get(k) ?? { bytes: 0, events: 0 };
      m.set(k, { bytes: p.bytes + b, events: p.events + e });
    };
    const passthrough = new Set<string>();
    for (let i = 0; i < r.nPipe; i++)
      if (r.passMask[i]) passthrough.add(`${G}:p${i}`);
    for (const s of r.seedFlows) {
      const inputId = s.input < 0 || s.input >= r.nIn ? "-" : `in${s.input}`;
      const routeId = s.route < 0 || s.route >= r.nRoute ? "-" : `r${s.route}`;
      if (inputId === "-" && routeId === "-") continue;
      const pipelineId = `p${s.pipe % r.nPipe}`;
      const outputId = `o${s.out % r.nOut}`;
      const key = makeFlowKey(G, inputId, routeId, pipelineId, outputId);
      if (flows.has(key)) continue;
      const attribution: Attribution =
        inputId === "-"
          ? "route-only"
          : routeId === "-"
            ? "proportional"
            : "route";
      flows.set(key, {
        key,
        groupId: G,
        inputId,
        routeId,
        pipelineId,
        outputId,
        attribution,
      });
      const pass = passthrough.has(`${G}:${pipelineId}`);
      const inB = r.idleHeavy && s.inB < 1000 ? 0 : s.inB;
      const outB = Math.round(inB * (pass ? 1 : s.keep));
      const inE = Math.ceil(inB / s.evSize);
      const outE = pass ? inE : Math.round(inE * Math.min(1, s.keep));
      truthOut[key] = outB;
      if (inputId !== "-") add(inByInput, `${G}:datagen:${inputId}`, inB, inE);
      add(outByOut, `${G}:${outputId}`, outB, outE);
      if (routeId !== "-") {
        add(rIn, `${G}:${routeId}`, inB, inE);
        add(
          rOut,
          `${G}:${routeId}`,
          Math.round(outB * (pass ? 1.002 : s.est)),
          outE,
        );
        add(pIn, `${G}:${pipelineId}`, inB, inE);
        add(
          pOut,
          `${G}:${pipelineId}`,
          Math.round(outB * (pass ? 1.002 : s.est)),
          outE,
        );
      }
    }
    const rec = (m: Map<string, ByteEvent>, f = 1) =>
      Object.fromEntries(
        [...m].map(([k, v]) => [
          k,
          { bytes: Math.round(v.bytes * f), events: v.events },
        ]),
      );
    const outputs = rec(outByOut, r.dstNoise);
    if (r.extra > 0) {
      const k = `${G}:o0`;
      outputs[k] = {
        bytes: (outputs[k]?.bytes ?? 0) + r.extra,
        events: (outputs[k]?.events ?? 0) + r.extraEvents,
      };
    }
    const metrics: MetricsWindow = {
      windowStart: "2026-09-27T12:00:00.000Z",
      windowEnd: "2026-09-27T12:01:00.000Z",
      inputs: rec(inByInput, r.srcNoise),
      outputs,
      routesIn: rec(rIn),
      routesOut: rec(rOut),
      pipelinesIn: rec(pIn),
      pipelinesOut: rec(pOut),
      has: { routeBytes: r.routeMode, pipelineBytes: r.pipeMode },
    };
    return { flows: [...flows.values()], passthrough, metrics, truthOut };
  });
const destOf = (f: Flow) => `${f.groupId}:${f.outputId}`;
const SEED = 20260928;

describe("r2 core-8 · the fuzz properties, fixed seed", () => {
  it("R3: an idle flow (its own estimate 0 in, 0 out, truly 0) is never handed bytes out", () => {
    const bad: string[] = [];
    fc.assert(
      fc.property(topoArb, (t) => {
        const est = attributeWindow(t.flows, t.metrics, { reconcile: false });
        const got = attributeWindow(t.flows, t.metrics, {
          passthroughPipelines: t.passthrough,
        });
        for (const f of t.flows) {
          const e = est[f.key];
          if (
            e.inB === 0 &&
            e.outB === 0 &&
            got[f.key].outB > 0 &&
            (t.truthOut[f.key] ?? 0) === 0
          )
            bad.push(`${f.key} given ${got[f.key].outB}`);
        }
        return true;
      }),
      { numRuns: 20_000, seed: SEED },
    );
    expect(bad.slice(0, 5)).toEqual([]);
  }, 120_000);

  it("R3b: a flow whose series reads > 0 in and 0 out (truly 0) is never handed bytes out", () => {
    const bad: string[] = [];
    fc.assert(
      fc.property(topoArb, (t) => {
        const est = attributeWindow(t.flows, t.metrics, { reconcile: false });
        const got = attributeWindow(t.flows, t.metrics, {
          passthroughPipelines: t.passthrough,
        });
        for (const f of t.flows) {
          const e = est[f.key];
          if (!(
            e.inB > 0 &&
            e.outB === 0 &&
            (t.truthOut[f.key] ?? 0) === 0 &&
            (e.attribution === "route" || e.attribution === "pipeline")
          ))
            continue;
          if (
            !t.flows.some(
              (g) =>
                destOf(g) === destOf(f) &&
                g.key !== f.key &&
                est[g.key].outB > 0,
            )
          )
            continue;
          if (got[f.key].outB > 0)
            bad.push(`${f.key} given ${got[f.key].outB}`);
        }
        return true;
      }),
      { numRuns: 20_000, seed: SEED + 1 },
    );
    expect(bad.slice(0, 5)).toEqual([]);
  }, 120_000);

  it("R2 (as amended): bytes stay whole; a destination never gets more than it counted, and exactly its count whenever some flow there could take the rest", () => {
    const bad: string[] = [];
    fc.assert(
      fc.property(topoArb, (t) => {
        const got = attributeWindow(t.flows, t.metrics, {
          passthroughPipelines: t.passthrough,
        });
        for (const f of t.flows)
          for (const k of ["inB", "outB", "inE", "outE"] as const)
            if (!Number.isSafeInteger(got[f.key][k]) || got[f.key][k] < 0)
              bad.push(`${f.key}.${k}=${got[f.key][k]}`);
        const byDest = new Map<string, Flow[]>();
        for (const f of t.flows)
          (
            byDest.get(destOf(f)) ?? byDest.set(destOf(f), []).get(destOf(f))!
          ).push(f);
        for (const [k, fs] of byDest) {
          const m = t.metrics.outputs[k];
          const reconciled = fs.filter(
            (f) => got[f.key].attribution === "reconciled",
          );
          if (!m || reconciled.length === 0) continue;
          const sum = fs.reduce((a, f) => a + got[f.key].outB, 0);
          if (sum > m.bytes) bad.push(`${k}: Σ ${sum} > measured ${m.bytes}`);
        }
        return true;
      }),
      { numRuns: 20_000, seed: SEED + 2 },
    );
    expect(bad.slice(0, 5)).toEqual([]);
  }, 120_000);
});
