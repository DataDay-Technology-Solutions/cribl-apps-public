// core/adapters/preview.ts — the What-if "Dry run on sample events" (DESIGN_BRIEF 5.9, DECISIONS D16).
//
// Runs a treatment's pipeline over real sample events of the stream's own Source through the Leader's
// documented preview API and measures bytes in vs bytes out. Nothing is written: the preview forks a
// throwaway worker process on the Leader, and the sample is only read.
//
//   1. GET  /m/<gid>/system/inputs                    (already granted) → the Source's Datagen sample id
//   2. GET  /m/<gid>/pipelines                        (already granted) → the treatment's pipeline, only when
//                                                       no similar stream already names it
//   3. GET  /m/<gid>/system/samples/<id>/content      → the sample's events (a JSON array of {_raw,_time,…})
//   4. POST /m/<gid>/preview {mode:'pipe', pipelineId, events}  → the events after the pipeline
//
// Byte rule (docs/RIG.md §5, "predicted (preview, `_raw`)"): an event weighs the UTF-8 length of its `_raw`,
// which is what the Destination receives. Measured live 2026-09-26 against Destination bytes: the preview
// prediction equals the true ratio to within 0.02 on every rig pipeline (Windows XML pack 0.342 = 0.342).
// This module, run live 2026-09-26 09:01Z (org main, group default): mrd_windows_workstations through
// mrd_win_xml_pack = 33 sample events, 88,694-byte request, 83,452 B in → 54,950 B out, ratio 0.3415;
// Go aggressive 0.7017; mrd_pan_firewall through mrd_pan_pack 0.371. Counting every field instead of `_raw`
// would have read 0.217 for the Windows pack, which is why the rule is `_raw`.
// An event with no `_raw` (a pipeline that serializes into fields) weighs the JSON of its visible fields
// (no `__` internals, no `cribl_pipe`). Events the pipeline drops are simply absent from the response.
//
// Bounds: at most 200 events and a request body under 90,000 bytes (the platform proxy and the Leader both
// refuse large bodies; the rig's biggest sample, 33 Windows XML events, is 88,694 bytes). One request each,
// 25 s timeout (the preview takes ~4 s live). Paths live here rather than in cribl-urls.ts because this
// module is their only caller.
//
// A Source with no sample of its own (HEC, syslog, S3 …; P2-W26): the dry run answers 'no-sample' together with
// the samples this worker group's Datagen Sources generate from (read from the same, already granted, inputs
// list), and the member can pick one to measure on (`sampleId`); the basis then names the sample. The group's
// whole sample library (GET /m/<gid>/system/samples) is NOT read: that GET is not in the release grants
// (config/policies.yml), so `parseSampleLibrary` is ready for the day it is declared and nothing calls it.

import type { CriblHttp, HttpResult } from '../types.ts';
import { itemsOf } from './config.ts';
import { pipelineMatchesTreatment, type PackTreatment } from '../whatif.ts';

const seg = encodeURIComponent;

/** POST {mode, pipelineId, events} — documented (PreviewDataParams, x-cribl-internal false). */
export const previewPath = (gid: string): string => `/m/${seg(gid)}/preview`;
/** GET → the sample's events. */
export const sampleContentPath = (gid: string, sampleId: string): string => `/m/${seg(gid)}/system/samples/${seg(sampleId)}/content`;

export const DRY_RUN_MAX_EVENTS = 200;
export const DRY_RUN_MAX_BODY_BYTES = 90_000;
export const DRY_RUN_TIMEOUT_MS = 25_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** UTF-8 byte length of a string (no TextEncoder needed; identical in the browser, Node and the backend). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4; // a surrogate pair is one 4-byte code point
      i++;
    } else n += 3;
  }
  return n;
}

/** Fields Cribl adds in the pipeline that no Destination receives as event bytes. */
const isInternalField = (k: string): boolean => k.startsWith('__') || k === 'cribl_pipe';

/** What one event weighs at the Destination: its `_raw`, or the JSON of its visible fields without one. */
export function eventBytes(e: unknown): number {
  if (!isObj(e)) return 0;
  if (typeof e._raw === 'string') return utf8Length(e._raw);
  const visible: Obj = {};
  for (const [k, v] of Object.entries(e)) if (!isInternalField(k)) visible[k] = v;
  return Object.keys(visible).length > 0 ? utf8Length(JSON.stringify(visible)) : 0;
}

export function previewBody(pipelineId: string, events: readonly Obj[]): { mode: 'pipe'; pipelineId: string; events: readonly Obj[] } {
  return { mode: 'pipe', pipelineId, events };
}

/**
 * The first sample events that fit: at most `maxEvents`, and the serialized preview request under
 * `maxBodyBytes`. Internal (`__`) fields are stripped first; non-objects are skipped.
 */
