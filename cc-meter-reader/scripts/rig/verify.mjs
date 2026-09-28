#!/usr/bin/env node
// Measure the Meter Reader demo rig from Cribl's own metrics (POST /system/metrics/query) — read-only.
//
//   node scripts/rig/verify.mjs                       # last 10 complete minutes
//   node scripts/rig/verify.mjs --minutes 30          # longer window
//   node scripts/rig/verify.mjs --since 2026-09-26T06:05:00Z   # from a whole minute (e.g. after a deploy) to now
//   node scripts/rig/verify.mjs --capture             # also sample live output events (true byte ratios)
//   node scripts/rig/verify.mjs --strict              # exit 1 when a ratio is out of band (the true ratio with --capture)
//   node scripts/rig/verify.mjs --json                # machine-readable result
//
// For every rig source it prints:
//   - GB/day in at the Source (total.in_bytes by input) and the rate achieved against the applied
//     eventsPerSec (read from the Leader's copy of the Source), with the number of short minutes;
//   - GB/day in and out at its route (route.in_bytes / route.out_bytes by route id) and the route ratio
//     1 − out/in, which is what Meter Reader prices, checked against the source's target band
//     (demo/rig/sources.json targetRatio ± verifyTolerance);
//   - with --capture, the TRUE ratio: the bytes the Destination receives over route.in_bytes. For a
//     Destination fed by one rig route that is its own total.out_bytes (exact); otherwise
//     route.out_events × the mean `_raw` bytes of live events captured just before the Destination
//     (POST /system/capture, level 3), checked against the Destination's total.out_bytes (the
//     reconciliation line). Measured 2026-09-26:
//     route.out_bytes is Cribl's *estimate* of the processed event's size and differs from the bytes a
//     Destination counts (docs/RIG.md §5).
// Health comes from the Worker Node's own buffer, sampled by scripts/rig/watch.mjs into
// node_modules/.cache/mr-rig-health.jsonl (CPU is not in the aggregate store), plus the aggregate
// store's blocked.outputs. Rows are scoped to __worker_group and rollup rows are dropped (lib.metrics).
// GB = 1e9 bytes.
import { existsSync, readFileSync } from "node:fs";
import { loadRig, metrics, gbPerDay, call, getOne, workerNodes } from "./lib.mjs";
import { token, baseUrl } from "../cribl-api.mjs";
import { HEALTH_LOG } from "./watch.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : dflt;
const strict = args.includes("--strict");
const asJson = args.includes("--json");
const doCapture = args.includes("--capture");

const rig = loadRig();
const GROUP = rig.sources.groupId;
const tol = rig.sources.verifyTolerance ?? { reduced: 0.1, raw: 0.03 };

// Whole minutes only, and leave the newest minute out: it is still being reported.
const MIN = 60_000;
const latestMs = Math.floor(Date.now() / MIN) * MIN - MIN;
const sinceArg = opt("--since");
const earliestMs = sinceArg
  ? Math.ceil(
      (/^\d+$/.test(sinceArg) ? Number(sinceArg) : Date.parse(sinceArg)) / MIN,
    ) * MIN
  : latestMs - Math.max(1, Number(opt("--minutes", 10))) * MIN;
if (!(earliestMs < latestMs))
  throw new Error("empty window: --since must be at least two minutes ago");
const minutes = (latestMs - earliestMs) / MIN;
const seconds = (latestMs - earliestMs) / 1000;

const sumBy = (rows, key, field) => {
  const out = {};
  for (const r of rows)
    out[r[key]] = (out[r[key]] ?? 0) + (Number(r[field]) || 0);
  return out;
};

