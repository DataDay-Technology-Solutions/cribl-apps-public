// tests/unit/whatif-preview.test.ts — the What-if dry run (core/adapters/preview.ts): the byte rule, the
// request bounds, the four-call sequence against a fake Leader, and every way it can decline.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { CriblHttp, HttpResult } from '../../core/types.ts';
import {
  DRY_RUN_MAX_BODY_BYTES,
  DRY_RUN_MAX_EVENTS,
  boundSampleEvents,
  eventBytes,
  measurePreview,
  previewBody,
  previewItems,
  previewPath,
  runDryRun,
  sampleContentPath,
  sampleIdForInput,
  treatmentPipelineIn,
  utf8Length,
  groupSamples,
  parseSampleLibrary,
  sampleLibraryPath,
  type DryRunOk,
} from '../../core/adapters/preview.ts';
import { estimateTreatment } from '../../core/whatif.ts';

const INPUTS = {
  count: 3,
  items: [
    { id: 'mrd_windows_workstations', type: 'datagen', samples: [{ sample: 'mrd_windows_security_xml', eventsPerSec: 366 }] },
    { id: 'in_splunk_tcp', type: 'splunk' },
    { id: 'weblog_gen', type: 'datagen', samples: [{ sample: 'weblog.log', eventsPerSec: 10 }] },
  ],
};
const PIPELINES = { count: 4, items: [{ id: 'main' }, { id: 'mrd_passthrough' }, { id: 'mrd_win_xml_pack' }, { id: 'mrd_win_docs_reduce' }] };
/** Two events: 100 and 300 bytes of `_raw`. */
const SAMPLE = [
  { _raw: 'x'.repeat(100), _time: 1 },
  { _raw: 'y'.repeat(300), _time: 2 },
];

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** A fake Leader: routes by `METHOD path` to a result (or a function of the body). */
function fakeHttp(routes: Record<string, HttpResult | ((body: unknown) => HttpResult)>): CriblHttp & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body });
      const r = routes[`${method} ${path}`];
      if (!r) return { status: 404, ok: false, json: { message: 'not found' } };
      return typeof r === 'function' ? r(body) : r;
    },
  };
}

const ok = (json: unknown): HttpResult => ({ status: 200, ok: true, json });

/** The preview "pipeline" keeps the first 60 % of each `_raw` and adds internals, as Cribl does. */
function halfPreview(body: unknown): HttpResult {
  const events = (body as { events: { _raw: string; _time: number }[] }).events;
  return ok({
    count: events.length,
    items: events.map((e, i) => ({ __criblEventType: 'event', __id: i, _time: e._time, _raw: e._raw.slice(0, Math.round(e._raw.length * 0.6)), cribl_pipe: 'mrd_win_xml_pack' })),
  });
}

