#!/usr/bin/env node
// Apply the Meter Reader demo rig to a Cribl Stream Worker Group — idempotently.
//
//   node scripts/rig/apply.mjs                       # upsert every rig object (pending changes only)
//   node scripts/rig/apply.mjs --factor 0.25         # override sources.json rateFactor for this run
//   node scripts/rig/apply.mjs --plan-commit         # show exactly which files a commit would include
//   node scripts/rig/apply.mjs --commit --deploy     # upsert, commit ONLY the rig's files, deploy
//   node scripts/rig/apply.mjs --commit-only --commit --deploy   # commit+deploy what an earlier apply left pending
//        [--accept-reserialization inputs.yml]       # see planCommit(): Leader re-serialization of a file clean at baseline
//        [--exclude-blocked]                          # commit the rest, leave blocked shared files pending
//        [--include-group-key]                        # ALSO commit auth/cribl.secret (org owner's explicit OK only; docs/RIG.md)
//   node scripts/rig/apply.mjs --write-throttles     # also rewrite demo/rig/throttles.json from the applied rates
//   node scripts/rig/apply.mjs --dry-run             # print what would be written, touch nothing
//   node scripts/rig/apply.mjs --route mrd_pan_firewall=mrd_pan_pack[,<route>=<pipeline>…]
//        # measurement runs only: this run's route uses one of that source's own pipelines (route.pipeline,
//        # packPipeline or aggressivePipeline). The next plain apply puts the design route back.
//   node scripts/rig/apply.mjs --break-trim mrd_pay_sample[,mrd_k8s_noise]
//        # measurement runs only: this run disables the pipeline's single [mr-trim] function (what the
//        # "break the trim" lever does). The next plain apply restores it.
//
// Order: destinations → pipelines → samples → sources → routes (every reference exists before it is used).
// Everything written is an `mrd_` object tagged `[meter-reader-demo]`; the route table is edited by
// replacing only the `mrd_` routes, which sit at the top, and every other route is sent back exactly as
// read. A commit passes an explicit file list; a shared file (inputs.yml, outputs.yml, route.yml,
// samples.yml) is included only when every changed line in its diff belongs to an `mrd_` object —
// otherwise the script stops without committing (the org has other people's pending changes).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RIG_DIR,
  PREFIX,
  TOKEN,
  RIG_PATH,
  loadRig,
  assertOurs,
  call,
  getOne,
  covers,
  upsert,
  workerNodes,
  pendingFiles,
  loadBaseline,
  saveBaseline,
  runCommit,
} from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const DRY = flag("--dry-run");
const MESSAGE = opt("--message") ?? "demo: apply the Meter Reader rig";

const rig = loadRig();
const GROUP = rig.sources.groupId;
const factor =
  opt("--factor") !== undefined
    ? Number(opt("--factor"))
    : rig.sources.rateFactor;
if (!(factor > 0 && factor <= 2)) throw new Error(`bad rate factor ${factor}`);
const sampleField = rig.sources.datagenSampleField ?? "id";

// Measurement overrides (docs/RIG.md §5, §7): a route swapped to one of its source's own pipelines, and
// trims disabled. Anything else is refused.
const routeOverride = Object.fromEntries(
  (opt("--route") ?? "")
    .split(",")
    .filter(Boolean)
    .map((kv) => kv.split("=")),
);
for (const [rid, pid] of Object.entries(routeOverride)) {
  const s = rig.sources.sources.find((x) => x.route.id === rid);
  const allowed = s
    ? [s.route.pipeline, s.packPipeline, s.aggressivePipeline].filter(Boolean)
    : [];
  if (!allowed.includes(pid))
    throw new Error(
      `--route ${rid}=${pid}: allowed pipelines for ${rid} are ${allowed.join(", ") || "none"}`,
    );
}
const brokenTrims = new Set((opt("--break-trim") ?? "").split(",").filter(Boolean));
for (const pid of brokenTrims) {
  const p = rig.pipelines.find((x) => x.id === pid);
  const trims = (p?.conf.functions ?? []).filter((f) =>
    (f.description ?? "").includes("[mr-trim]"),
  );
  if (trims.length !== 1)
    throw new Error(`--break-trim ${pid}: needs exactly one [mr-trim] function`);
}
const log = (...a) => console.log(...a);
const results = { created: [], updated: [], unchanged: [] };
const note = (kind, id, what) => results[what].push(`${kind}:${id}`);

// ─── Builders ────────────────────────────────────────────────────────────────

/**
 * The sample-library body for a manifest entry, flagged as a Datagen template. The description carries
 * a short content fingerprint so a re-apply can tell an unchanged sample from a regenerated one
 * without downloading its content.
 */
