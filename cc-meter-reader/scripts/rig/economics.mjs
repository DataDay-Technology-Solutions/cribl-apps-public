#!/usr/bin/env node
// Rig economics from measured windows → demo/rig/measured.json (+ a Markdown table on stdout).
//
//   node scripts/rig/verify.mjs --since <t> --capture --json > steady.json       # design state, stable level
//   node scripts/rig/verify.mjs --since <t> --capture --json > levers.json       # packs applied + trim broken
//   node scripts/rig/economics.mjs --steady steady.json --levers levers.json [--steps steps.json] [--write]
//
// Prices are the PRD 9.1 illustrative presets (demo/rig/destinations.json pricePreset): siem-prod
// $2.50/GB (splunk_cloud), analytics $1.50/GB (datadog), archive-s3 $0.03/GB (s3). GB = 1e9 bytes.
//
// Two ratios are reported for every flow (docs/RIG.md §5):
//   - trueRatio  — 1 − (bytes the Destination receives)/(bytes in): route.out_events × the mean `_raw`
//                  bytes of live events captured before the Destination, reconciled against each
//                  Destination's total.out_bytes. This is what a volume-priced bill charges.
//   - routeRatio — 1 − route.out_bytes/route.in_bytes: Cribl's route *estimate*, which Meter Reader's
//                  route attribution reads today. It is not byte-accurate for reshaped events.
// The money columns use trueRatio. The routeRatio money is kept under `appRouteEstimate` so the pitch
// can see what the app shows until attribution reconciles with Destination bytes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RIG_DIR, loadRig } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const read = (p) => (p ? JSON.parse(readFileSync(p, "utf8")) : null);
const steady = read(opt("--steady"));
const levers = read(opt("--levers"));
const steps = read(opt("--steps"));
if (!steady) throw new Error("--steady <verify --capture --json output> is required");

const rig = loadRig();
const USD_PER_GB = { splunk_cloud: 2.5, datadog: 1.5, s3: 0.03 };
const price = Object.fromEntries(
  rig.destinations.map((d) => [d.id, USD_PER_GB[d.pricePreset]]),
);
const label = Object.fromEntries(rig.destinations.map((d) => [d.id, d.label]));
const r2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
const r3 = (n) => (n === null || n === undefined ? null : Math.round(n * 1000) / 1000);
const r4 = (n) => (n === null || n === undefined ? null : Math.round(n * 10000) / 10000);
const r1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);
/**
 * A source's measured row, with trueRatio filled from the Destination's own byte count when the route
 * is that Destination's sole feeder and the capture saw nothing (e.g. an aggregation that emits only
 * at its window flush).
 */
const row = (j, id) => {
  const m = j?.sources?.find((s) => s.source === id) ?? null;
  if (!m || m.trueRatio !== null || !j.outputs) return m;
  const s = rig.sources.sources.find((x) => x.id === id);
  const sole =
    rig.sources.sources.filter((x) => x.route.output === s.route.output).length === 1;
  const o = j.outputs.find((x) => x.output === s.route.output);
  if (!sole || !o || !m.routeInGbPerDay) return m;
  return {
    ...m,
    trueOutGbPerDay: o.gbPerDay,
    trueRatio: 1 - o.gbPerDay / m.routeInGbPerDay,
    trueBasis: "destination total.out_bytes (sole feeder)",
  };
};

const flows = rig.sources.sources.map((s) => {
  const m = row(steady, s.id);
  const usd = price[s.route.output];
  const inGb = m.routeInGbPerDay;
  const whp = inGb * usd;
  // A raw (passthrough) route cannot change a byte: |ratio| < 0.005 there is capture noise, so it is 0.
  const ratioTrue =
    s.stage === "raw" && Math.abs(m.trueRatio ?? 0) < 0.005 ? 0 : m.trueRatio;
  const ratioRoute = m.ratio;
  return {
    source: s.id,
    label: s.label,
    stage: s.stage,
    pipeline: s.route.pipeline,
    destination: s.route.output,
    destinationLabel: label[s.route.output],
    usdPerGb: usd,
    inGbPerDay: r1(inGb),
    trueRatio: r4(ratioTrue),
    measuredTrueRatio: r4(m.trueRatio),
    trueBasis: m.trueBasis ?? null,
    routeRatio: r3(ratioRoute),
    target: s.targetRatio,
    wouldHavePaidPerDay: r2(whp),
    paidPerDay: r2(whp * (1 - ratioTrue)),
    savedPerDay: r2(whp * ratioTrue),
    appRouteEstimate: {
      paidPerDay: r2(inGb * (1 - ratioRoute) * usd),
      savedPerDay: r2(Math.max(0, inGb * ratioRoute * usd)),
    },
  };
});

