// core/demo/settle.ts — the GA rollback for FOUNDER_PLAN row 9 (founder-build r1 core-3): `scripts/lever.ts settle
// on|off` flips `settings.demo.settle` in App KV. The runner and every tab read settings from KV each sweep, so the
// flip takes effect on the next sweep with no redeploy and no runner restart (core/detector.ts SETTLE_MS).
//
// Demo-tagged KV only: it writes the settings document of a workspace whose demo mode is on AND whose stored inventory
// carries at least one demo rig object (an `mrd_` id or `[meter-reader-demo]` in a description). Anything else is
// refused and nothing is written; it never creates a settings document. It changes App KV state only — never Cribl
// configuration — and never deletes anything.

import type { InventoryDoc, Settings } from '../types.ts';
import type { KvDocs } from '../kv.ts';
import { DEMO_TAG } from '../flows.ts';
import { demoSettleOn } from '../settings.ts';

export type SettleResult =
  | { ok: true; settle: boolean; was: boolean }
  | { ok: false; error: 'no_settings' | 'not_demo' | 'not_demo_tagged'; message: string };

/** Whether any object in the stored inventory is a demo rig object (an `mrd_` id or the demo tag in its description). */
export function hasDemoTaggedObject(inventory: InventoryDoc | null | undefined): boolean {
  const tagged = (o: { id?: unknown; description?: unknown }): boolean =>
    (typeof o.id === 'string' && o.id.startsWith('mrd_')) || (typeof o.description === 'string' && o.description.includes(DEMO_TAG));
  for (const g of Object.values(inventory?.byGroup ?? {})) {
    for (const list of [g.inputs, g.outputs, g.pipelines, g.routes] as { id?: unknown; description?: unknown }[][]) {
      if ((list ?? []).some(tagged)) return true;
    }
  }
  return false;
}

/** Sets `settings.demo.settle` in a demo workspace's App KV; refuses (writing nothing) anywhere else. */
export async function setDemoSettle(docs: Pick<KvDocs, 'getSettings' | 'putSettings' | 'getInventory'>, on: boolean, nowMs: number): Promise<SettleResult> {
  const settings: Settings | null = await docs.getSettings();
  if (!settings) return { ok: false, error: 'no_settings', message: 'No settings document in this App KV: nothing to change.' };
  if (settings.demo?.enabled !== true) return { ok: false, error: 'not_demo', message: 'Demo mode is off in this workspace: settle applies to the demo profile only.' };
  if (!hasDemoTaggedObject(await docs.getInventory())) {
    return { ok: false, error: 'not_demo_tagged', message: `No demo rig object (mrd_ id or ${DEMO_TAG}) in this workspace's inventory: refusing.` };
  }
  const was = demoSettleOn(settings);
  await docs.putSettings({ ...settings, updatedAt: new Date(nowMs).toISOString(), demo: { ...settings.demo, settle: on } });
  return { ok: true, settle: on, was };
}
