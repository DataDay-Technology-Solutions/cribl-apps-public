// tests/integration/r1-core-router.test.ts — founder-build r1 core-12 (FINDINGS_R1 M12, #45; from AA/skeptic2-f45).
// A route that sends to an Output Router ended its flow at the router — a free type — so a Splunk-bound stream read $0
// paid, $0 saved, and nothing was flagged. Now a router whose enabled rules all lead to one destination is followed to it
// (the flow is priced at that destination, exactly as the direct route is), and a router that splits traffic across
// destinations, which one flow cannot attribute, is no longer free: it reads unpriced, so the member sees it and can price
// it at its destinations' rate (the Prices screen's own "no price yet"), instead of a silent $0.

import { describe, expect, it } from 'vitest';
import type { CriblHttp, HttpResult, Snapshot } from '../../core/types.ts';
import { appendPriceVersion, emptyPrices } from '../../core/pricing.ts';
import { HOUR, createWorld } from './harness.ts';

type Variant = 'control-direct' | 'router-reports' | 'router-silent' | 'router-split';
const GID = 'default';
const items = (x: unknown[]): HttpResult => ({ ok: true, status: 200, json: { count: x.length, items: x } }) as HttpResult;

async function run(v: Variant): Promise<Snapshot> {
  const viaRouter = v !== 'control-direct';
  const inputs = [{ id: 'in_hec', type: 'splunk_hec', disabled: false }];
  const rules =
    v === 'router-split'
      ? [
          { filter: "sourcetype=='pan:traffic'", output: 'splunk_prod', final: true },
          { filter: 'true', output: 'archive_s3', final: true },
        ]
      : [{ filter: 'true', output: 'splunk_prod', final: true }];
  const outputs = [
    { id: 'splunk_prod', type: 'splunk_hec' },
    { id: 'archive_s3', type: 's3' },
    { id: 'my_router', type: 'router', rules },
    { id: 'devnull', type: 'devnull' },
    { id: 'default', type: 'default', defaultId: 'devnull' },
  ];
  const pipelines = [{ id: 'trim', conf: { functions: [{ id: 'eval', filter: 'true' }] } }];
  const routes = [{ id: 'default', routes: [{ id: 'r1', name: 'r1', filter: "__inputId=='splunk_hec:in_hec'", pipeline: 'trim', output: viaRouter ? 'my_router' : 'splunk_prod', final: true }] }];
  const wrap = (inner: CriblHttp): CriblHttp => ({
    async request(method, path, body, o) {
      if (method === 'GET' && /\/products\/stream\/groups(\?|$)/.test(path)) return items([{ id: GID, type: 'stream' }]);
      if (method === 'GET' && path.startsWith(`/m/${GID}/system/inputs`)) return items(inputs);
      if (method === 'GET' && path.startsWith(`/m/${GID}/system/outputs`)) return items(outputs);
      if (method === 'GET' && path.startsWith(`/m/${GID}/pipelines`)) return items(pipelines);
      if (method === 'GET' && path.startsWith(`/m/${GID}/routes`)) return items(routes);
      if (method === 'POST' && path.includes('/system/metrics/query')) {
        const b = body as { earliest: number; latest: number };
        const rows: Record<string, unknown>[] = [];
        for (let m = b.earliest; m < b.latest; m += 60_000) {
          const s = m / 1000;
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, input: 'splunk_hec:in_hec', inB: 40_000_000, inE: 4000 });
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, output: 'splunk_hec:splunk_prod', outB: 24_000_000, outE: 4000 });
          if (v === 'router-reports' || v === 'router-split') rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, output: 'router:my_router', outB: 24_000_000, outE: 4000 });
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, route: 'r1', name: 'r1', inB: 40_000_000, outB: 24_000_000, inE: 4000, outE: 4000 });
        }
        return { ok: true, status: 200, json: { results: rows, info: { timeWindowSeconds: 60 } } } as HttpResult;
      }
      return inner.request(method, path, body, o);
    },
  });
  const w = await createWorld({ bare: true, wrapHttp: wrap, sweep: { firstRunReachMs: HOUR } });
  await w.docs.putPrices(appendPriceVersion(emptyPrices(''), { splunk_prod: { milliCentsPerGb: 225_000, preset: 'splunk_cloud' } } as never, w.now()));
  const r = await w.sweep('ui');
  expect(r.error).toBeUndefined();
  return (await w.docs.getSnapshot())!;
}

const money = (s: Snapshot) => {
  const d = s.destinations.find((x) => x.outputId === 'splunk_prod')!;
  return { flows: s.flows.map((f) => f.outputId), paid: d.paidPerDayM, saved: d.savedPerDayM, headline: s.headline.annualizedM };
};

describe('core-12 · M12: traffic through an Output Router is priced (or flagged)', () => {
  it('a router whose rules lead to one destination prices exactly like the direct route (≈ $77.76 paid, $51.84 saved a day)', async () => {
    const control = money(await run('control-direct'));
    expect(control.paid).toBe(7_776_000);
    expect(control.saved).toBe(5_184_000);
    for (const v of ['router-reports', 'router-silent'] as const) {
      const got = money(await run(v));
      expect(got, v).toEqual(control);
      expect(got.flows, v).toEqual(['splunk_prod']);
    }
  }, 120_000);

  it('a router that splits traffic across destinations is flagged unpriced, never a silent $0', async () => {
    const s = await run('router-split');
    expect(s.flows.map((f) => f.outputId)).toEqual(['my_router']);
    expect(s.unpricedOutputIds).toContain('my_router');
    const d = s.destinations.find((x) => x.outputId === 'my_router')!;
    expect(d.unpriced).toBe(true);
    expect(s.flows[0].state).toBe('unpriced');
  }, 120_000);
});