export function boundSampleEvents(events: readonly unknown[], pipelineId: string, opts: { maxEvents?: number; maxBodyBytes?: number } = {}): Obj[] {
  const maxEvents = Math.max(1, Math.floor(opts.maxEvents ?? DRY_RUN_MAX_EVENTS));
  const maxBytes = opts.maxBodyBytes ?? DRY_RUN_MAX_BODY_BYTES;
  const out: Obj[] = [];
  let size = utf8Length(JSON.stringify(previewBody(pipelineId, [])));
  for (const raw of events) {
    if (out.length >= maxEvents) break;
    if (!isObj(raw)) continue;
    const e: Obj = {};
    for (const [k, v] of Object.entries(raw)) if (!k.startsWith('__')) e[k] = v;
    const add = utf8Length(JSON.stringify(e)) + (out.length > 0 ? 1 : 0); // + the comma between events
    if (size + add >= maxBytes) break;
    size += add;
    out.push(e);
  }
  return out;
}

/**
 * The events a preview response returns (`{count, items}` or a bare array). Every item counts: an
 * Aggregations function emits its rows as `__criblEventType: 'stats'` (measured on mrd_vpc_pack), and those
 * rows are what the Destination receives. An item with no `_raw` and only internal fields weighs 0.
 */
export function previewItems(body: unknown): Obj[] {
  return itemsOf(body);
}

/** The Datagen sample a Source generates from (`samples[0].sample`), or undefined for any other Source. */
export function sampleIdForInput(inputsBody: unknown, inputId: string): string | undefined {
  const input = itemsOf(inputsBody).find((i) => i.id === inputId);
  if (!input || input.type !== 'datagen' || !Array.isArray(input.samples)) return undefined;
  const first = input.samples.find((s): s is Obj => isObj(s) && typeof s.sample === 'string' && s.sample !== '');
  return first ? (first.sample as string) : undefined;
}

/** A sample file this worker group's Datagen Sources generate from, and which Sources use it (P2-W26). */
export interface GroupSample {
  id: string;
  usedBy: string[];
}

