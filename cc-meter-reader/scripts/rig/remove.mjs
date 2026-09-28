#!/usr/bin/env node
// Remove the Meter Reader demo rig — ONLY objects whose id starts with `mrd_` AND whose description
// carries `[meter-reader-demo]` (SPEC 2). Everything else in the group is left exactly as it is.
//
//   node scripts/rig/remove.mjs                        # list what would be removed (touches nothing)
//   node scripts/rig/remove.mjs --yes                  # remove (pending changes only)
//   node scripts/rig/remove.mjs --yes --commit --deploy [--accept-reserialization inputs.yml] [--exclude-blocked]
//
// Order: routes → sources → pipelines (chaining pipelines before the ones they chain) → destinations →
// samples, so nothing is deleted while something still references it. Commits use the same explicit,
// diff-attributed file list as apply.mjs (lib.planCommit).
import { PREFIX, TOKEN, loadRig, call, getOne, runCommit } from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const YES = flag("--yes");

const rig = loadRig();
const GROUP = rig.sources.groupId;
const ours = (id, description) =>
  String(id).startsWith(PREFIX) && String(description ?? "").includes(TOKEN);
const list = async (path) => (await call("GET", path)).items ?? [];

// ─── Discover (read-only) ───────────────────────────────────────────────────
const table = await getOne(`/m/${GROUP}/routes/default`);
const routes = (table?.routes ?? []).filter((r) => ours(r.id, r.description));
const inputs = (await list(`/m/${GROUP}/system/inputs`)).filter((i) =>
  ours(i.id, i.description),
);
const pipelines = (await list(`/m/${GROUP}/pipelines`)).filter((p) =>
  ours(p.id, p.conf?.description),
);
const outputs = (await list(`/m/${GROUP}/system/outputs`)).filter((o) =>
  ours(o.id, o.description),
);
const samples = (await list(`/m/${GROUP}/system/samples`)).filter((s) =>
  ours(s.id, s.description),
);
// Pipelines that chain others go first.
pipelines.sort(
  (a, b) =>
    Number((b.conf?.functions ?? []).some((f) => f.id === "chain")) -
    Number((a.conf?.functions ?? []).some((f) => f.id === "chain")),
);

const plan = {
  routes: routes.map((r) => r.id),
  inputs: inputs.map((i) => i.id),
  pipelines: pipelines.map((p) => p.id),
  outputs: outputs.map((o) => o.id),
  samples: samples.map((s) => s.id),
};
console.log(JSON.stringify({ group: GROUP, willRemove: plan }, null, 2));
if (!YES) {
  console.log("dry run: pass --yes to remove exactly the objects listed above");
  process.exit(0);
}

// ─── Remove ──────────────────────────────────────────────────────────────────
if (routes.length) {
  const keep = table.routes.filter((r) => !ours(r.id, r.description)); // every other route exactly as read
  const body = { id: table.id, routes: keep };
  if (table.groups !== undefined) body.groups = table.groups;
  if (table.comments !== undefined) body.comments = table.comments;
  await call("PATCH", `/m/${GROUP}/routes/${table.id}`, body);
  console.log(`removed ${routes.length} route(s)`);
}
for (const i of inputs) {
  await call("DELETE", `/m/${GROUP}/system/inputs/${encodeURIComponent(i.id)}`);
  console.log("removed input", i.id);
}
for (const p of pipelines) {
  await call("DELETE", `/m/${GROUP}/pipelines/${encodeURIComponent(p.id)}`);
  console.log("removed pipeline", p.id);
}
for (const o of outputs) {
  await call(
    "DELETE",
    `/m/${GROUP}/system/outputs/${encodeURIComponent(o.id)}`,
  );
  console.log("removed output", o.id);
}
for (const s of samples) {
  await call(
    "DELETE",
    `/m/${GROUP}/system/samples/${encodeURIComponent(s.id)}`,
  );
  console.log("removed sample", s.id);
}

if (flag("--commit")) {
  await runCommit(GROUP, {
    message: opt("--message") ?? "demo: remove the Meter Reader rig",
    commit: true,
    deploy: flag("--deploy"),
    accept: (opt("--accept-reserialization") ?? "").split(",").filter(Boolean),
    excludeBlocked: flag("--exclude-blocked"),
    includeGroupKey: flag("--include-group-key"),
  });
}