describe('byte rule', () => {
  it('counts UTF-8 bytes, including multi-byte and astral characters', () => {
    expect(utf8Length('')).toBe(0);
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
    expect(utf8Length('\ud800')).toBe(3); // a lone surrogate encodes as U+FFFD
  });

  it('matches TextEncoder on arbitrary strings', () => {
    const enc = new TextEncoder();
    fc.assert(fc.property(fc.string({ unit: 'binary' }), (s) => utf8Length(s) === enc.encode(s).length));
  });

  it('weighs an event by its _raw, ignoring every other field', () => {
    expect(eventBytes({ _raw: 'hello', _time: 1, host: 'a', __id: 3, cribl_pipe: 'p' })).toBe(5);
  });

  it('weighs an event with no _raw by the JSON of its visible fields', () => {
    const e = { host: 'a', n: 1, __id: 3, cribl_pipe: 'p' };
    expect(eventBytes(e)).toBe(JSON.stringify({ host: 'a', n: 1 }).length);
    expect(eventBytes({ __final: true, cribl_pipe: 'p' })).toBe(0);
    expect(eventBytes(null)).toBe(0);
    expect(eventBytes('text')).toBe(0);
  });

  it('measures the ratio as 1 − out/in over the sums', () => {
    expect(measurePreview(SAMPLE, [{ _raw: 'x'.repeat(60) }, { _raw: 'y'.repeat(180) }])).toEqual({ inBytes: 400, outBytes: 240, ratio: 0.4 });
    // events the pipeline drops are simply absent
    expect(measurePreview(SAMPLE, [{ _raw: 'y'.repeat(300) }]).ratio).toBe(0.25);
    expect(measurePreview([], []).ratio).toBe(0);
  });

  it('counts every returned item, including aggregation rows (__criblEventType "stats")', () => {
    const items = previewItems({ count: 2, items: [{ __criblEventType: 'stats', _raw: '{"bytes":1}' }, { __criblEventType: 'event', _raw: 'ab' }] });
    expect(items).toHaveLength(2);
    expect(measurePreview([{ _raw: 'x'.repeat(100) }], items).outBytes).toBe(13);
    expect(previewItems([{ _raw: 'a' }])).toHaveLength(1);
    expect(previewItems({})).toEqual([]);
  });
});

describe('request bounds', () => {
  it('keeps at most 200 events', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ _raw: `e${i}`, _time: i }));
    expect(boundSampleEvents(many, 'p')).toHaveLength(DRY_RUN_MAX_EVENTS);
    expect(boundSampleEvents(many, 'p', { maxEvents: 7 })).toHaveLength(7);
  });

  it('keeps the serialized request under 90,000 bytes', () => {
    const big = Array.from({ length: 60 }, (_, i) => ({ _raw: 'é'.repeat(1_500), _time: i })); // 3 KB of UTF-8 each
    const kept = boundSampleEvents(big, 'mrd_win_xml_pack');
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(60);
    expect(utf8Length(JSON.stringify(previewBody('mrd_win_xml_pack', kept)))).toBeLessThan(DRY_RUN_MAX_BODY_BYTES);
    // one more event would not have fit
    expect(utf8Length(JSON.stringify(previewBody('mrd_win_xml_pack', big.slice(0, kept.length + 1))))).toBeGreaterThanOrEqual(DRY_RUN_MAX_BODY_BYTES);
  });

  it('holds the bound for any sample (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ _raw: fc.string({ maxLength: 4_000 }), _time: fc.integer() }), { maxLength: 300 }), fc.integer({ min: 200, max: 20_000 }), (events, max) => {
        const kept = boundSampleEvents(events, 'pipe', { maxBodyBytes: max });
        return kept.length <= DRY_RUN_MAX_EVENTS && (kept.length === 0 || utf8Length(JSON.stringify(previewBody('pipe', kept))) < max);
      }),
    );
  });

  it('strips internal fields and skips non-objects', () => {
    expect(boundSampleEvents([{ _raw: 'a', __inputId: 'x' }, 'junk', null, [1], { _raw: 'b' }], 'p')).toEqual([{ _raw: 'a' }, { _raw: 'b' }]);
  });
});

describe('lookups', () => {
  it('finds a Datagen Source’s sample; any other Source has none', () => {
    expect(sampleIdForInput(INPUTS, 'mrd_windows_workstations')).toBe('mrd_windows_security_xml');
    expect(sampleIdForInput(INPUTS, 'in_splunk_tcp')).toBeUndefined();
    expect(sampleIdForInput(INPUTS, 'missing')).toBeUndefined();
    expect(sampleIdForInput({ items: [{ id: 'd', type: 'datagen', samples: [{ sample: '' }] }] }, 'd')).toBeUndefined();
    expect(sampleIdForInput(null, 'd')).toBeUndefined();
  });

  it('finds the treatment’s local pipeline, never a Pack reference', () => {
    expect(treatmentPipelineIn(PIPELINES, 'pack-windows')).toBe('mrd_win_xml_pack');
    expect(treatmentPipelineIn(PIPELINES, 'aggressive-windows')).toBe('mrd_win_docs_reduce');
    expect(treatmentPipelineIn(PIPELINES, 'pack-panos')).toBeUndefined();
    expect(treatmentPipelineIn({ items: [{ id: 'pack:cribl-palo-alto-networks' }] }, 'pack-panos')).toBeUndefined();
  });

  it('encodes every id segment in the paths', () => {
    expect(previewPath('default')).toBe('/m/default/preview');
    expect(sampleContentPath('my group', 'a/b')).toBe('/m/my%20group/system/samples/a%2Fb/content');
  });
});