// Levers, measured live in one window: packs applied on the raw routes, the payments trim broken.
function leverRow(sourceId, pipeline, basis = "measured live") {
  const s = rig.sources.sources.find((x) => x.id === sourceId);
  const f = flows.find((x) => x.source === sourceId);
  const m = row(levers, sourceId);
  return { s, f, m, pipeline, basis };
}
const packs = [];
if (levers) {
  const dc = flows.find((x) => x.source === "mrd_windows_dc");
  const addPack = (sourceId, pipeline, trueRatio, routeRatio, basis) => {
    const f = flows.find((x) => x.source === sourceId);
    packs.push({
      source: sourceId,
      label: f.label,
      pipeline,
      basis,
      trueRatio: r4(trueRatio),
      routeRatio: r3(routeRatio),
      gainPerDay: r2(f.inGbPerDay * f.usdPerGb * trueRatio),
      gainPerYear: Math.round(f.inGbPerDay * f.usdPerGb * trueRatio * 365),
      appRouteEstimate: {
        gainPerDay: r2(Math.max(0, f.inGbPerDay * f.usdPerGb * routeRatio)),
      },
    });
  };
  // Windows workstations: the pack is the pipeline windows_dc runs on the same sample all week.
  addPack(
    "mrd_windows_workstations",
    "mrd_win_xml_pack",
    dc.trueRatio,
    dc.routeRatio,
    "windows_dc's steady ratio (same sample, same pipeline)",
  );
  for (const [sid, pid] of [
    ["mrd_windows_workstations", "mrd_win_docs_reduce"],
    ["mrd_pan_firewall", "mrd_pan_pack"],
    ["mrd_vpc_flow", "mrd_vpc_pack"],
  ]) {
    const { m } = leverRow(sid, pid);
    if (m) addPack(sid, pid, m.trueRatio, m.ratio, "measured live");
  }
}

let trim = null;
const pay = row(levers, "mrd_payments_api");
if (pay) {
  const f = flows.find((x) => x.source === "mrd_payments_api");
  const lost = f.inGbPerDay * f.usdPerGb * (f.trueRatio - pay.trueRatio);
  trim = {
    source: "mrd_payments_api",
    pipeline: "mrd_pay_sample",
    steadyTrueRatio: f.trueRatio,
    brokenTrueRatio: r4(pay.trueRatio),
    trimPoints: r1((f.trueRatio - pay.trueRatio) * 100),
    lostPerDay: r2(lost),
    lostPerYear: Math.round(lost * 365),
    steadyRouteRatio: f.routeRatio,
    brokenRouteRatio: r3(pay.ratio),
    routeTrimPoints: r1((f.routeRatio - pay.ratio) * 100),
    appRouteEstimate: {
      lostPerDay: r2(f.inGbPerDay * f.usdPerGb * (f.routeRatio - pay.ratio)),
    },
  };
}

const sum = (a, k) => a.reduce((x, y) => x + (y[k] ?? 0), 0);
const whp = sum(flows, "wouldHavePaidPerDay");
const saved = sum(flows, "savedPerDay");
const pick = (sid, pid) => packs.find((p) => p.source === sid && p.pipeline === pid);
const packGain = (aggressive) =>
  (aggressive
    ? pick("mrd_windows_workstations", "mrd_win_docs_reduce")?.gainPerDay ?? 0
    : pick("mrd_windows_workstations", "mrd_win_xml_pack")?.gainPerDay ?? 0) +
  (pick("mrd_pan_firewall", "mrd_pan_pack")?.gainPerDay ?? 0) +
  (pick("mrd_vpc_flow", "mrd_vpc_pack")?.gainPerDay ?? 0);
const totals = {
  inGbPerDay: r1(sum(flows, "inGbPerDay")),
  wouldHavePaidPerDay: r2(whp),
  paidPerDay: r2(whp - saved),
  savedPerDay: r2(saved),
  savedPerYear: Math.round(saved * 365),
  savingsRatio: r3(saved / whp),
  withPacks: packs.length
    ? {
        savedPerDay: r2(saved + packGain(false)),
        savedPerYear: Math.round((saved + packGain(false)) * 365),
        savedPerDayGoAggressive: r2(saved + packGain(true)),
        savedPerYearGoAggressive: Math.round((saved + packGain(true)) * 365),
      }
    : null,
  appRouteEstimate: {
    savedPerDay: r2(flows.reduce((a, f) => a + f.appRouteEstimate.savedPerDay, 0)),
    paidPerDay: r2(flows.reduce((a, f) => a + f.appRouteEstimate.paidPerDay, 0)),
  },
};

