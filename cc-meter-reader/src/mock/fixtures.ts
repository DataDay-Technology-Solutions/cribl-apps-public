// src/mock/fixtures.ts — the worlds the emulator serves, built from the live org's read-only captures.
//
// `demo`  : the real dev org (tests/fixtures/cribl/live-*.json, captured with scripts/cribl-api.mjs GET,
//           token and internal hostname redacted) with the Meter Reader demo rig merged into group
//           `default`, and the org's measured commit history in front of it.
// `scale` : the 2,000-flow synthetic estate (testdata/scale.ts) for Ledger and sweep scale runs.

import liveGroups from '../../tests/fixtures/cribl/live-master-groups.json';
import liveInputs from '../../tests/fixtures/cribl/live-inputs.json';
import liveOutputs from '../../tests/fixtures/cribl/live-outputs.json';
import livePipelines from '../../tests/fixtures/cribl/live-pipelines.json';
import liveRoutes from '../../tests/fixtures/cribl/live-routes.json';
import liveLog from '../../tests/fixtures/cribl/live-version-log.json';
import mockHistory from '../../tests/fixtures/cribl/mock-version-history.json';
import mockStatus from '../../tests/fixtures/cribl/mock-version-status.json';
import mockSystemInfo from '../../tests/fixtures/cribl/mock-system-info.json';
import {
  DAY_MS,
  DEMO_TAG,
  HOUR_MS,
  RIG,
  buildCommit,
  demoRigWorld,
  hashHex40,
  rigConfigObjects,
  type CriblInput,
  type CriblOutput,
  type CriblPipeline,
  type CriblRouteTable,
  type GroupConfig,
  type GroupRecord,
  type SyntheticCommit,
  type World,
} from '../../testdata/gen.ts';
import { scaleWorld } from '../../testdata/scale.ts';
import type { MockPreset } from './types.ts';

/** The live org's configuration for group `default`, as captured. */
export const LIVE_DEFAULT_CONFIG: GroupConfig = {
  inputs: liveInputs.items as unknown as CriblInput[],
  outputs: liveOutputs.items as unknown as CriblOutput[],
  pipelines: livePipelines.items as unknown as CriblPipeline[],
  routes: liveRoutes.items[0] as unknown as CriblRouteTable,
};
export const LIVE_GROUPS: GroupRecord[] = liveGroups.items as unknown as GroupRecord[];
export const SYSTEM_INFO: unknown = mockSystemInfo;
/** Files pending on the Leader before anything the app does (live `/version/status` + stand-ins). */
export const PREEXISTING_PENDING: string[] = mockStatus.files.map((f) => f.path);

const parseLogDate = (d: string): number => Date.parse(d.replace(' ', 'T').replace(/ \+0000$/, 'Z'));

/**
 * The Leader-wide history before Meter Reader (docs/platform/version.md 5.2): `Initial commit.` touches
 * default_search, then one `create group …` per group. The `default` commit is the live row verbatim.
 */
function orgHistory(): SyntheticCommit[] {
  const live = liveLog.items[0];
  return mockHistory.commits.map((h) => {
    const isLive = live && h.short === live.hash.slice(0, 7);
    const commit = buildCommit({
      seed: 0,
      at: parseLogDate(isLive ? live.date : h.date),
      message: isLive ? live.message : h.message,
      author: { name: isLive ? live.author_name : h.author_name, email: isLive ? live.author_email : h.author_email },
      files: h.files,
      after: h.files.some((f) => f.startsWith('groups/default/')) ? LIVE_DEFAULT_CONFIG : undefined,
    });
    // Keep the measured short hashes so logs line up with the org (the tail is synthetic but stable).
    return { ...commit, hash: isLive ? live.hash : h.short + hashHex40(h.short).slice(7) };
  });
}
const ORG_HISTORY = orgHistory();
/** When group `default` was created on the org; the rig cannot predate it. */
const DEFAULT_GROUP_CREATED = Math.max(...ORG_HISTORY.filter((c) => c.message === 'create group default').map((c) => c.at));

const emptyConfig = (): GroupConfig => ({ inputs: [], outputs: [], pipelines: [], routes: { id: 'default', routes: [] } });

