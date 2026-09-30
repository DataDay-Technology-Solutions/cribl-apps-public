// tests/unit/detector-settle-lever.test.ts — founder-build r1 core-3: `scripts/lever.ts settle on|off` (FOUNDER_PLAN
// row 9, "The setting"). The GA rollback is a settings flip with no redeploy and no runner restart: the runner reads
// settings from App KV every sweep. It writes only a demo workspace's KV — demo mode on, and an inventory that carries
// the demo rig's tagged objects — and refuses anything else. Run against a fake (in-memory) KV only; never the live org.

import { describe, expect, it } from 'vitest';
import type { InventoryDoc, Settings } from '../../core/types.ts';
import { createKvDocs, createMemoryKvStore } from '../../core/kv.ts';
import { identityCodec } from '../../core/codec.ts';
import { defaultSettings } from '../../core/settings.ts';
import { setDemoSettle } from '../../core/demo/settle.ts';

const NOW = Date.parse('2026-09-28T22:00:00Z');

const rigInventory = (tagged: boolean): InventoryDoc => ({
  schemaVersion: 1,
  updatedAt: '',
  hash: 'h',
  byGroup: {
    default: {
      inputs: [tagged ? { id: 'mrd_pan_firewall', type: 'datagen', description: '[meter-reader-demo] Palo Alto firewall' } : { id: 'in_syslog', type: 'syslog' }],
      outputs: [{ id: 'devnull', type: 'devnull' }],
      pipelines: [],
      routes: [
        tagged
          ? { id: 'mrd_pan_firewall', filter: "__inputId=='datagen:mrd_pan_firewall'", pipeline: 'mrd_passthrough', output: 'mrd_siem_prod', description: '[meter-reader-demo] Palo Alto firewall' }
          : { id: 'default', filter: 'true', pipeline: 'main', output: 'devnull' },
      ],
    },
  },
});

async function workspace(opts: { demoEnabled: boolean | null; tagged: boolean }) {
  const kv = createMemoryKvStore();
  const docs = createKvDocs({ kv, codec: identityCodec, clock: { now: () => NOW } });
  if (opts.demoEnabled !== null) {
    const s: Settings = defaultSettings('2026-09-27T00:00:00.000Z', 'America/New_York');
    s.demo = { enabled: opts.demoEnabled, replayMode: false, profile: true };
    s.headlinePeriodDefault = 'annualized';
    await docs.putSettings(s);
  }
  await docs.putInventory(rigInventory(opts.tagged));
  return { kv, docs };
}

describe('lever.ts settle on|off (core/demo/settle.ts)', () => {
  it('turns settling off and on again in a demo workspace, changing nothing else', async () => {
    const { docs } = await workspace({ demoEnabled: true, tagged: true });
    const before = (await docs.getSettings())!;
    const off = await setDemoSettle(docs, false, NOW);
    expect(off).toEqual({ ok: true, settle: false, was: true });
    const s1 = (await docs.getSettings())!;
    expect(s1.demo).toEqual({ enabled: true, replayMode: false, profile: true, settle: false });
    // Everything else is as it was (the demo org's Annualized default, its zone), bar updatedAt.
    expect({ ...s1, demo: before.demo, updatedAt: before.updatedAt }).toEqual(before);
    expect(s1.updatedAt).toBe(new Date(NOW).toISOString());
    const on = await setDemoSettle(docs, true, NOW + 1000);
    expect(on).toEqual({ ok: true, settle: true, was: false });
    expect((await docs.getSettings())!.demo.settle).toBe(true);
  });

  it('refuses a workspace whose demo mode is off (a release install), and writes nothing', async () => {
    const { docs, kv } = await workspace({ demoEnabled: false, tagged: true });
    const raw = await kv.get('settings');
    const r = await setDemoSettle(docs, false, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_demo');
    expect(await kv.get('settings')).toEqual(raw);
  });

  it('refuses a workspace with no demo-tagged object in its inventory, and writes nothing', async () => {
    const { docs, kv } = await workspace({ demoEnabled: true, tagged: false });
    const raw = await kv.get('settings');
    const r = await setDemoSettle(docs, false, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_demo_tagged');
    expect(await kv.get('settings')).toEqual(raw);
  });

  it('refuses a workspace with no settings document (never creates one)', async () => {
    const { docs, kv } = await workspace({ demoEnabled: null, tagged: true });
    const r = await setDemoSettle(docs, false, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('no_settings');
    expect(await kv.get('settings')).toBeNull();
  });
});