const [inRows, routeRows, outRows, nodes, applied] = await Promise.all([
  metrics({
    groupId: GROUP,
    earliestMs,
    latestMs,
    splitBys: ["input"],
    aggregations: [
      'sum("total.in_bytes").as("bytes")',
      'sum("total.in_events").as("events")',
    ],
  }),
  metrics({
    groupId: GROUP,
    earliestMs,
    latestMs,
    splitBys: ["route"],
    aggregations: [
      'sum("route.in_bytes").as("inBytes")',
      'sum("route.out_bytes").as("outBytes")',
      'sum("route.in_events").as("inEvents")',
      'sum("route.out_events").as("outEvents")',
    ],
  }),
  metrics({
    groupId: GROUP,
    earliestMs,
    latestMs,
    splitBys: ["output"],
    aggregations: [
      'sum("total.out_bytes").as("bytes")',
      'sum("total.out_events").as("events")',
      'sum("total.dropped_events").as("dropped")',
    ],
  }),
  workerNodes(GROUP),
  Promise.all(
    rig.sources.sources.map(async (s) => {
      const i = await getOne(`/m/${GROUP}/system/inputs/${s.id}`);
      return [s.id, Number(i?.samples?.[0]?.eventsPerSec ?? 0)];
    }),
  ).then(Object.fromEntries),
]);

// Blocked outputs from the aggregate store, over the window.
let blockedMax = null;
try {
  const j = await call("POST", "/system/metrics/query", {
    where: `__worker_group=='${GROUP}'`,
    aggs: {
      aggregations: ['max("blocked.outputs").as("blocked")'],
      timeWindowSeconds: minutes * 60,
    },
    earliest: earliestMs,
    latest: latestMs,
  });
  blockedMax = (j.results ?? [])[0]?.blocked ?? 0;
} catch {
  blockedMax = null;
}