// The live rig's own definitions (demo/rig/*.json, maintained with scripts/rig/apply.mjs) carry the
// full imported pack functions. When present and well-formed they replace the abbreviated objects of
// testdata/gen.ts, so the emulator serves exactly what the org runs; ids and ratios are unchanged.
// (`import.meta.glob` is a Vite transform; under plain Node — tsx scripts — the call throws and the
// emulator keeps the generator's objects.)
let RIG_FILES: Record<string, unknown> = {};
try {
  RIG_FILES = import.meta.glob<unknown>('../../demo/rig/{pipelines,destinations,sources}.json', { eager: true, import: 'default' });
} catch {
  RIG_FILES = {};
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Where the demo rig's objects came from, for `/mock-api/_state`. */
export let RIG_SOURCE: 'demo/rig/*.json' | 'testdata/gen.ts' = 'testdata/gen.ts';

function liveRigConfig(): GroupConfig {
  const base = rigConfigObjects();
  try {
    const pipes = RIG_FILES['../../demo/rig/pipelines.json'];
    const dests = RIG_FILES['../../demo/rig/destinations.json'];
    const srcs = RIG_FILES['../../demo/rig/sources.json'];
    if (!isObj(pipes) || !Array.isArray(pipes.pipelines) || !isObj(dests) || !Array.isArray(dests.destinations) || !isObj(srcs) || !Array.isArray(srcs.sources)) return base;
    const pipelines = base.pipelines.map((p) => {
      const live = (pipes.pipelines as unknown[]).find((x) => isObj(x) && x.id === p.id);
      // D59: a pack pipeline ships as a shell (its functions are Cribl's pack content); the emulator keeps its own.
      if (!isObj(live) || live.fromPack || !isObj(live.conf) || !Array.isArray(live.conf.functions) || !String(live.conf.description ?? '').includes(DEMO_TAG)) return p;
      return { id: p.id, conf: live.conf as CriblPipeline['conf'] };
    });
    const outputs = base.outputs.map((o) => {
      const live = (dests.destinations as unknown[]).find((x) => isObj(x) && x.id === o.id);
      return isObj(live) && isObj(live.output) && live.output.id === o.id && live.output.type === 'devnull' ? ({ ...(live.output as object) } as CriblOutput) : o;
    });
    const inputs = base.inputs.map((i) => {
      const live = (srcs.sources as unknown[]).find((x) => isObj(x) && x.id === i.id);
      return isObj(live) && typeof live.description === 'string' && live.description.includes(DEMO_TAG) ? { ...i, description: live.description } : i;
    });
    // The trim targets must still carry exactly one [mr-trim] step, or the break-the-trim lever has nothing to break.
    const trimOk = [RIG.pipelines.paySample, RIG.pipelines.k8sNoise].every(
      (id) => pipelines.find((p) => p.id === id)!.conf.functions.filter((f) => (f.description ?? '').includes('[mr-trim]')).length === 1,
    );
    if (!trimOk) return base;
    RIG_SOURCE = 'demo/rig/*.json';
    return { ...base, pipelines, outputs, inputs };
  } catch {
    return base;
  }
}
const RIG_CONFIG = liveRigConfig();

// ─── Datagen sample content (GET /m/<gid>/system/samples/<id>/content, the What-if dry run) ──────────
//
// The rig's sample files (demo/rig/samples/*, generated by testdata/samples.ts: one JSON array of
// { _raw, _time } events each) keyed by the sample-library id the Datagen sources name (manifest.json
// `sampleId`, e.g. 'mrd_windows_security_xml'). Read as raw text so the route answers the bytes the org
// stores. Like RIG_FILES above, `import.meta.glob` exists only under Vite (dev server, Playwright, vitest);
// elsewhere the map is empty and the content route answers 404, as it did before.
let SAMPLE_FILES: Record<string, string> = {};
try {
  SAMPLE_FILES = import.meta.glob<string>('../../demo/rig/samples/*.{log,json}', { eager: true, query: '?raw', import: 'default' });
} catch {
  SAMPLE_FILES = {};
}

function sampleContentById(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const manifestRaw = SAMPLE_FILES['../../demo/rig/samples/manifest.json'];
    if (typeof manifestRaw !== 'string') return out;
    const manifest = JSON.parse(manifestRaw) as { samples?: { sampleId?: unknown; file?: unknown }[] };
    for (const s of manifest.samples ?? []) {
      if (typeof s.sampleId !== 'string' || typeof s.file !== 'string') continue;
      const text = SAMPLE_FILES[`../../demo/rig/samples/${s.file}`];
      if (typeof text === 'string') out[s.sampleId] = text;
    }
  } catch {
    // a malformed manifest leaves the map empty: the content route then answers 404
  }
  return out;
}
/** Sample-library id → the file's text (a JSON array of `{ _raw, _time }`). Demo preset, rig group only. */
export const RIG_SAMPLE_CONTENT: Readonly<Record<string, string>> = sampleContentById();

