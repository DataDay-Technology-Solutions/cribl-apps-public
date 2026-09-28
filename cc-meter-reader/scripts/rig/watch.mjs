#!/usr/bin/env node
// Worker health sampler for the Meter Reader demo rig — read-only.
//
//   node scripts/rig/watch.mjs                  # one line per minute until stopped
//   node scripts/rig/watch.mjs --once           # one sample, then exit
//   node scripts/rig/watch.mjs --every 30       # sample every 30 s
//
// Why: `system.cpu_perc` and the memory gauges are not in the aggregate metrics store
// (POST /system/metrics/query returns nothing for them), only in each Worker Node's own buffer
// (GET /w/<wid>/system/metrics, ~10 s buckets, the last ~2 minutes). This samples that buffer and
// appends one JSON line per sample to node_modules/.cache/mr-rig-health.jsonl, which verify.mjs reads
// back for its window. Every value is averaged over the buckets since the previous sample.
//
// Per sample: CPU % per Worker Process (avg and max; 100 = one full core), load average, free and RSS
// memory, heartbeat-lagging and unresponsive Worker Processes, blocked / backpressured rig outputs,
// dropped events at rig outputs (the `null` output's drops are the pipelines' intentional drops and
// are reported separately), the running config version, and events in per second.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, call, sleep } from "./lib.mjs";

export const HEALTH_LOG = join(
  ROOT,
  "node_modules",
  ".cache",
  "mr-rig-health.jsonl",
);
const GROUP = "default";

const args = process.argv.slice(2);
const once = args.includes("--once");
const everySec = Math.max(
  15,
  Number(args.includes("--every") ? args[args.indexOf("--every") + 1] : 60),
);

async function worker() {
  const j = await call("GET", "/master/workers");
  const w = (j.items ?? []).find((x) => x.group === GROUP && !x.disconnected);
  if (!w) throw new Error(`no connected Worker in ${GROUP}`);
  return w;
}

const NAMES = [
  "system.cpu_perc",
  "system.load_avg",
  "system.free_mem",
  "system.total_mem",
  "system.mem_rss",
  "system.heartbeat_lagging_worker_processes",
  "system.worker_unresponsive",
  "blocked.outputs",
  "backpressure.outputs",
  "total.dropped_events",
  "total.in_events",
  "total.in_bytes",
];

