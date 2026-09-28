#!/usr/bin/env -S npx tsx
// scripts/record-replay.ts — record demo/sample/replay.json from a REAL break → alert → restore run in the
// live org (SPEC 15: "replay.json is the same shape [as tour.json] recorded from a real run"). The Replay
// toggle and Story mode's live cut (story-live.json, via scripts/story.ts) play it back with the real
// timings, numbers, commit and author, so the stage fallback never disagrees with reality.
//
// Needs the runner sweeping (scripts/runner.ts). Pulls the levers through core/demo/levers.ts (demo-tagged
// objects only). Usage: npx tsx scripts/record-replay.ts [--hold 30]
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { breakTrim, restoreTrim } from '../core/demo/levers.ts';
import { leverDepsFrom } from '../core/runtime.ts';
import { createKvDocs } from '../core/kv.ts';
import { compactSnapshot } from '../core/snapshot.ts';
import { allCommits } from '../core/timeline.ts';
import { canonicalPayload, payloadFor } from '../core/payloads.ts';
import type { Commit, DeliveryLog, Incident, Snapshot, TourStep } from '../core/types.ts';
import { deps } from './runner.ts';
import { leaks, redactRecording } from './redact-recording.ts';
// @ts-expect-error — plain ESM helper without type declarations
import { loadEnv } from './cribl-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'demo', 'sample', 'replay.json');
const PIPE = 'mrd_pay_sample';
const OBJ = 'route:default:mrd_payments_api';
const HOLD_SEC = process.argv.includes('--hold') ? Number(process.argv[process.argv.indexOf('--hold') + 1]) : 30;
const SNAPSHOT_BYTES = 45_000;
const author = process.env.MR_DEMO_AUTHOR || 's.koelpin';

const d = deps();
const docs = createKvDocs({ kv: d.kv, codec: d.codec, clock: d.clock });
const lever = leverDepsFrom(d, author);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const settings = await docs.getSettings();
const prices = await docs.getPrices();
const inventory = await docs.getInventory();
const meta = await docs.getMeta();
const first = await docs.getSnapshot();
if (!settings || !prices || !first || !meta) throw new Error('the App KV is missing settings/prices/snapshot/meta — is the runner metering?');
const demo = await docs.getDemoState();
const muted = demo?.muted?.[OBJ];
if (muted && Date.parse(muted) > Date.now()) {
  const wait = Date.parse(muted) - Date.now() + 15_000;
  console.log(`payments route muted until ${muted}; waiting ${Math.round(wait / 1000)} s`);
  await sleep(wait);
}

const t0 = Date.now();
const at = () => Math.round((Date.now() - t0) / 1000);
const steps: TourStep[] = [];
const seenDeliveries = new Set<string>();
const seenIncidents = new Map<string, boolean>(); // id → closed
const dkey = (x: DeliveryLog) => `${x.endpointId}|${x.incidentId}|${x.event}|${x.at}|${x.attempt}`;
let base: Snapshot = (await docs.getSnapshot()) ?? first;
for (const x of base.deliveries) seenDeliveries.add(dkey(x));
for (const i of base.incidents) seenIncidents.set(i.id, !!i.closedAt);
let lastSweep = base.sweepAt;

async function pollOnce(): Promise<Snapshot | null> {
  const s = await docs.getSnapshot();
  if (!s || s.sweepAt === lastSweep) return null;
  lastSweep = s.sweepAt;
  const t = at();
  steps.push({ at: t, action: 'snapshot', payload: compactSnapshot(s, SNAPSHOT_BYTES) });
  for (const i of s.incidents) {
    const known = seenIncidents.get(i.id);
    if (known === undefined && !i.closedAt) steps.push({ at: t, action: 'incident.open', payload: i });
    if (i.closedAt && known !== true) steps.push({ at: t, action: 'incident.close', payload: i });
    seenIncidents.set(i.id, !!i.closedAt);
  }
  for (const x of [...s.deliveries].reverse()) {
    if (seenDeliveries.has(dkey(x))) continue;
    seenDeliveries.add(dkey(x));
    steps.push({ at: t, action: 'delivery', payload: x });
  }
  return s;
}

