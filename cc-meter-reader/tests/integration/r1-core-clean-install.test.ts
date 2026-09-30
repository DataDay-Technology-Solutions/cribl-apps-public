// tests/integration/r1-core-clean-install.test.ts — founder-build r1 core-1 (FINDINGS_R1 B2 #40, FINDINGS_EXTRA RW-1,
// contract C3 option A). CLEAN_INSTALL_TEST 0.3's workspace, as DDT2 built it for real: a plain (untagged) Datagen
// Source (syslog sample, 100 EPS) → a route → a pipeline whose Drop keeps about half (`Math.random() < 0.5`) → DevNull,
// priced at $2.25/GB. The release used to hide every untagged Datagen as test plumbing, so the member's first sweeps read
// "$0 · Nothing saved yet" with no explanation. Promoted from AA/r1/resilience/zz-res.test.ts case G.

import { describe, expect, it } from 'vitest';
import type { CriblHttp, HttpResult } from '../../core/types.ts';
import { appendPriceVersion, emptyPrices } from '../../core/pricing.ts';
import { buildFlows } from '../../core/flows.ts';
import { defaultSettings } from '../../core/settings.ts';
import { HOUR, createWorld } from './harness.ts';

const GID = 'default';
const items = (x: unknown[]): HttpResult => ({ ok: true, status: 200, json: { count: x.length, items: x } }) as HttpResult;

/** A workspace with one Datagen (tagged or not), the system inputs every Cribl.Cloud group has, and DevNull. */
function cleanWorkspace(description: string | undefined): (inner: CriblHttp) => CriblHttp {
  const inputs = [
    {
      id: 'in_datagen_test',
      type: 'datagen',
      disabled: false,
      ...(description !== undefined ? { description } : {}),
      samples: [{ sample: 'syslog.log', eventsPerSec: 100 }],
    },
    { id: 'CriblMetrics', type: 'criblmetrics', disabled: false },
    { id: 'CriblLogs', type: 'cribl', disabled: false },
  ];
  const outputs = [
    { id: 'devnull', type: 'devnull' },
    { id: 'default', type: 'default', defaultId: 'devnull' },
  ];
  const pipelines = [
    { id: 'main', conf: { functions: [] } },
    { id: 'drop_half', conf: { functions: [{ id: 'drop', filter: 'Math.random() < 0.5' }] } },
  ];
  const routes = [
    {
      id: 'default',
      routes: [
        { id: 'r_dg', name: 'datagen test', filter: "__inputId=='datagen:in_datagen_test'", pipeline: 'drop_half', output: 'devnull', final: true },
        { id: 'default', name: 'default', filter: 'true', pipeline: 'main', output: 'default', final: true },
      ],
    },
  ];
  return (inner) => ({
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
          // 30 MB a minute in, half of it delivered (the Drop), and the system inputs' own traffic to DevNull.
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, input: 'datagen:in_datagen_test', inB: 30_000_000, inE: 6000 });
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, input: 'criblmetrics:CriblMetrics', inB: 2_000_000, inE: 900 });
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, output: 'devnull:devnull', outB: 15_000_000, outE: 3000 });
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, route: 'r_dg', name: 'datagen test', inB: 30_000_000, outB: 15_000_000, inE: 6000, outE: 3000 });
        }
        return { ok: true, status: 200, json: { results: rows, info: { timeWindowSeconds: 60 } } } as HttpResult;
      }
      return inner.request(method, path, body, o);
    },
  });
}

async function install(description: string | undefined) {
  const w = await createWorld({ bare: true, wrapHttp: cleanWorkspace(description), sweep: { firstRunReachMs: HOUR } });
  // Settings → Prices: DevNull at $2.25/GB, "This destination" (the only price the member saves), then Start the meter.
  await w.docs.putPrices(appendPriceVersion(emptyPrices(''), { devnull: { milliCentsPerGb: 225_000 } }, w.now()));
  return w;
}

describe('core-1 · a plain Datagen the member priced is metered (C3 option A)', () => {
  it('CLEAN_INSTALL_TEST 0.3: untagged Datagen → Drop → DevNull at $2.25 reads more than $0 within 3 sweeps, as one flow', async () => {
    const w = await install('syslog sample, 100 EPS');
    const first = await w.sweep('ui');
    expect(first.error).toBeUndefined();
    expect(first.skipped).toBeUndefined();
    const rest = await w.sweepMinutes(2);
    for (const r of rest) expect(r.error).toBeUndefined();

    const snap = (await w.docs.getSnapshot())!;
    expect(snap).not.toBeNull();
    // Saved by Cribl is more than $0 (CIT 5.1), on every period the Receipt offers.
    expect(snap.headline.mtdM).toBeGreaterThan(0);
    expect(snap.headline.todayM).toBeGreaterThan(0);
    expect(snap.headline.annualizedM).toBeGreaterThan(0);
    // One flow: the Datagen through its route; CriblMetrics and CriblLogs on the catch-all stay hidden.
    expect(snap.flowCounts?.flows).toBe(1);
    expect(snap.flows.map((f) => f.key)).toEqual(['default|in_datagen_test|r_dg|drop_half|devnull']);
    const devnull = snap.destinations.find((d) => d.outputId === 'devnull')!;
    // 30 MB/min in at $2.25/GB would have cost ≈ $97.20 a day; half of it is dropped, so ≈ $48.60 a day saved.
    expect(devnull.savedPerDayM).toBeGreaterThan(40 * 100_000);
    expect(devnull.savedPerDayM).toBeLessThan(55 * 100_000);
    expect(devnull.paidPerDayM).toBeGreaterThan(40 * 100_000);

    const inv = (await w.docs.getInventory())!;
    const keys = buildFlows(inv, defaultSettings(new Date(w.now()).toISOString(), 'UTC')).map((f) => f.key);
    expect(keys).toEqual(['default|in_datagen_test|r_dg|drop_half|devnull']);
  });

  it('the tagged control still meters exactly one flow, with the same figures', async () => {
    const plain = await install(undefined);
    await plain.sweep('ui');
    await plain.sweepMinutes(2);
    const tagged = await install('clean install [meter-reader-demo]');
    await tagged.sweep('ui');
    await tagged.sweepMinutes(2);
    const a = (await plain.docs.getSnapshot())!;
    const b = (await tagged.docs.getSnapshot())!;
    expect(b.flowCounts?.flows).toBe(1);
    expect(a.flowCounts?.flows).toBe(1);
    expect(a.headline.mtdM).toBe(b.headline.mtdM);
    expect(a.flows[0].savedPerDayM).toBe(b.flows[0].savedPerDayM);
  });
});