/** Every sample the group's Datagen Sources name in the inputs list (the granted read), by id. */
export function groupSamples(inputsBody: unknown): GroupSample[] {
  const by = new Map<string, Set<string>>();
  for (const input of itemsOf(inputsBody)) {
    if (input.type !== 'datagen' || typeof input.id !== 'string' || !Array.isArray(input.samples)) continue;
    for (const s of input.samples) {
      if (!isObj(s) || typeof s.sample !== 'string' || s.sample === '') continue;
      const users = by.get(s.sample) ?? new Set<string>();
      users.add(input.id);
      by.set(s.sample, users);
    }
  }
  return [...by]
    .map(([id, users]) => ({ id, usedBy: [...users].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** GET → the group's sample library. Not granted in the release (see the header); nothing calls it yet. */
export const sampleLibraryPath = (gid: string): string => `/m/${seg(gid)}/system/samples`;

/** The library list (`{count, items: [{id, sampleName}]}`) as ids and names, for when the read is declared. */
export function parseSampleLibrary(body: unknown): { id: string; name: string }[] {
  return itemsOf(body)
    .filter((i) => typeof i.id === 'string' && i.id !== '')
    .map((i) => ({ id: i.id as string, name: typeof i.sampleName === 'string' && i.sampleName !== '' ? i.sampleName : (i.id as string) }));
}

/** A local pipeline in the group that looks like the treatment (Pack references are not previewable here). */
export function treatmentPipelineIn(pipelinesBody: unknown, treatment: PackTreatment): string | undefined {
  return itemsOf(pipelinesBody)
    .map((p) => (typeof p.id === 'string' ? p.id : ''))
    .filter((id) => id !== '' && !id.startsWith('pack:') && pipelineMatchesTreatment(id, treatment))
    .sort()[0];
}

// ─── The dry run ─────────────────────────────────────────────────────────────

export interface DryRunRequest {
  groupId: string;
  inputId: string;
  /** The treatment's pipeline when a similar stream already names it; otherwise looked up by `treatment`. */
  pipelineId?: string;
  treatment: PackTreatment;
  /** P2-W26: measure on this sample from the group instead of the Source's own (a Source with none). */
  sampleId?: string;
  maxEvents?: number;
  maxBodyBytes?: number;
  timeoutMs?: number;
}

export interface DryRunOk {
  ok: true;
  pipelineId: string;
  sampleId: string;
  /** events sent / events the pipeline returned */
  events: number;
  eventsOut: number;
  inBytes: number;
  outBytes: number;
  /** byte savings ratio, 1 − out/in, rounded to 4 places */
  ratio: number;
  requestBytes: number;
  /** true when the member picked the sample (P2-W26); absent when it was the Source's own. */
  picked?: true;
}

/**
 * Why there is no measurement: 'no-sample' (the Source is not a Datagen Source, or its sample is gone);
 * 'no-pipeline' (nothing in the group implements the treatment); 'forbidden' (401/403: the App is not
 * granted the preview or the sample); 'unavailable' (404 on the preview, a timeout, the network); 'empty'
 * (no events, or zero bytes in); 'failed' (anything else).
 */
export interface DryRunFailed {
  ok: false;
  reason: 'no-sample' | 'no-pipeline' | 'forbidden' | 'unavailable' | 'empty' | 'failed';
  status?: number;
  detail?: string;
  /** 'no-sample' on a Source with none: the samples the group's Datagen Sources offer instead (P2-W26). */
  samples?: GroupSample[];
}

export type DryRunResult = DryRunOk | DryRunFailed;

function failure(res: HttpResult, notFound: DryRunFailed['reason']): DryRunFailed {
  const detail = res.text?.slice(0, 200) ?? (isObj(res.json) && typeof res.json.message === 'string' ? res.json.message.slice(0, 200) : undefined);
  const reason: DryRunFailed['reason'] = res.status === 401 || res.status === 403 ? 'forbidden' : res.status === 404 ? notFound : res.status === 0 ? 'unavailable' : 'failed';
  return detail !== undefined ? { ok: false, reason, status: res.status, detail } : { ok: false, reason, status: res.status };
}

/** Sums the byte rule over what went in and what came out. */
export function measurePreview(sent: readonly unknown[], returned: readonly unknown[]): { inBytes: number; outBytes: number; ratio: number } {
  const inBytes = sent.reduce<number>((a, e) => a + eventBytes(e), 0);
  const outBytes = returned.reduce<number>((a, e) => a + eventBytes(e), 0);
  const ratio = inBytes > 0 ? Math.round((1 - outBytes / inBytes) * 10_000) / 10_000 : 0;
  return { inBytes, outBytes, ratio };
}

/** Reads the sample by the id the Source names; a built-in names its file ('weblog.log' → id 'weblog'). */
async function readSample(http: CriblHttp, gid: string, sampleId: string, timeoutMs: number): Promise<{ id: string; res: HttpResult }> {
  const res = await http.request('GET', sampleContentPath(gid, sampleId), undefined, { timeoutMs });
  const bare = sampleId.replace(/\.[A-Za-z0-9]+$/, '');
  if (res.status !== 404 || bare === sampleId) return { id: sampleId, res };
  return { id: bare, res: await http.request('GET', sampleContentPath(gid, bare), undefined, { timeoutMs }) };
}

/** The dry run. Read-only; never throws (every failure is a DryRunFailed the UI can name). */
export async function runDryRun(http: CriblHttp, req: DryRunRequest): Promise<DryRunResult> {
  const timeoutMs = req.timeoutMs ?? DRY_RUN_TIMEOUT_MS;
  const gid = req.groupId;
  try {
    const inputs = await http.request('GET', `/m/${seg(gid)}/system/inputs`, undefined, { timeoutMs });
    if (!inputs.ok) return failure(inputs, 'no-sample');
    const own = sampleIdForInput(inputs.json, req.inputId);
    const sampleId = req.sampleId !== undefined && req.sampleId !== '' ? req.sampleId : own;
    if (!sampleId) {
      const samples = groupSamples(inputs.json);
      return samples.length > 0 ? { ok: false, reason: 'no-sample', samples } : { ok: false, reason: 'no-sample' };
    }
    const picked = sampleId !== own;

    let pipelineId = req.pipelineId && req.pipelineId !== '-' && !req.pipelineId.startsWith('pack:') ? req.pipelineId : undefined;
    if (!pipelineId) {
      const pipes = await http.request('GET', `/m/${seg(gid)}/pipelines`, undefined, { timeoutMs });
      if (!pipes.ok) return failure(pipes, 'no-pipeline');
      pipelineId = treatmentPipelineIn(pipes.json, req.treatment);
      if (!pipelineId) return { ok: false, reason: 'no-pipeline' };
    }

    const sample = await readSample(http, gid, sampleId, timeoutMs);
    if (!sample.res.ok) return failure(sample.res, 'no-sample');
    const all: unknown[] = Array.isArray(sample.res.json) ? sample.res.json : itemsOf(sample.res.json);
    const events = boundSampleEvents(all, pipelineId, { maxEvents: req.maxEvents, maxBodyBytes: req.maxBodyBytes });
    if (events.length === 0) return { ok: false, reason: 'empty' };

    const body = previewBody(pipelineId, events);
    const preview = await http.request('POST', previewPath(gid), body, { timeoutMs });
    if (!preview.ok) return failure(preview, 'unavailable');
    if (!isObj(preview.json) && !Array.isArray(preview.json)) return { ok: false, reason: 'failed', status: preview.status, detail: 'preview answered without JSON' };
    const returned = previewItems(preview.json);
    const m = measurePreview(events, returned);
    if (!(m.inBytes > 0)) return { ok: false, reason: 'empty' };
    return {
      ok: true,
      pipelineId,
      sampleId: sample.id,
      events: events.length,
      eventsOut: returned.length,
      inBytes: m.inBytes,
      outBytes: m.outBytes,
      ratio: m.ratio,
      requestBytes: utf8Length(JSON.stringify(body)),
      ...(picked ? { picked: true as const } : {}),
    };
  } catch (e) {
    return { ok: false, reason: 'failed', detail: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) };
  }
}
