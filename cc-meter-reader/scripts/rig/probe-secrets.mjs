#!/usr/bin/env node
// Can this group's Workers decrypt values the Leader encrypted at rest (`#42:…`)? — a self-cleaning probe.
//
//   node scripts/rig/probe-secrets.mjs
//
// Why: any write to inputs.yml makes the Leader re-serialize the whole file and re-encrypt every secret
// in it (here: the default HEC Source's token). If Workers cannot decrypt, committing inputs.yml would
// break that Source, so the rig refuses to (docs/RIG.md "Blocker"). This probe answers the question
// with rig-only objects: it creates a demo-tagged Webhook Destination `mrd_probe_secret` whose Bearer
// token is a dummy value, commits and deploys outputs.yml (rig-only file), asks the Worker to send one
// test event to a fresh webhook.site URL, reads the Authorization header that arrived, then deletes the
// Destination and commits + deploys again. It prints DECRYPTS or DOES NOT DECRYPT. No real secret is
// ever read or sent; the dummy token is the only credential involved.
import { api } from "../cribl-api.mjs";
import { call, commit, deploy, getOne, sleep } from "./lib.mjs";

const GROUP = "default";
const ID = "mrd_probe_secret";
const DUMMY = `mrd-probe-dummy-${Date.now().toString(36)}`;
const OUTPUTS = `groups/${GROUP}/local/cribl/outputs.yml`;

async function workerId() {
  const j = await call("GET", "/master/workers");
  const w = (j.items ?? []).find((x) => x.group === GROUP && !x.disconnected);
  if (!w) throw new Error(`no connected Worker in ${GROUP}`);
  return w.id;
}

async function commitOutputsOnly(message) {
  const st = (await call("GET", `/m/${GROUP}/version/status`)).items?.[0] ?? {};
  if (!(st.files ?? []).some((f) => f.path === OUTPUTS))
    throw new Error("outputs.yml is not pending; refusing to commit");
  const hash = await commit(GROUP, [OUTPUTS], message);
  await deploy(GROUP, hash);
  return hash;
}

const hook = await (
  await fetch("https://webhook.site/token", {
    method: "POST",
    headers: { accept: "application/json" },
  })
).json();
if (!hook.uuid) throw new Error("webhook.site did not issue a token");
const wid = await workerId();
let verdict = "UNKNOWN";
try {
  if (await getOne(`/m/${GROUP}/system/outputs/${ID}`))
    throw new Error(`${ID} already exists; remove it first`);
  await call("POST", `/m/${GROUP}/system/outputs`, {
    id: ID,
    type: "webhook",
    method: "POST",
    format: "ndjson",
    url: `https://webhook.site/${hook.uuid}`,
    authType: "token",
    token: DUMMY,
    onBackpressure: "drop",
    streamtags: ["meter-reader-demo"],
    description:
      "[meter-reader-demo] Temporary probe: does a Worker decrypt Leader-encrypted (#42:) values? Removed by the probe.",
  });
  const c1 = await commitOutputsOnly(
    `demo: temporary probe ${ID} (worker secret decryption check)`,
  );
  console.log(
    `probe destination committed ${c1} and deployed; waiting for the Worker to load it`,
  );
  // Wait until the Worker runs the probe's commit (info.cribl.config.version) AND serves the probe.
  // A test sent while the Worker is still reloading goes nowhere (the first runs after D19 printed
  // NO REQUEST RECEIVED for exactly that reason), so settle a little longer, then retry the test.
  const t0 = Date.now();
  const short = c1.slice(0, 7);
  for (;;) {
    const w = ((await call("GET", "/master/workers")).items ?? []).find(
      (x) => x.id === wid,
    );
    const running = String(w?.info?.cribl?.config?.version ?? "");
    const served =
      running.startsWith(short) &&
      (await call("GET", `/w/${wid}/system/outputs`)).items?.some(
        (o) => o.id === ID,
      );
    if (served) break;
    if (Date.now() - t0 > 240_000)
      throw new Error(
        `the Worker did not load the probe within 4 minutes (running ${running || "?"})`,
      );
    await sleep(5000);
  }
  console.log(
    `the Worker runs ${short} after ${Math.round((Date.now() - t0) / 1000)} s; settling 15 s`,
  );
  await sleep(15_000);
  let auth = "";
  for (let attempt = 1; attempt <= 3 && !auth; attempt++) {
    const r = await api("POST", `/w/${wid}/system/outputs/${ID}/test`, {
      events: [
        {
          _raw: "meter-reader rig probe: worker secret decryption check",
          _time: Math.floor(Date.now() / 1000),
        },
      ],
    });
    console.log(`test event ${attempt}: HTTP ${r.status}`);
    for (let i = 0; i < 12 && !auth; i++) {
      await sleep(5000);
      const got = await (
        await fetch(
          `https://webhook.site/token/${hook.uuid}/requests?sorting=newest`,
          { headers: { accept: "application/json" } },
        )
      ).json();
      auth = String(got.data?.[0]?.headers?.authorization?.[0] ?? "");
    }
  }
  verdict = !auth
    ? "NO REQUEST RECEIVED"
    : auth === `Bearer ${DUMMY}`
      ? "DECRYPTS"
      : auth.includes("#42:")
        ? "DOES NOT DECRYPT"
        : "UNEXPECTED HEADER";
} finally {
  if (await getOne(`/m/${GROUP}/system/outputs/${ID}`)) {
    await call("DELETE", `/m/${GROUP}/system/outputs/${ID}`);
    const c2 = await commitOutputsOnly(`demo: remove temporary probe ${ID}`);
    console.log(`probe destination removed, committed ${c2} and deployed`);
  }
}
console.log(`Worker secret decryption: ${verdict}`);