function sampleBody(m) {
  const text = readFileSync(join(RIG_DIR, "samples", m.file), "utf8");
  const events = JSON.parse(text);
  const sha = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return {
    id: m.sampleId,
    sampleName: m.sampleName,
    description: `${m.description} (sha ${sha})`,
    // A Datagen Source can only use sample-library entries flagged as templates ("Datagen files").
    isTemplate: true,
    context: { events },
  };
}

function inputFor(source, nodes) {
  const m = rig.samples[source.sampleKey];
  const bytesPerEvent = source.bytesPerEvent ?? m.avgEventBytes;
  const bytesPerSec = (source.targetGbPerDay * factor * 1e9) / 86_400;
  const eps = Math.max(
    1,
    Math.round(bytesPerSec / bytesPerEvent / Math.max(1, nodes)),
  );
  return {
    id: source.id,
    type: "datagen",
    disabled: false,
    sendToRoutes: true,
    pqEnabled: false,
    samples: [
      {
        sample: sampleField === "sampleName" ? m.sampleName : m.sampleId,
        eventsPerSec: eps,
      },
    ],
    description: source.description,
    streamtags: ["meter-reader-demo"],
  };
}

function routeFor(source) {
  return {
    id: source.route.id,
    name: source.route.id,
    final: true,
    disabled: false,
    pipeline: routeOverride[source.route.id] ?? source.route.pipeline,
    output: source.route.output,
    filter: `__inputId=='datagen:${source.id}'`,
    description: `${TOKEN} ${source.label}: Datagen ${source.id} → ${source.route.pipeline} → ${source.route.output}`,
    enableOutputExpression: false,
    clones: [],
  };
}

// ─── Steps ───────────────────────────────────────────────────────────────────

async function applyDestinations() {
  for (const d of rig.destinations) {
    const what = DRY
      ? "unchanged"
      : await upsert("output", `/m/${GROUP}/system/outputs`, d.output);
    note("output", d.id, what);
  }
}

async function applyPipelines() {
  // Chained pipelines first so a chain never points at a pipeline that does not exist yet.
  const order = [...rig.pipelines].sort(
    (a, b) =>
      Number(a.conf.functions.some((f) => f.id === "chain")) -
      Number(b.conf.functions.some((f) => f.id === "chain")),
  );
  for (const p of order) {
    // DECISIONS D59: a pipeline whose functions are a Cribl pack's (fromPack) ships only as a shell naming the pack:
    // its function list is Cribl's content, not this Apache-2.0 repository's. Leave it to the organization: never
    // write the empty shell over it, and say what to install when it is missing.
    if (p.fromPack) {
      const have = await getOne(`/m/${GROUP}/pipelines/${encodeURIComponent(p.id)}`);
      if (have) {
        note("pipeline", p.id, "unchanged");
      } else {
        log(
          `pipeline ${p.id}: not created. Its functions are Cribl's pack content (${p.fromPack.pack} ${p.fromPack.version}, pipeline ${p.fromPack.pipeline}), not shipped here: install the pack from the Cribl Dispensary and route through it, or import that pipeline as ${p.id} yourself.`,
        );
        results.missingPacks = [...(results.missingPacks ?? []), `${p.id} (${p.fromPack.pack})`];
      }
      continue;
    }
    const conf = brokenTrims.has(p.id)
      ? {
          ...p.conf,
          functions: p.conf.functions.map((f) =>
            (f.description ?? "").includes("[mr-trim]")
              ? { ...f, disabled: true }
              : f,
          ),
        }
      : p.conf;
    const obj = { id: p.id, conf };
    const what = DRY
      ? "unchanged"
      : await upsert("pipeline", `/m/${GROUP}/pipelines`, obj, {
          describe: (o) => o.conf?.description,
        });
    note("pipeline", p.id, what);
  }
}

async function applySamples() {
  for (const m of rig.manifest.samples) {
    const body = sampleBody(m);
    assertOurs("sample", body.id, body.description);
    const path = `/m/${GROUP}/system/samples/${encodeURIComponent(body.id)}`;
    const have = await getOne(path);
    if (DRY) {
      note("sample", body.id, have ? "unchanged" : "created");
      continue;
    }
    if (!have) {
      await call("POST", `/m/${GROUP}/system/samples`, body);
      note("sample", body.id, "created");
      continue;
    }
    assertOurs("sample", have.id, have.description);
    if (
      have.sampleName === body.sampleName &&
      have.description === body.description &&
      have.isTemplate === true &&
      Number(have.numEvents) === m.events
    ) {
      note("sample", body.id, "unchanged");
      continue;
    }
    // PATCH replaces the record: carry the original creation time forward.
    await call(
      "PATCH",
      path,
      have.created !== undefined ? { ...body, created: have.created } : body,
    );
    note("sample", body.id, "updated");
  }
}