describe('runDryRun', () => {
  const happy = {
    'GET /m/default/system/inputs': ok(INPUTS),
    'GET /m/default/pipelines': ok(PIPELINES),
    'GET /m/default/system/samples/mrd_windows_security_xml/content': ok(SAMPLE),
    'POST /m/default/preview': halfPreview,
  };

  it('reads the sample, previews it through the named pipeline and measures bytes in vs out', async () => {
    const http = fakeHttp(happy);
    const r = await runDryRun(http, { groupId: 'default', inputId: 'mrd_windows_workstations', treatment: 'pack-windows', pipelineId: 'mrd_win_xml_pack' });
    expect(r).toEqual<DryRunOk>({
      ok: true,
      pipelineId: 'mrd_win_xml_pack',
      sampleId: 'mrd_windows_security_xml',
      events: 2,
      eventsOut: 2,
      inBytes: 400,
      outBytes: 240,
      ratio: 0.4,
      requestBytes: utf8Length(JSON.stringify(previewBody('mrd_win_xml_pack', SAMPLE))),
    });
    // a named pipeline skips the pipelines read: three calls, the last one the preview
    expect(http.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /m/default/system/inputs',
      'GET /m/default/system/samples/mrd_windows_security_xml/content',
      'POST /m/default/preview',
    ]);
    expect(http.calls[2].body).toEqual({ mode: 'pipe', pipelineId: 'mrd_win_xml_pack', events: SAMPLE });
  });

  it('looks the pipeline up when no similar stream names it', async () => {
    const http = fakeHttp(happy);
    const r = await runDryRun(http, { groupId: 'default', inputId: 'mrd_windows_workstations', treatment: 'aggressive-windows' });
    expect(r.ok && r.pipelineId).toBe('mrd_win_docs_reduce');
    expect(http.calls.map((c) => c.path)).toContain('/m/default/pipelines');
  });

  it('feeds estimateTreatment a dry-run basis that outranks the similar stream', async () => {
    const r = await runDryRun(fakeHttp(happy), { groupId: 'default', inputId: 'mrd_windows_workstations', treatment: 'pack-windows', pipelineId: 'mrd_win_xml_pack' });
    if (!r.ok) throw new Error('expected a measurement');
    const flow = { inBPerDay: 80e9, outBPerDay: 80e9, whpPerDayM: 20_000_000, paidPerDayM: 20_000_000, savedPerDayM: 0 };
    const e = estimateTreatment({ flow, treatment: 'pack-windows', measuredSimilar: { ratio: 0.3, fromObject: 'route:default:x' }, dryRun: { inBytes: r.inBytes, outBytes: r.outBytes, events: r.events, pipelineId: r.pipelineId } });
    expect(e.ok && e.basis).toBe('dry-run');
    expect(e.ok && e.ratio).toBe(0.4);
    expect(e.ok && e.detail.dryRun?.pipelineId).toBe('mrd_win_xml_pack');
  });

  it('tries a built-in sample’s bare id when the file name 404s', async () => {
    const http = fakeHttp({ ...happy, 'GET /m/default/system/samples/weblog/content': ok(SAMPLE) });
    const r = await runDryRun(http, { groupId: 'default', inputId: 'weblog_gen', treatment: 'pack-windows', pipelineId: 'mrd_win_xml_pack' });
    expect(r.ok && r.sampleId).toBe('weblog');
  });

  it('declines a Source that is not a Datagen Source, offering the group’s samples instead (P2-W26)', async () => {
    const http = fakeHttp(happy);
    expect(await runDryRun(http, { groupId: 'default', inputId: 'in_splunk_tcp', treatment: 'pack-windows', pipelineId: 'mrd_win_xml_pack' })).toEqual({
      ok: false,
      reason: 'no-sample',
      samples: [
        { id: 'mrd_windows_security_xml', usedBy: ['mrd_windows_workstations'] },
        { id: 'weblog.log', usedBy: ['weblog_gen'] },
      ],
    });
    expect(http.calls).toHaveLength(1);
    // a group with no Datagen Source has nothing to offer
    const bare = fakeHttp({ ...happy, 'GET /m/default/system/inputs': ok({ count: 1, items: [{ id: 'in_splunk_tcp', type: 'splunk' }] }) });
    expect(await runDryRun(bare, { groupId: 'default', inputId: 'in_splunk_tcp', treatment: 'pack-windows' })).toEqual({ ok: false, reason: 'no-sample' });
  });

  it('measures on a sample the member picked from the group, and says so (P2-W26)', async () => {
    const http = fakeHttp(happy);
    const r = await runDryRun(http, { groupId: 'default', inputId: 'in_splunk_tcp', treatment: 'pack-windows', pipelineId: 'mrd_win_xml_pack', sampleId: 'mrd_windows_security_xml' });
    expect(r).toMatchObject({ ok: true, sampleId: 'mrd_windows_security_xml', picked: true, ratio: 0.4 });
    expect(http.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /m/default/system/inputs',
      'GET /m/default/system/samples/mrd_windows_security_xml/content',
      'POST /m/default/preview',
    ]);
    // the Source's own sample, named explicitly, is not "picked"
    const own = await runDryRun(fakeHttp(happy), { groupId: 'default', inputId: 'mrd_windows_workstations', treatment: 'pack-windows', pipelineId: 'mrd_win_xml_pack', sampleId: 'mrd_windows_security_xml' });
    expect(own.ok && 'picked' in own).toBe(false);
    // the basis carries it
    if (!r.ok) throw new Error('expected a measurement');
    const flow = { inBPerDay: 80e9, outBPerDay: 80e9, whpPerDayM: 20_000_000, paidPerDayM: 20_000_000, savedPerDayM: 0 };
    const e = estimateTreatment({ flow, treatment: 'pack-windows', dryRun: { inBytes: r.inBytes, outBytes: r.outBytes, sampleId: r.sampleId, picked: true } });
    expect(e.ok && e.detail.dryRun).toMatchObject({ sampleId: 'mrd_windows_security_xml', picked: true });
  });

  it('reads the group’s samples from the inputs list, and parses the library list for when its read is granted', () => {
    expect(groupSamples({ count: 2, items: [{ id: 'a', type: 'datagen', samples: [{ sample: 's1' }, { sample: '' }, 'junk'] }, { id: 'b', type: 'datagen', samples: [{ sample: 's1' }] }, { id: 'c', type: 'syslog' }] })).toEqual([{ id: 's1', usedBy: ['a', 'b'] }]);
    expect(groupSamples(null)).toEqual([]);
    expect(sampleLibraryPath('g 1')).toBe('/m/g%201/system/samples');
    expect(parseSampleLibrary({ count: 2, items: [{ id: 'pan_traffic', sampleName: 'pan_traffic.log' }, { id: 'x' }, { sampleName: 'no id' }] })).toEqual([
      { id: 'pan_traffic', name: 'pan_traffic.log' },
      { id: 'x', name: 'x' },
    ]);
  });

  it('declines when nothing in the group implements the treatment', async () => {
    const r = await runDryRun(fakeHttp(happy), { groupId: 'default', inputId: 'mrd_windows_workstations', treatment: 'pack-panos' });
    expect(r).toEqual({ ok: false, reason: 'no-pipeline' });
  });

  it('never previews a Pack reference directly', async () => {
    const http = fakeHttp(happy);
    const r = await runDryRun(http, { groupId: 'default', inputId: 'mrd_windows_workstations', treatment: 'pack-windows', pipelineId: 'pack:cribl-windows' });
    expect(r.ok && r.pipelineId).toBe('mrd_win_xml_pack');
  });

  it('names a missing grant (403) and a missing preview API (404)', async () => {
    const forbidden = await runDryRun(fakeHttp({ ...happy, 'POST /m/default/preview': { status: 403, ok: false, text: 'Forbidden' } }), {
      groupId: 'default',
      inputId: 'mrd_windows_workstations',
      treatment: 'pack-windows',
      pipelineId: 'mrd_win_xml_pack',
    });
    expect(forbidden).toEqual({ ok: false, reason: 'forbidden', status: 403, detail: 'Forbidden' });
    const missing = await runDryRun(fakeHttp({ ...happy, 'POST /m/default/preview': { status: 404, ok: false, json: { message: 'no such route' } } }), {
      groupId: 'default',
      inputId: 'mrd_windows_workstations',
      treatment: 'pack-windows',
      pipelineId: 'mrd_win_xml_pack',
    });
    expect(missing).toMatchObject({ ok: false, reason: 'unavailable', status: 404, detail: 'no such route' });
  });

  it('names a timeout as unavailable and a 5xx as failed', async () => {
    const base = { groupId: 'default', inputId: 'mrd_windows_workstations', treatment: 'pack-windows' as const, pipelineId: 'mrd_win_xml_pack' };
    expect(await runDryRun(fakeHttp({ ...happy, 'POST /m/default/preview': { status: 0, ok: false, text: 'timeout: no response' } }), base)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await runDryRun(fakeHttp({ ...happy, 'POST /m/default/preview': { status: 500, ok: false, text: 'boom' } }), base)).toMatchObject({ ok: false, reason: 'failed', status: 500 });
    expect(await runDryRun(fakeHttp({ ...happy, 'POST /m/default/preview': { status: 200, ok: true, text: 'not json' } }), base)).toMatchObject({ ok: false, reason: 'failed' });
    expect(await runDryRun(fakeHttp({ ...happy, 'GET /m/default/system/inputs': { status: 403, ok: false } }), base)).toMatchObject({ ok: false, reason: 'forbidden' });
  });

  it('declines an empty sample or one with no bytes', async () => {
    const base = { groupId: 'default', inputId: 'mrd_windows_workstations', treatment: 'pack-windows' as const, pipelineId: 'mrd_win_xml_pack' };
    expect(await runDryRun(fakeHttp({ ...happy, 'GET /m/default/system/samples/mrd_windows_security_xml/content': ok([]) }), base)).toEqual({ ok: false, reason: 'empty' });
    expect(await runDryRun(fakeHttp({ ...happy, 'GET /m/default/system/samples/mrd_windows_security_xml/content': ok([{ _raw: '' }]) }), base)).toEqual({ ok: false, reason: 'empty' });
    expect(await runDryRun(fakeHttp({ ...happy, 'GET /m/default/system/samples/mrd_windows_security_xml/content': { status: 404, ok: false } }), base)).toMatchObject({ ok: false, reason: 'no-sample' });
  });

  it('never throws', async () => {
    const http: CriblHttp = {
      request: () => Promise.reject(new Error('socket hang up')),
    };
    expect(await runDryRun(http, { groupId: 'default', inputId: 'x', treatment: 'pack-windows' })).toEqual({ ok: false, reason: 'failed', detail: 'socket hang up' });
  });
});