// Node health from the watch.mjs log, restricted to the window.
function healthFromLog() {
  if (!existsSync(HEALTH_LOG)) return null;
  const rows = readFileSync(HEALTH_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(
      (r) =>
        r &&
        r.buckets > 0 &&
        r.newest * 1000 > earliestMs &&
        r.newest * 1000 <= latestMs + MIN,
    );
  if (!rows.length) return null;
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const procs = [...new Set(rows.flatMap((r) => Object.keys(r.cpuAvg ?? {})))];
  return {
    samples: rows.length,
    cpuNodeAvg: Math.round(avg(rows.map((r) => r.cpuNodeAvg)) * 10) / 10,
    cpuProcessAvg: Object.fromEntries(
      procs.map((p) => [
        p,
        Math.round(avg(rows.map((r) => r.cpuAvg?.[p] ?? 0)) * 10) / 10,
      ]),
    ),
    cpuProcessMax: Object.fromEntries(
      procs.map((p) => [p, Math.max(...rows.map((r) => r.cpuMax?.[p] ?? 0))]),
    ),
    loadMax: Math.max(...rows.map((r) => r.loadMax)),
    freeMemMinMB: Math.min(...rows.map((r) => r.freeMemMinMB ?? Infinity)),
    rssMaxMB: Math.max(...rows.map((r) => r.rssMaxMB)),
    laggingSamples: rows.filter((r) => r.laggingProcesses > 0).length,
    unresponsiveMax: Math.max(...rows.map((r) => r.unresponsive)),
    blockedMax: Math.max(...rows.map((r) => r.blockedRigOutputs)),
    backpressureMax: Math.max(...rows.map((r) => r.backpressureRigOutputs)),
    droppedAtRigOutputs: rows.reduce((a, r) => a + r.droppedAtRigOutputs, 0),
    configVersions: [...new Set(rows.map((r) => r.configVersion))],
  };
}

/** Mean `_raw` bytes of up to `max` live events of one Source, just before the Destination. */
async function captureMeanBytes(sourceId, max = 400) {
  const t = await token();
  const res = await fetch(`${baseUrl()}/m/${GROUP}/system/capture`, {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: JSON.stringify({
      duration: 10,
      filter: `__inputId=='datagen:${sourceId}'`,
      level: 3,
      maxEvents: max,
      stepDuration: 1,
    }),
  });
  if (!res.ok) throw new Error(`capture ${sourceId}: HTTP ${res.status}`);
  const events = (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && typeof e._raw === "string");
  if (!events.length) return { n: 0, mean: null };
  const bytes = events.reduce((a, e) => a + Buffer.byteLength(e._raw), 0);
  return { n: events.length, mean: bytes / events.length };
}

const inBytes = sumBy(inRows, "input", "bytes");
const inEvents = sumBy(inRows, "input", "events");
const rIn = sumBy(routeRows, "route", "inBytes");
const rOut = sumBy(routeRows, "route", "outBytes");
const rInEv = sumBy(routeRows, "route", "inEvents");
const rOutEv = sumBy(routeRows, "route", "outEvents");
const oBytes = sumBy(outRows, "output", "bytes");
const oEvents = sumBy(outRows, "output", "events");
const oDropped = sumBy(outRows, "output", "dropped");

// Short minutes: a source minute below 97% of the applied rate (a deploy, a reload, or a Worker that
// cannot keep up).
const perMinute = {};
for (const r of inRows) {
  if (!String(r.input).startsWith("datagen:mrd_")) continue;
  (perMinute[r.input] ??= []).push(Number(r.events) || 0);
}

const captures = {};
if (doCapture)
  for (const s of rig.sources.sources)
    captures[s.id] = await captureMeanBytes(s.id).catch((e) => ({
      n: 0,
      mean: null,
      error: String(e.message),
    }));

const rows = rig.sources.sources.map((s) => {
  const key = `datagen:${s.id}`;
  const ri = rIn[s.route.id] ?? 0;
  const ro = rOut[s.route.id] ?? 0;
  const ratio = ri > 0 ? 1 - ro / ri : null;
  const t = rig.sources.verifyTolerance
    ? s.stage === "raw"
      ? tol.raw
      : tol.reduced
    : 0.1;
  const lo = s.targetRatio.min - t;
  const hi = s.targetRatio.max + t;
  const events = inEvents[key] ?? 0;
  const eps = applied[s.id] ?? 0;
  const expectedPerMin = eps * 60 * Math.max(1, nodes);
  const mins = perMinute[key] ?? [];
  const cap = captures[s.id];
  // A Destination fed by this route alone counts the true bytes itself (exact; also covers pipelines
  // that emit only at a window flush, which a 10 s capture can miss). Otherwise: capture × out events.
  const soleFeeder =
    rig.sources.sources.filter((x) => x.route.output === s.route.output)
      .length === 1;
  const destBytes =
    oBytes[`devnull:${s.route.output}`] ?? oBytes[s.route.output] ?? null;
  const trueOut =
    doCapture && soleFeeder && destBytes !== null
      ? destBytes
      : cap?.mean != null
        ? (rOutEv[s.route.id] ?? 0) * cap.mean
        : null;
  return {
    source: s.id,
    stage: s.stage,
    pipeline: s.route.pipeline,
    output: s.route.output,
    appliedEventsPerSec: eps,
    inGbPerDay: gbPerDay(inBytes[key] ?? 0, seconds),
    rateAchieved: expectedPerMin
      ? events / (expectedPerMin * minutes)
      : null,
    shortMinutes: mins.filter((n) => n < expectedPerMin * 0.97).length,
    routeInGbPerDay: gbPerDay(ri, seconds),
    routeOutGbPerDay: gbPerDay(ro, seconds),
    eventsPerSec: events / seconds,
    bytesPerEvent: events > 0 ? (inBytes[key] ?? 0) / events : null,
    routeEventsIn: rInEv[s.route.id] ?? 0,
    routeEventsOut: rOutEv[s.route.id] ?? 0,
    routeOutBytesPerEvent:
      rOutEv[s.route.id] > 0 ? ro / rOutEv[s.route.id] : null,
    ratio,
    capture: cap ?? null,
    trueBasis:
      trueOut === null
        ? null
        : doCapture && soleFeeder && destBytes !== null
          ? "destination total.out_bytes (sole feeder)"
          : "capture mean × route.out_events",
    trueOutGbPerDay: trueOut === null ? null : gbPerDay(trueOut, seconds),
    trueRatio: trueOut === null || !ri ? null : 1 - trueOut / ri,
    target: s.targetRatio,
    band: { min: lo, max: hi },
    ok: ratio !== null && ratio >= lo && ratio <= hi,
    trueOk:
      trueOut === null || !ri
        ? null
        : 1 - trueOut / ri >= lo && 1 - trueOut / ri <= hi,
  };
});

const outputs = rig.destinations.map((d) => {
  const key = `devnull:${d.id}`;
  const bytes = oBytes[key] ?? oBytes[d.id] ?? 0;
  const feeding = rows.filter((r) => r.output === d.id);
  const trueSum = feeding.every((r) => r.trueOutGbPerDay !== null)
    ? feeding.reduce((a, r) => a + r.trueOutGbPerDay, 0)
    : null;
  const routeSum = feeding.reduce((a, r) => a + r.routeOutGbPerDay, 0);
  const gb = gbPerDay(bytes, seconds);
  return {
    output: d.id,
    gbPerDay: gb,
    events: oEvents[key] ?? 0,
    dropped: oDropped[key] ?? oDropped[d.id] ?? 0,
    routeOutSumGbPerDay: routeSum,
    routeEstimateError: gb ? routeSum / gb - 1 : null,
    trueOutSumGbPerDay: trueSum,
    captureReconciliationError:
      trueSum === null || !gb ? null : trueSum / gb - 1,
  };
});
const totalIn = rows.reduce((a, r) => a + r.inGbPerDay, 0);
const totalOut = rows.reduce((a, r) => a + r.routeOutGbPerDay, 0);
const totalDest = outputs.reduce((a, o) => a + o.gbPerDay, 0);
const design = rig.sources.sources.reduce((a, s) => a + s.targetGbPerDay, 0);
const result = {
  window: {
    earliest: new Date(earliestMs).toISOString(),
    latest: new Date(latestMs).toISOString(),
    minutes,
  },
  workerNodes: nodes,
  rateFactor: rig.sources.rateFactor,
  totalInGbPerDay: totalIn,
  totalRouteOutGbPerDay: totalOut,
  totalDestinationGbPerDay: totalDest,
  designGbPerDay: design,
  achievedFactor: design ? totalIn / design : 0,
  sources: rows,
  outputs,
  health: { blockedMaxAggregate: blockedMax, node: healthFromLog() },
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const f = (n, d = 1) =>
    n === null || n === undefined ? "—" : Number(n).toFixed(d);
  console.log(
    `Meter Reader rig — ${result.window.earliest} → ${result.window.latest} (${minutes} min), group ${GROUP}, ${nodes} node(s)`,
  );
  console.log(
    "source                     eps   in GB/d  rate%  short  route in route out  ratio  target      ok " +
      (doCapture ? "  true out  true ratio ok" : ""),
  );
  for (const r of rows) {
    console.log(
      `${r.source.padEnd(26)} ${String(r.appliedEventsPerSec).padStart(5)} ${f(r.inGbPerDay).padStart(8)} ${f((r.rateAchieved ?? 0) * 100).padStart(6)} ${String(r.shortMinutes).padStart(5)} ${f(r.routeInGbPerDay).padStart(9)} ${f(r.routeOutGbPerDay).padStart(9)} ` +
        `${f(r.ratio, 3).padStart(6)}  ${`${r.target.min.toFixed(2)}–${r.target.max.toFixed(2)}`.padEnd(10)} ${r.ok ? "yes" : "NO "}` +
        (doCapture
          ? ` ${f(r.trueOutGbPerDay).padStart(9)} ${f(r.trueRatio, 3).padStart(10)}  ${r.trueOk ? "yes" : "NO"}`
          : ""),
    );
  }
  console.log(
    `total in ${f(totalIn)} GB/day (design ${design} × rateFactor ${rig.sources.rateFactor}; achieved ${(result.achievedFactor * 100).toFixed(1)}% of design); route out (estimate) ${f(totalOut)} GB/day; destinations ${f(totalDest)} GB/day`,
  );
  for (const o of outputs)
    console.log(
      `output ${o.output.padEnd(15)} ${f(o.gbPerDay).padStart(7)} GB/d  dropped ${o.dropped}  route-estimate sum ${f(o.routeOutSumGbPerDay)} (${f((o.routeEstimateError ?? 0) * 100)}%)` +
        (o.trueOutSumGbPerDay !== null
          ? `  capture sum ${f(o.trueOutSumGbPerDay)} (${f((o.captureReconciliationError ?? 0) * 100)}%)`
          : ""),
    );
  console.log("health", JSON.stringify(result.health));
}
// --strict judges the true ratio when --capture measured it (the route counter is an estimate that
// misreads reshaped and passthrough events, docs/RIG.md §5), else the route ratio.
if (strict && rows.some((r) => (r.trueOk === null ? !r.ok : !r.trueOk)))
  process.exit(1);