// ─── Notification targets (GET /notification-targets; docs/NOTIFICATIONS.md §2.2) ─────────────────────
//
// Every org has the built-in bell target `system_notifications`; the demo org adds the webhook target the
// live relay was proven with (`mrd_webhook_site`, §4) and a Slack target stands in for the one the pitch
// names. The Leader answers each target's FULL configuration, URLs included — the App keeps only id, type
// and description (core/adapters/cribl-notify.ts listTargets). The URLs here are placeholders on the
// emulator's sink hosts, so a relayed alert lands in `/mock-api/_sink` like a direct webhook does.
// Not inbox-shaped (a real webhook.site inbox is a UUID, which tests/forbidden.txt refuses in the repository).
export const MOCK_WEBHOOK_TARGET_URL = 'https://webhook.site/meter-reader-mock-target';
export const MOCK_SLACK_TARGET_URL = 'https://hooks.slack.com/services/mock-team/mock-hook/not-a-real-secret';
export const NOTIFICATION_TARGETS: readonly Record<string, unknown>[] = [
  {
    id: 'system_notifications',
    type: 'bulletin_message',
    severity: 'warn',
    text: 'Notification has been triggered',
    title: 'Notification',
    onBackpressure: 'drop',
    status: { health: 'Green' },
  },
  {
    id: 'mrd_webhook_site',
    type: 'webhook',
    url: MOCK_WEBHOOK_TARGET_URL,
    method: 'POST',
    format: 'ndjson',
    description: '[meter-reader-demo] Meter Reader demo receiver (webhook.site)',
    onBackpressure: 'drop',
    status: { health: 'Green' },
  },
  {
    id: 'mrd_slack_finops',
    type: 'slack',
    url: MOCK_SLACK_TARGET_URL,
    description: '[meter-reader-demo] FinOps channel in Slack',
    onBackpressure: 'drop',
    status: { health: 'Green' },
  },
];

export interface BaseWorld {
  world: World;
  /** every group's base config (groups without a flow get an empty one) */
  configs: Record<string, GroupConfig>;
}

const cache = new Map<string, BaseWorld>();

/**
 * The preset's world as of `createdAt`. Pure and cached: the same arguments always give the same
 * world, so every tab (and every reload) reconstructs identical history from the persisted doc.
 */
export function baseWorld(preset: MockPreset, seed: number, createdAt: number, flows?: number): BaseWorld {
  const key = `${preset}|${seed}|${createdAt}|${flows ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let world: World;
  if (preset === 'scale') {
    world = scaleWorld({ seed, end: createdAt, ...(flows ? { flows } : {}) });
  } else {
    // Two days of rig history (the metrics store keeps ≈ 2 days), never before the group existed.
    const rigFrom = Math.max(createdAt - 2 * DAY_MS, DEFAULT_GROUP_CREATED + HOUR_MS);
    world = demoRigWorld({
      now: createdAt,
      seed,
      historyDays: Math.max(1 / 24, (createdAt - rigFrom) / DAY_MS),
      rigConfig: RIG_CONFIG,
      extraConfig: LIVE_DEFAULT_CONFIG,
      groups: LIVE_GROUPS,
      baseCommits: ORG_HISTORY,
      hosts: ['wn-default-0'],
      processesPerHost: 2,
    });
  }
  const configs: Record<string, GroupConfig> = {};
  for (const g of world.groups) configs[g.id] = world.config[g.id] ?? emptyConfig();
  const out = { world, configs };
  if (cache.size > 4) cache.clear();
  cache.set(key, out);
  return out;
}