const h = steady.health?.node ?? {};
const doc = {
  schemaVersion: 1,
  note: "Measured Meter Reader demo rig economics (PRD 9.1 template) at the rig's stable rate. Money in USD at the PRD 9.1 illustrative presets; GB = 1e9 bytes. trueRatio = bytes the Destination receives (captured events reconciled with total.out_bytes); routeRatio = Cribl's route.out_bytes estimate, which Meter Reader's route attribution reads today (docs/RIG.md section 5). Money columns use trueRatio; appRouteEstimate shows what the app displays with route attribution. Regenerate with scripts/rig/economics.mjs.",
  measuredAt: new Date().toISOString(),
  org: { workspace: "main", group: rig.sources.groupId, cribl: "4.20.1" },
  worker: {
    nodes: steady.workerNodes,
    vcpus: 2,
    memGb: 1.9,
    workerProcesses: 2,
    cpuNodeAvgPct: h.cpuNodeAvg ?? null,
    cpuProcessMaxPct: h.cpuProcessMax ?? null,
    freeMemMinMb: h.freeMemMinMB ?? null,
  },
  capacity: steps
    ? {
        chosenRateFactor: steady.rateFactor,
        why: "The PRD 9.1 design rate (450 GB/day) is the target and the ceiling; every step ran at 100% of the applied rate with no blocked outputs, no dropped events at rig outputs and no heartbeat lag, including the worst case with all three packs (Go aggressive) applied and the trim broken.",
        designStateCpuNodeAvgPct: steps.filter((x) => x.rateFactor === steady.rateFactor && /^design/.test(x.state)).at(-1)?.cpuNodeAvgPct ?? null,
        worstCaseCpuNodeAvgPct: steps.find((x) => /packs applied/.test(x.state))?.cpuNodeAvgPct ?? null,
        worstCaseCpuProcessMaxPct: steps.find((x) => /packs applied/.test(x.state))?.cpuProcessMaxPct ?? null,
        cpuScale: "system.cpu_perc per Worker Process, 100 = one full vCPU; the node has 2 vCPUs (node total 200)",
      }
    : null,
  rate: {
    rateFactor: steady.rateFactor,
    designGbPerDay: steady.designGbPerDay,
    measuredInGbPerDay: r1(steady.totalInGbPerDay),
    destinationGbPerDay: r1(steady.totalDestinationGbPerDay),
    steps: steps ?? null,
  },
  windows: {
    steady: steady.window,
    levers: levers?.window ?? null,
  },
  prices: Object.fromEntries(
    rig.destinations.map((d) => [
      d.id,
      { label: d.label, preset: d.pricePreset, usdPerGb: price[d.id] },
    ]),
  ),
  flows,
  packs,
  trim,
  totals,
};

if (args.includes("--write")) {
  writeFileSync(join(RIG_DIR, "measured.json"), JSON.stringify(doc, null, 2) + "\n");
  console.error(`wrote ${join(RIG_DIR, "measured.json")}`);
}

// Markdown for docs/RIG.md.
const $ = (n) =>
  n === null || n === undefined
    ? "—"
    : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: n < 10 ? 2 : 0, maximumFractionDigits: n < 10 ? 2 : 0 })}`;
const lines = [];
lines.push(
  "| Source | GB/day in | Destination · $/GB | Would-have-paid / day | Ratio (true · app) | Saved / day | After the pack |",
  "|---|---|---|---|---|---|---|",
);
for (const f of flows) {
  const after = packs
    .filter((p) => p.source === f.source)
    .map((p) => `+${$(p.gainPerDay)}/day (${p.trueRatio >= 0.9995 ? p.trueRatio.toFixed(4) : p.trueRatio?.toFixed(2)}${p.pipeline === "mrd_win_docs_reduce" ? ", Go aggressive" : ""})`)
    .join(" · ");
  const extra =
    f.source === "mrd_payments_api" && trim
      ? `break the trim: ${trim.steadyTrueRatio.toFixed(2)} → ${trim.brokenTrueRatio.toFixed(2)} = ${$(trim.lostPerDay)}/day lost (${$(trim.lostPerYear)}/yr)`
      : "";
  lines.push(
    `| \`${f.source.replace(/^mrd_/, "")}\` | ${f.inGbPerDay.toFixed(1)} | ${f.destinationLabel} · ${f.usdPerGb.toFixed(2)} | ${$(f.wouldHavePaidPerDay)} | ${f.trueRatio.toFixed(3)} · ${f.routeRatio.toFixed(3)} | ${$(f.savedPerDay)} | ${after || extra || "—"} |`,
  );
}
lines.push(
  `| **Total** | **${totals.inGbPerDay.toFixed(1)}** | | **${$(totals.wouldHavePaidPerDay)}** | ${totals.savingsRatio.toFixed(3)} | **${$(totals.savedPerDay)}** (${$(totals.savedPerYear)}/yr) | ${totals.withPacks ? `**${$(totals.withPacks.savedPerDay)}–${$(totals.withPacks.savedPerDayGoAggressive)}/day** (${$(totals.withPacks.savedPerYear)}–${$(totals.withPacks.savedPerYearGoAggressive)}/yr) with all three packs` : "—"} |`,
);
console.log(lines.join("\n"));
