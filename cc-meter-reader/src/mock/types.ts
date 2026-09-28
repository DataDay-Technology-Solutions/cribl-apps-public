// src/mock/types.ts — shared types of the Cribl emulator (dev, Playwright and integration tests only).

import type { CriblInput, CriblOutput, CriblPipeline, CriblRouteTable, Effect, SyntheticCommit } from '../../testdata/gen.ts';

/** Base URL the emulator answers on in the browser; the app points `CRIBL_API_URL` here in mock mode. */
export const MOCK_API_BASE = '/mock-api/v1';
/** Test/driver endpoints live beside the API, outside `/v1`, so the app can never call them by accident. */
export const MOCK_CONTROL_PATH = '/mock-api/_control';
export const MOCK_SINK_PATH = '/mock-api/_sink';
export const MOCK_CALLS_PATH = '/mock-api/_calls';
export const MOCK_STATE_PATH = '/mock-api/_state';
/** The emulated bell (`/system/messages`) as a test sees it: GET lists newest first, DELETE empties it. Never journaled. */
export const MOCK_BELL_PATH = '/mock-api/_bell';

/** The member `window.getCriblUser()` resolves to in mock mode (AGENTS.md "How to Get User Info"). */
export const MOCK_USER = { id: 'u1', username: 's.koelpin', firstName: 'Steve', lastName: 'Koelpin', initials: 'SK' } as const;

export interface MockRequest {
  method: string;
  /** absolute URL (MSW) or path+query (direct adapters) */
  url: string;
  headers: Record<string, string>;
  body: string | null;
}
export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

export type MockPreset = 'demo' | 'scale';

export interface MockOptions {
  /** Added to every API response (browser only), to exercise loading states. */
  latencyMs: number;
  /** Seconds between a deploy and its effect on metrics (the effect starts at the next minute boundary after it). */
  deployLagSec: number;
  /** How far back `/system/metrics/query` has data (the Leader keeps ≈ 2 days). */
  retentionHours: number;
  /** true: a commit without an explicit `files` list is refused (400). false (default): it commits every pending file, as the platform does, and is recorded as a violation. */
  strictCommits: boolean;
  /** true (default): ':' in a KV key is refused (400) — DECISIONS D13; '|' is always a 404 (measured). */
  strictKeys: boolean;
  /** Leader calls allowed per mock-clock minute before 429 (0 = unlimited). */
  rateLimitPerMinute: number;
  /** Largest KV PUT body the Leader accepts (express `100kb`; SPIKE line 2). */
  kvMaxBodyBytes: number;
  /** External hosts whose POSTs are captured by the sink (directly or via `/proxy/<host>/…`). */
  sinkHosts: string[];
  /**
   * Cribl.Cloud's notification APIs: the bell (`/system/messages`), `/notification-targets` and the Search
   * relay (`/m/default_search/search/saved…`, `/search/notifications`). false = a Leader without them (every
   * one answers 404), the world the Node emulator (src/mock/direct.ts) keeps by default.
   */
  notificationApis: boolean;
}

export const DEFAULT_OPTIONS: MockOptions = {
  latencyMs: 0,
  deployLagSec: 0,
  retentionHours: 48,
  strictCommits: false,
  strictKeys: true,
  rateLimitPerMinute: 0,
  kvMaxBodyBytes: 102_400,
  sinkHosts: ['hooks.slack.com', 'webhook.site'],
  notificationApis: true,
};

/** Object overrides layered over a preset's base configuration. `null` deletes a base object. */
export interface Overlay {
  inputs?: Record<string, CriblInput | null>;
  outputs?: Record<string, CriblOutput | null>;
  pipelines?: Record<string, CriblPipeline | null>;
  routes?: CriblRouteTable;
}

/** An injected failure: the next `times` matching requests answer `status` (times −1 = forever). */
export interface Fault {
  method?: string;
  /** substring of the API path+query (or of the full URL for external calls) */
  path?: string;
  /** regular expression source matched against the same string (used instead of `path`) */
  pattern?: string;
  status: number;
  body?: unknown;
  times: number;
}

/** Everything the emulator persists besides KV, the journal and the sink. */
export interface MockDoc {
  v: 1;
  rev: number;
  preset: MockPreset;
  seed: number;
  /** scale preset only */
  flows?: number;
  /** mock-clock instant the world was created; history is generated before it */
  createdAt: number;
  clockOffsetMs: number;
  options: MockOptions;
  /** working copy (what config GETs return), committed state, and what each group runs */
  working: Record<string, Overlay>;
  committed: Record<string, Overlay>;
  running: Record<string, Overlay>;
  /** committed overlays (all groups) after each emulator-made commit, for deploys of older commits */
  snapshots: Record<string, Record<string, Overlay>>;
  /** uncommitted repo paths */
  pending: string[];
  commits: SyntheticCommit[];
  effects: Effect[];
  deployed: Record<string, { version: string; at: number }>;
  faults: Fault[];
  /** platform-legal but decision-breaking calls, e.g. a commit without `files` */
  violations: { at: number; message: string }[];
}