async function applySources(nodes) {
  const out = [];
  for (const s of rig.sources.sources) {
    const input = inputFor(s, nodes);
    out.push({ id: s.id, eventsPerSec: input.samples[0].eventsPerSec });
    const what = DRY
      ? "unchanged"
      : await upsert("input", `/m/${GROUP}/system/inputs`, input);
    note("input", s.id, what);
  }
  return out;
}

async function applyRoutes() {
  const table = await getOne(`/m/${GROUP}/routes/default`);
  if (!table) throw new Error("route table default not found");
  const ours = rig.sources.sources.map(routeFor);
  for (const r of ours) assertOurs("route", r.id, r.description);
  const existingOurs = table.routes.filter((r) =>
    String(r.id).startsWith(PREFIX),
  );
  for (const r of existingOurs) assertOurs("route", r.id, r.description);
  const others = table.routes.filter((r) => !String(r.id).startsWith(PREFIX));
  // Our routes go on top, in definition order; every other route is sent back exactly as read.
  const next = [...ours, ...others];
  const same =
    table.routes.length === next.length &&
    next.every((r, i) => covers(table.routes[i], r));
  if (same) {
    note("routes", "default", "unchanged");
    return;
  }
  if (DRY) {
    note("routes", "default", "updated");
    return;
  }
  const body = { id: table.id, routes: next };
  if (table.groups !== undefined) body.groups = table.groups;
  if (table.comments !== undefined) body.comments = table.comments;
  await call("PATCH", `/m/${GROUP}/routes/${table.id}`, body);
  note("routes", "default", existingOurs.length ? "updated" : "created");
}

/** demo/rig/throttles.json: the Throttle panel's per-source baselines at the applied rate (SPEC 11 demoSetRate). */
function writeThrottles(rates, nodes) {
  const sources = {};
  for (const s of rig.sources.sources) {
    const bytesPerEvent =
      s.bytesPerEvent ?? rig.samples[s.sampleKey].avgEventBytes;
    const eps = rates.find((r) => r.id === s.id).eventsPerSec;
    sources[s.id] = {
      baselineEventsPerSec: eps,
      bytesPerEvent,
      baselineGbPerDay:
        Math.round((eps * nodes * bytesPerEvent * 86_400) / 1e8) / 10,
      spikeMultiplier: 5,
      calmMultiplier: 1,
    };
  }
  const doc = {
    schemaVersion: 1,
    note: "Per-source Throttle panel limits (PRD 9 Lever 2, SPEC 11 demoSetRate). baselineEventsPerSec is the rig rate per Worker Node at sources.json rateFactor; demoSetRate sets eventsPerSec = round(baseline x multiplier), 0.1 <= multiplier <= 10. Regenerated by scripts/rig/apply.mjs --write-throttles.",
    rateFactor: factor,
    workerNodes: nodes,
    minMultiplier: 0.1,
    maxMultiplier: 10,
    sources,
  };
  writeFileSync(
    join(RIG_DIR, "throttles.json"),
    JSON.stringify(doc, null, 2) + "\n",
  );
  log(`wrote ${join(RIG_DIR, "throttles.json")}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const nodes = await workerNodes(GROUP);
if (nodes < 1) throw new Error(`no connected Worker Nodes in group ${GROUP}`);
log(
  `group ${GROUP}: ${nodes} worker node(s); rate factor ${factor}; datagen sample field "${sampleField}"${DRY ? " (dry run)" : ""}`,
);
const before = await pendingFiles(GROUP);
if (!loadBaseline() && !before.some((p) => RIG_PATH.test(p) || /mrd_/.test(p)))
  saveBaseline(GROUP, before);

if (!flag("--commit-only")) {
  await applyDestinations();
  await applyPipelines();
  await applySamples();
  const rates = await applySources(nodes);
  await applyRoutes();
  log(JSON.stringify({ results, rates }, null, 2));
  if (flag("--write-throttles")) writeThrottles(rates, nodes);
}

if (flag("--plan-commit") || flag("--commit")) {
  await runCommit(GROUP, {
    message: MESSAGE,
    commit: flag("--commit"),
    deploy: flag("--deploy"),
    accept: (opt("--accept-reserialization") ?? "").split(",").filter(Boolean),
    excludeBlocked: flag("--exclude-blocked"),
    includeGroupKey: flag("--include-group-key"),
  });
}
