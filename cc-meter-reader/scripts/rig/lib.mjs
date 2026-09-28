// Shared helpers for the Meter Reader demo rig scripts (apply / verify / remove).
//
// Safety model (SPEC 2): the rig only ever creates, changes or removes objects whose id starts with
// `mrd_` AND whose description carries `[meter-reader-demo]`. Every write goes through `assertOurs`,
// the route table is edited by splicing only `mrd_` routes, and commits always pass an explicit file
// list that is checked against the pending changes seen before the rig touched anything.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "../cribl-api.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RIG_DIR = join(ROOT, "demo", "rig");
export const TOKEN = "[meter-reader-demo]";
export const PREFIX = "mrd_";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Loads and cross-checks the rig definition (demo/rig/*.json + the samples manifest). */
export function loadRig() {
  const sources = readJson(join(RIG_DIR, "sources.json"));
  const pipelines = readJson(join(RIG_DIR, "pipelines.json")).pipelines;
  const destinations = readJson(
    join(RIG_DIR, "destinations.json"),
  ).destinations;
  const manifest = readJson(join(RIG_DIR, "samples", "manifest.json"));
  const samples = Object.fromEntries(manifest.samples.map((s) => [s.key, s]));
  const pipeIds = new Set(pipelines.map((p) => p.id));
  const outIds = new Set(destinations.map((d) => d.id));
  const problems = [];
  const check = (cond, msg) => {
    if (!cond) problems.push(msg);
  };
  for (const p of pipelines) {
    check(
      p.id.startsWith(PREFIX),
      `pipeline ${p.id}: id must start with ${PREFIX}`,
    );
    check(
      (p.conf.description ?? "").includes(TOKEN),
      `pipeline ${p.id}: conf.description lacks ${TOKEN}`,
    );
    const trims = p.conf.functions.filter((f) =>
      (f.description ?? "").includes("[mr-trim]"),
    );
    check(
      trims.length <= 1,
      `pipeline ${p.id}: more than one [mr-trim] function`,
    );
    for (const f of p.conf.functions)
      if (f.id === "chain")
        check(
          pipeIds.has(f.conf.processor),
          `pipeline ${p.id}: chains unknown ${f.conf.processor}`,
        );
  }
  for (const d of destinations) {
    check(
      d.id.startsWith(PREFIX) && d.output.id === d.id,
      `destination ${d.id}: bad id`,
    );
    check(
      (d.output.description ?? "").includes(TOKEN),
      `destination ${d.id}: description lacks ${TOKEN}`,
    );
  }
  for (const s of sources.sources) {
    check(
      s.id.startsWith(PREFIX) && s.route.id.startsWith(PREFIX),
      `source ${s.id}: ids must start with ${PREFIX}`,
    );
    check(
      s.description.includes(TOKEN),
      `source ${s.id}: description lacks ${TOKEN}`,
    );
    check(
      Boolean(samples[s.sampleKey]),
      `source ${s.id}: unknown sample ${s.sampleKey}`,
    );
    check(
      pipeIds.has(s.route.pipeline),
      `source ${s.id}: unknown pipeline ${s.route.pipeline}`,
    );
    for (const k of ["packPipeline", "aggressivePipeline", "trimPipeline"])
      if (s[k])
        check(pipeIds.has(s[k]), `source ${s.id}: unknown ${k} ${s[k]}`);
    check(
      outIds.has(s.route.output),
      `source ${s.id}: unknown output ${s.route.output}`,
    );
  }
  for (const m of manifest.samples)
    check(
      m.sampleId.startsWith(PREFIX) && m.description.includes(TOKEN),
      `sample ${m.key}: not demo-tagged`,
    );
  if (problems.length)
    throw new Error("rig definition invalid:\n  " + problems.join("\n  "));
  return { sources, pipelines, destinations, manifest, samples };
}

/** Refuses to touch anything that is not a demo object. */
export function assertOurs(kind, id, description) {
  if (!String(id).startsWith(PREFIX))
    throw new Error(
      `refusing to modify ${kind} ${id}: id does not start with ${PREFIX}`,
    );
  if (description !== undefined && !String(description ?? "").includes(TOKEN)) {
    throw new Error(
      `refusing to modify ${kind} ${id}: description lacks ${TOKEN}`,
    );
  }
}

/** Reads are retried on network errors (DNS blips were seen); writes never are. */
const READ_ONLY_POST = /^\/system\/(metrics\/query|capture)$/;
async function apiRetrying(method, path, body) {
  const retry = method === "GET" || (method === "POST" && READ_ONLY_POST.test(path));
  for (let attempt = 1; ; attempt++) {
    try {
      return await api(method, path, body);
    } catch (e) {
      if (!retry || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/** Throws with context on any non-2xx answer. */
export async function call(method, path, body) {
  const r = await apiRetrying(method, path, body);
  if (r.status < 200 || r.status >= 300) {
    const msg =
      typeof r.json === "string"
        ? r.json
        : (r.json?.message ?? JSON.stringify(r.json));
    const err = new Error(
      `${method} ${path} → HTTP ${r.status}: ${String(msg).slice(0, 400)}`,
    );
    err.status = r.status;
    throw err;
  }
  return r.json;
}

/** GET a single config object; null on 404. */
export async function getOne(path) {
  const r = await apiRetrying("GET", path);
  if (r.status === 404) return null;
  if (r.status !== 200)
    throw new Error(
      `GET ${path} → HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`,
    );
  return r.json?.items?.[0] ?? null;
}

/** Deep-equal on the keys `want` defines (server-added defaults on `have` are ignored). */
export function covers(have, want) {
  if (want === null || typeof want !== "object") return have === want;
  if (Array.isArray(want))
    return (
      Array.isArray(have) &&
      have.length === want.length &&
      want.every((w, i) => covers(have[i], w))
    );
  if (have === null || typeof have !== "object") return false;
  return Object.keys(want).every((k) => covers(have[k], want[k]));
}

/**
 * Idempotent upsert of a config object at `${collection}/${id}`: POST when absent, PATCH the full object
 * (existing fields carried forward, ours overlaid; PATCH replaces the whole object) when it differs.
 */
export async function upsert(
  kind,
  collection,
  obj,
  { describe = (o) => o.description } = {},
) {
  assertOurs(kind, obj.id, describe(obj));
  const path = `${collection}/${encodeURIComponent(obj.id)}`;
  const have = await getOne(path);
  if (!have) {
    await call("POST", collection, obj);
    return "created";
  }
  assertOurs(kind, have.id, describe(have));
  if (covers(have, obj)) return "unchanged";
  const {
    criblSourceProvenance: _p,
    status: _s,
    notifications: _n,
    ...rest
  } = have;
  await call("PATCH", path, { ...rest, ...obj });
  return "updated";
}

/** Number of connected Worker Nodes in a group (Datagen rates are per node). */
export async function workerNodes(groupId) {
  const j = await call("GET", "/master/workers");
  return (j.items ?? []).filter((w) => w.group === groupId && !w.disconnected)
    .length;
}

/** Pending (uncommitted) config files, as `version/status` names them. */
export async function pendingFiles(groupId) {
  const j = await call("GET", `/m/${groupId}/version/status`);
  const st = j.items?.[0] ?? {};
  return [...new Set((st.files ?? []).map((f) => f.path))].sort();
}

/**
 * Structured working-tree diff (`GET /version/diff` with no commit and no filename; the `filename`
 * parameter is not a reliable filter). Returns `{ [path]: blocks }` for the requested paths only.
 * SECURITY: the full response also carries the group's secret files (auth/cribl.secret, users.json,
 * secrets.yml). It is filtered here and must never be logged or written anywhere.
 */
export async function workingDiff(groupId, paths) {
  const want = new Set(paths);
  const j = await call("GET", `/m/${groupId}/version/diff?diffLineLimit=0`);
  const out = {};
  for (const it of j.items ?? [])
    for (const d of it.diffJson ?? [])
      if (want.has(d.newName)) out[d.newName] = d.blocks ?? [];
  return out;
}

/**
 * Attributes every changed line of a YAML diff (Cribl `diffJson` blocks) to the config object that
 * owns it. Ownership is indentation-aware: a line's ancestors are the nearest preceding lines in the
 * same hunk with strictly smaller indentation (a `- ` list marker counts as indentation for the
 * item's other keys). The owner is the first ancestor-or-self that names an object:
 *   inputs.yml / outputs.yml  `  <id>:` under `inputs:` / `outputs:`
 *   samples.yml               `<id>:` at column 0
 *   pipelines/route.yml       `  - id: <id>` under `routes:`
 * Returns `{ owners: Set<string>, structural: number, unattributed: number, loose: [{type, key, value}] }`
 * (`loose` = the unattributed changed lines' own key and value, kept in memory only, never printed);
 * structural lines are
 * the containers themselves (`inputs:`, `outputs:`, `routes:`, `id: default`), e.g. in a new file.
 */
export function attributeDiff(path, blocks) {
  const kind = /inputs\.yml$/.test(path)
    ? "inputs"
    : /outputs\.yml$/.test(path)
      ? "outputs"
      : /samples\.yml$/.test(path)
        ? "samples"
        : /route\.yml$/.test(path)
          ? "routes"
          : null;
  const owners = new Set();
  let structural = 0;
  let unattributed = 0;
  const loose = [];
  const indentOf = (t) => {
    const m = t.match(/^(\s*)(-\s+)?/);
    return { indent: m[1].length, isItem: Boolean(m[2]) };
  };
  const ownerOf = (t, depthIndent) => {
    const key = t.match(/^\s*([A-Za-z0-9_.-]+):/);
    const item = t.match(/^\s*-\s+id:\s*["']?([^"'\s]+)["']?\s*$/);
    if (kind === "routes" && item && depthIndent.indent === 2) return item[1];
    if (
      (kind === "inputs" || kind === "outputs") &&
      key &&
      depthIndent.indent === 2 &&
      !depthIndent.isItem
    )
      return key[1];
    if (kind === "samples" && key && depthIndent.indent === 0) return key[1];
    return null;
  };
  for (const b of blocks) {
    const stack = []; // [{ indent, owner }]
    // git puts the nearest preceding column-0 line in the hunk header ("@@ -3,34 +3,34 @@ mrd_x:"),
    // which names the owner when the hunk's own context lines start inside that object.
    const ctx = String(b.header ?? "").match(/^@@[^@]*@@\s?(.*)$/)?.[1] ?? "";
    if (ctx.trim())
      stack.push({
        indent: -1,
        owner: ownerOf(ctx, { indent: 0, isItem: false }),
      });
    for (const l of b.lines ?? []) {
      const text = String(l.content ?? "").slice(1);
      if (!text.trim()) continue;
      const d = indentOf(text);
      while (stack.length && stack[stack.length - 1].indent >= d.indent)
        stack.pop();
      const self = ownerOf(text, d);
      const inherited =
        [...stack].reverse().find((s) => s.owner)?.owner ?? null;
      const owner = self ?? inherited;
      // A list item's keys are indented past its "- " marker, so they stay under it; the next sibling
      // item, at the marker's own indentation, pops it.
      stack.push({ indent: d.indent, owner });
      if (l.type === "insert" || l.type === "delete") {
        if (owner) owners.add(owner);
        else if (
          /^(inputs|outputs|routes|groups|comments):\s*(\[\]|\{\})?\s*$/.test(
            text,
          ) ||
          /^id:\s*default\s*$/.test(text)
        )
          structural++;
        else {
          unattributed++;
          const kv = text.match(/^\s*(?:-\s+)?([A-Za-z0-9_.-]+):\s*(.*)$/);
          loose.push({ type: l.type, key: kv?.[1] ?? null, value: kv?.[2] ?? null });
        }
      }
    }
  }
  return { owners, structural, unattributed, loose };
}

// ─── Commit safety ───────────────────────────────────────────────────────────

export const SHARED =
  /(^|\/)(inputs\.yml|outputs\.yml|samples\.yml|pipelines\/route\.yml)$/;
/** Files that only the rig ever writes: its pipelines and its sample files. */
export const RIG_PATH = /\/(pipelines|samples)\/mrd_[^/]*(\/conf\.yml|\.json)$/;
const BASELINE_FILE = join(
  ROOT,
  "node_modules",
  ".cache",
  "mr-rig-baseline.json",
);

/**
 * The pending files that existed before the rig first wrote anything, recorded once while no rig path
 * was pending. A shared file that was already pending then holds someone else's work and is never ours.
 */
export function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  } catch {
    return null;
  }
}
export function saveBaseline(groupId, pending) {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(
    BASELINE_FILE,
    JSON.stringify(
      { recordedAt: new Date().toISOString(), group: groupId, pending },
      null,
      2,
    ),
  );
}

/**
 * A hunk that starts inside an object (git's 3 context lines do not reach its `  <id>:` line, and the
 * hunk header names only `inputs:`) leaves its changed lines without an owner, e.g. a rate change,
 * which touches only `eventsPerSec`. Such lines are still provably the rig's when (1) every line is a
 * `key: value` line, (2) every Source in the group that has that key anywhere is an `mrd_` Source, and
 * (3) for `eventsPerSec`, every inserted value is the rate an `mrd_` Source has now. Anything else
 * stays unattributed (and blocks the commit).
 */
async function resolveLooseInputLines(groupId, loose) {
  if (!loose.length || loose.some((l) => !l.key)) return { ok: false };
  const items = (await call("GET", `/m/${groupId}/system/inputs`)).items ?? [];
  const hasKey = (o, k) =>
    o !== null &&
    typeof o === "object" &&
    (Object.prototype.hasOwnProperty.call(o, k) ||
      Object.values(o).some((v) => hasKey(v, k)));
  const owners = new Set();
  for (const k of new Set(loose.map((l) => l.key))) {
    const holders = items.filter((i) => hasKey(i, k)).map((i) => String(i.id));
    if (!holders.length || holders.some((id) => !id.startsWith(PREFIX)))
      return { ok: false };
    for (const h of holders) owners.add(h);
  }
  const rigRates = new Set(
    items
      .filter((i) => String(i.id).startsWith(PREFIX))
      .flatMap((i) => (i.samples ?? []).map((x) => String(x.eventsPerSec))),
  );
  for (const l of loose)
    if (l.key === "eventsPerSec" && l.type === "insert" && !rigRates.has(String(l.value).trim()))
      return { ok: false };
  return { ok: true, owners };
}

/**
 * The route-table twin of resolveLooseInputLines: a hunk inside a route item whose `- id:` line is out
 * of git's context. Only `pipeline:` lines qualify, and only when the old and the new value are both
 * rig pipelines and every route in the table that references an `mrd_` pipeline is an `mrd_` route
 * (so no other route can own the line).
 */
async function resolveLooseRouteLines(groupId, loose) {
  if (!loose.length || loose.some((l) => l.key !== "pipeline")) return { ok: false };
  const table = await getOne(`/m/${groupId}/routes/default`);
  const routes = table?.routes ?? [];
  const values = loose.map((l) => String(l.value ?? "").trim().replace(/^["']|["']$/g, ""));
  if (values.some((v) => !v.startsWith(PREFIX))) return { ok: false };
  const users = routes.filter((r) => String(r.pipeline ?? "").startsWith(PREFIX));
  if (users.some((r) => !String(r.id).startsWith(PREFIX))) return { ok: false };
  return { ok: true, owners: new Set(users.map((r) => String(r.id))) };
}

/**
 * Decides the explicit commit list. Rig paths (pipelines/mrd_*, data/samples/mrd_*) are always ours.
 * A shared file (inputs.yml, outputs.yml, samples.yml, pipelines/route.yml) is ours when every changed
 * line belongs to an `mrd_` object; when its only other changes are the Leader's re-serialization of
 * objects the rig never touched (defaults materialized into local/, secrets re-encrypted at rest) it is
 * included only if it was clean in the baseline AND named in `accept`. Everything else is `blocked`.
 */
export async function planCommit(
  groupId,
  { accept = [], includeGroupKey = false } = {},
) {
  const pending = await pendingFiles(groupId);
  const baseline = new Set(loadBaseline()?.pending ?? []);
  const acceptSet = new Set(accept);
  const shared = pending.filter((p) => SHARED.test(p));
  const diffs = await workingDiff(groupId, shared);
  const commitFiles = pending.filter((p) => RIG_PATH.test(p));
  const blocked = [];
  const accepted = [];
  for (const p of shared) {
    const name = p.split("/").slice(-2).join("/");
    const short = p.split("/").pop();
    if (baseline.has(p)) {
      blocked.push({
        file: p,
        reason: "already pending before the rig ran (someone else's change)",
      });
      continue;
    }
    if (!diffs[p]) {
      blocked.push({ file: p, reason: "no diff available" });
      continue;
    }
    const a = attributeDiff(p, diffs[p]);
    const foreign = [...a.owners].filter((o) => !String(o).startsWith(PREFIX));
    if (a.unattributed) {
      const resolved = /inputs\.yml$/.test(p)
        ? await resolveLooseInputLines(groupId, a.loose)
        : /route\.yml$/.test(p)
          ? await resolveLooseRouteLines(groupId, a.loose)
          : { ok: false };
      if (resolved.ok) {
        for (const o of resolved.owners) a.owners.add(o);
        a.unattributed = 0;
      }
    }
    if (a.unattributed) {
      blocked.push({
        file: p,
        reason: `${a.unattributed} changed line(s) not attributable to an object`,
      });
      continue;
    }
    if (!foreign.length) {
      commitFiles.push(p);
      continue;
    }
    if (acceptSet.has(name) || acceptSet.has(short) || acceptSet.has(p)) {
      commitFiles.push(p);
      accepted.push({ file: p, reserialized: foreign });
      continue;
    }
    blocked.push({
      file: p,
      reason: `diff also touches non-rig objects: ${foreign.join(", ")}`,
    });
  }
  // The Leader re-encrypts secrets (#42:…) whenever it re-serializes a file, and a Worker decrypts them
  // only with the group key, which reaches Workers in the config bundle only once it is committed
  // (measured; docs/RIG.md "Blocker"). Committing it is the org owner's decision; this option exists so
  // the authorized run is one command. Never pass it without that explicit OK.
  if (includeGroupKey && accepted.some((x) => /inputs\.yml$/.test(x.file))) {
    const key = `groups/${groupId}/local/cribl/auth/cribl.secret`;
    if (pending.includes(key)) {
      commitFiles.push(key);
      accepted.push({
        file: key,
        reason:
          "group encryption key, so Workers can decrypt the secrets the Leader re-encrypted in inputs.yml",
      });
    }
  }
  const sorted = [...new Set(commitFiles)].sort();
  return {
    pending,
    commitFiles: sorted,
    blocked,
    accepted,
    otherPending: pending.filter((p) => !sorted.includes(p)),
  };
}

/** Plans, prints and (optionally) commits + deploys; exits 2 when blocked files would be skipped silently. */
export async function runCommit(
  groupId,
  {
    message,
    commit: doCommit,
    deploy: doDeploy,
    accept,
    excludeBlocked,
    includeGroupKey,
  },
) {
  const plan = await planCommit(groupId, { accept, includeGroupKey });
  console.log(
    JSON.stringify(
      {
        commitFiles: plan.commitFiles,
        accepted: plan.accepted,
        blocked: plan.blocked,
        otherPending: plan.otherPending,
      },
      null,
      2,
    ),
  );
  if (!doCommit) return null;
  if (plan.blocked.length && !excludeBlocked) {
    console.error(
      'STOP: a shared config file has changes that are not the rig\'s; nothing was committed (see "blocked").',
    );
    process.exit(2);
  }
  if (!plan.commitFiles.length) {
    console.log("nothing of the rig is pending; no commit");
    return null;
  }
  const hash = await commit(groupId, plan.commitFiles, message);
  console.log(`committed ${hash} (${plan.commitFiles.length} files)`);
  if (doDeploy)
    console.log(
      `deployed ${hash} to ${groupId} via ${await deploy(groupId, hash)}`,
    );
  return hash;
}

/** Commit exactly `files` with `message`; returns the commit hash. */
export async function commit(groupId, files, message) {
  if (!files.length)
    throw new Error(
      "refusing to commit an empty file list (that would commit every pending change)",
    );
  const j = await call("POST", `/m/${groupId}/version/commit`, {
    message,
    files,
    effective: true,
  });
  const hash = j.items?.[0]?.commit;
  if (!hash)
    throw new Error(
      `commit returned no hash: ${JSON.stringify(j).slice(0, 300)}`,
    );
  return hash;
}

/** Deploy a commit to a Worker Group (products path, legacy master path on 404). */
export async function deploy(groupId, version) {
  let r = await api("PATCH", `/products/stream/groups/${groupId}/deploy`, {
    version,
  });
  let via = "products";
  if (r.status === 404) {
    r = await api("PATCH", `/master/groups/${groupId}/deploy`, { version });
    via = "master";
  }
  if (r.status < 200 || r.status >= 300)
    throw new Error(
      `deploy ${version} → HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`,
    );
  return via;
}

/**
 * `POST /system/metrics/query` over an absolute window, bucketed per `bucketSec`, rollup rows dropped
 * (a row counts only when every split key is a string).
 */
export async function metrics({
  groupId,
  aggregations,
  splitBys = [],
  earliestMs,
  latestMs,
  bucketSec = 60,
  where,
}) {
  const body = {
    where: where ?? `__worker_group=='${groupId}'`,
    aggs: { aggregations, splitBys, timeWindowSeconds: bucketSec },
    earliest: earliestMs,
    latest: latestMs,
  };
  const j = await call("POST", "/system/metrics/query", body);
  return (j.results ?? []).filter((row) =>
    splitBys.every((k) => typeof row[k] === "string"),
  );
}

/** eventsPerSec per Worker Node for a source at `factor` of its design rate. */
export function eventsPerSec(source, bytesPerEvent, factor, nodes) {
  const bytesPerSec = (source.targetGbPerDay * factor * 1e9) / 86_400;
  return Math.max(
    1,
    Math.round(bytesPerSec / bytesPerEvent / Math.max(1, nodes)),
  );
}

/** Bytes over a window → GB/day. */
export const gbPerDay = (bytes, seconds) =>
  seconds > 0 ? ((bytes / seconds) * 86_400) / 1e9 : 0;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