/** One sample: the node's metrics buckets newer than `sinceSec`, summarized. */
export async function sampleHealth(sinceSec = 0) {
  const w = await worker();
  const filter = NAMES.map((n) => `name===${JSON.stringify(n)}`).join(" || ");
  const r = await call(
    "GET",
    `/w/${w.id}/system/metrics?metricNameFilter=${encodeURIComponent(filter)}`,
  );
  const buckets = (r.results?.metrics ?? []).filter(
    (b) => (b._time?.[0]?.val ?? 0) > sinceSec,
  );
  const cpu = {};
  let loadMax = 0;
  let freeMin = Infinity;
  let rssMax = 0;
  let totalMem = 0;
  let lagging = 0;
  let unresponsive = 0;
  let blocked = 0;
  let backpressure = 0;
  let droppedAtRigOutputs = 0;
  let droppedByPipelines = 0;
  let inEvents = 0;
  let inBytes = 0;
  const times = [];
  for (const b of buckets) {
    times.push(b._time?.[0]?.val ?? 0);
    for (const e of b["system.cpu_perc"] ?? []) {
      const p = e.model?.__worker_process ?? "?";
      (cpu[p] ??= []).push(Number(e.val) || 0);
    }
    for (const e of b["system.load_avg"] ?? [])
      loadMax = Math.max(loadMax, Number(e.val) || 0);
    for (const e of b["system.free_mem"] ?? [])
      freeMin = Math.min(freeMin, Number(e.val) || 0);
    for (const e of b["system.total_mem"] ?? [])
      totalMem = Number(e.val) || totalMem;
    for (const e of b["system.mem_rss"] ?? [])
      rssMax = Math.max(rssMax, Number(e.val) || 0);
    for (const e of b["system.heartbeat_lagging_worker_processes"] ?? [])
      lagging = Math.max(lagging, Number(e.val) || 0);
    for (const e of b["system.worker_unresponsive"] ?? [])
      unresponsive = Math.max(unresponsive, Number(e.val) || 0);
    for (const e of b["blocked.outputs"] ?? [])
      if (String(e.model?.output ?? "").includes(":mrd_"))
        blocked = Math.max(blocked, Number(e.val) || 0);
    for (const e of b["backpressure.outputs"] ?? [])
      if (String(e.model?.output ?? "").includes(":mrd_"))
        backpressure = Math.max(backpressure, Number(e.val) || 0);
    for (const e of b["total.dropped_events"] ?? []) {
      const o = String(e.model?.output ?? "");
      if (o.includes(":mrd_")) droppedAtRigOutputs += Number(e.val) || 0;
      else if (o === "null") droppedByPipelines += Number(e.val) || 0;
    }
    for (const e of b["total.in_events"] ?? [])
      if (e.model?.__internal === "1") inEvents += Number(e.val) || 0;
    for (const e of b["total.in_bytes"] ?? [])
      if (e.model?.__internal === "1") inBytes += Number(e.val) || 0;
  }
  const span =
    times.length > 1
      ? Math.max(...times) - Math.min(...times) + 10
      : times.length * 10;
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const cpuAvg = Object.fromEntries(
    Object.entries(cpu).map(([p, a]) => [p, Math.round(avg(a) * 10) / 10]),
  );
  const cpuMax = Object.fromEntries(
    Object.entries(cpu).map(([p, a]) => [p, Math.round(Math.max(...a) * 10) / 10]),
  );
  return {
    t: new Date().toISOString(),
    buckets: buckets.length,
    newest: times.length ? Math.max(...times) : sinceSec,
    configVersion: w.info?.cribl?.config?.version ?? null,
    workerStartTime: w.info?.cribl?.startTime ?? null,
    cpuAvg,
    cpuMax,
    cpuNodeAvg:
      Math.round(Object.values(cpuAvg).reduce((a, b) => a + b, 0) * 10) / 10,
    loadMax,
    freeMemMinMB: Number.isFinite(freeMin) ? Math.round(freeMin / 1e6) : null,
    totalMemMB: Math.round(totalMem / 1e6),
    rssMaxMB: Math.round(rssMax / 1e6),
    laggingProcesses: lagging,
    unresponsive,
    blockedRigOutputs: blocked,
    backpressureRigOutputs: backpressure,
    droppedAtRigOutputs,
    droppedByPipelines,
    inEventsPerSec: span ? Math.round(inEvents / span) : 0,
    inMBPerMin: span ? Math.round((inBytes / span) * 60 / 1e5) / 10 : 0,
  };
}

if (process.argv[1] && process.argv[1].endsWith("watch.mjs")) {
  mkdirSync(dirname(HEALTH_LOG), { recursive: true });
  let since = 0;
  for (;;) {
    try {
      const s = await sampleHealth(since);
      if (s.buckets) since = s.newest;
      appendFileSync(HEALTH_LOG, JSON.stringify(s) + "\n");
      console.log(
        `${s.t.slice(11, 19)} cfg ${s.configVersion} cpu ${JSON.stringify(s.cpuAvg)} max ${JSON.stringify(s.cpuMax)} load ${s.loadMax} free ${s.freeMemMinMB} MB rss ${s.rssMaxMB} MB lag ${s.laggingProcesses} unresp ${s.unresponsive} blocked ${s.blockedRigOutputs} bp ${s.backpressureRigOutputs} dropped ${s.droppedAtRigOutputs} in ${s.inEventsPerSec} ev/s ${s.inMBPerMin} MB/min`,
      );
    } catch (e) {
      console.log(`${new Date().toISOString().slice(11, 19)} error ${String(e.message).slice(0, 160)}`);
    }
    if (once) break;
    await sleep(everySec * 1000);
  }
}