export interface SinkEntry {
  id: number;
  at: number;
  method: string;
  url: string;
  host: string;
  /** 'cribl-target': delivered by the emulated notification service to a target's URL (the Search relay) */
  via: 'direct' | 'proxy' | 'cribl-target';
  contentType: string;
  body: string;
  /** parsed body when it is JSON */
  json?: unknown;
  status: number;
}

/** A bell entry (`POST /system/messages`, BulletinMessage; docs/NOTIFICATIONS.md §2.1). */
export interface BellMessage {
  id: string;
  severity: 'info' | 'warn' | 'error' | 'fatal';
  title: string;
  text: string;
  /** epoch ms (the Leader fills it when the POST omits it) */
  time: number;
}

/** A Search notification on a saved search (the relay; docs/NOTIFICATIONS.md §2.3). */
export interface SearchNotificationDoc {
  id: string;
  condition: string;
  conf: Record<string, unknown>;
  targets: string[];
  group: string;
  savedQueryId: string;
}

/** A saved search in `default_search` (never scheduled by the App), with its notifications. */
export interface SavedSearchDoc {
  id: string;
  name?: string;
  description?: string;
  query?: string;
  earliest?: string;
  latest?: string;
  schedule: { enabled?: boolean; notifications?: { items: SearchNotificationDoc[] } } & Record<string, unknown>;
  [k: string]: unknown;
}

export interface JournalEntry {
  at: number;
  method: string;
  path: string;
  /** normalized route, e.g. `GET /kvstore/*`, `PATCH /m/:gid/pipelines/:id` */
  route: string;
  status: number;
  kind: 'api' | 'external';
}

export interface CallsSummary {
  total: number;
  byRoute: Record<string, number>;
  /** calls to `/endpoints/*` (SPEC 16 S16: live mode must make none) */
  endpointCalls: number;
  recent: JournalEntry[];
}

/** `POST /mock-api/_control` bodies. Times accept `at` (epoch ms, mock clock) or `minutesAgo`. */
export type ControlAction =
  | { action: 'reset'; preset?: MockPreset; seed?: number; flows?: number; keepKv?: boolean; options?: Partial<MockOptions> }
  | { action: 'advance'; minutes: number }
  | { action: 'setClock'; at: number }
  | { action: 'breakTrim'; pipelineId?: string; withPacks?: boolean; at?: number; minutesAgo?: number }
  | { action: 'restore'; pipelineId?: string; at?: number; minutesAgo?: number }
  | { action: 'applyPack'; routeId: string; level?: 'pack' | 'aggressive'; at?: number; minutesAgo?: number }
  | { action: 'revertPack'; routeId: string; at?: number; minutesAgo?: number }
  | { action: 'setRate'; inputId: string; multiplier: number; at?: number; minutesAgo?: number }
  | { action: 'spike'; inputId?: string; multiplier?: number; at?: number; minutesAgo?: number }
  | { action: 'calm'; inputId?: string; at?: number; minutesAgo?: number }
  | { action: 'fault'; method?: string; path?: string; pattern?: string; status: number; body?: unknown; times?: number }
  | { action: 'clearFaults' }
  | { action: 'config'; options: Partial<MockOptions> }
  | { action: 'clearKv' }
  | { action: 'clearSink' }
  | { action: 'resetCalls' }
  | { action: 'state' }
  /**
   * Stores deterministic rollup history (testdata/rollups.ts): minute docs for the last 25 h, hour docs for
   * 32 days, day docs for `dayDays` (default 92) days and the matching `totals`, priced at `prices` (default
   * the rig's), all before `at` (default now) and after `since`. What a custom range on the Receipt reads.
   */
  | { action: 'seedRollups'; at?: number; since?: number; prices?: unknown; tz?: string; dayDays?: number }
  /**
   * Stores the `inventory` document a sweep would have written for the emulated org as it stands (a warm
   * workspace: the tab's first sweep then has no inventory walk to do). Budget tests (tests/e2e/budget.spec.ts).
   */
  | { action: 'seedInventory'; at?: number }
  /**
   * An emulated runner sweep (scripts/runner.ts): stamps the KV `meta` (and `snapshot`, when there is one) the
   * way a runner's sweep leaves them — last swept now by `owner` (default 'runner:workhorse:1'), metered through
   * the current minute — without making the calls, which are the runner's, not the tab's. Unjournaled. Needs a
   * plain JSON `meta` in KV (409 otherwise).
   */
  | { action: 'runnerSweep'; owner?: string; at?: number };