async function newestCommit(message: string): Promise<Commit | undefined> {
  const tl = await docs.getTimeline();
  return allCommits(tl).find((c) => c.message === message);
}

console.log('recording… (break at +10 s)');
await sleep(10_000);
const br = await breakTrim(lever, { pipelineId: PIPE });
if (!br.ok) throw new Error(`break refused: ${JSON.stringify(br)}`);
const brCommit = await newestCommit(`demo: break the trim on ${PIPE}`);
if (brCommit) steps.push({ at: at(), action: 'commit', payload: brCommit });
console.log(`+${at()} s broke the trim (${br.commit})`);

let opened: Incident | undefined;
while (!opened && at() < 480) {
  await pollOnce();
  const s = await docs.getSnapshot();
  opened = s?.incidents.find((i) => i.objectKey === OBJ && i.type === 'regression' && !i.closedAt && Date.parse(i.openedAt) >= t0);
  if (!opened) await sleep(5_000);
}
if (!opened) throw new Error('no regression within 8 minutes');
console.log(`+${at()} s incident ${opened.id} caught in ${opened.caughtInSec} s`);
const holdUntil = Date.now() + HOLD_SEC * 1000;
while (Date.now() < holdUntil) { await pollOnce(); await sleep(5_000); }

const rs = await restoreTrim(lever, { pipelineId: PIPE });
if (!rs.ok) throw new Error(`restore refused: ${JSON.stringify(rs)}`);
const rsCommit = await newestCommit(`demo: restore the trim on ${PIPE}`);
if (rsCommit) steps.push({ at: at(), action: 'commit', payload: rsCommit });
console.log(`+${at()} s restored (${rs.commit})`);

let closed = false;
while (!closed && at() < 900) {
  await pollOnce();
  const s = await docs.getSnapshot();
  closed = !!s?.incidents.find((i) => i.id === opened!.id && i.closedAt);
  if (!closed) await sleep(5_000);
}
// one more sweep so the recovery delivery lands in the recording
const tail = Date.now() + 70_000;
while (Date.now() < tail) { if (await pollOnce()) break; await sleep(5_000); }
console.log(`+${at()} s ${closed ? 'recovered' : 'NOT recovered'}; ${steps.length} steps`);

const slack = payloadFor('slack', canonicalPayload('incident.opened', { incident: opened, workspace: d.workspace, linkBase: d.linkBase }));
const doc = {
  schemaVersion: 1,
  generatedAt: new Date(t0).toISOString(),
  anchor: new Date(t0).toISOString(),
  source: 'replay',
  timezone: settings.displayTimezone,
  workspace: { name: d.workspace, recordedFrom: 'live demo rig (Cribl.Cloud, Standard plan)', rig: '≈450 GB/day synthetic Datagen' },
  settings,
  prices,
  meta,
  inventory,
  snapshot: compactSnapshot(base, SNAPSHOT_BYTES),
  incidents: base.incidents,
  timeline: base.timeline,
  notifyLog: base.deliveries,
  script: steps,
  slackMessage: slack,
  durationSec: at(),
  measured: { caughtInSec: opened.caughtInSec, breakCommit: br.commit, restoreCommit: rs.commit, author },
};
// The recording is committed and bundled into the demo build: no client-id authors, no .env values.
const env = loadEnv() as Record<string, string>;
const clean = redactRecording(`${JSON.stringify(doc)}\n`, env).text;
const left = leaks(clean, env);
if (left.length > 0) throw new Error(`refusing to write ${OUT}: it still holds ${left.join(', ')}`);
writeFileSync(OUT, clean);
console.log(`wrote ${OUT}: ${(JSON.stringify(doc).length / 1024).toFixed(0)} KB, ${steps.length} steps over ${doc.durationSec} s`);
